import { contentId } from '../core/canonical';
import { AppendLog } from '../core/append-log';
import { deflatedSharpe } from '../core/stats';
import type { KnowledgeMode } from '../events/types';
import type { Metrics } from '../backtest/engine';
import type { BaselineComparison } from '../backtest/analysis';

/**
 * Experiments: every research question becomes a pre-registered record. The design (hypothesis, strategy and feature
 * fingerprints, dataset version, periods, cost model, decision rule, how many configurations were compared) is fixed
 * and hashed into the experiment id before any test data is looked at. The test period is a sealed holdout:
 *
 * - it can be opened once per experiment, only after registration, and every opening is recorded;
 * - each (dataset version, test period) has a budget of openings across ALL experiments; every reuse after the first is
 *   reported as CONTAMINATED, and beyond the budget the vault refuses. New data (a new dataset version) is the only
 *   way to get a clean test set again;
 * - the verdict follows the pre-registered decision rule, not a judgement made after seeing the numbers.
 *
 * The log is append-only (core/append-log): history of experiments, including failed ones, cannot be rewritten.
 */

export interface Period { from: number; to: number }
export interface DecisionRule {
  /** Fewer filled, complete test trades than this is INCONCLUSIVE, whatever the mean. */
  minTrades: number;
  /** Bootstrap confidence level of the mean return. */
  ciLevel: number;
  /** The strategy must beat random entries on the same tokens and period (difference interval above zero). */
  requireBeatRandomBaseline: boolean;
  /** Minimum deflated Sharpe probability, given `trials` (Bailey & López de Prado). */
  minDeflatedSharpe: number;
}
export const DEFAULT_DECISION_RULE: DecisionRule = Object.freeze({ minTrades: 30, ciLevel: 0.95, requireBeatRandomBaseline: true, minDeflatedSharpe: 0.95 });

export interface ExperimentDesign {
  hypothesis: string;
  hypothesis_id: string | null;
  strategy_version: { id: string; fingerprint: string };
  feature_versions: Record<string, string>;
  dataset_version: string;
  periods: { training: Period | null; validation: Period | null; test: Period };
  execution_model: { id: string; fingerprint: string };
  transaction_cost_model: { venueFeeBps: number; networkFeeUsd: number; rentUsd: number; rentRecovered: boolean; stopSlipPct: number; gapFill: boolean };
  risk_fingerprint: string;
  knowledge_mode: KnowledgeMode;
  decision_rule: DecisionRule;
  /** Configurations compared before this one was chosen (grid points, walk-forward candidates, earlier versions). Be honest. */
  trials: number;
  known_cases_excluded: string[];
  seed: number;
  code_version: string;
}

export type Verdict = 'SUPPORTED' | 'REJECTED' | 'INCONCLUSIVE' | 'INVALID';

type LogRecord =
  | { kind: 'REGISTERED'; at: number; experiment_id: string; design: ExperimentDesign; actor: string }
  | { kind: 'VALIDATION'; at: number; experiment_id: string; run_id: string; metrics: Metrics }
  | { kind: 'HOLDOUT_OPENED'; at: number; experiment_id: string; holdout_key: string; use_number: number; actor: string }
  | { kind: 'CONCLUDED'; at: number; experiment_id: string; run_id: string | null; result: Verdict; metrics: Metrics | null; sample_size: number;
      failure_reason: string | null; baseline: BaselineComparison | null; deflated_sharpe: number | null; expected_max_sharpe: number | null;
      leakage: { passed: boolean; violations: number }; notes: string[] };

export interface ExperimentRecord {
  experiment_id: string;
  hypothesis: string;
  hypothesis_id: string | null;
  dataset_version: string;
  feature_versions: Record<string, string>;
  strategy_version: { id: string; fingerprint: string };
  training_period: Period | null;
  validation_period: Period | null;
  test_period: Period;
  execution_model: { id: string; fingerprint: string };
  transaction_cost_model: ExperimentDesign['transaction_cost_model'];
  decision_rule: DecisionRule;
  trials: number;
  result: Verdict | 'PENDING';
  metrics: Metrics | null;
  validation_metrics: Metrics | null;
  sample_size: number;
  failure_reason: string | null;
  baseline: BaselineComparison | null;
  deflated_sharpe: number | null;
  holdout: { opened: boolean; use_number: number | null; contaminated: boolean };
  notes: string[];
  /** Registration time. */
  timestamp: number;
  concluded_at: number | null;
  design: ExperimentDesign;
}

export const holdoutKey = (d: Pick<ExperimentDesign, 'dataset_version' | 'periods'>): string => `${d.dataset_version}|${d.periods.test.from}-${d.periods.test.to}`;

function validateDesign(d: ExperimentDesign): void {
  const bad = (w: string) => { throw new Error(`EXPERIMENT_DESIGN_INVALID: ${w}`); };
  if (!d.hypothesis.trim()) bad('hypothesis required');
  if (!d.dataset_version) bad('dataset version required');
  if (!(d.trials >= 1)) bad('trials must be ≥ 1 (count every configuration compared)');
  const ps = [d.periods.training, d.periods.validation, d.periods.test].filter((p): p is Period => p !== null);
  for (const p of ps) if (!(p.from < p.to)) bad('period from < to');
  for (let i = 1; i < ps.length; i++) if (ps[i]!.from < ps[i - 1]!.to) bad('periods must be ordered and must not overlap (training < validation < test)');
}

/**
 * The pre-registered verdict. SUPPORTED needs all of: enough trades, a confidence interval of the mean above zero,
 * (optionally) a win over random entries, and a deflated Sharpe above the threshold given the trials.
 */
export function decide(metrics: Metrics, baseline: BaselineComparison | null, trials: number, rule: DecisionRule, returns: readonly number[]):
  { result: Verdict; failure_reason: string | null; deflated: number | null; expectedMax: number | null } {
  const n = returns.length, ci = metrics.meanReturnCi95;
  const ds = deflatedSharpe(returns, trials);
  if (n < rule.minTrades) return { result: 'INCONCLUSIVE', failure_reason: `SAMPLE_TOO_SMALL (${n} < ${rule.minTrades} trades)`, deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (!ci) return { result: 'INCONCLUSIVE', failure_reason: 'NO_CONFIDENCE_INTERVAL', deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (ci.high < 0) return { result: 'REJECTED', failure_reason: `MEAN_RETURN_BELOW_ZERO (CI ${ci.low.toFixed(1)} … ${ci.high.toFixed(1)} %)`, deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (rule.requireBeatRandomBaseline && baseline?.differenceCi95 && baseline.differenceCi95.high < 0)
    return { result: 'REJECTED', failure_reason: 'WORSE_THAN_RANDOM_ENTRY', deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (ci.low <= 0) return { result: 'INCONCLUSIVE', failure_reason: `CI_INCLUDES_ZERO (${ci.low.toFixed(1)} … ${ci.high.toFixed(1)} %)`, deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (rule.requireBeatRandomBaseline && (!baseline?.differenceCi95 || baseline.differenceCi95.low <= 0))
    return { result: 'INCONCLUSIVE', failure_reason: 'NOT_DISTINGUISHABLE_FROM_RANDOM_ENTRY', deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  if (ds.dsr === null || ds.dsr < rule.minDeflatedSharpe)
    return { result: 'INCONCLUSIVE', failure_reason: `DEFLATED_SHARPE ${ds.dsr === null ? 'unknown' : ds.dsr.toFixed(3)} < ${rule.minDeflatedSharpe} after ${trials} trials`, deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
  return { result: 'SUPPORTED', failure_reason: null, deflated: ds.dsr, expectedMax: ds.expectedMaxSharpe };
}

export class ExperimentRegistry {
  private readonly records: LogRecord[] = [];
  private constructor(private readonly log: AppendLog<LogRecord> | null, readonly holdoutBudget: number) {}

  /** Durable registry in a directory (one writer). */
  static async open(dir: string, o: { holdoutBudget?: number; lock?: boolean } = {}): Promise<ExperimentRegistry> {
    const loaded: LogRecord[] = [];
    const log = await AppendLog.open<LogRecord>({ dir, prefix: 'experiments', lock: o.lock }, line => { loaded.push(line.data); });
    const r = new ExperimentRegistry(log, o.holdoutBudget ?? 3);
    r.records.push(...loaded);
    return r;
  }
  /** In-memory registry (tests, agents' dry runs). */
  static memory(o: { holdoutBudget?: number } = {}): ExperimentRegistry { return new ExperimentRegistry(null, o.holdoutBudget ?? 3); }

  private async write(rec: LogRecord): Promise<void> {
    if (this.log) await this.log.append([rec]);
    this.records.push(rec);
  }

  async register(design: ExperimentDesign, at: number, actor: string): Promise<ExperimentRecord> {
    validateDesign(design);
    const experiment_id = contentId('exp', design);
    if (!this.records.some(r => r.kind === 'REGISTERED' && r.experiment_id === experiment_id))
      await this.write({ kind: 'REGISTERED', at, experiment_id, design, actor });
    return this.get(experiment_id)!;
  }

  async recordValidation(id: string, runId: string, metrics: Metrics, at: number): Promise<void> {
    this.require(id, 'PENDING');
    await this.write({ kind: 'VALIDATION', at, experiment_id: id, run_id: runId, metrics });
  }

  /** How often this holdout has been opened by any experiment. */
  holdoutUses(key: string): number { return this.records.filter(r => r.kind === 'HOLDOUT_OPENED' && r.holdout_key === key).length; }

  async openHoldout(id: string, actor: string, at: number): Promise<{ use_number: number; contaminated: boolean }> {
    const rec = this.require(id, 'PENDING');
    if (rec.holdout.opened) throw new Error('HOLDOUT_ALREADY_OPENED: an experiment sees its test period once');
    const key = holdoutKey(rec.design), uses = this.holdoutUses(key);
    if (uses >= this.holdoutBudget) throw new Error(`HOLDOUT_BUDGET_EXHAUSTED: ${key} was opened ${uses} times; collect new data (a new dataset version)`);
    await this.write({ kind: 'HOLDOUT_OPENED', at, experiment_id: id, holdout_key: key, use_number: uses + 1, actor });
    return { use_number: uses + 1, contaminated: uses > 0 };
  }

  async conclude(id: string, c: Omit<Extract<LogRecord, { kind: 'CONCLUDED' }>, 'kind' | 'experiment_id'>): Promise<ExperimentRecord> {
    const rec = this.require(id, 'PENDING');
    if (c.result !== 'INVALID' && !rec.holdout.opened) throw new Error('HOLDOUT_NOT_OPENED: only an INVALID experiment concludes without its test');
    await this.write({ kind: 'CONCLUDED', experiment_id: id, ...c });
    return this.get(id)!;
  }

  private require(id: string, status: 'PENDING'): ExperimentRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`Unknown experiment ${id}`);
    if (status === 'PENDING' && rec.result !== 'PENDING') throw new Error(`EXPERIMENT_CONCLUDED: ${id} is ${rec.result}; register a new experiment`);
    return rec;
  }

  get(id: string): ExperimentRecord | null {
    const reg = this.records.find((r): r is Extract<LogRecord, { kind: 'REGISTERED' }> => r.kind === 'REGISTERED' && r.experiment_id === id);
    if (!reg) return null;
    const d = reg.design, mine = this.records.filter(r => r.experiment_id === id);
    const val = mine.filter((r): r is Extract<LogRecord, { kind: 'VALIDATION' }> => r.kind === 'VALIDATION').at(-1);
    const hold = mine.find((r): r is Extract<LogRecord, { kind: 'HOLDOUT_OPENED' }> => r.kind === 'HOLDOUT_OPENED');
    const done = mine.find((r): r is Extract<LogRecord, { kind: 'CONCLUDED' }> => r.kind === 'CONCLUDED');
    const notes = [...(done?.notes ?? [])];
    if (hold && hold.use_number > 1) notes.unshift(`HOLDOUT_CONTAMINATED: this test period was opened ${hold.use_number - 1} time(s) before by other experiments`);
    return {
      experiment_id: id, hypothesis: d.hypothesis, hypothesis_id: d.hypothesis_id, dataset_version: d.dataset_version, feature_versions: d.feature_versions,
      strategy_version: d.strategy_version, training_period: d.periods.training, validation_period: d.periods.validation, test_period: d.periods.test,
      execution_model: d.execution_model, transaction_cost_model: d.transaction_cost_model, decision_rule: d.decision_rule, trials: d.trials,
      result: done?.result ?? 'PENDING', metrics: done?.metrics ?? null, validation_metrics: val?.metrics ?? null, sample_size: done?.sample_size ?? 0,
      failure_reason: done?.failure_reason ?? null, baseline: done?.baseline ?? null, deflated_sharpe: done?.deflated_sharpe ?? null,
      holdout: { opened: !!hold, use_number: hold?.use_number ?? null, contaminated: !!hold && hold.use_number > 1 }, notes,
      timestamp: reg.at, concluded_at: done?.at ?? null, design: d,
    };
  }

  list(): ExperimentRecord[] {
    return this.records.filter(r => r.kind === 'REGISTERED').map(r => this.get(r.experiment_id)!).sort((a, b) => a.timestamp - b.timestamp);
  }

  async close(): Promise<void> { await this.log?.close(); }
}

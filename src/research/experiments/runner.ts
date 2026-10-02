import { seedFrom, seededRng } from '../core/random';
import type { DatasetManifest } from '../events/dataset';
import type { ResearchEvent } from '../events/types';
import { computeFeatures } from '../features/registry';
import { auditEvents, viewLeakageCases, type Violation } from '../pit/leakage';
import { executionFingerprint } from '../execution/model';
import { riskFingerprint } from '../risk/engine';
import { runBacktest, type BacktestConfig, type BacktestResult } from '../backtest/engine';
import { randomEntryBaseline } from '../backtest/analysis';
import { DEFAULT_DECISION_RULE, decide, type DecisionRule, type ExperimentDesign, type ExperimentRecord, type ExperimentRegistry, type Period } from './registry';

export interface ExperimentPlan {
  hypothesis: string;
  hypothesisId?: string | null;
  config: Omit<BacktestConfig, 'period' | 'datasetVersion'>;
  dataset: DatasetManifest;
  events: readonly ResearchEvent[];
  periods: { training: Period | null; validation: Period | null; test: Period };
  /** Configurations compared before choosing this one (at least 1). */
  trials: number;
  decisionRule?: DecisionRule;
  /** Known winners / anecdotes: never traded in any period of the experiment. */
  knownCases?: readonly string[];
  actor: string;
  now: () => number;
  /** (token, decision time) pairs sampled for the feature leakage tests: this many random price observations plus as many
   *  of the training run's signals (default 12 each). */
  leakageChecks?: number;
  baselineRepetitions?: number;
}

export interface ExperimentRun { record: ExperimentRecord; training: BacktestResult | null; validation: BacktestResult | null; test: BacktestResult | null; leakage: Violation[] }

/**
 * Runs one pre-registered experiment end to end:
 *   register → training and validation runs → data audit and feature leakage tests at random observations and at the
 *   in-sample signals (INVALID on any violation, before the holdout is touched) → validation recorded → open the sealed
 *   test period once → test run and random-entry baseline → verdict by the pre-registered decision rule → concluded.
 */
export async function runExperiment(registry: ExperimentRegistry, p: ExperimentPlan): Promise<ExperimentRun> {
  const c = p.config, rule = p.decisionRule ?? DEFAULT_DECISION_RULE, cases = [...new Set([...(p.knownCases ?? []), ...(c.excludeTokens ?? [])])].sort();
  const design: ExperimentDesign = {
    hypothesis: p.hypothesis, hypothesis_id: p.hypothesisId ?? null,
    strategy_version: { id: c.strategy.id, fingerprint: c.strategy.fingerprint }, feature_versions: c.features.fingerprints(c.strategy.features),
    dataset_version: p.dataset.dataset_version, periods: p.periods,
    execution_model: { id: c.execution.id, fingerprint: executionFingerprint(c.execution) },
    transaction_cost_model: { venueFeeBps: c.execution.venueFeeBps, networkFeeUsd: c.execution.networkFeeUsd, rentUsd: c.execution.rentUsd,
      rentRecovered: c.execution.rentRecovered, stopSlipPct: c.execution.stopSlipPct, gapFill: c.execution.gapFill },
    risk_fingerprint: riskFingerprint(c.risk), knowledge_mode: c.mode, decision_rule: rule, trials: p.trials, known_cases_excluded: cases,
    seed: c.seed, code_version: c.codeVersion,
  };
  const reg = await registry.register(design, p.now(), p.actor), id = reg.experiment_id;
  if (reg.result !== 'PENDING') return { record: reg, training: null, validation: null, test: null, leakage: [] };
  const cfg: BacktestConfig = { ...c, excludeTokens: cases, datasetVersion: p.dataset.dataset_version };

  // ---------------------------------------------------------------- in-sample
  const training = p.periods.training ? runBacktest(p.events, { ...cfg, period: p.periods.training }) : null;
  const validation = p.periods.validation ? runBacktest(p.events, { ...cfg, period: p.periods.validation }) : null;

  // ---------------------------------------------------------------- leakage, before the holdout is touched
  // Features are tested where they are used: at random price observations and at the in-sample signals.
  const violations: Violation[] = [...auditEvents(p.events).violations];
  const rng = seededRng(seedFrom(`${c.seed}:leakage`)), k = p.leakageChecks ?? 12;
  const testFrom = p.periods.test.from;
  const observations = p.events.filter(e => (e.event_type === 'Candle' || e.event_type === 'MarketSnapshot') && e.token && !e.token.startsWith('REF:'))
    .map(e => ({ token: e.token!, t: c.mode === 'OBSERVED' ? e.observed_at : e.available_at })).filter(x => x.t < testFrom);
  const signals = [...(training?.trades ?? []), ...(validation?.trades ?? [])].map(t => ({ token: t.token, t: t.decisionTime }));
  const sample = [...Array.from({ length: Math.min(k, observations.length) }, () => observations[Math.floor(rng() * observations.length)]!),
    ...Array.from({ length: Math.min(k, signals.length) }, () => signals[Math.floor(rng() * signals.length)]!)];
  for (const fid of c.strategy.features)
    violations.push(...viewLeakageCases(fid, sample.map(x => ({ t: x.t, token: x.token, compute: (v: Parameters<typeof computeFeatures>[2]) => computeFeatures(c.features, [fid], v, x.token).values[fid] })),
      p.events, c.mode, { seed: seedFrom(`${c.seed}:${fid}`) }).violations);
  if (violations.length) {
    const record = await registry.conclude(id, { at: p.now(), run_id: null, result: 'INVALID', metrics: null, sample_size: 0, baseline: null, deflated_sharpe: null,
      expected_max_sharpe: null, failure_reason: `LEAKAGE: ${violations.length} violation(s), first ${violations[0]!.kind} in ${violations[0]!.subject}`,
      leakage: { passed: false, violations: violations.length }, notes: violations.slice(0, 20).map(v => `${v.kind} ${v.subject}: ${v.detail}`) });
    return { record, training, validation, test: null, leakage: violations };
  }
  if (validation) await registry.recordValidation(id, validation.run_id, validation.metrics, p.now());

  // ---------------------------------------------------------------- the sealed test, once
  const holdout = await registry.openHoldout(id, p.actor, p.now());
  const test = runBacktest(p.events, { ...cfg, period: p.periods.test });
  const baseline = randomEntryBaseline(p.events, { ...cfg, period: p.periods.test }, test, p.baselineRepetitions ?? 30);
  const returns = test.trades.filter(t => t.status === 'FILLED' && !t.flags.includes('INCOMPLETE_PATH')).map(t => t.netReturnPct);
  const verdict = decide(test.metrics, baseline, p.trials, rule, returns);
  const notes = [...test.assumptions];
  if (holdout.contaminated) notes.push(`holdout use #${holdout.use_number}`);
  if (Object.keys(test.featureErrors).length) notes.push(`feature errors: ${JSON.stringify(test.featureErrors).slice(0, 300)}`);
  if (test.metrics.top3PnlShare !== null && test.metrics.top3PnlShare > 1) notes.push('OUTLIER_DEPENDENT: the three best trades exceed the total PnL');
  const record = await registry.conclude(id, { at: p.now(), run_id: test.run_id, result: verdict.result, metrics: test.metrics, sample_size: returns.length,
    failure_reason: verdict.failure_reason, baseline, deflated_sharpe: verdict.deflated, expected_max_sharpe: verdict.expectedMax, leakage: { passed: true, violations: 0 }, notes });
  return { record, training, validation, test, leakage: [] };
}

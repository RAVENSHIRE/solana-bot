import { contentId } from '../core/canonical';
import { AppendLog } from '../core/append-log';
import type { FeatureRegistry } from '../features/registry';
import type { ExitSpec, RuleCheck, StrategySpec } from '../strategy/versioning';

/**
 * The curiosity scout's intake. A scout wanders through launches, charts, X and creators and notices things. It never
 * trades and it never turns a story into a decision. What it may do:
 *
 *   OBSERVE → CONNECT → NOTICE    an Observation: free text plus the tokens and event ids it refers to
 *   → HYPOTHESIZE                 a Hypothesis: a measurable condition on registered features, an expected effect,
 *                                 how it could be shown false, the sample it needs
 *   → HAND OFF                    `hypothesisStrategy` turns it into an (unregistered) strategy spec that the standard
 *                                 experiment pipeline tests: point in time, sealed holdout, baselines, deflated Sharpe
 *
 * "I noticed projects with X behaviour frequently developed Y behaviour" becomes: condition X (feature rules), outcome
 * Y (net return after costs over a horizon, against random entries), falsified if the holdout CI excludes the claim.
 */

export interface Observation {
  id: string; at: number; agent: string;
  text: string;
  tokens: string[];
  event_ids: string[];
  tags: string[];
}

export type HypothesisStatus = 'PROPOSED' | 'ACCEPTED_FOR_TEST' | 'TESTING' | 'SUPPORTED' | 'REJECTED' | 'INCONCLUSIVE' | 'INVALID' | 'WITHDRAWN';
export interface Hypothesis {
  id: string; created_at: number; agent: string;
  statement: string;
  observation_ids: string[];
  /** The measurable condition: rules on registered features (the strategy rule grammar). */
  condition: RuleCheck[];
  /** The claimed effect: net return after costs, higher or lower than random entries, over a holding horizon. */
  expected: { direction: 'HIGHER' | 'LOWER'; horizonMin: number; metric: 'NET_RETURN_VS_RANDOM_ENTRY' };
  /** What result would show it false, in plain words, written before testing. */
  falsification: string;
  minimum_sample: number;
  status: HypothesisStatus;
  experiment_ids: string[];
}

export type HypothesisInput = Omit<Hypothesis, 'id' | 'created_at' | 'status' | 'experiment_ids'>;

/** Every reason the hypothesis is not testable as written (empty when it is). */
export function validateHypothesis(h: HypothesisInput, features: FeatureRegistry): string[] {
  const issues: string[] = [];
  if (h.statement.trim().length < 20) issues.push('STATEMENT_TOO_SHORT: state the claim in a full sentence');
  if (!h.condition.length) issues.push('NO_CONDITION: a hypothesis needs at least one measurable condition');
  for (const r of h.condition) if (!features.has(r.feature)) issues.push(`UNKNOWN_FEATURE ${r.feature}: register it (with leakage notes) first`);
  if (!(h.expected.horizonMin > 0 && h.expected.horizonMin <= 7 * 24 * 60)) issues.push('HORIZON_INVALID: 1 minute to 7 days');
  if (h.falsification.trim().length < 20) issues.push('NO_FALSIFICATION: say which result would show it false');
  if (!(h.minimum_sample >= 30)) issues.push('SAMPLE_TOO_SMALL: at least 30 trades');
  if (h.expected.direction === 'LOWER' && h.condition.length === 0) issues.push('LOWER needs a condition');
  return issues;
}

/**
 * The hypothesis as a strategy that the experiment pipeline can test. Exits default to a neutral time exit at the
 * horizon with a wide stop, so the test measures the condition, not an exit tuned to it. Unregistered: the id names
 * the hypothesis, the family is `hyp`.
 */
export function hypothesisStrategy(h: Hypothesis, o: { sizingUsd?: number; exit?: ExitSpec; cooldownMin?: number } = {}): StrategySpec {
  return {
    id: `hyp_${h.id.slice(4, 12)}_v001`.toLowerCase().replace(/[^a-z0-9_]/g, ''), family: `hyp_${h.id.slice(4, 12)}`.toLowerCase().replace(/[^a-z0-9_]/g, ''), parent: null,
    description: h.statement, entry: h.condition,
    exit: o.exit ?? { stopLossPct: 90, takeProfitPct: null, trailing: null, maxHoldMin: h.expected.horizonMin },
    sizing: { usd: o.sizingUsd ?? 2 }, cooldownMin: o.cooldownMin ?? h.expected.horizonMin,
    provenance: { source: `hypothesis ${h.id} by ${h.agent}`, notes: h.falsification },
  };
}

type Rec = { kind: 'OBSERVATION'; data: Observation } | { kind: 'HYPOTHESIS'; data: Hypothesis } | { kind: 'STATUS'; id: string; status: HypothesisStatus; at: number; actor: string; experiment_id?: string; note?: string };

/** Append-only book of observations and hypotheses (statuses are new records, never edits). */
export class HypothesisBook {
  private readonly recs: Rec[] = [];
  private constructor(private readonly log: AppendLog<Rec> | null) {}
  static memory(): HypothesisBook { return new HypothesisBook(null); }
  static async open(dir: string, o: { lock?: boolean } = {}): Promise<HypothesisBook> {
    const loaded: Rec[] = [];
    const log = await AppendLog.open<Rec>({ dir, prefix: 'hypotheses', lock: o.lock }, l => { loaded.push(l.data); });
    const b = new HypothesisBook(log); b.recs.push(...loaded); return b;
  }
  private async write(r: Rec): Promise<void> { if (this.log) await this.log.append([r]); this.recs.push(r); }

  async observe(o: Omit<Observation, 'id'>): Promise<Observation> {
    if (!o.text.trim()) throw new Error('OBSERVATION_EMPTY');
    const obs: Observation = { ...o, id: contentId('obs', o) };
    if (!this.recs.some(r => r.kind === 'OBSERVATION' && r.data.id === obs.id)) await this.write({ kind: 'OBSERVATION', data: obs });
    return obs;
  }

  async propose(input: HypothesisInput, at: number, features: FeatureRegistry): Promise<{ hypothesis: Hypothesis | null; issues: string[] }> {
    const issues = validateHypothesis(input, features);
    for (const id of input.observation_ids) if (!this.recs.some(r => r.kind === 'OBSERVATION' && r.data.id === id)) issues.push(`UNKNOWN_OBSERVATION ${id}`);
    if (issues.length) return { hypothesis: null, issues };
    const id = contentId('hyp', { statement: input.statement, condition: input.condition, expected: input.expected, falsification: input.falsification });
    const existing = this.get(id);
    if (existing) return { hypothesis: existing, issues: [] };
    const h: Hypothesis = { ...input, id, created_at: at, status: 'PROPOSED', experiment_ids: [] };
    await this.write({ kind: 'HYPOTHESIS', data: h });
    return { hypothesis: h, issues: [] };
  }

  async setStatus(id: string, status: HypothesisStatus, at: number, actor: string, experimentId?: string, note?: string): Promise<Hypothesis> {
    if (!this.get(id)) throw new Error(`Unknown hypothesis ${id}`);
    await this.write({ kind: 'STATUS', id, status, at, actor, experiment_id: experimentId, note });
    return this.get(id)!;
  }

  get(id: string): Hypothesis | null {
    const base = this.recs.find((r): r is Extract<Rec, { kind: 'HYPOTHESIS' }> => r.kind === 'HYPOTHESIS' && r.data.id === id)?.data;
    if (!base) return null;
    const updates = this.recs.filter((r): r is Extract<Rec, { kind: 'STATUS' }> => r.kind === 'STATUS' && r.id === id);
    return { ...base, status: updates.at(-1)?.status ?? base.status,
      experiment_ids: [...new Set([...base.experiment_ids, ...updates.map(u => u.experiment_id).filter((x): x is string => !!x)])] };
  }
  hypotheses(): Hypothesis[] { return this.recs.filter((r): r is Extract<Rec, { kind: 'HYPOTHESIS' }> => r.kind === 'HYPOTHESIS').map(r => this.get(r.data.id)!); }
  observations(): Observation[] { return this.recs.filter((r): r is Extract<Rec, { kind: 'OBSERVATION' }> => r.kind === 'OBSERVATION').map(r => r.data); }
  async close(): Promise<void> { await this.log?.close(); }
}

import { contentId, fingerprint } from '../core/canonical';
import { buildDataset, type DatasetManifest } from '../events/dataset';
import type { EventStore } from '../events/store';
import { MemoryEventStore, computeStats } from '../events/store';
import type { ResearchEvent } from '../events/types';
import { computeFeatures, type FeatureRegistry } from '../features/registry';
import { KnowledgeIndex } from '../pit/view';
import { evaluateEntry, StrategyRegistry, type StrategyVersion } from '../strategy/versioning';
import type { ExecutionModelSpec } from '../execution/model';
import type { RiskLimits } from '../risk/engine';
import { runBacktest, type BacktestConfig, type BacktestResult } from '../backtest/engine';
import { randomEntryBaseline, timeSplit, walkForward } from '../backtest/analysis';
import { DEFAULT_DECISION_RULE, type ExperimentRegistry } from '../experiments/registry';
import { runExperiment } from '../experiments/runner';
import { computeRegime, regimeKey } from '../regime/regime';
import { explainMissingAlert } from '../observability/why';
import type { HealthSnapshot } from '../observability/health';
import { HypothesisBook, hypothesisStrategy, type HypothesisInput } from '../curiosity/hypothesis';
import { KNOWN_CASES, knownCaseTokens } from '../curiosity/cases';

/**
 * The research API that agents (and people) use. Deterministic systems do the work; agents propose and investigate.
 *
 * Capabilities are separate and granted per role:
 *   READ        inspect events, tokens, alerts, features, experiments, strategies, health, data quality
 *   RESEARCH    run backtests, walk-forwards, comparisons, and register experiments (stopping before the holdout)
 *   HYPOTHESIS  submit observations and hypotheses (the curiosity scout)
 *   HOLDOUT     open a sealed test period and conclude an experiment (supervisor / human only)
 * There is no TRADING capability and no tool that places, signs or sizes an order: production stays gated outside
 * this API. Every call is audited as an AgentAction event, allowed or denied.
 */

export type Capability = 'READ' | 'RESEARCH' | 'HYPOTHESIS' | 'HOLDOUT';
export type AgentRole = 'DATA_AGENT' | 'FEATURE_AGENT' | 'HYPOTHESIS_AGENT' | 'BACKTEST_AGENT' | 'LEAKAGE_AGENT' | 'ADVERSARIAL_AGENT' | 'REGIME_AGENT' |
  'EXECUTION_AGENT' | 'RISK_AGENT' | 'REPORTING_AGENT' | 'SUPERVISOR_AGENT' | 'CURIOSITY_SCOUT' | 'HUMAN_OPERATOR';

export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, readonly Capability[]>> = Object.freeze({
  DATA_AGENT: ['READ'], REGIME_AGENT: ['READ'], RISK_AGENT: ['READ'], REPORTING_AGENT: ['READ'],
  FEATURE_AGENT: ['READ', 'RESEARCH'], BACKTEST_AGENT: ['READ', 'RESEARCH'], LEAKAGE_AGENT: ['READ', 'RESEARCH'],
  ADVERSARIAL_AGENT: ['READ', 'RESEARCH'], EXECUTION_AGENT: ['READ', 'RESEARCH'],
  HYPOTHESIS_AGENT: ['READ', 'HYPOTHESIS'], CURIOSITY_SCOUT: ['READ', 'HYPOTHESIS'],
  SUPERVISOR_AGENT: ['READ', 'RESEARCH', 'HYPOTHESIS', 'HOLDOUT'], HUMAN_OPERATOR: ['READ', 'RESEARCH', 'HYPOTHESIS', 'HOLDOUT'],
});

export interface Principal { id: string; role: AgentRole }
export type ApiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface ResearchContext {
  /** The events research works on (loaded from the stores). */
  events: readonly ResearchEvent[];
  features: FeatureRegistry;
  strategies: StrategyRegistry;
  experiments: ExperimentRegistry;
  hypotheses: HypothesisBook;
  execution: ExecutionModelSpec;
  risk: RiskLimits;
  /** Where AgentAction audit events go. */
  audit: EventStore;
  health?: () => HealthSnapshot | null;
  now: () => number;
  codeVersion: string;
}

interface ToolSpec {
  name: string; capability: Capability; description: string;
  input: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (ctx: ResearchContext, args: Record<string, unknown>, who: Principal) => Promise<unknown> | unknown;
}

class ArgError extends Error { constructor(message: string) { super(message); this.name = 'ArgError'; } }
const str = (a: Record<string, unknown>, k: string, required = true): string => {
  const v = a[k];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (!required && (v === undefined || v === null)) return '';
  throw new ArgError(`${k}: string required`);
};
const time = (a: Record<string, unknown>, k: string, fallback?: number): number => {
  const v = a[k];
  if (v === undefined || v === null) { if (fallback !== undefined) return fallback; throw new ArgError(`${k}: time required (ISO or epoch ms)`); }
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new ArgError(`${k}: invalid time`);
  return t;
};
const int = (a: Record<string, unknown>, k: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const v = a[k] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ArgError(`${k}: integer in [${min}, ${max}]`);
  return v;
};
const mode = (a: Record<string, unknown>) => { const m = a.mode ?? 'AVAILABLE'; if (m !== 'AVAILABLE' && m !== 'OBSERVED') throw new ArgError('mode: AVAILABLE or OBSERVED'); return m; };

function strategyOf(ctx: ResearchContext, id: string): StrategyVersion {
  if (!ctx.strategies.has(id)) throw new ArgError(`unknown strategy ${id}`);
  return ctx.strategies.get(id);
}
function dataset(ctx: ResearchContext): { manifest: DatasetManifest; events: ResearchEvent[] } {
  return buildDataset(ctx.events, { description: 'research API working set', createdAt: 0 });
}
function config(ctx: ResearchContext, s: StrategyVersion, a: Record<string, unknown>, datasetVersion: string): BacktestConfig {
  const cases = knownCaseTokens(new Set(ctx.events.map(e => e.token).filter((t): t is string => !!t)));
  return { strategy: s, features: ctx.features, execution: ctx.execution, risk: ctx.risk, mode: mode(a), seed: int(a, 'seed', 1), datasetVersion,
    codeVersion: ctx.codeVersion, excludeTokens: a.include_known_cases === true ? [] : cases, regime: v => regimeKey(computeRegime(v)) };
}
const summary = (r: BacktestResult) => ({ run_id: r.run_id, identity: r.identity, assumptions: r.assumptions, decisions: r.decisions, signals: r.signals,
  metrics: r.metrics, riskDenials: r.riskDenials, featureErrors: r.featureErrors, skipped: r.skipped, trades: r.trades.length });

const TOOLS: ToolSpec[] = [
  // ---------------------------------------------------------------- READ
  { name: 'get_system_health', capability: 'READ', description: 'Latest health snapshot (components, latencies, errors) and the event store summary.',
    input: { type: 'object', properties: {} },
    run: ctx => ({ health: ctx.health?.() ?? null, lastHealthEvent: ctx.events.filter(e => e.event_type === 'HealthSnapshot').at(-1)?.payload ?? null }) },
  { name: 'get_data_quality', capability: 'READ', description: 'Counts by type, source, quality and capture; ingestion latency per source; quality issues and feed gaps.',
    input: { type: 'object', properties: { token: { type: 'string' } } },
    run: (ctx, a) => {
      const token = str(a, 'token', false), list = token ? ctx.events.filter(e => e.token === token) : ctx.events;
      const issues = new Map<string, number>();
      for (const e of list) for (const i of e.quality.issues) issues.set(i.split(':')[0]!, (issues.get(i.split(':')[0]!) ?? 0) + 1);
      return { stats: computeStats(list), issues: Object.fromEntries([...issues].sort((x, y) => y[1] - x[1])),
        gaps: ctx.events.filter(e => e.event_type === 'DataQualityIssue').slice(-50).map(e => ({ at: e.timestamp, ...e.payload })) };
    } },
  { name: 'get_token', capability: 'READ', description: 'What is known about a token: first/last observation, event counts, latest market snapshot, alerts, known-case status.',
    input: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    run: (ctx, a) => {
      const token = str(a, 'token'), list = ctx.events.filter(e => e.token === token);
      if (!list.length) return { token, known: false };
      const byType: Record<string, number> = {};
      for (const e of list) byType[e.event_type] = (byType[e.event_type] ?? 0) + 1;
      return { token, known: true, firstObservedAt: Math.min(...list.map(e => e.observed_at)), lastObservedAt: Math.max(...list.map(e => e.observed_at)), byType,
        latestSnapshot: list.filter(e => e.event_type === 'MarketSnapshot').at(-1)?.payload ?? null,
        alerts: list.filter(e => e.event_type === 'AlertGenerated').map(e => ({ alert_id: e.payload.alert_id, kind: e.payload.kind, at: e.timestamp })),
        knownCase: KNOWN_CASES.find(c => c.mint === token) ?? null };
    } },
  { name: 'get_token_events', capability: 'READ', description: 'Events of a token, optionally only those known by a time (point in time), newest last.',
    input: { type: 'object', properties: { token: { type: 'string' }, types: { type: 'array', items: { type: 'string' } }, known_by: { type: 'string' }, mode: { enum: ['AVAILABLE', 'OBSERVED'] }, limit: { type: 'integer' } }, required: ['token'] },
    run: (ctx, a) => {
      const token = str(a, 'token'), types = Array.isArray(a.types) ? a.types.map(String) : null, m = mode(a), lim = int(a, 'limit', 500, 1, 5_000);
      const at = a.known_by === undefined ? null : time(a, 'known_by');
      return ctx.events.filter(e => e.token === token && (!types || types.includes(e.event_type)) && (at === null || ((m === 'OBSERVED' ? e.observed_at : e.available_at) <= at && e.timestamp <= at)))
        .sort((x, y) => x.timestamp - y.timestamp).slice(-lim);
    } },
  { name: 'get_alert', capability: 'READ', description: 'An alert with its delivery outcome.',
    input: { type: 'object', properties: { alert_id: { type: 'string' } }, required: ['alert_id'] },
    run: (ctx, a) => {
      const id = str(a, 'alert_id'), gen = ctx.events.find(e => e.event_type === 'AlertGenerated' && e.payload.alert_id === id);
      if (!gen) throw new ArgError(`unknown alert ${id}`);
      return { alert_id: id, kind: gen.payload.kind, token: gen.token, at: gen.timestamp, title: (gen.payload.what_happened as { title?: string })?.title ?? null,
        delivery: gen.payload.delivery, outcomes: ctx.events.filter(e => e.event_type === 'AlertDelivered' && e.payload.alert_id === id).map(e => e.payload) };
    } },
  { name: 'get_alert_evidence', capability: 'READ', description: 'The immutable evidence snapshot taken when the alert was generated (what the system knew, and when).',
    input: { type: 'object', properties: { alert_id: { type: 'string' } }, required: ['alert_id'] },
    run: (ctx, a) => {
      const id = str(a, 'alert_id'), gen = ctx.events.find(e => e.event_type === 'AlertGenerated' && e.payload.alert_id === id);
      if (!gen) throw new ArgError(`unknown alert ${id}`);
      return { event_id: gen.event_id, recorded_at: gen.recorded_at, evidence: gen.payload };
    } },
  { name: 'explain_missing_alert', capability: 'READ', description: 'Why no alert reached the phone for a token in a window: the first pipeline stage where it was lost.',
    input: { type: 'object', properties: { token: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['token', 'from', 'to'] },
    run: (ctx, a) => explainMissingAlert(ctx.events, { token: str(a, 'token'), from: time(a, 'from'), to: time(a, 'to') }) },
  { name: 'list_features', capability: 'READ', description: 'Registered features with definitions, windows, leakage risk and fingerprints.',
    input: { type: 'object', properties: {} },
    run: ctx => ctx.features.list().map(({ compute: _c, ...f }) => f) },
  { name: 'get_feature', capability: 'READ', description: 'Feature values for a token at a decision time, from what was known then (point in time).',
    input: { type: 'object', properties: { token: { type: 'string' }, at: { type: 'string' }, features: { type: 'array', items: { type: 'string' } }, mode: { enum: ['AVAILABLE', 'OBSERVED'] } }, required: ['token', 'at'] },
    run: (ctx, a) => {
      const ids = Array.isArray(a.features) ? a.features.map(String) : ctx.features.list().map(f => f.id);
      for (const id of ids) if (!ctx.features.has(id)) throw new ArgError(`unknown feature ${id}`);
      return computeFeatures(ctx.features, ids, new KnowledgeIndex(ctx.events, mode(a)).at(time(a, 'at')), str(a, 'token'));
    } },
  { name: 'get_strategy_version', capability: 'READ', description: 'A strategy version: rules, exits, fingerprint, lineage and what it does not model.',
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (ctx, a) => { const v = strategyOf(ctx, str(a, 'id')); return { version: v, lineage: ctx.strategies.lineage(v.id).map(x => x.id) }; } },
  { name: 'list_strategies', capability: 'READ', description: 'Registered strategy versions.',
    input: { type: 'object', properties: {} }, run: ctx => ctx.strategies.list().map(v => ({ id: v.id, fingerprint: v.fingerprint, parent: v.parent, description: v.description })) },
  { name: 'get_experiment', capability: 'READ', description: 'An experiment record: design, periods, result, metrics, holdout use, failure reason.',
    input: { type: 'object', properties: { experiment_id: { type: 'string' } }, required: ['experiment_id'] },
    run: (ctx, a) => { const r = ctx.experiments.get(str(a, 'experiment_id')); if (!r) throw new ArgError('unknown experiment'); return r; } },
  { name: 'list_experiments', capability: 'READ', description: 'All experiments with their verdicts.',
    input: { type: 'object', properties: {} },
    run: ctx => ctx.experiments.list().map(r => ({ experiment_id: r.experiment_id, hypothesis: r.hypothesis, strategy: r.strategy_version.id, result: r.result, failure_reason: r.failure_reason,
      sample_size: r.sample_size, holdout: r.holdout })) },
  { name: 'inspect_failure', capability: 'READ', description: 'Why an experiment failed or was inconclusive, with its notes; or why a strategy did not signal for a token at a time.',
    input: { type: 'object', properties: { experiment_id: { type: 'string' }, strategy: { type: 'string' }, token: { type: 'string' }, at: { type: 'string' } } },
    run: (ctx, a) => {
      if (a.experiment_id) {
        const r = ctx.experiments.get(str(a, 'experiment_id')); if (!r) throw new ArgError('unknown experiment');
        return { result: r.result, failure_reason: r.failure_reason, notes: r.notes, sample_size: r.sample_size, baseline: r.baseline, deflated_sharpe: r.deflated_sharpe, trials: r.trials };
      }
      const s = strategyOf(ctx, str(a, 'strategy')), v = computeFeatures(ctx.features, s.features, new KnowledgeIndex(ctx.events, mode(a)).at(time(a, 'at')), str(a, 'token'));
      return { verdict: evaluateEntry(s, v.values), errors: v.errors, provenance: v.provenance };
    } },
  { name: 'list_hypotheses', capability: 'READ', description: 'Observations and hypotheses with their status.',
    input: { type: 'object', properties: {} }, run: ctx => ({ hypotheses: ctx.hypotheses.hypotheses(), observations: ctx.hypotheses.observations().length }) },
  { name: 'list_known_cases', capability: 'READ', description: 'Anecdotes (winners, misses, clones, rugs) that are excluded from evaluation.',
    input: { type: 'object', properties: {} }, run: () => KNOWN_CASES },
  // ---------------------------------------------------------------- RESEARCH
  { name: 'run_backtest', capability: 'RESEARCH', description: 'Point-in-time backtest of a registered strategy over the working set (known cases excluded unless include_known_cases).',
    input: { type: 'object', properties: { strategy: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, mode: { enum: ['AVAILABLE', 'OBSERVED'] }, seed: { type: 'integer' },
      include_known_cases: { type: 'boolean' } }, required: ['strategy'] },
    run: (ctx, a) => {
      const ds = dataset(ctx), s = strategyOf(ctx, str(a, 'strategy'));
      const period = a.from === undefined && a.to === undefined ? undefined : { from: time(a, 'from', -Infinity), to: time(a, 'to', Infinity) };
      const r = runBacktest(ds.events, { ...config(ctx, s, a, ds.manifest.dataset_version), period });
      return { ...summary(r), random_entry_baseline: randomEntryBaseline(ds.events, { ...config(ctx, s, a, ds.manifest.dataset_version), period }, r, 20) };
    } },
  { name: 'compare_strategies', capability: 'RESEARCH', description: 'The same data, period and execution model for several strategies, side by side.',
    input: { type: 'object', properties: { strategies: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, mode: { enum: ['AVAILABLE', 'OBSERVED'] } }, required: ['strategies'] },
    run: (ctx, a) => {
      const ids = Array.isArray(a.strategies) ? a.strategies.map(String) : []; if (ids.length < 2 || ids.length > 10) throw new ArgError('strategies: 2 to 10 ids');
      const ds = dataset(ctx), period = a.from === undefined && a.to === undefined ? undefined : { from: time(a, 'from', -Infinity), to: time(a, 'to', Infinity) };
      return ids.map(id => { const r = runBacktest(ds.events, { ...config(ctx, strategyOf(ctx, id), a, ds.manifest.dataset_version), period }); return { strategy: id, run_id: r.run_id, metrics: r.metrics }; });
    } },
  { name: 'run_walk_forward', capability: 'RESEARCH', description: 'Rolling walk-forward over candidate strategies; reports out-of-sample metrics and the trials it took.',
    input: { type: 'object', properties: { candidates: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, train_hours: { type: 'number' }, test_hours: { type: 'number' } },
      required: ['candidates', 'from', 'to', 'train_hours', 'test_hours'] },
    run: (ctx, a) => {
      const ids = Array.isArray(a.candidates) ? a.candidates.map(String) : []; if (!ids.length) throw new ArgError('candidates required');
      const ds = dataset(ctx), first = strategyOf(ctx, ids[0]!), base = config(ctx, first, a, ds.manifest.dataset_version);
      const hours = (k: string) => { const v = a[k]; if (typeof v !== 'number' || !(v > 0)) throw new ArgError(`${k}: hours > 0`); return v * 3_600_000; };
      const { strategy: _s, ...rest } = base;
      return walkForward(ds.events, rest, ids.map(id => strategyOf(ctx, id)), { from: time(a, 'from'), to: time(a, 'to'), trainMs: hours('train_hours'), testMs: hours('test_hours') });
    } },
  { name: 'create_experiment', capability: 'RESEARCH', description: 'Pre-register an experiment and run training, validation and leakage tests. The sealed test period stays closed (needs HOLDOUT).',
    input: { type: 'object', properties: { hypothesis: { type: 'string' }, hypothesis_id: { type: 'string' }, strategy: { type: 'string' }, trials: { type: 'integer' },
      split: { type: 'array', items: { type: 'number' } }, from: { type: 'string' }, to: { type: 'string' }, mode: { enum: ['AVAILABLE', 'OBSERVED'] } }, required: ['hypothesis', 'strategy', 'trials'] },
    run: (ctx, a, who) => experiment(ctx, a, who, false) },
  // ---------------------------------------------------------------- HYPOTHESIS
  { name: 'submit_observation', capability: 'HYPOTHESIS', description: 'Record something noticed (free text, tokens, event ids). Not a signal and not a decision.',
    input: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'array', items: { type: 'string' } }, event_ids: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
    run: (ctx, a, who) => ctx.hypotheses.observe({ at: ctx.now(), agent: who.id, text: str(a, 'text'), tokens: (a.tokens as string[] | undefined)?.map(String) ?? [],
      event_ids: (a.event_ids as string[] | undefined)?.map(String) ?? [], tags: (a.tags as string[] | undefined)?.map(String) ?? [] }) },
  { name: 'submit_hypothesis', capability: 'HYPOTHESIS', description: 'Turn observations into a falsifiable hypothesis: a condition on registered features, the expected effect, what would refute it.',
    input: { type: 'object', properties: { statement: { type: 'string' }, observation_ids: { type: 'array', items: { type: 'string' } }, condition: { type: 'array' },
      direction: { enum: ['HIGHER', 'LOWER'] }, horizon_min: { type: 'number' }, falsification: { type: 'string' }, minimum_sample: { type: 'integer' } },
      required: ['statement', 'condition', 'direction', 'horizon_min', 'falsification'] },
    run: async (ctx, a, who) => {
      const input: HypothesisInput = { agent: who.id, statement: str(a, 'statement'), observation_ids: (a.observation_ids as string[] | undefined)?.map(String) ?? [],
        condition: Array.isArray(a.condition) ? a.condition as HypothesisInput['condition'] : [],
        expected: { direction: a.direction === 'LOWER' ? 'LOWER' : 'HIGHER', horizonMin: Number(a.horizon_min), metric: 'NET_RETURN_VS_RANDOM_ENTRY' },
        falsification: str(a, 'falsification'), minimum_sample: int(a, 'minimum_sample', 30, 1) };
      const r = await ctx.hypotheses.propose(input, ctx.now(), ctx.features);
      if (!r.hypothesis) throw new ArgError(`not testable: ${r.issues.join('; ')}`);
      return r.hypothesis;
    } },
  // ---------------------------------------------------------------- HOLDOUT
  { name: 'conclude_experiment', capability: 'HOLDOUT', description: 'Open the sealed test period of a registered experiment once and conclude it by its pre-registered rule.',
    input: { type: 'object', properties: { hypothesis: { type: 'string' }, hypothesis_id: { type: 'string' }, strategy: { type: 'string' }, trials: { type: 'integer' },
      split: { type: 'array', items: { type: 'number' } }, from: { type: 'string' }, to: { type: 'string' }, mode: { enum: ['AVAILABLE', 'OBSERVED'] } }, required: ['hypothesis', 'strategy', 'trials'] },
    run: (ctx, a, who) => experiment(ctx, a, who, true) },
];

async function experiment(ctx: ResearchContext, a: Record<string, unknown>, who: Principal, open: boolean) {
  const ds = dataset(ctx), hypId = str(a, 'hypothesis_id', false) || null;
  let s: StrategyVersion;
  if (hypId) {
    const h = ctx.hypotheses.get(hypId); if (!h) throw new ArgError(`unknown hypothesis ${hypId}`);
    s = ctx.strategies.register(hypothesisStrategy(h));
  } else s = strategyOf(ctx, str(a, 'strategy'));
  const from = time(a, 'from', ds.manifest.first_timestamp ?? 0), to = time(a, 'to', (ds.manifest.last_timestamp ?? 0) + 1);
  const weights = Array.isArray(a.split) && a.split.length === 3 ? a.split.map(Number) : [0.5, 0.2, 0.3];
  const [training, validation, test] = timeSplit(from, to, weights);
  const run = await runExperiment(ctx.experiments, { hypothesis: str(a, 'hypothesis'), hypothesisId: hypId, config: config(ctx, s, a, ds.manifest.dataset_version),
    dataset: ds.manifest, events: ds.events, periods: { training: training!, validation: validation!, test: test! }, trials: int(a, 'trials', 1, 1),
    decisionRule: DEFAULT_DECISION_RULE, actor: `${who.role}:${who.id}`, now: ctx.now, openHoldout: open });
  if (hypId && run.record.result !== 'PENDING') await ctx.hypotheses.setStatus(hypId, run.record.result === 'SUPPORTED' ? 'SUPPORTED' : run.record.result === 'REJECTED' ? 'REJECTED'
    : run.record.result === 'INVALID' ? 'INVALID' : 'INCONCLUSIVE', ctx.now(), who.id, run.record.experiment_id);
  else if (hypId) await ctx.hypotheses.setStatus(hypId, 'TESTING', ctx.now(), who.id, run.record.experiment_id);
  return { record: run.record, training: run.training ? summary(run.training) : null, validation: run.validation ? summary(run.validation) : null,
    test: run.test ? summary(run.test) : null, leakage: run.leakage };
}

/** Tool definitions for an LLM tool-use loop (name, description, JSON schema), filtered to what a role may call. */
export function toolManifest(role?: AgentRole): Array<{ name: string; capability: Capability; description: string; input_schema: ToolSpec['input'] }> {
  const caps = role ? ROLE_CAPABILITIES[role] : null;
  return TOOLS.filter(t => !caps || caps.includes(t.capability)).map(t => ({ name: t.name, capability: t.capability, description: t.description, input_schema: t.input }));
}

export class ResearchApi {
  constructor(private readonly ctx: ResearchContext) {}

  /** Calls a tool as a principal. Never throws: denials and errors are results, and every call is audited. */
  async call(who: Principal, name: string, args: Record<string, unknown> = {}): Promise<ApiResult> {
    const started = this.ctx.now(), tool = TOOLS.find(t => t.name === name);
    let result: ApiResult;
    if (!ROLE_CAPABILITIES[who.role]) result = { ok: false, error: { code: 'UNKNOWN_ROLE', message: `unknown role ${String(who.role)}` } };
    else if (!tool) result = { ok: false, error: { code: /trade|order|sign|buy|sell|swap/i.test(name) ? 'TRADING_NOT_AVAILABLE' : 'UNKNOWN_TOOL',
      message: /trade|order|sign|buy|sell|swap/i.test(name) ? 'This API has no trading capability. Production execution is gated outside the research system.' : `unknown tool ${name}` } };
    else if (!ROLE_CAPABILITIES[who.role].includes(tool.capability)) result = { ok: false, error: { code: 'CAPABILITY_DENIED', message: `${who.role} lacks ${tool.capability} for ${name}` } };
    else {
      try { result = { ok: true, data: await tool.run(this.ctx, args && typeof args === 'object' ? args : {}, who) }; }
      catch (error) { result = { ok: false, error: { code: error instanceof ArgError ? 'INVALID_ARGUMENT' : 'TOOL_ERROR', message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }; }
    }
    await this.audit(who, name, args, result, started).catch(() => undefined);
    return result;
  }

  private async audit(who: Principal, tool: string, args: Record<string, unknown>, r: ApiResult, started: number): Promise<void> {
    let digest: string;
    try { digest = fingerprint(args ?? {}); } catch { digest = 'unhashable'; }
    await this.ctx.audit.append({ event_type: 'AgentAction', token: null, timestamp: started, observed_at: this.ctx.now(), source: 'research:api',
      payload: { agent: who.id, role: who.role, tool, args_digest: digest, ok: r.ok, error: r.ok ? null : r.error.code, duration_ms: this.ctx.now() - started },
      natural_key: contentId('call', { who, tool, digest, started }), producer: { component: 'research-api', version: '1' } });
  }
}

/** A context over an in-memory working set (tests, one-off analyses). */
export function memoryContext(o: Omit<ResearchContext, 'audit'> & { audit?: EventStore }): ResearchContext {
  return { ...o, audit: o.audit ?? new MemoryEventStore(o.now) };
}

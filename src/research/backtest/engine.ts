import { contentId } from '../core/canonical';
import { seedFrom, seededRng } from '../core/random';
import {
  bootstrapCi, maxDrawdown, mean, median, probabilisticSharpe, profitFactor, sharpe, sum, tStat, type Interval,
} from '../core/stats';
import type { KnowledgeMode, ResearchEvent } from '../events/types';
import { computeFeatures, type FeatureRegistry } from '../features/registry';
import { KnowledgeIndex, type PointInTimeView } from '../pit/view';
import { evaluateEntry, type StrategyVersion } from '../strategy/versioning';
import { executionFingerprint, simulateTrade, type ExecutableTrade, type ExecutionModelSpec, type PathPoint } from '../execution/model';
import { RiskEngine, riskFingerprint, type RiskLimits } from '../risk/engine';

/**
 * Point-in-time backtest over events. For every decision time:
 *
 *   DECISION_TIME → AVAILABLE_INFORMATION (a view) → FEATURES (versioned) → SIGNAL (strategy version)
 *   → RISK (can override) → EXECUTION (latency, impact, fees, failures on the real path) → OUTCOME
 *
 * Decisions are made only at moments when new market information became known for the token (a bar close, a
 * snapshot), at most every `decisionEveryMs`. The outcome uses the market path after the decision: that is the future
 * the trade lives in, never an input to the decision. A run is fully identified by `run_id`.
 */

export interface BacktestConfig {
  strategy: StrategyVersion;
  features: FeatureRegistry;
  execution: ExecutionModelSpec;
  risk: RiskLimits;
  /** AVAILABLE for backfilled data (with an availability model), OBSERVED to replay what the live system knew. */
  mode: KnowledgeMode;
  seed: number;
  decisionEveryMs?: number;
  /** Decisions only in [from, to). The outcome path may extend beyond `to`. */
  period?: { from: number; to: number };
  /** Tokens never traded (e.g. the known winners that inspired the rule). */
  excludeTokens?: readonly string[];
  /** System health at a decision time; absent: assumed healthy, and the assumption is recorded. */
  healthy?: (t: number) => boolean | null;
  /** Regime label at a decision time (see regime/regime.ts). */
  regime?: (view: PointInTimeView) => string | null;
  datasetVersion: string | null;
  codeVersion: string;
}

export interface BacktestTrade extends ExecutableTrade {
  strategyId: string;
  /** The strategy's feature values at the decision (what it acted on). */
  features: Record<string, number | null>;
  regime: string | null;
  risk: { decision: string; reasons: string[] };
}

export interface Metrics {
  signals: number; filled: number; notFilled: number; failed: number; incomplete: number;
  fillRatePct: number | null;
  winRatePct: number | null; meanReturnPct: number | null; medianReturnPct: number | null; totalPnlUsd: number;
  profitFactor: number | null; maxDrawdownUsd: number; worstReturnPct: number | null; bestReturnPct: number | null;
  sharpePerTrade: number | null; tStat: number | null; meanReturnCi95: Interval | null; probabilisticSharpe: number | null;
  avgHoldMin: number | null;
  /** Share of total PnL from the 3 best trades: near or above 1 means a few outliers carry the result. */
  top3PnlShare: number | null;
  theoreticalMeanReturnPct: number | null;
  /** Theoretical minus executable mean return over the same filled trades (percentage points). */
  executionGapPct: number | null;
}

export interface BacktestResult {
  run_id: string;
  identity: {
    strategy_id: string; strategy_fingerprint: string; feature_fingerprints: Record<string, string>;
    execution_model: string; execution_fingerprint: string; risk_fingerprint: string; dataset_version: string | null;
    mode: KnowledgeMode; seed: number; decision_every_ms: number; period: { from: number; to: number } | null;
    exclude_tokens: string[]; code_version: string;
  };
  assumptions: string[];
  decisions: number;
  signals: number;
  trades: BacktestTrade[];
  riskDenials: Record<string, number>;
  featureErrors: Record<string, number>;
  skipped: Record<string, number>;
  metrics: Metrics;
}

const MIN = 60_000;
const PRICE_TYPES = ['Candle', 'MarketSnapshot'] as const;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The market path of one token, in event time, with liquidity carried forward from the latest observation. */
export function marketPath(events: readonly ResearchEvent[]): PathPoint[] {
  const sorted = events.filter(e => e.quality.status !== 'INVALID' && (PRICE_TYPES.includes(e.event_type as typeof PRICE_TYPES[number]) || e.event_type === 'LiquidityChange'))
    .sort((a, b) => a.timestamp - b.timestamp || (a.event_id < b.event_id ? -1 : 1));
  const out: PathPoint[] = [];
  let liquidity: number | null = null;
  for (const e of sorted) {
    const liq = num(e.payload.liquidity_usd);
    if (liq !== null) liquidity = liq;
    if (e.event_type === 'Candle') {
      const c = num(e.payload.c), h = num(e.payload.h), l = num(e.payload.l), o = num(e.payload.o), interval = num(e.payload.interval_ms);
      if (c === null || h === null || l === null || c <= 0) continue;
      out.push({ ts: e.timestamp, price: c, high: h, low: l, liquidityUsd: liquidity, ...(o !== null && interval !== null ? { open: o, start: e.timestamp - interval } : {}) });
    } else if (e.event_type === 'MarketSnapshot') {
      const p = num(e.payload.price_usd);
      if (p !== null && p > 0) out.push({ ts: e.timestamp, price: p, high: p, low: p, liquidityUsd: liquidity });
    }
  }
  return out;
}

export function computeMetrics(trades: readonly ExecutableTrade[], o: { seed?: number } = {}): Metrics {
  const filled = trades.filter(t => t.status === 'FILLED'), complete = filled.filter(t => !t.flags.includes('INCOMPLETE_PATH'));
  const r = complete.map(t => t.netReturnPct), pnl = [...complete].sort((a, b) => a.exit!.at - b.exit!.at).map(t => t.netPnlUsd);
  const total = sum(trades.map(t => (t.status === 'FILLED' && t.flags.includes('INCOMPLETE_PATH') ? 0 : t.netPnlUsd)));
  const best3 = sum([...pnl].sort((a, b) => b - a).slice(0, 3));
  const theo = complete.map(t => t.theoretical.returnPct).filter((x): x is number => x !== null);
  return {
    signals: trades.length, filled: filled.length, notFilled: trades.filter(t => t.status === 'NOT_FILLED').length,
    failed: trades.filter(t => t.status === 'FAILED').length, incomplete: filled.length - complete.length,
    fillRatePct: trades.length ? filled.length / trades.length * 100 : null,
    winRatePct: r.length ? r.filter(x => x > 0).length / r.length * 100 : null, meanReturnPct: mean(r), medianReturnPct: median(r), totalPnlUsd: total,
    profitFactor: profitFactor(r), maxDrawdownUsd: maxDrawdown(pnl), worstReturnPct: r.length ? Math.min(...r) : null, bestReturnPct: r.length ? Math.max(...r) : null,
    sharpePerTrade: sharpe(r), tStat: tStat(r), meanReturnCi95: bootstrapCi(r, { seed: o.seed ?? 1 }), probabilisticSharpe: probabilisticSharpe(r),
    avgHoldMin: complete.length ? mean(complete.map(t => (t.exit!.at - t.entry!.at) / MIN)) : null,
    top3PnlShare: total > 0 ? best3 / total : null,
    theoreticalMeanReturnPct: mean(theo),
    executionGapPct: theo.length === r.length && r.length ? mean(theo)! - mean(r)! : null,
  };
}

export function runBacktest(events: readonly ResearchEvent[], cfg: BacktestConfig): BacktestResult {
  const every = cfg.decisionEveryMs ?? MIN, assumptions: string[] = [];
  if (!cfg.healthy) assumptions.push('SYSTEM_HEALTH_ASSUMED (historical data carries no health record)');
  if (cfg.mode === 'OBSERVED') assumptions.push('OBSERVED knowledge: reproduces what the live system knew, including its gaps');
  const excluded = new Set(cfg.excludeTokens ?? []);
  const index = new KnowledgeIndex(events, cfg.mode);
  const risk = new RiskEngine(cfg.risk);
  const riskFeatures = ['liquidity_usd@v1', 'price_usd@v1'].filter(id => cfg.features.has(id));
  const featureIds = [...new Set([...cfg.strategy.features, ...riskFeatures])];

  // Token paths (outcomes) and decision times (moments new market information became known).
  const byToken = new Map<string, ResearchEvent[]>();
  for (const e of events) if (e.token && !e.token.startsWith('REF:')) { const l = byToken.get(e.token); if (l) l.push(e); else byToken.set(e.token, [e]); }
  const paths = new Map<string, PathPoint[]>(), decisions: Array<{ t: number; token: string }> = [];
  for (const [token, list] of byToken) {
    if (excluded.has(token)) continue;
    paths.set(token, marketPath(list));
    let last = -Infinity;
    const known = list.filter(e => PRICE_TYPES.includes(e.event_type as typeof PRICE_TYPES[number]) && e.quality.status !== 'INVALID')
      .map(e => (cfg.mode === 'OBSERVED' ? e.observed_at : e.available_at)).sort((a, b) => a - b);
    for (const t of known) {
      if (cfg.period && (t < cfg.period.from || t >= cfg.period.to)) continue;
      if (t - last < every) continue;
      decisions.push({ t, token }); last = t;
    }
  }
  decisions.sort((a, b) => a.t - b.t || (a.token < b.token ? -1 : 1));

  const trades: BacktestTrade[] = [], riskDenials: Record<string, number> = {}, featureErrors: Record<string, number> = {}, skipped: Record<string, number> = {};
  const open = new Map<string, BacktestTrade>(), cooldownUntil = new Map<string, number>();
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const settle = (until: number) => {
    for (const [token, t] of [...open].sort((a, b) => a[1].exit!.at - b[1].exit!.at)) {
      if (t.exit!.at > until) continue;
      open.delete(token);
      risk.onExit(token, t.exit!.at, t.netPnlUsd);
      cooldownUntil.set(token, t.exit!.at + cfg.strategy.cooldownMin * MIN);
    }
  };
  let signals = 0;
  for (const d of decisions) {
    settle(d.t);
    if (open.has(d.token)) { bump(skipped, 'IN_POSITION'); continue; }
    if ((cooldownUntil.get(d.token) ?? -Infinity) > d.t) { bump(skipped, 'COOLDOWN'); continue; }
    const view = index.at(d.t);
    const fv = computeFeatures(cfg.features, featureIds, view, d.token);
    for (const [id, err] of Object.entries(fv.errors)) bump(featureErrors, `${id}: ${err.slice(0, 80)}`);
    const verdict = evaluateEntry(cfg.strategy, fv.values);
    if (!verdict.signal) continue;
    signals++;
    const price = fv.values['price_usd@v1'] ?? null;
    if (price === null) { bump(skipped, 'NO_REFERENCE_PRICE'); continue; }
    const regime = cfg.regime ? cfg.regime(view) : null;
    const decision = risk.evaluateEntry({ at: d.t, token: d.token, sizeUsd: cfg.strategy.sizing.usd, liquidityUsd: fv.values['liquidity_usd@v1'] ?? null,
      dataAgeMs: fv.provenance.reads ? d.t - fv.provenance.maxKnownRead : null, healthy: cfg.healthy ? cfg.healthy(d.t) : true });
    if (decision.decision === 'DENY') { for (const r of decision.reasons) bump(riskDenials, r.split(' ')[0]!); continue; }
    const rng = seededRng(seedFrom(`${cfg.seed}:${d.token}:${d.t}`));
    const exec = simulateTrade({ token: d.token, decisionTime: d.t, referencePrice: price, sizeUsd: decision.sizeUsd, exit: cfg.strategy.exit,
      path: paths.get(d.token) ?? [], model: cfg.execution, rng });
    const features = Object.fromEntries(cfg.strategy.features.map(id => [id, fv.values[id] ?? null]));
    const trade: BacktestTrade = { ...exec, strategyId: cfg.strategy.id, features, regime, risk: { decision: decision.decision, reasons: decision.reasons } };
    trades.push(trade);
    if (exec.status === 'FILLED') { risk.onEntry(d.token, decision.sizeUsd); open.set(d.token, trade); }
    else if (exec.status === 'FAILED') risk.onExecutionFailure(d.t);
  }
  settle(Infinity);

  const identity: BacktestResult['identity'] = {
    strategy_id: cfg.strategy.id, strategy_fingerprint: cfg.strategy.fingerprint, feature_fingerprints: cfg.features.fingerprints(featureIds),
    execution_model: cfg.execution.id, execution_fingerprint: executionFingerprint(cfg.execution), risk_fingerprint: riskFingerprint(cfg.risk),
    dataset_version: cfg.datasetVersion, mode: cfg.mode, seed: cfg.seed, decision_every_ms: every, period: cfg.period ?? null,
    exclude_tokens: [...excluded].sort(), code_version: cfg.codeVersion,
  };
  return { run_id: contentId('run', identity), identity, assumptions, decisions: decisions.length, signals, trades, riskDenials, featureErrors, skipped,
    metrics: computeMetrics(trades, { seed: cfg.seed }) };
}

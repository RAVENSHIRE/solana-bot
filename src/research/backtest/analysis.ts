import { fingerprint } from '../core/canonical';
import { seedFrom, seededRng, shuffled } from '../core/random';
import { bootstrapDiffCi, mean, type Interval } from '../core/stats';
import type { ResearchEvent } from '../events/types';
import { simulateTrade } from '../execution/model';
import { strategyFingerprint, type StrategySpec, type StrategyVersion } from '../strategy/versioning';
import { computeMetrics, marketPath, runBacktest, type BacktestConfig, type BacktestResult, type BacktestTrade, type Metrics } from './engine';

/**
 * Research designs on top of runBacktest: baselines, walk-forward, ablation, sensitivity, adversarial stress, regime
 * and known-case splits. None of them registers strategy versions: variants are unregistered (`id~variant`) and exist
 * only inside the analysis that made them.
 */

const MIN = 60_000;

/** An unregistered variant of a strategy for analysis only (never traded, never in the registry). */
export function variant(base: StrategyVersion, suffix: string, patch: Partial<Pick<StrategySpec, 'entry' | 'exit' | 'sizing' | 'cooldownMin'>>): StrategyVersion {
  const spec: StrategySpec = { ...structuredClone(base), ...patch, id: `${base.id}~${suffix}`, parent: base.id };
  return { ...spec, version: base.version, features: [...new Set(spec.entry.map(r => r.feature))].sort(), fingerprint: strategyFingerprint(spec) };
}

/** Every moment a price became known for a token (the same decision moments the backtest uses), in known-at order. */
function priceDecisions(list: readonly ResearchEvent[], mode: BacktestConfig['mode']): Array<{ t: number; price: number }> {
  return list.filter(e => (e.event_type === 'Candle' || e.event_type === 'MarketSnapshot') && e.quality.status !== 'INVALID').flatMap(e => {
    const price = e.event_type === 'Candle' ? e.payload.c : e.payload.price_usd;
    return typeof price === 'number' && price > 0 ? [{ t: mode === 'OBSERVED' ? e.observed_at : e.available_at, price }] : [];
  }).sort((a, b) => a.t - b.t);
}

function tokensOf(events: readonly ResearchEvent[], exclude: readonly string[] | undefined): Map<string, ResearchEvent[]> {
  const byToken = new Map<string, ResearchEvent[]>(), skip = new Set(exclude ?? []);
  for (const e of events) if (e.token && !e.token.startsWith('REF:') && !skip.has(e.token)) { const l = byToken.get(e.token); if (l) l.push(e); else byToken.set(e.token, [e]); }
  return byToken;
}

const returns = (r: BacktestResult) => r.trades.filter(t => t.status === 'FILLED' && !t.flags.includes('INCOMPLETE_PATH')).map(t => t.netReturnPct);

// ------------------------------------------------------------------ baselines

export interface BaselineComparison {
  baseline: string; strategyMeanPct: number | null; baselineMeanPct: number | null;
  /** Bootstrap interval of strategy mean − baseline mean (percentage points). */
  differenceCi95: Interval | null;
  /** Share of baseline repetitions whose mean beat the strategy's (a permutation-style p-value); null for single baselines. */
  pValue: number | null;
  repetitions: number;
}

/**
 * Random-entry baseline: the same number of trades as the strategy, entered at random decision moments of the same
 * tokens and period, with the same exits, execution model and size. If the strategy's signals carry information, it
 * should beat this; if it does not, its result is what the market (and the exits) did, not the entry rule.
 */
export function randomEntryBaseline(events: readonly ResearchEvent[], cfg: BacktestConfig, result: BacktestResult, repetitions = 50): BaselineComparison {
  const strategy = returns(result), n = strategy.length;
  const candidates: Array<{ token: string; t: number; price: number }> = [];
  const paths = new Map<string, ReturnType<typeof marketPath>>();
  for (const [token, list] of tokensOf(events, cfg.excludeTokens)) {
    paths.set(token, marketPath(list));
    for (const d of priceDecisions(list, cfg.mode)) if (!cfg.period || (d.t >= cfg.period.from && d.t < cfg.period.to)) candidates.push({ token, ...d });
  }
  const means: number[] = [], pooled: number[] = [];
  if (n && candidates.length) for (let k = 0; k < repetitions; k++) {
    const rng = seededRng(seedFrom(`${cfg.seed}:random-baseline:${k}`));
    const picks = shuffled(candidates, rng).slice(0, n);
    const r = picks.map(c => simulateTrade({ token: c.token, decisionTime: c.t, referencePrice: c.price, sizeUsd: cfg.strategy.sizing.usd, exit: cfg.strategy.exit,
      path: paths.get(c.token)!, model: cfg.execution, rng: seededRng(seedFrom(`${cfg.seed}:${c.token}:${c.t}:rb`)) }))
      .filter(t => t.status === 'FILLED' && !t.flags.includes('INCOMPLETE_PATH')).map(t => t.netReturnPct);
    const m = mean(r); if (m !== null) { means.push(m); pooled.push(...r); }
  }
  const sm = mean(strategy);
  return { baseline: 'RANDOM_ENTRY', strategyMeanPct: sm, baselineMeanPct: mean(means), differenceCi95: bootstrapDiffCi(strategy, pooled, { seed: cfg.seed }),
    pValue: sm === null || !means.length ? null : means.filter(m => m >= sm).length / means.length, repetitions: means.length };
}

/** Fixed-delay baseline: every token entered once, `delayMin` after its first known price (the desk's "bought 10 min after graduation"). */
export function fixedDelayBaseline(events: readonly ResearchEvent[], cfg: BacktestConfig, result: BacktestResult, delayMin = 10): BaselineComparison {
  const r: number[] = [];
  for (const [token, list] of tokensOf(events, cfg.excludeTokens)) {
    const known = priceDecisions(list, cfg.mode), first = known[0];
    if (!first) continue;
    const at = known.find(d => d.t >= first.t + delayMin * MIN);
    if (!at || (cfg.period && (at.t < cfg.period.from || at.t >= cfg.period.to))) continue;
    const t = simulateTrade({ token, decisionTime: at.t, referencePrice: at.price, sizeUsd: cfg.strategy.sizing.usd, exit: cfg.strategy.exit, path: marketPath(list),
      model: cfg.execution, rng: seededRng(seedFrom(`${cfg.seed}:${token}:fixed`)) });
    if (t.status === 'FILLED' && !t.flags.includes('INCOMPLETE_PATH')) r.push(t.netReturnPct);
  }
  const s = returns(result);
  return { baseline: `FIXED_DELAY_${delayMin}MIN`, strategyMeanPct: mean(s), baselineMeanPct: mean(r), differenceCi95: bootstrapDiffCi(s, r, { seed: cfg.seed }), pValue: null, repetitions: 1 };
}

// ------------------------------------------------------------------ walk-forward

export interface WalkForwardFold {
  train: { from: number; to: number }; test: { from: number; to: number };
  chosen: string; chosenTrainMeanPct: number | null; trainTrades: number; testMetrics: Metrics;
}
export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** Out-of-sample trades of every fold, concatenated: the walk-forward result. */
  outOfSample: Metrics;
  /** Configurations compared per fold × folds: the multiple-testing burden behind the choice. */
  trials: number;
  fingerprint: string;
}

/**
 * Rolling (or anchored) walk-forward: in each fold every candidate is run on the training window, the best by mean net
 * return (with at least `minTrainTrades`) is chosen, and only that one is run on the following test window.
 */
export function walkForward(events: readonly ResearchEvent[], base: Omit<BacktestConfig, 'strategy' | 'period'>, candidates: readonly StrategyVersion[],
  o: { from: number; to: number; trainMs: number; testMs: number; stepMs?: number; anchored?: boolean; minTrainTrades?: number }): WalkForwardResult {
  if (!candidates.length) throw new Error('walkForward: no candidates');
  const folds: WalkForwardFold[] = [], oos: BacktestTrade[] = [], step = o.stepMs ?? o.testMs;
  for (let start = o.from; start + o.trainMs + o.testMs <= o.to; start += step) {
    const train = { from: o.anchored ? o.from : start, to: start + o.trainMs }, test = { from: train.to, to: train.to + o.testMs };
    let best: { s: StrategyVersion; m: number | null; n: number } | null = null;
    for (const s of candidates) {
      const r = runBacktest(events, { ...base, strategy: s, period: train }), m = r.metrics.meanReturnPct, n = r.metrics.filled - r.metrics.incomplete;
      if (n < (o.minTrainTrades ?? 5) || m === null) continue;
      if (!best || best.m === null || m > best.m) best = { s, m, n };
    }
    if (!best) { folds.push({ train, test, chosen: 'NONE (no candidate met the minimum trades)', chosenTrainMeanPct: null, trainTrades: 0, testMetrics: computeMetrics([]) }); continue; }
    const r = runBacktest(events, { ...base, strategy: best.s, period: test });
    oos.push(...r.trades);
    folds.push({ train, test, chosen: best.s.id, chosenTrainMeanPct: best.m, trainTrades: best.n, testMetrics: r.metrics });
  }
  return { folds, outOfSample: computeMetrics(oos, { seed: base.seed }), trials: candidates.length * folds.length,
    fingerprint: fingerprint({ candidates: candidates.map(c => c.fingerprint), o: { ...o, stepMs: step } }) };
}

// ------------------------------------------------------------------ ablation, sensitivity, adversarial

export interface VariantResult { variant: string; change: string; metrics: Metrics; deltaMeanPct: number | null }
const delta = (a: Metrics, b: Metrics) => (a.meanReturnPct === null || b.meanReturnPct === null ? null : a.meanReturnPct - b.meanReturnPct);

/** Drops each entry rule in turn: which conditions carry the result, and which are decoration. */
export function ablation(events: readonly ResearchEvent[], cfg: BacktestConfig, baseline?: BacktestResult): VariantResult[] {
  const ref = baseline ?? runBacktest(events, cfg);
  return cfg.strategy.entry.map((rule, i) => {
    const v = variant(cfg.strategy, `minus_${rule.feature.replace(/@.*/, '')}`, { entry: cfg.strategy.entry.filter((_, j) => j !== i) });
    const m = runBacktest(events, { ...cfg, strategy: v }).metrics;
    return { variant: v.id, change: `without ${rule.label ?? rule.feature}`, metrics: m, deltaMeanPct: delta(m, ref.metrics) };
  });
}

/**
 * Moves every numeric threshold and exit parameter by the given factors. A result that flips sign under ±10 % is a
 * cliff: the rule was fitted to the sample, not to a property of the market.
 */
export function sensitivity(events: readonly ResearchEvent[], cfg: BacktestConfig, factors: readonly number[] = [0.8, 0.9, 1.1, 1.2], baseline?: BacktestResult): { variants: VariantResult[]; cliffs: string[] } {
  const ref = baseline ?? runBacktest(events, cfg), s = cfg.strategy, out: VariantResult[] = [];
  const scale = (v: number, f: number) => Math.round(v * f * 1e6) / 1e6;
  for (const [i, rule] of s.entry.entries()) for (const f of factors) {
    const value = Array.isArray(rule.value) ? [scale(rule.value[0]!, f), scale(rule.value[1]!, f)] as const : scale(rule.value as number, f);
    const v = variant(s, `${rule.feature.replace(/@.*/, '')}x${f}`, { entry: s.entry.map((r, j) => (j === i ? { ...r, value } : r)) });
    const m = runBacktest(events, { ...cfg, strategy: v }).metrics;
    out.push({ variant: v.id, change: `${rule.label ?? rule.feature} × ${f}`, metrics: m, deltaMeanPct: delta(m, ref.metrics) });
  }
  for (const key of ['stopLossPct', 'takeProfitPct', 'maxHoldMin'] as const) for (const f of factors) {
    const cur = s.exit[key];
    if (cur === null) continue;
    const v = variant(s, `${key}x${f}`, { exit: { ...s.exit, [key]: scale(cur, f) } });
    const m = runBacktest(events, { ...cfg, strategy: v }).metrics;
    out.push({ variant: v.id, change: `${key} × ${f}`, metrics: m, deltaMeanPct: delta(m, ref.metrics) });
  }
  const sign = (x: number | null) => (x === null ? 0 : Math.sign(x));
  const cliffs = out.filter(v => /x(0\.9|1\.1)$/.test(v.variant) && sign(v.metrics.meanReturnPct) !== 0 && sign(ref.metrics.meanReturnPct) !== 0 &&
    sign(v.metrics.meanReturnPct) !== sign(ref.metrics.meanReturnPct)).map(v => v.change);
  return { variants: out, cliffs };
}

/** Harsher but plausible worlds: if the edge disappears under any of them, it was not robust enough to trade. */
export function adversarial(events: readonly ResearchEvent[], cfg: BacktestConfig, baseline?: BacktestResult): VariantResult[] {
  const ref = baseline ?? runBacktest(events, cfg), m = cfg.execution;
  const worlds: Array<[string, BacktestConfig]> = [
    ['costs ×2 (venue and network fees)', { ...cfg, execution: { ...m, id: `${m.id}~costs2`, venueFeeBps: m.venueFeeBps * 2, networkFeeUsd: m.networkFeeUsd * 2 } }],
    ['latency ×3', { ...cfg, execution: { ...m, id: `${m.id}~lat3`, entryLatencyMs: m.entryLatencyMs * 3, exitLatencyMs: m.exitLatencyMs * 3 } }],
    ['stop slippage +5 pts', { ...cfg, execution: { ...m, id: `${m.id}~stopslip`, stopSlipPct: m.stopSlipPct + 5 } }],
    ['20 % of transactions fail', { ...cfg, execution: { ...m, id: `${m.id}~fail20`, txFailureRate: Math.max(m.txFailureRate, 0.2) } }],
    ['entry one minute late', { ...cfg, execution: { ...m, id: `${m.id}~late60`, entryLatencyMs: m.entryLatencyMs + MIN } }],
    ['size ×10', { ...cfg, strategy: variant(cfg.strategy, 'size10', { sizing: { usd: cfg.strategy.sizing.usd * 10 } }), risk: { ...cfg.risk, maxPositionUsd: Math.max(cfg.risk.maxPositionUsd, cfg.strategy.sizing.usd * 10), maxExposureUsd: Math.max(cfg.risk.maxExposureUsd, cfg.strategy.sizing.usd * 30) } }],
  ];
  const out = worlds.map(([change, c]) => { const r = runBacktest(events, c).metrics; return { variant: change, change, metrics: r, deltaMeanPct: delta(r, ref.metrics) }; });
  // Outlier dependence: the same trades without the three best.
  const kept = [...ref.trades].filter(t => t.status === 'FILLED').sort((a, b) => b.netPnlUsd - a.netPnlUsd).slice(3);
  const without = computeMetrics(kept, { seed: cfg.seed });
  out.push({ variant: 'without the 3 best trades', change: 'without the 3 best trades', metrics: without, deltaMeanPct: delta(without, ref.metrics) });
  return out;
}

// ------------------------------------------------------------------ splits

/** Metrics per regime label at decision time. */
export function byRegime(trades: readonly BacktestTrade[], seed = 1): Record<string, Metrics> {
  const groups = new Map<string, BacktestTrade[]>();
  for (const t of trades) { const k = t.regime ?? 'UNKNOWN'; const l = groups.get(k); if (l) l.push(t); else groups.set(k, [t]); }
  return Object.fromEntries([...groups].map(([k, v]) => [k, computeMetrics(v, { seed })]));
}

/** The result with and without trades in the known cases (anecdotes that inspired rules must not carry them). */
export function knownCaseDependence(trades: readonly BacktestTrade[], caseTokens: readonly string[], seed = 1): { all: Metrics; withoutCases: Metrics; caseTrades: number } {
  const set = new Set(caseTokens), without = trades.filter(t => !set.has(t.token));
  return { all: computeMetrics(trades, { seed }), withoutCases: computeMetrics(without, { seed }), caseTrades: trades.length - without.length };
}

/** Time split by decision time into consecutive periods with the given weights (e.g. [0.6, 0.2, 0.2]). */
export function timeSplit(from: number, to: number, weights: readonly number[]): Array<{ from: number; to: number }> {
  const total = weights.reduce((a, w) => a + w, 0), out: Array<{ from: number; to: number }> = [];
  let start = from;
  for (const w of weights) { const end = Math.round(start + (to - from) * w / total); out.push({ from: start, to: end }); start = end; }
  out[out.length - 1]!.to = to;
  return out;
}

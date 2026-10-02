import { fingerprint } from '../core/canonical';
import type { Rng } from '../core/random';
import type { ExitSpec } from '../strategy/versioning';

/**
 * Execution realism. A signal is a THEORETICAL trade: a price on a chart at the decision time. What can actually be
 * traded is different: the order lands later (latency), moves the pool (impact, constant product on the liquidity
 * observed at the fill), pays fees, can revert (slippage tolerance, failed transactions), and an exit can be impossible
 * (no liquidity, no route) and end as a write-off. Both are reported side by side so the gap is visible.
 *
 * Deterministic given the path and the seeded rng.
 */

export interface ExecutionModelSpec {
  id: string;
  /** From decision to the order landing, and from an exit trigger to its fill. */
  entryLatencyMs: number;
  exitLatencyMs: number;
  /** Pool fee per side (PumpSwap LP + protocol + creator ≈ 30 bps). */
  venueFeeBps: number;
  /** Per transaction: base + priority fee, in USD. */
  networkFeeUsd: number;
  /** Token-account rent paid at entry, in USD; returned at exit when `rentRecovered`. */
  rentUsd: number;
  rentRecovered: boolean;
  /** An entry whose price moved more than this between decision and fill (impact included) reverts. */
  entrySlippageTolerancePct: number;
  /** Probability that one submitted transaction fails (fees still paid). */
  txFailureRate: number;
  /** Extra loss on stop-type exits: they sell into a falling pool after the level was crossed. */
  stopSlipPct: number;
  /** A stop crossed within a bar that closed below the level fills at the close, not the level (rugs gap). */
  gapFill: boolean;
  /** No entry below this liquidity; an exit below it waits for liquidity (or a write-off). */
  minLiquidityUsd: number;
  /** Price impact above this refuses the entry (the desk's MAX_PRICE_IMPACT_PCT / drag cap). */
  maxEntryImpactPct: number;
  /** How long to wait for the first observation after the order would land. */
  maxFillWaitMs: number;
  /** Exit attempts (each pays a fee) before the position is written off. */
  maxExitAttempts: number;
  /** Liquidity unknown at the fill: REJECT (default, no fill) or ASSUME (no impact, flagged). */
  unknownLiquidity: 'REJECT' | 'ASSUME';
  /** Constant-product price impact on entry and exit. */
  priceImpact: boolean;
}

/** Desk-like defaults for $2 CRASH trades (docs/DESK.md costs, 2 Oct). */
export const DESK_LIKE: ExecutionModelSpec = {
  id: 'desk_like_v1', entryLatencyMs: 2_000, exitLatencyMs: 2_000, venueFeeBps: 30, networkFeeUsd: 0.01, rentUsd: 0.4, rentRecovered: true,
  entrySlippageTolerancePct: 2.5, txFailureRate: 0.05, stopSlipPct: 3, gapFill: true, minLiquidityUsd: 5_000, maxEntryImpactPct: 5,
  maxFillWaitMs: 90_000, maxExitAttempts: 5, unknownLiquidity: 'REJECT', priceImpact: true,
};
/** No latency, no costs, no failures: the theoretical chart trade, for comparison only. */
export const FRICTIONLESS: ExecutionModelSpec = {
  id: 'frictionless_v1', entryLatencyMs: 0, exitLatencyMs: 0, venueFeeBps: 0, networkFeeUsd: 0, rentUsd: 0, rentRecovered: true,
  entrySlippageTolerancePct: Infinity, txFailureRate: 0, stopSlipPct: 0, gapFill: false, minLiquidityUsd: 0, maxEntryImpactPct: Infinity,
  maxFillWaitMs: Infinity, maxExitAttempts: 1, unknownLiquidity: 'ASSUME', priceImpact: false,
};

export const executionFingerprint = (m: ExecutionModelSpec): string =>
  fingerprint(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' && !Number.isFinite(v) ? String(v) : v])));

/**
 * One observation of the market after the decision: a snapshot (low = high = price) or a bar (`ts` = its close,
 * `start` and `open` set). An order landing inside a bar fills at the bar's open, the closest known price to the moment
 * just after the decision, and the whole bar's range counts for its exits.
 */
export interface PathPoint { ts: number; price: number; low: number; high: number; liquidityUsd: number | null; start?: number; open?: number }

export type FillFailure = 'NO_MARKET_DATA' | 'LIQUIDITY_UNKNOWN' | 'LIQUIDITY_TOO_LOW' | 'IMPACT_LIMIT' | 'SLIPPAGE_EXCEEDED' | 'TX_FAILED';
export type ExitReason = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'MAX_HOLD' | 'END_OF_DATA' | 'WRITE_OFF';

export interface ExecutableTrade {
  token: string;
  decisionTime: number;
  sizeUsd: number;
  theoretical: { entryPrice: number; exitPrice: number | null; exitAt: number | null; reason: ExitReason | null; returnPct: number | null };
  status: 'FILLED' | 'NOT_FILLED' | 'FAILED';
  failure: FillFailure | null;
  entry: { at: number; referencePrice: number; fillPrice: number; adverseMovePct: number; impactPct: number; liquidityUsd: number | null } | null;
  exit: { at: number; reason: ExitReason; fillPrice: number; impactPct: number; attempts: number; liquidityUsd: number | null } | null;
  peakPct: number;
  costsUsd: number;
  netPnlUsd: number;
  /** Net PnL ÷ size × 100; for a failed entry, the fees lost. */
  netReturnPct: number;
  flags: string[];
}

const liquidityAt = (path: readonly PathPoint[], ts: number): number | null => {
  for (let i = path.length - 1; i >= 0; i--) if (path[i]!.ts <= ts && path[i]!.liquidityUsd !== null) return path[i]!.liquidityUsd;
  return null;
};

interface Trigger { at: number; index: number; reference: number; theoretical: number; reason: ExitReason; stopType: boolean }

/** Walks the path from the fill: stops on the bar's low before the take profit on its high (pessimistic order). */
function findExit(path: readonly PathPoint[], start: number, entryPrice: number, fillAt: number, x: ExitSpec, gapFill: boolean): { trigger: Trigger | null; peakPct: number } {
  let peak = entryPrice;
  const stop = entryPrice * (1 - x.stopLossPct / 100), tp = x.takeProfitPct === null ? Infinity : entryPrice * (1 + x.takeProfitPct / 100);
  const deadline = fillAt + x.maxHoldMin * 60_000;
  for (let i = start; i < path.length; i++) {
    const p = path[i]!;
    const stopFill = (level: number) => (gapFill && p.price < level ? p.price : level);
    if (p.low <= stop) return { trigger: { at: p.ts, index: i, reference: stopFill(stop), theoretical: stop, reason: 'STOP_LOSS', stopType: true }, peakPct: (peak / entryPrice - 1) * 100 };
    if (x.trailing && (peak / entryPrice - 1) * 100 >= x.trailing.activationPct) {
      const trail = peak * (1 - x.trailing.stopPct / 100);
      if (p.low <= trail) return { trigger: { at: p.ts, index: i, reference: stopFill(trail), theoretical: trail, reason: 'TRAILING_STOP', stopType: true }, peakPct: (peak / entryPrice - 1) * 100 };
    }
    if (p.high >= tp) return { trigger: { at: p.ts, index: i, reference: tp, theoretical: tp, reason: 'TAKE_PROFIT', stopType: false }, peakPct: (Math.max(peak, p.high) / entryPrice - 1) * 100 };
    peak = Math.max(peak, p.high);
    if (p.ts >= deadline) return { trigger: { at: p.ts, index: i, reference: p.price, theoretical: p.price, reason: 'MAX_HOLD', stopType: false }, peakPct: (peak / entryPrice - 1) * 100 };
  }
  return { trigger: null, peakPct: (peak / entryPrice - 1) * 100 };
}

/**
 * Simulates one trade. `path` holds the market after the decision (sorted by ts, may start before the fill);
 * `referencePrice` is the price the signal saw at the decision time.
 */
export function simulateTrade(o: { token: string; decisionTime: number; referencePrice: number; sizeUsd: number; exit: ExitSpec;
  path: readonly PathPoint[]; model: ExecutionModelSpec; rng: Rng }): ExecutableTrade {
  const { model: m, path, sizeUsd, referencePrice: ref } = o, flags: string[] = [];
  const theoreticalStart = path.findIndex(p => p.ts > o.decisionTime);
  const th = theoreticalStart < 0 ? { trigger: null, peakPct: 0 } : findExit(path, theoreticalStart, ref, o.decisionTime, o.exit, false);
  const theoretical = { entryPrice: ref, exitPrice: th.trigger?.theoretical ?? null, exitAt: th.trigger?.at ?? null, reason: th.trigger?.reason ?? null,
    returnPct: th.trigger ? (th.trigger.theoretical / ref - 1) * 100 : null };
  const base = { token: o.token, decisionTime: o.decisionTime, sizeUsd, theoretical, entry: null, exit: null, peakPct: 0, flags };
  const notFilled = (failure: FillFailure, feesUsd = 0): ExecutableTrade =>
    ({ ...base, status: feesUsd > 0 ? 'FAILED' : 'NOT_FILLED', failure, costsUsd: feesUsd, netPnlUsd: -feesUsd, netReturnPct: -feesUsd / sizeUsd * 100 });

  // ---------------------------------------------------------------- entry
  const landAt = o.decisionTime + m.entryLatencyMs;
  const fillIndex = path.findIndex(p => p.ts >= landAt);
  if (fillIndex < 0 || path[fillIndex]!.ts - landAt > m.maxFillWaitMs) return notFilled('NO_MARKET_DATA');
  const fillPoint = path[fillIndex]!;
  const insideBar = fillPoint.start !== undefined && fillPoint.open !== undefined && fillPoint.start <= landAt;
  const fillReference = insideBar ? fillPoint.open! : fillPoint.price;
  let liquidity = fillPoint.liquidityUsd ?? liquidityAt(path, fillPoint.ts);
  if (liquidity === null) {
    if (m.unknownLiquidity === 'REJECT') return notFilled('LIQUIDITY_UNKNOWN');
    flags.push('LIQUIDITY_ASSUMED_INFINITE'); liquidity = Infinity;
  }
  if (liquidity < m.minLiquidityUsd) return notFilled('LIQUIDITY_TOO_LOW');
  // Constant product: buying S against a quote reserve R ≈ liquidity / 2 pays an average price × (1 + S / R).
  const reserve = m.priceImpact ? liquidity / 2 : Infinity, impactPct = Number.isFinite(reserve) ? sizeUsd / reserve * 100 : 0;
  if (impactPct > m.maxEntryImpactPct) return notFilled('IMPACT_LIMIT');
  const fillPrice = fillReference * (1 + impactPct / 100), adverse = (fillPrice / ref - 1) * 100;
  if (adverse > m.entrySlippageTolerancePct) return notFilled('SLIPPAGE_EXCEEDED', m.networkFeeUsd);
  if (o.rng() < m.txFailureRate) return notFilled('TX_FAILED', m.networkFeeUsd);
  // Explicit costs only: the venue fee is already in the token amount (entry) and the proceeds (exit).
  let costs = m.networkFeeUsd + m.rentUsd;
  const tokens = sizeUsd * (1 - m.venueFeeBps / 10_000) / fillPrice;
  const fillAt = insideBar ? landAt : fillPoint.ts;

  // ---------------------------------------------------------------- exit
  const ex = findExit(path, insideBar ? fillIndex : fillIndex + 1, fillPrice, fillAt, o.exit, m.gapFill);
  let trigger = ex.trigger, attempts = 0, proceeds = 0, exitAt = fillAt, exitPrice = fillPrice, exitImpact = 0, exitLiquidity: number | null = null;
  let reason: ExitReason;
  if (!trigger) {
    // No exit before the data ends: marked at the last observation, not a realised trade.
    const last = path.at(-1)!;
    reason = 'END_OF_DATA'; flags.push('INCOMPLETE_PATH');
    trigger = { at: last.ts, index: path.length - 1, reference: last.price, theoretical: last.price, reason, stopType: false };
  } else reason = trigger.reason;
  let index = trigger.index, reference = trigger.reference;
  // Exit latency: when the next observation falls inside the latency window, the fill uses it (worse for stops).
  if (m.exitLatencyMs > 0) {
    const next = path.findIndex((p, i) => i > index && p.ts >= trigger!.at + m.exitLatencyMs);
    if (next >= 0 && path[next]!.ts - trigger.at <= m.exitLatencyMs + 5_000) {
      index = next; reference = trigger.stopType ? Math.min(reference, path[next]!.price) : path[next]!.price;
    }
  }
  for (;;) {
    attempts++; costs += m.networkFeeUsd;
    const point = path[index]!, liq = point.liquidityUsd ?? liquidityAt(path, point.ts);
    const sold = reason !== 'END_OF_DATA' && (liq === null || liq < m.minLiquidityUsd) ? null : liq;
    const failed = sold !== null && o.rng() < m.txFailureRate;
    if (sold !== null && !failed || reason === 'END_OF_DATA') {
      const value = tokens * reference * (trigger.stopType ? 1 - m.stopSlipPct / 100 : 1);
      const r = m.priceImpact && sold !== null && Number.isFinite(sold) ? sold / 2 : Infinity;
      proceeds = (Number.isFinite(r) ? value * r / (r + value) : value) * (1 - m.venueFeeBps / 10_000);
      exitImpact = Number.isFinite(r) ? value / (r + value) * 100 : 0;
      exitAt = point.ts; exitPrice = proceeds / tokens; exitLiquidity = sold;
      break;
    }
    if (attempts >= m.maxExitAttempts || index + 1 >= path.length) {
      reason = 'WRITE_OFF'; flags.push(sold === null ? 'EXIT_NO_LIQUIDITY' : 'EXIT_TX_FAILED');
      proceeds = 0; exitAt = point.ts; exitPrice = 0; exitLiquidity = liq;
      break;
    }
    index++; reference = trigger.stopType ? Math.min(reference, path[index]!.price) : path[index]!.price;
    if (failed) flags.push('EXIT_RETRIED');
  }
  if (m.rentRecovered) costs -= m.rentUsd;
  const netPnl = proceeds - sizeUsd - costs;
  return {
    ...base, status: 'FILLED', failure: null,
    entry: { at: fillAt, referencePrice: ref, fillPrice, adverseMovePct: adverse, impactPct, liquidityUsd: Number.isFinite(liquidity) ? liquidity : null },
    exit: { at: exitAt, reason, fillPrice: exitPrice, impactPct: exitImpact, attempts, liquidityUsd: exitLiquidity },
    peakPct: ex.peakPct, costsUsd: costs, netPnlUsd: netPnl, netReturnPct: netPnl / sizeUsd * 100,
  };
}

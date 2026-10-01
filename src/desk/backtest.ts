import type { ExitRules } from './config';
import { replayExit, sizedReturn, type Candle } from './replay';

/**
 * Candle backtest of the CRASH strategy over complete pools: every minute of a young pool is checked against the
 * entry rule, entries are replayed under the exit rules (pessimistic intra-minute order), and every trade pays the
 * sized price impact, venue fees and fixed network costs. Pure functions; data collection lives in the script.
 */

export interface VCandle extends Candle { v: number }
export interface PoolSeries {
  mint: string; symbol: string | null; pool: string; createdAt: number;
  /** Token supply (market cap / price). */
  supply: number;
  /** One liquidity observation (USD, both sides) at priceRef; constant product gives the depth at any other price. */
  liquidityRefUsd: number; priceRef: number;
  candles: VCandle[];
}
export interface EntryRule {
  maxPoolAgeMin: number; minChange5mPct: number; maxChange5mPct: number; minVolume5mUsd: number;
  minLiquidityUsd: number; minLiquidityToMarketCap: number; maxMarketCapUsd: number;
  /** 0 = buy at the signal. Otherwise wait up to pullbackWindowMin for the price to fall this far below its high since the signal. */
  pullbackPct: number; pullbackWindowMin: number;
}
export interface Costs {
  sizeUsd: number;
  /** Venue fee per side (PumpSwap LP + protocol + creator ≈ 0.3%). */
  venueFeePct: number;
  /** Network fees and unrecovered account rent per round trip. */
  fixedUsd: number;
  /** Extra loss on stop-type exits: they fire after the level is crossed and sell into a falling pool. */
  stopSlipPct: number;
}
export interface Signal { at: number; price: number; change5mPct: number; volume5mUsd: number; marketCapUsd: number; liquidityUsd: number }
export interface SimTrade { mint: string; symbol: string | null; entryAt: number; entryPrice: number; exitAt: number; exitPrice: number; reason: string; peakPct: number; returnPct: number; pnlUsd: number }
export interface Summary { trades: number; winRatePct: number; meanPct: number; medianPct: number; totalUsd: number; profitFactor: number; worstPct: number; bestPct: number }

const MINUTE = 60_000;
const STOPS = new Set(['STOP_LOSS', 'PROFIT_LOCK', 'TRAILING_STOP']);

export const liquidityAt = (s: PoolSeries, price: number) => s.liquidityRefUsd * Math.sqrt(price / s.priceRef);

/** Every minute close at which the entry rule holds (price change and volume over the trailing five minutes). */
export function signals(s: PoolSeries, e: EntryRule): Signal[] {
  const out: Signal[] = [], c = s.candles;
  for (let i = 0; i < c.length; i++) {
    const k = c[i]!, closeAt = k.t + MINUTE;
    if ((closeAt - s.createdAt) / MINUTE > e.maxPoolAgeMin) break;
    let ref = c[0]!.o, volume = 0;
    for (let j = i; j >= 0; j--) {
      if (c[j]!.t <= k.t - 5 * MINUTE) { ref = c[j]!.c; break; }
      volume += c[j]!.v;
    }
    const change = (k.c / ref - 1) * 100, mcap = k.c * s.supply, liq = liquidityAt(s, k.c);
    if (change < e.minChange5mPct || change > e.maxChange5mPct || volume < e.minVolume5mUsd || liq < e.minLiquidityUsd
      || liq < mcap * e.minLiquidityToMarketCap || mcap > e.maxMarketCapUsd) continue;
    out.push({ at: closeAt, price: k.c, change5mPct: change, volume5mUsd: volume, marketCapUsd: mcap, liquidityUsd: liq });
  }
  return out;
}

/** Entry after a signal: at the signal, or at the first pullback of `pullbackPct` from the high since the signal. */
function entryAfter(s: PoolSeries, sig: Signal, e: EntryRule): { at: number; price: number } | null {
  if (e.pullbackPct <= 0) return { at: sig.at, price: sig.price };
  let high = sig.price;
  for (const k of s.candles) {
    if (k.t < sig.at) continue;
    if (k.t >= sig.at + e.pullbackWindowMin * MINUTE) return null;
    const limit = high * (1 - e.pullbackPct / 100);
    if (k.l <= limit) return { at: k.t + MINUTE, price: Math.min(limit, k.o) };
    high = Math.max(high, k.h);
  }
  return null;
}

/** All trades in one pool: one position at a time, re-entry only after `cooldownMin` past the previous exit. */
export function simulatePool(s: PoolSeries, e: EntryRule, exit: ExitRules, costs: Costs, cooldownMin: number, horizonMs = exit.maxHoldMin * MINUTE + MINUTE,
  precomputed?: Signal[]): SimTrade[] {
  const trades: SimTrade[] = [];
  let free = 0;
  for (const sig of precomputed ?? signals(s, e)) {
    if (sig.at < free) continue;
    const entry = entryAfter(s, sig, e);
    if (!entry || entry.at < free) continue;
    const x = replayExit(s.candles, entry.at, entry.price, exit, horizonMs);
    if (x.reason === 'END_OF_DATA' && x.exitAt <= entry.at) continue;
    const exitPrice = STOPS.has(x.reason) ? x.exitPrice * (1 - costs.stopSlipPct / 100) : x.exitPrice;
    const gross = sizedReturn(costs.sizeUsd, entry.price, exitPrice, s.liquidityRefUsd / 2, s.priceRef);
    const net = (1 + gross) * (1 - costs.venueFeePct / 100) ** 2 - 1 - costs.fixedUsd / costs.sizeUsd;
    trades.push({ mint: s.mint, symbol: s.symbol, entryAt: entry.at, entryPrice: entry.price, exitAt: x.exitAt, exitPrice, reason: x.reason,
      peakPct: x.peakPct, returnPct: net * 100, pnlUsd: net * costs.sizeUsd });
    free = x.exitAt + cooldownMin * MINUTE;
  }
  return trades;
}

export function summarize(trades: SimTrade[]): Summary {
  const r = trades.map(t => t.returnPct).sort((a, b) => a - b), n = r.length;
  const wins = r.filter(x => x > 0), gain = wins.reduce((a, x) => a + x, 0), loss = -r.filter(x => x <= 0).reduce((a, x) => a + x, 0);
  return { trades: n, winRatePct: n ? wins.length / n * 100 : 0, meanPct: n ? r.reduce((a, x) => a + x, 0) / n : 0,
    medianPct: n ? (n % 2 ? r[(n - 1) / 2]! : (r[n / 2 - 1]! + r[n / 2]!) / 2) : 0, totalUsd: trades.reduce((a, t) => a + t.pnlUsd, 0),
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : 0, worstPct: n ? r[0]! : 0, bestPct: n ? r[n - 1]! : 0 };
}

// ------------------------------------------------------------------ GOLDEN POCKET

/** GOLDEN POCKET exits: the pattern's own stop, then a trailing stop and/or a take profit just under the resistance the pattern ran to. */
export interface PocketExit {
  /** TRAIL rides the move; RESISTANCE sells everything just under the resistance; SPLIT sells half there and trails the rest. */
  mode: 'TRAIL' | 'RESISTANCE' | 'SPLIT';
  trailing: { activationPct: number; stopPct: number } | null;
  /** Take profit this far below the resistance (the owner: 5–10 %). */
  belowResistancePct: number;
  maxHoldMin: number;
}
export interface PocketFill { at: number; price: number; stop: number; resistance: number }

/** Market-cap candles: every price × supply, so pattern levels read as market caps. */
export const capSeries = (s: PoolSeries): PoolSeries => ({ ...s, candles: s.candles.map(k => ({ ...k, o: k.o * s.supply, h: k.h * s.supply, l: k.l * s.supply, c: k.c * s.supply })),
  priceRef: s.priceRef * s.supply, supply: 1 });

/**
 * One GOLDEN POCKET trade on market-cap candles: filled inside a candle, so that candle's low is checked against the
 * stop first (pessimistic), then each leg is replayed under its exit rules and pays the sized impact, fees and costs.
 */
export function pocketTrade(s: PoolSeries, fill: PocketFill, x: PocketExit, costs: Costs): SimTrade {
  const bar = s.candles.find(k => k.t === fill.at);
  const stopLossPct = (1 - fill.stop / fill.price) * 100;
  const net = (exitPrice: number, size: number) => {
    const gross = sizedReturn(size, fill.price, exitPrice, s.liquidityRefUsd / 2, s.priceRef);
    return (1 + gross) * (1 - costs.venueFeePct / 100) ** 2 - 1;
  };
  const trade = (exitAt: number, exitPrice: number, reason: string, peakPct: number, pnlUsd: number): SimTrade => ({ mint: s.mint, symbol: s.symbol, entryAt: fill.at,
    entryPrice: fill.price, exitAt, exitPrice, reason, peakPct, returnPct: pnlUsd / costs.sizeUsd * 100, pnlUsd });
  if (bar && bar.l <= fill.stop) {
    const exitPrice = fill.stop * (1 - costs.stopSlipPct / 100);
    return trade(fill.at, exitPrice, 'STOP_LOSS', 0, net(exitPrice, costs.sizeUsd) * costs.sizeUsd - costs.fixedUsd);
  }
  const tpPct = Math.max(3, (fill.resistance * (1 - x.belowResistancePct / 100) / fill.price - 1) * 100);
  const legs: Array<{ weight: number; rules: ExitRules }> = [];
  const base = { stopLossPct, maxHoldMin: x.maxHoldMin, giveback: null };
  if (x.mode !== 'TRAIL') legs.push({ weight: x.mode === 'SPLIT' ? 0.5 : 1, rules: { ...base, takeProfitPct: tpPct, trailing: null } });
  if (x.mode !== 'RESISTANCE') legs.push({ weight: x.mode === 'SPLIT' ? 0.5 : 1, rules: { ...base, takeProfitPct: Infinity, trailing: x.trailing } });
  let pnlUsd = -costs.fixedUsd, exitAt = fill.at, peakPct = 0, value = 0;
  const reasons: string[] = [];
  for (const leg of legs) {
    const r = replayExit(s.candles, fill.at, fill.price, leg.rules, x.maxHoldMin * MINUTE + MINUTE);
    const exitPrice = STOPS.has(r.reason) ? r.exitPrice * (1 - costs.stopSlipPct / 100) : r.exitPrice;
    pnlUsd += net(exitPrice, costs.sizeUsd * leg.weight) * costs.sizeUsd * leg.weight;
    exitAt = Math.max(exitAt, r.exitAt); peakPct = Math.max(peakPct, r.peakPct); value += exitPrice * leg.weight; reasons.push(r.reason);
  }
  return trade(exitAt, value, [...new Set(reasons)].join('+'), peakPct, pnlUsd);
}

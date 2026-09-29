import type { ExitRules } from './config';

/** One-minute OHLC candle (t = candle start, ms). */
export interface Candle { t: number; o: number; h: number; l: number; c: number }
export interface ReplayExit { exitAt: number; exitPrice: number; reason: string; peakPct: number }

const MINUTE = 60_000;

/**
 * Replays exit rules over minute candles after an entry. Within a candle the order of high and low is unknown, so
 * the replay is pessimistic: losses (stop loss, profit lock) are checked against the low before the candle's high
 * can raise the peak or reach the take profit. Returns percentages on price, before fees and impact.
 */
export function replayExit(candles: Candle[], entryAt: number, entryPrice: number, r: ExitRules, horizonMs: number): ReplayExit {
  const series = candles.filter(c => c.t + MINUTE > entryAt && c.t < entryAt + horizonMs).sort((a, b) => a.t - b.t);
  const pct = (p: number) => (p / entryPrice - 1) * 100, at = (p: number) => entryPrice * (1 + p / 100);
  let peak = 0;
  for (const c of series) {
    const stopAt = entryAt + r.maxHoldMin * MINUTE;
    // The entry candle's range before the entry is unknown; only its close is used.
    const first = c.t <= entryAt, low = first ? c.c : c.l, high = first ? c.c : c.h, open = first ? c.c : c.o;
    const sl = at(-r.stopLossPct);
    if (low <= sl) return { exitAt: Math.max(c.t, entryAt), exitPrice: Math.min(sl, open), reason: 'STOP_LOSS', peakPct: peak };
    if (r.giveback && peak >= r.giveback.lockPeakPct) {
      const lock = at(peak - r.giveback.points);
      if (low <= lock) return { exitAt: Math.max(c.t, entryAt), exitPrice: Math.min(lock, open), reason: 'PROFIT_LOCK', peakPct: peak };
    }
    if (r.trailing && peak >= r.trailing.activationPct) {
      const trail = at(peak) * (1 - r.trailing.stopPct / 100);
      if (low <= trail) return { exitAt: Math.max(c.t, entryAt), exitPrice: Math.min(trail, open), reason: 'TRAILING_STOP', peakPct: peak };
    }
    if (pct(high) >= r.takeProfitPct) return { exitAt: Math.max(c.t, entryAt), exitPrice: Math.max(at(r.takeProfitPct), open), reason: 'TAKE_PROFIT', peakPct: Math.max(peak, pct(high)) };
    peak = Math.max(peak, pct(high));
    if (c.t + MINUTE >= stopAt) return { exitAt: stopAt, exitPrice: c.c, reason: 'MAX_HOLD', peakPct: peak };
  }
  const last = series.at(-1);
  return { exitAt: last ? last.t + MINUTE : entryAt, exitPrice: last?.c ?? entryPrice, reason: 'END_OF_DATA', peakPct: peak };
}

/**
 * Constant-product estimate of a position's return at a given size. The pool's quote-side reserve at a price p is
 * estimated from one observation (reserveRef at priceRef) as reserveRef × √(p / priceRef), assuming no liquidity was
 * added or removed. Buying `size` pays size / reserve extra; selling value v receives v × reserve / (reserve + v).
 */
export function sizedReturn(sizeUsd: number, entryPrice: number, exitPrice: number, reserveRefUsd: number, priceRef: number): number {
  const r0 = reserveRefUsd * Math.sqrt(entryPrice / priceRef), r1 = reserveRefUsd * Math.sqrt(exitPrice / priceRef);
  const value = sizeUsd * (exitPrice / entryPrice) / (1 + sizeUsd / r0);
  return (value * r1 / (r1 + value)) / sizeUsd - 1;
}

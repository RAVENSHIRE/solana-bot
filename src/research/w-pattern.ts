import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * The W (double bottom) on the bonding curve's longer timeframe, with and without a volume check (owner, 6 Oct:
 * RESERVE "formed a W pattern on the long time frame 19:20–00:47 and then made new highs, but no volume check:
 * backtest it, prove it"). Fixed before any result was looked at:
 *
 *   bars       15-minute bars of the curve's market cap (SOL), from the observer's minute candles
 *   the W      a peak, a fall of ≥ 30 % to the first low, a rebound of ≥ 20 % to the neckline, a second low within
 *              ±15 % of the first and ≥ 15 % under the neckline, at least 2 bars after the first low; all within 8 h
 *   entry      the first 15-minute close above the neckline, at most 2 h after the second low
 *   volume     V1: the breakout bar trades ≥ 1.5× the average volume of the bars between the two lows
 *              V2: the second low trades less volume than the first (sellers tiring)
 *   exits      take profit +100 % (or +200 %), stop 3 % under the second low, out at graduation or after 6 h
 *   control    the plain breakout: the first 15-minute close above the highest high of the 8 bars before it (2 h)
 *
 * Every group is split by V1: a new high WITH volume behind it, and one WITHOUT (the owner's RESERVE case: new highs on
 * thin volume, then the dump).
 *
 * Stops fill at the stop or at the minute's open if it opened below (gaps are not forgiven); a minute that touches both
 * the stop and the target counts as the stop.
 */
export const W_RULE = Object.freeze({
  barMs: 15 * 60_000, minDropPct: 30, minReboundPct: 20, lowTolerancePct: 15, minSecondDropPct: 15, minLowGapBars: 2,
  maxSpanBars: 32, maxBreakoutBars: 8, volumeX: 1.5, stopBelowPct: 3, maxHoldMs: 6 * 3_600_000, controlLookbackBars: 8,
});

export interface Minute { t: number; o: number; h: number; l: number; c: number; vol: number; buyers: number }
export interface Bar extends Minute { n: number }
export interface CurveCoin { mint: string; symbol: string | null; name: string | null; created: number; complete: number | null; mayhem: boolean; minutes: Minute[] }

/** 15-minute bars (clock-aligned); a bar without trades does not exist. Volume in SOL, buyers summed per minute. */
export function bars(minutes: readonly Minute[], barMs = W_RULE.barMs): Bar[] {
  const out: Bar[] = [];
  for (const m of minutes) {
    const t = Math.floor(m.t / barMs) * barMs, last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, m.h); last.l = Math.min(last.l, m.l); last.c = m.c; last.vol += m.vol; last.buyers += m.buyers; last.n++; }
    else out.push({ t, o: m.o, h: m.h, l: m.l, c: m.c, vol: m.vol, buyers: m.buyers, n: 1 });
  }
  return out;
}

export interface WSignal {
  kind: 'W' | 'BREAKOUT';
  /** The breakout bar's index and its close time (the entry moment) and price. */
  j: number; at: number; entry: number;
  peak: number | null; low1: number | null; neckline: number; low2: number | null; stop: number;
  v1: boolean | null; v2: boolean | null;
}

/** The first W breakout of a coin, point in time: decided at a bar's close from that bar and the ones before it. */
export function findW(b: readonly Bar[], r = W_RULE): WSignal | null {
  for (let j = 3; j < b.length; j++) {
    const i0 = Math.max(0, j - r.maxSpanBars);
    for (let iN = j - 2; iN >= i0 + 2; iN--) {
      const N = b[iN]!.h;
      if (!(b[j]!.c > N) || b[j - 1]!.c > N) continue;
      // The neckline is the highest high since the first low; the second low is after it.
      let i2 = -1;
      for (let k = iN + 1; k < j; k++) if (i2 < 0 || b[k]!.l < b[i2]!.l) i2 = k;
      if (i2 < 0 || j - i2 > r.maxBreakoutBars) continue;
      // The peak is the highest high before the neckline; the first low is the lowest low between them.
      let iP = -1, i1 = -1;
      for (let k = i0; k < iN; k++) if (iP < 0 || b[k]!.h > b[iP]!.h) iP = k;
      for (let k = iP + 1; k < iN; k++) if (i1 < 0 || b[k]!.l < b[i1]!.l) i1 = k;
      if (iP < 0 || i1 < 0 || i2 - i1 < r.minLowGapBars) continue;
      const P = b[iP]!.h, L1 = b[i1]!.l, L2 = b[i2]!.l;
      let maxBetween = 0;
      for (let k = i1 + 1; k < i2; k++) maxBetween = Math.max(maxBetween, b[k]!.h);
      if (maxBetween > N) continue;
      if (L1 > P * (1 - r.minDropPct / 100) || N < L1 * (1 + r.minReboundPct / 100)) continue;
      if (Math.abs(L2 / L1 - 1) * 100 > r.lowTolerancePct || L2 > N * (1 - r.minSecondDropPct / 100)) continue;
      const between = b.slice(i1, i2 + 1), avgVol = between.reduce((a, x) => a + x.vol, 0) / between.length;
      return { kind: 'W', j, at: b[j]!.t + r.barMs, entry: b[j]!.c, peak: P, low1: L1, neckline: N, low2: L2, stop: L2 * (1 - r.stopBelowPct / 100),
        v1: b[j]!.vol >= r.volumeX * avgVol, v2: b[i2]!.vol < b[i1]!.vol };
    }
  }
  return null;
}

/**
 * The control: the first close above the highest high of the previous 8 bars (a new 2-h high); its stop is the lowest
 * low of those bars −3 %. V1 the same way: the breakout bar trades ≥ 1.5× their average volume.
 */
export function findBreakout(b: readonly Bar[], r = W_RULE): WSignal | null {
  for (let j = r.controlLookbackBars; j < b.length; j++) {
    const prev = b.slice(j - r.controlLookbackBars, j), hi = Math.max(...prev.map(x => x.h)), lo = Math.min(...prev.map(x => x.l));
    const avgVol = prev.reduce((a, x) => a + x.vol, 0) / prev.length;
    if (b[j]!.c > hi) return { kind: 'BREAKOUT', j, at: b[j]!.t + r.barMs, entry: b[j]!.c, peak: null, low1: null, neckline: hi, low2: null, stop: lo * (1 - r.stopBelowPct / 100),
      v1: b[j]!.vol >= r.volumeX * avgVol, v2: null };
  }
  return null;
}

export interface WTrade { reason: 'TAKE_PROFIT' | 'STOP' | 'GRADUATION' | 'MAX_HOLD' | 'DATA_END'; exitAt: number; exit: number; grossPct: number; peakPct: number }

/** The trade from the signal on the minute candles: take profit, stop, graduation, 6 h, or the last candle. */
export function trade(s: WSignal, coin: Pick<CurveCoin, 'complete' | 'minutes'>, tpPct: number, r = W_RULE): WTrade {
  const after = coin.minutes.filter(m => m.t >= s.at), target = s.entry * (1 + tpPct / 100);
  let peak = s.entry;
  for (const m of after) {
    if (coin.complete !== null && m.t >= coin.complete) break;
    if (m.t - s.at >= r.maxHoldMs) return { reason: 'MAX_HOLD', exitAt: m.t, exit: m.o, grossPct: (m.o / s.entry - 1) * 100, peakPct: (peak / s.entry - 1) * 100 };
    if (m.l <= s.stop) { const px = Math.min(s.stop, m.o); return { reason: 'STOP', exitAt: m.t, exit: px, grossPct: (px / s.entry - 1) * 100, peakPct: (peak / s.entry - 1) * 100 }; }
    peak = Math.max(peak, m.h);
    if (m.h >= target) return { reason: 'TAKE_PROFIT', exitAt: m.t, exit: target, grossPct: tpPct, peakPct: (peak / s.entry - 1) * 100 };
  }
  const last = after.filter(m => coin.complete === null || m.t < coin.complete).at(-1);
  const px = last?.c ?? s.entry;
  return { reason: coin.complete !== null ? 'GRADUATION' : 'DATA_END', exitAt: coin.complete ?? last?.t ?? s.at, exit: px, grossPct: (px / s.entry - 1) * 100, peakPct: (peak / s.entry - 1) * 100 };
}

/** Net of the fee on both sides and the fixed cost per round trip at the trade size (the measured K1 costs). */
export const netPct = (grossPct: number, feePct = 1.25, fixedUsd = 0.03, sizeUsd = 2) => ((1 + grossPct / 100) * (1 - feePct / 100) ** 2 - 1) * 100 - fixedUsd / sizeUsd * 100;

/** Every launch's curve minute candles, creation and graduation from the observer ledger (one pass, no trades kept). */
export function readCurves(files: readonly string[]): Map<string, CurveCoin> {
  const coins = new Map<string, CurveCoin>();
  const coin = (mint: string, obs: number) => { let c = coins.get(mint); if (!c) { c = { mint, symbol: null, name: null, created: obs, complete: null, mayhem: false, minutes: [] }; coins.set(mint, c); } return c; };
  for (const file of files) {
    const raw = fs.readFileSync(file), text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const ms: string[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tag = line.slice(2, line.indexOf('"', 2));
      if (tag !== 'M' && tag !== 'PC' && tag !== 'C' && tag !== 'K' && tag !== 'X' && tag !== 'G') continue;
      let r: unknown[];
      try { r = JSON.parse(line) as unknown[]; } catch { continue; }
      const mintAt = (i: number) => typeof r[i] === 'number' ? ms[r[i] as number] ?? null : null;
      if (tag === 'M') { ms[r[1] as number] = r[2] as string; continue; }
      if (tag === 'PC' || tag === 'C') {
        const mint = mintAt(tag === 'PC' ? 2 : 4); if (!mint) continue;
        const c = coin(mint, r[1] as number);
        c.created = Math.min(c.created, r[1] as number);
        c.name ??= (r[tag === 'PC' ? 5 : 8] as string) ?? null; c.symbol ??= (r[tag === 'PC' ? 6 : 9] as string) ?? null;
        if (tag === 'PC' && r[11] === 1) c.mayhem = true;
      } else if (tag === 'K') {
        const mint = mintAt(2), c = mint ? coins.get(mint) : undefined; if (!c) continue;
        c.minutes.push({ t: (r[1] as number) * 60_000, o: r[3] as number, h: r[4] as number, l: r[5] as number, c: r[6] as number, vol: ((r[7] as number) + (r[8] as number)) / 1e9, buyers: r[11] as number });
      } else {
        const mint = mintAt(tag === 'X' ? 3 : 2), c = mint ? coins.get(mint) : undefined;
        if (c) c.complete ??= r[1] as number;
      }
    }
  }
  for (const c of coins.values()) {
    c.minutes.sort((a, b) => a.t - b.t);
    // A normal curve never trades below its start (~27.96 SOL): one that does is mayhem mode, whose price does not follow trades.
    if (c.minutes.some(m => m.l < 27.5)) c.mayhem = true;
  }
  return coins;
}

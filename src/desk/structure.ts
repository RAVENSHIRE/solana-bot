/**
 * The technical-analysis layer (research, TA-LAYER.md, pre-registered 5 Oct): where the previous resistance is, and
 * the stop and target it implies. One pure function for live and backtest, on minute candles complete by T only.
 *
 *   - swing high: a minute whose high is above the highs of the minute before and the minute after; it is confirmed
 *     only when the minute after has closed (known one minute late);
 *   - previous resistance R: the most recent confirmed swing high that a later minute closed above, and that lies
 *     below the price at T; none → no structural stop ("no structure yet");
 *   - stop: R × (1 − 3 %); target: the nearest confirmed swing high above the price, else 2× the stop distance;
 *   - firstX = first minute's high ÷ its open; firstWick = how much of the first minute's rise was given back;
 *     range5 = (highest high − lowest low) ÷ last close over the last 5 complete minutes.
 *
 * Units do not matter (price or market cap) as long as candles and price share them. The thresholds are fixed by the
 * pre-registration and must not move after scoring.
 */
export interface Bar { t: number; o: number; h: number; l: number; c: number }
export const STRUCTURE = Object.freeze({ bufferPct: 3, maxStopPct: 25, wickWarning: 0.5, targetR: 2, minuteMs: 60_000 });

export interface Structure {
  /** The price at T the levels are measured from (the given price, else the last complete close). */
  price: number | null;
  resistance: number | null; stop: number | null; stopPct: number | null;
  target: number | null; targetPct: number | null;
  firstX: number | null; firstWick: number | null; range5: number | null;
  /** Complete minutes used. */
  bars: number;
}

export function structure(candles: readonly Bar[], T: number, price: number | null = null): Structure {
  const bars = candles.filter(b => b.t + STRUCTURE.minuteMs <= T).sort((a, b) => a.t - b.t);
  const n = bars.length, at = price ?? bars.at(-1)?.c ?? null;
  const first = bars[0] ?? null;
  const firstX = first && first.o > 0 ? first.h / first.o : null;
  const firstWick = first && first.h > first.o ? (first.h - first.c) / (first.h - first.o) : first ? 0 : null;
  const last5 = bars.slice(-5), lastClose = bars.at(-1)?.c ?? null;
  const range5 = last5.length && lastClose ? (Math.max(...last5.map(b => b.h)) - Math.min(...last5.map(b => b.l))) / lastClose : null;
  // Swing highs: both neighbours complete, so the one after has closed (confirmed).
  const swings: number[] = [];
  for (let i = 1; i < n - 1; i++) if (bars[i]!.h > bars[i - 1]!.h && bars[i]!.h > bars[i + 1]!.h) swings.push(i);
  let resistance: number | null = null;
  if (at !== null) for (let k = swings.length - 1; k >= 0; k--) {
    const i = swings[k]!, h = bars[i]!.h;
    if (h < at && bars.slice(i + 1).some(b => b.c > h)) { resistance = h; break; }
  }
  const stop = resistance !== null ? resistance * (1 - STRUCTURE.bufferPct / 100) : null;
  const stopPct = stop !== null && at ? (at - stop) / at * 100 : null;
  const above = at === null ? [] : swings.map(i => bars[i]!.h).filter(h => h > at);
  const target = above.length ? Math.min(...above) : stopPct !== null && at ? at * (1 + STRUCTURE.targetR * stopPct / 100) : null;
  const targetPct = target !== null && at ? (target / at - 1) * 100 : null;
  return { price: at, resistance, stop, stopPct, target, targetPct, firstX, firstWick, range5, bars: n };
}

/**
 * Minute candles from samples (the live path: pool reserves read every few seconds). Minute `i` covers
 * `[start + i·60 s, start + (i+1)·60 s)`; a minute with no sample is skipped, never invented.
 */
export function addSample(bars: Bar[], start: number, t: number, v: number, keep = 120): void {
  const m = start + Math.floor((t - start) / STRUCTURE.minuteMs) * STRUCTURE.minuteMs, last = bars.at(-1);
  if (last && last.t === m) { last.h = Math.max(last.h, v); last.l = Math.min(last.l, v); last.c = v; return; }
  if (last && m < last.t) return;
  bars.push({ t: m, o: v, h: v, l: v, c: v });
  if (bars.length > keep) bars.splice(0, bars.length - keep);
}

const k = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1000).toFixed(1)}K`;
/** One line for events and alerts: "stop $11.8K (prev. resistance $12.2K, −21 %) · target $19.5K (+32 %)". */
export function structureLine(s: Structure | null): string {
  if (!s || s.bars === 0) return 'no pool candles yet';
  if (s.stop === null || s.resistance === null || s.stopPct === null) return `no structure yet: no stop level (${s.bars} min)`;
  return `stop ${k(s.stop)} (prev. resistance ${k(s.resistance)}, −${s.stopPct.toFixed(0)} %)${s.target !== null && s.targetPct !== null ? ` · target ${k(s.target)} (+${s.targetPct.toFixed(0)} %)` : ''}`;
}

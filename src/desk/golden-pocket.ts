import type { Candle } from './replay';

/**
 * GOLDEN POCKET — break and retest, from 66hK2…pump on 1 Oct (PumpSwap pool from 21:41 UTC):
 *
 *   graduated $85K → $163K (first impulse: the resistance) → $107K (the dip) → $224K (breakout) →
 *   back to $146K (the old resistance $140–160K, also the 0.618–0.65 retracement of the $107K → $224K swing:
 *   the golden pocket) → straight up to $642K.
 *
 * The owner's rules: the shape counts, not the level (the opening screen's $9–50K → $6.7–27K → $14–50K → $27–100K,
 * or ten times that); the dip never goes below its minimum; buy the retest of the old resistance, the stop 5–10 %
 * below it. A second variant: the first candles are only up — buy within 12 % above the first / second candle.
 *
 * One state machine for both, fed minute candles (backtest) or market-cap samples (live). Values are market caps
 * in USD, but only their ratios matter, so the same rules hold on a $10K curve and a $200K pool.
 */
export type PocketZone = 'RESISTANCE' | 'FIB' | 'EITHER';
export interface OnlyUpRules {
  /** The first `bars` one-minute candles all close up, each above the previous close. */
  bars: number;
  /** Bought on a return to within `chasePct` above this candle's close (1 = first, 2 = second). */
  ref: number; chasePct: number;
  /** The return must come this soon; the stop is this far below the ref close. */
  windowMin: number; stopBelowPct: number;
}
export interface PocketRules {
  /** Break and retest; off to run only the only-up variant. */
  retest: boolean;
  /** The dip after the first impulse: at least dipMinPct below its high, and never more than dipMaxPct (the floor). */
  dipMinPct: number; dipMaxPct: number;
  /** The breakout: this multiple of the first impulse's high. */
  breakoutOverHigh: number;
  /** Where the retest is bought: the old resistance (its high, down to resistanceBelowPct under it), the Fibonacci pocket of the dip → breakout swing, or whichever comes first. */
  zone: PocketZone;
  resistanceBelowPct: number; resistanceAbovePct: number;
  /** Retracement of the dip → breakout swing: 0.5 → 0.65 (0.618–0.65 is the golden pocket proper). */
  fibTop: number; fibBottom: number;
  /** The stop: this far below the zone's bottom (the owner: 5–10 %). */
  stopBelowPct: number;
  /** The retest must come this soon after the breakout. */
  retestWindowMin: number;
  /** The whole pattern, up to the entry, within this long of the start (creation or graduation). */
  maxPatternMin: number;
  onlyUp: OnlyUpRules | null;
  /** Absolute floor (market cap): trading below it before the entry ends the pattern. */
  floorUsd: number;
}

export type PocketPhase = 'IMPULSE' | 'DIP' | 'BROKEN_OUT' | 'ENTRY' | 'FAILED' | 'EXPIRED';
export interface PocketEntry {
  kind: 'RETEST' | 'ONLY_UP'; at: number; price: number; stop: number;
  /** The level the pattern ran to before the entry (the next resistance): the breakout high, or the only-up high. */
  resistance: number; zone: [number, number]; detail: string;
}
export interface PocketState {
  startAt: number; phase: PocketPhase;
  /** Break and retest: first impulse high, dip low, breakout high. */
  high: number | null; low: number | null; top: number | null; breakoutAt: number | null;
  /** Only-up: the minute being built, completed up-candles, the ref close, the level once armed, the high since. */
  minute: { index: number; o: number; h: number; l: number; c: number } | null;
  upBars: number; upLastClose: number | null; upRefClose: number | null; upBroken: boolean; upRef: number | null; upReadyAt: number | null; upHigh: number | null;
  entry: PocketEntry | null; detail: string;
}

const MINUTE = 60_000;
const k = (v: number | null) => v === null ? '?' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1000).toFixed(1)}K`;

export function pocketState(startAt: number): PocketState {
  return { startAt, phase: 'IMPULSE', high: null, low: null, top: null, breakoutAt: null, minute: null, upBars: 0, upLastClose: null, upRefClose: null,
    upBroken: false, upRef: null, upReadyAt: null, upHigh: null, entry: null, detail: 'waiting for the first impulse' };
}

/** The buy zone and stop of a break and retest, from the impulse high, the dip low and the breakout high. */
export function pocketZone(r: PocketRules, high: number, low: number, top: number): { zone: [number, number]; stop: number } {
  const res: [number, number] = [high * (1 - r.resistanceBelowPct / 100), high * (1 + r.resistanceAbovePct / 100)];
  const fib: [number, number] = [top - r.fibBottom * (top - low), top - r.fibTop * (top - low)];
  const zone: [number, number] = r.zone === 'RESISTANCE' ? res : r.zone === 'FIB' ? fib : [Math.min(res[0], fib[0]), Math.max(res[1], fib[1])];
  // The zone never reaches the breakout high itself.
  zone[1] = Math.min(zone[1], top * 0.97);
  return { zone, stop: zone[0] * (1 - r.stopBelowPct / 100) };
}

const finished = (s: PocketState) => s.phase === 'ENTRY' || s.phase === 'FAILED' || s.phase === 'EXPIRED';

/**
 * One candle (or one sample: o = h = l = c) through the pattern. Returns the entry when this candle fills it.
 * Within a candle the order of high and low is unknown: a fill is taken at the zone's top or the candle's open,
 * whichever is lower, and the structure is updated from the candle's high only after the fill check.
 */
export function pocketStep(s: PocketState, r: PocketRules, bar: Candle): PocketEntry | null {
  if (finished(s)) return null;
  if (bar.t - s.startAt > r.maxPatternMin * MINUTE) { s.phase = 'EXPIRED'; s.detail = `no entry within ${r.maxPatternMin} min`; return null; }
  if (bar.l < r.floorUsd) { s.phase = 'FAILED'; s.detail = `traded at ${k(bar.l)}, below the ${k(r.floorUsd)} floor`; return null; }
  // Both variants run side by side; the first fill wins.
  const up = r.onlyUp ? onlyUpStep(s, r.onlyUp, bar) : null;
  if (up || !r.retest) return up;
  if (s.phase === 'IMPULSE') {
    // A candle that sets a new high: its low may have come before that high, only its close surely after.
    const newHigh = bar.h > (s.high ?? 0), after = newHigh ? bar.c : bar.l;
    s.high = Math.max(s.high ?? 0, bar.h);
    if (after <= s.high * (1 - r.dipMinPct / 100)) { s.phase = 'DIP'; s.low = after; s.detail = `${k(s.high)} → dip ${k(s.low)}`; }
    else s.detail = `impulse ${k(s.high)}`;
    if (s.phase === 'IMPULSE' || after >= s.high * (1 - r.dipMaxPct / 100)) return null;
  }
  if (s.phase === 'DIP') {
    s.low = Math.min(s.low!, bar.l);
    if (s.low < s.high! * (1 - r.dipMaxPct / 100)) { s.phase = 'FAILED'; s.detail = `dipped to ${k(s.low)}, more than ${r.dipMaxPct}% below the ${k(s.high)} high`; return null; }
    if (bar.h >= s.high! * r.breakoutOverHigh) { s.phase = 'BROKEN_OUT'; s.top = bar.h; s.breakoutAt = bar.t; s.detail = `${k(s.high)} → ${k(s.low)} → broke out to ${k(s.top)}`; }
    else s.detail = `${k(s.high)} → dip ${k(s.low)} · breakout at ${k(s.high! * r.breakoutOverHigh)}`;
    return null;
  }
  // Broken out: wait for the retest.
  if (bar.t - s.breakoutAt! > r.retestWindowMin * MINUTE) { s.phase = 'EXPIRED'; s.detail = `no retest within ${r.retestWindowMin} min of the breakout to ${k(s.top)}`; return null; }
  const { zone, stop } = pocketZone(r, s.high!, s.low!, s.top!);
  if (bar.l <= zone[1]) {
    if (bar.o < stop) { s.phase = 'FAILED'; s.detail = `fell through the ${k(zone[0])}–${k(zone[1])} pocket to ${k(bar.o)}`; return null; }
    const price = Math.min(zone[1], bar.o);
    s.phase = 'ENTRY';
    s.detail = `${k(s.high)} → ${k(s.low)} → ${k(s.top)} → retest at ${k(price)} (pocket ${k(zone[0])}–${k(zone[1])}, stop ${k(stop)})`;
    s.entry = { kind: 'RETEST', at: bar.t, price, stop, resistance: s.top!, zone, detail: s.detail };
    return s.entry;
  }
  s.top = Math.max(s.top!, bar.h);
  s.detail = `${k(s.high)} → ${k(s.low)} → ${k(s.top)} · buy at ${k(zone[1])}–${k(zone[0])}, stop ${k(stop)}`;
  return null;
}

/** Only-up variant: one-minute candles from the start; returns the entry when a return to the ref level fills it. */
function onlyUpStep(s: PocketState, u: OnlyUpRules, bar: Candle): PocketEntry | null {
  if (s.upBroken) return null;
  if (s.upRef === null) {
    const index = Math.max(0, Math.floor((bar.t - s.startAt) / MINUTE));
    // A minute is judged once the next one starts: it must close above its open and above the previous close.
    if (s.minute && index > s.minute.index) {
      const m = s.minute;
      s.minute = null;
      if (!(m.c > m.o && (s.upLastClose === null || m.c > s.upLastClose))) { s.upBroken = true; return null; }
      s.upBars++; s.upLastClose = m.c;
      if (s.upBars === u.ref) s.upRefClose = m.c;
      if (s.upBars >= u.bars) { s.upRef = s.upRefClose; s.upReadyAt = bar.t; }
    }
    if (s.upRef === null) {
      s.minute = s.minute ? { ...s.minute, h: Math.max(s.minute.h, bar.h), l: Math.min(s.minute.l, bar.l), c: bar.c } : { index, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
      s.upHigh = Math.max(s.upHigh ?? 0, bar.h);
      return null;
    }
  }
  if (bar.t - s.upReadyAt! > u.windowMin * MINUTE) { s.upBroken = true; return null; }
  const ref = s.upRef!, limit = ref * (1 + u.chasePct / 100), stop = ref * (1 - u.stopBelowPct / 100);
  if (bar.l <= limit) {
    if (bar.o < stop) { s.upBroken = true; return null; }
    const price = Math.min(limit, bar.o);
    s.phase = 'ENTRY';
    s.detail = `first ${u.bars} candles only up to ${k(s.upHigh)} → back to ${k(price)}, within ${u.chasePct}% of candle ${u.ref} (${k(ref)}), stop ${k(stop)}`;
    s.entry = { kind: 'ONLY_UP', at: bar.t, price, stop, resistance: s.upHigh!, zone: [ref, limit], detail: s.detail };
    return s.entry;
  }
  s.upHigh = Math.max(s.upHigh!, bar.h);
  return null;
}

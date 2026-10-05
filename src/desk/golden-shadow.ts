/**
 * GOLDEN POCKET shadow trades (research P2, CASE-2026-10-05-GOLDEN.md, pre-registered 5 Oct): no money. Every
 * only-up fill is "bought" at bot speed (the first pool sample ≥ 2 s after the fill) and at phone speed (≥ 45 s), and
 * followed on the pool's market cap with three exits judged together:
 *
 *   a  GOLDEN as it trades: the pattern's stop, −40 % fixed stop, a 25 % trailing stop after +50 %, 60 minutes;
 *   b  (a) plus a +100 % take profit;
 *   c  half sold at +100 %, the rest as (a).
 *
 * Each record carries `poolJumpX`: the first pool minute's high ÷ the graduation market cap (a pump.fun curve
 * completes at about 410.9 SOL). P1/P2 split on it (≤ 3 sane openers, ≥ 10 the $5M-first-candle rugs). Returns are
 * gross (market cap in, market cap out); costs are applied when the records are judged, at the size being studied.
 */
export const SHADOW = Object.freeze({ botMs: 2_000, phoneMs: 45_000, maxHoldMin: 60, stopLossPct: 40, trail: { activationPct: 50, stopPct: 25 }, takeProfitPct: 100 });
/** A pump.fun curve's market cap at completion: 30 SOL × 1,073,000,191 / 279,900,191 tokens left, on a 1B supply. */
export const GRADUATION_MCAP_SOL = 30 * 1_073_000_191 / 279_900_191 / 279_900_191 * 1e9;

type Exit = { pct: number; reason: string; at: number };
interface Leg {
  speed: 'bot' | 'phone'; due: number; entry: number | null; entryAt: number | null; peak: number;
  a: Exit | null; b: Exit | null; c: Exit | null; half: Exit | null;
}
interface Trade { mint: string; symbol: string | null; fillAt: number; fillUsd: number; stopUsd: number; poolJumpX: number | null; graduationUsd: number | null; legs: Leg[] }
export interface ShadowRecord {
  mint: string; symbol: string | null; fillAt: number; fillUsd: number; stopUsd: number; poolJumpX: number | null; graduationUsd: number | null;
  legs: Array<{ speed: 'bot' | 'phone'; entryAt: number | null; entryUsd: number | null; a: Exit | null; b: Exit | null; c: Exit | null }>;
}

export class GoldenShadow {
  private readonly open = new Map<string, Trade>();
  constructor(private readonly write: (r: ShadowRecord) => void) {}

  mints(): string[] { return [...this.open.keys()]; }
  has(mint: string): boolean { return this.open.has(mint); }

  start(t: { mint: string; symbol: string | null; fillAt: number; fillUsd: number; stopUsd: number; poolJumpX: number | null; graduationUsd: number | null }): void {
    if (this.open.has(t.mint)) return;
    const leg = (speed: 'bot' | 'phone', ms: number): Leg => ({ speed, due: t.fillAt + ms, entry: null, entryAt: null, peak: 0, a: null, b: null, c: null, half: null });
    this.open.set(t.mint, { ...t, legs: [leg('bot', SHADOW.botMs), leg('phone', SHADOW.phoneMs)] });
  }

  /** One market-cap sample of a pool with an open shadow trade. */
  sample(mint: string, cap: number, now: number): void {
    const t = this.open.get(mint);
    if (!t || !(cap > 0)) return;
    for (const l of t.legs) {
      if (l.entry === null) { if (now >= l.due) { l.entry = cap; l.entryAt = now; l.peak = cap; } continue; }
      l.peak = Math.max(l.peak, cap);
      const pct = (cap / l.entry - 1) * 100, peakPct = (l.peak / l.entry - 1) * 100, fromPeak = (cap / l.peak - 1) * 100, held = now - l.entryAt!;
      const base = cap <= t.stopUsd ? 'POCKET_STOP' : pct <= -SHADOW.stopLossPct ? 'STOP_LOSS'
        : peakPct >= SHADOW.trail.activationPct && fromPeak <= -SHADOW.trail.stopPct ? 'TRAILING_STOP' : held >= SHADOW.maxHoldMin * 60_000 ? 'MAX_HOLD' : null;
      const tp = pct >= SHADOW.takeProfitPct;
      if (!l.half && tp) l.half = { pct, reason: 'TAKE_PROFIT', at: now };
      if (!l.b && (tp || base)) l.b = tp ? { pct, reason: 'TAKE_PROFIT', at: now } : { pct, reason: base!, at: now };
      if (!l.a && base) l.a = { pct, reason: base, at: now };
      if (!l.c && l.a) l.c = l.half ? { pct: (l.half.pct + l.a.pct) / 2, reason: `half TAKE_PROFIT, half ${l.a.reason}`, at: now } : l.a;
    }
    this.closeIfDone(t);
  }

  /** Legs whose pool stopped being sampled (the tracker gave it up) close at their last state after the time stop. */
  expire(now: number, last: (mint: string) => { cap: number | null; at: number | null }): void {
    for (const t of [...this.open.values()]) {
      const s = last(t.mint);
      for (const l of t.legs) {
        if (now - (l.entryAt ?? l.due) < (SHADOW.maxHoldMin + 5) * 60_000) continue;
        if (l.entry === null) { l.a = l.b = l.c = { pct: 0, reason: 'NO_SAMPLE', at: now }; continue; }
        const pct = s.cap ? (s.cap / l.entry - 1) * 100 : 0, x = { pct, reason: 'NO_SAMPLE', at: s.at ?? now };
        l.a ??= x; l.b ??= x; l.c ??= l.half ? { pct: (l.half.pct + l.a.pct) / 2, reason: `half TAKE_PROFIT, half ${l.a.reason}`, at: x.at } : l.a;
      }
      this.closeIfDone(t);
    }
  }

  private closeIfDone(t: Trade): void {
    if (!t.legs.every(l => l.a && l.b && l.c)) return;
    this.open.delete(t.mint);
    try {
      this.write({ mint: t.mint, symbol: t.symbol, fillAt: t.fillAt, fillUsd: t.fillUsd, stopUsd: t.stopUsd, poolJumpX: t.poolJumpX, graduationUsd: t.graduationUsd,
        legs: t.legs.map(l => ({ speed: l.speed, entryAt: l.entryAt, entryUsd: l.entry, a: l.a, b: l.b, c: l.c })) });
    } catch { /* the shadow record is research, never a reason to stop the tracker */ }
  }
}

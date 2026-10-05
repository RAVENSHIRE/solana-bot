import { median } from '../core/stats';
import { MILESTONES } from './levels';

/**
 * What a coin's market-cap history says about two owner hypotheses, measured the same way on every coin:
 *
 *   Milestones   Once a coin closes above a round market cap ($100K, $1M, $10M…), does it keep going more often than
 *                after closing above a non-round level in the same decade? The control levels are the answer to
 *                "round numbers matter": without them a breakout rate means nothing.
 *   Old highs    A coin that fell ≥ 80 % from its high: how often does it get back to that high within a horizon?
 *                "8× back to the high" is only an upside if that happens often enough.
 *
 * Bars are market cap in USD (price × supply). Missing bars mean no trades, not missing data: GeckoTerminal leaves
 * empty intervals out, so a dead coin simply stops. A horizon is censored only when it ends after `asOf` (the time the
 * history was read), never because the bars ran out.
 */

export interface Bar { t: number; o: number; h: number; l: number; c: number }

const ok = (b: Bar) => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h > 0 && b.l > 0 && b.c > 0;
const sorted = (bars: readonly Bar[]) => bars.filter(ok).sort((a, b) => a.t - b.t);

export interface AthSummary {
  firstAt: number; lastAt: number; bars: number;
  athUsd: number; athAt: number;
  /** Last close. */
  currentUsd: number;
  /** Last close against the high, in % (≤ 0). */
  drawdownPct: number;
  /** Multiple from the last close back to the high. */
  toAthX: number;
  lowSinceAthUsd: number;
}

export function athSummary(raw: readonly Bar[]): AthSummary | null {
  const bars = sorted(raw);
  const last = bars.at(-1);
  if (!last) return null;
  let ath = bars[0]!;
  for (const b of bars) if (b.h > ath.h) ath = b;
  const lowSince = Math.min(...bars.filter(b => b.t >= ath.t).map(b => b.l));
  return { firstAt: bars[0]!.t, lastAt: last.t, bars: bars.length, athUsd: ath.h, athAt: ath.t, currentUsd: last.c,
    drawdownPct: (last.c / ath.h - 1) * 100, toAthX: ath.h / last.c, lowSinceAthUsd: lowSince };
}

/** Each milestone is paired with two levels in the same decade that are not round: ≈ 2.34× and ≈ 5.37× it. */
export const CONTROL_OFFSETS: readonly number[] = Object.freeze([10 ** 0.37, 10 ** 0.73]);

export interface Level { usd: number; round: boolean }
export function studyLevels(): Level[] {
  return MILESTONES.flatMap(m => [{ usd: m, round: true }, ...CONTROL_OFFSETS.map(k => ({ usd: m * k, round: false }))]);
}

export interface Crossing {
  levelUsd: number; round: boolean;
  /** Start of the first bar that closed at or above the level after a close below it. */
  at: number; closeUsd: number;
  /** Outcomes within the horizon; null when the horizon ends after the history was read. */
  reached2x: boolean | null;
  /** A high of 10× the level: the next milestone, for a round level. */
  reached10x: boolean | null;
  /** The last close inside the horizon is still at or above the level. */
  heldAbove: boolean | null;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
}

/** The first upward close through each study level, one per level and coin, with what followed. */
export function crossings(raw: readonly Bar[], o: { horizonMs: number; asOf: number; levels?: readonly Level[] }): Crossing[] {
  const bars = sorted(raw), out: Crossing[] = [];
  for (const level of o.levels ?? studyLevels()) {
    const i = bars.findIndex((b, k) => k > 0 && b.c >= level.usd && bars[k - 1]!.c < level.usd);
    if (i < 0) continue;
    const x = bars[i]!, end = x.t + o.horizonMs, censored = end > o.asOf;
    const after = bars.filter(b => b.t > x.t && b.t <= end);
    const hi = Math.max(x.c, ...after.map(b => b.h)), lo = Math.min(x.c, ...after.map(b => b.l));
    const lastClose = after.at(-1)?.c ?? x.c;
    out.push({ levelUsd: level.usd, round: level.round, at: x.t, closeUsd: x.c,
      reached2x: hi >= 2 * level.usd ? true : censored ? null : false,
      reached10x: hi >= 10 * level.usd ? true : censored ? null : false,
      heldAbove: censored ? null : lastClose >= level.usd,
      maxGainPct: censored ? null : (hi / x.c - 1) * 100,
      maxDrawdownPct: censored ? null : (lo / x.c - 1) * 100 });
  }
  return out;
}

export interface Reclaim {
  athUsd: number; athAt: number;
  /** The first close at least `drawdownPct` below the running high. */
  triggerAt: number; triggerCloseUsd: number; drawdownPct: number;
  /** Time from the first bar to the trigger: how young the coin was when it fell. */
  ageAtTriggerMs: number;
  /** A high at or above the old high within the horizon; null while unknown (horizon not over, not reclaimed yet). */
  reclaimed: boolean | null; reclaimedAt: number | null;
  maxGainPct: number | null;
}

/** The first deep fall from a running high per coin, and whether the high came back within the horizon. */
export function reclaims(raw: readonly Bar[], o: { drawdownPct: number; horizonMs: number; asOf: number }): Reclaim | null {
  const bars = sorted(raw);
  if (!bars.length) return null;
  let ath = bars[0]!;
  for (const b of bars) {
    if (b.h > ath.h) ath = b;
    const dd = (b.c / ath.h - 1) * 100;
    if (dd > -o.drawdownPct) continue;
    const end = b.t + o.horizonMs, censored = end > o.asOf;
    const after = bars.filter(x => x.t > b.t && x.t <= end);
    const back = after.find(x => x.h >= ath.h) ?? null;
    const hi = Math.max(b.c, ...after.map(x => x.h));
    return { athUsd: ath.h, athAt: ath.t, triggerAt: b.t, triggerCloseUsd: b.c, drawdownPct: dd, ageAtTriggerMs: b.t - bars[0]!.t,
      reclaimed: back ? true : censored ? null : false, reclaimedAt: back?.t ?? null,
      maxGainPct: censored && !back ? null : (hi / b.c - 1) * 100 };
  }
  return null;
}

export interface Rate { n: number; hits: number; rate: number | null; low: number | null; high: number | null }

/** Share of hits with a Wilson 95 % interval; unknown outcomes (null) are left out of n. */
export function rate(outcomes: ReadonlyArray<boolean | null>, z = 1.96): Rate {
  const known = outcomes.filter((x): x is boolean => x !== null), n = known.length, hits = known.filter(Boolean).length;
  if (!n) return { n, hits, rate: null, low: null, high: null };
  const p = hits / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { n, hits, rate: p, low: (c - m) / d, high: (c + m) / d };
}

export interface CrossingGroup { crossings: number; censored: number; reached2x: Rate; reached10x: Rate; heldAbove: Rate; medianMaxGainPct: number | null; medianMaxDrawdownPct: number | null }
const groupOf = (cs: readonly Crossing[]): CrossingGroup => ({
  crossings: cs.length, censored: cs.filter(c => c.heldAbove === null).length,
  reached2x: rate(cs.map(c => c.reached2x)), reached10x: rate(cs.map(c => c.reached10x)), heldAbove: rate(cs.map(c => c.heldAbove)),
  medianMaxGainPct: median(cs.flatMap(c => c.maxGainPct ?? [])), medianMaxDrawdownPct: median(cs.flatMap(c => c.maxDrawdownPct ?? [])),
});

/** Round milestones against the control levels, overall and per milestone decade. */
export function summarizeCrossings(cs: readonly Crossing[]): { round: CrossingGroup; control: CrossingGroup; byDecade: Array<{ milestoneUsd: number; round: CrossingGroup; control: CrossingGroup }> } {
  const decade = (c: Crossing) => MILESTONES.filter(m => m <= c.levelUsd * 1.0000001).at(-1) ?? MILESTONES[0]!;
  return { round: groupOf(cs.filter(c => c.round)), control: groupOf(cs.filter(c => !c.round)),
    byDecade: MILESTONES.map(m => ({ milestoneUsd: m, round: groupOf(cs.filter(c => c.round && decade(c) === m)), control: groupOf(cs.filter(c => !c.round && decade(c) === m)) }))
      .filter(g => g.round.crossings + g.control.crossings > 0) };
}

export interface ReclaimGroup { events: number; censored: number; reclaimed: Rate; medianMaxGainPct: number | null }
const reclaimGroup = (es: readonly Reclaim[]): ReclaimGroup => ({ events: es.length, censored: es.filter(e => e.reclaimed === null).length,
  reclaimed: rate(es.map(e => e.reclaimed)), medianMaxGainPct: median(es.flatMap(e => e.maxGainPct ?? [])) });

/** All deep falls, and split by how young the coin was when it fell (default: within its first 7 days). */
export function summarizeReclaims(es: readonly Reclaim[], youngMs = 7 * 86_400_000): { all: ReclaimGroup; young: ReclaimGroup; older: ReclaimGroup } {
  return { all: reclaimGroup(es), young: reclaimGroup(es.filter(e => e.ageAtTriggerMs <= youngMs)), older: reclaimGroup(es.filter(e => e.ageAtTriggerMs > youngMs)) };
}

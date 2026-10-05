import type { LedgerEntry } from './types';

/**
 * Levels (owner, 5 Oct, docs/MULTICHAIN.md): Solana first, then one chain at a time. A level is mastered when one
 * strategy passes all four: (1) ≥ 100 TEST trades, positive on average after costs, with the luck test passing;
 * (2) stops fill within 10 points of their level; (3) about 20 LIVE trades at the smallest size inside the TEST range;
 * (4) the owner's go. This module scores (1) and (2) from the TEST ledgers; (3) and (4) are shown as the next steps.
 *
 * Only trades opened after the clean start count: 5 Oct 21:00 UTC, after the fixes of that day (stale insider
 * baseline, dropped custom signals, Jupiter quote throttle).
 */
export const LEVEL1 = Object.freeze({
  chain: 'Solana', since: Date.parse('2026-10-05T21:00:00Z'), minTrades: 100, maxLuckP: 0.05, maxStopGapPts: 10, liveTrades: 20,
  resamples: 4_000,
});

export interface LevelTrade { at: number; pct: number; reason: string | null }
export interface LevelRow {
  id: string; label: string; enabled: boolean;
  trades: number; avgPct: number | null; wonPct: number | null; luckP: number | null;
  /** STOP_LOSS exits: how many, and how many points past the stop they filled on average (net of costs). */
  stops: { n: number; gapPts: number | null };
  checks: { trades: boolean; positive: boolean; luck: boolean; stops: boolean | null };
  /** All TEST checks pass: the strategy may go to the LIVE step. */
  testPassed: boolean;
}

/** Closed trades opened at or after `since`: each SELL matched to the BUY that opened it (scale-ins and drills as the stats do). */
export function levelTrades(entries: readonly LedgerEntry[], since: number): LevelTrade[] {
  const open = new Map<string, LedgerEntry>(), out: LevelTrade[] = [];
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (e.status === 'FAILED' || e.status === 'UNKNOWN') continue;
    if (e.side === 'BUY') { if (!(e.note?.startsWith('ADD') && open.has(e.mint))) open.set(e.mint, e); continue; }
    const buy = open.get(e.mint) ?? null;
    open.delete(e.mint);
    if (!buy || buy.at < since || e.note?.startsWith('DRILL') || buy.note?.startsWith('DRILL') || e.netPnlUsd === null) continue;
    const qty = Number(e.quantity), cost = e.entryPriceUsd !== null && Number.isFinite(qty) ? e.entryPriceUsd * qty + (buy.networkFeeUsd ?? 0) : null;
    if (cost) out.push({ at: e.at, pct: e.netPnlUsd / cost * 100, reason: e.exitReason ?? null });
  }
  return out;
}

/** A small deterministic PRNG (mulberry32): the same trades always give the same p. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

/**
 * The luck test: how often the average would be at least this high if the strategy had no edge. The returns are
 * shifted to a zero mean and resampled with replacement; p is the share of resampled averages ≥ the real one.
 */
export function luckP(xs: readonly number[], resamples = LEVEL1.resamples, seed = 7): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length, centered = xs.map(x => x - mean), next = rng(seed);
  let hits = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += centered[Math.floor(next() * xs.length)]!;
    if (s / xs.length >= mean) hits++;
  }
  return (hits + 1) / (resamples + 1);
}

export function levelRow(s: { id: string; label: string; enabled: boolean; stopLossPct: number }, trades: readonly LevelTrade[]): LevelRow {
  const n = trades.length, pcts = trades.map(t => t.pct);
  const avgPct = n ? pcts.reduce((a, b) => a + b, 0) / n : null, wonPct = n ? trades.filter(t => t.pct > 0).length / n * 100 : null;
  const p = luckP(pcts);
  const stops = trades.filter(t => t.reason?.startsWith('STOP_LOSS'));
  const gapPts = stops.length ? stops.reduce((a, t) => a + (-t.pct - s.stopLossPct), 0) / stops.length : null;
  const checks = { trades: n >= LEVEL1.minTrades, positive: avgPct !== null && avgPct > 0, luck: p !== null && p < LEVEL1.maxLuckP,
    stops: gapPts === null ? null : gapPts <= LEVEL1.maxStopGapPts };
  return { id: s.id, label: s.label, enabled: s.enabled, trades: n, avgPct, wonPct, luckP: p, stops: { n: stops.length, gapPts }, checks,
    testPassed: checks.trades && checks.positive && checks.luck && checks.stops !== false };
}

/** Furthest along first: passed checks, then trades. */
export const byProgress = (a: LevelRow, b: LevelRow): number => {
  const score = (r: LevelRow) => Number(r.checks.trades) + Number(r.checks.positive) + Number(r.checks.luck) + Number(r.checks.stops === true);
  return Number(b.testPassed) - Number(a.testPassed) || score(b) - score(a) || b.trades - a.trades;
};

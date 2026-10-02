import { curveMcapSol } from './pump-events';
import type { Dataset, LaunchFacts } from './dataset';

/**
 * "What if every launch had been bought straight away?" A trade simulation on the observer's data: buy a fixed delay
 * after creation, sell at a take profit, a stop or a time limit. Conservative by construction:
 *
 *   - the buy fills at the highest curve price seen between the decision and `latencyMs` later (our transaction lands
 *     after the trades already in flight);
 *   - a stop that a trade jumps over sells at that trade's price, not at the stop (a rug falls through it);
 *   - the take profit sells at its level; within a minute candle the low is checked before the high;
 *   - a curve that completes while held sells at the graduation price (the pool after it is not observed);
 *   - fees: pump.fun's curve fee on each side plus a fixed network/priority cost per round trip.
 */
export interface ExitRule { tpPct: number; slPct: number | null; maxHoldMin: number }
export interface DirectOptions { delayS: number; latencyMs: number; feePct: number; fixedUsd: number; sizeUsd: number; solUsd: number }
export const DIRECT_DEFAULTS: Omit<DirectOptions, 'delayS'> = { latencyMs: 2_000, feePct: 1.25, fixedUsd: 0.03, sizeUsd: 2, solUsd: 118 };
export interface DirectTrade { mint: string; symbol: string | null; createdObs: number; entryAt: number; entryMcap: number; exitAt: number; exitMcap: number; reason: string; netPct: number; peakPct: number }

interface Point { at: number; h: number; l: number; c: number; trade: boolean }
const paths = new WeakMap<LaunchFacts, Point[]>();
function pricePath(l: LaunchFacts): Point[] {
  const hit = paths.get(l);
  if (hit) return hit;
  const out: Point[] = l.trades.map(t => { const p = curveMcapSol(t.vSol, t.vTok); return { at: t.obs, h: p, l: p, c: p, trade: true }; });
  const lastTrade = out.at(-1)?.at ?? 0;
  for (const k of l.candles) if (k.m + 60_000 > lastTrade) out.push({ at: k.m + 60_000, h: k.h, l: k.l, c: k.c, trade: false });
  out.sort((a, b) => a.at - b.at);
  paths.set(l, out);
  return out;
}

export function simulate(l: LaunchFacts, rule: ExitRule, o: DirectOptions, dataEnd: number): DirectTrade | null {
  const decide = l.createdObs + o.delayS * 1000, fillBy = decide + o.latencyMs, until = fillBy + rule.maxHoldMin * 60_000;
  if (until > dataEnd || (l.completeObs !== null && l.completeObs <= fillBy)) return null;
  const path = pricePath(l);
  const before = path.filter(p => p.trade && p.at <= decide).at(-1);
  const inFlight = path.filter(p => p.trade && p.at > decide && p.at <= fillBy);
  // Nothing traded yet: the launch is not known to be alive, so it is not bought.
  if (!before && !inFlight.length) return null;
  const entry = Math.max(before?.c ?? 0, ...inFlight.map(p => p.h));
  const tp = entry * (1 + rule.tpPct / 100), sl = rule.slPct === null ? null : entry * (1 - rule.slPct / 100);
  let exitAt = until, exit: number | null = null, reason = 'TIME', peak = entry;
  for (const p of path) {
    if (p.at <= fillBy) continue;
    if (p.at > until) break;
    if (sl !== null && p.l <= sl) { exit = p.trade ? p.l : Math.min(sl, p.c); exitAt = p.at; reason = 'STOP'; break; }
    if (p.h >= tp) { exit = tp; exitAt = p.at; reason = 'TAKE_PROFIT'; peak = Math.max(peak, p.h); break; }
    peak = Math.max(peak, p.h);
    if (l.completeObs !== null && p.at >= l.completeObs) { exit = p.c; exitAt = p.at; reason = 'GRADUATED'; break; }
  }
  if (exit === null) exit = path.filter(p => p.at <= until).at(-1)?.c ?? entry;
  const gross = exit / entry, f = 1 - o.feePct / 100;
  const netPct = (gross * f * f - 1 - o.fixedUsd / o.sizeUsd) * 100;
  return { mint: l.mint, symbol: l.symbol, createdObs: l.createdObs, entryAt: fillBy, entryMcap: entry, exitAt, exitMcap: exit, reason, netPct, peakPct: (peak / entry - 1) * 100 };
}

export interface Summary { n: number; winPct: number; meanPct: number; medianPct: number; pf: number; totalUsd: number; tpPct: number; stopPct: number; worstPct: number; bestPct: number }
export function summarize(trades: DirectTrade[], sizeUsd: number): Summary {
  const r = trades.map(t => t.netPct).sort((a, b) => a - b), n = r.length;
  const gain = r.filter(x => x > 0).reduce((a, x) => a + x, 0), loss = -r.filter(x => x <= 0).reduce((a, x) => a + x, 0);
  return { n, winPct: n ? r.filter(x => x > 0).length / n * 100 : 0, meanPct: n ? r.reduce((a, x) => a + x, 0) / n : 0,
    medianPct: n ? r[n >> 1]! : 0, pf: loss > 0 ? gain / loss : gain > 0 ? Infinity : 0, totalUsd: r.reduce((a, x) => a + x, 0) / 100 * sizeUsd,
    tpPct: n ? trades.filter(t => t.reason === 'TAKE_PROFIT').length / n * 100 : 0, stopPct: n ? trades.filter(t => t.reason === 'STOP').length / n * 100 : 0,
    worstPct: n ? r[0]! : 0, bestPct: n ? r[n - 1]! : 0 };
}

/** Normal launches only: mayhem-mode curves gain SOL without matching trades. */
export function directTrades(ds: Dataset, rule: ExitRule, o: DirectOptions, filter: (l: LaunchFacts) => boolean = () => true): DirectTrade[] {
  const out: DirectTrade[] = [];
  for (const l of ds.launches.values()) {
    if (l.mayhem || l.createdObs < ds.first || !filter(l)) continue;
    const t = simulate(l, rule, o, ds.last);
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.createdObs - b.createdObs);
}

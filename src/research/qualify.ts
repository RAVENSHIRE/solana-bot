import { blindSpots, features, type Dataset, type Features, type LaunchFacts } from './dataset';
import { DIRECT_DEFAULTS, simulate, summarize, type DirectOptions, type DirectTrade, type ExitRule, type Summary } from './direct';
import { EXITS, FAST_EXITS, GROUPS, exitsFor, groupDelays, ruleId, type GroupId } from './rules';

/**
 * The gate between research and the phone. A rule qualifies only when, on launches it was never tuned on, it
 *   - had at least `minTrades` trades,
 *   - made a profit after costs on average,
 *   - hit its take profit often enough to cover the losers (the hit rate at which the average breaks even),
 *   - was profitable on its tuning period too,
 *   - is clear of luck: the chance of an average this good from a rule with no edge (a bootstrap p-value) is small
 *     enough for the number of rules tested in the same run (Holm's correction at `alpha`),
 *   - is not carried by a few spikes: still profitable without its best `trimTopPct` % of trades (at least one),
 *   - and has not lost money live: once `minForwardTrades` of its live calls are judged, their average must be ≥ 0.
 * Each group's exit is chosen on the tuning period (earlier 60 % of launches) and judged unchanged on the later 40 %,
 * at the costs given (the gate's: a buy at the owner's speed, see GATE_COSTS). The same rule bought by a bot is shown
 * next to it (`botFill`), so the price of the owner's delay is visible.
 */
export interface Criteria { minTrades: number; minMeanPct: number; tuneSplit: number; minForwardTrades: number; alpha: number; bootstrap: number; trimTopPct: number }
export const CRITERIA: Criteria = { minTrades: 100, minMeanPct: 0, tuneSplit: 0.6, minForwardTrades: 30, alpha: 0.05, bootstrap: 2_000, trimTopPct: 1 };

export interface RuleEvidence {
  id: string; group: GroupId; groupLabel: string; delayS: number; exit: ExitRule;
  tuning: Summary; validation: Summary;
  /** The take-profit hit rate (%) at which the later period's trades would have broken even. */
  requiredHitPct: number | null;
  /** One-sided bootstrap p-value for a positive later-period average, and the Holm threshold it had to meet. */
  pValue: number | null; pThreshold: number | null;
  /** The later-period average without its best `trimTopPct` % of trades. */
  trimmedMeanPct: number | null;
  /** The same rule and exit on the same later launches, bought by a bot (2 s fill): the cost of the owner's delay. */
  botFill: Summary | null;
  forward: { n: number; meanPct: number | null };
  qualified: boolean; reasons: string[];
}
export interface Qualification {
  version: 1; generatedAt: number; data: { from: number; to: number; launches: number }; cut: number;
  criteria: Criteria; costs: Omit<DirectOptions, 'delayS'>; rules: RuleEvidence[];
}

const mean = (v: number[]) => v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;

/** A small seeded generator, so the same data gives the same p-values. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * One-sided p-value for "the true average is above 0": the returns are shifted to an average of exactly 0 (a rule with
 * no edge but the same spread), resampled `b` times, and p is the share of resampled averages at least as high as the
 * real one.
 */
export function bootstrapP(returns: number[], b: number, seed: string): number | null {
  const n = returns.length;
  if (n < 2) return null;
  const m = returns.reduce((a, x) => a + x, 0) / n, shifted = returns.map(x => x - m), next = rng(seed);
  let hits = 0;
  for (let i = 0; i < b; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += shifted[(next() * n) | 0]!;
    if (sum / n >= m) hits++;
  }
  return (hits + 1) / (b + 1);
}

/** Holm's step-down thresholds: the k-th smallest of m p-values must be ≤ alpha / (m − k); all after the first miss fail. */
export function holm(ps: Array<number | null>, alpha: number): Array<{ threshold: number | null; pass: boolean }> {
  const m = ps.length, order = ps.map((p, i) => ({ p: p ?? 1, i })).sort((a, b) => a.p - b.p);
  const out: Array<{ threshold: number | null; pass: boolean }> = ps.map(() => ({ threshold: null, pass: false }));
  let open = true;
  order.forEach(({ p, i }, k) => { const threshold = alpha / (m - k); open = open && p <= threshold; out[i] = { threshold, pass: open && ps[i] !== null }; });
  return out;
}

/** The average without the best `pct` % of trades (at least one): a rule carried by one spike is not an edge. */
export function trimmedMean(returns: number[], pct: number): number | null {
  if (returns.length < 2) return null;
  const drop = Math.max(1, Math.ceil(returns.length * pct / 100)), kept = [...returns].sort((a, b) => a - b).slice(0, returns.length - drop);
  return mean(kept);
}

/** The take-profit hit rate at which these trades break even: wins at the target's net, the rest at their average. */
export function requiredHitRate(trades: DirectTrade[]): number | null {
  const wins = trades.filter(t => t.reason === 'TAKE_PROFIT').map(t => t.netPct), rest = trades.filter(t => t.reason !== 'TAKE_PROFIT').map(t => t.netPct);
  const w = mean(wins), r = mean(rest);
  if (w === null || r === null) return null;
  if (r >= 0) return 0;
  return w > r ? -r / (w - r) * 100 : null;
}

export function qualify(ds: Dataset, costs: Omit<DirectOptions, 'delayS'>, o: { criteria?: Criteria; now?: number } = {}): Qualification {
  const criteria = o.criteria ?? CRITERIA, blind = blindSpots(ds);
  const launches = [...ds.launches.values()].filter(l => !l.mayhem && l.createdObs >= ds.first).sort((a, b) => a.createdObs - b.createdObs);
  const cut = launches[Math.floor(launches.length * criteria.tuneSplit)]?.createdObs ?? Infinity;
  const byCreator = new Map<string, LaunchFacts[]>();
  for (const l of launches) if (l.creator) byCreator.set(l.creator, [...(byCreator.get(l.creator) ?? []), l]);
  const forward = new Map<string, number[]>();
  for (const r of ds.results) (forward.get(r.ruleId) ?? forward.set(r.ruleId, []).get(r.ruleId)!).push(r.netPct);
  const rules: RuleEvidence[] = [];
  const delays = [...new Set(groupDelays().map(g => g.delayS))];
  for (const delayS of delays) {
    // Features once per launch, simulations once per launch and exit; every group is a filter over them.
    const f = new Map<string, Features>();
    for (const l of launches) {
      const end = l.createdObs + delayS * 1000, earlier = (byCreator.get(l.creator ?? '') ?? []).filter(e => e.createdObs < l.createdObs);
      f.set(l.mint, features(l, delayS, { creatorLaunches: earlier.length, creatorGraduations: earlier.filter(e => e.completeObs !== null && e.completeObs <= end).length }, blind));
    }
    const sims = [...EXITS, ...FAST_EXITS].map(x => ({ x, trades: launches.map(l => simulate(l, x, { ...costs, delayS }, ds.last)).filter((t): t is DirectTrade => !!t) }));
    for (const { group } of groupDelays().filter(g => g.delayS === delayS)) {
      const g = GROUPS[group], menu = exitsFor(group);
      const runs = sims.filter(s => menu.includes(s.x)).map(({ x, trades }) => {
        const mine = trades.filter(t => g.test(f.get(t.mint)!));
        return { x, tune: mine.filter(t => t.createdObs < cut), later: mine.filter(t => t.createdObs >= cut) };
      });
      const best = [...runs].sort((a, b) => summarize(b.tune, costs.sizeUsd).meanPct - summarize(a.tune, costs.sizeUsd).meanPct)[0]!;
      const id = ruleId(group, delayS, best.x), tuning = summarize(best.tune, costs.sizeUsd), validation = summarize(best.later, costs.sizeUsd);
      const required = requiredHitRate(best.later), fwd = forward.get(id) ?? [], fwdMean = mean(fwd), later = best.later.map(t => t.netPct);
      const trimmed = trimmedMean(later, criteria.trimTopPct);
      // The same exit bought by a bot, on the same later launches: shown, never decisive.
      const bot = costs.fill === 'phone' ? launches.filter(l => l.createdObs >= cut && g.test(f.get(l.mint)!))
        .map(l => simulate(l, best.x, { ...costs, latencyMs: DIRECT_DEFAULTS.latencyMs, fill: 'bot', delayS }, ds.last)).filter((t): t is DirectTrade => !!t) : null;
      const reasons: string[] = [];
      if (validation.n < criteria.minTrades) reasons.push(`only ${validation.n} later trades (needs ${criteria.minTrades})`);
      if (validation.meanPct <= criteria.minMeanPct) reasons.push(`later average ${validation.meanPct.toFixed(1)} % after costs`);
      if (required === null || validation.tpPct < required) reasons.push(`target hit ${validation.tpPct.toFixed(0)} % of the time, ${required === null ? 'never enough' : `needs ${required.toFixed(0)} %`} to cover the losers`);
      if (tuning.meanPct <= 0) reasons.push(`tuning average ${tuning.meanPct.toFixed(1)} %`);
      if (validation.meanPct > criteria.minMeanPct && trimmed !== null && trimmed <= criteria.minMeanPct)
        reasons.push(`carried by its best trades: ${trimmed.toFixed(1)} % average without the best ${Math.max(1, Math.ceil(later.length * criteria.trimTopPct / 100))}`);
      if (fwd.length >= criteria.minForwardTrades && (fwdMean ?? 0) < 0) reasons.push(`live calls lost ${fwdMean!.toFixed(1)} % on average over ${fwd.length}`);
      rules.push({ id, group, groupLabel: g.label, delayS, exit: best.x, tuning, validation, requiredHitPct: required,
        pValue: bootstrapP(later, criteria.bootstrap, id), pThreshold: null, trimmedMeanPct: trimmed, botFill: bot ? summarize(bot, costs.sizeUsd) : null,
        forward: { n: fwd.length, meanPct: fwdMean }, qualified: false, reasons });
    }
  }
  // Luck: many rules are tried at once, so each must be clear of chance by Holm's correction over all of them.
  const luck = holm(rules.map(r => r.pValue), criteria.alpha);
  rules.forEach((r, i) => {
    r.pThreshold = luck[i]!.threshold;
    if (!luck[i]!.pass) r.reasons.push(r.pValue === null ? 'too few later trades to tell it from luck'
      : `could be luck: p = ${r.pValue.toFixed(4)} for a positive average, needs ≤ ${r.pThreshold!.toFixed(4)} with ${rules.length} rules tested`);
    r.qualified = r.reasons.length === 0;
  });
  rules.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.validation.meanPct - a.validation.meanPct);
  return { version: 1, generatedAt: o.now ?? Date.now(), data: { from: ds.first, to: ds.last, launches: launches.length }, cut, criteria, costs, rules };
}

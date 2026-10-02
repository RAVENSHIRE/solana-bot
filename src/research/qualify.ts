import { blindSpots, features, type Dataset, type Features, type LaunchFacts } from './dataset';
import { simulate, summarize, type DirectOptions, type DirectTrade, type ExitRule, type Summary } from './direct';
import { EXITS, GROUPS, groupDelays, ruleId, type GroupId } from './rules';

/**
 * The gate between research and the phone. A rule qualifies only when, on launches it was never tuned on, it
 *   - had at least `minTrades` trades,
 *   - made a profit after costs on average,
 *   - hit its take profit often enough to cover the losers (the hit rate at which the average breaks even),
 *   - was profitable on its tuning period too,
 *   - and has not lost money live: once `minForwardTrades` of its live calls are judged, their average must be ≥ 0.
 * Each group's exit is chosen on the tuning period (earlier 60 % of launches) and judged unchanged on the later 40 %.
 */
export interface Criteria { minTrades: number; minMeanPct: number; tuneSplit: number; minForwardTrades: number }
export const CRITERIA: Criteria = { minTrades: 100, minMeanPct: 0, tuneSplit: 0.6, minForwardTrades: 30 };

export interface RuleEvidence {
  id: string; group: GroupId; groupLabel: string; delayS: number; exit: ExitRule;
  tuning: Summary; validation: Summary;
  /** The take-profit hit rate (%) at which the later period's trades would have broken even. */
  requiredHitPct: number | null;
  forward: { n: number; meanPct: number | null };
  qualified: boolean; reasons: string[];
}
export interface Qualification {
  version: 1; generatedAt: number; data: { from: number; to: number; launches: number }; cut: number;
  criteria: Criteria; costs: Omit<DirectOptions, 'delayS'>; rules: RuleEvidence[];
}

const mean = (v: number[]) => v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;

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
    const sims = EXITS.map(x => ({ x, trades: launches.map(l => simulate(l, x, { ...costs, delayS }, ds.last)).filter((t): t is DirectTrade => !!t) }));
    for (const { group } of groupDelays().filter(g => g.delayS === delayS)) {
      const g = GROUPS[group];
      const runs = sims.map(({ x, trades }) => {
        const mine = trades.filter(t => g.test(f.get(t.mint)!));
        return { x, tune: mine.filter(t => t.createdObs < cut), later: mine.filter(t => t.createdObs >= cut) };
      });
      const best = [...runs].sort((a, b) => summarize(b.tune, costs.sizeUsd).meanPct - summarize(a.tune, costs.sizeUsd).meanPct)[0]!;
      const id = ruleId(group, delayS, best.x), tuning = summarize(best.tune, costs.sizeUsd), validation = summarize(best.later, costs.sizeUsd);
      const required = requiredHitRate(best.later), fwd = forward.get(id) ?? [], fwdMean = mean(fwd);
      const reasons: string[] = [];
      if (validation.n < criteria.minTrades) reasons.push(`only ${validation.n} later trades (needs ${criteria.minTrades})`);
      if (validation.meanPct <= criteria.minMeanPct) reasons.push(`later average ${validation.meanPct.toFixed(1)} % after costs`);
      if (required === null || validation.tpPct < required) reasons.push(`target hit ${validation.tpPct.toFixed(0)} % of the time, ${required === null ? 'never enough' : `needs ${required.toFixed(0)} %`} to cover the losers`);
      if (tuning.meanPct <= 0) reasons.push(`tuning average ${tuning.meanPct.toFixed(1)} %`);
      if (fwd.length >= criteria.minForwardTrades && (fwdMean ?? 0) < 0) reasons.push(`live calls lost ${fwdMean!.toFixed(1)} % on average over ${fwd.length}`);
      rules.push({ id, group, groupLabel: g.label, delayS, exit: best.x, tuning, validation, requiredHitPct: required, forward: { n: fwd.length, meanPct: fwdMean },
        qualified: reasons.length === 0, reasons });
    }
  }
  rules.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.validation.meanPct - a.validation.meanPct);
  return { version: 1, generatedAt: o.now ?? Date.now(), data: { from: ds.first, to: ds.last, launches: launches.length }, cut, criteria, costs, rules };
}

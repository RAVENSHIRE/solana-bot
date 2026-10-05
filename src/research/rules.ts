import type { Features } from './dataset';
import type { ExitRule } from './direct';

/**
 * The pre-registered call rules: a group of launches (features known at the decision time), a decision time after
 * creation, and an exit (take profit, stop, time limit). The catalog is fixed in code; the qualification job only picks
 * each group's exit on the tuning period and then judges it, unchanged, on a later period it never saw.
 *
 * Only features the live observer knows by the decision time are allowed: trades and curve state, the creation
 * message (dev buy) and the launch's metadata. The X contract-address post is not used yet: the observer reads X at
 * +6 min, so a live rule could not see it at 60–120 s even though a backtest would.
 */
export type GroupId = 'all' | 'ownX' | 'ownXSite' | 'devBuy1' | 'buyers5' | 'broad15' | 'organic' | 'organicX' | 'sprint' | 'sprintBroad';
/** `fast`: the group is judged on FAST_EXITS (short holds, trailing stop) instead of EXITS. */
export interface Group { label: string; minDelayS: number; test: (f: Features) => boolean; fast?: boolean }
const organic = (f: Features) => (f.velocity60 ?? 0) > 0 && (f.effectiveBuyers ?? 0) >= 3 && (f.top1 ?? 1) < 0.5 && f.devSold !== true;
/**
 * Growth speed in the first minutes (the owner's OPEN observation, 3 Oct: GOOP HEAD went $3.4K → $28.9K in 68 s and
 * $105K in the same minute, then died): the curve filling at ≥ 30 % of its length per minute over the last 30 s, or
 * the last minute when known. Such sprints rug soon, so they are tested with the fast, trailing exits below.
 */
export const SPRINT = Object.freeze({ minVelocity: 0.3 });
const sprint = (f: Features) => Math.max(f.velocity30 ?? 0, f.velocity60 ?? 0) >= SPRINT.minVelocity && f.mayhem !== true;
export const GROUPS: Record<GroupId, Group> = {
  all: { label: 'every normal launch', minDelayS: 0, test: () => true },
  ownX: { label: 'own X account in its metadata', minDelayS: 0, test: f => f.hasX === true },
  ownXSite: { label: 'own X account and a website', minDelayS: 0, test: f => f.hasX === true && f.hasSite === true },
  devBuy1: { label: 'dev bought ≥ 1 SOL', minDelayS: 0, test: f => (f.devBuySol ?? 0) >= 1 },
  buyers5: { label: '≥ 5 buyers', minDelayS: 0, test: f => f.buyers >= 5 },
  broad15: { label: '≥ 15 buyers, no wallet over 30 %', minDelayS: 0, test: f => f.buyers >= 15 && (f.top1 ?? 1) < 0.3 },
  organic: { label: 'organic demand: curve rising, ≥ 3 effective buyers, top buyer < 50 %, dev not sold', minDelayS: 60, test: organic },
  organicX: { label: 'organic demand and an own X account', minDelayS: 60, test: f => organic(f) && f.hasX === true },
  sprint: { label: 'sprint: curve filling ≥ 30 %/min in its first minutes', minDelayS: 30, test: sprint, fast: true },
  sprintBroad: { label: 'sprint with ≥ 10 buyers, no wallet over 30 %, dev not sold', minDelayS: 30, fast: true,
    test: f => sprint(f) && f.buyers >= 10 && (f.top1 ?? 1) < 0.3 && f.devSold !== true },
};
export const DELAYS_S = [5, 15, 30, 60, 120] as const;
export const EXITS: ExitRule[] = [];
for (const tpPct of [40, 100]) for (const slPct of [20, 35, null]) for (const maxHoldMin of [15, 60]) EXITS.push({ tpPct, slPct, maxHoldMin });
/** Fast exits for sprints: keep most of the spike (trailing 20 % from the peak) and end early (1 or 3 min at most). */
export const FAST_EXITS: ExitRule[] = [];
for (const tpPct of [40, 100, 200]) for (const maxHoldMin of [1, 3]) FAST_EXITS.push({ tpPct, slPct: 25, maxHoldMin, trailPct: 20 });
export const exitsFor = (group: GroupId): ExitRule[] => GROUPS[group].fast ? FAST_EXITS : EXITS;

export interface RuleSpec { id: string; group: GroupId; delayS: number; exit: ExitRule }
export const ruleId = (group: GroupId, delayS: number, x: ExitRule) => `${group}@${delayS}s/tp${x.tpPct}/sl${x.slPct ?? 'none'}${x.trailPct ? `/tr${x.trailPct}` : ''}/${x.maxHoldMin}m`;
export const describeExit = (x: ExitRule) => `+${x.tpPct}% target · ${x.slPct === null ? 'no stop' : `stop −${x.slPct}%`}${x.trailPct ? ` · trailing −${x.trailPct}% from the peak` : ''} · ${x.maxHoldMin} min max`;

/** Every (group, decision time) pair of the catalog. */
export function groupDelays(): Array<{ group: GroupId; delayS: number }> {
  const out: Array<{ group: GroupId; delayS: number }> = [];
  for (const group of Object.keys(GROUPS) as GroupId[]) for (const delayS of DELAYS_S) if (delayS >= GROUPS[group].minDelayS) out.push({ group, delayS });
  return out;
}

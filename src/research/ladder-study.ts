import { levels, tierOf, type LadderCoinData } from './ladder';
import { TIERS, type TierId } from './fundamentals/levels';

/**
 * What followed each ladder snapshot. One sample per coin per day (consecutive 10-minute snapshots of one coin are not
 * independent), features only from what was known at that moment, and outcomes over the next 24 hours and 7 days:
 * doubled, reached the next decade level, got back to its all-time high, or halved first.
 *
 * Survivorship: a coin that vanishes from every source (rugged, delisted) keeps its sample; it counts as not rising.
 */
export const HORIZONS = { '24h': 24 * 3_600_000, '7d': 7 * 86_400_000 } as const;
export type Horizon = keyof typeof HORIZONS;
/** Old runners coming back: the high is 45+ days old, the coin fell 70 %+ below it, and it is 50 %+ off its 30-day low. */
export const REVIVAL = Object.freeze({ minAthAgeDays: 45, maxLowOfAth: 0.3, minOffLow: 1.5 });

export interface Outcome { maxMcap: number; up2x: boolean; nextLevel: boolean; ath: boolean | null; halvedFirst: boolean; maxRisePct: number; vanished: boolean }
export interface LadderSample {
  key: string; net: string; symbol: string | null; at: number; mcap: number; tier: TierId; level: { below: number; above: number };
  /** From candles recorded before this moment (null until the coin's history was read), raised by any higher snapshot since. */
  athMcap: number | null; drawdownPct: number | null; athAgeDays: number | null; revival: boolean | null;
  holderCh24h: number | null; flow: number | null; organicFlow: number | null; liqRatio: number | null; ageDays: number | null;
  team: number | null; cluster: number | null;
  outcome: Partial<Record<Horizon, Outcome>>;
}

const DAY = 86_400_000;
const ratio = (a: number | null, b: number | null) => a !== null && b !== null && a > 0 && b > 0 ? a / b : null;

export function ladderSamples(data: ReadonlyMap<string, LadderCoinData>, dataEnd: number, everyMs = DAY): LadderSample[] {
  const out: LadderSample[] = [];
  for (const c of data.values()) {
    const snaps = c.snaps.filter(s => (s.mcap ?? 0) > 0), lastSeen = snaps.at(-1)?.at ?? 0;
    let lastSample = -Infinity, seenMax = 0, seenMaxAt = 0;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i]!, mcap = s.mcap!;
      if (mcap > seenMax) { seenMax = mcap; seenMaxAt = s.at; }
      if (s.at - lastSample < everyMs) continue;
      lastSample = s.at;
      const hist = c.histories.filter(h => h.at <= s.at).at(-1) ?? null, held = c.holders.filter(h => h.at <= s.at).at(-1) ?? null;
      const athMcap = hist ? Math.max(hist.athMcap, seenMax) : null, athAt = hist ? (seenMax > hist.athMcap ? seenMaxAt : hist.athAt) : null;
      const athAgeDays = athAt !== null ? (s.at - athAt) / DAY : null;
      const revival = hist && athMcap && hist.low30Mcap ? (athAgeDays ?? 0) >= REVIVAL.minAthAgeDays && hist.low30Mcap <= athMcap * REVIVAL.maxLowOfAth && mcap >= hist.low30Mcap * REVIVAL.minOffLow : null;
      const sample: LadderSample = { key: c.key, net: c.net, symbol: c.symbol, at: s.at, mcap, tier: tierOf(mcap), level: levels(mcap),
        athMcap, drawdownPct: athMcap ? (1 - mcap / athMcap) * 100 : null, athAgeDays, revival,
        holderCh24h: s.holderCh24h, flow: ratio(s.buys1h, s.sells1h), organicFlow: ratio(s.orgBuyVol1h, s.orgSellVol1h), liqRatio: ratio(s.liq, mcap),
        ageDays: s.createdAt ? (s.at - s.createdAt) / DAY : null, team: held?.team ?? null, cluster: held?.clu ?? null, outcome: {} };
      for (const [h, ms] of Object.entries(HORIZONS) as Array<[Horizon, number]>) {
        if (s.at + ms > dataEnd) continue;
        let maxMcap = mcap, upAt: number | null = null, downAt: number | null = null;
        for (let j = i + 1; j < snaps.length && snaps[j]!.at <= s.at + ms; j++) {
          const f = snaps[j]!, m = f.mcap!;
          maxMcap = Math.max(maxMcap, m);
          if (upAt === null && m >= mcap * 2) upAt = f.at;
          if (downAt === null && m <= mcap / 2) downAt = f.at;
        }
        sample.outcome[h] = { maxMcap, up2x: upAt !== null, nextLevel: maxMcap >= sample.level.above, ath: athMcap ? maxMcap >= athMcap : null,
          halvedFirst: downAt !== null && (upAt === null || downAt < upAt), maxRisePct: (maxMcap / mcap - 1) * 100, vanished: lastSeen < s.at + ms * 0.9 };
      }
      out.push(sample);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface CohortRow {
  label: string; n: number; up2xPct: number; nextLevelPct: number; athPct: number | null; halvedFirstPct: number; medianRisePct: number;
  /** The doubling rate in the earlier 60 % and the later 40 % of the samples (by time): a real effect holds in both. */
  earlyUp2xPct: number | null; lateUp2xPct: number | null; vanished: number;
}
export function cohorts(samples: LadderSample[], horizon: Horizon, groups: Array<[string, (s: LadderSample) => boolean]>): CohortRow[] {
  const done = samples.filter(s => s.outcome[horizon]), cut = done[Math.floor(done.length * 0.6)]?.at ?? Infinity;
  const pct = (xs: LadderSample[], f: (o: Outcome) => boolean) => xs.length ? xs.filter(s => f(s.outcome[horizon]!)).length / xs.length * 100 : 0;
  return groups.map(([label, test]) => {
    const xs = done.filter(test), withAth = xs.filter(s => s.outcome[horizon]!.ath !== null), early = xs.filter(s => s.at < cut), late = xs.filter(s => s.at >= cut);
    const rises = xs.map(s => s.outcome[horizon]!.maxRisePct).sort((a, b) => a - b);
    return { label, n: xs.length, up2xPct: pct(xs, o => o.up2x), nextLevelPct: pct(xs, o => o.nextLevel), athPct: withAth.length ? pct(withAth, o => !!o.ath) : null,
      halvedFirstPct: pct(xs, o => o.halvedFirst), medianRisePct: rises.length ? rises[rises.length >> 1]! : 0,
      earlyUp2xPct: early.length ? pct(early, o => o.up2x) : null, lateUp2xPct: late.length ? pct(late, o => o.up2x) : null, vanished: xs.filter(s => s.outcome[horizon]!.vanished).length };
  });
}

/** The cohorts the owner asked about: tiers, distance below the high, holders, flow, revival, team, chains, level position. */
export function ladderGroups(samples: LadderSample[]): Array<[string, Array<[string, (s: LadderSample) => boolean]>]> {
  const nets = [...new Set(samples.map(s => s.net))].sort();
  const dd = (lo: number, hi: number) => (s: LadderSample) => s.drawdownPct !== null && s.drawdownPct >= lo && s.drawdownPct < hi;
  return [
    ['All', [['every sample', () => true]]],
    ['Tier', TIERS.map(t => [`${t.id} (${t.id === 'MICRO' ? '$10K–$100K' : t.label})`, (s: LadderSample) => s.tier === t.id] as [string, (s: LadderSample) => boolean])],
    ['Below the all-time high', [['under 50 %', dd(0, 50)], ['50–80 %', dd(50, 80)], ['80–90 %', dd(80, 90)], ['90 % or more', dd(90, 101)],
      ['mid tier, 80 %+ below (WWW-like)', s => s.tier === 'MID' && (s.drawdownPct ?? 0) >= 80]]],
    ['Position between the levels', [['just above a level (< 1.5×)', s => s.mcap < s.level.below * 1.5], ['middle (1.5–5×)', s => s.mcap >= s.level.below * 1.5 && s.mcap < s.level.below * 5],
      ['near the next level (≥ 5×)', s => s.mcap >= s.level.below * 5]]],
    ['Holders over 24 h (Solana)', [['rising', s => (s.holderCh24h ?? 0) > 0], ['falling', s => s.holderCh24h !== null && s.holderCh24h <= 0]]],
    ['Real (organic) buying vs selling, last hour (Solana)', [['buyers lead', s => (s.organicFlow ?? 0) >= 1], ['sellers lead', s => s.organicFlow !== null && s.organicFlow < 1]]],
    ['Old runner coming back', [['revival', s => s.revival === true], ['no revival', s => s.revival === false]]],
    ['Team and clusters (holder scan)', [['team < 5 %', s => s.team !== null && s.team < 5], ['team 5–20 %', s => s.team !== null && s.team >= 5 && s.team < 20],
      ['team ≥ 20 %', s => (s.team ?? 0) >= 20], ['clusters ≥ 20 %', s => (s.cluster ?? 0) >= 20]]],
    ['Chain', nets.map(n => [n, (s: LadderSample) => s.net === n] as [string, (s: LadderSample) => boolean])],
  ];
}

/**
 * Look-back: what if launches had been bought a few seconds after creation? Every normal launch in the observer's data,
 * a grid of take profits (+40 %, +100 %), stops and time limits, conservative fills and fees (see research/direct.ts);
 * earlier 60 % of launches against the later 40 %, overall and for groups known at the moment of buying. Read-only.
 *
 *   npm run research:direct -- [--dir data-desk/research] [--delays 5,15,30,60,120] [--size 2] [--fixed-usd 0.10] [--fee-pct 1.25] [--sol-usd 118]
 */
import path from 'node:path';
import { blindSpots, features, ledgerFiles, readDataset, type Features, type LaunchFacts } from '../research/dataset';
import { DIRECT_DEFAULTS, directTrades, summarize, type DirectOptions, type ExitRule, type Summary } from '../research/direct';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const RULES: ExitRule[] = [];
for (const tpPct of [40, 100]) for (const slPct of [20, 35, null]) for (const maxHoldMin of [15, 60]) RULES.push({ tpPct, slPct, maxHoldMin });
const rule = (r: ExitRule) => `TP +${r.tpPct}% · ${r.slPct === null ? 'no stop' : `SL −${r.slPct}%`} · ${r.maxHoldMin}m`;
const line = (s: Summary) => `n ${String(s.n).padStart(5)} · TP hit ${s.tpPct.toFixed(0).padStart(3)}% · stop ${s.stopPct.toFixed(0).padStart(3)}% · mean ${s.meanPct.toFixed(1).padStart(6)}% · median ${s.medianPct.toFixed(1).padStart(6)}% · PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : '∞'} · $${s.totalUsd.toFixed(2)}`;

function main(): void {
  const ds = readDataset(ledgerFiles(path.resolve(arg('dir') ?? 'data-desk/research')));
  const delays = (arg('delays') ?? '5,15,30,60,120').split(',').map(Number);
  const base = { ...DIRECT_DEFAULTS, sizeUsd: Number(arg('size') ?? 2), fixedUsd: Number(arg('fixed-usd') ?? 0.10), feePct: Number(arg('fee-pct') ?? DIRECT_DEFAULTS.feePct), solUsd: Number(arg('sol-usd') ?? DIRECT_DEFAULTS.solUsd) };
  const blind = blindSpots(ds), byCreator = new Map<string, LaunchFacts[]>();
  for (const l of [...ds.launches.values()].sort((a, b) => a.createdObs - b.createdObs)) if (l.creator) byCreator.set(l.creator, [...(byCreator.get(l.creator) ?? []), l]);
  console.log(`LOOK-BACK · direct entries · ${new Date(ds.first).toISOString().slice(0, 16)} → ${new Date(ds.last).toISOString().slice(0, 16)} UTC · $${base.sizeUsd} per trade · ` +
    `fee ${base.feePct}% per side + $${base.fixedUsd} per round trip · buy fills at the highest price in the ${base.latencyMs / 1000} s after the decision`);
  for (const delayS of delays) {
    const o: DirectOptions = { ...base, delayS };
    // What was known at the moment of buying (point in time), per launch.
    const known = new Map<string, Features>();
    const featureOf = (l: LaunchFacts) => {
      let f = known.get(l.mint);
      if (!f) {
        const end = l.createdObs + delayS * 1000, earlier = (byCreator.get(l.creator ?? '') ?? []).filter(e => e.createdObs < l.createdObs);
        f = features(l, delayS, { creatorLaunches: earlier.length, creatorGraduations: earlier.filter(e => e.completeObs !== null && e.completeObs <= end).length }, blind);
        known.set(l.mint, f);
      }
      return f;
    };
    const groups: Array<[string, (f: Features) => boolean]> = [
      ['every normal launch', () => true],
      ['own X account in metadata', f => f.hasX === true],
      ['own X account + website', f => f.hasX === true && f.hasSite === true],
      ['dev buy ≥ 1 SOL', f => (f.devBuySol ?? 0) >= 1],
      [`≥ 5 buyers by ${delayS} s`, f => f.buyers >= 5],
      [`≥ 15 buyers by ${delayS} s, top buyer < 30 %`, f => f.buyers >= 15 && (f.top1 ?? 1) < 0.3],
      ...(delayS >= 60 ? [
        ['organic: curve rising, ≥ 3 effective buyers, top buyer < 50 %, dev not sold', (f: Features) => (f.velocity60 ?? 0) > 0 && (f.effectiveBuyers ?? 0) >= 3 && (f.top1 ?? 1) < 0.5 && f.devSold !== true],
        ['own X account posted this CA', (f: Features) => f.xCaPost === true],
      ] as Array<[string, (f: Features) => boolean]> : []),
    ];
    console.log(`\n== BUY ${delayS} s AFTER CREATION`);
    for (const [label, test] of groups) {
      const runs = RULES.map(r => {
        const all = directTrades(ds, r, o, l => test(featureOf(l)));
        const cut = all[Math.floor(all.length * 0.6)]?.createdObs ?? Infinity;
        return { r, all, d: summarize(all.filter(t => t.createdObs < cut), o.sizeUsd), v: summarize(all.filter(t => t.createdObs >= cut), o.sizeUsd) };
      });
      const best = [...runs].sort((a, b) => b.d.meanPct - a.d.meanPct)[0]!;
      const reach = (k: number) => best.all.length ? (best.all.filter(t => t.peakPct >= k).length / best.all.length * 100).toFixed(0) : '–';
      console.log(`  ${label}`);
      console.log(`    best on the earlier 60 %: ${rule(best.r)}\n      earlier ${line(best.d)}\n      later   ${line(best.v)}`);
      console.log(`    reached +40 % at some point ${reach(40)} % · +100 % ${reach(100)} % (of ${best.all.length}, before its exit)`);
      if (label === 'every normal launch') {
        const top = [...best.all].sort((a, b) => b.netPct - a.netPct).slice(0, 5);
        for (const t of top) console.log(`      ${(t.symbol ?? t.mint.slice(0, 6)).slice(0, 12).padEnd(12)} ${new Date(t.createdObs).toISOString().slice(11, 16)} UTC · in ${t.entryMcap.toFixed(0)} SOL mcap → ${t.reason} ${t.netPct.toFixed(0)}%`);
      }
    }
  }
}

main();

/**
 * GOLDEN POCKET backtest on every pump.fun graduation of the last hours: the break and retest (66hK2: $163K → $107K →
 * $224K → $146K → $642K) and the only-up variant, over a grid of pattern and exit rules, judged by the weaker of two
 * time halves. Shares the CRASH backtest's cache. Read-only.
 *
 *   npm run desk:golden -- [--env-dir .] [--hours 12] [--cache data-desk/backtest-cache] [--size 2] [--fixed-usd 0.02]
 *     [--gecko-ms 4000] [--max-pools N] [--cached-only] [--mints A,B] [--out golden.json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { deskEnvironment } from '../desk/runtime';
import { capSeries, pocketTrade, summarize, type Costs, type PocketExit, type PoolSeries, type SimTrade, type Summary } from '../desk/backtest';
import { pocketState, pocketStep, type PocketEntry, type PocketRules } from '../desk/golden-pocket';
import { backtestData } from './backtest-data';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const hours = Number(arg('hours') ?? 12);
const sizeUsd = Number(arg('size') ?? 2);
const fixedUsd = Number(arg('fixed-usd') ?? 0.02);
const maxPools = Number(arg('max-pools') ?? Infinity);
const minVolume24hUsd = Number(arg('min-volume') ?? 5_000);
const MINUTE = 60_000;
const { graduations, pools, candles } = backtestData({ cacheDir: path.resolve(arg('cache') ?? 'data-desk/backtest-cache'), hours,
  geckoMs: Number(arg('gecko-ms') ?? 4_000), cachedOnly: process.argv.includes('--cached-only'), refreshPools: process.argv.includes('--refresh-pools') });

// ------------------------------------------------------------------ grids

const retest = (p: Partial<PocketRules>): PocketRules => ({ retest: true, dipMinPct: 20, dipMaxPct: 60, breakoutOverHigh: 1.25, zone: 'RESISTANCE', resistanceBelowPct: 12,
  resistanceAbovePct: 3, fibTop: 0.5, fibBottom: 0.65, stopBelowPct: 7.5, retestWindowMin: 30, maxPatternMin: 120, onlyUp: null, floorUsd: 0, ...p });
const onlyUp = (u: NonNullable<PocketRules['onlyUp']>, maxPatternMin = 60): PocketRules => ({ ...retest({ retest: false, maxPatternMin }), onlyUp: u });

function entryGrid(): Array<{ rules: PocketRules; minVolumeUsd: number }> {
  const out: Array<{ rules: PocketRules; minVolumeUsd: number }> = [];
  const zones: Array<Partial<PocketRules>> = [{ zone: 'RESISTANCE' }, { zone: 'FIB', fibTop: 0.5, fibBottom: 0.65 }, { zone: 'FIB', fibTop: 0.618, fibBottom: 0.65 },
    { zone: 'EITHER', fibTop: 0.5, fibBottom: 0.65 }];
  for (const dipMinPct of [15, 25]) for (const dipMaxPct of [50, 70]) for (const breakoutOverHigh of [1.1, 1.25, 1.4]) for (const z of zones)
    for (const stopBelowPct of [5, 10]) for (const retestWindowMin of [20, 60]) for (const maxPatternMin of [60, 180]) for (const minVolumeUsd of [0, 30_000])
      out.push({ rules: retest({ dipMinPct, dipMaxPct, breakoutOverHigh, ...z, stopBelowPct, retestWindowMin, maxPatternMin }), minVolumeUsd });
  for (const bars of [2, 3]) for (const ref of [1, 2]) for (const chasePct of [5, 12, 20]) for (const windowMin of [10, 30]) for (const stopBelowPct of [5, 10])
    for (const minVolumeUsd of [0, 30_000]) out.push({ rules: onlyUp({ bars, ref, chasePct, windowMin, stopBelowPct }), minVolumeUsd });
  return out;
}
function exitGrid(): PocketExit[] {
  const out: PocketExit[] = [];
  const trails = [{ activationPct: 20, stopPct: 15 }, { activationPct: 30, stopPct: 20 }, { activationPct: 50, stopPct: 25 }, { activationPct: 100, stopPct: 35 }, { activationPct: 200, stopPct: 40 }];
  for (const trailing of trails) for (const maxHoldMin of [60, 240, 720]) out.push({ mode: 'TRAIL', trailing, belowResistancePct: 0, maxHoldMin });
  for (const belowResistancePct of [5, 10]) for (const maxHoldMin of [60, 240]) out.push({ mode: 'RESISTANCE', trailing: null, belowResistancePct, maxHoldMin });
  for (const belowResistancePct of [5, 10]) for (const trailing of trails.slice(2, 4)) out.push({ mode: 'SPLIT', trailing, belowResistancePct, maxHoldMin: 240 });
  return out;
}
const pct = (v: number) => `${v}%`;
const describeEntry = (e: { rules: PocketRules; minVolumeUsd: number }) => {
  const r = e.rules, vol = e.minVolumeUsd ? ` · vol≥$${e.minVolumeUsd / 1000}K` : '';
  if (r.onlyUp) return `ONLY_UP ${r.onlyUp.bars} green · ≤+${r.onlyUp.chasePct}% of candle ${r.onlyUp.ref} within ${r.onlyUp.windowMin}m · stop −${r.onlyUp.stopBelowPct}%${vol}`;
  const zone = r.zone === 'RESISTANCE' ? `old high −${r.resistanceBelowPct}%..+${r.resistanceAbovePct}%` : r.zone === 'FIB' ? `fib ${r.fibTop}–${r.fibBottom}` : `either (high −${r.resistanceBelowPct}% / fib ${r.fibTop}–${r.fibBottom})`;
  return `RETEST dip ${pct(r.dipMinPct)}–${pct(r.dipMaxPct)} · breakout ×${r.breakoutOverHigh} · ${zone} · stop −${r.stopBelowPct}% · retest ≤${r.retestWindowMin}m · pattern ≤${r.maxPatternMin}m${vol}`;
};
const describeExit = (x: PocketExit) => x.mode === 'RESISTANCE' ? `sell all ${x.belowResistancePct}% under the resistance · ${x.maxHoldMin}m`
  : `${x.mode === 'SPLIT' ? `half ${x.belowResistancePct}% under the resistance, half ` : ''}trail ${x.trailing!.stopPct}% after +${x.trailing!.activationPct}% · ${x.maxHoldMin}m`;

// ------------------------------------------------------------------ run

/** The first fill of a pattern in one pool, with the volume traded from the pool's start to the fill. */
function firstEntry(s: PoolSeries, rules: PocketRules): (PocketEntry & { volumeUsd: number }) | null {
  const state = pocketState(s.candles[0]!.t);
  let volumeUsd = 0;
  for (const bar of s.candles) {
    const e = pocketStep(state, rules, bar);
    if (e) return { ...e, volumeUsd };
    volumeUsd += (bar as { v?: number }).v ?? 0;
    if (state.phase === 'FAILED' || state.phase === 'EXPIRED') return null;
  }
  return null;
}

interface Result { entry: { rules: PocketRules; minVolumeUsd: number }; exit: PocketExit; all: Summary; first: Summary; second: Summary; score: number; trades: SimTrade[] }
const row = (r: Result) => `n ${String(r.all.trades).padStart(3)} · win ${r.all.winRatePct.toFixed(0).padStart(2)}% · mean ${r.all.meanPct.toFixed(1).padStart(6)}% · median ${r.all.medianPct.toFixed(1).padStart(6)}%` +
  ` · PF ${Number.isFinite(r.all.profitFactor) ? r.all.profitFactor.toFixed(2) : '∞'} · total $${r.all.totalUsd.toFixed(2).padStart(6)} · best ${r.all.bestPct.toFixed(0)}% · halves ${r.first.meanPct.toFixed(1)}% (${r.first.trades}) / ${r.second.meanPct.toFixed(1)}% (${r.second.trades})`;

async function main(): Promise<void> {
  const env = await deskEnvironment(path.resolve(arg('env-dir') ?? '.'));
  const endpoint = (env.RPC_ENDPOINTS ?? 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).find(s => /^https?:\/\//.test(s)) ?? 'https://api.mainnet-beta.solana.com';
  const grads = await graduations(new Connection(endpoint, 'confirmed'));
  const watch = (arg('mints') ?? '').split(',').map(m => m.trim()).filter(Boolean);
  const info = await pools([...new Set([...grads.map(g => g.mint), ...watch])]);
  const hash = (a: string) => [...a].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const active = info.filter(p => !watch.includes(p.mint) && p.volume24hUsd >= minVolume24hUsd && p.createdAt >= Date.now() - (hours + 1) * 3_600_000)
    .sort((a, b) => hash(a.pool) - hash(b.pool)).slice(0, maxPools);
  console.log(`pools: ${info.length} graduated tokens with a pool, ${active.length} with ≥ $${minVolume24hUsd / 1000}K 24h volume; loading candles…`);
  const spanMin = 180 + 720;
  const series: PoolSeries[] = [];
  const load = async (p: (typeof info)[number], latest = false) => {
    const k = await candles(p, latest ? Math.min(990, Math.ceil((Date.now() - p.createdAt) / MINUTE) + 5) : spanMin, latest);
    return k.length >= 5 && p.marketCapUsd > 0 ? capSeries({ mint: p.mint, symbol: p.symbol, pool: p.pool, createdAt: p.createdAt, supply: p.marketCapUsd / p.priceUsd,
      liquidityRefUsd: p.liquidityUsd, priceRef: p.priceUsd, candles: k }) : null;
  };
  for (const [i, p] of active.entries()) {
    const s = await load(p);
    if (s) series.push(s);
    if ((i + 1) % 50 === 0) console.log(`  candles ${i + 1}/${active.length}`);
  }
  const split = [...series].sort((a, b) => a.createdAt - b.createdAt)[Math.floor(series.length / 2)]?.createdAt ?? 0;
  const costs: Costs = { sizeUsd, venueFeePct: 0.3, fixedUsd, stopSlipPct: 3 };
  console.log(`\n${series.length} pools with candles · ${new Date(Math.min(...series.map(s => s.createdAt))).toISOString()} → ${new Date(Math.max(...series.map(s => s.createdAt))).toISOString()}` +
    ` · split ${new Date(split).toISOString()} · $${sizeUsd} per trade, ${costs.venueFeePct}% venue fee per side, $${fixedUsd} fixed, ${costs.stopSlipPct}% stop slippage`);

  const entries = new Map<string, Array<{ s: PoolSeries; e: PocketEntry & { volumeUsd: number } }>>();
  const entriesOf = (e: { rules: PocketRules; minVolumeUsd: number }) => {
    const key = JSON.stringify(e.rules);
    if (!entries.has(key)) entries.set(key, series.flatMap(s => { const x = firstEntry(s, e.rules); return x ? [{ s, e: x }] : []; }));
    return entries.get(key)!.filter(x => x.e.volumeUsd >= e.minVolumeUsd);
  };
  const run = (entry: { rules: PocketRules; minVolumeUsd: number }, exit: PocketExit): Result => {
    const trades = entriesOf(entry).map(({ s, e }) => pocketTrade(s, e, exit, costs));
    const first = summarize(trades.filter(t => t.entryAt < split)), second = summarize(trades.filter(t => t.entryAt >= split));
    const score = first.trades >= 6 && second.trades >= 6 ? Math.min(first.meanPct, second.meanPct) : -Infinity;
    return { entry, exit, all: summarize(trades), first, second, score, trades };
  };

  // Baseline: the same exits on every pool bought 10 minutes after graduation (does the pattern add anything?).
  const baseline = (x: PocketExit) => summarize(series.flatMap(s => {
    const bar = s.candles.find(k => k.t >= s.candles[0]!.t + 10 * MINUTE);
    if (!bar) return [];
    return [pocketTrade(s, { at: bar.t, price: bar.o, stop: bar.o * 0.7, resistance: Math.max(...s.candles.filter(k => k.t < bar.t).map(k => k.h)) }, x, costs)];
  }));

  // The owner's rules as stated: retest of the old high down to 12 % under it, stop 5–10 % below; only-up within 12 % of candle 1 / 2.
  const owner: Array<[string, { rules: PocketRules; minVolumeUsd: number }]> = [
    ['retest, stop −5%', { rules: retest({ stopBelowPct: 5 }), minVolumeUsd: 0 }], ['retest, stop −10%', { rules: retest({ stopBelowPct: 10 }), minVolumeUsd: 0 }],
    ['only up, candle 1', { rules: onlyUp({ bars: 2, ref: 1, chasePct: 12, windowMin: 30, stopBelowPct: 7.5 }), minVolumeUsd: 0 }],
    ['only up, candle 2', { rules: onlyUp({ bars: 2, ref: 2, chasePct: 12, windowMin: 30, stopBelowPct: 7.5 }), minVolumeUsd: 0 }]];
  const ownerExits: PocketExit[] = [{ mode: 'TRAIL', trailing: { activationPct: 50, stopPct: 25 }, belowResistancePct: 0, maxHoldMin: 240 },
    { mode: 'RESISTANCE', trailing: null, belowResistancePct: 5, maxHoldMin: 240 }, { mode: 'RESISTANCE', trailing: null, belowResistancePct: 10, maxHoldMin: 240 },
    { mode: 'SPLIT', trailing: { activationPct: 50, stopPct: 25 }, belowResistancePct: 7.5, maxHoldMin: 240 }];
  console.log('\nOWNER\'S RULES (pattern ≤120m, dip 20–60%, breakout ×1.25, retest ≤30m):');
  for (const [label, e] of owner) for (const x of ownerExits) console.log(`  ${label.padEnd(18)} | ${describeExit(x).padEnd(58)} ${row(run(e, x))}`);
  console.log('\nBASELINE (every pool bought 10 min after graduation, stop −30%):');
  for (const x of ownerExits) { const b = baseline(x); console.log(`  ${describeExit(x).padEnd(58)} n ${b.trades} · win ${b.winRatePct.toFixed(0)}% · mean ${b.meanPct.toFixed(1)}% · median ${b.medianPct.toFixed(1)}% · PF ${b.profitFactor.toFixed(2)}`); }

  const grid = entryGrid(), exits = exitGrid();
  const results: Result[] = [];
  for (const e of grid) for (const x of exits) { const r = run(e, x); if (r.all.trades) results.push({ ...r, trades: r.score > -Infinity ? r.trades : [] }); }
  results.sort((a, b) => b.score - a.score);
  for (const kind of ['RETEST', 'ONLY_UP']) {
    const top = results.filter(r => (kind === 'ONLY_UP') === !!r.entry.rules.onlyUp && r.score > -Infinity).slice(0, 12);
    console.log(`\nTOP ${kind} by the weaker time half (${grid.filter(e => (kind === 'ONLY_UP') === !!e.rules.onlyUp).length} pattern rules × ${exits.length} exits):`);
    for (const r of top) console.log(`  ${describeEntry(r.entry)} | ${describeExit(r.exit)}\n    ${row(r)}`);
    const best = top[0];
    if (!best) continue;
    const byReason = new Map<string, number>();
    for (const t of best.trades) byReason.set(t.reason, (byReason.get(t.reason) ?? 0) + 1);
    console.log(`  BEST ${kind} exits: ${[...byReason].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const t of [...best.trades].sort((a, b) => a.entryAt - b.entryAt)) {
      console.log(`    ${new Date(t.entryAt).toISOString().slice(5, 16)} ${(t.symbol ?? t.mint.slice(0, 6)).slice(0, 12).padEnd(12)} at $${(t.entryPrice / 1000).toFixed(0).padStart(4)}K ${t.reason.padEnd(26)} peak +${t.peakPct.toFixed(0).padStart(5)}% · net ${t.returnPct.toFixed(1).padStart(6)}%`);
    }
  }

  // Tokens named on the command line: the pattern each rule set saw and the trade it made.
  const bestOf = (kind: boolean) => results.find(r => !!r.entry.rules.onlyUp === kind && r.score > -Infinity);
  for (const mint of watch) {
    const p = info.find(x => x.mint === mint);
    const s = p ? await load(p, true) : null;
    if (!p || !s) { console.log(`\nWATCH ${mint}: no pool or candles`); continue; }
    const peak = Math.max(...s.candles.map(k => k.h));
    console.log(`\nWATCH ${p.symbol ?? mint} · ${p.dex} pool ${new Date(p.createdAt).toISOString()} · ${s.candles.length} candles · first $${(s.candles[0]!.o / 1000).toFixed(0)}K · peak $${(peak / 1000).toFixed(0)}K`);
    const runs: Array<[string, { rules: PocketRules; minVolumeUsd: number } | undefined, PocketExit | undefined]> = [
      ...owner.map(([l, e]) => [l, e, ownerExits[0]] as [string, typeof e, PocketExit]), ['best retest', bestOf(false)?.entry, bestOf(false)?.exit], ['best only-up', bestOf(true)?.entry, bestOf(true)?.exit]];
    for (const [label, e, x] of runs) {
      if (!e || !x) continue;
      const state = pocketState(s.candles[0]!.t);
      let fill: PocketEntry | null = null;
      for (const bar of s.candles) { fill = pocketStep(state, e.rules, bar); if (fill || state.phase === 'FAILED' || state.phase === 'EXPIRED') break; }
      const t = fill ? pocketTrade(s, fill, x, costs) : null;
      const at = (v: number) => new Date(v).toISOString().slice(11, 16);
      console.log(`  ${label.padEnd(16)} ${state.detail}${t ? ` → ${t.reason} ${at(t.exitAt)} at $${(t.exitPrice / 1000).toFixed(0)}K · net ${t.returnPct.toFixed(0)}% (peak +${t.peakPct.toFixed(0)}%)` : ''}`);
    }
  }
  const out = arg('out');
  if (out) await fs.writeFile(path.resolve(out), JSON.stringify({ generatedAt: new Date().toISOString(), hours, costs, pools: series.length, split,
    top: results.filter(r => r.score > -Infinity).slice(0, 80).map(({ trades, ...r }) => ({ ...r, trades: trades.length, describe: `${describeEntry(r.entry)} | ${describeExit(r.exit)}` })) },
    (_k, v) => v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v, 2));
}

main().catch(error => { console.error(`desk:golden failed: ${(error as Error).message}`); process.exitCode = 1; });

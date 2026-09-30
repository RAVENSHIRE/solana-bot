/**
 * CRASH backtest on every pump.fun graduation of the last hours (read from the chain), with GeckoTerminal minute
 * candles. Searches entry and exit rules, validates on two time halves, and prints the best robust rules next to
 * the current ones. Everything downloaded is cached, so a rerun gives the same numbers. Read-only: it never signs,
 * submits or loads a private key (only RPC_ENDPOINTS is read from .env, through the desk allowlist).
 *
 *   npm run desk:backtest -- [--env-dir .] [--hours 18] [--cache data-desk/backtest-cache] [--size 2]
 *     [--fixed-usd 0.02] [--current-fixed-usd 0.22] [--out backtest.json] [--refresh-pools] [--mints A,B]
 *     [--gecko-ms 6000] [--max-pools N]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Connection, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { CRASH_DEFAULTS, CRASH_ENTRY, type ExitRules } from '../desk/config';
import { graduatedMint, migrationTx, PUMP_MIGRATION_AUTHORITY } from '../desk/migrations';
import { deskEnvironment } from '../desk/runtime';
import { signals, simulatePool, summarize, type Costs, type EntryRule, type PoolSeries, type Signal, type SimTrade, type Summary, type VCandle } from '../desk/backtest';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const hours = Number(arg('hours') ?? 18);
const cacheDir = path.resolve(arg('cache') ?? 'data-desk/backtest-cache');
const sizeUsd = Number(arg('size') ?? 2);
const fixedUsd = Number(arg('fixed-usd') ?? 0.02);
const currentFixedUsd = Number(arg('current-fixed-usd') ?? 0.22);
/** GeckoTerminal's public limit is shared with a running desk on the same IP: stay well below it. */
const geckoMs = Number(arg('gecko-ms') ?? 6_000);
const maxPools = Number(arg('max-pools') ?? Infinity);
const MINUTE = 60_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function readJson<T>(file: string): Promise<T | null> { try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; } }
async function writeJson(file: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= 6) throw new Error(`${label}: ${(error as Error).message.slice(0, 120)}`);
      await sleep(2_000 * 2 ** Math.min(attempt, 4));
    }
  }
}

/** Every graduation in the window, from the migration authority's signatures and each transaction's balances. */
async function graduations(rpc: Connection): Promise<Array<{ mint: string; at: number }>> {
  const file = path.join(cacheDir, 'graduations.json');
  const known = (await readJson<Record<string, { mint: string | null; at: number }>>(file)) ?? {};
  const since = Date.now() - hours * 3_600_000, sigs: ConfirmedSignatureInfo[] = [];
  for (let before: string | undefined; ;) {
    const page = await retry('signatures', () => rpc.getSignaturesForAddress(PUMP_MIGRATION_AUTHORITY, { before, limit: 1000 }, 'confirmed'));
    const inside = page.filter(s => s.blockTime && s.blockTime * 1000 >= since);
    sigs.push(...inside.filter(s => !s.err));
    if (!page.length || inside.length < page.length) break;
    before = page.at(-1)!.signature;
  }
  const todo = sigs.filter(s => !(s.signature in known));
  console.log(`graduations: ${sigs.length} migration-authority transactions in ${hours} h, ${todo.length} to read`);
  let done = 0;
  const worker = async () => {
    for (let s = todo.shift(); s; s = todo.shift()) {
      const tx = await retry('transaction', () => migrationTx(rpc, s.signature));
      known[s.signature] = { mint: graduatedMint(tx), at: s.blockTime! * 1000 };
      if (++done % 100 === 0) { console.log(`  ${done} read`); await writeJson(file, known); }
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));
  await writeJson(file, known);
  const out = new Map<string, number>();
  for (const s of sigs) { const g = known[s.signature]; if (g?.mint && !out.has(g.mint)) out.set(g.mint, g.at); }
  return [...out].map(([mint, at]) => ({ mint, at }));
}

interface PoolInfo { mint: string; symbol: string | null; pool: string; dex: string; createdAt: number; priceUsd: number; liquidityUsd: number; marketCapUsd: number; volume24hUsd: number }
type DexPair = { pairAddress: string; dexId: string; baseToken: { address: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number };
  marketCap?: number; fdv?: number; volume?: { h24?: number }; pairCreatedAt?: number };

/** Each graduated token's PumpSwap pool, depth and 24 h volume (DexScreener, 30 tokens per request). */
async function pools(mints: string[]): Promise<PoolInfo[]> {
  const file = path.join(cacheDir, 'pools.json');
  const known = process.argv.includes('--refresh-pools') ? {} : (await readJson<Record<string, PoolInfo | null>>(file)) ?? {};
  const todo = mints.filter(m => !(m in known));
  for (let i = 0; i < todo.length; i += 30) {
    const chunk = todo.slice(i, i + 30);
    const pairs = await retry('dexscreener', async () => {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as DexPair[];
    });
    for (const mint of chunk) {
      const own = pairs.filter(p => p.baseToken.address === mint);
      const p = own.find(x => x.dexId === 'pumpswap') ?? own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      known[mint] = p && p.priceUsd && p.liquidity?.usd && p.pairCreatedAt ? { mint, symbol: p.baseToken.symbol ?? null, pool: p.pairAddress, dex: p.dexId,
        createdAt: p.pairCreatedAt, priceUsd: Number(p.priceUsd), liquidityUsd: p.liquidity.usd, marketCapUsd: p.marketCap ?? p.fdv ?? 0, volume24hUsd: p.volume?.h24 ?? 0 } : null;
    }
    await sleep(250);
  }
  await writeJson(file, known);
  return mints.map(m => known[m]).filter((p): p is PoolInfo => !!p);
}

let lastGecko = 0;
/** Minute candles from pool creation until every entry window and hold could have ended. */
async function candles(p: PoolInfo, spanMin: number, latest = false): Promise<VCandle[]> {
  // Rounded to 10 minutes, so reruns hit the same cache entries.
  const now = Math.floor(Date.now() / 600_000) * 600_000;
  const before = Math.floor((latest ? now : Math.min(p.createdAt + spanMin * MINUTE, now)) / 1000), limit = Math.min(1000, spanMin + 5);
  const file = path.join(cacheDir, 'ohlcv', `${p.pool}-${before}-${limit}.json`);
  let list = await readJson<number[][]>(file);
  if (!list) {
    for (let attempt = 0; !list; attempt++) {
      await sleep(Math.max(0, lastGecko + geckoMs - Date.now())); lastGecko = Date.now();
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.pool}/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd&token=base&before_timestamp=${before}&include_empty_intervals=false`,
        { headers: { accept: 'application/json' } }).catch(() => null);
      if (res?.status === 404) list = [];
      else if (res?.ok) list = (await res.json() as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list;
      // Rate limited: back off for a while instead of spending the shared budget on retries.
      else if (attempt >= 8) throw new Error(`geckoterminal: HTTP ${res?.status ?? 'network error'} for ${p.pool}`);
      else await sleep(res?.status === 429 ? 20_000 * (attempt + 1) : 5_000);
    }
    await writeJson(file, list);
  }
  return list.map(([t, o, h, l, c, v]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 })).filter(k => k.t >= p.createdAt - MINUTE).sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ search

const current: EntryRule = { maxPoolAgeMin: CRASH_ENTRY.maxPoolAgeMin, minChange5mPct: CRASH_ENTRY.minPriceChange5mPct, maxChange5mPct: CRASH_ENTRY.maxPriceChange5mPct,
  minVolume5mUsd: CRASH_ENTRY.minVolume5mUsd, minLiquidityUsd: CRASH_ENTRY.minLiquidityUsd, minLiquidityToMarketCap: CRASH_ENTRY.minLiquidityToMarketCap,
  maxMarketCapUsd: Infinity, pullbackPct: 0, pullbackWindowMin: 0 };
const c = CRASH_DEFAULTS;
const quick: ExitRules = { takeProfitPct: c.takeProfitPct, stopLossPct: c.stopLossPct, maxHoldMin: c.maxHoldMin, trailing: null, giveback: { lockPeakPct: c.lockPeakPct, points: c.givebackPts } };
const ride: ExitRules = { takeProfitPct: Infinity, stopLossPct: c.stopLossPct, maxHoldMin: c.rideMaxHoldMin, trailing: { activationPct: c.rideTrailActivationPct, stopPct: c.rideTrailStopPct }, giveback: null };

function entryGrid(): EntryRule[] {
  const out: EntryRule[] = [];
  for (const maxPoolAgeMin of [15, 30, 60]) for (const [lo, hi] of [[10, 200], [10, 30], [10, 60], [20, 100], [30, 200], [50, 200]] as const)
    for (const minVolume5mUsd of [20_000, 50_000]) for (const maxMarketCapUsd of [Infinity, 300_000, 150_000])
      for (const [pullbackPct, pullbackWindowMin] of [[0, 0], [10, 10], [20, 15]] as const)
        out.push({ ...current, maxPoolAgeMin, minChange5mPct: lo, maxChange5mPct: hi, minVolume5mUsd, maxMarketCapUsd, pullbackPct, pullbackWindowMin });
  return out;
}
function exitGrid(): ExitRules[] {
  const out: ExitRules[] = [];
  for (const stopLossPct of [10, 15, 20, 25, 35, 50]) for (const takeProfitPct of [30, 50, 100, 200, Infinity])
    for (const trailing of [null, { activationPct: 20, stopPct: 15 }, { activationPct: 30, stopPct: 20 }, { activationPct: 50, stopPct: 35 }, { activationPct: 100, stopPct: 40 }])
      for (const giveback of [null, { lockPeakPct: 40, points: 15 }]) for (const maxHoldMin of [4, 10, 20, 45, 90])
        out.push({ takeProfitPct, stopLossPct, maxHoldMin, trailing, giveback });
  return out;
}
const describeEntry = (e: EntryRule) => `age≤${e.maxPoolAgeMin}m · 5m ${e.minChange5mPct}..${e.maxChange5mPct}% · vol5m≥$${e.minVolume5mUsd / 1000}K` +
  `${Number.isFinite(e.maxMarketCapUsd) ? ` · mcap≤$${e.maxMarketCapUsd / 1000}K` : ''}${e.pullbackPct ? ` · pullback ${e.pullbackPct}% within ${e.pullbackWindowMin}m` : ''}`;
const describeExit = (x: ExitRules) => `SL ${x.stopLossPct}% · TP ${Number.isFinite(x.takeProfitPct) ? `+${x.takeProfitPct}%` : 'none'}` +
  `${x.trailing ? ` · trail ${x.trailing.stopPct}% after +${x.trailing.activationPct}%` : ''}${x.giveback ? ` · lock ${x.giveback.points}pts after +${x.giveback.lockPeakPct}%` : ''} · ${x.maxHoldMin}m`;

interface Result { entry: EntryRule; exit: ExitRules; all: Summary; first: Summary; second: Summary; score: number; trades: SimTrade[] }
const signalCache = new Map<string, Map<string, Signal[]>>();
function run(series: PoolSeries[], split: number, entry: EntryRule, exit: ExitRules, costs: Costs): Result {
  const key = JSON.stringify(entry), cache = signalCache.get(key) ?? new Map<string, Signal[]>();
  signalCache.set(key, cache);
  const trades = series.flatMap(s => {
    if (!cache.has(s.pool)) cache.set(s.pool, signals(s, entry));
    return simulatePool(s, entry, exit, costs, c.reentryMin, undefined, cache.get(s.pool));
  });
  const first = summarize(trades.filter(t => t.entryAt < split)), second = summarize(trades.filter(t => t.entryAt >= split));
  // Robust: judged by the weaker half, and only with enough trades in both.
  const score = first.trades >= 8 && second.trades >= 8 ? Math.min(first.meanPct, second.meanPct) : -Infinity;
  return { entry, exit, all: summarize(trades), first, second, score, trades };
}
const row = (r: Result) => `n ${String(r.all.trades).padStart(3)} · win ${r.all.winRatePct.toFixed(0).padStart(2)}% · mean ${r.all.meanPct.toFixed(1).padStart(6)}% · median ${r.all.medianPct.toFixed(1).padStart(6)}%` +
  ` · PF ${Number.isFinite(r.all.profitFactor) ? r.all.profitFactor.toFixed(2) : '∞'} · total $${r.all.totalUsd.toFixed(2).padStart(6)} · halves ${r.first.meanPct.toFixed(1)}% (${r.first.trades}) / ${r.second.meanPct.toFixed(1)}% (${r.second.trades})`;

async function main(): Promise<void> {
  const env = await deskEnvironment(path.resolve(arg('env-dir') ?? '.'));
  const endpoint = (env.RPC_ENDPOINTS ?? 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).find(s => /^https?:\/\//.test(s)) ?? 'https://api.mainnet-beta.solana.com';
  const rpc = new Connection(endpoint, 'confirmed');
  const grads = await graduations(rpc);
  const watch = (arg('mints') ?? '').split(',').map(m => m.trim()).filter(Boolean);
  const info = await pools([...new Set([...grads.map(g => g.mint), ...watch])]);
  // A CRASH signal needs ≥ $20K in five minutes, so a token below that in 24 h could never have signalled (no survivorship filter).
  // A fixed pseudo-random order (by pool address hash): a run cut short by --max-pools is still an unbiased sample.
  const hash = (a: string) => [...a].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const active = info.filter(p => p.volume24hUsd >= CRASH_ENTRY.minVolume5mUsd && p.createdAt >= Date.now() - (hours + 1) * 3_600_000)
    .sort((a, b) => hash(a.pool) - hash(b.pool)).slice(0, maxPools);
  console.log(`pools: ${info.length} graduated tokens with a pool, ${active.length} with ≥ $${CRASH_ENTRY.minVolume5mUsd / 1000}K 24h volume; loading candles…`);
  const spanMin = 60 + 95;
  const series: PoolSeries[] = [];
  for (const [i, p] of active.entries()) {
    const k = await candles(p, spanMin);
    if (k.length >= 3 && p.marketCapUsd > 0) series.push({ mint: p.mint, symbol: p.symbol, pool: p.pool, createdAt: p.createdAt, supply: p.marketCapUsd / p.priceUsd,
      liquidityRefUsd: p.liquidityUsd, priceRef: p.priceUsd, candles: k });
    if ((i + 1) % 50 === 0) console.log(`  candles ${i + 1}/${active.length}`);
  }
  const split = [...series].sort((a, b) => a.createdAt - b.createdAt)[Math.floor(series.length / 2)]?.createdAt ?? 0;
  const costs: Costs = { sizeUsd, venueFeePct: 0.3, fixedUsd, stopSlipPct: 3 };
  console.log(`\n${series.length} pools with candles · ${new Date(Math.min(...series.map(s => s.createdAt))).toISOString()} → ${new Date(Math.max(...series.map(s => s.createdAt))).toISOString()}` +
    ` · split ${new Date(split).toISOString()} · $${sizeUsd} per trade, ${costs.venueFeePct}% venue fee per side, $${fixedUsd} fixed per trade, ${costs.stopSlipPct}% stop slippage`);

  const now = { quick: run(series, split, current, quick, costs), ride: run(series, split, current, ride, costs) };
  const nowCosts = run(series, split, current, quick, { ...costs, fixedUsd: currentFixedUsd });
  console.log(`\nCURRENT rules (${describeEntry(current)})`);
  console.log(`  QUICK ${describeExit(quick)}\n    ${row(now.quick)}`);
  console.log(`  RIDE  ${describeExit(ride)}\n    ${row(now.ride)}`);
  console.log(`  QUICK with today's costs ($${currentFixedUsd} per trade: full exit priority fee, rent never reclaimed)\n    ${row(nowCosts)}`);

  const stageA = entryGrid().flatMap(e => [run(series, split, e, quick, costs), run(series, split, e, ride, costs)]);
  const bestEntries = [...new Map(stageA.sort((a, b) => b.score - a.score).map(r => [describeEntry(r.entry), r.entry])).values()].slice(0, 8);
  const stageB = bestEntries.flatMap(e => exitGrid().map(x => run(series, split, e, x, costs))).sort((a, b) => b.score - a.score);
  console.log('\nTOP rules by the weaker time half (entry grid × exit grid; b/s ratio and holder gates not modelled):');
  for (const r of stageB.slice(0, 15)) console.log(`  ${describeEntry(r.entry)} | ${describeExit(r.exit)}\n    ${row(r)}`);
  const best = stageB[0];
  if (best) {
    console.log(`\nBEST: ${describeEntry(best.entry)} | ${describeExit(best.exit)}`);
    const byReason = new Map<string, number>();
    for (const t of best.trades) byReason.set(t.reason, (byReason.get(t.reason) ?? 0) + 1);
    console.log(`  exits: ${[...byReason].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const t of [...best.trades].sort((a, b) => a.entryAt - b.entryAt)) {
      console.log(`  ${new Date(t.entryAt).toISOString().slice(5, 16)} ${(t.symbol ?? t.mint.slice(0, 6)).slice(0, 12).padEnd(12)} ${t.reason.padEnd(13)} peak +${t.peakPct.toFixed(0).padStart(4)}% · net ${t.returnPct.toFixed(1).padStart(6)}%`);
    }
  }
  // Tokens named on the command line: what the pool did, and when each rule set would have entered and exited.
  const diagnostics: unknown[] = [];
  for (const mint of watch) {
    const p = info.find(x => x.mint === mint);
    if (!p) { console.log(`\nWATCH ${mint}: no pool found`); continue; }
    const recent = await candles(p, Math.min(900, Math.ceil((Date.now() - p.createdAt) / MINUTE) + 5), true);
    const s: PoolSeries = { mint, symbol: p.symbol, pool: p.pool, createdAt: p.createdAt, supply: p.marketCapUsd / p.priceUsd, liquidityRefUsd: p.liquidityUsd, priceRef: p.priceUsd, candles: recent };
    const mcap = (price: number) => `$${Math.round(price * s.supply / 1000)}K`, at = (t: number) => new Date(t).toISOString().slice(11, 16);
    const peak = recent.reduce((a, k) => (k.h > a.h ? k : a), recent[0] ?? { t: 0, h: 0 } as VCandle);
    console.log(`\nWATCH ${p.symbol ?? mint} ${mint} · ${p.dex} pool created ${new Date(p.createdAt).toISOString()} · ${recent.length} candles` +
      (recent.length ? ` · first ${at(recent[0]!.t)} ${mcap(recent[0]!.o)} · peak ${at(peak.t)} ${mcap(peak.h)} · last ${at(recent.at(-1)!.t)} ${mcap(recent.at(-1)!.c)}` : ''));
    const ageless: EntryRule = { ...current, maxPoolAgeMin: 100_000 };
    const first = signals(s, ageless)[0];
    console.log(first ? `  first CRASH signal ignoring pool age: ${at(first.at)} (pool age ${((first.at - p.createdAt) / MINUTE).toFixed(0)} min) at ${mcap(first.price)} · 5m ${first.change5mPct.toFixed(0)}% · vol5m $${Math.round(first.volume5mUsd / 1000)}K`
      : '  no minute ever met the CRASH price/volume/liquidity rule');
    const runs: Array<[string, EntryRule, ExitRules]> = [['current QUICK', current, quick], ['current RIDE', current, ride], ...(best ? [['best', best.entry, best.exit] as [string, EntryRule, ExitRules]] : [])];
    for (const [label, e, x] of runs) {
      const t = simulatePool(s, e, x, costs, c.reentryMin);
      console.log(`  ${label.padEnd(13)} ${t.length ? t.map(v => `${at(v.entryAt)} ${mcap(v.entryPrice)} → ${v.reason} ${at(v.exitAt)} ${v.returnPct.toFixed(0)}%`).join(' | ') : 'no entry'}`);
    }
    diagnostics.push({ mint, pool: p, first: first ?? null });
  }
  const out = arg('out');
  if (out) await fs.writeFile(path.resolve(out), JSON.stringify({ generatedAt: new Date().toISOString(), hours, costs, pools: series.length, split,
    current: { quick: { ...now.quick, trades: now.quick.trades }, ride: now.ride }, top: stageB.slice(0, 50).map(({ trades, ...r }) => ({ ...r, trades: trades.length })),
    best: best ?? null, watch: diagnostics }, (_k, v) => v === Infinity ? 'Infinity' : v, 2));
}

main().catch(error => { console.error(`desk:backtest failed: ${(error as Error).message}`); process.exitCode = 1; });

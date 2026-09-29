/**
 * Reproducible replay of desk trades on market data. Recomputes each closed trade from GeckoTerminal minute candles
 * under several exit rules and entry sizes (constant-product impact estimate). Downloaded data is cached, so a rerun
 * with the same cache gives the same numbers. Reads ledgers only; never signs, submits or reads a private key.
 *
 *   npm run desk:replay -- --ledger data-desk/ledger-PAPER-CRASH.json [--sizes 2,10,100,1000,10000] [--horizon-min 30]
 *   npm run desk:replay -- --mint <MINT> --entry-at <ISO|ms> --entry-price <USD>
 *     [--cache data-desk/replay-cache] [--out replay.json] [--exit-fee-pct 1] [--refresh]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { deskCapital, strategyProfiles, type ExitRules } from '../desk/config';
import { replayExit, sizedReturn, type Candle } from '../desk/replay';
import type { LedgerEntry } from '../desk/types';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sizes = (arg('sizes') ?? '2,10,100,1000,10000').split(',').map(Number).filter(n => n > 0);
const horizonMs = Number(arg('horizon-min') ?? 30) * 60_000;
const exitFee = Number(arg('exit-fee-pct') ?? 1) / 100;
const cacheDir = path.resolve(arg('cache') ?? 'data-desk/replay-cache');
const refresh = process.argv.includes('--refresh');

async function cached<T>(key: string, url: string): Promise<T> {
  const file = path.join(cacheDir, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  if (!refresh) { try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { /* not cached yet */ } }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429 && attempt < 6) { await new Promise(r => setTimeout(r, 10_000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
    const body = await res.json() as T;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(body));
    return body;
  }
}

interface Pool { address: string; dex: string; reserveUsd: number }
async function mainPool(mint: string): Promise<Pool> {
  const body = await cached<{ data: Array<{ attributes: { address: string; reserve_in_usd: string | null }; relationships: { dex: { data: { id: string } } } }> }>(
    `pools-${mint}`, `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
  const pools = body.data.map(p => ({ address: p.attributes.address, dex: p.relationships.dex.data.id, reserveUsd: Number(p.attributes.reserve_in_usd ?? 0) }));
  const best = pools.sort((a, b) => b.reserveUsd - a.reserveUsd)[0];
  if (!best) throw new Error(`no pool for ${mint}`);
  return best;
}
async function candles(pool: string, mint: string, from: number, to: number): Promise<Candle[]> {
  const before = Math.floor(Math.min(to, Date.now()) / 60_000) * 60, limit = Math.min(1000, Math.ceil((before * 1000 - from) / 60_000) + 2);
  const body = await cached<{ data: { attributes: { ohlcv_list: number[][] } } }>(`ohlcv-${pool}-${mint}-${before}-${limit}`,
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd&token=${mint}&before_timestamp=${before}&include_empty_intervals=false`);
  return body.data.attributes.ohlcv_list.map(([t, o, h, l, c]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c! })).sort((a, b) => a.t - b.t);
}
/** Depth reference for the impact estimate: the pool's current liquidity and price (DexScreener). */
async function depth(pool: string): Promise<{ reserveUsd: number; price: number; observedAt: number }> {
  const body = await cached<{ pairs?: Array<{ priceUsd: string; liquidity?: { usd?: number } }>; pair?: { priceUsd: string; liquidity?: { usd?: number } } }>(
    `depth-${pool}`, `https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`);
  const p = body.pair ?? body.pairs?.[0];
  if (!p?.liquidity?.usd) throw new Error(`no liquidity for pool ${pool}`);
  return { reserveUsd: p.liquidity.usd / 2, price: Number(p.priceUsd), observedAt: Date.now() };
}

interface Trade { mint: string; symbol: string | null; entryAt: number; entryPrice: number; exitAt: number | null; exitPrice: number | null; netUsd: number | null; costUsd: number | null }
function tradesFromLedger(entries: LedgerEntry[]): Trade[] {
  const open = new Map<string, LedgerEntry>(), out: Trade[] = [];
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (e.status === 'FAILED' || e.status === 'UNKNOWN' || e.entryPriceUsd === null) continue;
    if (e.side === 'BUY') { open.set(e.mint, e); continue; }
    const b = open.get(e.mint); open.delete(e.mint);
    if (!b) continue;
    out.push({ mint: e.mint, symbol: e.symbol, entryAt: b.at, entryPrice: b.entryPriceUsd!, exitAt: e.at, exitPrice: e.exitPriceUsd, netUsd: e.netPnlUsd,
      costUsd: b.entryPriceUsd! * Number(b.quantity) + (b.networkFeeUsd ?? 0) });
  }
  for (const b of open.values()) out.push({ mint: b.mint, symbol: b.symbol, entryAt: b.at, entryPrice: b.entryPriceUsd!, exitAt: null, exitPrice: null, netUsd: null, costUsd: null });
  return out;
}

async function main(): Promise<void> {
  const rs = { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 };
  const crash = strategyProfiles({ ...process.env, CRASH_EXIT_MODE: 'quick' }, deskCapital(process.env), rs).CRASH.exits;
  const ride = strategyProfiles({ ...process.env, CRASH_EXIT_MODE: 'ride' }, deskCapital(process.env), rs).CRASH.exits;
  const runner: ExitRules = { takeProfitPct: Infinity, stopLossPct: crash.stopLossPct, maxHoldMin: horizonMs / 60_000, trailing: { activationPct: 40, stopPct: 40 }, giveback: null };
  const variants: Array<{ name: string; legs: ExitRules[] }> = [
    { name: `CRASH QUICK (TP +${crash.takeProfitPct}%, lock ${crash.giveback?.points} pts after +${crash.giveback?.lockPeakPct}%, SL -${crash.stopLossPct}%, ${crash.maxHoldMin} min)`, legs: [crash] },
    { name: `CRASH RIDE (no TP, trail ${ride.trailing?.stopPct}% after +${ride.trailing?.activationPct}%, SL -${ride.stopLossPct}%, ${ride.maxHoldMin} min)`, legs: [ride] },
    { name: 'No take profit, same lock/stop/time', legs: [{ ...crash, takeProfitPct: Infinity }] },
    { name: `Runner: 50% at TP, 50% trails 40% from peak (≤ ${horizonMs / 60_000} min)`, legs: [crash, runner] },
    { name: `Hold to +${horizonMs / 60_000} min (hindsight reference)`, legs: [{ takeProfitPct: Infinity, stopLossPct: 100, maxHoldMin: horizonMs / 60_000, trailing: null, giveback: null }] },
  ];
  let trades: Trade[] = [];
  for (const file of process.argv.flatMap((a, i) => a === '--ledger' ? [process.argv[i + 1]!] : [])) {
    trades.push(...tradesFromLedger((JSON.parse(await fs.readFile(file, 'utf8')) as { entries: LedgerEntry[] }).entries));
  }
  const mint = arg('mint');
  if (mint) {
    const at = arg('entry-at')!, entryAt = /^\d+$/.test(at) ? Number(at) : Date.parse(at);
    trades.push({ mint, symbol: null, entryAt, entryPrice: Number(arg('entry-price')), exitAt: null, exitPrice: null, netUsd: null, costUsd: null });
  }
  trades = trades.filter(t => Number.isFinite(t.entryAt) && t.entryPrice > 0);
  if (!trades.length) throw new Error('no trades: pass --ledger <file> or --mint/--entry-at/--entry-price');
  const report: unknown[] = [], totals = new Map<string, number[]>();
  const money = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 10 ? 2 : 0)}`;
  for (const t of trades) {
    const pool = await mainPool(t.mint), series = await candles(pool.address, t.mint, t.entryAt - 120_000, t.entryAt + horizonMs), ref = await depth(pool.address);
    const peak = Math.max(...series.filter(c => c.t > t.entryAt).map(c => c.h), t.entryPrice);
    console.log(`\n${t.symbol ?? t.mint} · ${pool.dex} ${pool.address} · entry ${new Date(t.entryAt).toISOString()} @ $${t.entryPrice.toPrecision(4)} · ` +
      `${series.length} candles · peak +${((peak / t.entryPrice - 1) * 100).toFixed(0)}% · depth ref $${Math.round(ref.reserveUsd * 2).toLocaleString('en-US')} liquidity @ $${ref.price.toPrecision(4)}`);
    if (t.exitPrice !== null) console.log(`  ACTUAL paper exit ${new Date(t.exitAt!).toISOString()} @ $${t.exitPrice.toPrecision(4)} (${((t.exitPrice / t.entryPrice - 1) * 100).toFixed(1)}%) · net ${money(t.netUsd ?? 0)} on $${t.costUsd?.toFixed(2)}`);
    const rows = variants.map(v => {
      const legs = v.legs.map(r => replayExit(series, t.entryAt, t.entryPrice, r, horizonMs));
      const bySize = sizes.map(s => legs.reduce((a, x) => a + (s / legs.length) * (sizedReturn(s / legs.length, t.entryPrice, x.exitPrice, ref.reserveUsd, ref.price) * (1 - exitFee) - exitFee), 0));
      bySize.forEach((pnl, i) => { const k = `${v.name}|${sizes[i]}`; totals.set(k, [...(totals.get(k) ?? []), pnl]); });
      console.log(`  ${v.name}\n    exit ${legs.map(x => `${x.reason} ${new Date(x.exitAt).toISOString().slice(11, 16)} ${((x.exitPrice / t.entryPrice - 1) * 100).toFixed(0)}%`).join(' + ')} · ` +
        sizes.map((s, i) => `$${s}: ${money(bySize[i]!)}`).join(' · '));
      return { variant: v.name, exits: legs, pnlBySize: Object.fromEntries(sizes.map((s, i) => [s, bySize[i]])) };
    });
    report.push({ trade: t, pool, depthReference: ref, candles: series.length, peakPrice: peak, variants: rows });
  }
  if (trades.length > 1) {
    console.log('\nTOTAL over all trades');
    for (const v of variants) console.log(`  ${v.name}: ${sizes.map(s => `$${s}: ${money((totals.get(`${v.name}|${s}`) ?? []).reduce((a, x) => a + x, 0))}`).join(' · ')}`);
  }
  console.log(`\nAssumptions: pessimistic intra-minute order (losses before highs), ${exitFee * 100}% exit fee, constant-product impact from the pool's current depth ` +
    '(no liquidity changes). Paper and replay ignore latency and MEV. Cached data in ' + cacheDir);
  const out = arg('out');
  if (out) await fs.writeFile(path.resolve(out), JSON.stringify({ generatedAt: new Date().toISOString(), sizes, horizonMs, exitFee, report }, null, 2));
}

main().catch(error => { console.error(`desk:replay failed: ${(error as Error).message}`); process.exitCode = 1; });

/**
 * Data for the desk backtests: every pump.fun graduation in a window (read from the chain), each token's pool
 * (DexScreener) and its minute candles (GeckoTerminal). Everything downloaded is cached, so a rerun gives the same
 * numbers. Read-only: it never signs, submits or loads a private key.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Connection, ConfirmedSignatureInfo } from '@solana/web3.js';
import { graduatedMint, migrationTx, PUMP_MIGRATION_AUTHORITY } from '../desk/migrations';
import type { VCandle } from '../desk/backtest';

export interface BacktestDataOptions {
  cacheDir: string; hours: number;
  /** GeckoTerminal's public limit is shared with a running desk on the same IP: stay well below it. */
  geckoMs: number;
  /** Analyse only what is already downloaded (no candle requests). */
  cachedOnly: boolean; refreshPools: boolean;
  /** Minute candles from Birdeye (token price in USD, 1 request per second) instead of GeckoTerminal (pool, shared with the desk). */
  birdeyeKey?: string | null;
}
export interface PoolInfo { mint: string; symbol: string | null; pool: string; dex: string; createdAt: number; priceUsd: number; liquidityUsd: number; marketCapUsd: number; volume24hUsd: number }
type DexPair = { pairAddress: string; dexId: string; baseToken: { address: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number };
  marketCap?: number; fdv?: number; volume?: { h24?: number }; pairCreatedAt?: number };

const MINUTE = 60_000;
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function readJson<T>(file: string): Promise<T | null> { try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; } }
export async function writeJson(file: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= 6) throw new Error(`${label}: ${(error as Error).message.slice(0, 120)}`);
      await sleep(2_000 * 2 ** Math.min(attempt, 4));
    }
  }
}

export function backtestData(o: BacktestDataOptions) {
  let lastGecko = 0, lastBirdeye = 0, birdeyeCalls = 0;
  /** Birdeye token candles (USD, the most liquid market: the curve until graduation, then the pool). */
  const birdeye = async (p: PoolInfo, spanMin: number, latest: boolean): Promise<VCandle[]> => {
    const now = Math.floor(Date.now() / 600_000) * 600_000;
    const to = Math.floor((latest ? now : Math.min(p.createdAt + spanMin * MINUTE, now)) / 1000), from = Math.max(Math.floor(p.createdAt / 1000) - 60, to - 999 * 60);
    const file = path.join(o.cacheDir, 'birdeye', `${p.mint}-${from}-${to}.json`);
    let list = await readJson<Array<{ unixTime: number; o: number; h: number; l: number; c: number; v: number }>>(file);
    if (!list && o.cachedOnly) return [];
    for (let attempt = 0; !list; attempt++) {
      await sleep(Math.max(0, lastBirdeye + 1_100 - Date.now())); lastBirdeye = Date.now(); birdeyeCalls++;
      const res = await fetch(`https://public-api.birdeye.so/defi/ohlcv?address=${p.mint}&type=1m&currency=usd&time_from=${from}&time_to=${to}`,
        { headers: { 'X-API-KEY': o.birdeyeKey!, 'x-chain': 'solana', accept: 'application/json' } }).catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) as { success?: boolean; data?: { items?: typeof list } } | null : null;
      if (body?.success) list = body.data?.items ?? [];
      else if (attempt >= 8) throw new Error(`birdeye: HTTP ${res?.status ?? 'network error'} for ${p.mint}`);
      else await sleep(res?.status === 429 ? 2_000 * (attempt + 1) : 3_000);
    }
    await writeJson(file, list);
    return list.map(k => ({ t: k.unixTime * 1000, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v * (k.o + k.c) / 2 })).filter(k => k.t >= p.createdAt - MINUTE).sort((a, b) => a.t - b.t);
  };
  return {
    /** Requests sent to Birdeye in this run (cached candles are free). */
    birdeyeCalls: () => birdeyeCalls,
    /** Every graduation in the window, from the migration authority's signatures and each transaction's balances. */
    async graduations(rpc: Connection): Promise<Array<{ mint: string; at: number }>> {
      const file = path.join(o.cacheDir, 'graduations.json');
      const known = (await readJson<Record<string, { mint: string | null; at: number }>>(file)) ?? {};
      const since = Date.now() - o.hours * 3_600_000, sigs: ConfirmedSignatureInfo[] = [];
      for (let before: string | undefined; ;) {
        const page = await retry('signatures', () => rpc.getSignaturesForAddress(PUMP_MIGRATION_AUTHORITY, { before, limit: 1000 }, 'confirmed'));
        const inside = page.filter(s => s.blockTime && s.blockTime * 1000 >= since);
        sigs.push(...inside.filter(s => !s.err));
        if (!page.length || inside.length < page.length) break;
        before = page.at(-1)!.signature;
      }
      const todo = sigs.filter(s => !(s.signature in known));
      console.log(`graduations: ${sigs.length} migration-authority transactions in ${o.hours} h, ${todo.length} to read`);
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
    },

    /** Each graduated token's PumpSwap pool, depth and 24 h volume (DexScreener, 30 tokens per request). */
    async pools(mints: string[]): Promise<PoolInfo[]> {
      const file = path.join(o.cacheDir, 'pools.json');
      const known = o.refreshPools ? {} : (await readJson<Record<string, PoolInfo | null>>(file)) ?? {};
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
    },

    /** Minute candles from pool creation until every entry window and hold could have ended (or the latest ones). */
    async candles(p: PoolInfo, spanMin: number, latest = false): Promise<VCandle[]> {
      if (o.birdeyeKey) return birdeye(p, spanMin, latest);
      // Rounded to 10 minutes, so reruns hit the same cache entries.
      const now = Math.floor(Date.now() / 600_000) * 600_000;
      const before = Math.floor((latest ? now : Math.min(p.createdAt + spanMin * MINUTE, now)) / 1000), limit = Math.min(1000, spanMin + 5);
      const file = path.join(o.cacheDir, 'ohlcv', `${p.pool}-${before}-${limit}.json`);
      let list = await readJson<number[][]>(file);
      if (!list && o.cachedOnly) return [];
      if (!list) {
        for (let attempt = 0; !list; attempt++) {
          await sleep(Math.max(0, lastGecko + o.geckoMs - Date.now())); lastGecko = Date.now();
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
    },
  };
}

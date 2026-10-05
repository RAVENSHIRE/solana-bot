import fs from 'node:fs/promises';
import path from 'node:path';
import type { EventInput } from '../events/types';

/**
 * Converts the desk backtests' download cache (data-desk/backtest-cache) into BACKFILL events with explicit
 * availability, so the same data can be used point in time:
 *
 *   graduations.json  → Graduation (block time; available `graduationLagMs` later, as the live on-chain feed)
 *   pools.json        → MarketSnapshot at the download time ONLY (file mtime): the depth/supply reference the desk
 *                       backtest applies to every earlier minute (AUDIT #4) can no longer reach into the past
 *   birdeye/*.json    → Candle (bar close; available `barLagMs` after the close)
 *   ohlcv/*.json      → Candle from GeckoTerminal pools (mint from pools.json)
 */

const PRODUCER = { component: 'ingest:backtest-cache', version: '1' };
const MIN = 60_000;

export interface CacheImportOptions {
  /** Live graduation feed latency (default 15 s). */
  graduationLagMs?: number;
  /** How long after its close a minute bar is available from the provider (default 60 s, conservative). */
  barLagMs?: number;
}
export interface CacheImportReport { graduations: number; pools: number; birdeyeFiles: number; geckoFiles: number; candles: number; skipped: number }

interface PoolInfo { mint: string; symbol: string | null; pool: string; dex: string; createdAt: number; priceUsd: number; liquidityUsd: number; marketCapUsd: number; volume24hUsd: number }

async function json<T>(file: string): Promise<T | null> { try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; } }
const mtime = async (file: string) => Math.round((await fs.stat(file)).mtimeMs);

function candle(token: string, start: number, o: number, h: number, l: number, c: number, v: number | null, observed: number, lag: number, source: string, supply: number | null): EventInput | null {
  if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0) || h < Math.max(o, c, l) || l > Math.min(o, c, h)) return null;
  const close = start + MIN;
  return { event_type: 'Candle', token, timestamp: close, observed_at: observed, available_at: Math.min(observed, close + lag), source, capture: 'BACKFILL',
    payload: { interval_ms: MIN, start, o, h, l, c, v, ...(supply ? { supply } : {}) }, natural_key: `${source}:${token}:${start}`, producer: PRODUCER };
}

export async function backtestCacheInputs(dir: string, o: CacheImportOptions = {}): Promise<{ inputs: EventInput[]; report: CacheImportReport }> {
  const gradLag = o.graduationLagMs ?? 15_000, barLag = o.barLagMs ?? MIN, inputs: EventInput[] = [];
  const report: CacheImportReport = { graduations: 0, pools: 0, birdeyeFiles: 0, geckoFiles: 0, candles: 0, skipped: 0 };
  const gradFile = path.join(dir, 'graduations.json'), grads = await json<Record<string, { mint: string | null; at: number }>>(gradFile);
  if (grads) {
    const seen = await mtime(gradFile);
    for (const [signature, g] of Object.entries(grads)) {
      if (!g.mint || !Number.isSafeInteger(g.at)) { report.skipped++; continue; }
      inputs.push({ event_type: 'Graduation', token: g.mint, timestamp: g.at, observed_at: seen, available_at: Math.min(seen, g.at + gradLag), source: 'chain:pump-migration',
        capture: 'BACKFILL', payload: { signature }, natural_key: signature, producer: PRODUCER });
      report.graduations++;
    }
  }
  const poolFile = path.join(dir, 'pools.json'), pools = (await json<Record<string, PoolInfo | null>>(poolFile)) ?? {}, byPool = new Map<string, PoolInfo>();
  if (Object.keys(pools).length) {
    const seen = await mtime(poolFile);
    for (const p of Object.values(pools)) {
      if (!p) continue;
      byPool.set(p.pool, p);
      // Observed once, at download: valid for decisions after that moment only.
      inputs.push({ event_type: 'MarketSnapshot', token: p.mint, timestamp: seen, observed_at: seen, source: 'dexscreener:backtest-cache', capture: 'BACKFILL',
        available_at: seen, timestamp_estimated: true,
        payload: { price_usd: p.priceUsd, liquidity_usd: p.liquidityUsd, market_cap_usd: p.marketCapUsd, volume_24h_usd: p.volume24hUsd, pool: p.pool, dex: p.dex,
          pool_created_at: p.createdAt, symbol: p.symbol }, natural_key: `pool:${p.mint}:${seen}`, producer: PRODUCER });
      report.pools++;
    }
  }
  const supplyOf = (mint: string) => { const p = Object.values(pools).find(x => x?.mint === mint); return p && p.priceUsd > 0 && p.marketCapUsd > 0 ? p.marketCapUsd / p.priceUsd : null; };
  const birdeye = path.join(dir, 'birdeye');
  for (const name of (await fs.readdir(birdeye).catch(() => [] as string[])).sort()) {
    const m = /^([1-9A-HJ-NP-Za-km-z]{32,44})-(\d+)-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(birdeye, name), list = await json<Array<{ unixTime: number; o: number; h: number; l: number; c: number; v: number }>>(file);
    if (!list) { report.skipped++; continue; }
    const seen = await mtime(file), supply = supplyOf(m[1]!);
    for (const k of list) {
      // Birdeye volume is in tokens: USD ≈ tokens × the bar's mid price (as the desk backtest does).
      const e = candle(m[1]!, k.unixTime * 1000, k.o, k.h, k.l, k.c, Number.isFinite(k.v) ? k.v * (k.o + k.c) / 2 : null, seen, barLag, 'birdeye', supply);
      if (e) { inputs.push(e); report.candles++; } else report.skipped++;
    }
    report.birdeyeFiles++;
  }
  const ohlcv = path.join(dir, 'ohlcv');
  for (const name of (await fs.readdir(ohlcv).catch(() => [] as string[])).sort()) {
    const m = /^([1-9A-HJ-NP-Za-km-z]{32,44})-/.exec(name), pool = m ? byPool.get(m[1]!) : undefined;
    if (!pool) { report.skipped++; continue; }
    const file = path.join(ohlcv, name), rows = await json<number[][]>(file);
    if (!rows) { report.skipped++; continue; }
    const seen = await mtime(file), supply = supplyOf(pool.mint);
    for (const r of rows) {
      const [ts, o1, h, l, c, v] = r as [number, number, number, number, number, number];
      const e = candle(pool.mint, ts * 1000, o1, h, l, c, Number.isFinite(v) ? v : null, seen, barLag, 'geckoterminal', supply);
      if (e) { inputs.push(e); report.candles++; } else report.skipped++;
    }
    report.geckoFiles++;
  }
  return { inputs, report };
}

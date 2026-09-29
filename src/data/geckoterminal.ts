import { z } from 'zod';
import type { Logger } from '../utils/logger';
import type { Candle, PoolTrade } from '../core/types';
import { DataRuntime } from './core/data-runtime';
import { address, nonnegative, optionalNumber, parse, positive, safeInteger, unixSeconds } from './core/data-validator';
import { DataError, observation, type OHLCVSeries, type Observation, type TradeEvent, type MarketSnapshot } from './core/data-types';

const relation = z.object({ data: z.object({ id: z.string() }) });
const poolSchema = z.object({ id: z.string(), attributes: z.object({ address, name: z.string(), base_token_price_usd: optionalNumber,
  reserve_in_usd: optionalNumber, market_cap_usd: optionalNumber, fdv_usd: optionalNumber, pool_created_at: z.string().datetime({ offset: true }).nullish(),
  volume_usd: z.object({ h1: optionalNumber, h24: optionalNumber }).nullish() }),
  relationships: z.object({ base_token: relation, quote_token: relation, dex: relation.optional() }) });
export interface GeckoPool { address: string; name: string; baseTokenMint: string; quoteTokenMint: string; reserveUsd: number | null;
  createdAt: number | null; volumeUsd: { h1: number | null; h24: number | null }; priceUsd: number | null;
  marketCapUsd: number | null; fdvUsd: number | null; dex: string; meta: Observation }
function mintFromId(id: string): string {
  if (!id.startsWith('solana_')) throw new DataError('invalid-response', 'geckoterminal', 'wrong network relationship');
  return parse(address, id.slice(7), 'geckoterminal');
}
export function normalizeGeckoPool(raw: unknown, at: number): GeckoPool {
  const p = parse(poolSchema, raw, 'geckoterminal'); const a = p.attributes;
  if (mintFromId(p.id) !== a.address) throw new DataError('invalid-response', 'geckoterminal', 'pool identity mismatch');
  const baseTokenMint = mintFromId(p.relationships.base_token.data.id); const quoteTokenMint = mintFromId(p.relationships.quote_token.data.id);
  const createdAt = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
  if (createdAt !== null && (createdAt <= 0 || createdAt > at)) throw new DataError('invalid-response', 'geckoterminal', 'future pool creation');
  return { address: a.address, name: a.name, baseTokenMint, quoteTokenMint, reserveUsd: a.reserve_in_usd, createdAt,
    volumeUsd: { h1: a.volume_usd?.h1 ?? null, h24: a.volume_usd?.h24 ?? null }, priceUsd: a.base_token_price_usd,
    marketCapUsd: a.market_cap_usd, fdvUsd: a.fdv_usd, dex: p.relationships.dex?.data.id ?? 'unknown',
    meta: observation('geckoterminal', at, baseTokenMint, a.address) };
}
export function geckoSnapshot(p: GeckoPool): MarketSnapshot {
  return { meta: p.meta, token: { mint: p.baseTokenMint, name: null, symbol: null, decimals: null },
    pool: { address: p.address, baseMint: p.baseTokenMint, quoteMint: p.quoteTokenMint, dex: p.dex, type: 'unknown' },
    priceUsd: p.priceUsd, liquidityUsd: p.reserveUsd, marketCapUsd: p.marketCapUsd, fdvUsd: p.fdvUsd, createdAt: p.createdAt, volumeUsd: p.volumeUsd };
}
export function normalizeOhlcv(raw: unknown, pool: string, mint: string, intervalMs: number, at: number): OHLCVSeries {
  const rows = parse(z.object({ data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.tuple([safeInteger, positive, positive, positive, positive, nonnegative])).max(1000) }) }) }), raw, 'geckoterminal').data.attributes.ohlcv_list;
  const byTime = new Map<number, Candle>();
  for (const [seconds, o, h, l, c, v] of rows) {
    const t = unixSeconds(seconds, at);
    if (t % intervalMs !== 0 || h < Math.max(o, l, c) || l > Math.min(o, h, c)) throw new DataError('invalid-response', 'geckoterminal', 'invalid OHLC interval or relationship');
    const candle = { t, o, h, l, c, v }; const old = byTime.get(t);
    if (old && JSON.stringify(old) !== JSON.stringify(candle)) throw new DataError('invalid-response', 'geckoterminal', 'conflicting candle duplicates');
    byTime.set(t, candle);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  const candles = sorted.filter(c => c.t + intervalMs <= at); const partial = sorted.filter(c => c.t + intervalMs > at);
  const missingIntervals: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1]!; const current = candles[i]!;
    for (let t = previous.t + intervalMs; t < current.t; t += intervalMs) {
      if (missingIntervals.length >= 10_000) throw new DataError('invalid-response', 'geckoterminal', 'excessive history gap');
      missingIntervals.push(t);
    }
  }
  return { meta: observation('geckoterminal', at, mint, pool, candles.at(-1) ? candles.at(-1)!.t + intervalMs : null), intervalMs, candles, partial, missingIntervals };
}
const tradeSchema = z.object({ id: z.string().min(1), attributes: z.object({ tx_hash: z.string().min(1), tx_from_address: address,
  from_token_address: address, to_token_address: address, from_token_amount: positive, to_token_amount: positive,
  price_from_in_usd: optionalNumber, price_to_in_usd: optionalNumber, volume_in_usd: nonnegative,
  block_timestamp: z.string().datetime({ offset: true }), kind: z.enum(['buy', 'sell']) }) });
export function normalizeTrades(raw: unknown, pool: string, mint: string, at: number): TradeEvent[] {
  const rows = parse(z.object({ data: z.array(tradeSchema) }), raw, 'geckoterminal').data; const events = new Map<string, TradeEvent>();
  for (const row of rows) {
    const a = row.attributes; const incoming = a.to_token_address === mint; const outgoing = a.from_token_address === mint;
    if (incoming === outgoing) throw new DataError('invalid-response', 'geckoterminal', 'trade token identity mismatch');
    const ts = Date.parse(a.block_timestamp); const priceUsd = incoming ? a.price_to_in_usd : a.price_from_in_usd;
    if (ts > at || ts <= 0 || priceUsd === null || priceUsd <= 0) throw new DataError('invalid-response', 'geckoterminal', 'invalid trade time or price');
    const event: TradeEvent = { id: row.id, txHash: a.tx_hash, wallet: a.tx_from_address, kind: incoming ? 'buy' : 'sell', volumeUsd: a.volume_in_usd,
      ts, priceUsd, tokenAmount: incoming ? a.to_token_amount : a.from_token_amount, tokenMint: mint, poolAddress: pool,
      meta: observation('geckoterminal', at, mint, pool, ts), walletVerified: false };
    const old = events.get(row.id);
    if (old && JSON.stringify(old) !== JSON.stringify(event)) throw new DataError('invalid-response', 'geckoterminal', 'conflicting trade duplicates');
    events.set(row.id, event);
  }
  return [...events.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}
export class GeckoTerminalClient {
  private readonly http;
  constructor(logger: Logger, readonly data = new DataRuntime(logger)) { this.http = data.http('geckoterminal', 'https://api.geckoterminal.com/api/v2', data.settings.geckoRps); }
  private pools(route: string, page: number): Promise<GeckoPool[]> {
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new Error('Invalid page');
    return this.data.read('geckoterminal', `${route}:${page}`, 'discovery', () => this.http.get(route, { page }), (raw, at) =>
      parse(z.object({ data: z.array(z.unknown()) }), raw, 'geckoterminal').data.map(p => normalizeGeckoPool(p, at)));
  }
  getTrendingPools(page = 1): Promise<GeckoPool[]> { return this.pools('/networks/solana/trending_pools', page); }
  getNewPools(page = 1): Promise<GeckoPool[]> { return this.pools('/networks/solana/new_pools', page); }
  getPool(pool: string): Promise<GeckoPool> {
    parse(address, pool, 'geckoterminal');
    return this.data.read('geckoterminal', `pool:${pool}`, 'analysis', () => this.http.get(`/networks/solana/pools/${pool}`), (raw, at) => {
      const p = normalizeGeckoPool(parse(z.object({ data: z.unknown() }), raw, 'geckoterminal').data, at);
      if (p.address !== pool) throw new DataError('invalid-response', 'geckoterminal', 'requested pool mismatch'); return p;
    });
  }
  async getOhlcvSeries(pool: string, timeframe: 'minute' | 'hour' | 'day', aggregate: number, limit: number, mint?: string): Promise<OHLCVSeries> {
    parse(address, pool, 'geckoterminal');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !(timeframe === 'minute' ? [1, 5, 15] : timeframe === 'hour' ? [1, 4, 12] : [1]).includes(aggregate)) throw new Error('Invalid OHLCV request');
    const token = mint ?? (await this.getPool(pool)).baseTokenMint; parse(address, token, 'geckoterminal');
    const interval = aggregate * (timeframe === 'minute' ? 60_000 : timeframe === 'hour' ? 3_600_000 : 86_400_000);
    return this.data.read('geckoterminal', `ohlcv:${pool}:${token}:${timeframe}:${aggregate}:${limit}`, 'analysis',
      () => this.http.get(`/networks/solana/pools/${pool}/ohlcv/${timeframe}`, { aggregate, limit, currency: 'usd', token, include_empty_intervals: false }),
      (raw, at) => normalizeOhlcv(raw, pool, token, interval, at));
  }
  async getOhlcv(pool: string, timeframe: 'minute' | 'hour' | 'day', aggregate: number, limit: number): Promise<Candle[]> { return (await this.getOhlcvSeries(pool, timeframe, aggregate, limit)).candles; }
  async getTradeEvents(pool: string, mint?: string, minVolume = 0): Promise<TradeEvent[]> {
    parse(address, pool, 'geckoterminal'); const token = mint ?? (await this.getPool(pool)).baseTokenMint; parse(address, token, 'geckoterminal');
    parse(nonnegative, minVolume, 'geckoterminal');
    return this.data.read('geckoterminal', `trades:${pool}:${token}:${minVolume}`, 'analysis', () => this.http.get(`/networks/solana/pools/${pool}/trades`, { trade_volume_in_usd_greater_than: minVolume }), (raw, at) => normalizeTrades(raw, pool, token, at));
  }
  async getTrades(pool: string, minVolume = 0, mint?: string): Promise<PoolTrade[]> { return this.getTradeEvents(pool, mint, minVolume); }
}

import { HttpClient } from './http-client';
import { TokenBucket } from '../utils/rate-limiter';
import type { Logger } from '../utils/logger';
import type { Candle, PoolTrade } from '../core/types';

type Window = 'm5' | 'h1' | 'h6' | 'h24';

export interface GeckoPool {
  address: string;
  name: string;
  dexId: string;
  baseTokenMint: string;
  quoteTokenMint: string;
  priceUsd: number;
  reserveUsd: number;
  volumeUsd: Record<Window, number>;
  priceChangePct: Record<Window, number>;
  createdAt: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
}

interface JsonApiPool {
  attributes?: {
    address?: string;
    name?: string;
    base_token_price_usd?: string | null;
    reserve_in_usd?: string | null;
    pool_created_at?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    volume_usd?: Partial<Record<Window, string | null>>;
    price_change_percentage?: Partial<Record<Window, string | null>>;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

interface JsonApiTrade {
  attributes?: {
    tx_hash?: string;
    tx_from_address?: string;
    kind?: string;
    volume_in_usd?: string | null;
    block_timestamp?: string;
    from_token_amount?: string | null;
    to_token_amount?: string | null;
    price_from_in_usd?: string | null;
    price_to_in_usd?: string | null;
  };
}

const toNum = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? NaN);
  return Number.isFinite(n) ? n : 0;
};
const toNumOrNull = (v: string | null | undefined): number | null => {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
};
const stripNetwork = (id: string | undefined): string => (id ? id.replace(/^solana_/, '') : '');

/**
 * GeckoTerminal Public API v2 (Free Tier ≈ 30 Calls/Minute → Bucket 27/min).
 * Liefert OHLCV und Einzel-Trades inkl. Wallet-Adresse – Basis für Support-,
 * Wash-Trading- und Smart-Money-Analyse.
 */
export class GeckoTerminalClient {
  private readonly http: HttpClient;

  constructor(logger: Logger) {
    this.http = new HttpClient({
      name: 'GeckoTerminal',
      baseUrl: 'https://api.geckoterminal.com/api/v2',
      limiter: new TokenBucket(3, 0.45),
      logger,
      timeoutMs: 15_000,
      headers: { Accept: 'application/json;version=20230302' },
    });
  }

  async getTrendingPools(page = 1): Promise<GeckoPool[]> {
    const res = await this.http.get<{ data?: JsonApiPool[] }>('/networks/solana/trending_pools', { page });
    return (res.data ?? []).map((p) => this.parsePool(p)).filter((p): p is GeckoPool => p !== null);
  }

  async getNewPools(page = 1): Promise<GeckoPool[]> {
    const res = await this.http.get<{ data?: JsonApiPool[] }>('/networks/solana/new_pools', { page });
    return (res.data ?? []).map((p) => this.parsePool(p)).filter((p): p is GeckoPool => p !== null);
  }

  /** OHLCV aufsteigend sortiert. timeframe: minute|hour|day, aggregate z. B. 1/5/15. */
  async getOhlcv(
    poolAddress: string,
    timeframe: 'minute' | 'hour' | 'day',
    aggregate: number,
    limit: number,
  ): Promise<Candle[]> {
    const res = await this.http.get<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      `/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`,
      { aggregate, limit: Math.min(limit, 1000), currency: 'usd' },
    );
    const list = res.data?.attributes?.ohlcv_list ?? [];
    return list
      .filter((row) => Array.isArray(row) && row.length >= 6)
      .map((row) => ({
        t: toNum(row[0]) * 1000,
        o: toNum(row[1]),
        h: toNum(row[2]),
        l: toNum(row[3]),
        c: toNum(row[4]),
        v: toNum(row[5]),
      }))
      .filter((c) => c.c > 0 && c.l > 0)
      .sort((a, b) => a.t - b.t);
  }

  /** Letzte Trades (max. ~300) eines Pools, neueste zuerst. */
  async getTrades(poolAddress: string, minVolumeUsd = 0): Promise<PoolTrade[]> {
    const res = await this.http.get<{ data?: JsonApiTrade[] }>(`/networks/solana/pools/${poolAddress}/trades`, {
      trade_volume_in_usd_greater_than: minVolumeUsd,
    });
    const out: PoolTrade[] = [];
    for (const t of res.data ?? []) {
      const a = t.attributes;
      if (!a?.tx_from_address || (a.kind !== 'buy' && a.kind !== 'sell')) continue;
      const isBuy = a.kind === 'buy';
      out.push({
        txHash: a.tx_hash ?? '',
        wallet: a.tx_from_address,
        kind: a.kind,
        volumeUsd: toNum(a.volume_in_usd),
        ts: a.block_timestamp ? Date.parse(a.block_timestamp) : 0,
        priceUsd: toNum(isBuy ? a.price_to_in_usd : a.price_from_in_usd),
        tokenAmount: toNum(isBuy ? a.to_token_amount : a.from_token_amount),
      });
    }
    return out;
  }

  private parsePool(p: JsonApiPool): GeckoPool | null {
    const a = p.attributes;
    if (!a?.address) return null;
    const vol = a.volume_usd ?? {};
    const chg = a.price_change_percentage ?? {};
    return {
      address: a.address,
      name: a.name ?? '',
      dexId: p.relationships?.dex?.data?.id ?? 'unknown',
      baseTokenMint: stripNetwork(p.relationships?.base_token?.data?.id),
      quoteTokenMint: stripNetwork(p.relationships?.quote_token?.data?.id),
      priceUsd: toNum(a.base_token_price_usd),
      reserveUsd: toNum(a.reserve_in_usd),
      volumeUsd: { m5: toNum(vol.m5), h1: toNum(vol.h1), h6: toNum(vol.h6), h24: toNum(vol.h24) },
      priceChangePct: { m5: toNum(chg.m5), h1: toNum(chg.h1), h6: toNum(chg.h6), h24: toNum(chg.h24) },
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
      fdvUsd: toNumOrNull(a.fdv_usd),
      marketCapUsd: toNumOrNull(a.market_cap_usd),
    };
  }
}

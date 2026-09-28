import { HttpClient } from './http-client';
import { TokenBucket } from '../utils/rate-limiter';
import type { Logger } from '../utils/logger';

export interface RaydiumMint {
  address: string;
  symbol: string;
  decimals: number;
}

export interface RaydiumPeriodStats {
  volume: number;
  volumeQuote?: number;
  volumeFee?: number;
  apr: number;
  feeApr: number;
  priceMin: number;
  priceMax: number;
}

export interface RaydiumPool {
  type: 'Standard' | 'Concentrated' | string;
  programId: string;
  id: string;
  mintA: RaydiumMint;
  mintB: RaydiumMint;
  price: number;
  mintAmountA: number;
  mintAmountB: number;
  feeRate: number;
  tvl: number;
  day: RaydiumPeriodStats;
  week?: RaydiumPeriodStats;
}

interface ListResponse {
  success: boolean;
  data?: { count?: number; data?: RaydiumPool[]; hasNextPage?: boolean };
}

interface IdsResponse {
  success: boolean;
  data?: Array<RaydiumPool | null>;
}

/** Raydium API v3 (https://api-v3.raydium.io). */
export class RaydiumClient {
  private readonly http: HttpClient;

  constructor(logger: Logger) {
    this.http = new HttpClient({
      name: 'Raydium',
      baseUrl: 'https://api-v3.raydium.io',
      limiter: new TokenBucket(3, 2),
      logger,
      timeoutMs: 15_000,
    });
  }

  async listPools(o: {
    page?: number;
    pageSize?: number;
    sortField?: 'volume24h' | 'fee24h' | 'apr24h' | 'liquidity' | 'default';
  }): Promise<RaydiumPool[]> {
    const res = await this.http.get<ListResponse>('/pools/info/list', {
      poolType: 'all',
      poolSortField: o.sortField ?? 'volume24h',
      sortType: 'desc',
      pageSize: Math.min(o.pageSize ?? 100, 1000),
      page: o.page ?? 1,
    });
    if (!res.success) throw new Error('Raydium /pools/info/list: success=false');
    return (res.data?.data ?? []).filter(isValidPool);
  }

  async getPoolsByIds(ids: string[]): Promise<RaydiumPool[]> {
    if (ids.length === 0) return [];
    const out: RaydiumPool[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await this.http.get<IdsResponse>('/pools/info/ids', { ids: chunk.join(',') });
      if (!res.success) throw new Error('Raydium /pools/info/ids: success=false');
      for (const p of res.data ?? []) if (p && isValidPool(p)) out.push(p);
    }
    return out;
  }
}

function isValidPool(p: RaydiumPool): boolean {
  return (
    typeof p.id === 'string' &&
    typeof p.mintA?.address === 'string' &&
    typeof p.mintB?.address === 'string' &&
    Number.isFinite(p.tvl) &&
    Number.isFinite(p.mintAmountA) &&
    Number.isFinite(p.mintAmountB) &&
    p.day !== undefined
  );
}

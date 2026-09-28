import { z } from 'zod';
import type { Logger } from '../utils/logger';
import { DataRuntime } from './core/data-runtime';
import { address, nonnegative, optionalNumber, parse, unixSeconds } from './core/data-validator';
import { observation, type Observation, DataError } from './core/data-types';
const mint = z.object({ address, decimals: z.number().int().min(0).max(255), symbol: z.string(), name: z.string().optional() });
const pool = z.object({ id: address, type: z.enum(['Standard', 'Concentrated']), pooltype: z.array(z.string()).optional(),
  mintA: mint, mintB: mint, price: optionalNumber, tvl: optionalNumber, feeRate: nonnegative.refine(n => n <= 1),
  openTime: z.string().regex(/^\d+$/).optional(), day: z.object({ volume: optionalNumber, feeApr: optionalNumber, priceMin: optionalNumber, priceMax: optionalNumber }) });
export type RaydiumPool = z.infer<typeof pool> & { createdAt: number | null; constantProduct: boolean; meta: Observation };
export function normalizeRaydiumPools(raw: unknown, at: number): RaydiumPool[] {
  return parse(z.array(pool), raw, 'raydium').map(p => {
    if (p.mintA.address === p.mintB.address || (p.day.priceMax !== null && p.day.priceMin !== null && p.day.priceMax < p.day.priceMin)) throw new DataError('invalid-response', 'raydium', 'invalid pool identity or range');
    return { ...p, createdAt: p.openTime && p.openTime !== '0' ? unixSeconds(Number(p.openTime), at) : null,
      constantProduct: p.type === 'Standard' && !p.pooltype?.includes('StablePool'), meta: observation('raydium', at, p.mintA.address, p.id) };
  });
}
export class RaydiumClient {
  private readonly http;
  constructor(logger: Logger, readonly data = new DataRuntime(logger)) { this.http = data.http('raydium', 'https://api-v3.raydium.io', data.settings.raydiumRps); }
  listPools(params: { sortField: 'volume24h' | 'liquidity'; pageSize: number }): Promise<RaydiumPool[]> {
    if (!Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 1000) throw new Error('Invalid page size');
    return this.data.read('raydium', `list:${params.sortField}:${params.pageSize}`, 'discovery',
      () => this.http.get('/pools/info/list-v2', { size: params.pageSize, sortField: params.sortField, sortType: 'desc', hasReward: false }),
      (raw, at) => normalizeRaydiumPools(parse(z.object({ success: z.literal(true), data: z.object({ data: z.array(z.unknown()) }) }), raw, 'raydium').data.data, at));
  }
  async getPoolsByIds(ids: string[]): Promise<RaydiumPool[]> {
    const unique = [...new Set(ids.map(id => parse(address, id, 'raydium')))].sort(); const out: RaydiumPool[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      out.push(...await this.data.read('raydium', `ids:${batch.join(',')}`, 'position', () => this.http.get('/pools/info/ids', { ids: batch.join(',') }), (raw, at) => {
        const rows = parse(z.object({ success: z.literal(true), data: z.array(z.unknown()) }), raw, 'raydium').data;
        const normalized = normalizeRaydiumPools(rows.filter(r => r !== null), at);
        if (normalized.some(p => !batch.includes(p.id))) throw new DataError('invalid-response', 'raydium', 'requested pool mismatch'); return normalized;
      }));
    }
    return out;
  }
}

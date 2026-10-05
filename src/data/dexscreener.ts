import { z } from 'zod';
import type { Logger } from '../utils/logger';
import { QUOTE_MINTS } from '../core/types';
import { DataRuntime } from './core/data-runtime';
import { address, decimal, optionalNumber, parse, safeInteger, timestamp } from './core/data-validator';
import { observation, type MarketSnapshot, type Observation } from './core/data-types';

const changes = z.object({ m5: decimal.nullish(), h1: decimal.nullish(), h6: decimal.nullish(), h24: decimal.nullish() });
const volumes = z.object({ m5: optionalNumber, h1: optionalNumber, h6: optionalNumber, h24: optionalNumber });
const token = z.object({ address, symbol: z.string().optional(), name: z.string().optional() });
const transactions = z.object({ buys: safeInteger, sells: safeInteger });
const link = z.object({ url: z.string().url().max(500), type: z.string().max(40).optional(), label: z.string().max(80).optional() });
const listingSchema = z.object({ chainId: z.string(), tokenAddress: z.string(), description: z.string().max(2000).nullish().catch(null),
  links: z.array(link).max(20).nullish().catch(null), totalAmount: z.number().finite().nonnegative().nullish().catch(null) });
export interface DexListing { mint: string; description: string | null; links: Array<{ url: string; type: string | null; label: string | null }>; boostAmount: number | null }
const pairSchema = z.object({ chainId: z.literal('solana'), dexId: z.string().min(1), pairAddress: address,
  baseToken: token, quoteToken: token, priceUsd: optionalNumber, liquidity: z.object({ usd: optionalNumber }).nullish(),
  marketCap: optionalNumber, fdv: optionalNumber, pairCreatedAt: timestamp.nullish(),
  priceChange: changes.nullish(), volume: volumes.nullish(),
  txns: z.object({ m5: transactions.optional(), h1: transactions.optional(), h6: transactions.optional(), h24: transactions.optional() }).nullish(),
  // Project links are optional context: a malformed entry must never reject the market data itself.
  info: z.object({ websites: z.array(link).max(10).optional(), socials: z.array(link).max(10).optional() }).nullish().catch(null) });
export type DexPair = z.infer<typeof pairSchema> & { meta: Observation };
export function normalizeDexPairs(raw: unknown, at: number): DexPair[] {
  return parse(z.array(z.unknown()), raw, 'dexscreener').filter(p => (p as { chainId?: unknown } | null)?.chainId === 'solana').map(p => {
    const row = parse(pairSchema, p, 'dexscreener');
    return { ...row, meta: observation('dexscreener', at, row.baseToken.address, row.pairAddress) };
  });
}
export function dexSnapshot(p: DexPair): MarketSnapshot {
  return { meta: p.meta, token: { mint: p.baseToken.address, name: p.baseToken.name ?? null, symbol: p.baseToken.symbol ?? null, decimals: null },
    pool: { address: p.pairAddress, baseMint: p.baseToken.address, quoteMint: p.quoteToken.address, dex: p.dexId, type: 'unknown' },
    priceUsd: p.priceUsd, liquidityUsd: p.liquidity?.usd ?? null, marketCapUsd: p.marketCap, fdvUsd: p.fdv,
    createdAt: p.pairCreatedAt ?? null, volumeUsd: p.volume ?? {} };
}
export class DexScreenerClient {
  private readonly http;
  constructor(logger: Logger, readonly data = new DataRuntime(logger)) {
    this.http = data.http('dexscreener', 'https://api.dexscreener.com', data.settings.dexRps);
  }
  private listings(route: string): Promise<string[]> {
    return this.data.read('dexscreener', route, 'discovery', () => this.http.get(route), raw => {
      const rows = parse(z.array(z.object({ chainId: z.string(), tokenAddress: z.string() })), raw, 'dexscreener');
      return [...new Set(rows.filter(r => r.chainId === 'solana').map(r => parse(address, r.tokenAddress, 'dexscreener')))];
    });
  }
  /** Listing rows with their project description, links and boost amount (for the desk's evidence model). */
  listingDetails(route: '/token-boosts/latest/v1' | '/token-boosts/top/v1' | '/token-profiles/latest/v1'): Promise<DexListing[]> {
    return this.data.read('dexscreener', `details:${route}`, 'discovery', () => this.http.get(route), raw => {
      const rows = parse(z.array(z.unknown()), raw, 'dexscreener').map(r => listingSchema.safeParse(r)).flatMap(r => r.success ? [r.data] : []);
      const out = new Map<string, DexListing>();
      for (const r of rows) {
        if (r.chainId !== 'solana' || !address.safeParse(r.tokenAddress).success || out.has(r.tokenAddress)) continue;
        out.set(r.tokenAddress, { mint: r.tokenAddress, description: r.description ?? null, boostAmount: r.totalAmount ?? null,
          links: (r.links ?? []).map(l => ({ url: l.url, type: l.type ?? null, label: l.label ?? null })) });
      }
      return [...out.values()];
    });
  }
  getLatestBoostedTokens(): Promise<string[]> { return this.listings('/token-boosts/latest/v1'); }
  getTopBoostedTokens(): Promise<string[]> { return this.listings('/token-boosts/top/v1'); }
  getLatestProfiles(): Promise<string[]> { return this.listings('/token-profiles/latest/v1'); }
  /** Solana pairs whose token name or ticker matches `query` (DexScreener search); malformed rows are skipped. */
  searchPairs(query: string): Promise<DexPair[]> {
    const q = query.trim().slice(0, 40);
    return this.data.read('dexscreener', `search:${q.toLowerCase()}`, 'analysis', () => this.http.get('/latest/dex/search', { q }), (raw, at) => {
      const rows = (raw as { pairs?: unknown } | null)?.pairs;
      return (Array.isArray(rows) ? rows : []).filter(p => (p as { chainId?: unknown } | null)?.chainId === 'solana').flatMap(p => {
        const row = pairSchema.safeParse(p);
        return row.success ? [{ ...row.data, meta: observation('dexscreener', at, row.data.baseToken.address, row.data.pairAddress) }] : [];
      });
    });
  }
  async getPairsForTokens(mints: string[]): Promise<DexPair[]> {
    const unique = [...new Set(mints.map(m => parse(address, m, 'dexscreener')))].sort();
    const pairs = new Map<string, DexPair>();
    for (let i = 0; i < unique.length; i += 30) {
      const batch = unique.slice(i, i + 30);
      const rows = await this.data.read('dexscreener', `tokens:${batch.join(',')}`, 'analysis',
        () => this.http.get(`/tokens/v1/solana/${batch.join(',')}`), normalizeDexPairs);
      for (const p of rows) if (batch.includes(p.baseToken.address)) pairs.set(p.pairAddress, p);
    }
    return [...pairs.values()];
  }
  static selectPairs(pairs: DexPair[], now = Date.now(), maxAgeMs = 90_000, quotes: ReadonlySet<string> = QUOTE_MINTS): { selected: Map<string, DexPair>; rejected: Array<{ pool: string; reason: string }> } {
    const selected = new Map<string, DexPair>(); const rejected: Array<{ pool: string; reason: string }> = [];
    for (const p of pairs) {
      const reason = !quotes.has(p.quoteToken.address) ? 'UNSUPPORTED_QUOTE' :
        now - p.meta.receivedAt > maxAgeMs || now < p.meta.receivedAt ? 'STALE_PRICE' :
        !p.priceUsd || !p.liquidity?.usd ? 'MISSING_PRICE_OR_LIQUIDITY' :
        !p.pairCreatedAt ? 'UNKNOWN_POOL_AGE' : !p.txns?.h1 || p.txns.h1.buys + p.txns.h1.sells === 0 ? 'NO_RECENT_ACTIVITY' : null;
      if (reason) { rejected.push({ pool: p.pairAddress, reason }); continue; }
      const previous = selected.get(p.baseToken.address);
      if (!previous || p.liquidity!.usd! > previous.liquidity!.usd! || (p.liquidity!.usd === previous.liquidity!.usd && p.pairAddress < previous.pairAddress)) {
        if (previous) rejected.push({ pool: previous.pairAddress, reason: 'LOWER_LIQUIDITY_ALTERNATIVE' });
        selected.set(p.baseToken.address, p);
      } else rejected.push({ pool: p.pairAddress, reason: 'LOWER_LIQUIDITY_ALTERNATIVE' });
    }
    return { selected, rejected };
  }
  static bestPairPerToken(pairs: DexPair[]): Map<string, DexPair> { return this.selectPairs(pairs).selected; }
}

import { HttpClient } from './http-client';
import { TokenBucket } from '../utils/rate-limiter';
import type { Logger } from '../utils/logger';
import { QUOTE_MINTS } from '../core/types';

type Window = 'm5' | 'h1' | 'h6' | 'h24';

export interface DexPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Partial<Record<Window, { buys: number; sells: number }>>;
  volume?: Partial<Record<Window, number>>;
  priceChange?: Partial<Record<Window, number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

interface TokenListing {
  chainId: string;
  tokenAddress: string;
}

/**
 * DexScreener öffentliche API.
 * Limits laut Doku: Pair-/Token-Endpoints 300 req/min, Profile/Boosts 60 req/min.
 */
export class DexScreenerClient {
  private readonly pairsHttp: HttpClient;
  private readonly listingsHttp: HttpClient;

  constructor(logger: Logger) {
    const base = 'https://api.dexscreener.com';
    this.pairsHttp = new HttpClient({
      name: 'DexScreener',
      baseUrl: base,
      limiter: new TokenBucket(5, 4), // ~240/min
      logger,
    });
    this.listingsHttp = new HttpClient({
      name: 'DexScreener',
      baseUrl: base,
      limiter: new TokenBucket(2, 0.8), // ~48/min
      logger,
    });
  }

  /** Pairs für bis zu beliebig viele Mints (intern in 30er-Blöcken). */
  async getPairsForTokens(mints: string[]): Promise<DexPair[]> {
    const unique = [...new Set(mints)];
    const out: DexPair[] = [];
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const res = await this.pairsHttp.get<DexPair[] | { pairs?: DexPair[] | null }>(
        `/tokens/v1/solana/${chunk.join(',')}`,
      );
      const pairs = Array.isArray(res) ? res : (res.pairs ?? []);
      out.push(...pairs.filter((p) => p && p.chainId === 'solana'));
    }
    return out;
  }

  async getLatestBoostedTokens(): Promise<string[]> {
    return this.listingMints('/token-boosts/latest/v1');
  }

  async getTopBoostedTokens(): Promise<string[]> {
    return this.listingMints('/token-boosts/top/v1');
  }

  async getLatestProfiles(): Promise<string[]> {
    return this.listingMints('/token-profiles/latest/v1');
  }

  private async listingMints(path: string): Promise<string[]> {
    const res = await this.listingsHttp.get<TokenListing[] | unknown>(path);
    if (!Array.isArray(res)) return [];
    return (res as TokenListing[])
      .filter((t) => t && t.chainId === 'solana' && typeof t.tokenAddress === 'string')
      .map((t) => t.tokenAddress);
  }

  /** Liquidestes Pair pro Token (nur gegen SOL/USDC). */
  static bestPairPerToken(pairs: DexPair[]): Map<string, DexPair> {
    const best = new Map<string, DexPair>();
    for (const p of pairs) {
      if (!QUOTE_MINTS.has(p.quoteToken.address) || QUOTE_MINTS.has(p.baseToken.address)) continue;
      const current = best.get(p.baseToken.address);
      if (!current || (p.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
        best.set(p.baseToken.address, p);
      }
    }
    return best;
  }
}

import { DexScreenerClient, type DexListing, type DexPair } from '../data/dexscreener';
import type { GeckoPool, GeckoTerminalClient } from '../data/geckoterminal';
import { PRICE_QUOTE_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from '../core/types';
import { errorMessage } from '../utils/errors';
import { DESK } from './config';
import type { Graduation } from './migrations';
import type { CandidateMetrics, Migration, Tier } from './types';

export interface Discovered {
  mint: string; sources: string[]; boostAmount: number | null; description: string | null;
  links: DexListing['links']; geckoPool: GeckoPool | null;
}
export interface DiscoveryResult { tokens: Map<string, Discovered>; sources: Record<string, string> }

const QUOTE_SYMBOLS: Record<string, string> = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT' };
const isQuote = (mint: string): boolean => PRICE_QUOTE_MINTS.has(mint);

/**
 * Two-tier universe: trending / migrated tokens and freshly launched bonding-curve tokens, every pump.fun graduation
 * of the last 30 minutes read from the chain, plus the current watchlist.
 */
export async function discover(dex: DexScreenerClient, gecko: GeckoTerminalClient, watchlist: string[],
  graduations?: () => Promise<Graduation[]>): Promise<DiscoveryResult> {
  const tokens = new Map<string, Discovered>();
  const sources: Record<string, string> = {};
  const add = (mint: string, source: string, extra: Partial<Discovered> = {}) => {
    if (isQuote(mint)) return;
    const row = tokens.get(mint) ?? { mint, sources: [], boostAmount: null, description: null, links: [], geckoPool: null };
    if (!row.sources.includes(source)) row.sources.push(source);
    if (extra.boostAmount != null) row.boostAmount = Math.max(row.boostAmount ?? 0, extra.boostAmount);
    row.description ??= extra.description ?? null;
    if (extra.links?.length) row.links = [...row.links, ...extra.links.filter(l => !row.links.some(o => o.url === l.url))];
    row.geckoPool ??= extra.geckoPool ?? null;
    tokens.set(mint, row);
  };
  const jobs: Array<[string, Promise<void>]> = [
    ['DexScreener top boosts', dex.listingDetails('/token-boosts/top/v1').then(rows => rows.forEach(r => add(r.mint, 'top-boosts', r)))],
    ['DexScreener latest boosts', dex.listingDetails('/token-boosts/latest/v1').then(rows => rows.forEach(r => add(r.mint, 'latest-boosts', r)))],
    ['DexScreener latest profiles', dex.listingDetails('/token-profiles/latest/v1').then(rows => rows.forEach(r => add(r.mint, 'profiles', r)))],
    ['GeckoTerminal trending pools', gecko.getTrendingPools(1).then(pools => pools.filter(p => isQuote(p.quoteTokenMint))
      .forEach(p => add(p.baseTokenMint, 'gecko-trending', { geckoPool: p })))],
    ['GeckoTerminal new pools', gecko.getNewPools(1).then(pools => pools.filter(p => isQuote(p.quoteTokenMint))
      .forEach(p => add(p.baseTokenMint, p.dex === 'pump-fun' ? 'new-launch' : 'new-pool', { geckoPool: p })))],
    ...(graduations ? [['Pump.fun graduations (on-chain)', graduations().then(rows => rows.forEach(g => add(g.mint, 'graduated')))] as [string, Promise<void>]] : []),
  ];
  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  settled.forEach((r, i) => { sources[jobs[i]![0]] = r.status === 'fulfilled' ? 'OK' : `UNAVAILABLE: ${errorMessage(r.reason)}`; });
  for (const mint of watchlist) add(mint, 'watchlist');
  sources['Desk watchlist'] = `${watchlist.length} token(s)`;
  return { tokens, sources };
}

/** One observed pool per token: deepest supported liquidity, else the active bonding curve (which has no liquidity figure). */
/** A pool quoted in another token (COMMIE/AMC on 1 Oct: $116K) counts when it holds real liquidity. */
export const OTHER_QUOTE = Object.freeze({ minLiquidityUsd: 20_000, overStandard: 5 });
export function selectPair(pairs: DexPair[], mint: string, now: number): DexPair | null {
  const priced = pairs.filter(p => p.baseToken.address === mint && now - p.meta.receivedAt <= DESK.priceMaxAgeMs && now >= p.meta.receivedAt && p.priceUsd !== null);
  const rank = (p: DexPair) => [p.liquidity?.usd ?? -1, p.volume?.h1 ?? 0, p.pairAddress] as const;
  const best = (list: DexPair[]) => list.sort((a, b) => {
    const [la, va, pa] = rank(a), [lb, vb, pb] = rank(b);
    return lb - la || vb - va || pa.localeCompare(pb);
  })[0] ?? null;
  const standard = best(priced.filter(p => isQuote(p.quoteToken.address)));
  // Jupiter routes through any pool; the market's real price and volume are where its liquidity is.
  const other = best(priced.filter(p => !isQuote(p.quoteToken.address) && (p.liquidity?.usd ?? 0) >= OTHER_QUOTE.minLiquidityUsd));
  return other && (!standard || (other.liquidity?.usd ?? 0) >= OTHER_QUOTE.overStandard * (standard.liquidity?.usd ?? 0)) ? other : standard;
}

/** When the token appeared, from all its pools: the oldest one; and its first AMM (non-curve) pool. */
export function tokenTimes(pairs: DexPair[], mint: string): { createdAt: number | null; firstPoolAt: number | null } {
  const own = pairs.filter(p => p.baseToken.address === mint && p.pairCreatedAt);
  const min = (list: DexPair[]) => list.length ? Math.min(...list.map(p => p.pairCreatedAt!)) : null;
  return { createdAt: min(own), firstPoolAt: min(own.filter(p => p.dexId !== 'pumpfun')) };
}

export function migrationOf(pair: DexPair): Migration {
  if (pair.dexId === 'pumpfun') return 'BONDING_CURVE';
  if (pair.baseToken.address.endsWith('pump') || pair.dexId === 'pumpswap') return 'MIGRATED';
  return pair.dexId ? 'AMM' : 'UNKNOWN';
}

export function pairMetrics(pair: DexPair, now: number, times: { createdAt?: number | null; firstPoolAt?: number | null } = {}): CandidateMetrics {
  const buys = pair.txns?.m5?.buys ?? null, sells = pair.txns?.m5?.sells ?? null;
  const v5 = pair.volume?.m5 ?? null, v1h = pair.volume?.h1 ?? null;
  const age = (t: number | null | undefined) => t ? Math.max(0, (now - t) / 60_000) : null;
  const createdAt = times.createdAt ?? pair.pairCreatedAt ?? null;
  const firstPoolAt = times.firstPoolAt !== undefined ? times.firstPoolAt : pair.dexId === 'pumpfun' ? null : pair.pairCreatedAt ?? null;
  return {
    tokenAgeMin: age(createdAt), firstPoolAgeMin: age(firstPoolAt),
    priceChange6hPct: pair.priceChange?.h6 ?? null, priceChange24hPct: pair.priceChange?.h24 ?? null, volume24hUsd: pair.volume?.h24 ?? null,
    buys1h: pair.txns?.h1?.buys ?? null, sells1h: pair.txns?.h1?.sells ?? null, quote: pair.quoteToken.symbol ?? null,
    priceUsd: pair.priceUsd, marketCapUsd: pair.marketCap ?? pair.fdv, marketCapBasis: pair.marketCap !== null ? 'MARKET_CAP' : pair.fdv !== null ? 'FDV' : null,
    liquidityUsd: pair.liquidity?.usd ?? null, poolAgeMin: pair.pairCreatedAt ? Math.max(0, (now - pair.pairCreatedAt) / 60_000) : null,
    volume5mUsd: v5, volume1hUsd: v1h, buys5m: buys, sells5m: sells,
    // Sells of zero make the ratio undefined, not infinite; buys alone are shown separately.
    buySellRatio5m: buys !== null && sells !== null && sells > 0 ? buys / sells : null,
    // 5-minute volume against the hour's average 5-minute volume (1.0 = steady).
    volumeAcceleration: v5 !== null && v1h !== null && v1h > 0 ? v5 / (v1h / 12) : null,
    priceChange5mPct: pair.priceChange?.m5 ?? null, priceChange1hPct: pair.priceChange?.h1 ?? null,
    top10WalletPct: null, largestWalletPct: null, developerPct: null, washRatio: null, migration: migrationOf(pair),
  };
}

export type TierDecision = { tier: Tier } | { filtered: string };
/**
 * Tier by observed market cap. Launches stay in the ultra-early scanner while on the bonding curve (up to its
 * monitoring ceiling); once migrated they are judged by the trending strategy's hard gates.
 */
export function tierFor(m: CandidateMetrics): TierDecision {
  const cap = m.marketCapUsd, t = DESK.tiers;
  if (cap === null) return { filtered: 'Market cap unknown (no market cap or FDV reported)' };
  if (cap < t.ultraEarly.minMarketCapUsd) return { filtered: `Market cap $${Math.round(cap)} < $${t.ultraEarly.minMarketCapUsd}` };
  if (cap <= t.ultraEarly.maxMarketCapUsd) return { tier: 'ULTRA_EARLY' };
  if (m.migration === 'BONDING_CURVE') {
    return cap <= t.ultraEarly.monitorMaxMarketCapUsd ? { tier: 'ULTRA_EARLY' }
      : { filtered: `Bonding curve above $${t.ultraEarly.monitorMaxMarketCapUsd.toLocaleString('en-US')} without migrated liquidity` };
  }
  if (cap >= t.trending.maxMarketCapUsd) return { filtered: `Market cap $${Math.round(cap).toLocaleString('en-US')} ≥ $1M` };
  return { tier: 'TRENDING' };
}

export const quoteSymbol = (pair: DexPair): string | null => QUOTE_SYMBOLS[pair.quoteToken.address] ?? pair.quoteToken.symbol ?? null;

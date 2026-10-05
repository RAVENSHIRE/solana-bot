import type { Bar } from './history';
import type { Chain } from './scanner';

/**
 * Multi-chain market reads for the fundamentals layer: DexScreener for the current state of a token (every chain it
 * lists) and GeckoTerminal for its history. The desk's own clients (src/data) are Solana-only on purpose; this module
 * is read-only research and never feeds an order.
 */

/** GeckoTerminal network ids (DexScreener uses the chain names as they are). */
export const GECKO_NETWORK: Readonly<Record<Chain, string>> = Object.freeze({
  solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism',
});

export interface TokenMarket {
  chain: Chain; token: string; name: string | null; symbol: string | null;
  /** The pair with the most liquidity, where the token is the base token. */
  pairAddress: string; dexId: string; url: string | null;
  priceUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null; liquidityUsd: number | null;
  volume24hUsd: number | null; priceChange24hPct: number | null; buys24h: number | null; sells24h: number | null;
  /** Earliest pair creation across all of the token's pairs on this chain: a proxy for its launch. */
  firstPairAt: number | null;
  pairs: number;
  links: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => { const x = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN; return Number.isFinite(x) ? x : null; };
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const sameAddress = (chain: Chain, a: unknown, b: string) => typeof a === 'string' && (chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());

/** The token's main pair from a DexScreener `/latest/dex/tokens/{address}` answer, or null when it lists none. */
export function mainPair(raw: unknown, chain: Chain, token: string): TokenMarket | null {
  const pairs = (isObj(raw) && Array.isArray(raw.pairs) ? raw.pairs : []).filter(isObj)
    .filter(p => p.chainId === chain && isObj(p.baseToken) && sameAddress(chain, p.baseToken.address, token));
  if (!pairs.length) return null;
  const liq = (p: Obj) => (isObj(p.liquidity) ? num(p.liquidity.usd) : null) ?? 0;
  const p = [...pairs].sort((a, b) => liq(b) - liq(a))[0]!;
  const base = p.baseToken as Obj, info = isObj(p.info) ? p.info : {};
  const created = pairs.map(x => num(x.pairCreatedAt)).filter((x): x is number => x !== null && x > 0);
  const links = [...(Array.isArray(info.websites) ? info.websites : []), ...(Array.isArray(info.socials) ? info.socials : [])]
    .filter(isObj).map(l => str(l.url)).filter((u): u is string => u !== null);
  const h24 = (k: string) => { const v = p[k]; return isObj(v) ? v.h24 : undefined; };
  const tx = h24('txns');
  return {
    chain, token, name: str(base.name), symbol: str(base.symbol), pairAddress: String(p.pairAddress ?? ''), dexId: String(p.dexId ?? ''), url: str(p.url),
    priceUsd: num(p.priceUsd), marketCapUsd: num(p.marketCap), fdvUsd: num(p.fdv), liquidityUsd: isObj(p.liquidity) ? num(p.liquidity.usd) : null,
    volume24hUsd: num(h24('volume')), priceChange24hPct: num(h24('priceChange')),
    buys24h: isObj(tx) ? num(tx.buys) : null, sells24h: isObj(tx) ? num(tx.sells) : null,
    firstPairAt: created.length ? Math.min(...created) : null, pairs: pairs.length, links,
  };
}

/** Circulating supply implied by the snapshot (market cap ÷ price; FDV when no market cap is reported). */
export function impliedSupply(m: Pick<TokenMarket, 'priceUsd' | 'marketCapUsd' | 'fdvUsd'>): number | null {
  const cap = m.marketCapUsd ?? m.fdvUsd;
  return cap !== null && m.priceUsd !== null && m.priceUsd > 0 ? cap / m.priceUsd : null;
}

/**
 * GeckoTerminal OHLCV (price in USD, newest first) → market-cap bars, oldest first. Supply is taken as constant at its
 * current value: right for fixed-supply memecoins, wrong for coins that minted or burned a lot since.
 */
export function ohlcvToBars(raw: unknown, supply: number): Bar[] {
  const list = isObj(raw) && isObj(raw.data) && isObj(raw.data.attributes) && Array.isArray(raw.data.attributes.ohlcv_list) ? raw.data.attributes.ohlcv_list : [];
  const bars: Bar[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, o, h, l, c] = row.slice(0, 5).map(num);
    if (t == null || o == null || h == null || l == null || c == null || h <= 0 || l <= 0 || c <= 0) continue;
    bars.push({ t: t * 1000, o: o * supply, h: h * supply, l: l * supply, c: c * supply });
  }
  return bars.sort((a, b) => a.t - b.t);
}

export interface MarketDeps { fetcher?: typeof fetch; timeoutMs?: number }

async function getJson(url: string, d: MarketDeps, accept = 'application/json'): Promise<unknown> {
  const res = await (d.fetcher ?? fetch)(url, { headers: { accept }, signal: AbortSignal.timeout(d.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

export async function readMarket(chain: Chain, token: string, d: MarketDeps = {}): Promise<{ market: TokenMarket | null; raw: unknown }> {
  const raw = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, d);
  return { market: mainPair(raw, chain, token), raw };
}

export type Timeframe = 'day' | 'hour';
/** Up to 1,000 bars of one pool (1,000 days, or about 41 days of hours). */
export async function readHistory(chain: Chain, pool: string, token: string, timeframe: Timeframe, supply: number, d: MarketDeps = {}): Promise<Bar[]> {
  const q = new URLSearchParams({ aggregate: '1', limit: '1000', currency: 'usd', token, include_empty_intervals: 'false' });
  const raw = await getJson(`https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK[chain]}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}?${q}`,
    d, 'application/json;version=20230302');
  return ohlcvToBars(raw, supply);
}

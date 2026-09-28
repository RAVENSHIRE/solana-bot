import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { TokenSafetyChecker } from '../../../analysis/token-safety';
import { HttpClient } from '../../../data/http-client';
import { SOL_MINT, QUOTE_MINTS, type Candle } from '../../../core/types';
import type { ConnectionManager } from '../../../rpc/connection-manager';
import { TokenBucket } from '../../../utils/rate-limiter';
import type { Logger } from '../../../utils/logger';
import { hasThirtyMinuteSupport, type Snapshot, type EntryEvidence } from './model';

const numeric = z.union([z.number(), z.string().min(1)]).transform(Number).pipe(z.number().finite());
const pairSchema = z.object({
  chainId: z.string(), pairAddress: z.string(), baseToken: z.object({ address: z.string(), symbol: z.string() }),
  quoteToken: z.object({ address: z.string() }), priceUsd: numeric.nullish(), marketCap: numeric.nullish(),
  liquidity: z.object({ usd: numeric.nullish() }).nullish(),
  info: z.object({
    websites: z.array(z.object({ url: z.string() })).nullish(),
    socials: z.array(z.object({ type: z.string().optional(), platform: z.string().optional(), url: z.string().optional(), handle: z.string().optional() })).nullish(),
  }).nullish(),
});
const tradeSchema = z.object({ data: z.array(z.object({ id: z.string(), attributes: z.object({
  kind: z.enum(['buy', 'sell']), volume_in_usd: numeric, block_timestamp: z.string().datetime({ offset: true }),
  from_token_address: z.string(), to_token_address: z.string(),
}) })) });
export type PoolTrades = z.infer<typeof tradeSchema>['data'];
export function volumeWindow(rows: PoolTrades, now: number, mint: string): Pick<EntryEvidence, 'buyVolumeUsd' | 'sellVolumeUsd' | 'completeVolumeWindow'> {
  const start = now - 300_000;
  const unique = new Map(rows.map(r => [r.id, r]));
  const trades = [...unique.values()];
  const times = trades.map(t => Date.parse(t.attributes.block_timestamp));
  const valid = trades.every(t => Number.isFinite(t.attributes.volume_in_usd) && t.attributes.volume_in_usd >= 0 && Date.parse(t.attributes.block_timestamp) <= now &&
    ((t.attributes.to_token_address === mint) !== (t.attributes.from_token_address === mint)));
  // A response containing only recent trades may have been truncated: never guess volume share.
  const complete = valid && times.length > 0 && Math.min(...times) <= start && Math.max(...times) >= now - 90_000;
  if (!complete) return { buyVolumeUsd: null, sellVolumeUsd: null, completeVolumeWindow: false };
  let buy = 0, sell = 0;
  for (const t of trades) {
    if (Date.parse(t.attributes.block_timestamp) < start) continue;
    if (t.attributes.to_token_address === mint) buy += t.attributes.volume_in_usd; else sell += t.attributes.volume_in_usd;
  }
  return { buyVolumeUsd: buy, sellVolumeUsd: sell, completeVolumeWindow: true };
}

/** Owners aggregated across ALL standard SPL token accounts, including pool vault owners.
 * No unsupported claim that largest token accounts are largest wallets. */
export function ownerConcentration(accounts: Array<{ owner: string; amount: bigint }>, supply: bigint): number {
  if (supply <= 0n) throw new Error('Zero supply');
  const balances = new Map<string, bigint>();
  let total = 0n;
  for (const a of accounts) {
    if (a.amount < 0n) throw new Error('Negative balance');
    total += a.amount;
    balances.set(a.owner, (balances.get(a.owner) ?? 0n) + a.amount);
  }
  if (total !== supply) throw new Error('Holder snapshot does not reconcile to supply');
  const largest = [...balances.values()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0).slice(0, 10).reduce((a, b) => a + b, 0n);
  const fraction = Number(largest) / Number(supply);
  return largest * 4n > supply ? Math.max(fraction, 0.25 + Number.EPSILON) : fraction;
}
const positiveOrNull = (n: number | null | undefined): number | null => n != null && n > 0 ? n : null;
const website = (value: string): boolean => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
const twitter = (s: { type?: string; platform?: string; url?: string; handle?: string }): boolean => {
  if (s.url) { try { const u = new URL(s.url); return ['https:', 'http:'].includes(u.protocol) && /^(www\.)?(x|twitter)\.com$/.test(u.hostname) && u.pathname.length > 1; } catch { return false; } }
  return ['twitter', 'x'].includes(s.platform ?? s.type ?? '') && /^@?\w{1,15}$/.test(s.handle ?? '');
};

export class PlaybookMarket {
  private readonly dex: HttpClient;
  private readonly gecko: HttpClient;
  constructor(private readonly rpc: ConnectionManager, private readonly log: Logger) {
    this.dex = new HttpClient({ name: 'DEX Screener', baseUrl: 'https://api.dexscreener.com', limiter: new TokenBucket(1, 1), logger: log, timeoutMs: 10_000, retries: 0 });
    this.gecko = new HttpClient({ name: 'GeckoTerminal', baseUrl: 'https://api.geckoterminal.com/api/v2', limiter: new TokenBucket(1, 8 / 60), logger: log, timeoutMs: 10_000, retries: 0 });
  }
  async discover(): Promise<string[]> {
    const rows = z.array(z.object({ chainId: z.string(), tokenAddress: z.string() })).parse(await this.dex.get('/token-profiles/latest/v1'));
    return rows.filter(r => r.chainId === 'solana' && !QUOTE_MINTS.has(r.tokenAddress)).flatMap(r => {
      try { return [new PublicKey(r.tokenAddress).toBase58()]; } catch { return []; }
    }).slice(0, 40);
  }
  async snapshots(mints: string[], preferredPairs = new Map<string, string>()): Promise<Map<string, Snapshot>> {
    const pairs: z.infer<typeof pairSchema>[] = [];
    const all = [...new Set([...mints, SOL_MINT])];
    for (let i = 0; i < all.length; i += 30) pairs.push(...pairSchema.array().parse(await this.dex.get(`/tokens/v1/solana/${all.slice(i, i + 30).join(',')}`)));
    const valid = pairs.filter(p => p.chainId === 'solana' && QUOTE_MINTS.has(p.quoteToken.address) && positiveOrNull(p.priceUsd));
    const sol = valid.filter(p => p.baseToken.address === SOL_MINT).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]?.priceUsd ?? null;
    const result = new Map<string, Snapshot>();
    for (const mint of mints) {
      const preferred = preferredPairs.get(mint);
      const p = valid.filter(p => p.baseToken.address === mint && (!preferred || p.pairAddress === preferred))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!p) continue;
      result.set(mint, { mint, symbol: p.baseToken.symbol, pairAddress: p.pairAddress, observedAt: Date.now(), priceUsd: p.priceUsd!,
        marketCapUsd: positiveOrNull(p.marketCap), liquidityUsd: positiveOrNull(p.liquidity?.usd),
        hasWebsite: p.info?.websites?.some(w => website(w.url)) ?? false, hasTwitter: p.info?.socials?.some(twitter) ?? false, solUsd: sol });
    }
    return result;
  }
  async evidence(s: Snapshot, reentry: boolean): Promise<{ evidence: EntryEvidence; decimals: number }> {
    // Fresh scanner per entry attempt; do not use the old 30-minute safety cache.
    const safety = await new TokenSafetyChecker(this.rpc, this.log).safeCheck(s.mint, { rejectMintAuthority: true });
    const evidence: EntryEvidence = { safetyOk: safety.ok, safetyReasons: [...safety.reasons], top10OwnerFraction: null,
      buyVolumeUsd: null, sellVolumeUsd: null, completeVolumeWindow: false, consolidated: false };
    if (!safety.ok) return { evidence, decimals: safety.decimals };
    if (safety.isToken2022) {
      evidence.safetyOk = false; evidence.safetyReasons.push('Token-2022 holder enumeration not supported by this profile');
      return { evidence, decimals: safety.decimals };
    }
    try {
      const mint = new PublicKey(s.mint);
      const supply = await this.rpc.execute('playbookSupply', c => c.getTokenSupply(mint, 'finalized'), { attempts: 1 });
      const accounts = await this.rpc.execute('playbookHolders', c => c.getProgramAccounts(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), {
        commitment: 'finalized', minContextSlot: supply.context.slot,
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: s.mint } }], dataSlice: { offset: 32, length: 40 },
      }), { attempts: 1 });
      evidence.top10OwnerFraction = ownerConcentration(accounts.map(a => {
        if (a.account.data.length !== 40) throw new Error('Malformed holder account');
        return { owner: new PublicKey(a.account.data.subarray(0, 32)).toBase58(), amount: a.account.data.readBigUInt64LE(32) };
      }), BigInt(supply.value.amount));
    } catch {
      evidence.safetyReasons.push('Complete holder snapshot unavailable');
      return { evidence, decimals: safety.decimals };
    }
    if (evidence.top10OwnerFraction > 0.25) return { evidence, decimals: safety.decimals };
    const trades = tradeSchema.parse(await this.gecko.get(`/networks/solana/pools/${s.pairAddress}/trades`, { trade_volume_in_usd_greater_than: 0 }));
    Object.assign(evidence, volumeWindow(trades.data, Date.now(), s.mint));
    if (reentry && evidence.completeVolumeWindow) {
      const data = z.object({ data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.tuple([numeric, numeric, numeric, numeric, numeric, numeric])) }) }) })
        .parse(await this.gecko.get(`/networks/solana/pools/${s.pairAddress}/ohlcv/minute`, { aggregate: 1, limit: 40, currency: 'usd', token: s.mint, include_empty_intervals: false }));
      const candles: Candle[] = data.data.attributes.ohlcv_list.map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }));
      evidence.consolidated = hasThirtyMinuteSupport(candles, Date.now(), s.priceUsd);
    }
    return { evidence, decimals: safety.decimals };
  }
}

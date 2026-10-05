import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { TokenSafety, TokenSafetyChecker } from '../analysis/token-safety';
import { analyzeVolumeQuality } from '../analysis/wash-trading';
import type { GeckoTerminalClient } from '../data/geckoterminal';
import { exactNumber, parse, rawAmount } from '../data/core/data-validator';
import { errorMessage } from '../utils/errors';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** One owner among the largest token accounts; PROGRAM = an off-curve owner (pool vault, bonding curve, locker). */
export interface HolderRow { owner: string; pct: number; kind: 'WALLET' | 'PROGRAM' }
export interface Holders {
  supplyRaw: bigint; decimals: number; walletTop10Pct: number; largestWalletPct: number;
  programOwnedPct: number; accountsInspected: number; at: number;
  /** The largest holders by owner (from the 20 largest token accounts), largest first. */
  top: HolderRow[];
  /** Owners with a non-zero balance; null when the RPC cannot count them (see countNote). */
  count: number | null; countCapped: boolean; countNote: string | null; countAt: number | null;
}
export interface Developer { creator: string; heldPct: number; source: string }
export interface TradeFlow { trades: number; uniqueWallets: number; washRatio: number; topWalletShare: number; flags: string[] }
export interface OnchainEvidence {
  safety: TokenSafety | null; holders: Holders | null; developer: Developer | null; flow: TradeFlow | null;
  errors: Record<string, string>;
}

const largestSchema = z.object({ value: z.array(z.object({ address: z.instanceof(PublicKey), amount: rawAmount })) });
const parsedOwner = z.object({ parsed: z.object({ info: z.object({ owner: z.string(), mint: z.string() }) }) });

/**
 * Holder concentration counts wallets only. Accounts owned by program addresses (pools, bonding curves,
 * lockers) are off-curve owners and reported separately rather than guessed to be whales.
 */
export async function holders(rpc: ConnectionManager, mint: string): Promise<Holders> {
  const key = new PublicKey(mint);
  const supply = await rpc.execute('desk:supply', c => c.getTokenSupply(key, 'confirmed'));
  const supplyRaw = BigInt(parse(z.string().regex(/^\d+$/), supply.value.amount, 'solana-rpc'));
  if (supplyRaw <= 0n) throw new Error('Token supply is zero');
  const largest = largestSchema.parse(await rpc.execute('desk:largest', c => c.getTokenLargestAccounts(key, 'confirmed')));
  const infos = await rpc.execute('desk:holder-owners', c => c.getMultipleParsedAccounts(largest.value.map(a => a.address), { commitment: 'confirmed' }));
  const byOwner = new Map<string, bigint>(), programs = new Map<string, bigint>(); let program = 0n;
  largest.value.forEach((row, i) => {
    const parsed = parsedOwner.safeParse(infos.value[i]?.data);
    if (!parsed.success || parsed.data.parsed.info.mint !== mint) return;
    const owner = new PublicKey(parsed.data.parsed.info.owner), key = owner.toBase58();
    if (PublicKey.isOnCurve(owner.toBytes())) byOwner.set(key, (byOwner.get(key) ?? 0n) + row.amount);
    else { program += row.amount; programs.set(key, (programs.get(key) ?? 0n) + row.amount); }
  });
  const desc = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0);
  const wallets = [...byOwner.values()].sort(desc);
  const pct = (raw: bigint) => exactNumber(raw * 1_000_000n / supplyRaw) / 10_000;
  const top: HolderRow[] = [...[...byOwner].map(([owner, raw]) => ({ owner, raw, kind: 'WALLET' as const })), ...[...programs].map(([owner, raw]) => ({ owner, raw, kind: 'PROGRAM' as const }))]
    .sort((a, b) => desc(a.raw, b.raw)).slice(0, 20).map(({ owner, raw, kind }) => ({ owner, pct: pct(raw), kind }));
  return { supplyRaw, decimals: supply.value.decimals, walletTop10Pct: pct(wallets.slice(0, 10).reduce((s, v) => s + v, 0n)),
    largestWalletPct: pct(wallets[0] ?? 0n), programOwnedPct: pct(program), accountsInspected: largest.value.length, at: Date.now(),
    top, count: null, countCapped: false, countNote: null, countAt: null };
}

const tokenAccountsPage = z.object({ token_accounts: z.array(z.object({ owner: z.string(), amount: z.union([z.number(), z.string()]) })) });

/**
 * Number of owners with a non-zero balance, from the DAS `getTokenAccounts` method (Helius and compatible RPCs),
 * 1,000 accounts per page. Stops after `maxPages`: the count is then a lower bound (countCapped).
 */
export async function holderCount(rpc: ConnectionManager, mint: string, maxPages: number): Promise<{ count: number; capped: boolean }> {
  const owners = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const res = await rpc.execute('desk:holder-count', c => (c as unknown as { _rpcRequest(method: string, args: unknown): Promise<{ result?: unknown; error?: { message: string } }> })
      ._rpcRequest('getTokenAccounts', { mint, page, limit: 1000, options: { showZeroBalance: false } }));
    if (res.error) throw new Error(res.error.message);
    const rows = tokenAccountsPage.parse(res.result).token_accounts;
    for (const r of rows) if (Number(r.amount) > 0) owners.add(r.owner);
    if (rows.length < 1000) return { count: owners.size, capped: false };
  }
  return { count: owners.size, capped: true };
}

/** pump.fun records the creator in its bonding-curve account (offset 49). Other launch venues: UNKNOWN. */
export async function developer(rpc: ConnectionManager, mint: string, supplyRaw: bigint): Promise<Developer | null> {
  const key = new PublicKey(mint);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), key.toBuffer()], PUMP_PROGRAM);
  const account = await rpc.execute('desk:bonding-curve', c => c.getAccountInfo(curve, 'confirmed'));
  if (!account || !account.owner.equals(PUMP_PROGRAM) || account.data.length < 81) return null;
  const creator = new PublicKey(account.data.subarray(49, 81));
  if (creator.equals(PublicKey.default)) return null;
  const owned = await rpc.execute('desk:creator-balance', c => c.getParsedTokenAccountsByOwner(creator, { mint: key }, 'confirmed'));
  let held = 0n;
  for (const row of owned.value) {
    const amount = z.object({ parsed: z.object({ info: z.object({ tokenAmount: z.object({ amount: rawAmount }) }) }) }).safeParse(row.account.data);
    if (amount.success) held += amount.data.parsed.info.tokenAmount.amount;
  }
  return { creator: creator.toBase58(), heldPct: exactNumber(held * 1_000_000n / supplyRaw) / 10_000, source: 'pump.fun bonding-curve creator field' };
}

/** Current share of supply held by a known creator (for the dev-selling exit). */
export async function creatorHolding(rpc: ConnectionManager, creator: string, mint: string): Promise<number> {
  const key = new PublicKey(mint);
  const supply = await rpc.execute('desk:supply', c => c.getTokenSupply(key, 'confirmed'));
  const supplyRaw = BigInt(parse(z.string().regex(/^\d+$/), supply.value.amount, 'solana-rpc'));
  const owned = await rpc.execute('desk:creator-balance', c => c.getParsedTokenAccountsByOwner(new PublicKey(creator), { mint: key }, 'confirmed'));
  let held = 0n;
  for (const row of owned.value) {
    const amount = z.object({ parsed: z.object({ info: z.object({ tokenAmount: z.object({ amount: rawAmount }) }) }) }).safeParse(row.account.data);
    if (amount.success) held += amount.data.parsed.info.tokenAmount.amount;
  }
  return supplyRaw > 0n ? exactNumber(held * 1_000_000n / supplyRaw) / 10_000 : 0;
}

export async function tradeFlow(gecko: GeckoTerminalClient, pool: string, mint: string): Promise<TradeFlow> {
  const trades = await gecko.getTradeEvents(pool, mint);
  const q = analyzeVolumeQuality(trades);
  return { trades: q.tradeCount, uniqueWallets: q.uniqueWallets, washRatio: q.washRatio, topWalletShare: q.topWalletShare, flags: [...q.flags] };
}

/** Every source is independent: one outage leaves its fields UNKNOWN instead of failing the candidate. */
export async function gatherOnchain(rpc: ConnectionManager, safety: TokenSafetyChecker, gecko: GeckoTerminalClient,
  mint: string, pool: string, pumpToken: boolean, includeTrades: boolean): Promise<OnchainEvidence> {
  const errors: Record<string, string> = {};
  const attempt = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
    try { return await work(); } catch (error) { errors[name] = errorMessage(error); return null; }
  };
  const [checked, held, flow] = await Promise.all([
    attempt('mint', () => safety.check(mint, { rejectMintAuthority: true })),
    attempt('holders', () => holders(rpc, mint)),
    // Trade flow is rate-limited upstream; it is fetched only where it can still change an entry decision.
    includeTrades ? attempt('trades', () => tradeFlow(gecko, pool, mint)) : Promise.resolve(null),
  ]);
  const dev = held && pumpToken ? await attempt('developer', () => developer(rpc, mint, held.supplyRaw)) : null;
  return { safety: checked, holders: held, developer: dev, flow, errors };
}

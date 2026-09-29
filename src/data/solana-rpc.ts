import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { z } from 'zod';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { DataRuntime } from './core/data-runtime';
import { address, parse, rawAmount, safeInteger } from './core/data-validator';
import { DataError, observation, type TokenSafetyResult, type WalletActivity } from './core/data-types';

export const mintInfoSchema = z.object({ decimals: z.number().int().min(0).max(255), supply: rawAmount,
  mintAuthority: address.nullable(), freezeAuthority: address.nullable(), isInitialized: z.boolean(),
  extensions: z.array(z.object({ extension: z.string().min(1), state: z.record(z.unknown()).optional() })).optional() });
export function parseMintAccount(account: { owner: PublicKey; data: unknown } | null): z.infer<typeof mintInfoSchema> & { isToken2022: boolean } {
  if (!account || (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new DataError('on-chain-verification', 'solana-rpc', 'account is not an SPL mint');
  const parsed = parse(z.object({ program: z.enum(['spl-token', 'spl-token-2022']), parsed: z.object({ type: z.literal('mint'), info: mintInfoSchema }) }), account.data, 'solana-rpc');
  const isToken2022 = account.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (isToken2022 !== (parsed.program === 'spl-token-2022')) throw new DataError('invalid-response', 'solana-rpc', 'mint program mismatch');
  return { ...parsed.parsed.info, isToken2022 };
}
/** Read-only adapter over the existing failover/confirmation infrastructure. Never signs. */
export class SolanaDataClient {
  constructor(private readonly rpc: ConnectionManager, private readonly data: DataRuntime) {}
  async verifyMint(mint: string): Promise<TokenSafetyResult> {
    parse(address, mint, 'solana-rpc');
    try {
      const res = await this.rpc.execute('data:mint', c => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
      const info = parseMintAccount(res.value);
      const result: TokenSafetyResult = { meta: observation('solana-rpc', Date.now(), mint, null), status: info.isInitialized ? 'verified' : 'rejected',
        supplyRaw: info.supply, decimals: info.decimals, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority,
        reasons: info.isInitialized ? [] : ['MINT_UNINITIALIZED'] };
      this.data.record('mint-verification', 'solana-rpc', { ...result, slot: res.context.slot, extensions: info.extensions }); return result;
    } catch (error) {
      const rejected = error instanceof DataError && error.kind === 'on-chain-verification';
      const result: TokenSafetyResult = { meta: { ...observation('solana-rpc', Date.now(), mint, null), validation: rejected ? 'valid' : 'unavailable' }, status: rejected ? 'rejected' : 'unavailable',
        supplyRaw: null, decimals: null, mintAuthority: null, freezeAuthority: null, reasons: [rejected ? 'NOT_SPL_MINT' : 'VERIFICATION_UNAVAILABLE'] };
      this.data.record('mint-verification', 'solana-rpc', result); return result;
    }
  }
  async walletBalance(wallet: string): Promise<{ rawLamports: bigint; meta: ReturnType<typeof observation> }> {
    parse(address, wallet, 'solana-rpc');
    const amount = await this.rpc.execute('data:balance', c => c.getBalance(new PublicKey(wallet), 'confirmed'));
    const result = { rawLamports: BigInt(parse(safeInteger, amount, 'solana-rpc')), meta: observation('solana-rpc', Date.now(), null, null) };
    this.data.record('wallet-balance', 'solana-rpc', { wallet, ...result }); return result;
  }
  async poolAccount(pool: string, expectedOwner: string): Promise<{ verified: boolean; meta: ReturnType<typeof observation> }> {
    parse(address, pool, 'solana-rpc'); parse(address, expectedOwner, 'solana-rpc');
    const account = await this.rpc.execute('data:pool', c => c.getAccountInfo(new PublicKey(pool), 'confirmed'));
    const result = { verified: !!account && !account.executable && account.owner.toBase58() === expectedOwner, meta: observation('solana-rpc', Date.now(), null, pool) };
    this.data.record('pool-verification', 'solana-rpc', result); return result;
  }
  async recentActivity(wallet: string, limit = 50): Promise<WalletActivity> {
    parse(address, wallet, 'solana-rpc'); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid activity limit');
    const rows = await this.rpc.execute('data:signatures', c => c.getSignaturesForAddress(new PublicKey(wallet), { limit }, 'confirmed'));
    const result: WalletActivity = { meta: observation('solana-rpc', Date.now(), null, null), wallet,
      signatures: rows.map(r => ({ signature: r.signature, slot: parse(safeInteger, r.slot, 'solana-rpc'), blockTime: r.blockTime ?? null, failed: r.err !== null })), economicOwnershipVerified: false };
    this.data.record('wallet-activity', 'solana-rpc', result); return result;
  }
}

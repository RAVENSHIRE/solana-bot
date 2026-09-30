import { PublicKey, type Connection } from '@solana/web3.js';
import type { ConnectionManager } from '../rpc/connection-manager';
import { SOL_MINT } from '../core/types';

/** pump.fun's migration authority: it signs every bonding-curve graduation into a PumpSwap pool (MigrateV2 → CreatePool). */
export const PUMP_MIGRATION_AUTHORITY = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

export interface Graduation { mint: string; signature: string; at: number }

/** The fields of a confirmed transaction that identify a graduation (same shape in json and jsonParsed encodings). */
export interface MigrationTx { meta: { err: unknown; logMessages?: string[] | null; preTokenBalances?: Array<{ mint: string }> | null; postTokenBalances?: Array<{ mint: string }> | null } | null }

/**
 * Reads a transaction of any version. Migrations may be version 1 transactions, which clients that request
 * version 0 at most are refused ("Transaction version (1) is not supported by the requesting client").
 */
export async function migrationTx(c: Connection, signature: string): Promise<MigrationTx | null> {
  const rpc = c as unknown as { _rpcRequest(method: string, args: unknown[]): Promise<{ result?: MigrationTx | null; error?: { message: string } }> };
  const res = await rpc._rpcRequest('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
  if (res.error) throw new Error(res.error.message);
  return res.result ?? null;
}

/** The graduating token of a migration transaction (MigrateV2 → CreatePool), or null for any other transaction. */
export function graduatedMint(tx: MigrationTx | null): string | null {
  const logs = tx?.meta?.logMessages ?? [];
  if (!tx || tx.meta?.err || !logs.some(l => /Instruction: Migrate/.test(l)) || !logs.some(l => /Instruction: CreatePool/.test(l))) return null;
  // The graduating token already existed before this transaction; the LP mint it creates did not.
  const before = new Set((tx.meta?.preTokenBalances ?? []).map(b => b.mint));
  const mints = [...new Set((tx.meta?.postTokenBalances ?? []).map(b => b.mint))].filter(m => m !== SOL_MINT);
  return mints.find(m => before.has(m)) ?? (mints.length === 1 ? mints[0]! : null);
}

/**
 * Every pump.fun graduation, read from the chain: the migration authority's recent signatures, then each new
 * transaction's token balances. About two graduations a minute, so one signature page per scan covers every one of
 * them — unlike aggregator "new pools" pages, which scroll past a pool within a minute. Graduations stay in
 * discovery for `windowMs`.
 */
export class GraduationFeed {
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly recent = new Map<string, Graduation>();
  constructor(private readonly rpc: ConnectionManager, private readonly windowMs = 30 * 60_000, private readonly maxNewPerPoll = 12) {}

  async poll(now = Date.now()): Promise<Graduation[]> {
    const sigs = await this.rpc.execute('desk:graduations', c => c.getSignaturesForAddress(PUMP_MIGRATION_AUTHORITY, { limit: 40 }, 'confirmed'));
    const fresh = sigs.filter(s => !s.err && s.blockTime && !this.seen.has(s.signature) && s.blockTime * 1000 >= now - this.windowMs)
      .sort((a, b) => b.blockTime! - a.blockTime!).slice(0, this.maxNewPerPoll);
    for (const s of fresh) {
      let tx: MigrationTx | null;
      try { tx = await this.rpc.execute('desk:graduation-tx', c => migrationTx(c, s.signature)); }
      catch {
        // One unreadable transaction must never hide the other graduations; it is retried twice, then skipped.
        const n = (this.failures.get(s.signature) ?? 0) + 1;
        this.failures.set(s.signature, n);
        if (n >= 3) { this.seen.add(s.signature); this.failures.delete(s.signature); }
        if (this.failures.size > 1_000) this.failures.clear();
        continue;
      }
      this.seen.add(s.signature); this.failures.delete(s.signature);
      const mint = graduatedMint(tx);
      if (mint) this.recent.set(mint, { mint, signature: s.signature, at: s.blockTime! * 1000 });
    }
    for (const [mint, g] of this.recent) if (now - g.at > this.windowMs) this.recent.delete(mint);
    if (this.seen.size > 5_000) for (const sig of [...this.seen].slice(0, 2_500)) this.seen.delete(sig);
    return [...this.recent.values()].sort((a, b) => b.at - a.at);
  }
}

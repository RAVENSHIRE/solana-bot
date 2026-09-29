import { PublicKey } from '@solana/web3.js';
import type { ConnectionManager } from '../rpc/connection-manager';
import { SOL_MINT } from '../core/types';

/** pump.fun's migration authority: it signs every bonding-curve graduation into a PumpSwap pool (MigrateV2 → CreatePool). */
export const PUMP_MIGRATION_AUTHORITY = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

export interface Graduation { mint: string; signature: string; at: number }

/**
 * Every pump.fun graduation, read from the chain: the migration authority's recent signatures, then each new
 * transaction's token balances. About two graduations a minute, so one signature page per scan covers every one of
 * them — unlike aggregator "new pools" pages, which scroll past a pool within a minute. Graduations stay in
 * discovery for `windowMs`.
 */
export class GraduationFeed {
  private readonly seen = new Set<string>();
  private readonly recent = new Map<string, Graduation>();
  constructor(private readonly rpc: ConnectionManager, private readonly windowMs = 30 * 60_000, private readonly maxNewPerPoll = 12) {}

  async poll(now = Date.now()): Promise<Graduation[]> {
    const sigs = await this.rpc.execute('desk:graduations', c => c.getSignaturesForAddress(PUMP_MIGRATION_AUTHORITY, { limit: 40 }, 'confirmed'));
    const fresh = sigs.filter(s => !s.err && s.blockTime && !this.seen.has(s.signature) && s.blockTime * 1000 >= now - this.windowMs)
      .sort((a, b) => b.blockTime! - a.blockTime!).slice(0, this.maxNewPerPoll);
    for (const s of fresh) {
      const tx = await this.rpc.execute('desk:graduation-tx', c => c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
      this.seen.add(s.signature);
      const logs = tx?.meta?.logMessages ?? [];
      if (!tx || tx.meta?.err || !logs.some(l => /Instruction: Migrate/.test(l)) || !logs.some(l => /Instruction: CreatePool/.test(l))) continue;
      // The graduating token already existed before this transaction; the LP mint it creates did not.
      const before = new Set((tx.meta?.preTokenBalances ?? []).map(b => b.mint));
      const mints = [...new Set((tx.meta?.postTokenBalances ?? []).map(b => b.mint))].filter(m => m !== SOL_MINT);
      const mint = mints.find(m => before.has(m)) ?? (mints.length === 1 ? mints[0] : undefined);
      if (mint) this.recent.set(mint, { mint, signature: s.signature, at: s.blockTime! * 1000 });
    }
    for (const [mint, g] of this.recent) if (now - g.at > this.windowMs) this.recent.delete(mint);
    if (this.seen.size > 5_000) for (const sig of [...this.seen].slice(0, 2_500)) this.seen.delete(sig);
    return [...this.recent.values()].sort((a, b) => b.at - a.at);
  }
}

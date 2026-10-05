import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { TransactionSender } from '../execution/tx-sender';
import { signTransactionChecked, type TransactionSigner } from '../execution/transaction-signer';
import { listTokenAccounts, type OwnedTokenAccount } from '../execution/token-accounts';
import { parse, safeInteger } from '../data/core/data-validator';
import { DeskReject } from './guard';

export interface RentReclaim { accounts: OwnedTokenAccount[]; reclaimedLamports: bigint; feeLamports: bigint; signature: string }

/**
 * Returns the rent of the wallet's empty token accounts for the given (desk-traded) mints. Scoped by construction:
 * only accounts the wallet owns, holding zero tokens, closable by the wallet; the transaction holds nothing but
 * compute-budget and CloseAccount instructions with the wallet as destination, and it is simulated before signing.
 * Returns null when there is nothing to close.
 */
export async function reclaimRent(d: { rpc: ConnectionManager; sender: TransactionSender; owner: PublicKey; signer: TransactionSigner; mints: readonly string[] }): Promise<RentReclaim | null> {
  if (!d.signer.publicKey.equals(d.owner)) throw new DeskReject('INVALID_PAYER');
  const wanted = new Set(d.mints);
  const accounts = (await listTokenAccounts(d.rpc, d.owner)).filter(a => wanted.has(a.mint) && a.closable && a.amountRaw === 0n).slice(0, 8);
  if (!accounts.length) return null;
  const { blockhash, lastValidBlockHeight } = await d.rpc.execute('desk:rent-blockhash', c => c.getLatestBlockhash('confirmed'));
  const message = new TransactionMessage({ payerKey: d.owner, recentBlockhash: blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 + 6_000 * accounts.length }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    ...accounts.map(a => createCloseAccountInstruction(a.pubkey, d.owner, d.owner, [], a.programId)),
  ] }).compileToV0Message();
  let tx = new VersionedTransaction(message);
  const rent = accounts.reduce((s, a) => s + BigInt(a.lamports), 0n);
  const fee = await d.rpc.execute('desk:rent-fee', c => c.getFeeForMessage(message, 'confirmed'));
  if (fee.value === null) throw new DeskReject('ACTUAL_FEE_UNAVAILABLE');
  const feeLamports = BigInt(parse(safeInteger, fee.value, 'solana-rpc'));
  if (feeLamports >= rent) return null;
  const before = BigInt(parse(safeInteger, await d.rpc.execute('desk:rent-balance', c => c.getBalance(d.owner, 'confirmed')), 'solana-rpc'));
  const sim = await d.rpc.execute('desk:rent-simulate', c => c.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [d.owner.toBase58()] } }));
  if (sim.value.err) throw new DeskReject('RENT_SIMULATION_FAILED', JSON.stringify(sim.value.err).slice(0, 200));
  const after = sim.value.accounts?.[0];
  // The wallet may gain at most the closed accounts' rent; anything else means the transaction is not what was built.
  if (!after || BigInt(parse(safeInteger, after.lamports, 'solana-rpc')) - before > rent) throw new DeskReject('RENT_SIMULATION_MISMATCH');
  tx = await signTransactionChecked(d.signer, tx, { expiresAt: Date.now() + 30_000 });
  const { signature } = await d.sender.sendAndConfirm(tx, lastValidBlockHeight);
  return { accounts, reclaimedLamports: rent, feeLamports, signature };
}

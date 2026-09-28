import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Keypair,
  type ParsedAccountData,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { TransactionSender } from './tx-sender';
import type { Logger } from '../utils/logger';
import { z } from 'zod';
import { address, parse, rawAmount, safeInteger } from '../data/core/data-validator';
import { DataError } from '../data/core/data-types';
import { errorMessage } from '../utils/errors';

export interface OwnedTokenAccount {
  pubkey: PublicKey;
  mint: string;
  programId: PublicKey;
  amountRaw: bigint;
  lamports: number;
  /** Leer, nicht eingefroren und keine einbehaltenen Token-2022-Transfer-Fees. */
  closable: boolean;
}

const tokenAccountInfo = z.object({ mint: address, owner: address, state: z.enum(['initialized', 'frozen', 'uninitialized']),
  closeAuthority: address.nullish(), tokenAmount: z.object({ amount: rawAmount }),
  extensions: z.array(z.object({ extension: z.string(), state: z.object({ withheldAmount: rawAmount.optional() }).passthrough().optional() })).optional() });
export function parseOwnedTokenAccount(item: { pubkey: PublicKey; account: AccountInfo<ParsedAccountData> }, owner: PublicKey, expectedMint?: string): OwnedTokenAccount {
  if (!item.account.owner.equals(TOKEN_PROGRAM_ID) && !item.account.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new DataError('on-chain-verification', 'solana-rpc', 'unexpected token account program');
  const parsed = parse(z.object({ type: z.literal('account'), info: tokenAccountInfo }), item.account.data.parsed, 'solana-rpc');
  const info = parsed.info;
  if (info.owner !== owner.toBase58() || (expectedMint && info.mint !== expectedMint)) throw new DataError('on-chain-verification', 'solana-rpc', 'token account ownership or mint mismatch');
  const withheld = info.extensions?.find(e => e.extension === 'transferFeeAmount');
  const clearWithheld = !withheld || withheld.state?.withheldAmount === 0n;
  return { pubkey: item.pubkey, mint: info.mint, programId: item.account.owner, amountRaw: info.tokenAmount.amount,
    lamports: parse(safeInteger, item.account.lamports, 'solana-rpc'),
    closable: info.tokenAmount.amount === 0n && info.state === 'initialized' && clearWithheld && (!info.closeAuthority || info.closeAuthority === owner.toBase58()) };
}

export async function listTokenAccounts(
  rpc: ConnectionManager,
  owner: PublicKey,
  mint?: string,
): Promise<OwnedTokenAccount[]> {
  if (mint) {
    const res = await rpc.execute('getParsedTokenAccountsByOwner(mint)', (c) =>
      c.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }),
    );
    return res.value.map(item => parseOwnedTokenAccount(item, owner, mint));
  }
  const results = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      rpc.execute('getParsedTokenAccountsByOwner(program)', (c) => c.getParsedTokenAccountsByOwner(owner, { programId })),
    ),
  );
  return results
    .flatMap((r) => r.value)
    .map(item => parseOwnedTokenAccount(item, owner));
}

/** Schließt leere Token-Konten in Batches und holt die Rent zurück in die Wallet. */
export async function closeTokenAccounts(
  rpc: ConnectionManager,
  sender: TransactionSender,
  wallet: Keypair,
  accounts: OwnedTokenAccount[],
  log: Logger,
  batchSize = 8,
): Promise<{ closed: number; reclaimedLamports: bigint; signatures: string[] }> {
  const closable = accounts.filter((a) => a.closable);
  let closed = 0;
  let reclaimed = 0n;
  const signatures: string[] = [];

  for (let i = 0; i < closable.length; i += batchSize) {
    const batch = closable.slice(i, i + batchSize);
    try {
      const { blockhash, lastValidBlockHeight } = await rpc.execute('getLatestBlockhash', (c) =>
        c.getLatestBlockhash('confirmed'),
      );
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 + 6_000 * batch.length }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
        ...batch.map((a) => createCloseAccountInstruction(a.pubkey, wallet.publicKey, wallet.publicKey, [], a.programId)),
      ];
      const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([wallet]);
      const { signature } = await sender.sendAndConfirm(tx, lastValidBlockHeight);
      closed += batch.length;
      reclaimed += batch.reduce((sum, a) => sum + BigInt(a.lamports), 0n);
      signatures.push(signature);
    } catch (e) {
      log.warn('Schließen von Token-Konten fehlgeschlagen', {
        accounts: batch.map((a) => a.pubkey.toBase58()),
        error: errorMessage(e),
      });
    }
  }
  return { closed, reclaimedLamports: reclaimed, signatures };
}

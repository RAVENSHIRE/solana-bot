import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import type { VersionedTransaction } from '@solana/web3.js';
import { parseSecretKey } from '../utils/wallet';
import type { TransactionSigner } from '../execution/transaction-signer';
import { DeskReject } from './guard';

/**
 * LIVE signer backed by WALLET_PRIVATE_KEY in the local .env — used only when the owner opts in with
 * DESK_LIVE_SIGNER=local-key. The key is parsed in this process only, checked against WALLET_PUBLIC_KEY when set,
 * and never logged, returned or sent anywhere; errors never include it. Every order still passes the execution guard.
 */
export async function localKeySigner(envDir: string): Promise<TransactionSigner> {
  let env: Record<string, string>;
  try { env = parseEnv(await fs.readFile(path.join(envDir, '.env'))); } catch { throw new DeskReject('LOCAL_ENV_MISSING'); }
  const secret = env.WALLET_PRIVATE_KEY;
  if (!secret) throw new DeskReject('LOCAL_KEY_MISSING', 'WALLET_PRIVATE_KEY is not set in .env');
  let keypair: ReturnType<typeof parseSecretKey>;
  try { keypair = parseSecretKey(secret); } catch { throw new DeskReject('LOCAL_KEY_INVALID', 'WALLET_PRIVATE_KEY is not a base58 or JSON secret key'); }
  const expected = env.WALLET_PUBLIC_KEY?.trim();
  if (expected && expected !== keypair.publicKey.toBase58()) throw new DeskReject('LOCAL_KEY_MISMATCH', 'WALLET_PUBLIC_KEY does not match WALLET_PRIVATE_KEY');
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: VersionedTransaction) => { tx.sign([keypair]); return tx; },
  };
}

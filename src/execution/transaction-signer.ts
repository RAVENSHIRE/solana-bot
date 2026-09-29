import { createPublicKey, verify } from 'node:crypto';
import { VersionedTransaction, type Keypair, type PublicKey } from '@solana/web3.js';

export interface SigningContext { expiresAt: number }

/** A browser wallet supplies signatures, never its secret key. */
export interface TransactionSigner {
  readonly publicKey: PublicKey;
  signTransaction(transaction: VersionedTransaction, context: SigningContext): Promise<VersionedTransaction>;
}

export class SigningError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SigningError'; }
}

export function isTransactionSigner(wallet: Keypair | TransactionSigner): wallet is TransactionSigner {
  return 'signTransaction' in wallet && typeof wallet.signTransaction === 'function';
}

export function requireSigningDeadline(expiresAt: number, now = Date.now()): void {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now)
    throw new SigningError('SIGNING_DEADLINE_EXPIRED');
}

/** Single owner signature is the only permitted signing authority for these swaps. */
export function validateSignerMessage(transaction: VersionedTransaction, owner: PublicKey): void {
  if (transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1 ||
      !transaction.message.staticAccountKeys[0]?.equals(owner))
    throw new SigningError('SIGNER_OR_FEE_PAYER_MISMATCH');
}

/** Reject wallet/provider mutations, including a valid signature over a different message. */
export function validateSignedTransaction(transaction: VersionedTransaction, expectedMessage: Uint8Array, owner: PublicKey): void {
  validateSignerMessage(transaction, owner);
  const message = Buffer.from(transaction.message.serialize());
  if (!message.equals(Buffer.from(expectedMessage))) throw new SigningError('SIGNED_MESSAGE_CHANGED');
  const signature = transaction.signatures[0];
  if (!signature || signature.length !== 64) throw new SigningError('INVALID_WALLET_SIGNATURE');
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), owner.toBuffer()]),
    format: 'der', type: 'spki' });
  if (!verify(null, message, key, signature)) throw new SigningError('INVALID_WALLET_SIGNATURE');
}

export async function signTransactionChecked(wallet: Keypair | TransactionSigner, transaction: VersionedTransaction,
  context: SigningContext): Promise<VersionedTransaction> {
  requireSigningDeadline(context.expiresAt);
  validateSignerMessage(transaction, wallet.publicKey);
  const expected = Buffer.from(transaction.message.serialize());
  // Isolate our authorized message from a wallet implementation which mutates its input.
  const candidate = VersionedTransaction.deserialize(transaction.serialize());
  let signed: VersionedTransaction;
  if (isTransactionSigner(wallet)) signed = await wallet.signTransaction(candidate, context);
  else { candidate.sign([wallet]); signed = candidate; }
  requireSigningDeadline(context.expiresAt);
  validateSignedTransaction(signed, expected, wallet.publicKey);
  // Retain an independent snapshot: the provider cannot change it after this check.
  return VersionedTransaction.deserialize(signed.serialize());
}

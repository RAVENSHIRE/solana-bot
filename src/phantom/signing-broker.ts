import { randomBytes } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { requireSigningDeadline, SigningError, validateSignedTransaction, validateSignerMessage,
  type SigningContext, type TransactionSigner } from '../execution/transaction-signer';

export interface SigningSession { sessionId: string; address: string; expiresAt: number }
export interface PendingSignature {
  requestId: string;
  address: string;
  transactionBase64: string;
  expiresAt: number;
}
interface WaitingSignature {
  request: PendingSignature;
  message: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
  resolve: (transaction: VersionedTransaction) => void;
  reject: (error: Error) => void;
}

/** Transport independent. The HTTP layer must authenticate capabilities and origin. */
export class SigningBroker {
  private session: SigningSession | null = null;
  private waiting: WaitingSignature | null = null;
  private readonly sessionTtlMs: number;
  private readonly maxRequestMs: number;
  private readonly now: () => number;

  constructor(options: { sessionTtlMs?: number; maxRequestMs?: number; now?: () => number } = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 300_000;
    this.maxRequestMs = options.maxRequestMs ?? 15_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1 || this.sessionTtlMs > 900_000 ||
        !Number.isSafeInteger(this.maxRequestMs) || this.maxRequestMs < 1 || this.maxRequestMs > 15_000)
      throw new SigningError('INVALID_SIGNING_LIFETIME');
  }

  connect(address: string): SigningSession {
    const owner = new PublicKey(address);
    if (!PublicKey.isOnCurve(owner.toBytes()) || owner.toBase58() !== address)
      throw new SigningError('INVALID_SIGNING_ADDRESS');
    this.cancelPending('WALLET_SESSION_REPLACED');
    this.session = { sessionId: randomBytes(32).toString('base64url'), address,
      expiresAt: this.now() + this.sessionTtlMs };
    return { ...this.session };
  }

  /** No signing capability or session ID is exposed in public connection information. */
  connection(): { connected: boolean; address: string | null; expiresAt: number | null } {
    this.expireSession();
    return { connected: this.session !== null, address: this.session?.address ?? null, expiresAt: this.session?.expiresAt ?? null };
  }

  status(sessionId: string): SigningSession {
    return { ...this.requireSession(sessionId) };
  }

  /** Authenticated browser activity renews inactivity expiry; an expired session cannot revive. */
  heartbeat(sessionId:string):void {
    this.requireSession(sessionId).expiresAt=this.now()+this.sessionTtlMs;
  }

  pending(sessionId: string): PendingSignature | null {
    this.requireSession(sessionId);
    if (this.waiting && this.waiting.request.expiresAt <= this.now()) this.cancelPending('SIGNING_DEADLINE_EXPIRED');
    return this.waiting ? { ...this.waiting.request } : null;
  }

  signer(sessionId: string): TransactionSigner {
    const session = this.requireSession(sessionId);
    const owner = new PublicKey(session.address);
    return { publicKey: owner, signTransaction: (transaction, context) => this.request(sessionId, owner, transaction, context) };
  }

  resolve(sessionId: string, requestId: string, signedBase64: string): void {
    const session = this.requireSession(sessionId);
    const waiting = this.requirePending(requestId);
    try {
      requireSigningDeadline(waiting.request.expiresAt, this.now());
      // A Solana wire transaction cannot exceed 1232 bytes. Reject lax base64 decoding.
      if (typeof signedBase64 !== 'string' || signedBase64.length > 1644 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(signedBase64)) throw new SigningError('INVALID_SIGNED_TRANSACTION');
      const bytes = Buffer.from(signedBase64, 'base64');
      if (bytes.length > 1232 || bytes.toString('base64') !== signedBase64)
        throw new SigningError('INVALID_SIGNED_TRANSACTION');
      const signed = VersionedTransaction.deserialize(bytes);
      validateSignedTransaction(signed, waiting.message, new PublicKey(session.address));
      clearTimeout(waiting.timer);
      this.waiting = null;
      waiting.resolve(signed);
    } catch (error) {
      this.cancelPending(error instanceof SigningError ? error.code : 'INVALID_SIGNED_TRANSACTION');
      throw error;
    }
  }

  reject(sessionId: string, requestId: string): void {
    this.requireSession(sessionId);
    this.requirePending(requestId);
    this.cancelPending('WALLET_SIGNATURE_REJECTED');
  }

  disconnect(sessionId: string): void {
    this.requireSession(sessionId);
    this.cancelPending('WALLET_DISCONNECTED');
    this.session = null;
  }

  cancel():void {this.cancelPending('STOP_REQUESTED');}

  private request(sessionId: string, owner: PublicKey, transaction: VersionedTransaction, context: SigningContext): Promise<VersionedTransaction> {
    try {
      const session = this.requireSession(sessionId);
      if (session.address !== owner.toBase58()) throw new SigningError('WALLET_SESSION_MISMATCH');
      if (this.waiting) throw new SigningError('SIGNATURE_ALREADY_PENDING');
      validateSignerMessage(transaction, owner);
      if (transaction.signatures.some(signature => signature.some(byte => byte !== 0)))
        throw new SigningError('TRANSACTION_ALREADY_SIGNED');
      requireSigningDeadline(context.expiresAt, this.now());
      const expiresAt = Math.min(context.expiresAt, session.expiresAt, this.now() + this.maxRequestMs);
      requireSigningDeadline(expiresAt, this.now());
      const bytes = transaction.serialize();
      if (bytes.length > 1232) throw new SigningError('TRANSACTION_TOO_LARGE');
      const request: PendingSignature = { requestId: randomBytes(24).toString('base64url'), address: session.address,
        transactionBase64: Buffer.from(bytes).toString('base64'), expiresAt };
      return new Promise<VersionedTransaction>((resolve, reject) => {
        const timer = setTimeout(() => this.cancelPending('SIGNING_DEADLINE_EXPIRED'), expiresAt - this.now());
        this.waiting = { request, message: Buffer.from(transaction.message.serialize()), timer, resolve, reject };
      });
    } catch (error) { return Promise.reject(error); }
  }

  private requirePending(requestId: string): WaitingSignature {
    if (!this.waiting || this.waiting.request.requestId !== requestId) throw new SigningError('SIGNATURE_REQUEST_MISMATCH');
    return this.waiting;
  }

  private expireSession(): void {
    if (this.session && this.session.expiresAt <= this.now()) {
      this.cancelPending('WALLET_SESSION_EXPIRED');
      this.session = null;
    }
  }

  private requireSession(sessionId: string): SigningSession {
    this.expireSession();
    if (!this.session || this.session.sessionId !== sessionId) throw new SigningError('WALLET_SESSION_MISMATCH');
    return this.session;
  }

  private cancelPending(code: string): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    waiting.reject(new SigningError(code));
  }
}

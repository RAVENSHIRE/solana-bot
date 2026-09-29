import type { VersionedTransaction } from '@solana/web3.js';
import type { SwapRequest } from './executor';
import type { JupiterQuote, JupiterSwapResponse } from './jupiter-client';
/** Gates run before signing; onSigned persists the signature before broadcasting. */
export interface ExecutionGuard {
  /** Synchronous final stop/session check, after the durable signature write. */
  assertActive?():void;
  onSigned?(transaction:VersionedTransaction):Promise<void>;
  beforeBuild(request:SwapRequest, quote:JupiterQuote):Promise<{priorityFeeCapLamports:number}>;
  beforeSign(request:SwapRequest,quote:JupiterQuote,tx:VersionedTransaction,built:JupiterSwapResponse):Promise<void>;
  beforeSend(request:SwapRequest,quote:JupiterQuote,tx:VersionedTransaction):Promise<void>;
}

import type { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config/config';
import type { ConnectionManager } from '../rpc/connection-manager';
import { ESTIMATED_SWAP_COMPUTE_UNITS, SOL_MINT, type ExecMode, type Side } from '../core/types';
import { JupiterClient, type JupiterQuote } from './jupiter-client';
import { errorMessage } from '../utils/errors';
import type { Logger } from '../utils/logger';

/** Jeder Swap ist SOL ↔ Token. `amountRaw` ist Lamports (BUY) bzw. Token-Rohbetrag (SELL). */
export interface SwapRequest {
  side: Side;
  mint: string;
  amountRaw: bigint;
  slippageBps: number;
  maxPriceImpactPct?: number;
}

export interface SwapFill {
  simulated: boolean;
  signature: string | null;
  side: Side;
  mint: string;
  inAmountRaw: bigint;
  outAmountRaw: bigint;
  quotedOutRaw: bigint;
  minOutRaw: bigint;
  /** Netto-Veränderung des SOL-Saldos der Wallet (negativ bei BUY). Enthält Fees & Rent. */
  solDeltaLamports: bigint;
  feeLamports: bigint;
  rentLamports: bigint;
  priceImpactPct: number;
  realizedSlippageBps: number;
  route: string;
  latencyMs: number;
}

export type SwapStage = 'quote' | 'impact' | 'build' | 'simulate' | 'send' | 'confirm' | 'slippage' | 'unknown';

export class SwapError extends Error {
  constructor(
    message: string,
    public readonly stage: SwapStage,
    /** Tatsächlich/virtuell bezahlte Gebühren trotz Fehlschlag (on-chain gescheitert). */
    public readonly feeLamports: bigint = 0n,
    public readonly signature: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SwapError';
  }

  /** Fehler in der Ausführung (zählen für den Circuit Breaker), nicht bloß "kein Quote". */
  get isExecutionFailure(): boolean {
    return ['simulate', 'send', 'confirm', 'slippage', 'unknown'].includes(this.stage);
  }
}

export interface RentReclaimResult {
  found: number;
  closed: number;
  reclaimableLamports: bigint;
  reclaimedLamports: bigint;
  signatures: string[];
}

export interface TradeExecutor {
  readonly mode: ExecMode;
  readonly owner: PublicKey;
  swap(req: SwapRequest): Promise<SwapFill>;
  getSolBalanceLamports(): Promise<bigint>;
  getTokenBalanceRaw(mint: string): Promise<bigint>;
  /** Schließt das (leere) Token-Konto für `mint`, gibt zurückgeholte Lamports zurück. */
  closeTokenAccountIfEmpty(mint: string): Promise<bigint>;
  /** Findet leere Token-Konten (ohne excludeMints) und schließt sie (nur LIVE). */
  reclaimEmptyAccounts(excludeMints: ReadonlySet<string>): Promise<RentReclaimResult>;
  estimatePriorityFeeLamports(): Promise<bigint>;
}

export interface ExecutorDeps {
  cfg: AppConfig;
  rpc: ConnectionManager;
  jupiter: JupiterClient;
  logger: Logger;
  owner: PublicKey;
}

export abstract class BaseExecutor implements TradeExecutor {
  abstract readonly mode: ExecMode;
  private priorityCache: { value: bigint; at: number } | null = null;

  protected constructor(protected readonly deps: ExecutorDeps) {}

  get owner(): PublicKey {
    return this.deps.owner;
  }

  abstract swap(req: SwapRequest): Promise<SwapFill>;
  abstract getSolBalanceLamports(): Promise<bigint>;
  abstract getTokenBalanceRaw(mint: string): Promise<bigint>;
  abstract closeTokenAccountIfEmpty(mint: string): Promise<bigint>;
  abstract reclaimEmptyAccounts(excludeMints: ReadonlySet<string>): Promise<RentReclaimResult>;

  protected mintsFor(req: SwapRequest): { inputMint: string; outputMint: string } {
    if (req.mint === SOL_MINT) throw new SwapError('Token-Mint darf nicht SOL sein', 'quote');
    return req.side === 'BUY' ? { inputMint: SOL_MINT, outputMint: req.mint } : { inputMint: req.mint, outputMint: SOL_MINT };
  }

  /** Holt einen Quote und erzwingt das Price-Impact-Limit. */
  protected async checkedQuote(req: SwapRequest): Promise<JupiterQuote> {
    const { inputMint, outputMint } = this.mintsFor(req);
    let quote: JupiterQuote;
    try {
      quote = await this.deps.jupiter.quote({ inputMint, outputMint, amountRaw: req.amountRaw, slippageBps: req.slippageBps });
    } catch (e) {
      throw new SwapError(`Quote fehlgeschlagen: ${errorMessage(e)}`, 'quote', 0n, null, { cause: e });
    }
    const impact = JupiterClient.priceImpactPct(quote);
    const limit = req.maxPriceImpactPct ?? this.deps.cfg.execution.maxPriceImpactPct;
    if (impact > limit) {
      throw new SwapError(`Price Impact ${impact.toFixed(2)} % > Limit ${limit} %`, 'impact');
    }
    return quote;
  }

  /**
   * Schätzt die Priority-Fee eines Swaps aus getRecentPrioritizationFees
   * (Perzentil passend zu PRIORITY_LEVEL), gedeckelt durch MAX_PRIORITY_FEE_LAMPORTS.
   */
  async estimatePriorityFeeLamports(): Promise<bigint> {
    if (this.priorityCache && Date.now() - this.priorityCache.at < 30_000) return this.priorityCache.value;
    const cap = BigInt(this.deps.cfg.jupiter.maxPriorityFeeLamports);
    try {
      const fees = await this.deps.rpc.execute('getRecentPrioritizationFees', (c) => c.getRecentPrioritizationFees());
      const values = fees
        .map((f) => f.prioritizationFee)
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      const level = this.deps.cfg.jupiter.priorityLevel;
      const pct = level === 'medium' ? 0.5 : level === 'high' ? 0.75 : 0.9;
      const microLamportsPerCu = values.length > 0 ? values[Math.min(values.length - 1, Math.floor(values.length * pct))]! : 0;
      const estimate = BigInt(Math.ceil((microLamportsPerCu * ESTIMATED_SWAP_COMPUTE_UNITS) / 1_000_000));
      const value = estimate > cap ? cap : estimate;
      this.priorityCache = { value, at: Date.now() };
      return value;
    } catch (e) {
      this.deps.logger.debug('Priority-Fee-Schätzung fehlgeschlagen – nutze Fallback', { error: errorMessage(e) });
      return this.priorityCache?.value ?? cap / 4n;
    }
  }
}

/**
 * Gemeinsame Domänentypen und Konstanten für alle Module.
 */

export type Side = 'BUY' | 'SELL';
export type ExecMode = 'LIVE' | 'SIMULATION';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Quote-Assets, gegen die gehandelt wird (werden nie selbst als "Token" behandelt). */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([SOL_MINT, USDC_MINT]);

/** Basisgebühr pro Signatur in Lamports. */
export const BASE_FEE_LAMPORTS = 5_000n;
/** Rent-Exemption eines SPL-Token-Kontos (165 Bytes) – rückholbar beim Schließen. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Konservative Compute-Unit-Schätzung für einen Jupiter-Swap (für Fee-Kalkulation). */
export const ESTIMATED_SWAP_COMPUTE_UNITS = 300_000;

export const BASE58_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface Candle {
  /** Unix-Zeit in Millisekunden (Kerzenbeginn) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volumen in USD */
  v: number;
}

export interface PoolTrade {
  /** Provider event identity; one transaction can contain multiple trades. */
  id?: string;
  txHash: string;
  wallet: string;
  kind: 'buy' | 'sell';
  volumeUsd: number;
  ts: number;
  priceUsd: number;
  tokenAmount: number;
}

export interface ExitRules {
  takeProfitPct: number;
  stopLossPct: number;
  /** Trailing-Stop wird erst ab diesem Gewinn (in %) scharf geschaltet. */
  trailingActivationPct: number;
  /** Abstand vom Hoch (in %), bei dem der Trailing-Stop auslöst. 0 = deaktiviert. */
  trailingStopPct: number;
  maxHoldMs: number;
}

export interface Position {
  id: string;
  strategy: string;
  mint: string;
  symbol: string;
  decimals: number;
  pairAddress: string | null;
  tokenAmountRaw: bigint;
  /** Gesamter SOL-Abfluss beim Einstieg inkl. Netzwerk-/Priority-Fees und ATA-Rent. */
  costLamports: bigint;
  /** Reiner Swap-Input in Lamports. */
  entryInputLamports: bigint;
  entryPriceUsd: number | null;
  openedAt: number;
  peakValueLamports: bigint;
  lastValueLamports: bigint;
  lastCheckedAt: number;
  exitRules: ExitRules;
  entrySignal: string;
  tags: Record<string, string | number | boolean>;
  closing: boolean;
  exitFailures: number;
  valuationMisses: number;
}

export interface ClosedTrade {
  id: string;
  strategy: string;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costLamports: bigint;
  proceedsLamports: bigint;
  pnlLamports: bigint;
  pnlPct: number;
  reason: string;
  entrySignal: string;
}

/** Simulierte (Paper-)LP-Position für die Fee-Harvesting-Analyse. Werte in Lamports als number. */
export interface LpPaperPosition {
  id: string;
  strategy: string;
  poolId: string;
  pairName: string;
  tokenMint: string;
  tokenIsMintA: boolean;
  depositLamports: number;
  entryTokenPriceSol: number;
  lastTokenPriceSol: number;
  feeAprPct: number;
  accruedFeesLamports: number;
  unhedgedPnlLamports: number;
  deltaNeutralPnlLamports: number;
  openedAt: number;
  lastUpdateAt: number;
  missedUpdates: number;
}

export interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
  realizedPnlLamports: bigint;
  feesLamports: bigint;
}

export type TradeAction =
  | 'BUY'
  | 'SELL'
  | 'BUY_FAILED'
  | 'SELL_FAILED'
  | 'WRITE_OFF'
  | 'LP_OPEN'
  | 'LP_CLOSE'
  | 'RENT_RECLAIM';

export interface TradeRecord {
  ts: string;
  mode: ExecMode;
  strategy: string;
  action: TradeAction;
  symbol: string;
  mint: string;
  signal: string;
  inAmount: string;
  outAmount: string;
  feesSol: string;
  priceImpactPct: number | null;
  slippageBps: number | null;
  signature: string | null;
  pnlSol: string | null;
  pnlPct: number | null;
  note?: string;
}

/** Vertrag, den jedes Strategie-Plugin erfüllt. Die Engine kennt nur dieses Interface. */
export interface Strategy {
  readonly name: string;
  readonly enabled: boolean;
  readonly scanIntervalMs: number;
  readonly manageIntervalMs: number;
  init(): Promise<void>;
  /** Marktanalyse + Einstiege */
  scan(): Promise<void>;
  /** Verwaltung offener Positionen (Exits) */
  manage(): Promise<void>;
  shutdown(): Promise<void>;
}

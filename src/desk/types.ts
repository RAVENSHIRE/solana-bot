/** Shared by the desk engine, the local API and the dashboard. Type-only; no runtime dependencies. */
export type DeskMode = 'PAPER' | 'LIVE';
/** FAIR: fair-launch trend strategy with momentum confirmation. CRASH: 1–4 minute momentum trades with tight exits. */
export type StrategyId = 'FAIR' | 'CRASH';

export type Stage = 'SYSTEM' | 'SCANNING' | 'FILTERED' | 'WATCHLIST' | 'WAITING' | 'QUALIFIED' | 'QUOTE' | 'ROUTE' |
  'SIMULATION' | 'PREFLIGHT' | 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'POSITION' | 'EXIT' | 'PNL';

export interface DeskEvent {
  id: number; at: number; mode: DeskMode; stage: Stage;
  mint: string | null; symbol: string | null; message: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** OBSERVED: read from a source. DERIVED: computed from observations. INFERRED: an interpretation. */
export type EvidenceKind = 'OBSERVED' | 'DERIVED' | 'INFERRED';
export interface Evidence {
  key: string; label: string; kind: EvidenceKind;
  /** null means UNKNOWN / UNVERIFIED; it is never replaced by a default. */
  value: string | number | boolean | null;
  display: string; source: string; at: number | null; note?: string;
}

export type GateStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export interface GateResult { key: string; label: string; status: GateStatus; actual: string; required: string; blocking: boolean }

export type ScoreKey = 'FUNDAMENTAL' | 'SOCIAL' | 'MARKET' | 'ONCHAIN' | 'RISK' | 'MOMENTUM';
export interface ScoreFactor { label: string; points: number; max: number; basis: string }
export interface ComponentScore { key: ScoreKey; score: number; factors: ScoreFactor[] }

export type Tier = 'TRENDING' | 'ULTRA_EARLY';
export type Classification = 'EARLY' | 'PROMISING' | 'WATCH' | 'HIGH_RISK' | 'REJECT' | 'WAITING' | 'QUALIFIED';
export type CandidateStatus = 'FILTERED' | 'WATCHLIST' | 'WAITING' | 'QUALIFIED';
export type Authenticity = 'VERIFIED' | 'LIKELY' | 'UNCERTAIN' | 'SUSPICIOUS' | 'UNVERIFIED';
export type Migration = 'BONDING_CURVE' | 'MIGRATED' | 'AMM' | 'UNKNOWN';

export interface CandidateMetrics {
  priceUsd: number | null; marketCapUsd: number | null; marketCapBasis: 'MARKET_CAP' | 'FDV' | null;
  liquidityUsd: number | null; poolAgeMin: number | null; volume5mUsd: number | null; volume1hUsd: number | null;
  buys5m: number | null; sells5m: number | null; buySellRatio5m: number | null; volumeAcceleration: number | null;
  priceChange5mPct: number | null; priceChange1hPct: number | null; top10WalletPct: number | null;
  largestWalletPct: number | null; developerPct: number | null; washRatio: number | null; migration: Migration;
}

export interface CandidateSocial {
  website: string | null; websiteStatus: string; description: string | null;
  x: { kind: 'ACCOUNT' | 'POST' | 'COMMUNITY' | 'NONE'; handle: string | null; url: string | null };
  xAccountCreatedAt: string | null; xFollowers: number | null; xPosts7d: number | null; xEngagementRatePct: number | null;
  narrativeVelocity: string; authenticity: Authenticity; authenticityFlags: string[];
}

export interface Candidate {
  mint: string; symbol: string | null; name: string | null; tier: Tier; sources: string[];
  pair: { address: string; dex: string; quote: string | null; url: string };
  status: CandidateStatus; classification: Classification; reasons: string[];
  metrics: CandidateMetrics; social: CandidateSocial;
  onchain: { mintAuthority: boolean | null; freezeAuthority: boolean | null; token2022: boolean | null; risks: string[]; decimals: number | null };
  evidence: Evidence[]; gates: GateResult[]; scores: ComponentScore[]; riskFlags: string[];
  firstSeenAt: number; updatedAt: number; deepAnalyzedAt: number | null; observations: number;
  /** Consecutive scans, including this one, in which every hard gate passed and momentum held. */
  momentumStreak: number;
  /** CRASH entry checks for this scan; null until computed. */
  crash: CrashSignal | null;
  /** Largest holders and holder count; null until first read. */
  holders: HolderView | null;
  /** Status view only: why a strategy did not enter this token (skip, cooldown, slots, sleeve…). */
  entryNotes?: Partial<Record<StrategyId, string>>;
  /** Status view only: not re-assessed in the last completed scan; its data is a past snapshot and is never traded on. */
  stale?: boolean;
}

export interface CrashSignal { signal: boolean; checks: GateResult[]; summary: string }

/** Holder snapshot for the dashboard. DEV = the pump.fun creator; PROGRAM = pool vault, bonding curve or locker. */
export interface HolderView {
  count: number | null; countCapped: boolean; countNote: string | null;
  top10WalletPct: number; largestWalletPct: number; programOwnedPct: number;
  top: Array<{ owner: string; pct: number; kind: 'WALLET' | 'PROGRAM' | 'DEV' }>; at: number;
}

export type SignatureState = 'NOT_REQUESTED_TEST' | 'AWAITING_PHANTOM' | 'SIGNED' | 'REJECTED' | 'EXPIRED' | 'NOT_REACHED';
export interface Preflight {
  id: string; at: number; mode: DeskMode; side: 'BUY' | 'SELL'; mint: string; symbol: string | null;
  router: string; route: string; ammKeys: string[];
  amountIn: string; expectedOut: string; minimumOut: string; entrySizeUsd: number | null;
  priceImpactPct: number; slippageBps: number; priorityFeeLamports: string; networkFeeLamports: string;
  accountRentLamports: string; dragPct: number | null;
  simulation: { status: 'PASSED' | 'FAILED' | 'NOT_POSSIBLE'; detail: string; solDeltaLamports: string | null; tokenDeltaRaw: string | null };
  balanceCheck: { ok: boolean; detail: string }; riskStatus: string;
  signature: SignatureState; txSignature: string | null; outcome: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'PAPER_FILLED' | 'BLOCKED' | 'PROBE_NOT_BOOKED';
}

export interface DeskPosition {
  id: string; mint: string; symbol: string | null; decimals: number; openedAt: number;
  qtyRaw: string; costLamports: string; costUsd: number; entryPriceUsd: number | null;
  peakValueLamports: string; lastValueLamports: string | null; lastPriceUsd: number | null;
  router: string; route: string; entrySignature: string | null; rentLamports: string; pairAddress: string;
  /** Context at entry for early-warning exits; absent in ledgers written before they existed. */
  entryLiquidityUsd?: number | null; creator?: string | null; creatorPctAtEntry?: number | null;
  /** Status view only: the strategy whose ledger holds the position. */
  strategy?: StrategyId;
  /** Status view only: EXIT NOW was requested and the sell is being attempted. */
  exitRequested?: boolean;
  /** Since when Jupiter has refused to route this token (no sell route); null or absent while it routes. */
  noRouteSince?: number | null;
}

export interface LedgerEntry {
  id: string; at: number; mode: DeskMode; txSignature: string | null; mint: string; symbol: string | null;
  router: string; route: string; side: 'BUY' | 'SELL'; quantity: string; qtyRaw: string;
  entryPriceUsd: number | null; exitPriceUsd: number | null; grossPnlUsd: number | null;
  networkFeeLamports: string; networkFeeUsd: number | null; routerFeeUsd: number | null; totalFeesUsd: number | null;
  netPnlUsd: number | null; solDeltaLamports: string; status: 'CONFIRMED' | 'PAPER_FILLED' | 'FAILED' | 'UNKNOWN'; note: string | null;
  /** SELL: token-account rent charged to this trade and not yet returned by closing the account. */
  rentOutstandingLamports?: string;
  /** Status view only: the strategy whose ledger holds the row. */
  strategy?: StrategyId;
}

export interface StrategyStats {
  /** Closed strategy trades; TEST drill trades are counted separately and never included. */
  trades: number; wins: number; losses: number; winRatePct: number | null; netPnlUsd: number;
  avgReturnPct: number | null; bestReturnPct: number | null; worstReturnPct: number | null; avgHoldSec: number | null;
  /** Gross profit ÷ gross loss; null without a losing trade. */
  profitFactor: number | null; maxDrawdownUsd: number; drillTrades: number; failedOrders: number;
}
export interface ScaleCheck { label: string; ok: boolean; actual: string; required: string }
export interface ScaleAdvice {
  currentEntryUsd: number; nextEntryUsd: number | null; ready: boolean; checks: ScaleCheck[];
  /** Pool liquidity needed at the next size to keep price impact near 2 %. */
  nextMinLiquidityUsd: number | null; note: string;
}
export interface StrategyView {
  id: StrategyId; label: string; summary: string; enabled: boolean;
  capitalUsd: number; entryUsd: number; slippageBps: number; maxDragPct: number; maxOpenPositions: number; positionCheckSec: number;
  exitRules: string[]; reentryCooldownMin?: number;
  cashUsd: number | null; openPositions: number; realizedPnlUsd: number; unrealizedPnlUsd: number | null; feesUsd: number; halted: string | null;
  /** TEST: completed sleeve cycles (auto re-funded after running dry); stats and realized PnL include them. */
  cycles: number;
  stats: StrategyStats; scale: ScaleAdvice;
}

export interface DeskCapitalView {
  plannedStartingCapitalUsd: number; baseEntryUsd: number; reserveSol: number; maxDragPct: number; slippageBps: number;
  walletSol: number | null; walletUsd: number | null; solUsd: number | null;
  availableSol: number | null; reservedSol: number | null; spendableUsd: number | null;
  paperCashUsd: number | null; openPositions: number; positionsValueUsd: number | null;
  unrealizedPnlUsd: number | null; realizedPnlUsd: number; totalFeesUsd: number; equityUsd: number | null; lastWalletSync: number | null;
}

export interface DeskStatus {
  mode: DeskMode; label: string; scanner: boolean; execution: boolean;
  operational?: import('./config').DeskOperational;
  /** CONFIGURED: TEST is using WALLET_PUBLIC_KEY from .env because Phantom is not connected (address only, never a signer). */
  wallet: { connected: boolean; address: string | null; source?: 'PHANTOM' | 'CONFIGURED' | 'LOCAL_KEY' };
  drill: boolean;
  /** LIVE only: PHANTOM (browser approval per order) or LOCAL_KEY (signed by WALLET_PRIVATE_KEY, unattended). */
  signer: 'PHANTOM' | 'LOCAL_KEY' | null;
  /** LIVE only: new entries this session may still open (null = no cap). */
  entriesLeft: number | null;
  strategies: StrategyView[];
  capital: DeskCapitalView; message: string | null; halted: string | null;
  lastScanAt: number | null; nextScanAt: number | null; scanning: boolean;
  events: DeskEvent[]; candidates: Candidate[]; preflights: Preflight[];
  positions: DeskPosition[]; ledger: LedgerEntry[]; sources: Record<string, string>;
  path: Array<{ layer: string; provider: string }>;
}

/** Shared by the desk engine, the local API and the dashboard. Type-only; no runtime dependencies. */
export type DeskMode = 'PAPER' | 'LIVE';

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
}

export interface LedgerEntry {
  id: string; at: number; mode: DeskMode; txSignature: string | null; mint: string; symbol: string | null;
  router: string; route: string; side: 'BUY' | 'SELL'; quantity: string; qtyRaw: string;
  entryPriceUsd: number | null; exitPriceUsd: number | null; grossPnlUsd: number | null;
  networkFeeLamports: string; networkFeeUsd: number | null; routerFeeUsd: number | null; totalFeesUsd: number | null;
  netPnlUsd: number | null; solDeltaLamports: string; status: 'CONFIRMED' | 'PAPER_FILLED' | 'FAILED' | 'UNKNOWN'; note: string | null;
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
  wallet: { connected: boolean; address: string | null };
  capital: DeskCapitalView; message: string | null; halted: string | null;
  lastScanAt: number | null; nextScanAt: number | null; scanning: boolean;
  events: DeskEvent[]; candidates: Candidate[]; preflights: Preflight[];
  positions: DeskPosition[]; ledger: LedgerEntry[]; sources: Record<string, string>;
  path: Array<{ layer: string; provider: string }>;
}

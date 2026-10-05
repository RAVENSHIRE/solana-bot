/**
 * The research event model. An event is one immutable observation: something happened (`timestamp`), this system
 * learned it (`observed_at`), a real-time system could have learned it (`available_at`), and it was written
 * (`recorded_at`). The three times are what make point-in-time research possible:
 *
 * - OBSERVED knowledge (`observed_at ≤ t`): what this system actually knew at t. Used for alert evidence and for
 *   "why did I not get an alert?".
 * - AVAILABLE knowledge (`available_at ≤ t`): what a real-time system could have known at t. Used for backtests over
 *   data that was downloaded later (backfill), with an explicit, conservative availability estimate.
 */

export const EVENT_SCHEMA = 'solana-research/event' as const;
export const EVENT_SCHEMA_VERSION = 1 as const;

export type EventCategory = 'ONCHAIN' | 'MARKET' | 'SOCIAL' | 'DECISION' | 'EXECUTION' | 'SYSTEM' | 'RESEARCH';
type FieldType = 'string' | 'number' | 'boolean' | 'number?' | 'string?' | 'array' | 'object';
interface EventTypeSpec {
  category: EventCategory;
  /** REQUIRED: the event is about one token (mint). OPTIONAL: may be. NONE: never. */
  token: 'REQUIRED' | 'OPTIONAL' | 'NONE';
  /** Payload fields that must be present with this type (others are free). */
  fields?: Record<string, FieldType>;
  /** Derived from other events (must list them in `causation_ids`). */
  derived?: boolean;
  description: string;
}

export const EVENT_TYPES = {
  // ------------------------------------------------------------------ on chain
  TokenCreated: { category: 'ONCHAIN', token: 'REQUIRED', fields: { creator: 'string?' }, description: 'A token was created (pump.fun create, or first seen pool for others)' },
  CreatorBuy: { category: 'ONCHAIN', token: 'REQUIRED', fields: { wallet: 'string' }, description: 'The creator (or a creation-slot insider) bought' },
  CreatorSell: { category: 'ONCHAIN', token: 'REQUIRED', fields: { wallet: 'string' }, description: 'The creator (or an insider) sold' },
  Buy: { category: 'ONCHAIN', token: 'REQUIRED', fields: { wallet: 'string' }, description: 'A swap into the token' },
  Sell: { category: 'ONCHAIN', token: 'REQUIRED', fields: { wallet: 'string' }, description: 'A swap out of the token' },
  NewWallet: { category: 'ONCHAIN', token: 'NONE', fields: { wallet: 'string' }, description: 'A wallet seen for the first time' },
  WalletFunded: { category: 'ONCHAIN', token: 'NONE', fields: { wallet: 'string', funder: 'string' }, description: 'A wallet received its funding from another wallet' },
  LiquidityChange: { category: 'ONCHAIN', token: 'REQUIRED', fields: { liquidity_usd: 'number?' }, description: 'Pool liquidity observed or changed' },
  CurveProgress: { category: 'ONCHAIN', token: 'REQUIRED', fields: { progress_pct: 'number' }, description: 'Bonding-curve fill (0–100)' },
  CurveAcceleration: { category: 'ONCHAIN', token: 'REQUIRED', derived: true, fields: { acceleration: 'number' }, description: 'Change of curve velocity (derived)' },
  Graduation: { category: 'ONCHAIN', token: 'REQUIRED', description: 'Migration from the bonding curve to an AMM pool' },
  HolderSnapshot: { category: 'ONCHAIN', token: 'REQUIRED', description: 'Holder count and concentration' },
  // ------------------------------------------------------------------ market
  MarketSnapshot: { category: 'MARKET', token: 'REQUIRED', fields: { price_usd: 'number?' }, description: 'Price / market cap / liquidity / flow of one pool or token' },
  Candle: { category: 'MARKET', token: 'REQUIRED', fields: { interval_ms: 'number', o: 'number', h: 'number', l: 'number', c: 'number' },
    description: 'OHLC(V) bar; timestamp is the bar CLOSE (the earliest moment it is complete)' },
  ProviderObservation: { category: 'MARKET', token: 'OPTIONAL', description: 'A raw provider response kept for audit' },
  RegimeSnapshot: { category: 'MARKET', token: 'NONE', description: 'Market regime context (BTC, SOL, launch activity)' },
  // ------------------------------------------------------------------ social
  SocialLinkDiscovered: { category: 'SOCIAL', token: 'REQUIRED', fields: { kind: 'string', url: 'string' }, description: 'X / website / Telegram link found in metadata' },
  XPost: { category: 'SOCIAL', token: 'OPTIONAL', fields: { author: 'string' }, description: 'A post on X' },
  XContractAddressPost: { category: 'SOCIAL', token: 'REQUIRED', fields: { author: 'string' }, description: 'A post on X naming the contract address' },
  TelegramActivity: { category: 'SOCIAL', token: 'REQUIRED', description: 'Telegram group activity' },
  WebsiteActivity: { category: 'SOCIAL', token: 'REQUIRED', description: 'Website status / content observation' },
  RiskFlag: { category: 'SOCIAL', token: 'REQUIRED', fields: { flag: 'string' }, description: 'RUG, IMPERSONATOR, COPYCAT, CLONE… as judged at the time' },
  // ------------------------------------------------------------------ decisions
  ScanDecision: { category: 'DECISION', token: 'REQUIRED', fields: { stage: 'string' }, description: 'Scanner outcome for a token (filtered, watchlist, qualified…)' },
  SignalEvaluated: { category: 'DECISION', token: 'REQUIRED', fields: { strategy: 'string', signal: 'boolean' }, description: 'A strategy evaluated its entry rule' },
  AlertGenerated: { category: 'DECISION', token: 'OPTIONAL', fields: { alert_id: 'string', kind: 'string' }, description: 'An alert was generated, with its evidence snapshot' },
  AlertDelivered: { category: 'DECISION', token: 'OPTIONAL', fields: { alert_id: 'string', status: 'string' }, description: 'Delivery outcome of an alert' },
  // ------------------------------------------------------------------ execution
  ExecutionAttempt: { category: 'EXECUTION', token: 'REQUIRED', description: 'Quote / route / simulation / pre-flight / submission' },
  ExecutionResult: { category: 'EXECUTION', token: 'REQUIRED', description: 'Confirmed, failed, paper-filled or unknown' },
  // ------------------------------------------------------------------ system / research
  PipelineStage: { category: 'SYSTEM', token: 'OPTIONAL', fields: { stage: 'string' }, description: 'Engine lifecycle and pipeline telemetry' },
  HealthSnapshot: { category: 'SYSTEM', token: 'NONE', description: 'Component health, latencies, queue depth' },
  DataQualityIssue: { category: 'SYSTEM', token: 'OPTIONAL', fields: { issue: 'string' }, description: 'A data problem worth keeping (gap, conflict, torn write)' },
  AgentAction: { category: 'RESEARCH', token: 'NONE', fields: { agent: 'string', tool: 'string' }, description: 'An audited agent tool call' },
} as const satisfies Record<string, EventTypeSpec>;

export type EventType = keyof typeof EVENT_TYPES;
export const isEventType = (s: string): s is EventType => Object.prototype.hasOwnProperty.call(EVENT_TYPES, s);

/** Ordered by severity. Only INVALID events are excluded from point-in-time views by default. */
export const QUALITY_LEVELS = ['OK', 'UNVERIFIED', 'DEGRADED', 'CONFLICT', 'INVALID'] as const;
export type QualityStatus = (typeof QUALITY_LEVELS)[number];
export interface Quality { status: QualityStatus; issues: string[] }

/** LIVE: captured as it happened. BACKFILL: downloaded afterwards. IMPORT: converted from an existing local file. DERIVED: computed. */
export type Capture = 'LIVE' | 'BACKFILL' | 'IMPORT' | 'DERIVED';

export type Payload = Record<string, unknown>;

export interface ResearchEvent<P extends Payload = Payload> {
  schema: typeof EVENT_SCHEMA;
  schema_version: typeof EVENT_SCHEMA_VERSION;
  /** `ev_` + 128-bit content hash of the identity (type, token, timestamp, source, natural key, payload). */
  event_id: string;
  event_type: EventType;
  /** Mint address, or null for market-wide / system events. */
  token: string | null;
  /** When it happened (chain block time, provider time, bar close), epoch ms. */
  timestamp: number;
  /** When this system observed it, epoch ms. */
  observed_at: number;
  /** Earliest time a real-time system could have known it, epoch ms (= observed_at for live capture). */
  available_at: number;
  /** When it was appended to the store, epoch ms. */
  recorded_at: number;
  /** e.g. `chain:pump-migration`, `dexscreener`, `desk:tape`, `birdeye`. */
  source: string;
  payload: P;
  payload_version: number;
  /** observed_at − timestamp; null when the timestamp itself is an estimate. */
  ingestion_latency_ms: number | null;
  quality: Quality;
  capture: Capture;
  /** Provider identity (tx signature, trade id…) for duplicate and conflict detection. */
  natural_key: string | null;
  /** Groups events of one scan, one alert, one order… */
  correlation_id: string | null;
  /** Inputs of a derived event. */
  causation_ids: string[];
  producer: { component: string; version: string };
}

export interface EventInput<P extends Payload = Payload> {
  event_type: EventType;
  token?: string | null;
  timestamp: number;
  observed_at?: number;
  available_at?: number;
  source: string;
  payload: P;
  payload_version?: number;
  /** The timestamp is approximate (e.g. a file's modification time): no ingestion latency is computed. */
  timestamp_estimated?: boolean;
  capture?: Capture;
  natural_key?: string | null;
  correlation_id?: string | null;
  causation_ids?: string[];
  producer?: { component: string; version: string };
  /** Problems the producer already knows about (added to the computed quality issues). */
  quality_issues?: Array<{ issue: string; status: QualityStatus }>;
}

/** Point-in-time knowledge semantics, see the module comment. */
export type KnowledgeMode = 'OBSERVED' | 'AVAILABLE';
export const knownAt = (e: Pick<ResearchEvent, 'observed_at' | 'available_at'>, mode: KnowledgeMode): number =>
  mode === 'OBSERVED' ? e.observed_at : e.available_at;

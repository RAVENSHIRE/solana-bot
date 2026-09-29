import type { Candle, PoolTrade } from '../../core/types';

export type Source = 'dexscreener' | 'geckoterminal' | 'raydium' | 'solana-rpc' | 'jupiter';
export type Category = 'discovery' | 'analysis' | 'position' | 'execution' | 'history';
export type FailureKind = 'transient' | 'rate-limited' | 'invalid-response' | 'stale-data' | 'unavailable-provider' | 'configuration' | 'on-chain-verification' | 'critical-execution-data';
export interface Observation {
  schemaVersion: 1; source: Source; network: 'solana-mainnet';
  sourceAt: number | null; receivedAt: number; tokenMint: string | null; poolAddress: string | null;
  freshness: 'fresh' | 'stale' | 'unknown'; validation: 'valid' | 'invalid' | 'unavailable'; warnings: string[];
}
export interface TokenIdentity { mint: string; symbol: string | null; name: string | null; decimals: number | null }
export interface PoolIdentity { address: string; baseMint: string; quoteMint: string; dex: string; type: 'constant-product' | 'concentrated' | 'unknown' }
export interface MarketSnapshot {
  meta: Observation; token: TokenIdentity; pool: PoolIdentity; priceUsd: number | null;
  liquidityUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null;
  createdAt: number | null; volumeUsd: Record<string, number | null>;
}
export interface LiquiditySnapshot { meta: Observation; liquidityUsd: number | null; feeRate: number | null; feeAprPct: number | null }
export interface OHLCVSeries { meta: Observation; intervalMs: number; candles: Candle[]; partial: Candle[]; missingIntervals: number[] }
export interface TradeEvent extends PoolTrade { id: string; meta: Observation; tokenMint: string; poolAddress: string; walletVerified: false }
export interface WalletActivity { meta: Observation; wallet: string; signatures: Array<{ signature: string; slot: number; blockTime: number | null; failed: boolean }>; economicOwnershipVerified: false }
export interface TokenSafetyResult { meta: Observation; status: 'verified' | 'rejected' | 'unavailable'; supplyRaw: bigint | null; decimals: number | null; mintAuthority: string | null; freezeAuthority: string | null; reasons: string[] }
export interface ExecutableQuote { meta: Observation; inputMint: string; outputMint: string; inputRaw: bigint; outputRaw: bigint; minimumOutputRaw: bigint; priceImpactPct: number; slippageBps: number; route: string[]; executionAuthorized: false }
export interface DataSourceStatus { source: Source; requests: number; failures: number; retries: number; rateLimits: number; invalidResponses: number; cacheHits: number; cacheMisses: number; latencyMs: number | null; lastSuccessAt: number | null; lastFailure: FailureKind | null; cooldownUntil: number }

export class DataError extends Error {
  constructor(readonly kind: FailureKind, readonly source: string, message: string, readonly retryAfterMs = 0) {
    super(`${source}: ${message}`); this.name = 'DataError';
  }
}
export function observation(source: Source, receivedAt: number, tokenMint: string | null, poolAddress: string | null, sourceAt: number | null = null): Observation {
  return { schemaVersion: 1, source, network: 'solana-mainnet', sourceAt, receivedAt, tokenMint, poolAddress,
    freshness: sourceAt === null ? 'unknown' : 'fresh', validation: 'valid', warnings: sourceAt === null ? ['SOURCE_TIMESTAMP_UNAVAILABLE'] : [] };
}
export function assertFresh(meta: Observation, maxAgeMs: number, now = Date.now()): void {
  if (meta.validation !== 'valid') throw new DataError('invalid-response', meta.source, 'observation is not validated');
  if (meta.receivedAt > now || now - meta.receivedAt > maxAgeMs || (meta.sourceAt !== null && (meta.sourceAt > now || now - meta.sourceAt > maxAgeMs)))
    throw new DataError('stale-data', meta.source, 'observation is stale or future-dated');
}

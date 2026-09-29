import { assertFresh, type MarketSnapshot, type OHLCVSeries, type TradeEvent } from '../core/data-types';
export interface QualityAssessment { adequate: boolean; reasons: string[]; walletEvidence: 'heuristic-only'; volumePolicy: 'single-pool-single-source' }
export function reconcile(a: MarketSnapshot, b: MarketSnapshot, maxAgeMs: number, maxPriceDifferencePct = 20, maxLiquidityDifferencePct = 50): string[] {
  const reasons: string[] = [];
  if (a.token.mint !== b.token.mint || a.pool.address !== b.pool.address || a.pool.baseMint !== b.pool.baseMint || a.pool.quoteMint !== b.pool.quoteMint) return ['POOL_IDENTITY_MISMATCH'];
  for (const snapshot of [a, b]) { try { assertFresh(snapshot.meta, maxAgeMs); } catch { reasons.push('STALE_PRICE'); } }
  const compare = (x: number | null, y: number | null, label: string, tolerance: number): void => {
    if (x === null || y === null || x <= 0 || y <= 0) reasons.push(`UNKNOWN_${label}`);
    else if (Math.abs(x - y) / Math.max(x, y) * 100 > tolerance) reasons.push(`${label}_DISAGREEMENT`);
  };
  compare(a.priceUsd, b.priceUsd, 'PRICE', maxPriceDifferencePct); compare(a.liquidityUsd, b.liquidityUsd, 'LIQUIDITY', maxLiquidityDifferencePct);
  // Volume is deliberately not summed or averaged across overlapping providers.
  return [...new Set(reasons)];
}
export function assessQuality(series: OHLCVSeries, trades: TradeEvent[] | null, maxCandleAgeMs: number, minCandles = 60, now = Date.now()): QualityAssessment {
  const reasons: string[] = [];
  if (series.candles.length < minCandles) reasons.push('INSUFFICIENT_CANDLES');
  if (series.missingIntervals.length) reasons.push('MISSING_CANDLES');
  if (series.meta.sourceAt === null) reasons.push('NO_COMPLETED_CANDLE');
  try { assertFresh(series.meta, maxCandleAgeMs, now); } catch { reasons.push('STALE_CANDLES'); }
  if (trades !== null) {
    if (trades.length < 10) reasons.push('INSUFFICIENT_TRADE_SAMPLE');
    if (!trades.some(t => now >= t.ts && now - t.ts <= maxCandleAgeMs)) reasons.push('STALE_TRADES');
    if (trades.some(t => !t.wallet)) reasons.push('UNAVAILABLE_WALLET_INFORMATION');
    if (trades.some(t => t.tokenMint !== series.meta.tokenMint || t.poolAddress !== series.meta.poolAddress)) reasons.push('TRADE_IDENTITY_MISMATCH');
  }
  return { adequate: reasons.length === 0, reasons, walletEvidence: 'heuristic-only', volumePolicy: 'single-pool-single-source' };
}

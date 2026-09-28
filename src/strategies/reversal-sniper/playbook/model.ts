import { z } from 'zod';
import type { Candle, Position } from '../../../core/types';

export const PLAYBOOK = 'ReversalSniper:Playbook';
const positive = z.number().finite().positive();
export const CycleSchema = z.object({
  mint: z.string(), symbol: z.string(), pairAddress: z.string(), decimals: z.number().int().min(0).max(18),
  phase: z.enum(['holding', 'watching', 'done']),
  initialSizeLamports: z.bigint().positive(), peakUsd: positive,
  reEntryUsed: z.boolean(), positionId: z.string().nullable(),
});
export type Cycle = z.infer<typeof CycleSchema>;
export interface Snapshot {
  mint: string; symbol: string; pairAddress: string;
  observedAt: number; priceUsd: number; marketCapUsd: number | null;
  liquidityUsd: number | null; hasWebsite: boolean; hasTwitter: boolean;
  solUsd: number | null;
}
export interface EntryEvidence {
  safetyOk: boolean; safetyReasons: string[]; top10OwnerFraction: number | null;
  buyVolumeUsd: number | null; sellVolumeUsd: number | null;
  completeVolumeWindow: boolean; consolidated: boolean;
}
export type Intent =
  | { type: 'BUY' | 'RE_ENTRY'; reason: string }
  | { type: 'SELL'; amountRaw: bigint; stage: '2x' | '5x' | 'exit'; reason: string }
  | { type: 'WAIT' | 'SKIP'; reason: string };

export function entryRejection(s: Snapshot, e: EntryEvidence, maxCap: number): string | null {
  if (!e.safetyOk) return `SAFETY: ${e.safetyReasons.join('; ') || 'unknown'}`;
  if (e.top10OwnerFraction === null || !Number.isFinite(e.top10OwnerFraction) || e.top10OwnerFraction < 0 || e.top10OwnerFraction > 1) return 'HOLDER_DATA_MISSING';
  if (e.top10OwnerFraction > 0.25) return 'TOP10_OWNERS_ABOVE_25_PERCENT';
  if (s.marketCapUsd === null || !Number.isFinite(s.marketCapUsd) || s.marketCapUsd <= 0) return 'MARKET_CAP_MISSING';
  if (s.marketCapUsd >= maxCap) return 'MARKET_CAP_LIMIT';
  if (!s.hasWebsite || !s.hasTwitter) return 'SOCIAL_LINKS_MISSING';
  if (!e.completeVolumeWindow || e.buyVolumeUsd === null || e.sellVolumeUsd === null ||
      !Number.isFinite(e.buyVolumeUsd) || !Number.isFinite(e.sellVolumeUsd) || e.buyVolumeUsd < 0 || e.sellVolumeUsd < 0) return 'VOLUME_WINDOW_INCOMPLETE';
  if (e.buyVolumeUsd + e.sellVolumeUsd <= 0) return 'NO_VOLUME';
  return null;
}

/** Price triggers use observed USD, execution/P&L use actual paper fills in SOL. */
export function evaluate(s: Snapshot, cycle: Cycle | undefined, pos: Position | undefined, e: EntryEvidence | undefined,
  options: { now: number; maxCap: number; initialStopPct: number; maxHoldMs: number }): Intent {
  if (!Number.isFinite(s.priceUsd) || s.priceUsd <= 0 || s.observedAt > options.now || options.now - s.observedAt > 90_000) return { type: 'WAIT', reason: 'PRICE_STALE_OR_INVALID' };
  // Exit logic deliberately precedes every entry safety check.
  if (pos) {
    const entry = pos.entryPriceUsd;
    if (!entry || !cycle) return { type: 'WAIT', reason: 'POSITION_METADATA_MISSING' };
    const peak = Math.max(Number(pos.tags.playbookPeakUsd) || entry, s.priceUsd);
    const reentry = pos.tags.playbookReentry === true;
    if (s.priceUsd <= entry * (1 - (reentry ? 0.10 : options.initialStopPct / 100)))
      return { type: 'SELL', amountRaw: pos.tokenAmountRaw, stage: 'exit', reason: reentry ? 'REENTRY_STOP_10_PERCENT' : 'INITIAL_STOP' };
    if (pos.tags.playbook2x === true && s.priceUsd <= peak * 0.80)
      return { type: 'SELL', amountRaw: pos.tokenAmountRaw, stage: 'exit', reason: 'TRAILING_STOP_20_PERCENT' };
    if (options.now - pos.openedAt >= options.maxHoldMs)
      return { type: 'SELL', amountRaw: pos.tokenAmountRaw, stage: 'exit', reason: 'MAX_HOLD' };
    const original = BigInt(String(pos.tags.playbookOriginalRaw));
    if (s.priceUsd >= entry * 2 && pos.tags.playbook2x !== true) {
      const amount = original / 2n;
      if (amount > 0n) return { type: 'SELL', amountRaw: amount < pos.tokenAmountRaw ? amount : pos.tokenAmountRaw, stage: '2x', reason: 'TAKE_PROFIT_2X_ORIGINAL_50_PERCENT' };
    }
    if (s.priceUsd >= entry * 5 && pos.tags.playbook5x !== true) {
      const amount = original / 4n;
      if (amount > 0n) return { type: 'SELL', amountRaw: amount < pos.tokenAmountRaw ? amount : pos.tokenAmountRaw, stage: '5x', reason: 'TAKE_PROFIT_5X_ORIGINAL_25_PERCENT' };
    }
    return { type: 'WAIT', reason: 'MANAGE_POSITION' };
  }
  if (cycle?.phase === 'done' || cycle?.reEntryUsed) return { type: 'SKIP', reason: 'CYCLE_FINISHED' };
  if (!e) return { type: 'WAIT', reason: 'ENTRY_EVIDENCE_PENDING' };
  // Re-entry safety is refreshed too. The initial market-cap/social constraints remain in force.
  const reject = entryRejection(s, e, options.maxCap);
  if (reject) return { type: 'SKIP', reason: reject };
  const buy = e.buyVolumeUsd!; const sell = e.sellVolumeUsd!;
  if (cycle) {
    if (cycle.phase !== 'watching') return { type: 'SKIP', reason: 'INCONSISTENT_CYCLE' };
    if (s.priceUsd > cycle.peakUsd * 0.20) return { type: 'WAIT', reason: 'WAIT_FOR_80_PERCENT_DROP' };
    if (!e.consolidated) return { type: 'WAIT', reason: 'WAIT_FOR_30_MINUTE_SUPPORT' };
    if (buy <= sell * 1.5) return { type: 'WAIT', reason: 'WAIT_FOR_VOLUME_REVERSAL' };
    return { type: 'RE_ENTRY', reason: 'PHOENIX_80_PERCENT_30_MINUTE_SUPPORT' };
  }
  if (buy / (buy + sell) <= 0.65) return { type: 'SKIP', reason: 'BUY_VOLUME_AT_OR_BELOW_65_PERCENT' };
  return { type: 'BUY', reason: 'PLAYBOOK_INITIAL_ENTRY' };
}

/** 31 complete consecutive one-minute candles: first candle establishes the low;
 * the following 30 must never undercut it. No invented/fill-forward candles. */
export function hasThirtyMinuteSupport(candles: Candle[], now: number, currentPrice: number): boolean {
  const end = Math.floor(now / 60_000) * 60_000;
  const rows = candles.filter(c => c.t >= end - 31 * 60_000 && c.t < end).sort((a, b) => a.t - b.t);
  if (rows.length !== 31) return false;
  const floor = rows[0]!.l;
  return Number.isFinite(floor) && floor > 0 && currentPrice >= floor && rows.every((c, i) =>
    c.t === end - (31 - i) * 60_000 && Number.isFinite(c.l) && c.l >= floor);
}

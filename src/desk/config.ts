import { z } from 'zod';
import { MICRO } from '../micro/policy';

/**
 * Single source of the desk's capital plan and discovery thresholds.
 * Native reserve and max drag are the project's existing micro values; they are referenced, never redefined.
 */
export const DESK_DEFAULTS = Object.freeze({
  plannedStartingCapitalUsd: 5.45,
  baseEntryUsd: 2.0,
  slippageBps: 100,
});

export const DESK = Object.freeze({
  reserveLamports: MICRO.reserveLamports,
  maxDragBps: MICRO.feeBps,
  scanMs: 20_000,
  maxOpenPositions: 2,
  /** No re-entry into a token this soon after exiting it. */
  reentryCooldownMs: 30 * 60_000,
  /** Deep (RPC + social + trade-flow) analyses per scan; the rest keep their last evidence. */
  maxDeepAnalysesPerScan: 4,
  deepAnalysisTtlMs: 120_000,
  priceMaxAgeMs: 60_000,
  tiers: {
    trending: { maxMarketCapUsd: 1_000_000, priorityMarketCapUsd: 100_000 },
    ultraEarly: { minMarketCapUsd: 2_000, maxMarketCapUsd: 10_000, monitorMaxMarketCapUsd: 100_000 },
  },
  gates: {
    minVolume5mUsd: 15_000,
    minLiquidityUsd: 10_000,
    minBuySellRatio: 1.4,
    maxTop10WalletPct: 35,
    maxLargestWalletPct: 10,
    maxDeveloperPct: 5,
    minLiquidityToMarketCap: 0.03,
    maxLiquidityDropPct: 25,
    /** Fair launch: a curve graduating sooner was bought out at creation (bundled / insider launch). */
    minGraduationSec: 300,
    /** Fair launch: highest market cap allowed within the first 5 minutes after launch. */
    maxLaunchMarketCapUsd: 250_000,
  },
  exits: {
    /** Positions are re-valued this often, independent of the discovery scan. */
    positionCheckMs: 5_000,
    /** Emergency exit when pool liquidity falls this far below its level at entry. */
    liquidityDropExitPct: 30,
    /** Emergency exit when the pump.fun creator's holding falls by this many percentage points of supply. */
    creatorSellExitPts: 0.5,
    creatorCheckMs: 30_000,
  },
  momentum: { minObservations: 2, minAcceleration: 1, minPriceChange5mPct: 0 },
  /** Candidates kept in memory and on the status API. */
  maxCandidates: 60,
  maxEvents: 400,
});

export interface DeskCapital { plannedStartingCapitalUsd: number; baseEntryUsd: number; slippageBps: number }

const money = (fallback: number) => z.coerce.number().finite().positive().max(100_000).default(fallback);
export function deskCapital(env: NodeJS.ProcessEnv = process.env): DeskCapital {
  const e = z.object({ DESK_PLANNED_CAPITAL_USD: money(DESK_DEFAULTS.plannedStartingCapitalUsd),
    DESK_BASE_ENTRY_USD: money(DESK_DEFAULTS.baseEntryUsd),
    // Slippage tolerance counts toward the max drag, so values at or above it could never pass.
    DESK_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(Number(MICRO.feeBps) - 1).default(DESK_DEFAULTS.slippageBps) }).parse(env);
  if (e.DESK_BASE_ENTRY_USD > e.DESK_PLANNED_CAPITAL_USD) throw new Error('DESK_BASE_ENTRY_USD exceeds DESK_PLANNED_CAPITAL_USD');
  return { plannedStartingCapitalUsd: e.DESK_PLANNED_CAPITAL_USD, baseEntryUsd: e.DESK_BASE_ENTRY_USD, slippageBps: e.DESK_SLIPPAGE_BPS };
}

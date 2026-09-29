import { z } from 'zod';
import { MICRO } from '../micro/policy';
import type { StrategyId } from './types';

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
  /** Orders tried per strategy and scan; a candidate blocked by the guard is skipped for entrySkipMs. */
  maxEntryAttemptsPerScan: 4,
  entrySkipMs: 5 * 60_000,
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

/**
 * CRASH: short, high-conviction momentum trades in young pools (target +40–100 % within 1–4 minutes).
 * Launch fairness is not required; the safety gates are. Its TEST sleeve and ledger are separate from FAIR.
 */
export const CRASH_DEFAULTS = Object.freeze({
  enabled: true,
  capitalUsd: 10,
  entryUsd: 2.0,
  slippageBps: 250,
  maxDragBps: 500,
  maxOpenPositions: 3,
  positionCheckMs: 2_000,
  /** +100 % = $2 unrealized on a $2 entry. */
  takeProfitPct: 100,
  /** Once the return has peaked at or above lockPeakPct, exit when it falls givebackPts below that peak. */
  lockPeakPct: 40,
  givebackPts: 15,
  stopLossPct: 15,
  maxHoldMin: 4,
});

export const CRASH_ENTRY = Object.freeze({
  maxPoolAgeMin: 60,
  minPriceChange5mPct: 10,
  /** Above this the move is already vertical; entering there is buying the top. */
  maxPriceChange5mPct: 200,
  minVolume5mUsd: 20_000,
  minBuySellRatio: 1.3,
  minBuys5m: 40,
  minLiquidityUsd: 10_000,
  minLiquidityToMarketCap: 0.03,
  maxTop10WalletPct: 50,
  maxLargestWalletPct: 15,
});

export interface DeskCapital { plannedStartingCapitalUsd: number; baseEntryUsd: number; slippageBps: number }

export interface ExitRules {
  takeProfitPct: number; stopLossPct: number; maxHoldMin: number;
  /** FAIR: exit after the value falls stopPct below its peak, once the return reached activationPct. */
  trailing: { activationPct: number; stopPct: number } | null;
  /** CRASH: exit when the return falls `points` below its peak, once the peak reached lockPeakPct. */
  giveback: { lockPeakPct: number; points: number } | null;
}
export interface StrategyProfile {
  id: StrategyId; label: string; summary: string; enabled: boolean;
  /** TEST sleeve; LIVE always spends from the connected wallet. */
  capitalUsd: number; entryUsd: number; slippageBps: number; maxDragBps: bigint;
  maxOpenPositions: number; positionCheckMs: number; exits: ExitRules;
}
export const STRATEGY_IDS: readonly StrategyId[] = ['FAIR', 'CRASH'];

const money = (fallback: number) => z.coerce.number().finite().positive().max(100_000).default(fallback);
export function deskCapital(env: NodeJS.ProcessEnv = process.env): DeskCapital {
  const e = z.object({ DESK_PLANNED_CAPITAL_USD: money(DESK_DEFAULTS.plannedStartingCapitalUsd),
    DESK_BASE_ENTRY_USD: money(DESK_DEFAULTS.baseEntryUsd),
    // Slippage tolerance counts toward the max drag, so values at or above it could never pass.
    DESK_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(Number(MICRO.feeBps) - 1).default(DESK_DEFAULTS.slippageBps) }).parse(env);
  if (e.DESK_BASE_ENTRY_USD > e.DESK_PLANNED_CAPITAL_USD) throw new Error('DESK_BASE_ENTRY_USD exceeds DESK_PLANNED_CAPITAL_USD');
  return { plannedStartingCapitalUsd: e.DESK_PLANNED_CAPITAL_USD, baseEntryUsd: e.DESK_BASE_ENTRY_USD, slippageBps: e.DESK_SLIPPAGE_BPS };
}

const pctSetting = (fallback: number, max = 1_000) => z.coerce.number().finite().positive().max(max).default(fallback);
/**
 * Both strategies' settings. FAIR keeps the desk capital and the RS_* exit rules; CRASH reads CRASH_* keys.
 * Slippage tolerance counts toward the drag cap, so it must stay below it.
 */
export function strategyProfiles(env: NodeJS.ProcessEnv, capital: DeskCapital,
  rs: { takeProfitPct: number; stopLossPct: number; trailingActivationPct: number; trailingStopPct: number; maxHoldMin: number }): Record<StrategyId, StrategyProfile> {
  const c = CRASH_DEFAULTS;
  const e = z.object({
    CRASH_ENABLED: z.enum(['true', 'false']).default(c.enabled ? 'true' : 'false'),
    CRASH_CAPITAL_USD: money(c.capitalUsd), CRASH_ENTRY_USD: money(c.entryUsd),
    CRASH_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(c.slippageBps),
    CRASH_MAX_DRAG_BPS: z.coerce.number().int().min(50).max(2_500).default(c.maxDragBps),
    CRASH_MAX_POSITIONS: z.coerce.number().int().min(1).max(10).default(c.maxOpenPositions),
    CRASH_TAKE_PROFIT_PCT: pctSetting(c.takeProfitPct), CRASH_LOCK_PEAK_PCT: pctSetting(c.lockPeakPct), CRASH_GIVEBACK_PTS: pctSetting(c.givebackPts),
    CRASH_STOP_LOSS_PCT: pctSetting(c.stopLossPct, 100), CRASH_MAX_HOLD_MIN: pctSetting(c.maxHoldMin, 240),
  }).parse(env);
  if (e.CRASH_SLIPPAGE_BPS >= e.CRASH_MAX_DRAG_BPS) throw new Error('CRASH_SLIPPAGE_BPS must be below CRASH_MAX_DRAG_BPS');
  if (e.CRASH_ENTRY_USD > e.CRASH_CAPITAL_USD) throw new Error('CRASH_ENTRY_USD exceeds CRASH_CAPITAL_USD');
  return {
    FAIR: { id: 'FAIR', label: 'FAIR LAUNCH', summary: 'Fair-launch trending tokens: every hard gate plus momentum in two consecutive scans', enabled: true,
      capitalUsd: capital.plannedStartingCapitalUsd, entryUsd: capital.baseEntryUsd, slippageBps: capital.slippageBps, maxDragBps: DESK.maxDragBps,
      maxOpenPositions: DESK.maxOpenPositions, positionCheckMs: DESK.exits.positionCheckMs,
      exits: { takeProfitPct: rs.takeProfitPct, stopLossPct: rs.stopLossPct, maxHoldMin: rs.maxHoldMin,
        trailing: rs.trailingStopPct > 0 ? { activationPct: rs.trailingActivationPct, stopPct: rs.trailingStopPct } : null, giveback: null } },
    CRASH: { id: 'CRASH', label: 'CRASH', summary: 'Young pools pumping now: entered in one scan, exited within minutes — launch fairness not required, safety gates are',
      enabled: e.CRASH_ENABLED === 'true', capitalUsd: e.CRASH_CAPITAL_USD, entryUsd: e.CRASH_ENTRY_USD, slippageBps: e.CRASH_SLIPPAGE_BPS,
      maxDragBps: BigInt(e.CRASH_MAX_DRAG_BPS), maxOpenPositions: e.CRASH_MAX_POSITIONS, positionCheckMs: c.positionCheckMs,
      exits: { takeProfitPct: e.CRASH_TAKE_PROFIT_PCT, stopLossPct: e.CRASH_STOP_LOSS_PCT, maxHoldMin: e.CRASH_MAX_HOLD_MIN, trailing: null,
        giveback: { lockPeakPct: e.CRASH_LOCK_PEAK_PCT, points: e.CRASH_GIVEBACK_PTS } } },
  };
}

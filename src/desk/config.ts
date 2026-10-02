import { z } from 'zod';
import { MICRO } from '../micro/policy';
import type { StrategyId } from './types';
import type { RuleSpec } from './custom';
import type { PocketRules } from './golden-pocket';

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
  /** Tokens assessed per scan: held positions, recent graduations and the watchlist first, then fresh discoveries. */
  maxStagedPerScan: 120,
  /** Discovery requests (DexScreener, GeckoTerminal, chain) that take longer are cancelled for this scan. */
  discoveryBudgetMs: 12_000,
  /** GeckoTerminal-bound evidence (trade flow, launch history) per scan; unfinished requests are cancelled, never queued up. */
  slowPathBudgetMs: 20_000,
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
    /**
     * A held token Jupiter refuses to route (HTTP 4xx, e.g. pool drained or delisted) is re-quoted this often instead of
     * every check. After `writeOffMin` without a route it no longer occupies a slot; TEST books it at zero.
     */
    noRoute: { retryMs: 120_000, writeOffMin: 30 },
    /** Other valuation failures (provider outage) are logged at most this often per position. */
    valuationLogMs: 60_000,
  },
  momentum: { minObservations: 2, minAcceleration: 1, minPriceChange5mPct: 0 },
  /** Candidates kept in memory and on the status API. */
  maxCandidates: 60,
  /**
   * Holders for more candidates than the deep analyses reach: the largest accounts every few minutes (standard RPC
   * calls), and the holder count less often (DAS getTokenAccounts, 1,000 accounts per page, capped).
   */
  holders: { perScan: 8, ttlMs: 180_000, countPerScan: 3, countTtlMs: 600_000, countPages: 2 },
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
  /** Exits: a sell that fails while a pool dumps costs more than a wider fill. */
  exitSlippageBps: 1_000,
  maxDragBps: 500,
  maxOpenPositions: 3,
  positionCheckMs: 2_000,
  /** +100 % = $2 unrealized on a $2 entry. */
  takeProfitPct: 100,
  /**
   * Optional profit lock: once the return has peaked at or above lockPeakPct, exit when it falls givebackPts below
   * that peak. Off (0) by default: in the backtest it cut the result by about 10 points in every variant.
   */
  lockPeakPct: 0,
  givebackPts: 15,
  /**
   * Backtest (every pump.fun graduation over 12 h, 247 pools, docs/DESK.md): stops at 15–25 % were shaken out by
   * normal volatility; 35 % held the edge with a worst trade near −38 %. A 10-minute hold beat 4 minutes.
   */
  stopLossPct: 35,
  maxHoldMin: 10,
  /** QUICK takes the fixed profit; RIDE has no take profit and trails the move (the SI / GM runs went 8–20×). */
  exitMode: 'quick' as 'quick' | 'ride',
  rideTrailActivationPct: 50,
  rideTrailStopPct: 35,
  rideMaxHoldMin: 60,
  /** A fresh signal may re-enter a token this soon after an exit (SI dipped to $95K after a stop-out, then ran 20×). */
  reentryMin: 10,
});

/**
 * CRASH entry, set from the backtest: entering a pool that already moved more than +30 % in five minutes, or on less
 * than $50K five-minute volume, lost money (the old rule, up to +200 % on $20K, averaged −11 % per trade); the early,
 * well-traded part of the move in a pool at most 15 minutes old paid.
 */
export const CRASH_ENTRY = Object.freeze({
  maxPoolAgeMin: 15,
  minPriceChange5mPct: 10,
  /** Above this the move is already vertical; entering there is buying the top. */
  maxPriceChange5mPct: 30,
  minVolume5mUsd: 50_000,
  minBuySellRatio: 1.3,
  minBuys5m: 40,
  minLiquidityUsd: 10_000,
  minLiquidityToMarketCap: 0.03,
  /** Above this the early part of the move is gone; the backtest keeps this where entries still paid. */
  maxMarketCapUsd: 300_000,
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
  /** Custom strategies: exit when the token's market cap falls to the floor or reaches the target. */
  marketCap?: { floorUsd: number | null; targetUsd: number | null } | null;
  /** No stop loss or trailing stop this long after entry; take profit and targets still apply. */
  graceMs?: number;
  /** The trailing stop only applies once the price reached this multiple of the first entry (OPEN: "stay in for at least 6×"). */
  holdUntilMultiple?: number;
}
export interface StrategyProfile {
  id: StrategyId; label: string; summary: string; enabled: boolean;
  /** TEST sleeve; LIVE always spends from the connected wallet. */
  capitalUsd: number; entryUsd: number; slippageBps: number; exitSlippageBps: number; maxDragBps: bigint;
  maxOpenPositions: number; positionCheckMs: number; exits: ExitRules;
  /** CRASH exit preset; FAIR uses the RS_* rules. */
  exitMode: 'quick' | 'ride' | 'rules';
  /** A token is not re-entered by this strategy sooner than this after an exit. */
  reentryCooldownMs: number;
  /** Custom rule strategy: the spec its entries are checked against. */
  rule?: RuleSpec;
  /** Scale-in: add `addUsd` when the price reaches each multiple of the first entry (in order, once each). */
  scaleIn?: Array<{ atMultiple: number; addUsd: number }>;
  /** Sell a curve position before graduation while its insiders still hold a bag (default true). */
  preGraduationExit?: boolean;
  /** GOLDEN POCKET: which pattern fills are bought (the others are shown only). */
  entryKinds?: Array<'ONLY_UP' | 'RETEST'>;
}
/** The built-in strategies; custom rule strategies are added at runtime (see custom.ts). */
export type BuiltinStrategyId = 'FAIR' | 'CRASH' | 'LAUNCH' | 'OPEN' | 'GOLDEN';
export const STRATEGY_IDS: readonly BuiltinStrategyId[] = ['FAIR', 'CRASH', 'LAUNCH', 'OPEN', 'GOLDEN'];

export interface DeskOperational {
  version: 1;
  deploymentMode: 'LOCKED' | 'EDITABLE';
  strategyEnabled: Record<'PAPER' | 'LIVE', Record<StrategyId, boolean>>;
  lossCooldownMs: Record<StrategyId, number>;
  freshSignal: Record<StrategyId, boolean>;
}
/** Allowlisted settings are validated at startup; the UI cannot override a locked deployment. */
export function deskOperational(env: NodeJS.ProcessEnv = {}): DeskOperational {
  const bool = z.enum(['true', 'false']);
  const minutes = z.coerce.number().int().min(1).max(1_440);
  const e = z.object({
    // EDITABLE: strategies and the TEST drill are switched in the dashboard (saved per mode). LOCKED fixes them at startup.
    DESK_DEPLOYMENT_MODE: z.enum(['LOCKED', 'EDITABLE']).default('EDITABLE'),
    DESK_PAPER_FAIR_ENABLED: bool.default('true'), DESK_PAPER_CRASH_ENABLED: bool.default('true'),
    DESK_LIVE_FAIR_ENABLED: bool.default('true'), DESK_LIVE_CRASH_ENABLED: bool.default('false'),
    DESK_FAIR_LOSS_REENTRY_MIN: minutes.default(60), DESK_CRASH_LOSS_REENTRY_MIN: minutes.default(30),
    DESK_FAIR_FRESH_SIGNAL: bool.default('true'), DESK_CRASH_FRESH_SIGNAL: bool.default('true'),
  }).parse(env);
  return { version: 1, deploymentMode: e.DESK_DEPLOYMENT_MODE,
    strategyEnabled: { PAPER: { FAIR: e.DESK_PAPER_FAIR_ENABLED === 'true', CRASH: e.DESK_PAPER_CRASH_ENABLED === 'true' },
      LIVE: { FAIR: e.DESK_LIVE_FAIR_ENABLED === 'true', CRASH: e.DESK_LIVE_CRASH_ENABLED === 'true' } },
    lossCooldownMs: { FAIR: e.DESK_FAIR_LOSS_REENTRY_MIN * 60_000, CRASH: e.DESK_CRASH_LOSS_REENTRY_MIN * 60_000 },
    freshSignal: { FAIR: e.DESK_FAIR_FRESH_SIGNAL === 'true', CRASH: e.DESK_CRASH_FRESH_SIGNAL === 'true' } };
}

const money = (fallback: number) => z.coerce.number().finite().positive().max(100_000).default(fallback);
export function deskCapital(env: NodeJS.ProcessEnv = process.env): DeskCapital {
  const e = z.object({ DESK_PLANNED_CAPITAL_USD: money(DESK_DEFAULTS.plannedStartingCapitalUsd),
    DESK_BASE_ENTRY_USD: money(DESK_DEFAULTS.baseEntryUsd),
    // Slippage tolerance counts toward the max drag, so values at or above it could never pass.
    DESK_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(Number(MICRO.feeBps) - 1).default(DESK_DEFAULTS.slippageBps) }).parse(env);
  if (e.DESK_BASE_ENTRY_USD > e.DESK_PLANNED_CAPITAL_USD) throw new Error('DESK_BASE_ENTRY_USD exceeds DESK_PLANNED_CAPITAL_USD');
  return { plannedStartingCapitalUsd: e.DESK_PLANNED_CAPITAL_USD, baseEntryUsd: e.DESK_BASE_ENTRY_USD, slippageBps: e.DESK_SLIPPAGE_BPS };
}

export type LiveSignerKind = 'PHANTOM' | 'LOCAL_KEY';
/**
 * How LIVE orders are signed. Default PHANTOM (browser approval). DESK_LIVE_SIGNER=local-key signs with
 * WALLET_PRIVATE_KEY from .env, unattended; DESK_LIVE_MAX_ENTRIES caps new entries per LIVE session (exits never).
 */
export function liveSignerSettings(env: NodeJS.ProcessEnv): { signer: LiveSignerKind; maxEntries: number } {
  const e = z.object({ DESK_LIVE_SIGNER: z.enum(['phantom', 'local-key']).default('phantom'),
    DESK_LIVE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000).default(10) }).parse(env);
  return { signer: e.DESK_LIVE_SIGNER === 'local-key' ? 'LOCAL_KEY' : 'PHANTOM', maxEntries: e.DESK_LIVE_MAX_ENTRIES };
}

const pctSetting = (fallback: number, max = 1_000) => z.coerce.number().finite().positive().max(max).default(fallback);
/**
 * Both strategies' settings. FAIR keeps the desk capital and the RS_* exit rules; CRASH reads CRASH_* keys.
 * Slippage tolerance counts toward the drag cap, so it must stay below it.
 */
export function strategyProfiles(env: NodeJS.ProcessEnv, capital: DeskCapital,
  rs: { takeProfitPct: number; stopLossPct: number; trailingActivationPct: number; trailingStopPct: number; maxHoldMin: number }): Record<BuiltinStrategyId, StrategyProfile> {
  const c = CRASH_DEFAULTS;
  const e = z.object({
    CRASH_ENABLED: z.enum(['true', 'false']).default(c.enabled ? 'true' : 'false'),
    CRASH_CAPITAL_USD: money(c.capitalUsd), CRASH_ENTRY_USD: money(c.entryUsd),
    CRASH_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(c.slippageBps),
    CRASH_EXIT_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5_000).default(c.exitSlippageBps),
    CRASH_MAX_DRAG_BPS: z.coerce.number().int().min(50).max(2_500).default(c.maxDragBps),
    CRASH_MAX_POSITIONS: z.coerce.number().int().min(1).max(10).default(c.maxOpenPositions),
    CRASH_TAKE_PROFIT_PCT: pctSetting(c.takeProfitPct), CRASH_LOCK_PEAK_PCT: z.coerce.number().finite().min(0).max(1_000).default(c.lockPeakPct), CRASH_GIVEBACK_PTS: pctSetting(c.givebackPts),
    CRASH_STOP_LOSS_PCT: pctSetting(c.stopLossPct, 100), CRASH_MAX_HOLD_MIN: pctSetting(c.maxHoldMin, 240),
    CRASH_EXIT_MODE: z.enum(['quick', 'ride']).default(c.exitMode),
    CRASH_TRAIL_ACTIVATION_PCT: pctSetting(c.rideTrailActivationPct), CRASH_TRAIL_STOP_PCT: pctSetting(c.rideTrailStopPct, 95),
    CRASH_RIDE_MAX_HOLD_MIN: pctSetting(c.rideMaxHoldMin, 1_440),
    CRASH_REENTRY_MIN: z.coerce.number().finite().min(0).max(1_440).default(c.reentryMin),
    OPEN_CAPITAL_USD: money(Math.max(capital.plannedStartingCapitalUsd, 15)),
    OPEN_ADD_AT: z.string().regex(/^\s*(\d+(\.\d+)?\s*(,\s*\d+(\.\d+)?\s*)*)?$/).default('2,4'),
    GOLDEN_CAPITAL_USD: money(Math.max(capital.plannedStartingCapitalUsd, 15)),
    GOLDEN_RETEST_ENTRIES: z.enum(['true', 'false']).default('false'),
  }).parse(env);
  const openAdds = e.OPEN_ADD_AT.split(',').map(v => Number(v.trim())).filter(v => Number.isFinite(v) && v > 1).sort((a, b) => a - b).slice(0, 5);
  const ride = e.CRASH_EXIT_MODE === 'ride';
  if (e.CRASH_SLIPPAGE_BPS >= e.CRASH_MAX_DRAG_BPS) throw new Error('CRASH_SLIPPAGE_BPS must be below CRASH_MAX_DRAG_BPS');
  if (e.CRASH_ENTRY_USD > e.CRASH_CAPITAL_USD) throw new Error('CRASH_ENTRY_USD exceeds CRASH_CAPITAL_USD');
  if (e.CRASH_EXIT_SLIPPAGE_BPS < e.CRASH_SLIPPAGE_BPS) throw new Error('CRASH_EXIT_SLIPPAGE_BPS must be at least CRASH_SLIPPAGE_BPS');
  return {
    FAIR: { id: 'FAIR', label: 'FAIR LAUNCH', summary: 'Fair-launch trending tokens: every hard gate plus momentum in two consecutive scans', enabled: true,
      capitalUsd: capital.plannedStartingCapitalUsd, entryUsd: capital.baseEntryUsd, slippageBps: capital.slippageBps, exitSlippageBps: capital.slippageBps, maxDragBps: DESK.maxDragBps,
      maxOpenPositions: DESK.maxOpenPositions, positionCheckMs: DESK.exits.positionCheckMs, exitMode: 'rules', reentryCooldownMs: DESK.reentryCooldownMs,
      exits: { takeProfitPct: rs.takeProfitPct, stopLossPct: rs.stopLossPct, maxHoldMin: rs.maxHoldMin,
        trailing: rs.trailingStopPct > 0 ? { activationPct: rs.trailingActivationPct, stopPct: rs.trailingStopPct } : null, giveback: null } },
    CRASH: { id: 'CRASH', label: 'CRASH', summary: 'Young pools pumping now: entered in one scan, exited within minutes — launch fairness not required, safety gates are',
      enabled: e.CRASH_ENABLED === 'true', capitalUsd: e.CRASH_CAPITAL_USD, entryUsd: e.CRASH_ENTRY_USD, slippageBps: e.CRASH_SLIPPAGE_BPS,
      exitSlippageBps: e.CRASH_EXIT_SLIPPAGE_BPS,
      maxDragBps: BigInt(e.CRASH_MAX_DRAG_BPS), maxOpenPositions: e.CRASH_MAX_POSITIONS, positionCheckMs: c.positionCheckMs,
      exitMode: e.CRASH_EXIT_MODE, reentryCooldownMs: e.CRASH_REENTRY_MIN * 60_000,
      exits: ride
        ? { takeProfitPct: Number.POSITIVE_INFINITY, stopLossPct: e.CRASH_STOP_LOSS_PCT, maxHoldMin: e.CRASH_RIDE_MAX_HOLD_MIN,
          trailing: { activationPct: e.CRASH_TRAIL_ACTIVATION_PCT, stopPct: e.CRASH_TRAIL_STOP_PCT }, giveback: null }
        : { takeProfitPct: e.CRASH_TAKE_PROFIT_PCT, stopLossPct: e.CRASH_STOP_LOSS_PCT, maxHoldMin: e.CRASH_MAX_HOLD_MIN, trailing: null,
          giveback: e.CRASH_LOCK_PEAK_PCT > 0 ? { lockPeakPct: e.CRASH_LOCK_PEAK_PCT, points: e.CRASH_GIVEBACK_PTS } : null } },
    LAUNCH: { id: 'LAUNCH', label: 'LAUNCH', enabled: true,
      summary: 'Fresh pump.fun launches with their own X account and a real website: bought on the curve 1–12 min after creation once the project shows the CA (3 min otherwise), or after graduation up to 90 min / $400K when the X reach is strong; impersonators, rugs and insider dumps blocked or sold (the @glabuz Meme Industries entry); TEST first',
      capitalUsd: capital.plannedStartingCapitalUsd, entryUsd: capital.baseEntryUsd, slippageBps: 600, exitSlippageBps: 1_500, maxDragBps: 1_200n,
      maxOpenPositions: 2, positionCheckMs: 3_000, exitMode: 'rules', reentryCooldownMs: 4 * 60 * 60_000,
      exits: { takeProfitPct: Number.POSITIVE_INFINITY, stopLossPct: 40, maxHoldMin: 240, trailing: { activationPct: 100, stopPct: 35 }, giveback: null, graceMs: 60_000 } },
    OPEN: { id: 'OPEN', label: 'OPEN', enabled: true,
      summary: `The basic screen: a pump.fun launch whose first one-minute candle reached ${usdK(OPENING_RULES.minOpenUsd)}+, that never fell below ${usdK(OPENING_RULES.floorUsd)}, bought when it breaks back above its opening high (×${OPENING_RULES.breakoutOverOpen}); held for at least 6×, the ${usdK(OPENING_RULES.floorUsd)} floor as the stop, adding at ${openAdds.map(m => `${m}×`).join(' and ') || 'no step'}; TEST first`,
      capitalUsd: e.OPEN_CAPITAL_USD, entryUsd: capital.baseEntryUsd, slippageBps: 600, exitSlippageBps: 1_500, maxDragBps: 1_200n,
      maxOpenPositions: 2, positionCheckMs: 3_000, exitMode: 'rules', reentryCooldownMs: 4 * 60 * 60_000, preGraduationExit: false,
      scaleIn: openAdds.map(atMultiple => ({ atMultiple, addUsd: capital.baseEntryUsd })),
      exits: { takeProfitPct: Number.POSITIVE_INFINITY, stopLossPct: 85, maxHoldMin: 1_440, trailing: { activationPct: 0, stopPct: 30 }, giveback: null, graceMs: 60_000,
        holdUntilMultiple: 6, marketCap: { floorUsd: OPENING_RULES.floorUsd, targetUsd: null } } },
    GOLDEN: { id: 'GOLDEN', label: 'GOLDEN POCKET', enabled: true,
      summary: `Fresh pump.fun graduations whose first ${GOLDEN_RULES.onlyUp!.bars} one-minute candles on the pool are only up: bought up to ${
        GOLDEN_RULES.onlyUp!.chasePct}% above candle ${GOLDEN_RULES.onlyUp!.ref}, the stop ${GOLDEN_RULES.onlyUp!.stopBelowPct}% under it, a ${GOLDEN_EXIT.trailing.stopPct}% trailing stop after +${
        GOLDEN_EXIT.trailing.activationPct}%, out after ${GOLDEN_EXIT.maxHoldMin} min (backtest: +7.9% per trade, both halves positive). Break and retest of the old high (66hK2) is ${
        e.GOLDEN_RETEST_ENTRIES === 'true' ? `bought too, sold ${GOLDEN_EXIT.belowResistancePct}% under the breakout high` : 'shown, not bought (break-even in the backtest)'}; TEST first`,
      capitalUsd: e.GOLDEN_CAPITAL_USD, entryUsd: capital.baseEntryUsd, slippageBps: 600, exitSlippageBps: 1_500, maxDragBps: 1_200n,
      maxOpenPositions: 2, positionCheckMs: 3_000, exitMode: 'rules', reentryCooldownMs: 4 * 60 * 60_000, preGraduationExit: false,
      entryKinds: e.GOLDEN_RETEST_ENTRIES === 'true' ? ['ONLY_UP', 'RETEST'] : ['ONLY_UP'],
      exits: { takeProfitPct: Number.POSITIVE_INFINITY, stopLossPct: 40, maxHoldMin: GOLDEN_EXIT.maxHoldMin, trailing: { ...GOLDEN_EXIT.trailing }, giveback: null } },
  };
}

/**
 * GOLDEN POCKET pattern rules (golden-pocket.ts) on graduated pools, from `npm run desk:golden` over 12 h of pump.fun
 * graduations on 1 Oct (533 pools, Birdeye minute candles, judged by the weaker time half; see docs/DESK.md):
 *   only up (2 rising green minutes, bought within 12 % of candle 2, stop 5 % under it, 60 min): +7.9 % per trade, PF 2.0,
 *     weaker half +7 % (310 trades); it holds for 3 candles, any volume filter, 30–60 min holds, and fails past 2 hours.
 *   break and retest (the owner's 66hK2 pattern): break-even at best (PF 1.0), −5…−11 % with the owner's exact levels.
 */
export const GOLDEN_RULES: Readonly<PocketRules> = Object.freeze({
  retest: true, dipMinPct: 15, dipMaxPct: 50, breakoutOverHigh: 1.1, zone: 'EITHER', resistanceBelowPct: 12, resistanceAbovePct: 3, fibTop: 0.5, fibBottom: 0.65,
  stopBelowPct: 5, retestWindowMin: 20, maxPatternMin: 60, onlyUp: { bars: 2, ref: 2, chasePct: 12, windowMin: 10, stopBelowPct: 5 }, floorUsd: 0 });
/** GOLDEN POCKET exits: the pattern's stop (per position), a trailing stop, out after an hour; a retest sells just under the breakout high. */
export const GOLDEN_EXIT = Object.freeze({ trailing: { activationPct: 50, stopPct: 25 }, maxHoldMin: 60, belowResistancePct: 5 });

/** The opening screen's price rules (see opening.ts), shared with the OPEN strategy's floor. */
export const OPENING_RULES = Object.freeze({ minOpenUsd: 10_000, floorUsd: 6_700, breakoutOverOpen: 1.3 });
const usdK = (v: number) => `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;

/**
 * LAUNCH entry rules: the launch radar's quality score plus a clean, still-early curve. A launch whose own X account
 * (or website) shows its CA may be bought from 1 min; others wait 3 min, time for the project to post it or for an
 * impersonator to be exposed. Jupiter quotes new curve tokens within seconds, so routing never sets the window.
 */
export const LAUNCH_ENTRY = Object.freeze({
  minScore: 6, minAgeMin: 3, minAgeConfirmedMin: 1, maxAgeMin: 12,
  minMarketCapUsd: 5_000, maxMarketCapUsd: 40_000,
  /**
   * Second window, after graduation: a launch with strong X reach that outran the curve window (Ansemmas on 1 Oct:
   * curve bought out in 89 s, $63K at 3 min with a 21.7K-view post, $1.03M three hours later; WIRED: $75K at
   * graduation, $2.7M 26 min later). Entered from the first AMM pool up to 90 min after creation, $40K–$400K.
   */
  migrated: Object.freeze({ maxAgeMin: 90, minMarketCapUsd: 40_000, maxMarketCapUsd: 400_000, minScore: 9, minVolume5mUsd: 10_000, minBuys5m: 40,
    minFollowers: 300, minBestViews: 5_000 }),
  minVolume5mUsd: 1_000, minBuys5m: 10,
  maxTop10WalletPct: 35, maxLargestWalletPct: 12, maxDeveloperPct: 10,
});

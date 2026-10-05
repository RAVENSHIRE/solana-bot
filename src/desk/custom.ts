import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../utils/fs';
import { CRASH_DEFAULTS, DESK, type StrategyProfile } from './config';
import { structureLine, type Structure } from './structure';
import type { Candidate, CandidateMetrics, CrashSignal, GateResult } from './types';

/**
 * Custom rule strategies: entry thresholds on the candidate's market data, holders and safety evidence, plus exits and
 * sizing. They are created in the dashboard (or by the strategy assistant), saved in `strategies.json` next to the
 * ledgers, and switched on and off per mode like FAIR and CRASH. Each one trades its own ledger and TEST sleeve.
 *
 * Safety is not configurable: mint authority, freeze authority and dangerous token extensions must pass for every
 * entry, and a pool needs real liquidity so an exit can be quoted.
 */
export const BUILTIN_STRATEGIES = ['FAIR', 'CRASH', 'LAUNCH', 'OPEN', 'GOLDEN'] as const;

const num = z.number().finite();
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().default(null);
const pct100 = num.min(0).max(100);

export const ruleSpecSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/, '2–16 characters, A–Z, 0–9 and _, starting with a letter')
    .refine(id => !(BUILTIN_STRATEGIES as readonly string[]).includes(id), 'FAIR, CRASH, LAUNCH, OPEN and GOLDEN are built in'),
  label: z.string().trim().min(1).max(40),
  summary: z.string().trim().max(400).default(''),
  entry: z.object({
    minMarketCapUsd: opt(num.min(0)), maxMarketCapUsd: opt(num.positive()),
    /** Owners with a balance (DAS count; a capped count is a lower bound). */
    minHolders: opt(z.number().int().min(0)),
    minPoolAgeMin: opt(num.min(0)), maxPoolAgeMin: opt(num.positive()),
    minPriceChange5mPct: opt(num), maxPriceChange5mPct: opt(num),
    minPriceChange1hPct: opt(num), maxPriceChange1hPct: opt(num),
    minVolume5mUsd: opt(num.min(0)), minVolume1hUsd: opt(num.min(0)),
    /** 1h volume as % of market cap ("Vol/MC > 30%"). */
    minVolume1hToMcapPct: opt(num.min(0).max(10_000)),
    minBuySellRatio: opt(num.min(0)),
    /** Required: an exit needs a pool deep enough to be quoted. */
    minLiquidityUsd: num.min(1_000).default(10_000),
    maxTop10WalletPct: opt(pct100), maxLargestWalletPct: opt(pct100),
    /** The token links an X account (not a post or a community). */
    requireXAccount: z.boolean().default(false),
    /**
     * TA2 (research, TA-LAYER.md): enter only when the pool's previous resistance gives a structural stop at most this
     * far below the price; no structure yet (or no pool candles) is a miss.
     */
    maxStructureStopPct: opt(num.positive().max(100)),
  }).strict(),
  exits: z.object({
    /** null: no take profit, the trailing stop or the market-cap target ends the trade. */
    takeProfitPct: opt(num.positive().max(100_000)),
    stopLossPct: num.positive().max(100),
    trailingActivationPct: opt(num.min(0).max(100_000)), trailingStopPct: opt(num.positive().max(95)),
    maxHoldMin: num.positive().max(30 * 24 * 60),
    /** No stop loss or trailing stop in the first seconds after entry (consolidation plays need time to settle). */
    graceSec: num.min(0).max(3_600).default(0),
    /** Exit when the token's market cap falls to this (your floor), or reaches this target. */
    marketCapFloorUsd: opt(num.positive()), marketCapTargetUsd: opt(num.positive()),
    /**
     * TA1: the stop sits at the previous resistance −3 % (set at entry from the pool's candles) instead of the fixed
     * stop, which then applies only to an entry without structure or while the market cap cannot be read.
     */
    structuralStop: z.boolean().default(false),
  }).strict(),
  sizing: z.object({
    capitalUsd: num.positive().max(1_000_000), entryUsd: num.positive().max(100_000),
    maxOpenPositions: z.number().int().min(1).max(10),
    slippageBps: z.number().int().min(10).max(2_000), exitSlippageBps: z.number().int().min(10).max(5_000),
    maxDragPct: num.min(0.5).max(25),
  }).strict(),
  reentryCooldownMin: num.min(0).max(10_080).default(60),
  /**
   * A TEST comparison variant of a built-in strategy: its entries need that strategy's own entry signal (plus the rules
   * above), it enters in the same pass, and in TEST it may hold a token the strategy holds (and the reverse), so both
   * trade the same signals side by side. In LIVE the usual one-holder-per-token rule applies.
   */
  compareWith: z.enum(['CRASH']).nullable().default(null),
}).strict().superRefine((s, ctx) => {
  const issue = (message: string, at: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: at });
  const band = (lo: number | null, hi: number | null, name: string, at: string[]) => { if (lo !== null && hi !== null && lo > hi) issue(`${name}: minimum above maximum`, at); };
  const e = s.entry, x = s.exits, m = s.sizing;
  band(e.minMarketCapUsd, e.maxMarketCapUsd, 'market cap', ['entry', 'maxMarketCapUsd']);
  band(e.minPoolAgeMin, e.maxPoolAgeMin, 'pool age', ['entry', 'maxPoolAgeMin']);
  band(e.minPriceChange5mPct, e.maxPriceChange5mPct, '5m change', ['entry', 'maxPriceChange5mPct']);
  band(e.minPriceChange1hPct, e.maxPriceChange1hPct, '1h change', ['entry', 'maxPriceChange1hPct']);
  if ((x.trailingActivationPct === null) !== (x.trailingStopPct === null)) issue('trailing stop needs both activation and stop', ['exits', 'trailingStopPct']);
  if (x.marketCapFloorUsd !== null && x.marketCapTargetUsd !== null && x.marketCapFloorUsd >= x.marketCapTargetUsd) issue('market-cap floor must be below the target', ['exits', 'marketCapFloorUsd']);
  if (m.entryUsd > m.capitalUsd) issue('entry exceeds the TEST capital', ['sizing', 'entryUsd']);
  if (m.slippageBps >= m.maxDragPct * 100) issue('slippage counts toward the drag cap and must stay below it', ['sizing', 'slippageBps']);
  if (m.exitSlippageBps < m.slippageBps) issue('exit slippage must be at least the entry slippage', ['sizing', 'exitSlippageBps']);
});
export type RuleSpec = z.infer<typeof ruleSpecSchema>;
export type RuleSpecInput = z.input<typeof ruleSpecSchema>;

/** Validates untrusted input (dashboard, assistant) into a spec; the message names the first problem. */
export function parseRuleSpec(input: unknown): RuleSpec {
  const r = ruleSpecSchema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new Error(`INVALID_STRATEGY_SPEC: ${i.path.join('.')}${i.path.length ? ': ' : ''}${i.message}`);
  }
  return r.data;
}

/**
 * The user's own style, as a starting point: established tokens with more than 1,000 holders, bought while the hour
 * moves sideways and the last minutes turn up again (re-entry after consolidation), ridden with a trailing stop
 * instead of a fixed take profit. Untested by the backtest; it starts in TEST.
 */
export const RUNNER_PRESET: RuleSpecInput = {
  id: 'RUNNER', label: 'RUNNER',
  summary: 'Established runners: >1,000 holders, $300K–$20M, bought when a sideways hour turns up again, ridden with a 25% trailing stop',
  entry: { minMarketCapUsd: 300_000, maxMarketCapUsd: 20_000_000, minHolders: 1_000, minPoolAgeMin: 60,
    minPriceChange1hPct: -15, maxPriceChange1hPct: 25, minPriceChange5mPct: 1, maxPriceChange5mPct: 15,
    minVolume1hUsd: 100_000, minBuySellRatio: 1.1, minLiquidityUsd: 50_000, maxTop10WalletPct: 40, maxLargestWalletPct: 10 },
  exits: { takeProfitPct: null, stopLossPct: 25, trailingActivationPct: 30, trailingStopPct: 25, maxHoldMin: 7 * 24 * 60 },
  sizing: { capitalUsd: 5.45, entryUsd: 2, maxOpenPositions: 2, slippageBps: 300, exitSlippageBps: 500, maxDragPct: 8 },
  reentryCooldownMin: 60,
};
/**
 * The owner's four plays (Meme Alpha Coach framework). The desk sells a position in one piece, so the profit ladder
 * (2× / 5× / 10× / trail the rest) is approximated by a trailing stop that activates at the first ladder step.
 */
export const MIGRATION_PRESET: RuleSpecInput = {
  id: 'MIGRATION', label: 'MIGRATION',
  summary: 'Pump.fun graduations at $60K–$300K in their first hour, with Vol/MC > 30%, real holders and no whale; ride with a 30% trailing stop from 2×',
  entry: { minMarketCapUsd: 60_000, maxMarketCapUsd: 300_000, maxPoolAgeMin: 60, minVolume1hToMcapPct: 30, minHolders: 200,
    minLiquidityUsd: 15_000, maxTop10WalletPct: 30, maxLargestWalletPct: 10 },
  exits: { takeProfitPct: null, stopLossPct: 50, trailingActivationPct: 100, trailingStopPct: 30, maxHoldMin: 3 * 24 * 60, graceSec: 60 },
  sizing: { capitalUsd: 5.45, entryUsd: 2, maxOpenPositions: 2, slippageBps: 500, exitSlippageBps: 1_000, maxDragPct: 12 },
  reentryCooldownMin: 60,
};
export const CONSOL_PRESET: RuleSpecInput = {
  id: 'CONSOL', label: 'CONSOLIDATION',
  summary: 'Re-entry after the first pump and dump: $800K–$1.2M, at least 12 h old, a sideways hour with volume still there; never stopped out in the first minute',
  entry: { minMarketCapUsd: 800_000, maxMarketCapUsd: 1_200_000, minPoolAgeMin: 12 * 60, minPriceChange1hPct: -10, maxPriceChange1hPct: 10,
    minPriceChange5mPct: 0, maxPriceChange5mPct: 8, minVolume1hUsd: 30_000, minHolders: 500, minLiquidityUsd: 50_000, maxTop10WalletPct: 40, maxLargestWalletPct: 10 },
  exits: { takeProfitPct: null, stopLossPct: 30, trailingActivationPct: 200, trailingStopPct: 30, maxHoldMin: 3 * 24 * 60, graceSec: 60 },
  sizing: { capitalUsd: 5.45, entryUsd: 2, maxOpenPositions: 2, slippageBps: 300, exitSlippageBps: 800, maxDragPct: 8 },
  reentryCooldownMin: 120,
};
export const SCALP_PRESET: RuleSpecInput = {
  id: 'SCALP', label: '15-MIN SCALP',
  summary: 'Catalyst pumps at $400K–$1M: a big 5m candle with volume and buyers; take +60%, stop −30%, out within 25 minutes',
  entry: { minMarketCapUsd: 400_000, maxMarketCapUsd: 1_000_000, minPriceChange5mPct: 15, maxPriceChange5mPct: 80, minVolume5mUsd: 50_000,
    minBuySellRatio: 1.3, minLiquidityUsd: 40_000, maxTop10WalletPct: 40, maxLargestWalletPct: 10 },
  exits: { takeProfitPct: 60, stopLossPct: 30, trailingActivationPct: null, trailingStopPct: null, maxHoldMin: 25, graceSec: 0 },
  sizing: { capitalUsd: 5.45, entryUsd: 2, maxOpenPositions: 2, slippageBps: 400, exitSlippageBps: 1_000, maxDragPct: 10 },
  reentryCooldownMin: 30,
};
/**
 * CRASH as it ran on the first TEST night (30 Sep, 32 trades, 15 wins, +$4.91), before the backtest rules: pools up to an
 * hour old, any 5m pump from +10 %, no market-cap cap, a tight −15 % stop and a 4-minute time stop. Its profit lock
 * (exit 15 points below a ≥ +40 % peak) becomes a trailing stop. Run it next to CRASH in TEST to compare like for like.
 */
export const CRASH_V1_PRESET: RuleSpecInput = {
  id: 'CRASH_V1', label: 'CRASH V1 (first night)',
  summary: 'The original CRASH rules from the first TEST night, to run side by side with the current CRASH',
  entry: { maxPoolAgeMin: 60, minPriceChange5mPct: 10, maxPriceChange5mPct: 200, minVolume5mUsd: 20_000, minBuySellRatio: 1.3,
    minLiquidityUsd: 10_000, maxTop10WalletPct: 50, maxLargestWalletPct: 15 },
  exits: { takeProfitPct: 100, stopLossPct: 15, trailingActivationPct: 40, trailingStopPct: 11, maxHoldMin: 4, graceSec: 0 },
  sizing: { capitalUsd: 10, entryUsd: 2, maxOpenPositions: 3, slippageBps: 250, exitSlippageBps: 1_000, maxDragPct: 5 },
  reentryCooldownMin: 10,
};
/**
 * CRASH on bigger, slightly older pools (pre-registered 5 Oct 2026, 15:00 UTC): in the 88 TEST trades of CRASH (1–5 Oct),
 * entries at a market cap of $70K or more on a pool at least 5 minutes old made +15.6 % on average (40 trades), the rest
 * −6.1 % (48). That split was found in those same trades, so it proves nothing yet: this preset runs it beside CRASH in
 * TEST on the same signals, with CRASH's own exits, and only its trades from now on count. It takes CRASH's own signal
 * (compareWith) and may hold a coin CRASH holds: before 5 Oct 21:00 UTC CRASH, entering first, kept it out of nearly every coin.
 */
export const CRASH_70K_PRESET: RuleSpecInput = {
  id: 'CRASH_70K', label: 'CRASH 70K+ (5–15 min)',
  summary: 'CRASH on pools at $70K–$300K, 5–15 minutes after graduation; same 5m move, volume, buyers and exits as CRASH',
  entry: { minMarketCapUsd: 70_000, maxMarketCapUsd: 300_000, minPoolAgeMin: 5, maxPoolAgeMin: 15, minPriceChange5mPct: 10, maxPriceChange5mPct: 30,
    minVolume5mUsd: 50_000, minBuySellRatio: 1.3, minLiquidityUsd: 10_000, maxTop10WalletPct: 50, maxLargestWalletPct: 15 },
  exits: { takeProfitPct: 100, stopLossPct: 35, trailingActivationPct: null, trailingStopPct: null, maxHoldMin: 10, graceSec: 0 },
  sizing: { capitalUsd: 10, entryUsd: 2, maxOpenPositions: 3, slippageBps: 250, exitSlippageBps: 1_000, maxDragPct: 5 },
  reentryCooldownMin: 10,
  compareWith: 'CRASH',
};
/**
 * CRASH's TA variants (research, STRATEGY-REVIEW.md C1/C2 and TA-LAYER.md TA1/TA2, pre-registered 5 Oct): the same
 * CRASH signals, in TEST beside CRASH. Only trades after 5 Oct 21:00 UTC count; each needs ≥ 100 trades and the luck
 * test before LIVE. The structure comes from the pool's minute candles (pump.fun graduations watched from the start).
 *   C1 (TA2): skip the entry when the structural stop is more than 25 % below the price, or there is no structure.
 *   C2 (TA1): stop at the previous resistance −3 % instead of −35 %; target and time stop as CRASH.
 */
const CRASH_EXITS = { takeProfitPct: 100, stopLossPct: 35, trailingActivationPct: null, trailingStopPct: null, maxHoldMin: 10, graceSec: 0 };
const CRASH_SIZING = { capitalUsd: 10, entryUsd: 2, maxOpenPositions: 3, slippageBps: 250, exitSlippageBps: 1_000, maxDragPct: 5 };
export const CRASH_C1_PRESET: RuleSpecInput = {
  id: 'CRASH_C1', label: 'CRASH C1 (skip far stops)',
  summary: 'CRASH, but only when the previous resistance gives a stop at most 25% below the price (TA2); CRASH\'s exits',
  entry: { maxStructureStopPct: 25, minLiquidityUsd: 10_000 }, exits: CRASH_EXITS, sizing: CRASH_SIZING, reentryCooldownMin: 10, compareWith: 'CRASH',
};
export const CRASH_C2_PRESET: RuleSpecInput = {
  id: 'CRASH_C2', label: 'CRASH C2 (stop at resistance)',
  summary: 'CRASH\'s entries with the stop at the previous resistance −3% instead of −35% (TA1); +100% target, 10 minutes',
  entry: { minLiquidityUsd: 10_000 }, exits: { ...CRASH_EXITS, structuralStop: true }, sizing: CRASH_SIZING, reentryCooldownMin: 10, compareWith: 'CRASH',
};
export const PRESETS: Record<string, RuleSpecInput> = { RUNNER: RUNNER_PRESET, MIGRATION: MIGRATION_PRESET, CONSOL: CONSOL_PRESET, SCALP: SCALP_PRESET, CRASH_V1: CRASH_V1_PRESET,
  CRASH_70K: CRASH_70K_PRESET, CRASH_C1: CRASH_C1_PRESET, CRASH_C2: CRASH_C2_PRESET };

const usd = (n: number | null) => n === null ? 'UNKNOWN' : `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const pct = (n: number | null) => n === null ? 'UNKNOWN' : `${n.toFixed(1)}%`;
const big = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;

function range(key: string, label: string, v: number | null, lo: number | null, hi: number | null, show: (n: number | null) => string, fmt: (n: number) => string): GateResult[] {
  if (lo === null && hi === null) return [];
  const pass = v !== null && (lo === null || v >= lo) && (hi === null || v <= hi);
  const required = lo !== null && hi !== null ? `${fmt(lo)} to ${fmt(hi)}` : lo !== null ? `≥ ${fmt(lo)}` : `≤ ${fmt(hi!)}`;
  return [{ key, label, status: v === null ? 'UNKNOWN' : pass ? 'PASS' : 'FAIL', actual: show(v), required, blocking: true }];
}

/** Market-only rules: decide in staging whether a token is kept (above FAIR's band too) and analysed for this strategy. */
export function ruleMarketChecks(s: RuleSpec, m: CandidateMetrics): GateResult[] {
  const e = s.entry, signed = (n: number) => `${n >= 0 ? '+' : ''}${n}%`;
  return [
    ...range('ruleMcap', 'Market cap', m.marketCapUsd, e.minMarketCapUsd, e.maxMarketCapUsd, usd, big),
    // Since the token's first AMM pool (its graduation), or its creation while on the curve — never a later extra pool.
    ...range('ruleAge', 'Age (since first pool)', m.firstPoolAgeMin ?? m.tokenAgeMin ?? m.poolAgeMin, e.minPoolAgeMin, e.maxPoolAgeMin, v => v === null ? 'UNKNOWN' : `${Math.round(v)} min`, v => `${v} min`),
    ...range('rule5m', '5m price change', m.priceChange5mPct, e.minPriceChange5mPct, e.maxPriceChange5mPct, pct, signed),
    ...range('rule1h', '1h price change', m.priceChange1hPct, e.minPriceChange1hPct, e.maxPriceChange1hPct, pct, signed),
    ...range('ruleVol5m', '5m volume', m.volume5mUsd, e.minVolume5mUsd, null, usd, big),
    ...range('ruleVol1h', '1h volume', m.volume1hUsd, e.minVolume1hUsd, null, usd, big),
    ...range('ruleVolMc', '1h volume / market cap', m.volume1hUsd !== null && m.marketCapUsd ? m.volume1hUsd / m.marketCapUsd * 100 : null,
      e.minVolume1hToMcapPct, null, pct, v => `${v}%`),
    ...range('ruleBuySell', 'Buy/sell ratio (5m)', m.buySellRatio5m, e.minBuySellRatio, null, v => v?.toFixed(2) ?? 'UNKNOWN', v => String(v)),
    ...(m.migration === 'BONDING_CURVE' && m.liquidityUsd === null
      ? [{ key: 'ruleLiquidity', label: 'AMM liquidity', status: 'FAIL' as const, actual: 'bonding curve — no AMM pool yet', required: `≥ ${big(e.minLiquidityUsd)}`, blocking: true }]
      : range('ruleLiquidity', 'AMM liquidity', m.liquidityUsd, e.minLiquidityUsd, null, usd, big)),
  ];
}
/** Whether staging keeps a token for this strategy; a comparison variant rides on its base strategy's staging. */
export const ruleMarketHint = (s: RuleSpec, m: CandidateMetrics): boolean => s.compareWith === null && ruleMarketChecks(s, m).every(g => g.status === 'PASS');

/** Every rule of the strategy, with the always-on safety gates; UNKNOWN evidence blocks (the token waits for it). */
export function ruleCheck(s: RuleSpec, c: Candidate): CrashSignal {
  const e = s.entry, m = c.metrics, gate = (key: string): GateResult => {
    const g = c.gates.find(x => x.key === key);
    return g ? { ...g, blocking: true } : { key, label: key, status: 'UNKNOWN', actual: 'not evaluated', required: 'PASS', blocking: true };
  };
  const holders = c.holders?.count ?? null, capped = c.holders?.countCapped ?? false;
  const checks: GateResult[] = [
    ...ruleMarketChecks(s, m),
    gate('mintAuthority'), gate('freezeAuthority'), gate('contract'),
    ...(e.minHolders !== null ? [{ key: 'ruleHolders', label: 'Holders', status: holders === null ? 'UNKNOWN' as const : holders >= e.minHolders ? 'PASS' as const : capped ? 'UNKNOWN' as const : 'FAIL' as const,
      actual: holders === null ? (c.holders?.countNote ?? 'not counted yet') : `${holders.toLocaleString('en-US')}${capped ? '+' : ''}`, required: `≥ ${e.minHolders.toLocaleString('en-US')}`, blocking: true }] : []),
    ...range('ruleTop10', 'Top-10 wallet concentration', m.top10WalletPct, null, e.maxTop10WalletPct, pct, v => `${v}%`),
    ...range('ruleLargest', 'Largest single wallet', m.largestWalletPct, null, e.maxLargestWalletPct, pct, v => `${v}%`),
    ...(e.requireXAccount ? [{ key: 'ruleX', label: 'X account linked', status: c.social.x.kind === 'ACCOUNT' ? 'PASS' as const : 'FAIL' as const,
      actual: c.social.x.handle ? `${c.social.x.kind} @${c.social.x.handle}` : c.social.x.kind, required: 'ACCOUNT', blocking: true }] : []),
    ...(s.compareWith === 'CRASH' ? [{ key: 'ruleCrash', label: 'CRASH entry signal', status: !c.crash ? 'UNKNOWN' as const : c.crash.signal ? 'PASS' as const : 'FAIL' as const,
      actual: c.crash ? c.crash.signal ? 'entry-ready' : c.crash.summary : 'not evaluated', required: 'entry-ready', blocking: true }] : []),
    ...(e.maxStructureStopPct !== null ? [structureGate(c.structure ?? null, e.maxStructureStopPct)] : []),
  ];
  const signal = checks.every(g => g.status === 'PASS'), miss = checks.find(g => g.status !== 'PASS');
  const summary = signal
    ? `${usd(m.marketCapUsd)} cap · ${holders !== null ? `${holders.toLocaleString('en-US')}${capped ? '+' : ''} holders · ` : ''}1h ${pct(m.priceChange1hPct)} · 5m ${pct(m.priceChange5mPct)}` +
      (usesStructure(s) ? ` · ${structureLine(c.structure ?? null)}` : '')
    : `${miss!.label}: ${miss!.actual} (${miss!.required})`;
  return { signal, checks, summary };
}

/** Whether a strategy reads the pool's structure (TA1/TA2): the GOLDEN tracker must then sample young pools. */
export const usesStructure = (s: RuleSpec): boolean => s.entry.maxStructureStopPct !== null || s.exits.structuralStop;

/** TA2's gate: a structural stop within the distance; no candles or no structure is a miss (FAIL, not UNKNOWN). */
function structureGate(st: Structure | null, maxPct: number): GateResult {
  const ok = st?.stopPct != null && st.stopPct <= maxPct;
  return { key: 'ruleStructure', label: 'Structural stop distance', status: ok ? 'PASS' : 'FAIL', actual: structureLine(st), required: `≤ ${maxPct}% below (previous resistance −3 %)`, blocking: true };
}

export function ruleProfile(s: RuleSpec, enabled: boolean): StrategyProfile {
  const x = s.exits, z = s.sizing;
  return { id: s.id, label: s.label, summary: s.summary || 'Custom rule strategy', enabled, capitalUsd: z.capitalUsd, entryUsd: z.entryUsd,
    slippageBps: z.slippageBps, exitSlippageBps: z.exitSlippageBps, maxDragBps: BigInt(Math.round(z.maxDragPct * 100)), maxOpenPositions: z.maxOpenPositions,
    // Holds of 15 minutes or less are checked as often as CRASH (2 s): a 5 s check lets a fast stop overshoot further.
    positionCheckMs: x.maxHoldMin <= 15 ? CRASH_DEFAULTS.positionCheckMs : DESK.exits.positionCheckMs, exitMode: 'rules', reentryCooldownMs: s.reentryCooldownMin * 60_000,
    exits: { takeProfitPct: x.takeProfitPct ?? Number.POSITIVE_INFINITY, stopLossPct: x.stopLossPct, maxHoldMin: x.maxHoldMin,
      trailing: x.trailingActivationPct !== null && x.trailingStopPct !== null ? { activationPct: x.trailingActivationPct, stopPct: x.trailingStopPct } : null,
      giveback: null, graceMs: x.graceSec * 1000, marketCap: x.marketCapFloorUsd !== null || x.marketCapTargetUsd !== null ? { floorUsd: x.marketCapFloorUsd, targetUsd: x.marketCapTargetUsd } : null },
    rule: s };
}

/** `strategies.json` beside the ledgers; writes are serialized per file, so the TEST and LIVE engines never interleave. */
const queues = new Map<string, Promise<unknown>>();
const fileOf = (dir: string) => path.join(dir, 'strategies.json');
function serialized<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queues.set(file, next);
  return next;
}
export async function loadRuleSpecs(dir: string): Promise<{ specs: RuleSpec[]; errors: string[] }> {
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(fileOf(dir), 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { specs: [], errors: [] };
    return { specs: [], errors: [`strategies.json unreadable: ${(error as Error).message}`] };
  }
  const list = Array.isArray((raw as { strategies?: unknown }).strategies) ? (raw as { strategies: unknown[] }).strategies : [];
  const specs: RuleSpec[] = [], errors: string[] = [];
  for (const item of list) {
    try { const s = parseRuleSpec(item); if (!specs.some(x => x.id === s.id)) specs.push(s); } catch (error) { errors.push((error as Error).message); }
  }
  return { specs, errors };
}
export function saveRuleSpec(dir: string, spec: RuleSpec): Promise<void> {
  return serialized(fileOf(dir), async () => {
    const { specs } = await loadRuleSpecs(dir);
    const next = [...specs.filter(s => s.id !== spec.id), spec];
    await atomicWriteFile(fileOf(dir), JSON.stringify({ version: 1, strategies: next }, null, 2));
  });
}
export function removeRuleSpec(dir: string, id: string): Promise<void> {
  return serialized(fileOf(dir), async () => {
    const { specs } = await loadRuleSpecs(dir);
    await atomicWriteFile(fileOf(dir), JSON.stringify({ version: 1, strategies: specs.filter(s => s.id !== id) }, null, 2));
  });
}

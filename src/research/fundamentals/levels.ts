/**
 * Market-cap tiers and the round milestones between them ($10K → $100K → $1M → $10M → $100M → $1B).
 *
 * A tier is where a coin trades now; it decides what a strategy can expect there (rug rate, liquidity, how much one
 * entry can be). A milestone is a round market cap that traders watch. Whether milestones act as resistance, or as
 * launch pads once broken, is a hypothesis: `history.ts` measures it against non-round control levels.
 */

export type TierId = 'MICRO' | 'LOW' | 'MID' | 'HIGH' | 'LARGE';
export interface Tier { id: TierId; fromUsd: number; toUsd: number; label: string }

export const TIERS: readonly Tier[] = Object.freeze([
  { id: 'MICRO', fromUsd: 0, toUsd: 100_000, label: 'under $100K' },
  { id: 'LOW', fromUsd: 100_000, toUsd: 1_000_000, label: '$100K–$1M' },
  { id: 'MID', fromUsd: 1_000_000, toUsd: 10_000_000, label: '$1M–$10M' },
  { id: 'HIGH', fromUsd: 10_000_000, toUsd: 100_000_000, label: '$10M–$100M' },
  { id: 'LARGE', fromUsd: 100_000_000, toUsd: Infinity, label: '$100M and up' },
]);

export const MILESTONES: readonly number[] = Object.freeze([10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000]);

/**
 * Largest share of pool liquidity one entry may take to keep price impact near 2 %. The desk's scale-up ladder uses the
 * same rule (`SCALE_RULES.maxImpactShareOfLiquidity` in src/desk/strategies.ts; a test keeps the two equal).
 */
export const MAX_IMPACT_SHARE_OF_LIQUIDITY = 0.02;

const valid = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function tierOf(marketCapUsd: number | null | undefined): Tier | null {
  if (!valid(marketCapUsd)) return null;
  return TIERS.find(t => marketCapUsd >= t.fromUsd && marketCapUsd < t.toUsd) ?? null;
}

export interface MilestoneContext {
  /** Highest milestone at or below the market cap (null under $10K). */
  belowUsd: number | null;
  /** Next milestone above (null at $1B and up). */
  nextUsd: number | null;
  /** Multiple needed to reach the next milestone. */
  toNextX: number | null;
  /** Position between the two milestones on a log scale: 0 at the one below, 1 at the next. */
  decadePosition: number | null;
}

export function milestoneContext(marketCapUsd: number | null | undefined): MilestoneContext {
  if (!valid(marketCapUsd)) return { belowUsd: null, nextUsd: null, toNextX: null, decadePosition: null };
  const below = [...MILESTONES].reverse().find(m => m <= marketCapUsd) ?? null;
  const next = MILESTONES.find(m => m > marketCapUsd) ?? null;
  const lo = below ?? (next !== null ? next / 10 : null);
  return {
    belowUsd: below, nextUsd: next, toNextX: next !== null ? next / marketCapUsd : null,
    decadePosition: lo !== null && next !== null ? Math.log10(marketCapUsd / lo) / Math.log10(next / lo) : null,
  };
}

/** The largest entry the pool can take near 2 % impact, or null without a liquidity reading. */
export function capacityUsd(liquidityUsd: number | null | undefined, share = MAX_IMPACT_SHARE_OF_LIQUIDITY): number | null {
  return valid(liquidityUsd) ? liquidityUsd * share : null;
}

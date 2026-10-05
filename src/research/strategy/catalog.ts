import type { StrategySpec } from './versioning';

/**
 * Strategies as versioned data. The values below are copied from the desk (src/desk/config.ts at 63f4e0e), so a
 * research result about `crash_v001` is a result about the CRASH rule the desk trades. `tests/desk-research-parity`
 * fails when the desk's constants drift from this copy: then register `crash_v002`, never edit v001.
 */

export const CRASH_V001: StrategySpec = {
  id: 'crash_v001', family: 'crash', parent: null,
  description: 'Desk CRASH entry: young graduated pool in the early part of its first move, quick exits.',
  entry: [
    { feature: 'pool_age_min@v1', op: '<=', value: 15, label: 'pool age (min)' },
    { feature: 'price_change_5m_pct@v1', op: 'between', value: [10, 30], label: '5m change (%)' },
    { feature: 'volume_5m_usd@v1', op: '>=', value: 50_000, label: '5m volume ($)' },
    { feature: 'buy_sell_ratio_5m@v1', op: '>=', value: 1.3, label: 'buy/sell 5m' },
    { feature: 'buys_5m@v1', op: '>=', value: 40, label: 'buys 5m' },
    { feature: 'liquidity_usd@v1', op: '>=', value: 10_000, label: 'liquidity ($)' },
    { feature: 'liquidity_to_mcap@v1', op: '>=', value: 0.03, label: 'liquidity / mcap' },
    { feature: 'market_cap_usd@v1', op: '<=', value: 300_000, label: 'market cap ($)' },
    { feature: 'top10_pct@v1', op: '<=', value: 50, whenUnknown: 'PASS', label: 'top-10 (%) when known' },
    { feature: 'largest_wallet_pct@v1', op: '<=', value: 15, whenUnknown: 'PASS', label: 'largest wallet (%) when known' },
  ],
  exit: { stopLossPct: 35, takeProfitPct: 100, trailing: null, maxHoldMin: 10 },
  sizing: { usd: 2 },
  cooldownMin: 10,
  provenance: {
    source: 'src/desk/config.ts CRASH_ENTRY + CRASH_DEFAULTS (quick exit mode)', commit: '63f4e0e',
    notModelled: ['mint and freeze authority revoked', 'dangerous token extensions', 'liquidity drop since the last scan',
      'copycat guard', 'early-warning exits (liquidity −30 % since entry, creator selling)', 'liquidity not dropping'],
  },
};

/**
 * What `npm run desk:backtest` can test from minute candles: CRASH without the count and holder gates, which candles
 * do not carry. A result for this strategy says nothing about those gates.
 */
export const CRASHCANDLE_V001: StrategySpec = {
  ...CRASH_V001, id: 'crashcandle_v001', family: 'crashcandle',
  description: 'CRASH entry as testable from minute candles only (no buy/sell counts, no holder concentration).',
  entry: CRASH_V001.entry.filter(r => !['buy_sell_ratio_5m@v1', 'buys_5m@v1', 'top10_pct@v1', 'largest_wallet_pct@v1'].includes(r.feature)),
  provenance: { ...CRASH_V001.provenance, notModelled: [...(CRASH_V001.provenance.notModelled ?? []), 'buy/sell ratio', 'buy count', 'holder concentration'] },
};

export const CATALOG: readonly StrategySpec[] = [CRASH_V001, CRASHCANDLE_V001];

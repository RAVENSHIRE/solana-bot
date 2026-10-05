import test from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from '../src/research/core/random';
import { standardRegistry } from '../src/research/features/library';
import { CRASH_V001, CRASHCANDLE_V001 } from '../src/research/strategy/catalog';
import { StrategyRegistry, evaluateEntry, strategyFingerprint } from '../src/research/strategy/versioning';
import { DESK_LIKE, FRICTIONLESS, simulateTrade, type ExecutionModelSpec, type PathPoint } from '../src/research/execution/model';
import { RESEARCH_DEFAULT_LIMITS, RiskEngine } from '../src/research/risk/engine';

const T0 = Date.UTC(2026, 9, 2, 10, 0, 0), MIN = 60_000;
const MINT = 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H';
/** Minute bars from closes; each bar opens at the previous close. */
const bars = (closes: number[], liquidity: number | null = 100_000, lows?: number[]): PathPoint[] => closes.map((c, i) => {
  const open = i ? closes[i - 1]! : c;
  return { ts: T0 + (i + 1) * MIN, start: T0 + i * MIN, open, price: c, high: Math.max(open, c), low: lows?.[i] ?? Math.min(open, c), liquidityUsd: liquidity };
});
const exit = CRASH_V001.exit;

test('strategy versions are immutable data with lineage', () => {
  const reg = new StrategyRegistry(standardRegistry());
  const v1 = reg.register(CRASH_V001);
  assert.equal(v1.version, 1);
  assert.equal(reg.register(structuredClone(CRASH_V001)), v1, 'same definition: idempotent');
  assert.throws(() => reg.register({ ...CRASH_V001, exit: { ...CRASH_V001.exit, stopLossPct: 30 } }), /STRATEGY_VERSION_IMMUTABLE/);
  assert.equal(strategyFingerprint({ ...CRASH_V001, description: 'reworded' }), v1.fingerprint, 'wording does not change behaviour');
  const v2 = reg.derive('crash_v001', { exit: { ...CRASH_V001.exit, stopLossPct: 25 } }, 'tighter stop to test');
  assert.equal(v2.id, 'crash_v002');
  assert.deepEqual(reg.lineage('crash_v002').map(v => v.id), ['crash_v001', 'crash_v002']);
  assert.deepEqual(reg.diff('crash_v001', 'crash_v002'), ['exit.stopLossPct']);
  assert.ok(Object.isFrozen(reg.get('crash_v001').exit));
  assert.throws(() => reg.register({ ...CRASH_V001, id: 'crash_v009', entry: [{ feature: 'nope@v1', op: '>', value: 1 }] }), /unknown feature/);
  reg.register(CRASHCANDLE_V001);
  assert.ok(!CRASHCANDLE_V001.entry.some(r => r.feature === 'buys_5m@v1'));
});

test('entry rules: unknown fails unless the rule says "when known"', () => {
  const values: Record<string, number | null> = { 'pool_age_min@v1': 4, 'price_change_5m_pct@v1': 18, 'volume_5m_usd@v1': 80_000, 'buy_sell_ratio_5m@v1': 1.6,
    'buys_5m@v1': 120, 'liquidity_usd@v1': 30_000, 'liquidity_to_mcap@v1': 0.2, 'market_cap_usd@v1': 150_000, 'top10_pct@v1': null, 'largest_wallet_pct@v1': null };
  assert.equal(evaluateEntry(CRASH_V001, values).signal, true);
  const unknownVolume = evaluateEntry(CRASH_V001, { ...values, 'volume_5m_usd@v1': null });
  assert.equal(unknownVolume.signal, false);
  assert.equal(unknownVolume.checks.find(c => c.feature === 'volume_5m_usd@v1')!.status, 'UNKNOWN');
  const tooHot = evaluateEntry(CRASH_V001, { ...values, 'price_change_5m_pct@v1': 45 });
  assert.match(tooHot.summary, /5m change/);
});

test('frictionless execution reproduces the theoretical trade exactly', () => {
  const t = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: bars([1, 1.3, 1.7, 2.2]), model: FRICTIONLESS, rng: seededRng(1) });
  assert.equal(t.status, 'FILLED');
  assert.equal(t.exit!.reason, 'TAKE_PROFIT');
  assert.equal(t.theoretical.returnPct, 100);
  assert.equal(t.netPnlUsd, 2);
  assert.equal(t.netReturnPct, 100);
});

test('desk-like execution: latency, impact, fees and rent make the executable trade worse than the chart', () => {
  const path = bars([1, 1.3, 1.7, 2.2, 2.4]);
  const t = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path, model: { ...DESK_LIKE, txFailureRate: 0 }, rng: seededRng(1) });
  assert.equal(t.status, 'FILLED');
  assert.equal(t.entry!.fillPrice, 1 * (1 + 2 / 50_000), 'inside the first bar: its open plus constant-product impact');
  assert.ok(t.netReturnPct < t.theoretical.returnPct!);
  assert.ok(t.netPnlUsd > 0);
  assert.ok(Math.abs(t.costsUsd - DESK_LIKE.networkFeeUsd * 2) < 1e-12, 'two transactions; rent returned');
});

test('a rug gaps through the stop: the fill is the bar close minus stop slippage, not the stop level', () => {
  const path = bars([1, 0.98, 0.1], 100_000);
  const t = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path, model: { ...DESK_LIKE, txFailureRate: 0, exitLatencyMs: 0 }, rng: seededRng(1) });
  assert.equal(t.exit!.reason, 'STOP_LOSS');
  assert.equal(t.theoretical.returnPct, -35, 'the chart says −35 %');
  assert.ok(t.netReturnPct < -88, `executable ${t.netReturnPct.toFixed(1)} %`);
  const levelFill = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path, model: { ...DESK_LIKE, txFailureRate: 0, exitLatencyMs: 0, gapFill: false }, rng: seededRng(1) });
  assert.ok(levelFill.netReturnPct > -40, 'the old model fills at the level');
});

test('orders that cannot be filled are reported as such, with the fees they cost', () => {
  const model: ExecutionModelSpec = { ...DESK_LIKE, txFailureRate: 0 };
  const jumped = bars([1.2, 1.3]); jumped[0]!.open = 1.1;
  const slip = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: jumped, model, rng: seededRng(1) });
  assert.equal(slip.status, 'FAILED'); assert.equal(slip.failure, 'SLIPPAGE_EXCEEDED'); assert.equal(slip.netPnlUsd, -DESK_LIKE.networkFeeUsd);
  assert.equal(simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: bars([1, 1.1], null), model, rng: seededRng(1) }).failure, 'LIQUIDITY_UNKNOWN');
  assert.equal(simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: [], model, rng: seededRng(1) }).failure, 'NO_MARKET_DATA');
  assert.equal(simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2_000, exit, path: bars([1, 1.1], 20_000), model, rng: seededRng(1) }).failure, 'IMPACT_LIMIT');
  const always: ExecutionModelSpec = { ...DESK_LIKE, txFailureRate: 1 };
  assert.equal(simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: bars([1, 1.1]), model: always, rng: seededRng(1) }).failure, 'TX_FAILED');
});

test('a position that cannot be sold is written off, not marked at a price nobody pays', () => {
  const path = bars([1, 1.05, 0.5, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1]);
  for (const p of path.slice(2)) p.liquidityUsd = 100;   // liquidity pulled
  const t = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path, model: { ...DESK_LIKE, txFailureRate: 0, maxExitAttempts: 3 }, rng: seededRng(1) });
  assert.equal(t.exit!.reason, 'WRITE_OFF');
  assert.ok(t.flags.includes('EXIT_NO_LIQUIDITY'));
  assert.ok(t.netPnlUsd <= -2);
  const open = simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit: { ...exit, maxHoldMin: 600 }, path: bars([1, 1.1, 1.2]), model: FRICTIONLESS, rng: seededRng(1) });
  assert.equal(open.exit!.reason, 'END_OF_DATA');
  assert.ok(open.flags.includes('INCOMPLETE_PATH'));
});

test('same seed, same trades', () => {
  const run = () => simulateTrade({ token: MINT, decisionTime: T0, referencePrice: 1, sizeUsd: 2, exit, path: bars([1, 1.1, 0.9, 1.4, 2.1]), model: { ...DESK_LIKE, txFailureRate: 0.4 }, rng: seededRng(42) });
  assert.deepEqual(run(), run());
});

test('risk engine overrides the strategy and its kill switch stays tripped until an operator resets it', () => {
  const risk = new RiskEngine({ ...RESEARCH_DEFAULT_LIMITS, maxDrawdownUsd: 5, maxDailyLossUsd: 100 });
  const req = { at: T0, token: MINT, sizeUsd: 5, liquidityUsd: 100_000, dataAgeMs: 2_000, healthy: true };
  assert.equal(risk.evaluateEntry(req).decision, 'ALLOW');
  // A position may not exceed a share of the pool: here 0.02 % of $10K = $2.
  const reduced = new RiskEngine({ ...RESEARCH_DEFAULT_LIMITS, maxPositionToLiquidity: 0.0002 }).evaluateEntry({ ...req, liquidityUsd: 10_000 });
  assert.equal(reduced.decision, 'REDUCE'); assert.equal(reduced.sizeUsd, 2); assert.deepEqual(reduced.reasons, ['LIQUIDITY_SHARE']);
  const denied = risk.evaluateEntry({ ...req, dataAgeMs: 600_000, healthy: false, liquidityUsd: null });
  assert.equal(denied.decision, 'DENY');
  assert.deepEqual(denied.reasons.map(r => r.split(' ')[0]), ['SYSTEM_UNHEALTHY', 'STALE_DATA', 'LIQUIDITY_UNKNOWN']);
  risk.onEntry(MINT, 5);
  assert.ok(risk.evaluateEntry(req).reasons.includes('ALREADY_IN_POSITION'));
  risk.onExit(MINT, T0 + MIN, -6);
  assert.equal(risk.state.killed!.reason.startsWith('DRAWDOWN'), true);
  assert.equal(risk.evaluateEntry(req).decision, 'DENY');
  assert.throws(() => risk.reset(T0, '', 'x'), /ACTOR/);
  risk.reset(T0 + 2 * MIN, 'owner', 'reviewed the losing trade');
  assert.equal(risk.evaluateEntry(req).decision, 'ALLOW');
  assert.deepEqual(risk.log.filter(e => e.kind !== 'DENY').map(e => e.kind), ['KILL', 'RESET']);
});

test('risk engine: repeated execution failures and the daily loss limit stop entries', () => {
  const risk = new RiskEngine({ ...RESEARCH_DEFAULT_LIMITS, maxConsecutiveExecFailures: 2, maxDailyLossUsd: 3, maxDrawdownUsd: 1_000 });
  const req = { at: T0, token: MINT, sizeUsd: 2, liquidityUsd: 100_000, dataAgeMs: 1_000, healthy: true };
  risk.onExit('A', T0, -2); risk.onExit('B', T0, -1.5);
  assert.ok(risk.evaluateEntry(req).reasons.includes('DAILY_LOSS_LIMIT'));
  assert.equal(risk.evaluateEntry({ ...req, at: T0 + 86_400_000 }).decision, 'ALLOW', 'a new UTC day');
  risk.onExecutionFailure(T0); risk.onExecutionFailure(T0);
  assert.match(risk.state.killed!.reason, /EXECUTION FAILURES/);
});

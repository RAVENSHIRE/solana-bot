import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent } from '../src/research/events/factory';
import type { EventInput, ResearchEvent } from '../src/research/events/types';
import { KnowledgeIndex, LeakageError, viewAt } from '../src/research/pit/view';
import { auditEvents, differentialLeakageTest, sandboxed, viewLeakageTest } from '../src/research/pit/leakage';
import { FeatureRegistry, computeFeatures, type FeatureDefinition } from '../src/research/features/registry';
import { STANDARD_FEATURES, standardRegistry } from '../src/research/features/library';

const MINT = '7cYaQcAuSTSfUcDXqVM3mAkpSpQo1GiLqm8QDZmPz2kE';
const OTHER = 'F4sTBdunw23aCMuTMJE7scem1VWwcoptL6iwaGeZt3Fe';
const T0 = Date.UTC(2026, 9, 2, 1, 0, 0);
const MIN = 60_000;
const ev = (i: EventInput) => makeEvent({ observed_at: i.timestamp + 500, ...i }, (i.observed_at ?? i.timestamp) + 600);

/** A launch, its curve, its buyers (two funded by one wallet), a creator sell, an own CA post, holders and bars. */
function story(): ResearchEvent[] {
  const e: ResearchEvent[] = [];
  e.push(ev({ event_type: 'TokenCreated', token: OTHER, timestamp: T0 - 3_600_000, source: 'chain:pump', payload: { creator: 'CREATOR1' } }));
  e.push(ev({ event_type: 'RiskFlag', token: OTHER, timestamp: T0 - 3_000_000, source: 'desk:radar', payload: { flag: 'RUG' } }));
  e.push(ev({ event_type: 'TokenCreated', token: MINT, timestamp: T0, source: 'chain:pump', payload: { creator: 'CREATOR1', symbol: 'X' } }));
  for (let i = 0; i <= 6; i++) e.push(ev({ event_type: 'CurveProgress', token: MINT, timestamp: T0 + i * MIN, source: 'chain:curve', payload: { progress_pct: i * i * 2 } }));
  e.push(ev({ event_type: 'WalletFunded', token: null, timestamp: T0 - MIN, source: 'chain:transfers', payload: { wallet: 'A', funder: 'F' } }));
  e.push(ev({ event_type: 'WalletFunded', token: null, timestamp: T0 - MIN, source: 'chain:transfers', payload: { wallet: 'B', funder: 'F' } }));
  const buys: Array<[string, number, number]> = [['A', 100, 2], ['B', 100, 3], ['C', 200, 4], ['D', 100, 5]];
  for (const [w, usd, m] of buys) e.push(ev({ event_type: 'Buy', token: MINT, timestamp: T0 + m * MIN, source: 'chain:swaps', natural_key: `${w}${m}`, payload: { wallet: w, amount_usd: usd } }));
  e.push(ev({ event_type: 'Sell', token: MINT, timestamp: T0 + 5 * MIN + 10_000, source: 'chain:swaps', natural_key: 's1', payload: { wallet: 'C', amount_usd: 150 } }));
  e.push(ev({ event_type: 'CreatorSell', token: MINT, timestamp: T0 + 5 * MIN + 30_000, source: 'chain:swaps', natural_key: 'cs', payload: { wallet: 'CREATOR1', amount_usd: 50 } }));
  e.push(ev({ event_type: 'XContractAddressPost', token: MINT, timestamp: T0 + 80_000, source: 'x', payload: { author: 'proj', own_account: true, followers: 400 } }));
  e.push(ev({ event_type: 'HolderSnapshot', token: MINT, timestamp: T0 + 3 * MIN, source: 'rpc:das', payload: { holder_count: 50, top10_pct: 30, largest_wallet_pct: 8 } }));
  e.push(ev({ event_type: 'HolderSnapshot', token: MINT, timestamp: T0 + 6 * MIN, source: 'rpc:das', payload: { holder_count: 110, top10_pct: 25, largest_wallet_pct: 6 } }));
  e.push(ev({ event_type: 'Graduation', token: MINT, timestamp: T0 + 6 * MIN, source: 'chain:pump-migration', payload: { pool: 'POOL' } }));
  for (let i = 1; i <= 8; i++) {
    const close = T0 + (6 + i) * MIN, price = 0.0001 * (1 + i / 10);
    e.push(ev({ event_type: 'Candle', token: MINT, timestamp: close, source: 'birdeye', payload: { interval_ms: MIN, start: close - MIN, o: price * 0.98, h: price * 1.05, l: price * 0.95, c: price, v: 10_000, supply: 1e9 } }));
  }
  e.push(ev({ event_type: 'LiquidityChange', token: MINT, timestamp: T0 + 14 * MIN, source: 'chain:pool', payload: { liquidity_usd: 30_000 } }));
  return e;
}

test('a view holds only what was known at the decision time, and refuses to look past it', () => {
  const events = story(), v = viewAt(events, T0 + 3 * MIN + 30_000);
  assert.ok(v.events().every(e => e.timestamp <= v.decisionTime && e.available_at <= v.decisionTime));
  assert.equal(v.events({ types: ['Buy'], token: MINT }).length, 2);
  assert.throws(() => v.events({ to: v.decisionTime + 1 }), LeakageError);
  // Known by t but stamped after t: impossible data, excluded and counted.
  const bad = makeEvent({ event_type: 'Buy', token: MINT, timestamp: T0 + 10 * MIN, observed_at: T0, source: 'broken', payload: { wallet: 'Z', amount_usd: 1 } }, T0);
  assert.equal(bad.quality.status, 'INVALID');
  const idx = new KnowledgeIndex([...events, bad], 'OBSERVED');
  assert.equal(idx.excludedInvalid, 1);
  assert.equal(idx.at(T0 + MIN).events({ types: ['Buy'] }).length, 0);
  // Even when INVALID events are let through on purpose, the view still refuses them.
  const v2 = new KnowledgeIndex([...events, bad], 'OBSERVED', { includeInvalid: true }).at(T0 + MIN);
  assert.equal(v2.events({ types: ['Buy'] }).length, 0);
  assert.equal(v2.futureDated, 1);
});

test('the wall clock and Math.random are unavailable during point-in-time computations', () => {
  assert.throws(() => sandboxed(() => Date.now()), /WALL_CLOCK/);
  assert.throws(() => sandboxed(() => new Date()), /WALL_CLOCK/);
  assert.throws(() => sandboxed(() => Math.random()), /RANDOMNESS/);
  assert.equal(sandboxed(() => new Date(T0).getTime()), T0);
  assert.ok(Date.now() > 0 && Math.random() >= 0, 'restored afterwards');
});

test('leakage detector: honest features pass, peeking ones are caught', () => {
  const events = story(), times = [2, 4, 6, 9, 12].map(m => T0 + m * MIN + 15_000);
  const honest = viewLeakageTest('honest', v => v.window(5 * MIN, { types: ['Buy'], token: MINT }).length, events, times);
  assert.equal(honest.passed, true);
  // Closes over the whole dataset ("the highest price this token will ever reach"): it bypasses the view, but reads the
  // same event objects, so replacing the not-yet-known future in place exposes it.
  const peek = viewLeakageTest('peek', () => Math.max(...events.filter(e => e.event_type === 'Candle').map(e => e.payload.h as number)), events, times);
  assert.equal(peek.passed, false);
  assert.ok(peek.violations.some(v => v.kind === 'FUTURE_SENSITIVITY'));
  const peekAhead = viewLeakageTest('peek-ahead', v => Math.max(0, ...events.filter(e => e.event_type === 'Candle' && e.timestamp <= v.decisionTime + 5 * MIN).map(e => e.payload.h as number)), events, times);
  assert.equal(peekAhead.passed, false);
  const clock = viewLeakageTest('clock', v => v.decisionTime - Date.now(), events, times);
  assert.equal(clock.violations[0]!.kind, 'WALL_CLOCK');
  const offByOne = viewLeakageTest('window', v => v.events({ to: v.decisionTime + MIN }).length, events, times);
  assert.equal(offByOne.violations[0]!.kind, 'WINDOW_PAST_DECISION');
});

test('differential test catches look-ahead in series-based signal functions (the desk backtest class, AUDIT #4)', () => {
  interface Series { candles: Array<{ t: number; c: number }>; liquidityRefUsd: number }
  const series: Series = { candles: Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * MIN, c: 1 + i / 10 })), liquidityRefUsd: 50_000 };
  const times = [5, 10, 20].map(m => T0 + m * MIN);
  // Truncation keeps what is knowable at t. A reference observation taken at download time is not: drop it.
  const truncate = (s: Series, t: number): Series => ({ candles: s.candles.filter(k => k.t <= t), liquidityRefUsd: Number.NaN });
  const future = (s: Series, t: number, rng: () => number): Series => ({ candles: s.candles.map(k => (k.t > t ? { ...k, c: k.c * (0.1 + rng() * 10) } : k)), liquidityRefUsd: s.liquidityRefUsd * 0.01 });
  const honest = differentialLeakageTest('momentum', (s: Series, t) => { const k = s.candles.filter(x => x.t <= t); return k.at(-1)!.c / k.at(-6)!.c > 1.1; }, series, times, truncate, future);
  assert.equal(honest.passed, true);
  const usesFutureLiquidity = differentialLeakageTest('liquidity-gate', (s: Series, t) => s.candles.some(x => x.t <= t) && s.liquidityRefUsd >= 10_000, series, times, truncate, future);
  assert.equal(usesFutureLiquidity.passed, false);
  const usesFuturePrices = differentialLeakageTest('peak', (s: Series, t) => Math.max(...s.candles.map(k => k.c)) > s.candles.filter(x => x.t <= t).at(-1)!.c * 2, series, times, truncate, future);
  assert.equal(usesFuturePrices.passed, false);
});

test('data audit: known before it happened, bars stamped at their open, derived before inputs', () => {
  const ok = story();
  assert.equal(auditEvents(ok).passed, true);
  const openStamped = makeEvent({ event_type: 'Candle', token: MINT, timestamp: T0, observed_at: T0 + MIN, source: 'gecko', payload: { interval_ms: MIN, start: T0, o: 1, h: 2, l: 1, c: 2 } }, T0 + MIN);
  const input = makeEvent({ event_type: 'CurveProgress', token: MINT, timestamp: T0, observed_at: T0 + 10_000, source: 'c', payload: { progress_pct: 5 } }, T0 + 10_000);
  const derived = makeEvent({ event_type: 'CurveAcceleration', token: MINT, timestamp: T0, observed_at: T0 + 1_000, source: 'research', causation_ids: [input.event_id], payload: { acceleration: 1 } }, T0 + 1_000);
  const kinds = auditEvents([openStamped, input, derived]).violations.map(v => v.kind).sort();
  assert.deepEqual(kinds, ['BAR_STAMPED_BEFORE_CLOSE', 'DERIVED_BEFORE_INPUTS']);
});

test('feature versions are immutable; dependencies resolve first', () => {
  const r = new FeatureRegistry();
  const base: FeatureDefinition = { name: 'x', version: 1, definition: 'd', unit: 'u', sources: ['Buy'], lookbackMs: 1, timestamp: 'DECISION_TIME', missing: 'NULL',
    dependencies: [], leakageRisk: 'LOW', leakageNotes: 'n', compute: () => 1 };
  const a = r.register(base);
  assert.equal(r.register(base), a, 'idempotent');
  assert.throws(() => r.register({ ...base, definition: 'changed' }), /FEATURE_VERSION_IMMUTABLE/);
  assert.throws(() => r.register({ ...base, compute: () => 2 }), /FEATURE_VERSION_IMMUTABLE/);
  r.register({ ...base, version: 2, compute: () => 2 });
  r.register({ ...base, name: 'y', dependencies: ['x@v2'], compute: (_v, c) => (c.deps['x@v2'] ?? 0) + 1 });
  assert.deepEqual(r.closure(['y@v1']), ['x@v2', 'y@v1']);
  assert.ok(Object.isFrozen(a));
  assert.throws(() => r.register({ ...base, name: 'z', dependencies: ['nope@v1'] }), /unknown dependency/);
});

test('standard features compute the documented values from what was known', () => {
  const events = story(), r = standardRegistry(), idx = new KnowledgeIndex(events);
  // One second after each minute: an observation reaches the system 500 ms after it happens.
  const at = (m: number) => computeFeatures(r, r.list().map(f => f.id), idx.at(T0 + m * MIN + 1_000), MINT).values;
  const f = at(6);
  assert.equal(f['curve_progress@v1'], 72);
  assert.equal(f['curve_velocity@v1'], (72 - 8) / 4);             // window from 1:01: points 2 → 6 min, 8 % → 72 %
  assert.ok(f['curve_acceleration@v1']! > 0);
  assert.equal(f['buyer_hhi@v1'], (100 / 500) ** 2 * 3 + (200 / 500) ** 2);
  // A and B share funder F: three independent buyers, not four.
  assert.equal(Math.round(1 / f['effective_independent_buyers@v1']! * 1000) / 1000, Math.round(((200 / 500) ** 2 * 2 + (100 / 500) ** 2) * 1000) / 1000);
  assert.equal(f['wallet_funding_cluster@v1'], 2 / 4);               // buyers A, B, C, D; A and B share funder F
  assert.equal(f['buy_sell_imbalance@v1'], (500 - 200) / 700);       // last 5 min: A, B, C, D buy 500 vs C 150 + creator 50
  assert.equal(f['creator_sold@v1'], 1);
  assert.equal(f['creator_sell_latency_ms@v1'], 5 * MIN + 30_000);
  assert.equal(f['creator_prior_tokens@v1'], 1);
  assert.equal(f['creator_prior_rugs@v1'], 1);
  assert.equal(f['ca_post_latency_ms@v1'], 80_000);
  assert.equal(f['holder_count@v1'], 110);
  assert.equal(f['holder_growth_velocity@v1'], (110 - 50) / 3);
  assert.equal(f['pool_age_min@v1'], 1 / 60);

  const before = at(5);   // creator sale not yet known, no bars yet
  assert.equal(before['creator_sold@v1'], 0);
  assert.equal(before['creator_sell_latency_ms@v1'], null);
  assert.equal(before['price_usd@v1'], null);
  assert.equal(before['pool_age_min@v1'], null);

  const later = at(14);
  assert.equal(later['price_usd@v1'], 0.0001 * 1.8);
  assert.equal(later['market_cap_usd@v1'], 0.0001 * 1.8 * 1e9);
  assert.equal(later['volume_5m_usd@v1'], 50_000);
  assert.equal(later['liquidity_usd@v1'], 30_000);
  assert.equal(later['liquidity_to_mcap@v1'], 30_000 / (0.0001 * 1.8 * 1e9));
  assert.equal(Math.round(later['price_change_5m_pct@v1']! * 1e6) / 1e6, Math.round((1.8 / 1.3 - 1) * 100 * 1e6) / 1e6);
  // Without a trade feed for a token, flow features are unknown, not zero.
  const none = computeFeatures(r, ['buy_sell_imbalance@v1', 'new_buyer_velocity@v1'], idx.at(T0 + 14 * MIN + 1_000), OTHER).values;
  assert.deepEqual(none, { 'buy_sell_imbalance@v1': null, 'new_buyer_velocity@v1': null });
});

test('every standard feature passes the leakage tests at every decision time', () => {
  const events = story(), r = standardRegistry(), times = Array.from({ length: 16 }, (_, i) => T0 + i * MIN + 7_000);
  for (const f of STANDARD_FEATURES) {
    const id = `${f.name}@v${f.version}`;
    const report = viewLeakageTest(id, v => computeFeatures(r, [id], v, MINT).values[id], events, times);
    assert.equal(report.passed, true, `${id}: ${JSON.stringify(report.violations[0])}`);
  }
  for (const f of r.list()) assert.ok(f.definition && f.leakageNotes && f.unit, f.id);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { byProgress, LEVEL1, levelRow, levelTrades, luckP, type LevelTrade } from '../src/desk/levels';
import type { LedgerEntry } from '../src/desk/types';

const S = LEVEL1.since, M = 60_000;
const row = (side: 'BUY' | 'SELL', at: number, mint: string, net: number | null, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: `${mint}-${at}`, at, mode: 'PAPER',
  txSignature: null, mint, symbol: 'X', router: 'Jupiter', route: 'r', side, quantity: '1000', qtyRaw: '1000000000', entryPriceUsd: 0.002, exitPriceUsd: null,
  grossPnlUsd: net, networkFeeLamports: '5000', networkFeeUsd: 0, routerFeeUsd: 0, totalFeesUsd: 0, netPnlUsd: net, solDeltaLamports: '0', status: 'PAPER_FILLED', note: null, ...extra });
const trades = (pcts: number[], reason: string | null = null): LevelTrade[] => pcts.map((pct, i) => ({ at: S + i * M, pct, reason }));

test('level trades: only trades opened after the clean start, failed orders, drills and scale-ins handled as the stats do', () => {
  const t = levelTrades([
    row('BUY', S - 5 * M, 'old', null), row('SELL', S + M, 'old', 1),                        // opened before the clean start
    row('BUY', S + M, 'a', null), row('BUY', S + 2 * M, 'a', null, { note: 'ADD — scale in' }), row('SELL', S + 3 * M, 'a', -0.9, { exitReason: 'STOP_LOSS -45.00% ≤ -35%' }),
    row('BUY', S + 4 * M, 'b', null), row('SELL', S + 5 * M, 'b', null, { status: 'FAILED' }), row('SELL', S + 6 * M, 'b', 2, { exitReason: 'TAKE_PROFIT 100.20% ≥ 100%' }),
    row('BUY', S + 7 * M, 'c', null, { note: 'DRILL — x' }), row('SELL', S + 8 * M, 'c', 5, { note: 'DRILL — x' }),
  ], S);
  assert.deepEqual(t.map(x => [x.pct, x.reason]), [[-45, 'STOP_LOSS -45.00% ≤ -35%'], [100, 'TAKE_PROFIT 100.20% ≥ 100%']]);
});

test('the luck test is deterministic, small for a steady edge, and about one half without one', () => {
  const edge = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? -30 : 25));
  assert.equal(luckP(edge), luckP(edge), 'same trades, same p');
  assert.ok(luckP(edge)! < 0.01, `steady edge p ${luckP(edge)}`);
  const none = Array.from({ length: 100 }, (_, i) => (i % 2 ? 20 : -20));
  assert.ok(Math.abs(luckP(none)! - 0.5) < 0.1, `no edge p ${luckP(none)}`);
  assert.equal(luckP([5]), null, 'one trade proves nothing');
});

test('a level row: trades, average, luck and how far stops filled past their level', () => {
  const won = trades(Array.from({ length: 70 }, () => 40), 'TAKE_PROFIT'), stopped = trades(Array.from({ length: 30 }, () => -50), 'STOP_LOSS -50.00% ≤ -35%');
  const r = levelRow({ id: 'CRASH', label: 'CRASH', enabled: true, stopLossPct: 35 }, [...won, ...stopped]);
  assert.equal(r.trades, 100); assert.equal(r.avgPct, 13); assert.equal(r.wonPct, 70);
  assert.deepEqual(r.stops, { n: 30, gapPts: 15 }); assert.equal(r.checks.stops, false, '15 points past the stop: the stop does not hold');
  assert.equal(r.checks.trades, true); assert.equal(r.checks.positive, true); assert.equal(r.testPassed, false);
  const tight = levelRow({ id: 'C2', label: 'C2', enabled: true, stopLossPct: 35 }, [...won, ...trades(Array.from({ length: 30 }, () => -40), 'STOP_LOSS')]);
  assert.equal(tight.stops.gapPts, 5); assert.equal(tight.testPassed, tight.checks.luck, 'stops within 10 points: the luck test decides');
  const few = levelRow({ id: 'C1', label: 'C1', enabled: false, stopLossPct: 35 }, trades([10, 12]));
  assert.equal(few.checks.trades, false); assert.equal(few.checks.stops, null, 'no stop yet: not a fail'); assert.equal(few.testPassed, false);
  const empty = levelRow({ id: 'X', label: 'X', enabled: true, stopLossPct: 35 }, []);
  assert.equal(empty.avgPct, null); assert.equal(empty.luckP, null);
  assert.deepEqual([few, empty, r].sort(byProgress).map(x => x.id), ['CRASH', 'C1', 'X'], 'furthest along first');
});

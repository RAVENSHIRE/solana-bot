import assert from 'node:assert/strict';
import test from 'node:test';
import { bars, findBreakout, findW, netPct, trade, W_RULE, type Minute } from '../src/research/w-pattern';

const T0 = Date.parse('2026-10-05T17:15:00Z'), B = W_RULE.barMs;
const m = (bar: number, o: number, h: number, l: number, c: number, vol = 1, minute = 0): Minute => ({ t: T0 + bar * B + minute * 60_000, o, h, l, c, vol, buyers: 1 });
// Peak 100 → first low 65 (−35 %) → neckline 82 (+26 %) → second low 68 → a close at 85 over the neckline.
const W_MINUTES = [m(0, 60, 100, 60, 95, 4), m(1, 95, 95, 65, 70, 10), m(2, 70, 82, 70, 75, 5), m(3, 75, 76, 68, 72, 3), m(4, 72, 86, 72, 85, 20)];

test('15-minute bars from minute candles: open, high, low, close and summed volume', () => {
  const b = bars([m(0, 10, 12, 9, 11, 1, 0), m(0, 11, 15, 10, 14, 2, 7), m(1, 14, 14, 13, 13, 3, 1)]);
  assert.equal(b.length, 2);
  assert.deepEqual({ o: b[0]!.o, h: b[0]!.h, l: b[0]!.l, c: b[0]!.c, vol: b[0]!.vol, n: b[0]!.n }, { o: 10, h: 15, l: 9, c: 14, vol: 3, n: 2 });
});

test('the W: peak, two lows, neckline, breakout close, the volume checks and the stop under the second low', () => {
  const w = findW(bars(W_MINUTES))!;
  assert.equal(w.kind, 'W'); assert.equal(w.j, 4); assert.equal(w.at, T0 + 5 * B, 'decided when the breakout bar closes');
  assert.deepEqual([w.peak, w.low1, w.neckline, w.low2, w.entry], [100, 65, 82, 68, 85]);
  assert.equal(w.v1, true, 'breakout volume 20 ≥ 1.5 × the average 6 between the lows');
  assert.equal(w.v2, true, 'the second low traded 3 against 10');
  assert.ok(Math.abs(w.stop - 68 * 0.97) < 1e-9);
  // The same W with a thin breakout: found, without volume.
  const thin = findW(bars([...W_MINUTES.slice(0, 4), m(4, 72, 86, 72, 85, 2)]))!;
  assert.equal(thin.v1, false);
  // A second low 25 % under the first is no W; nor is a shallow first fall (−20 %).
  assert.equal(findW(bars([...W_MINUTES.slice(0, 3), m(3, 75, 76, 48, 72, 3), m(4, 72, 86, 72, 85, 20)])), null);
  assert.equal(findW(bars([m(0, 60, 100, 60, 95), m(1, 95, 95, 80, 85), m(2, 85, 97, 85, 90), m(3, 90, 91, 81, 88), m(4, 88, 99, 88, 98)])), null);
});

test('the trade: take profit, a stop that gaps, the graduation, and the costs', () => {
  const w = findW(bars(W_MINUTES))!;
  const up = trade(w, { complete: null, minutes: [...W_MINUTES, m(5, 85, 120, 84, 110), m(5, 110, 175, 108, 160, 1, 1)] }, 100);
  assert.equal(up.reason, 'TAKE_PROFIT'); assert.equal(up.exit, 170); assert.equal(up.grossPct, 100);
  const gap = trade(w, { complete: null, minutes: [...W_MINUTES, m(5, 85, 90, 80, 82), m(5, 50, 52, 40, 45, 1, 1)] }, 100);
  assert.equal(gap.reason, 'STOP'); assert.equal(gap.exit, 50, 'opened under the stop: filled at the open');
  const grad = trade(w, { complete: T0 + 5 * B + 2 * 60_000, minutes: [...W_MINUTES, m(5, 85, 120, 84, 118), m(5, 118, 150, 117, 148, 1, 1), m(5, 148, 200, 140, 190, 1, 2)] }, 100);
  assert.equal(grad.reason, 'GRADUATION'); assert.equal(grad.exit, 148, 'the last curve price before it completed');
  assert.ok(Math.abs(netPct(100) - ((2 * 0.9875 * 0.9875 - 1) * 100 - 1.5)) < 1e-9);
});

test('the control: the first close over the highest high of the 8 bars before it', () => {
  const flat = Array.from({ length: 8 }, (_, i) => m(i, 50, 55, 45, 50, 2));
  const k = findBreakout(bars([...flat, m(8, 50, 60, 50, 58, 5)]))!;
  assert.equal(k.kind, 'BREAKOUT'); assert.equal(k.entry, 58); assert.equal(k.neckline, 55); assert.equal(k.v1, true); assert.ok(Math.abs(k.stop - 45 * 0.97) < 1e-9);
  assert.equal(findBreakout(bars([...flat, m(8, 50, 54, 50, 53)])), null);
});

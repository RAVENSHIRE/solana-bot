import assert from 'node:assert/strict';
import test from 'node:test';
import { addSample, structure, structureLine, STRUCTURE, type Bar } from '../src/desk/structure';
import { GoldenShadow, GRADUATION_MCAP_SOL, SHADOW, type ShadowRecord } from '../src/desk/golden-shadow';
import { RecorderWatch, RECORDER_WATCH } from '../src/desk/recorder-watch';
import { PRESETS, parseRuleSpec, ruleCheck, ruleMarketHint, usesStructure } from '../src/desk/custom';
import type { Candidate } from '../src/desk/types';

const M = 60_000, T0 = Date.UTC(2026, 9, 5, 18, 0);
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: T0 + i * M, o, h, l, c });
// $150K → a $190K swing high → back to $175K → a close at $198K breaks it; minute 4 is still running.
const BARS = [bar(0, 150, 170, 150, 165), bar(1, 165, 190, 160, 180), bar(2, 180, 185, 170, 175), bar(3, 175, 200, 175, 198), bar(4, 198, 260, 120, 140)]
  .map(b => ({ ...b, o: b.o * 1000, h: b.h * 1000, l: b.l * 1000, c: b.c * 1000 }));

test('structure: the previous resistance is the last broken swing high below the price; stop 3 % under it, target 2R; only complete minutes count', () => {
  const at = T0 + 4.5 * M, s = structure(BARS, at, 200_000);
  assert.equal(s.bars, 4, 'minute 4 is not complete at 4.5 min: its $260K high and $120K low are not known yet');
  assert.equal(s.resistance, 190_000);
  assert.equal(s.stop, 190_000 * 0.97);
  assert.ok(Math.abs(s.stopPct! - (200_000 - 184_300) / 200_000 * 100) < 1e-9);
  assert.ok(Math.abs(s.target! - 200_000 * (1 + 2 * s.stopPct! / 100)) < 1e-6, 'no swing high above the price: 2× the stop distance');
  assert.ok(Math.abs(s.firstX! - 170 / 150) < 1e-12); assert.ok(Math.abs(s.firstWick! - 5 / 20) < 1e-12);
  assert.ok(Math.abs(s.range5! - (200 - 150) / 198) < 1e-12);
  assert.match(structureLine(s), /^stop \$184\.3K \(prev\. resistance \$190\.0K, −8 %\) · target \$231\.4K \(\+16 %\)$/);
  // Before minute 2 closed, minute 1 was not a confirmed swing high; and an unbroken swing high is no resistance.
  assert.equal(structure(BARS, T0 + 2.5 * M, 182_000).resistance, null);
  assert.equal(structure(BARS.slice(0, 3), T0 + 3.5 * M, 176_000).resistance, null, '$190K was never closed above');
  assert.match(structureLine(structure(BARS.slice(0, 3), T0 + 3.5 * M, 176_000)), /^no structure yet: no stop level/);
  assert.equal(structureLine(null), 'no pool candles yet');
  // A price under the broken swing high: that level is not below it, so it is not the stop.
  assert.equal(structure(BARS, T0 + 4.5 * M, 185_000).resistance, null);
  assert.deepEqual([STRUCTURE.bufferPct, STRUCTURE.maxStopPct, STRUCTURE.wickWarning, STRUCTURE.targetR], [3, 25, 0.5, 2], 'pre-registered thresholds');
});

test('structure: live samples (every 4 s) and backtest minute candles give the same levels', () => {
  const live: Bar[] = [];
  for (const b of BARS.slice(0, 4)) for (const [dt, v] of [[1_000, b.o], [16_000, b.h], [31_000, b.l], [59_000, b.c]] as const) addSample(live, T0, b.t + dt, v);
  addSample(live, T0, T0 - 1, 1); // a sample before the start is ignored, never invents a minute
  assert.deepEqual(live.map(b => ({ ...b })), BARS.slice(0, 4));
  assert.deepEqual(structure(live, T0 + 4.5 * M, 200_000), structure(BARS, T0 + 4.5 * M, 200_000));
});

test('GOLDEN shadow trades (P2): bot and phone entries, exits a (GOLDEN), b (+100 % take profit), c (half at +100 %), one record', () => {
  const rows: ShadowRecord[] = [], book = new GoldenShadow(r => { rows.push(r); });
  assert.ok(Math.abs(GRADUATION_MCAP_SOL - 410.9) < 0.1, 'a pump.fun curve completes at about 410.9 SOL');
  book.start({ mint: 'M', symbol: 'ABC', fillAt: T0, fillUsd: 50_000, stopUsd: 45_000, poolJumpX: 1.2, graduationUsd: 48_000 });
  assert.deepEqual(book.mints(), ['M']);
  const s = (dt: number, cap: number) => book.sample('M', cap, T0 + dt);
  s(4_000, 50_000);   // bot entry
  s(48_000, 60_000);  // phone entry
  s(60_000, 105_000); // bot +110 %: take profit (b) and the half (c); phone +75 %
  s(64_000, 125_000); // phone +108 %: its take profit; the trail is active for both
  s(68_000, 90_000);  // −28 % from the $125K peak: trailing stop (a) for both
  assert.equal(rows.length, 1); assert.deepEqual(book.mints(), []);
  const [bot, phone] = rows[0]!.legs;
  assert.equal(bot!.entryUsd, 50_000); assert.equal(phone!.entryUsd, 60_000);
  assert.equal(bot!.b!.reason, 'TAKE_PROFIT'); assert.ok(Math.abs(bot!.b!.pct - 110) < 1e-9);
  assert.equal(bot!.a!.reason, 'TRAILING_STOP'); assert.ok(Math.abs(bot!.a!.pct - 80) < 1e-9);
  assert.ok(Math.abs(bot!.c!.pct - (110 + 80) / 2) < 1e-9, 'half at +110 %, half on the trail');
  assert.equal(phone!.a!.reason, 'TRAILING_STOP'); assert.ok(Math.abs(phone!.a!.pct - 50) < 1e-9);
  assert.equal(rows[0]!.poolJumpX, 1.2);
  // A rug through the pattern stop: (a), (b) and (c) all lose the same; a pool that stops being sampled closes at its last value.
  const r2: ShadowRecord[] = [], b2 = new GoldenShadow(r => { r2.push(r); });
  b2.start({ mint: 'R', symbol: null, fillAt: T0, fillUsd: 50_000, stopUsd: 45_000, poolJumpX: 40, graduationUsd: 48_000 });
  b2.sample('R', 50_000, T0 + 4_000); b2.sample('R', 4_000, T0 + 8_000);
  b2.expire(T0 + (SHADOW.maxHoldMin + 6) * M, () => ({ cap: 4_000, at: T0 + 8_000 }));
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.legs[0]!.a!.reason, 'POCKET_STOP'); assert.ok(Math.abs(r2[0]!.legs[0]!.a!.pct + 92) < 1e-9);
  assert.equal(r2[0]!.legs[1]!.a!.reason, 'NO_SAMPLE', 'the phone entry never came: the pool was not sampled 45 s after the fill');
});

test('recorder dead-man: one phone message after 10 silent minutes, one when it records again; a fresh start is not silence', async () => {
  const sent: string[] = [];
  let last: number | null = T0 - 60 * M;
  const watch = new RecorderWatch('dir', async t => { sent.push(t); }, T0, async () => last);
  assert.equal(await watch.check(T0 + 5 * M), null, 'the desk itself started 5 min ago: not 10 min of silence yet');
  assert.equal(await watch.check(T0 + RECORDER_WATCH.silentMs), 'DOWN');
  assert.equal(await watch.check(T0 + 20 * M), null, 'said once');
  assert.match(watch.status(T0 + 20 * M), /^SILENT since 18:00 UTC/);
  last = T0 + 21 * M;
  assert.equal(await watch.check(T0 + 21.5 * M), 'UP');
  assert.deepEqual(sent, ['Research recorder silent', 'Research recorder back']);
  assert.match(watch.status(T0 + 21.5 * M), /^last record 30 s ago/);
});

test('CRASH variants: C1 needs a structural stop within 25 %, C2 takes its stop from the structure, both need CRASH\'s own signal', () => {
  const c1 = parseRuleSpec(PRESETS.CRASH_C1), c2 = parseRuleSpec(PRESETS.CRASH_C2), k70 = parseRuleSpec(PRESETS.CRASH_70K);
  assert.deepEqual([c1.compareWith, c2.compareWith, k70.compareWith], ['CRASH', 'CRASH', 'CRASH']);
  assert.deepEqual([usesStructure(c1), usesStructure(c2), usesStructure(k70)], [true, true, false]);
  assert.equal(c1.entry.maxStructureStopPct, 25); assert.equal(c2.exits.structuralStop, true); assert.equal(c2.exits.stopLossPct, 35);
  assert.equal(parseRuleSpec({ ...PRESETS.RUNNER }).compareWith, null, 'saved strategies without the field keep trading on their own');
  const pass = { key: '', label: '', status: 'PASS' as const, actual: '', required: '', blocking: true };
  const cand = (crash: boolean, stopPct: number | null): Candidate => ({ metrics: { liquidityUsd: 50_000, marketCapUsd: null, priceChange1hPct: null, priceChange5mPct: null, top10WalletPct: null, largestWalletPct: null }, gates: ['mintAuthority', 'freezeAuthority', 'contract'].map(key => ({ ...pass, key })),
    holders: null, social: { x: { kind: 'NONE', handle: null } }, crash: { signal: crash, checks: [], summary: crash ? 'ok' : '5m price change: 4% (+10% to +30%)' },
    structure: stopPct === null ? null : { price: 100, resistance: 100 - stopPct - 3, stop: 100 - stopPct, stopPct, target: 120, targetPct: 20, firstX: 1, firstWick: 0, range5: 0.2, bars: 6 } } as unknown as Candidate);
  assert.equal(ruleCheck(c1, cand(true, 8)).signal, true);
  assert.match(ruleCheck(c1, cand(true, 8)).summary, /stop \$0\.1K/);
  assert.equal(ruleCheck(c1, cand(true, 31)).signal, false);
  assert.match(ruleCheck(c1, cand(true, null)).summary, /^Structural stop distance: no pool candles yet/);
  assert.match(ruleCheck(c2, cand(false, 8)).summary, /^CRASH entry signal: 5m price change/);
  assert.equal(ruleCheck(c2, cand(true, null)).signal, true, 'C2 enters without structure; its fixed −35 % stop then applies');
  assert.equal(ruleMarketHint(c1, { liquidityUsd: 50_000 } as never), false, 'staged by CRASH, not on its own');
});

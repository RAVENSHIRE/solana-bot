import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { OPENING, OpeningTracker, curveMarketCapSol, openingSpeed, openingStep, type OpeningRecord, type OpeningState } from '../src/desk/opening';
import { exitReason } from '../src/desk/strategies';
import { strategyProfiles, deskCapital } from '../src/desk/config';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const T0 = Date.parse('2026-10-01T21:50:00Z');
const state = (at = T0): OpeningState => ({ mint: key(1), symbol: 'FIX6900', name: 'Fantasy Index 6900', at, status: 'OPENING', openHighUsd: null, lowUsd: null, lastUsd: null,
  peakUsd: null, firstSampleAt: null, lastSampleAt: null, signalAt: null, signalUsd: null, detail: '', samples: [] });

test('the owner\'s FIX6900 path: $20K opening candle → $7K (floor held) → $14K → $27K is the breakout, not before', () => {
  const s = state();
  const path: Array<[number, number, boolean]> = [[8, 12_000, false], [30, 20_000, false], [55, 16_000, false], // the opening minute: high $20K
    [90, 9_000, false], [140, 7_000, false], [200, 14_000, false], [260, 25_000, false], [300, 27_000, true]];
  for (const [sec, usd, signal] of path) assert.equal(openingStep(s, T0 + sec * 1000, usd), signal, `${usd} at ${sec}s`);
  assert.equal(s.status, 'SIGNAL'); assert.equal(s.openHighUsd, 20_000); assert.equal(s.lowUsd, 7_000); assert.equal(s.signalUsd, 27_000);
  assert.equal(s.detail, '$20.0K open → low $7.0K (held $6.7K) → $27.0K: broke above the opening high');
  assert.equal(openingStep(s, T0 + 320_000, 35_000), false, 'a signal fires once');
});

test('below the $6.7K floor is a rug; a weak opening candle or a launch first seen too late is never judged', () => {
  const rug = state();
  openingStep(rug, T0 + 20_000, 20_000); openingStep(rug, T0 + 70_000, 9_000);
  assert.equal(openingStep(rug, T0 + 100_000, 6_500), false); assert.equal(rug.status, 'RUG');
  assert.match(rug.detail, /^fell to \$6\.5K below the \$6\.7K floor after a \$20\.0K open/);
  assert.equal(openingStep(rug, T0 + 200_000, 40_000), false, 'a rug never signals later');
  const weak = state();
  openingStep(weak, T0 + 20_000, 8_000); openingStep(weak, T0 + 70_000, 30_000);
  assert.equal(weak.status, 'WEAK', 'an opening candle under $10K is not the screen');
  const late = state();
  openingStep(late, T0 + 50_000, 20_000);
  assert.equal(late.status, 'UNKNOWN_OPEN');
});

test('market cap from the bonding curve: a fresh pump.fun curve is ~28 SOL; a completed curve is reported as graduated', () => {
  const b = Buffer.alloc(151);
  b.writeBigUInt64LE(1_073_000_000_000_000n, 8); b.writeBigUInt64LE(30_000_000_000n, 16); b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  assert.ok(Math.abs(curveMarketCapSol(b)!.sol - 27.96) < 0.01);
  b[48] = 1; assert.deepEqual(curveMarketCapSol(b), { sol: 0, complete: true });
  assert.equal(curveMarketCapSol(Buffer.alloc(20)), null);
});

test('the tracker reads every watched curve in one call per 100 and reports each breakout once', async () => {
  const solUsd = 100, mint = key(2), other = key(3);
  // Market cap in SOL = vSol/vTok × supply: set vSol so that cap(USD) hits the path.
  const curve = (usd: number) => { const b = Buffer.alloc(151); b.writeBigUInt64LE(1_000_000_000_000_000n, 8); b.writeBigUInt64LE(BigInt(Math.round(usd / solUsd * 1e9)), 16);
    b.writeBigUInt64LE(1_000_000_000_000_000n, 40); return b; };
  let caps: Record<string, number> = { [mint]: 20_000, [other]: 5_000 };
  const calls: number[] = [];
  const conn = { getMultipleAccountsInfo: async (keys: unknown[]) => { calls.push(keys.length); return [mint, other].map(m => ({ data: curve(caps[m]!) })); } };
  const t = new OpeningTracker({ execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never);
  t.observe([{ mint, symbol: 'AAA', name: 'A', at: T0 }, { mint: other, symbol: 'BBB', name: 'B', at: T0 }], T0 + 5_000);
  assert.deepEqual(await t.poll(T0 + 10_000, null), [], 'no SOL price, no reading');
  await t.poll(T0 + 10_000, solUsd);
  caps = { [mint]: 8_000, [other]: 9_000 }; await t.poll(T0 + 70_000, solUsd);
  assert.equal(t.get(mint)!.status, 'STRONG'); assert.equal(t.get(other)!.status, 'WEAK');
  caps = { [mint]: 27_000, [other]: 9_000 };
  const signals = await t.poll(T0 + 200_000, solUsd);
  assert.deepEqual(signals.map(s => s.symbol), ['AAA']);
  assert.deepEqual(await t.poll(T0 + 204_000, solUsd), []);
  assert.deepEqual(calls, [2, 2, 1], 'weak opens and signalled launches are no longer read');
  assert.deepEqual(t.list().map(s => s.symbol), ['AAA']); assert.equal(t.counts().SIGNAL, 1);
  assert.equal(OPENING.breakoutOverOpen, 1.3);
});

test('OPEN exits: no profit-taking before 6× the first entry; the $6.7K floor is the stop; then a 30% trailing stop', () => {
  const p = strategyProfiles({}, deskCapital({}), { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 }).OPEN;
  assert.deepEqual(p.scaleIn, [{ atMultiple: 2, addUsd: 2 }, { atMultiple: 4, addUsd: 2 }]); assert.equal(p.preGraduationExit, false);
  const base = { pnlPct: 150, peakPct: 300, fromPeakPct: -40, heldMs: 600_000, marketCapUsd: 60_000 };
  assert.equal(exitReason(p.exits, { ...base, peakMultiple: 4.5 }), null, 'at 4.5× a 40% pullback is held through');
  assert.match(exitReason(p.exits, { ...base, peakMultiple: 6.2 })!, /^TRAILING_STOP -40\.00% from peak/);
  assert.match(exitReason(p.exits, { ...base, peakMultiple: 2, marketCapUsd: 6_600 })!, /^MCAP_FLOOR \$6,600 ≤ \$6,700/);
  assert.equal(exitReason(p.exits, { ...base, pnlPct: -60, peakMultiple: 1, marketCapUsd: 9_000, fromPeakPct: -60 }), null, 'a deep dip above the floor is held');
});

test('the card keeps its rows: every listed status change is saved and comes back after a restart (24 h); every read goes to the screen tape', async () => {
  const solUsd = 100, mint = key(4), old = key(5);
  const curve = (usd: number) => { const b = Buffer.alloc(151); b.writeBigUInt64LE(1_000_000_000_000_000n, 8); b.writeBigUInt64LE(BigInt(Math.round(usd / solUsd * 1e9)), 16);
    b.writeBigUInt64LE(1_000_000_000_000_000n, 40); return b; };
  let cap = 20_000;
  const conn = { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => ({ data: curve(cap) })) };
  const rpc = { execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never;
  const saved: OpeningRecord[] = [], tape: string[] = [];
  const store = { load: () => saved, save: (r: OpeningRecord) => { saved.push(r); } };
  const t = new OpeningTracker(rpc, null, store, T0);
  t.tape = { openingSample: (s, at, usd) => { tape.push(`OS ${s.status} ${usd}`); }, openingChange: s => { tape.push(`OC ${s.status}`); } };
  t.observe([{ mint, symbol: 'AAA', name: 'A', at: T0 }], T0 + 5_000);
  await t.poll(T0 + 10_000, solUsd);                 // opening minute: $20K
  cap = 9_000; await t.poll(T0 + 70_000, solUsd);    // strong open
  cap = 27_000; await t.poll(T0 + 200_000, solUsd);  // breakout
  assert.deepEqual(saved.map(r => r.status), ['STRONG', 'SIGNAL'], 'each listed status change, once');
  assert.deepEqual(saved[1]!.firstSample, [T0 + 10_000, 20_000], 'the first read, for the speed');
  assert.deepEqual(tape, ['OS OPENING 20000', 'OS STRONG 9000', 'OC STRONG', 'OS SIGNAL 27000', 'OC SIGNAL'], 'every read, then the change it caused');
  // A restart: the same rows; one from yesterday is not brought back.
  saved.push({ ...saved[1]!, mint: old, symbol: 'OLD', at: T0 - 25 * 3_600_000 });
  const after = new OpeningTracker(rpc, null, store, T0 + 300_000);
  assert.deepEqual(after.list().map(s => [s.symbol, s.status]), [['AAA', 'SIGNAL']]);
  assert.equal(openingSpeed(after.get(mint)!)?.multiple.toFixed(2), '1.35', 'the speed survives the restart');
  // Rows stay listed for the history window, not 2 hours.
  after.observe([], T0 + 5 * 3_600_000);
  assert.equal(after.list().length, 1);
  after.observe([], T0 + OPENING.historyMs + 1);
  assert.equal(after.list().length, 0);
});

test('the history file and the screen tape on disk: append, reload the last record per coin, compact records', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { openingStore } = await import('../src/desk/runtime');
  const { screenTape } = await import('../src/desk/screen-tape');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-store-')), file = path.join(dir, 'opening-screen.jsonl');
  try {
    const store = openingStore(file), now = Date.now();
    const row = (status: OpeningState['status'], at = now) => ({ ...state(at), status, openHighUsd: 20_000, firstSample: [at, 5_000] as [number, number] });
    assert.deepEqual(store.load(), [], 'no file yet');
    store.save(row('STRONG')); store.save(row('SIGNAL')); fs.appendFileSync(file, '{"torn');
    assert.deepEqual(store.load().map(r => r.status), ['SIGNAL'], 'the last record of the coin; a torn line is skipped');
    const recs: unknown[][] = [];
    const tape = screenTape({ put: r => { recs.push(r as unknown[]); }, lowDisk: false });
    tape.openingSample({ ...state(now), status: 'STRONG' }, now, 12_345.6);
    tape.goldenSample(key(9), now, 98_765.4, 20_000.2, 'IMPULSE');
    assert.deepEqual(recs, [['OS', now, { $m: key(1) }, 'STRONG', 12_346], ['GS', now, { $m: key(9) }, 98_765, 20_000, 'IMPULSE']]);
    const quiet = screenTape({ put: () => { throw new Error('disk'); }, lowDisk: false });
    assert.doesNotThrow(() => quiet.openingSample(state(now), now, 1), 'a failing write never stops the screen');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

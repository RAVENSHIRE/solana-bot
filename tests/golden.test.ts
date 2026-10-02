import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { GoldenTracker, PUMP_AMM_PROGRAM, PUMP_QUOTE_MINT, WSOL_MINT, decodePumpSwapPool, pocketState, pocketStep, pumpSwapPool, type PocketRules } from '../src/desk/golden-pocket';
import { GOLDEN_RULES, deskCapital, strategyProfiles } from '../src/desk/config';
import { exitReason, goldenEntryCheck } from '../src/desk/strategies';
import { capSeries, pocketTrade } from '../src/desk/backtest';

const K = 1000, MIN = 60_000;
const BULLISHCAT = '66hK2GEsF5djkH6JWYCVKytuhz5Hc6bvsDQzRgqrpump';
const T0 = Date.parse('2026-10-01T21:41:00Z');
/** 66hK2 (BULLISHCAT) on 1 Oct, market cap per minute from 21:41 (Birdeye, USD): o, h, l, c in $K. */
const BULLISHCAT_1M = [[3.4, 162.8, 3.4, 140.9], [140.9, 143.4, 126.5, 139.5], [139.5, 144.8, 125.8, 134.6], [134.6, 159.8, 126.5, 146.9], [146.9, 157.1, 123.1, 133.0],
  [133.0, 154.4, 107.9, 117.6], [117.6, 139.4, 107.7, 129.1], [129.1, 157.6, 120.6, 150.7], [150.7, 163.9, 142.1, 156.3], [156.3, 167.5, 146.4, 167.5],
  [167.5, 202.9, 161.6, 194.4], [194.4, 225.0, 185.8, 212.7], [212.7, 224.4, 160.1, 174.3], [174.3, 193.4, 157.9, 182.9], [182.9, 201.6, 172.5, 198.5], [198.5, 249.0, 181.9, 220.7]]
  .map(([o, h, l, c], i) => ({ t: T0 + i * MIN, o: o! * K, h: h! * K, l: l! * K, c: c! * K }));
const run = (rules: PocketRules, bars: Array<{ t: number; o: number; h: number; l: number; c: number }>, startAt = bars[0]!.t) => {
  const s = pocketState(startAt);
  for (const b of bars) { const e = pocketStep(s, rules, b); if (e) return { s, e }; }
  return { s, e: null };
};

test('GOLDEN POCKET break and retest: 66hK2 — $163K high, dip to $108K, breakout to $225K, bought on the retest of the old high', () => {
  const { s, e } = run(GOLDEN_RULES, BULLISHCAT_1M);
  assert.ok(e, s.detail);
  assert.equal(e.kind, 'RETEST'); assert.equal(e.at, T0 + 12 * MIN, 'the 21:53 candle, low $160.1K');
  assert.equal(s.high, 162.8 * K); assert.equal(s.low, 107.7 * K); assert.equal(e.resistance, 225 * K);
  assert.ok(Math.abs(e.price - 162.8 * K * 1.03) < 1, 'filled at the pocket top: the old high +3%');
  assert.ok(Math.abs(e.stop - 162.8 * K * 0.88 * 0.95) < 1, 'stop 5% under the pocket (old high −12%)');
  assert.equal(s.upBroken, true, 'the second minute closed red: not an only-up start');
  // The first candle reached $162.8K from the curve; its low came before that high and is no dip.
  assert.notEqual(s.low, 3.4 * K);
});

test('GOLDEN POCKET only up: two rising green minutes, bought within 12% of candle 2, stop 5% under it — on candles and on live samples alike', () => {
  const t = Date.parse('2026-10-01T12:00:00Z');
  const bars = [[80, 96, 79, 95], [95, 112, 94, 110], [112, 118, 108, 115], [115, 160, 114, 150]].map(([o, h, l, c], i) => ({ t: t + i * MIN, o: o! * K, h: h! * K, l: l! * K, c: c! * K }));
  const { e } = run(GOLDEN_RULES, bars);
  assert.equal(e?.kind, 'ONLY_UP'); assert.equal(e!.at, t + 2 * MIN); assert.equal(e!.price, 112 * K, 'the third minute opens within 12% of candle 2');
  assert.ok(Math.abs(e!.stop - 110 * K * 0.95) < 1e-6); assert.deepEqual(e!.zone.map(Math.round), [110 * K, 123_200]);
  // Live: 4-second samples of the same path give the same entry.
  const samples = bars.flatMap(b => [b.o, b.l, b.h, b.c].map((v, j) => ({ t: b.t + j * 15_000, o: v, h: v, l: v, c: v })));
  const live = run(GOLDEN_RULES, samples, t);
  assert.equal(live.e?.kind, 'ONLY_UP'); assert.equal(live.e!.price, 112 * K);
  // A red second minute, or a third minute already 12% above candle 2 for the whole window, is never bought.
  assert.equal(run(GOLDEN_RULES, [bars[0]!, { ...bars[1]!, c: 90 * K }, bars[2]!]).e, null);
  const away = [bars[0]!, bars[1]!, ...Array.from({ length: 12 }, (_, i) => ({ t: t + (2 + i) * MIN, o: 130 * K, h: 140 * K, l: 125 * K, c: 135 * K }))];
  assert.equal(run(GOLDEN_RULES, away).e, null);
});

test('GOLDEN POCKET trade: the stop is checked inside the fill candle first; a trailing stop rides the move', () => {
  const s = capSeries({ mint: BULLISHCAT, symbol: 'BULLISHCAT', pool: 'p', createdAt: T0, supply: 1, liquidityRefUsd: 60_000, priceRef: 200 * K,
    candles: BULLISHCAT_1M.map(k => ({ ...k, v: 0 })) });
  const costs = { sizeUsd: 2, venueFeePct: 0.3, fixedUsd: 0.02, stopSlipPct: 3 };
  const fill = { at: T0 + 12 * MIN, price: 167.7 * K, stop: 136.1 * K, resistance: 225 * K };
  const ride = pocketTrade(s, fill, { mode: 'TRAIL', trailing: { activationPct: 30, stopPct: 20 }, belowResistancePct: 0, maxHoldMin: 60 }, costs);
  assert.equal(ride.reason, 'END_OF_DATA'); assert.ok(ride.returnPct > 25, `${ride.returnPct}`);
  const tp = pocketTrade(s, fill, { mode: 'RESISTANCE', trailing: null, belowResistancePct: 5, maxHoldMin: 60 }, costs);
  assert.equal(tp.reason, 'TAKE_PROFIT', 'sold at $213.75K, 5% under the $225K breakout high');
  const stopped = pocketTrade(s, { ...fill, stop: 161 * K }, { mode: 'TRAIL', trailing: { activationPct: 30, stopPct: 20 }, belowResistancePct: 0, maxHoldMin: 60 }, costs);
  assert.equal(stopped.reason, 'STOP_LOSS', 'the fill candle traded down to $160.1K, under a $161K stop');
});

test('PumpSwap pools from the chain: the canonical pool address of a graduation (SOL- or PUMP-quoted) and its vaults', () => {
  assert.equal(pumpSwapPool(BULLISHCAT, WSOL_MINT), '827V45MWcBaZaq1Wjfw4N2CDEsWR8sU4jr6Pboxb7bq2');
  assert.equal(pumpSwapPool('6bQ4MCnJ5rab9pDGR43hbTCf1GabYEVmCP2oLyexSmvC', PUMP_QUOTE_MINT), '4qbokk9tDkinqANgHGMw1vHD73MuwCuSLeJfGjjHpLgw', 'FIX6900 graduated into a PUMP pool');
  const b = Buffer.alloc(301);
  const put = (o: number, k: string) => new PublicKey(k).toBuffer().copy(b, o);
  put(43, BULLISHCAT); put(75, WSOL_MINT); put(139, '96yXppN53yoqrqkdEroJG3qH6cEDGRLSdjDQHVy3jmZ5'); put(171, 'B28K8a7sCyjLjN8p8Jbi8825GZAmbMcRwCEL94K9BR5p');
  assert.deepEqual(decodePumpSwapPool(b), { baseMint: BULLISHCAT, quoteMint: WSOL_MINT, baseVault: '96yXppN53yoqrqkdEroJG3qH6cEDGRLSdjDQHVy3jmZ5', quoteVault: 'B28K8a7sCyjLjN8p8Jbi8825GZAmbMcRwCEL94K9BR5p' });
  assert.equal(decodePumpSwapPool(Buffer.alloc(100)), null);
});

test('the tracker watches a graduation from its pool reserves and reports an only-up fill once', async () => {
  const t = Date.parse('2026-10-01T12:00:00Z'), solUsd = 100, pool = pumpSwapPool(BULLISHCAT, WSOL_MINT);
  const baseVault = new PublicKey(new Uint8Array(32).fill(7)).toBase58(), quoteVault = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
  const poolData = Buffer.alloc(301);
  new PublicKey(BULLISHCAT).toBuffer().copy(poolData, 43); new PublicKey(WSOL_MINT).toBuffer().copy(poolData, 75);
  new PublicKey(baseVault).toBuffer().copy(poolData, 139); new PublicKey(quoteVault).toBuffer().copy(poolData, 171);
  // Market cap = quote SOL / base tokens × 1B supply × SOL price: 200M tokens in the pool, quote set for the cap.
  const vault = (raw: bigint) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(raw, 64); return { data: d }; };
  let cap = 80 * K;
  const calls: string[][] = [];
  const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => {
    calls.push(keys.map(k => k.toBase58()));
    return keys.map(k => k.toBase58() === pool ? { owner: new PublicKey(PUMP_AMM_PROGRAM), data: poolData }
      : k.toBase58() === baseVault ? vault(200_000_000n * 1_000_000n) : k.toBase58() === quoteVault ? vault(BigInt(Math.round(cap / solUsd / 1e9 * 200e6 * 1e9))) : null);
  } };
  const tracker = new GoldenTracker({ execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never, GOLDEN_RULES);
  tracker.watchGraduations([{ mint: BULLISHCAT, at: t, symbol: 'BULLISHCAT' }], t + 2_000);
  const quote = (q: string) => q === WSOL_MINT ? solUsd : null;
  const path: Array<[number, number]> = [[4, 80], [30, 88], [56, 95], [64, 97], [90, 104], [116, 110], [124, 112]];
  const fills = [];
  for (const [sec, k] of path) { cap = k * K; fills.push(...await tracker.poll(t + sec * 1000, quote)); }
  assert.equal(fills.length, 1); assert.equal(fills[0]!.entry.kind, 'ONLY_UP'); assert.equal(fills[0]!.pool, pool);
  assert.ok(Math.abs(fills[0]!.entry.price - 112 * K) < 1); assert.ok(Math.abs(tracker.get(BULLISHCAT)!.lastUsd! - 112 * K) < 1);
  assert.equal(calls[0]!.length, 2, 'first read: the SOL- and PUMP-quoted pool addresses'); assert.deepEqual(calls[1], [baseVault, quoteVault]);
  cap = 130 * K; assert.deepEqual(await tracker.poll(t + 130_000, quote), [], 'a fill is reported once');
  assert.equal(tracker.counts().ENTRY, 1); assert.equal(tracker.list()[0]!.mint, BULLISHCAT);
});

test('GOLDEN strategy: only-up fills are bought by default; the pattern stop and the retest target are per position', () => {
  const rs = { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 };
  const p = strategyProfiles({}, deskCapital({}), rs).GOLDEN;
  assert.deepEqual(p.entryKinds, ['ONLY_UP']); assert.deepEqual(p.exits.trailing, { activationPct: 50, stopPct: 25 }); assert.equal(p.exits.maxHoldMin, 60);
  assert.deepEqual(strategyProfiles({ GOLDEN_RETEST_ENTRIES: 'true' }, deskCapital({}), rs).GOLDEN.entryKinds, ['ONLY_UP', 'RETEST']);
  const x = { pnlPct: -8, peakPct: 2, fromPeakPct: -10, heldMs: 60_000, marketCapUsd: 104 * K };
  assert.match(exitReason(p.exits, { ...x, levels: { stopUsd: 104.5 * K } })!, /^POCKET_STOP \$104,000 ≤ \$104,500 \(under the pocket\)/);
  assert.equal(exitReason(p.exits, { ...x, marketCapUsd: 106 * K, levels: { stopUsd: 104.5 * K } }), null);
  assert.match(exitReason(p.exits, { ...x, pnlPct: 20, marketCapUsd: 214 * K, levels: { stopUsd: 136 * K, targetUsd: 213.75 * K } })!, /^RESISTANCE_TARGET/);

  const gate = (key: string) => ({ key, label: key, status: 'PASS', actual: 'ok', required: 'PASS', blocking: true });
  const c = { metrics: { marketCapUsd: 113 * K, largestWalletPct: 4 }, gates: ['mintAuthority', 'freezeAuthority', 'contract'].map(gate) } as never;
  const now = Date.parse('2026-10-01T12:02:30Z');
  const fill = { kind: 'ONLY_UP' as const, fillUsd: 112 * K, stopUsd: 104.5 * K, resistanceUsd: 112 * K, zone: [110 * K, 123.2 * K] as [number, number], signalAt: now - 20_000, detail: 'first 2 candles only up' };
  const live = { lastUsd: 113 * K, lastSampleAt: now - 2_000 };
  const ok = goldenEntryCheck(c, fill, ['ONLY_UP'], null, live, now);
  assert.equal(ok.signal, true, ok.summary); assert.match(ok.summary, /now \$113\.0K$/);
  assert.match(goldenEntryCheck(c, { ...fill, kind: 'RETEST' }, ['ONLY_UP'], null, live, now).summary, /^Pattern bought: break and retest \(only up\)/);
  assert.match(goldenEntryCheck(c, fill, ['ONLY_UP'], null, { ...live, lastUsd: 140 * K }, now).summary, /^Still at the pocket: \$140\.0K/);
  assert.match(goldenEntryCheck(c, fill, ['ONLY_UP'], null, { ...live, lastUsd: 104 * K }, now).summary, /^Above the pattern stop/);
  assert.match(goldenEntryCheck(c, fill, ['ONLY_UP'], null, live, now + 4 * MIN).summary, /^Minutes since the fill/);
  assert.match(goldenEntryCheck(c, fill, ['ONLY_UP'], { rug: 'RUG insiders dumped' }, live, now).summary, /^Rug checks/);
});

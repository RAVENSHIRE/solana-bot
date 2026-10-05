import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { botList, creatorHistory, gradFeatures, pastThresholds, rugLabel, scanLedger } from '../src/research/rug-entry';

const T0 = Date.parse('2026-10-05T12:00:00Z'), FROZEN = Date.parse('2026-10-05T17:00:00Z');

/** Two launches by one creator (the first never graduated) and a third coin; curve states chain from 30 SOL. */
function ledger(dir: string): string[] {
  const lines: unknown[][] = [['M', 0, 'MINT_A'], ['M', 1, 'MINT_B'], ['M', 2, 'MINT_OLD'],
    ['W', 0, 'CREATOR'], ['W', 1, 'SNIPER'], ['W', 2, 'BOT'], ['W', 3, 'BUYER'], ['W', 4, 'OTHER']];
  let vSol = 30e9;
  const trade = (obs: number, slot: number, m: number, w: number, buy: boolean, lamports: number, tok: number) => {
    vSol += buy ? lamports : -lamports;
    lines.push(['T', obs, Math.floor(obs / 1000), slot, m, w, buy ? 1 : 0, lamports, tok, vSol, 1e15, 7e14, 'sig']);
  };
  lines.push(['C', T0 - 3_600_000, 0, 50, 2, 0, null, 'sig', 'Old', 'OLD', 'uri']);
  lines.push(['C', T0, 0, 100, 0, 0, null, 'sig', 'Coin A', 'A', 'uri']);
  trade(T0 + 1_000, 100, 0, 0, true, 1e9, 50e12);      // creator, creation slot: 5 %
  trade(T0 + 1_500, 101, 0, 1, true, 2e9, 100e12);     // sniper, next slot: an insider and a sniper, 10 %
  trade(T0 + 2_000, 102, 0, 2, true, 3e9, 120e12);     // bot, third slot: a sniper, 12 %, the top buyer of the first 120 s
  const grad = T0 + 20 * 60_000;
  trade(grad - 90_000, 400, 0, 3, true, 1e9, 30e12);   // buyer, 90 s before the graduation
  trade(grad - 60_000, 410, 0, 1, false, 1.5e9, 40e12); // the sniper sells 4 % into the graduation
  lines.push(['X', grad, Math.floor(grad / 1000), 0]);
  // Coin B: the same bot is its top buyer too.
  vSol = 30e9;
  lines.push(['C', T0 + 60_000, 0, 500, 1, 4, null, 'sig', 'Coin B', 'B', 'uri']);
  trade(T0 + 61_000, 500, 1, 2, true, 5e9, 200e12);
  trade(T0 + 62_000, 501, 1, 4, true, 1e9, 30e12);
  const half = lines.length >> 1;
  fs.writeFileSync(path.join(dir, 'ev-20261005-12.jsonl.gz'), gzipSync(lines.slice(0, half).map(l => JSON.stringify(l)).join('\n') + '\n'));
  // The open hour repeats the dictionary lines, as a new file does.
  fs.writeFileSync(path.join(dir, 'ev-20261005-13.jsonl'), [...lines.slice(0, 8), ...lines.slice(half)].map(l => JSON.stringify(l)).join('\n') + '\n');
  return [path.join(dir, 'ev-20261005-12.jsonl.gz'), path.join(dir, 'ev-20261005-13.jsonl')];
}

test('rug features at graduation: insiders, snipers, the top 10, bots, sells into the graduation, holders, the creator history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rug-entry-'));
  try {
    const scan = scanLedger(ledger(dir), new Set(['MINT_A']), { frozenAt: FROZEN });
    const a = scan.launches.get('MINT_A')!;
    assert.equal(a.createdSlot, 100); assert.equal(a.complete, T0 + 20 * 60_000); assert.equal(a.creator, 'CREATOR');
    assert.equal(scan.trades.get('MINT_A')!.length, 5); assert.equal(scan.trades.has('MINT_B'), false, 'only the requested coins keep their trades');
    const history = creatorHistory(scan.launches, a, a.complete!);
    assert.deepEqual(history, { launches: 1, graduations: 0 });
    const f = gradFeatures(a, scan.trades.get('MINT_A')!, new Set(['BOT']), history);
    assert.equal(f.chainBreaks, 0); assert.equal(f.trades, 5);
    const near = (x: number | null, y: number) => assert.ok(x !== null && Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
    near(f.insiderAtGrad, 0.11);   // creator 5 % + sniper 10 % − 4 % sold
    near(f.sniperAtGrad, 0.18);    // sniper 6 % + bot 12 %, creator excluded
    near(f.botAtGrad, 0.12); near(f.top10AtGrad, 0.26); near(f.preGradSellShare, 0.6);
    assert.equal(f.holdersAtGrad, 4); assert.equal(f.serialCreator, false, 'one earlier launch is not serial');
    assert.deepEqual(pastThresholds(f), { insiderAtGrad: true, top10AtGrad: false, sniperAtGrad: true, botAtGrad: true, preGradSellShare: true, serialCreator: false, holdersAtGrad: true });
    // Before the freeze, BOT was the top buyer of both coins; the old coin had no trades.
    assert.equal(scan.topBuyerLaunches, 2);
    assert.deepEqual(botList(scan, 2), [{ wallet: 'BOT', launches: 2 }]);
    assert.deepEqual(scanLedger(ledger(dir), new Set(), { frozenAt: T0 + 30_000 }).topBuyer.get('BOT'), 1, 'coin B was created after that freeze');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a coin without a graduation has no features; a serial creator is one with ≥ 2 launches and none graduated', () => {
  const l = { mint: 'M', created: T0, createdSlot: 1, creator: 'C', complete: null };
  assert.equal(gradFeatures(l, [], new Set(), { launches: 3, graduations: 0 }).insiderAtGrad, null);
  const g = gradFeatures({ ...l, complete: T0 + 60_000 }, [], new Set(), { launches: 3, graduations: 0 });
  assert.equal(g.serialCreator, true); assert.equal(g.holdersAtGrad, 0); assert.equal(g.preGradSellShare, null);
});

test('the 10-minute rug label from pool minute candles', () => {
  const at = T0 + 30_000, k = (min: number, l: number, h = 1.2) => ({ t: T0 + min * 60_000, h, l, c: l });
  const rug = rugLabel(1, at, [k(0, 0.95), k(3, 0.25)], T0 + 3_600_000);
  assert.equal(rug.label, 'RUG'); assert.equal(rug.minPct, -75); assert.ok(Math.abs(rug.maxPct! - 20) < 1e-9);
  assert.equal(rugLabel(1, at, [k(0, 0.9), k(5, 0.8)], T0 + 3_600_000).label, 'NO');
  assert.equal(rugLabel(1, at, [k(0, 0.9)], T0 + 5 * 60_000).label, 'PENDING', 'the window is still open');
  assert.equal(rugLabel(1, at, [k(12, 0.1)], T0 + 3_600_000).label, 'NO_DATA', 'a fall after 10 min is not this label');
});

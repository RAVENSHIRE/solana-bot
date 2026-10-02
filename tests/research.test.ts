import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Keypair } from '@solana/web3.js';
import { pumpEvents, curveMcapSol, curveProgress } from '../src/research/pump-events';
import { ResearchLedger } from '../src/research/ledger';
import { ResearchObserver, OBSERVE } from '../src/research/observer';
import { RecentSet, type SocketLike } from '../src/research/streams';
import { postAddresses, postFacts, snowflakeMs } from '../src/research/xread';

const pk = () => Keypair.generate().publicKey;
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
function tradeLog(o: { mint: Buffer; user: Buffer; buy: boolean; lamports: number; tokens: number; ts: number; vSol: number; vTok: number; realTok: number; creator?: Buffer }): string {
  const b = Buffer.concat([Buffer.from('bddb7fd34ee661ee', 'hex'), o.mint, u64(o.lamports), u64(o.tokens), Buffer.from([o.buy ? 1 : 0]), o.user, i64(o.ts),
    u64(o.vSol), u64(o.vTok), u64(0), u64(o.realTok), Buffer.alloc(32), u64(95), u64(1000), o.creator ?? Buffer.alloc(32)]);
  return `Program data: ${b.toString('base64')}`;
}
const str = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from(Uint32Array.of(b.length).buffer), b]); };
function createLog(o: { mint: Buffer; user: Buffer; name: string; symbol: string; uri: string; ts: number }): string {
  const b = Buffer.concat([Buffer.from('1b72a94ddeeb6376', 'hex'), str(o.name), str(o.symbol), str(o.uri), o.mint, Buffer.alloc(32), o.user, o.user, i64(o.ts)]);
  return `Program data: ${b.toString('base64')}`;
}

test('pump.fun events: trades, creations and completions decode from transaction logs', () => {
  const mint = pk(), user = pk(), creator = pk();
  const ev = pumpEvents(['Program log: Instruction: Buy', tradeLog({ mint: mint.toBuffer(), user: user.toBuffer(), buy: true, lamports: 244_400_000, tokens: 5_096_846_000_000,
    ts: 1_790_000_000, vSol: 48_300_000_000, vTok: 1_000_000_000_000_000, realTok: 700_000_000_000_000, creator: creator.toBuffer() }),
    createLog({ mint: mint.toBuffer(), user: user.toBuffer(), name: 'Agency ', symbol: 'AGENCY', uri: 'https://ipfs.io/x', ts: 1_790_000_001 }),
    `Program data: ${Buffer.concat([Buffer.from('5f72619cd42e9808', 'hex'), user.toBuffer(), mint.toBuffer(), Buffer.alloc(32), i64(1_790_000_100)]).toString('base64')}`,
    'Program data: AAAA', 'Program data: !!not base64!!']);
  assert.deepEqual(ev.map(e => e.kind), ['trade', 'create', 'complete']);
  const t = ev[0]!.kind === 'trade' ? ev[0]!.e : null;
  assert.equal(t?.mint, mint.toBase58()); assert.equal(t?.user, user.toBase58()); assert.equal(t?.isBuy, true); assert.equal(t?.lamports, 244_400_000);
  assert.equal(t?.creator, creator.toBase58()); assert.equal(t?.ts, 1_790_000_000);
  assert.ok(Math.abs(curveMcapSol(t!.vSol, t!.vTok) - 48.3) < 1e-9);
  assert.ok(Math.abs(curveProgress(t!.realTok) - (1 - 700 / 793.1)) < 1e-9);
  const c = ev[1]!.kind === 'create' ? ev[1]!.e : null;
  assert.equal(c?.name, 'Agency'); assert.equal(c?.mint, mint.toBase58()); assert.equal(c?.ts, 1_790_000_001);
  assert.equal(ev[2]!.kind === 'complete' && ev[2]!.e.mint, mint.toBase58());
});

test('X posts: the post time comes from its id, and contract addresses are found in the text, not the profile', () => {
  assert.equal(new Date(snowflakeMs('2105790296105841114')!).toISOString(), '2026-10-01T22:41:44.940Z');
  const mint = '7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump';
  const p = postFacts({ id: '2105790296105841114', text: `On AGENCY it gets a mind. ${mint}`, author: { screen_name: 'tryagency', followers: 677 } });
  assert.equal(p?.at, snowflakeMs('2105790296105841114'));
  assert.deepEqual(postAddresses(p!.raw, mint), { mint: true, other: null });
  assert.deepEqual(postAddresses(JSON.stringify({ t: 'new one 9tGLRvTTmm4MHCGUaULjpQbHFLg6JPLyqTz4k64Cpump' }), mint), { mint: false, other: '9tGLRvTTmm4MHCGUaULjpQbHFLg6JPLyqTz4k64Cpump' });
});

test('recent set: each key once, bounded', () => {
  const s = new RecentSet(10);
  assert.equal(s.add('a'), true); assert.equal(s.add('a'), false);
  for (let i = 0; i < 50; i++) s.add(`k${i}`);
  assert.equal(s.add('k49'), false); assert.equal(s.add('a'), true);
});

const lines = (text: string) => text.trim().split('\n').map(l => JSON.parse(l) as unknown[]);

test('ledger: dictionaries per hourly file, gzip on rotation, bulk paused on low disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-'));
  let now = Date.parse('2026-10-02T10:59:59Z'), free = 2_000 * 1048576;
  const ledger = new ResearchLedger({ dir, now: () => now, minFreeMb: 700, freeBytes: async () => free });
  await ledger.start();
  ledger.put(['T', now, { $m: 'MINT1' }, { $w: 'W1' }, 1]);
  ledger.put(['T', now, { $m: 'MINT1' }, { $w: 'W2' }, 0]);
  await ledger.flush();
  const first = lines(await fs.readFile(path.join(dir, 'ev-20261002-10.jsonl'), 'utf8'));
  assert.deepEqual(first, [['M', 0, 'MINT1'], ['W', 0, 'W1'], ['T', now, 0, 0, 1], ['W', 1, 'W2'], ['T', now, 0, 1, 0]]);
  now += 2_000;
  ledger.put(['T', now, { $m: 'MINT1' }, { $w: 'W2' }, 1]);
  await ledger.flush();
  await ledger.close();
  const gz = lines(gunzipSync(await fs.readFile(path.join(dir, 'ev-20261002-10.jsonl.gz'))).toString());
  assert.equal(gz.length, 5);
  await assert.rejects(fs.access(path.join(dir, 'ev-20261002-10.jsonl')));
  assert.deepEqual(lines(await fs.readFile(path.join(dir, 'ev-20261002-11.jsonl'), 'utf8')), [['M', 0, 'MINT1'], ['W', 0, 'W2'], ['T', now, 0, 0, 1]]);
  free = 100 * 1048576;
  const low = new ResearchLedger({ dir, now: () => now, minFreeMb: 700, freeBytes: async () => free });
  await low.start();
  assert.equal(low.lowDisk, true);
  await low.close();
});

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.onclose?.({ code: 1000 }); }
}

test('observer: a launch from creation to candles, raw trades only in its first minutes, X posts dated by their id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-'));
  let now = Date.parse('2026-10-02T12:00:00Z');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const mint = pk(), dev = pk(), buyer = pk();
  const fetcher = (async (url: string) => {
    assert.equal(url, 'https://ipfs.io/meta');
    return new Response(JSON.stringify({ twitter: 'https://x.com/tryagency', website: 'https://agencypad.fun', description: 'living tokens' }));
  }) as typeof fetch;
  const xReads: string[] = [];
  FakeSocket.all = [];
  const obs = new ResearchObserver({ ledger, now: () => now, fetcher, factory: url => new FakeSocket(url), tradeSources: ['wss://logs'],
    xRead: async handle => { xReads.push(handle); return { status: 'OK', http: 200, detail: '', profile: { handle, followers: 677, following: 0, statuses: 31, joinedAt: now - 10 * 3600e3, verified: true, website: null, bio: 'living' },
      posts: [{ id: '2105790296105841114', at: snowflakeMs('2105790296105841114')!, author: handle, text: `CA ${mint.toBase58()}`, views: 31563, likes: 157, reposts: 8, replies: 4, quotes: 1, repost: false, replyTo: null, raw: JSON.stringify({ t: `CA ${mint.toBase58()}` }) }] }; },
    site: async url => ({ url, status: 'AVAILABLE', httpStatus: 200, title: 'Agency', description: null, xHandles: ['tryagency'], detail: '', addresses: [mint.toBase58()], claimed: [mint.toBase58()] }) });
  obs.start();
  const [portal, logs] = FakeSocket.all;
  portal!.onopen?.({}); logs!.onopen?.({});
  assert.match(portal!.sent.join(), /subscribeNewToken/); assert.match(logs!.sent[0]!, /logsSubscribe/);
  portal!.onmessage?.({ data: JSON.stringify({ txType: 'create', mint: mint.toBase58(), traderPublicKey: dev.toBase58(), signature: 'sig1', name: 'Agency', symbol: 'AGENCY',
    uri: 'https://ipfs.io/meta', solAmount: 0.5, initialBuy: 17e6, marketCapSol: 28.2 }) });
  const sec = Math.floor(now / 1000);
  const trade = (user: Buffer, buy: boolean, ts: number, vSol: number, sig: string) => logs!.onmessage?.({ data: JSON.stringify({ params: { result: { context: { slot: 5 }, value: { signature: sig, err: null,
    logs: [tradeLog({ mint: mint.toBuffer(), user, buy, lamports: 1e8, tokens: 3e12, ts, vSol, vTok: 1e15, realTok: 7e14 })] } } } }) });
  trade(dev.toBuffer(), true, sec, 30.5e9, 'a1');
  trade(dev.toBuffer(), true, sec, 30.5e9, 'a1');
  trade(buyer.toBuffer(), true, sec + 1, 31e9, 'a2');
  trade(buyer.toBuffer(), false, sec + 2, 30.8e9, 'a3');
  obs.pump();
  await new Promise(r => setTimeout(r, 20));
  now += OBSERVE.rawWindowMs + 60_000;
  trade(buyer.toBuffer(), true, sec + 700, 32e9, 'a4');
  now = Date.parse('2026-10-02T12:00:00Z') + 6 * 60_000 + 1_000;
  obs.pump();
  await new Promise(r => setTimeout(r, 20));
  now = Date.parse('2026-10-02T12:12:00Z');
  obs.tick();
  obs.stop();
  await ledger.close();
  const recs = lines(await fs.readFile(path.join(dir, 'ev-20261002-12.jsonl'), 'utf8'));
  const of = (tag: string) => recs.filter(r => r[0] === tag);
  assert.equal(of('PC').length, 1);
  assert.equal(of('T').length, 3, 'three raw trades in the first 10 minutes; the duplicate delivery and the late trade are not raw');
  assert.equal(obs.totals.trades, 4);
  const k = of('K');
  assert.equal(k.length, 2, 'one candle for the first minute, one for minute 11');
  assert.deepEqual(k[0]!.slice(7, 13), [2e8, 1e8, 2, 1, 2, 2]);
  const meta = of('META')[0]!;
  assert.deepEqual((meta[3] as { tw: string }).tw, 'https://x.com/tryagency');
  assert.deepEqual(xReads, ['tryagency']);
  const xt = of('XT')[0]!;
  assert.equal(xt[4], '2105790296105841114'); assert.equal(xt[5], snowflakeMs('2105790296105841114'));
  assert.equal((xt[6] as { mint: number }).mint, 1);
  assert.equal(of('XP').length, 1);
  assert.equal((of('S')[0]![3] as { v: string }).v, 'CONFIRMED');
});

test('metadata goes through pump.fun\'s gateway, never ipfs.io', async () => {
  const { metadataUrl } = await import('../src/desk/launches');
  const cid = 'bafkreih5thta47hbpo36sc7l5jygoxqz6nnqvzojeriu6gh6fdpejejdfu';
  assert.equal(metadataUrl(`https://ipfs.io/ipfs/${cid}`), `https://pump.mypinata.cloud/ipfs/${cid}`);
  assert.equal(metadataUrl(`https://cf-ipfs.com/ipfs/${cid}/meta.json`), `https://pump.mypinata.cloud/ipfs/${cid}/meta.json`);
  assert.equal(metadataUrl('https://metadata.j7tracker.io/abc.json'), 'https://metadata.j7tracker.io/abc.json');
});

test('dataset: point-in-time features and labels — nothing after the decision time leaks into a feature', async () => {
  const { readDataset, rows, features, blindSpots } = await import('../src/research/dataset');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-ds-'));
  const t0 = Date.parse('2026-10-02T12:00:00Z'), s0 = t0 / 1000;
  // Curve: virtual SOL starts at 30 SOL; each buy adds its lamports, each sell removes them. vTok shrinks so price rises.
  let vSol = 30e9, vTok = 1_073_000_000e6, realTok = 793_100_000e6;
  const T: unknown[][] = [];
  const trade = (sec: number, w: number, buy: boolean, sol: number, mint = 0) => {
    const lam = sol * 1e9, k = vSol * vTok;
    vSol += buy ? lam : -lam; const nt = k / vSol; realTok -= vTok - nt; vTok = nt;
    T.push(['T', t0 + sec * 1000 + 3000, s0 + sec, 100 + sec, mint, w, buy ? 1 : 0, lam, 1, vSol, vTok, realTok, 'sig']);
  };
  trade(5, 1, true, 1); trade(20, 2, true, 1); trade(40, 3, true, 2); trade(50, 4, true, 1); trade(70, 1, false, 0.5); trade(90, 5, true, 3);
  const at90 = vSol / vTok;
  trade(200, 6, true, 20);
  const lines: unknown[][] = [['M', 0, 'MINTA'], ['W', 0, 'DEV'], ['W', 1, 'B1'], ['W', 2, 'B2'], ['W', 3, 'B3'], ['W', 4, 'B4'], ['W', 5, 'B5'], ['W', 6, 'WHALE'],
    ['PC', t0, 0, 0, 'sig', 'Agency', 'AGENCY', 'https://x/meta', 0.5, 1e7, 28, 0],
    ['META', t0 + 9 * 60_000, 0, { tw: 'https://x.com/tryagency', web: 'https://agencypad.fun', tg: null, desc: 'living tokens', img: null, keys: 5 }],
    ['XT', t0 + 6 * 60_000, 0, 'tryagency', '2', t0 + 80_000, { a: 'tryagency', t: 'CA', mint: 1 }],
    ...T,
    ['K', Math.floor(s0 / 60) + 30, 0, 50, 400, 50, 400, 0, 0, 0, 0, 0, 0, 1],
    ['X', t0 + 31 * 60_000, s0 + 1860, 0],
    ['GAP', t0 + 400_000, 'logs0', 'logs0: closed (1006)'],
    ['M', 1, 'MINTB'], ['PC', t0 + 7 * 3600e3, 0, 1, 'sig', 'Later', 'LATER', null, 0.1, 1e6, 28, 0]];
  await fs.writeFile(path.join(dir, 'ev-20261002-12.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const ds = readDataset([path.join(dir, 'ev-20261002-12.jsonl')]);
  const a = ds.launches.get('MINTA')!;
  assert.equal(a.creator, 'DEV'); assert.equal(a.trades.length, 7);
  const f60 = features(a, 60, { creatorLaunches: 0, creatorGraduations: 0 }, blindSpots(ds));
  assert.equal(f60.buyers, 4, 'buyers up to 60 s only'); assert.equal(f60.trades, 4);
  assert.equal(f60.xCaPost, false, 'the CA post at +80 s is not known at 60 s (nor before +110 s: 30 s to see it)');
  assert.equal(f60.hasX, true, 'metadata is an immutable document named at creation: known from the start');
  assert.equal(f60.gapInWindow, false); assert.equal(f60.chainBreaks, 0);
  assert.ok(Math.abs(f60.top1! - 2 / 5) < 1e-9, 'B3 bought 2 of 5 SOL');
  const f120 = features(a, 120, { creatorLaunches: 0, creatorGraduations: 0 }, blindSpots(ds));
  assert.equal(f120.xCaPost, true); assert.equal(f120.xCaPostDelayS, 80);
  assert.equal(features(a, 100, { creatorLaunches: 0, creatorGraduations: 0 }, blindSpots(ds)).xCaPost, false, 'posted at +80 s, seen at +110 s');
  assert.equal(f120.devSold, false); assert.equal(f120.sellSol, 0.5);
  assert.ok(Math.abs(f120.mcapSol! - at90 / 1e9 * 1e6 * 1e9) < 1e-6, 'market cap from the last trade before 120 s');
  const r120 = rows(ds, 120).find(r => r.mint === 'MINTA')!;
  assert.equal(r120.y.graduated, true, 'completed at 31 min: inside the hour'); assert.ok(r120.y.mfe[60]! > 3, 'the minute-30 candle at 400 SOL is in the 1 h window');
  assert.equal(r120.y.graduatedMin, 31);
  assert.equal(r120.y.reached[5], true);
  assert.equal(r120.y.twoBeforeHalf, true);
  const f600 = features(a, 600, { creatorLaunches: 0, creatorGraduations: 0 }, blindSpots(ds));
  assert.equal(f600.gapInWindow, true, 'the logs disconnect at +400 s is inside the 600 s window');
  // A trade lost in a disconnect shows up as a break in the curve-state chain.
  a.trades.splice(2, 1);
  assert.equal(features(a, 60, { creatorLaunches: 0, creatorGraduations: 0 }, blindSpots(ds)).chainBreaks, 1);
  assert.equal(rows(ds, 60).some(r => r.mint === 'MINTB'), false, 'a launch at the very end of the data has no decision time yet');
  assert.equal(a.mayhem, false, 'a standard curve is not mistaken for a mayhem one');
  // Labels wait for their whole window: with the data ending 40 min after the decision, the 1 h outcomes are unknown.
  const short = { ...ds, last: a.createdObs + 120_000 + 40 * 60_000 };
  const early = rows(short, 120).find(r => r.mint === 'MINTA')!;
  assert.equal(early.y.graduated, null); assert.equal(early.y.reached[5], null); assert.equal(early.y.twoBeforeHalf, null);
  assert.ok(early.y.mfe[15]! > 0); assert.equal(early.y.mfe[60], null);
  // One feed down while another is connected is no blind spot; both down at once, or a restart, is.
  assert.deepEqual(blindSpots({ runs: [{ start: 0, sources: 2 }], gaps: [{ obs: 100_000, source: 'logs0', detail: '' }] }), []);
  assert.deepEqual(blindSpots({ runs: [{ start: 0, sources: 2 }, { start: 500_000, sources: 2 }], gaps: [{ obs: 100_000, source: 'logs0', detail: '' }, { obs: 105_000, source: 'logs1', detail: '' }] }),
    [100_000, 105_000, 500_000]);
});

test('direct entry look-back: conservative fill, take profit, a stop jumped over sells at the trade, costs', async () => {
  const { simulate, DIRECT_DEFAULTS } = await import('../src/research/direct');
  const t0 = Date.parse('2026-10-02T12:00:00Z');
  const mc = (sol: number) => ({ vSol: sol * 1e9, vTok: 1e15 });
  const tr = (sec: number, sol: number) => ({ obs: t0 + sec * 1000, ts: 0, slot: sec, w: 1, buy: true, lamports: 1, ...mc(sol), realTok: 7e14 });
  const launch = (trades: ReturnType<typeof tr>[]) => ({ mint: 'M', createdObs: t0, createdTs: null, creator: null, creatorW: null, devBuySol: null, name: null, symbol: 'X', mayhem: false,
    trades, candles: [], completeObs: null, migrateObs: null, meta: null, metaError: false, xReads: [], xPosts: [], sites: [] });
  const o = { ...DIRECT_DEFAULTS, delayS: 5, fixedUsd: 0, feePct: 0 };
  // Decision at 5 s: last price 30; a trade in flight at 6 s (31) sets the fill. +40 % of 31 = 43.4 reached at 20 s.
  const win = simulate(launch([tr(1, 30), tr(6, 31), tr(20, 44), tr(30, 20)]), { tpPct: 40, slPct: 20, maxHoldMin: 15 }, o, t0 + 3_600_000)!;
  assert.equal(win.entryMcap, 31); assert.equal(win.reason, 'TAKE_PROFIT'); assert.ok(Math.abs(win.netPct - 40) < 1e-9);
  // A rug: the next trade after the fill is far below the −20 % stop; it sells at that trade, not at the stop.
  const rug = simulate(launch([tr(1, 30), tr(10, 9)]), { tpPct: 40, slPct: 20, maxHoldMin: 15 }, o, t0 + 3_600_000)!;
  assert.equal(rug.reason, 'STOP'); assert.ok(Math.abs(rug.netPct - (9 / 30 - 1) * 100) < 1e-9);
  // Fees on both sides and the fixed cost.
  const costly = simulate(launch([tr(1, 30), tr(20, 42)]), { tpPct: 40, slPct: 20, maxHoldMin: 15 }, { ...o, feePct: 1.25, fixedUsd: 0.1, sizeUsd: 2 }, t0 + 3_600_000)!;
  assert.ok(Math.abs(costly.netPct - (1.4 * 0.9875 * 0.9875 - 1 - 0.05) * 100) < 1e-9);
  // No trade before the decision and none in flight: not bought. Data ending inside the hold: not judged.
  assert.equal(simulate(launch([tr(30, 30)]), { tpPct: 40, slPct: 20, maxHoldMin: 15 }, o, t0 + 3_600_000), null);
  assert.equal(simulate(launch([tr(1, 30)]), { tpPct: 40, slPct: 20, maxHoldMin: 15 }, o, t0 + 5 * 60_000), null);
});

// ------------------------------------------------------------------ qualified calls

type Facts = import('../src/research/dataset').LaunchFacts;
function syntheticLaunch(i: number, t0: number, wins: boolean): Facts {
  const created = t0 + i * 60_000, mc = (sol: number) => ({ vSol: sol * 1e9, vTok: 1e15 });
  const tr = (sec: number, sol: number, w: number) => ({ obs: created + sec * 1000, ts: 0, slot: i * 1000 + sec, w, buy: true, lamports: 1, ...mc(sol), realTok: 7e14 });
  // Every launch trades at 30 SOL in its first seconds; a winner touches 42 SOL (+40 %) at 2 min and falls back to 31,
  // a loser drifts to 29.
  const trades = [tr(1, 30, 1), tr(3, 30, 2), tr(4, 30, 3), ...(wins ? [tr(120, 42, 4), tr(300, 31, 5)] : [tr(120, 29, 4)])];
  return { mint: `M${i}`, createdObs: created, createdTs: null, creator: `C${i}`, creatorW: null, devBuySol: 0.5, name: null, symbol: `T${i}`, mayhem: false, trades, candles: [],
    completeObs: null, migrateObs: null, meta: { tw: 'https://x.com/proj', web: null, tg: null, desc: null }, metaError: false, xReads: [], xPosts: [], sites: [] };
}
function syntheticDataset(n: number, winEvery: number) {
  const t0 = Date.parse('2026-10-02T00:00:00Z'), launches = new Map<string, Facts>();
  for (let i = 0; i < n; i++) { const l = syntheticLaunch(i, t0, i % winEvery === 0); launches.set(l.mint, l); }
  return { launches, gaps: [], runs: [{ start: t0 - 1, sources: 2 }], results: [], first: t0, last: t0 + (n + 120) * 60_000, files: 1, wallets: 0 };
}
const freeCosts = { latencyMs: 2_000, feePct: 0, fixedUsd: 0, sizeUsd: 2, solUsd: 100 };

test('qualification: a rule reaches the phone only with ≥ 100 profitable later trades whose target hits cover the losers', async () => {
  const { qualify, requiredHitRate } = await import('../src/research/qualify');
  // Every other launch wins +40 % (target), the rest lose ~3 %: profitable, and the gate passes for "every launch at 5 s".
  const good = qualify(syntheticDataset(400, 2), freeCosts);
  const all5 = good.rules.find(r => r.group === 'all' && r.delayS === 5)!;
  assert.equal(all5.exit.tpPct, 40, 'the +40 % target was the best exit on the tuning period');
  assert.ok(all5.validation.n >= 100); assert.ok(all5.validation.meanPct > 0);
  assert.equal(all5.qualified, true, all5.reasons.join('; '));
  // One winner in ten: the target hit rate is far below what covers the losers.
  const bad = qualify(syntheticDataset(400, 10), { ...freeCosts, fixedUsd: 0.2 });
  const b = bad.rules.find(r => r.group === 'all' && r.delayS === 5)!;
  assert.equal(b.qualified, false); assert.ok(b.reasons.some(x => /cover the losers/.test(x)), b.reasons.join('; '));
  // Too few later trades: never qualified, however good.
  assert.equal(qualify(syntheticDataset(150, 2), freeCosts).rules.find(r => r.group === 'all' && r.delayS === 5)!.qualified, false);
  // Live results can revoke it: 30 losing live calls.
  const ds = syntheticDataset(400, 2);
  const id = all5.id;
  ds.results = Array.from({ length: 30 }, (_, i) => ({ obs: i, mint: `M${i}`, ruleId: id, qualified: true, netPct: -10, reason: 'STOP' })) as never;
  const revoked = qualify(ds, freeCosts).rules.find(r => r.id === id)!;
  assert.equal(revoked.qualified, false); assert.ok(revoked.reasons.some(x => /live calls lost/.test(x)));
  assert.equal(requiredHitRate([{ reason: 'TAKE_PROFIT', netPct: 40 }, { reason: 'STOP', netPct: -20 }] as never), 20 / 60 * 100);
});

test('call engine: a qualified rule calls the phone at its decision time, other candidates are shadow calls, results are judged after the hold', async () => {
  const { qualify } = await import('../src/research/qualify');
  const { CallEngine } = await import('../src/research/calls');
  const q = qualify(syntheticDataset(400, 2), freeCosts);
  // The own-X rule is held back (as if it had failed its later period): its matches are shadow calls.
  const held = q.rules.find(r => r.group === 'ownX' && r.delayS === 5)!;
  held.qualified = false; held.reasons = ['held back for the test'];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-calls-'));
  const t0 = Date.parse('2026-10-03T00:00:00Z');
  let now = t0;
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const sent: Array<[string, string]> = [];
  const engine = new CallEngine({ ledger, now: () => now, notify: async (t, b) => { sent.push([t, b]); }, solUsd: () => 150, costs: freeCosts, link: m => `https://fomo.family/tokens/solana/${m}` });
  engine.setQualification(q);
  const l = syntheticLaunch(0, t0, true);
  now = t0 + 5_000; engine.tick([l]);
  const live = q.rules.filter(r => r.qualified && r.delayS === 5);
  assert.ok(live.length >= 1);
  assert.equal(sent.length, live.length, 'one phone call per qualified rule that matched');
  assert.match(sent[0]![0], /^CALL T0: \+40% target$/);
  assert.match(sent[0]![1], /Buy now at \$4\.5K \(30 SOL\) market cap, 5 s after launch\./);
  assert.match(sent[0]![1], /Sell at \$6\.3K \(42 SOL\) \(\+40%\)/);
  assert.match(sent[0]![1], /https:\/\/fomo\.family\/tokens\/solana\/M0$/);
  now = t0 + 5_000; engine.tick([l]);
  assert.equal(sent.length, live.length, 'a decision is evaluated once');
  // A launch first seen too late for its decision time is not called (its price is stale).
  const late = syntheticLaunch(1, t0, true);
  now = late.createdObs + 27_000; engine.tick([late]);
  assert.equal(sent.length, live.length); assert.ok(engine.stats.late > 0);
  // After the hold and the judging delay, every signal gets its result.
  now = t0 + 62 * 60_000 + 95_000; engine.tick([]);
  await ledger.close();
  const read = async (f: string) => f.endsWith('.gz') ? gunzipSync(await fs.readFile(path.join(dir, f))).toString() : await fs.readFile(path.join(dir, f), 'utf8');
  const recs = lines((await Promise.all((await fs.readdir(dir)).filter(f => f.startsWith('ev-')).sort().map(read))).join(''));
  const sig = recs.filter(r => r[0] === 'SIG'), res = recs.filter(r => r[0] === 'RES');
  assert.equal(sig.filter(r => r[4] === 1).length, live.length);
  assert.ok(sig.some(r => r[4] === 0 && r[3] === held.id), 'a matching rule that is not qualified is recorded as a shadow call, never sent');
  assert.equal(res.length, sig.length, 'each signal judged once');
  assert.ok(res.filter(r => r[4] === 1).every(r => r[6] === 'TAKE_PROFIT'), 'the winner hit its target');
  assert.equal(recs.filter(r => r[0] === 'QUAL').length, 1);
});

test('live and look-back features are the same code over the same facts', async () => {
  const { readDataset, features } = await import('../src/research/dataset');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-parity-'));
  let now = Date.parse('2026-10-02T14:00:00Z');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  FakeSocket.all = [];
  const obs = new ResearchObserver({ ledger, now: () => now, factory: url => new FakeSocket(url), tradeSources: ['wss://logs'],
    fetcher: (async () => new Response(JSON.stringify({ twitter: 'https://x.com/proj', website: 'https://proj.example' }))) as typeof fetch });
  obs.start();
  const [portal, logs] = FakeSocket.all;
  portal!.onopen?.({}); logs!.onopen?.({});
  const mint = pk(), dev = pk(), sec0 = Math.floor(now / 1000);
  portal!.onmessage?.({ data: JSON.stringify({ txType: 'create', mint: mint.toBase58(), traderPublicKey: dev.toBase58(), signature: 's', name: 'P', symbol: 'P', uri: 'https://x/meta', solAmount: 1.5, initialBuy: 1, marketCapSol: 30 }) });
  obs.pump(); await new Promise(r => setTimeout(r, 10));
  let vSol = 31e9;
  for (let i = 0; i < 25; i++) {
    now += 4_000; vSol += 3e8 * (i % 4 === 3 ? -1 : 1);
    const user = i % 6 === 0 ? dev : pk();
    logs!.onmessage?.({ data: JSON.stringify({ params: { result: { context: { slot: 10 + i }, value: { signature: `sg${i}`, err: null,
      logs: [tradeLog({ mint: mint.toBuffer(), user: user.toBuffer(), buy: i % 4 !== 3, lamports: 3e8, tokens: 1e12, ts: sec0 + i * 4, vSol, vTok: 1e15 - i * 1e12, realTok: 7e14 - i * 1e12 })] } } } }) });
  }
  const liveFacts = obs.facts.get(mint.toBase58())!;
  obs.stop(); await ledger.close();
  const ds = readDataset((await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)));
  const backFacts = ds.launches.get(mint.toBase58())!;
  for (const t of [30, 60, 90]) {
    const a = features(liveFacts, t, { creatorLaunches: 0, creatorGraduations: 0 }, []), b = features(backFacts, t, { creatorLaunches: 0, creatorGraduations: 0 }, []);
    for (const k of ['buyers', 'top1', 'effectiveBuyers', 'mcapSol', 'progress', 'velocity60', 'devBuySol', 'devSold', 'hasX', 'hasSite', 'netSol'] as const)
      assert.deepEqual(a[k], b[k], `${k} at ${t} s: live ${a[k]} vs look-back ${b[k]}`);
  }
});

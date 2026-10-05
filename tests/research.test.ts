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
  // The CA on its own line (CRWLR, 5 Oct: "ca:" + line break + address): in the JSON the break is \n, whose "n" made one
  // base58 run too long to match. Also after a tab or a unicode escape.
  for (const sep of ['\n', '\n\n', '\r\n', '\t', '\u2026 ']) assert.deepEqual(postAddresses(JSON.stringify({ text: `ca:${sep}${mint}` }), mint), { mint: true, other: null }, JSON.stringify(sep));
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
  // A sprint (GOOP HEAD, 3 Oct): fill 30, spike to 100, then the rug. The trailing exit keeps most of the spike: it sells
  // at the first trade 20 % under the peak (75), not at the stop and not after the crash; the target alone never hits.
  const spike = launch([tr(1, 30), tr(10, 60), tr(20, 100), tr(30, 75), tr(40, 4)]);
  const trailed = simulate(spike, { tpPct: 400, slPct: 25, maxHoldMin: 3, trailPct: 20 }, o, t0 + 3_600_000)!;
  assert.equal(trailed.reason, 'TRAIL'); assert.equal(trailed.exitMcap, 75); assert.ok(Math.abs(trailed.netPct - 150) < 1e-9);
  assert.ok(Math.abs(trailed.peakPct - (100 / 30 - 1) * 100) < 1e-9);
  const held = simulate(spike, { tpPct: 400, slPct: 25, maxHoldMin: 3 }, o, t0 + 3_600_000)!;
  assert.equal(held.reason, 'STOP', 'without the trailing exit the same trade rides the spike back down');
  // The sprint group and its fast exits are part of the pre-registered catalog.
  const { GROUPS, FAST_EXITS, exitsFor, ruleId, describeExit } = await import('../src/research/rules');
  const f = { velocity30: 0.7, velocity60: null, mayhem: false, buyers: 12, top1: 0.2, devSold: false } as never;
  assert.ok(GROUPS.sprint.test(f) && GROUPS.sprintBroad.test(f));
  assert.ok(!GROUPS.sprint.test({ velocity30: 0.1, velocity60: 0.2, mayhem: false } as never));
  assert.equal(exitsFor('sprint'), FAST_EXITS, 'sprints are judged on the fast exits'); assert.notEqual(exitsFor('all'), FAST_EXITS);
  const fast = FAST_EXITS.find(x => x.maxHoldMin === 1)!;
  assert.equal(ruleId('sprint', 30, fast), 'sprint@30s/tp40/sl25/tr20/1m');
  assert.match(describeExit(fast), /trailing −20% from the peak · 1 min max/);
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

test('luck: bootstrap p-values, Holm\'s correction over every rule tested, and no rule carried by one spike', async () => {
  const { bootstrapP, holm, trimmedMean, qualify, CRITERIA } = await import('../src/research/qualify');
  // A steady edge: 200 trades alternating +40 % and −10 %. No edge: the same spread around 0.
  const steady = Array.from({ length: 200 }, (_, i) => i % 2 ? 40 : -10), none = Array.from({ length: 200 }, (_, i) => i % 2 ? 25 : -25);
  assert.ok(bootstrapP(steady, 2_000, 'a')! < 0.001);
  assert.ok(bootstrapP(none, 2_000, 'b')! > 0.3);
  assert.equal(bootstrapP(steady, 2_000, 'a'), bootstrapP(steady, 2_000, 'a'), 'seeded: the same data gives the same p');
  assert.equal(bootstrapP([5], 100, 'c'), null);
  // Holm with 4 tests at 0.05: thresholds 0.0125, 0.0167, 0.025, 0.05 in p order; everything after the first miss fails.
  assert.deepEqual(holm([0.001, 0.04, 0.012, 0.3], 0.05).map(x => x.pass), [true, false, true, false]);
  assert.deepEqual(holm([0.001, 0.04, 0.012, 0.3], 0.05).map(x => x.threshold), [0.0125, 0.025, 0.05 / 3, 0.05]);
  // One spike: 199 trades at −2 %, one at +600 %: a positive average (+1 %), negative without the best trade.
  const spike = [...Array.from({ length: 199 }, () => -2), 600];
  assert.ok(spike.reduce((a, x) => a + x, 0) / 200 > 0);
  assert.equal(trimmedMean(spike, 1), -2);
  // In the gate: every rule now carries its p-value and Holm threshold; the good synthetic rule clears both.
  const q = qualify(syntheticDataset(400, 2), freeCosts);
  const all5 = q.rules.find(r => r.group === 'all' && r.delayS === 5)!;
  assert.ok(all5.pValue !== null && all5.pThreshold !== null && all5.pValue <= all5.pThreshold, `${all5.pValue} vs ${all5.pThreshold}`);
  assert.equal(all5.qualified, true, all5.reasons.join('; '));
  assert.ok(q.rules.every(r => r.pThreshold !== null && r.pThreshold <= CRITERIA.alpha));
  // The same launches with costs that leave a thin positive average (≈ +0.7 % on a ±22 % spread): not clear of luck.
  const thin = qualify(syntheticDataset(400, 2), { ...freeCosts, fixedUsd: 0.35 }).rules.find(r => r.group === 'all' && r.delayS === 5)!;
  assert.ok(thin.validation.meanPct > 0 && thin.validation.meanPct < 2, `${thin.validation.meanPct}`);
  assert.equal(thin.qualified, false);
  assert.ok(thin.reasons.some(x => /^could be luck: p = /.test(x)), thin.reasons.join('; '));
});

test('phone fill: the owner buys about 45 s after the call, at that moment\'s price; the gate shows the bot\'s price beside it', async () => {
  const { simulate, GATE_COSTS, PHONE_FILL_MS } = await import('../src/research/direct');
  const { qualify } = await import('../src/research/qualify');
  const t0 = Date.parse('2026-10-02T00:00:00Z'), l = syntheticLaunch(0, t0, true);
  // The winner trades at 30 SOL, touches 42 at 120 s. Add a run-up to 36 SOL at 40 s, inside the owner's 45 s.
  l.trades.splice(3, 0, { ...l.trades[2]!, obs: l.createdObs + 40_000, vSol: 36e9, slot: 40 });
  const x = { tpPct: 40, slPct: 20, maxHoldMin: 15 };
  const bot = simulate(l, x, { ...freeCosts, delayS: 5 }, t0 + 3_600_000)!;
  const phone = simulate(l, x, { ...freeCosts, latencyMs: PHONE_FILL_MS, fill: 'phone', delayS: 5 }, t0 + 3_600_000)!;
  assert.equal(bot.entryAt, l.createdObs + 7_000); assert.equal(phone.entryAt, l.createdObs + 50_000);
  assert.ok(phone.entryMcap > bot.entryMcap * 1.15, 'the owner pays the run-up');
  assert.equal(bot.reason, 'TAKE_PROFIT'); assert.notEqual(phone.reason, 'TAKE_PROFIT', '42 SOL is only +17 % from 36');
  assert.equal(GATE_COSTS.fill, 'phone'); assert.equal(GATE_COSTS.latencyMs, PHONE_FILL_MS);
  const q = qualify(syntheticDataset(400, 2), { ...freeCosts, latencyMs: PHONE_FILL_MS, fill: 'phone' });
  const all5 = q.rules.find(r => r.group === 'all' && r.delayS === 5)!;
  assert.ok(all5.botFill && all5.botFill.n === all5.validation.n, 'the bot\'s result on the same later launches');
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
  // Rules that start calling are announced once; the phone hears it before any call.
  assert.equal(sent.length, 1);
  assert.match(sent[0]![0], /^Research: \d+ rule\(s\) now calling$/);
  sent.length = 0;
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

test('call engine: without explicit costs, live calls are judged at the gate\'s costs ($0.10 a round trip), not the cheaper simulation default', async () => {
  const { qualify } = await import('../src/research/qualify');
  const { CallEngine } = await import('../src/research/calls');
  const { simulate, GATE_COSTS } = await import('../src/research/direct');
  const q = qualify(syntheticDataset(400, 2), freeCosts);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-calls-costs-'));
  const t0 = Date.parse('2026-10-03T00:00:00Z');
  let now = t0;
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const engine = new CallEngine({ ledger, now: () => now, notify: null, solUsd: () => 150 });
  engine.setQualification(q);
  const l = syntheticLaunch(0, t0, true);
  now = t0 + 5_000; engine.tick([l]);
  now = t0 + 62 * 60_000 + 95_000; engine.tick([]);
  await ledger.close();
  const read = async (f: string) => f.endsWith('.gz') ? gunzipSync(await fs.readFile(path.join(dir, f))).toString() : await fs.readFile(path.join(dir, f), 'utf8');
  const recs = lines((await Promise.all((await fs.readdir(dir)).filter(f => f.startsWith('ev-')).sort().map(read))).join(''));
  const res = recs.filter(r => r[0] === 'RES');
  assert.ok(res.length > 0);
  for (const r of res) {
    const rule = q.rules.find(x => x.id === r[3])!;
    const expected = simulate(l, rule.exit, { ...GATE_COSTS, delayS: rule.delayS }, now)!.netPct;
    assert.ok(Math.abs((r[5] as number) - expected) < 0.01, `${rule.id} judged with the gate's costs (${r[5]} vs ${expected})`);
  }
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

test('local feed: the observer shares new launches, migrations and curve market caps with the desk, which then leaves the RPC alone', async () => {
  const { LocalFeed } = await import('../src/research/local-feed');
  const { LocalPumpStream } = await import('../src/desk/pump-stream');
  const { LaunchFeed } = await import('../src/desk/launches');
  const { GraduationFeed } = await import('../src/desk/migrations');
  let upstream = true;
  const feed = new LocalFeed(() => upstream), port = 39_000 + Math.floor(Math.random() * 1_000);
  await feed.listen(port);
  try {
    const mint = pk().toBase58(), grad = pk().toBase58(), now = Date.now();
    feed.addCreate({ mint, name: 'Agency', symbol: 'AGENCY', uri: 'https://meta/a', creator: 'DEV', signature: 'SIGC', at: now });
    feed.addCreate({ mint, name: 'Agency', symbol: 'AGENCY', uri: 'https://meta/a', creator: 'DEV', signature: 'SIGC', at: now });
    feed.addMigration({ mint: grad, signature: 'SIGG', at: now });
    const stream = new LocalPumpStream(`http://127.0.0.1:${port}/pump/events`);
    await stream.poll();
    assert.equal(stream.healthy(Date.now()), true);
    let rpcCalls = 0;
    const rpc = { execute: async () => { rpcCalls++; throw new Error('the RPC must not be used while the stream is healthy'); } };
    const launches = new LaunchFeed(rpc as never, (async () => new Response(JSON.stringify({ twitter: 'https://x.com/tryagency' }))) as typeof fetch,
      async url => ({ url, status: 'NONE', httpStatus: null, title: null, description: null, xHandles: [], detail: '', addresses: [], claimed: [] }),
      async handle => ({ handle, status: 'UNAVAILABLE', detail: 'test', addresses: [], claimed: [] }), { stream, insiders: null });
    const got = await launches.poll(Date.now());
    assert.deepEqual(got.map(l => [l.mint, l.symbol, l.signature, l.creator]), [[mint, 'AGENCY', 'SIGC', 'DEV']], 'one launch, once');
    const grads = await new GraduationFeed(rpc as never, undefined, undefined, stream).poll(Date.now());
    assert.deepEqual(grads.map(g => g.mint), [grad]);
    // TEST and LIVE each keep a graduation feed on the same stream: both see every graduation.
    const other = await new GraduationFeed(rpc as never, undefined, undefined, stream).poll(Date.now());
    assert.deepEqual(other.map(g => g.mint), [grad]);
    // The opening screen reads curve market caps from the stream (the state each trade left), not the curve accounts.
    const { OpeningTracker } = await import('../src/desk/opening');
    const opening = new OpeningTracker(rpc as never, stream);
    const fresh = pk().toBase58(), done = pk().toBase58();
    opening.observe([{ mint: fresh, symbol: 'NEW', name: 'New', at: now }, { mint: done, symbol: 'DONE', name: 'Done', at: now }, { mint: grad, symbol: 'X', name: 'No trade yet', at: now }], now);
    feed.addCurve(fresh, 80, now + 1_000); feed.addCurve(fresh, 120, now + 2_000);
    feed.addCurve(done, 300, now + 1_000); feed.addCurve(done, 0, now + 2_000, true); feed.addCurve(done, 50, now + 3_000);
    await opening.poll(now + 4_000, 150);
    assert.equal(opening.source, 'stream');
    assert.equal(opening.get(fresh)!.lastUsd, 120 * 150, 'the latest trade\'s market cap');
    assert.equal(opening.get(done)!.status, 'GRADUATED', 'a completed curve stays complete');
    assert.equal(opening.get(grad)!.lastUsd, null, 'no trade seen yet: no sample');
    assert.equal(rpcCalls, 0);
    // The observer's upstream is down: the desk falls back to the RPC.
    upstream = false; await stream.poll();
    assert.equal(stream.healthy(Date.now()), false);
    await launches.poll(Date.now());
    assert.ok(rpcCalls > 0, 'fallback to the RPC');
    const before = rpcCalls; await opening.poll(now + 8_000, 150);
    assert.ok(rpcCalls > before); assert.equal(opening.source, null, 'the RPC read failed: no source');
  } finally { feed.close(); }
});

test('reviews: Gemini answers while Claude is out of credits', async () => {
  const { GeminiReviewer, RotatingReviewer, REVIEWER_COOLDOWN_MS } = await import('../src/desk/review');
  const verdict = { verdict: 'OK', idea: 6, professionalism: 12, aiGenerated: 'POSSIBLE', scamSignals: [], summary: 'Plausible.' };
  const urls: string[] = [];
  const gemini = new GeminiReviewer('KEY', 'gemini-old-flash', (async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'KEY', 'the key goes in a header, never the URL');
    if (url.includes('gemini-old-flash:')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models?pageSize=200')) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-pro', supportedGenerationMethods: ['generateContent'] }] }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] }));
  }) as typeof fetch);
  let claudeCalls = 0, claudeDown = 0;
  const claude = { available: () => true, status: () => 'Claude review: 0 done', downUntil: () => claudeDown,
    review: async (_i: unknown, now = Date.now()) => { claudeCalls++; claudeDown = now + REVIEWER_COOLDOWN_MS; return null; } };
  const r = new RotatingReviewer([claude, gemini]);
  const input = { mint: 'M', name: 'A', symbol: 'A', description: null, ageMin: 1, x: null, website: null, ca: 'CA not posted yet', insiders: null };
  const first = await r.review(input, 1_000);
  assert.equal(first?.verdict, 'OK'); assert.equal(first?.professionalism, 10, 'clamped to 0–10'); assert.equal(first?.model, 'gemini-3.5-flash', 'newest flash picked');
  assert.equal(claudeCalls, 1);
  await r.review(input, 2_000);
  assert.equal(claudeCalls, 1, 'Claude is skipped while out of credits');
  await r.review(input, 2_000 + REVIEWER_COOLDOWN_MS);
  assert.equal(claudeCalls, 2, 'and tried again after the cooldown');
  assert.match(r.status(), /Gemini review \(gemini-3\.5-flash\): 3 done/);
});

test('info messages: a checkmarked or established project account that posted its CA; capped, once per launch', async () => {
  const { CallEngine, CALLS } = await import('../src/research/calls');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-info-'));
  const now = Date.parse('2026-10-03T10:00:00Z');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const sent: Array<[string, string]> = [];
  const engine = new CallEngine({ ledger, now: () => now, notify: async (t, b) => { sent.push([t, b]); }, solUsd: () => 150, link: m => `https://fomo.family/tokens/solana/${m}` });
  const profile = (o: Partial<import('../src/research/xread').XProfileFacts>) => ({ handle: 'proj', followers: 50, following: 0, statuses: 3, joinedAt: now - 5 * 86_400_000,
    verified: false, verifiedType: null, website: null, bio: null, ...o });
  const read = (mint: string, p: ReturnType<typeof profile>, posted: boolean) => ({ status: 'OK' as const, http: 200, detail: '', profile: p,
    posts: posted ? [{ id: '1', at: now - 30_000, author: p.handle, text: `CA ${mint}`, views: 100, likes: 1, reposts: 0, replies: 0, quotes: 0, repost: false, replyTo: null, raw: JSON.stringify({ t: `CA ${mint}` }) }] : [] });
  const l = syntheticLaunch(0, now - 60_000, true);
  engine.xRead(l, 'proj', read(l.mint, profile({}), true));
  assert.equal(sent.length, 0, 'an unchecked 50-follower account posting its CA is not enough');
  engine.xRead(l, 'proj', read(l.mint, profile({ verified: true, verifiedType: 'individual' }), true));
  assert.equal(sent.length, 1);
  assert.match(sent[0]![0], /^INFO T0: project posted its CA$/);
  assert.match(sent[0]![1], /Not a qualified call/); assert.match(sent[0]![1], /blue check, 50 followers, account 5 days old/); assert.match(sent[0]![1], /posted this contract address 30 s after launch/);
  engine.xRead(l, 'proj', read(l.mint, profile({ verified: true, verifiedType: 'individual' }), true));
  assert.equal(sent.length, 1, 'once per launch');
  const org = syntheticLaunch(1, now - 60_000, true);
  // A launch that merely links a gold-check company account is often a copycat: nothing without the account's own CA post.
  engine.xRead(org, 'bigco', read(org.mint, profile({ handle: 'bigco', verified: true, verifiedType: 'business', followers: 120_000 }), false));
  assert.equal(sent.length, 1);
  engine.xRead(org, 'bigco', read(org.mint, profile({ handle: 'bigco', verified: true, verifiedType: 'business', followers: 120_000 }), true));
  assert.match(sent[1]![0], /^INFO T1: project posted its CA \(gold check \(organisation\)\)$/);
  assert.match(sent[1]![1], /SOL\) market cap/);
  // A mayhem coin: its curve price does not follow its trades, so no market cap is printed (it read "$0.0K (0 SOL)").
  const mayhem = { ...syntheticLaunch(2, now - 60_000, true), mayhem: true };
  engine.xRead(mayhem, 'bigco', read(mayhem.mint, profile({ handle: 'bigco', verified: true, verifiedType: 'business', followers: 120_000 }), true));
  assert.match(sent[2]![1], /market cap unknown \(mayhem mode/); assert.doesNotMatch(sent[2]![1], /\$0\.0K/);
  for (let i = 3; i < 30; i++) { const x = syntheticLaunch(i, now - 60_000, true); engine.xRead(x, 'bigco', read(x.mint, profile({ handle: 'bigco', verified: true, verifiedType: 'government' }), true)); }
  assert.equal(sent.length, CALLS.infoPerHour, 'capped per hour');
  await ledger.close();
});

test('verified coins: a blue-check memecoin that starts to move is an INFO message; stables, unverified coins and repeats are not', async () => {
  const { VerifiedWatch, VERIFIED } = await import('../src/research/verified');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-verified-'));
  let now = Date.parse('2026-10-03T10:00:00Z');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const mint = (i: number) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey.toBase58();
  const coin = (i: number, o: Record<string, unknown> = {}) => ({ id: mint(i), name: `Coin ${i}`, symbol: `C${i}`, usdPrice: 0.01, mcap: 15e6, liquidity: 9e5, holderCount: 20_000,
    organicScore: 85, organicScoreLabel: 'high', isVerified: true, tags: ['verified'], launchpad: 'pump.fun', firstPool: { createdAt: '2026-09-25T21:14:34Z' },
    stats5m: { priceChange: 2 }, stats1h: { priceChange: 22, buyVolume: 4e5, sellVolume: 3e5, numTraders: 1200, numNetBuyers: 150 }, stats6h: { priceChange: -8 }, stats24h: { priceChange: -12 }, ...o });
  let lists: Array<Record<string, unknown>> = [
    coin(0),                                                         // moving, verified: INFO
    coin(1, { tags: ['verified', 'stable'] }),                       // a stablecoin
    coin(2, { isVerified: undefined, tags: ['unknown'] }),           // not verified, not on the watchlist
    coin(3, { stats1h: { priceChange: 22, buyVolume: 1e5, sellVolume: 3e5, numNetBuyers: -40 } }), // up, but sellers win
    coin(4, { mintAuthority: 'AUTH' }),                              // a wrapped/bridged token
  ];
  const watched = coin(5, { isVerified: undefined, tags: ['unknown'], mcap: 4e5, liquidity: 5e4 });
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.includes('/search?query=')) return new Response(JSON.stringify(url.includes(mint(5)) ? [watched] : []));
    return new Response(JSON.stringify(url.includes('toptrending') ? lists : []));
  }) as typeof fetch;
  const watchFile = path.join(dir, 'watch-tokens.json');
  await fs.writeFile(watchFile, JSON.stringify([{ mint: mint(5), note: 'blue check on FOMO' }, { mint: 'not a mint' }]));
  const sent: Array<[string, string]> = [];
  const w = new VerifiedWatch({ ledger, watchFile, fetcher, now: () => now, notify: async (t, b) => { sent.push([t, b]); }, link: m => `https://fomo.family/tokens/solana/${m}` });
  await w.check();
  assert.deepEqual(sent.map(s => s[0]), ['INFO C0: verified coin up +22% in 1h', 'INFO C5: verified coin up +22% in 1h']);
  assert.match(sent[0]![1], /Not a qualified call/); assert.match(sent[0]![1], /blue check: Jupiter verified\./);
  assert.match(sent[0]![1], /\$15\.0M market cap · \$900K liquidity · 20,000 holders · organic score 85 \(high\)/);
  assert.match(sent[0]![1], /150 more buyers than sellers, bought \$400K vs sold \$300K/);
  assert.match(sent[1]![1], /blue check: blue check on FOMO\./, 'a watchlist coin needs no Jupiter check and no size floor');
  assert.ok(urls.every(u => u.startsWith('https://lite-api.jup.ag/tokens/v2/')));
  // The same coins five minutes later: no repeat; another +25 % on the price: once more (after an hour).
  now += 5 * 60_000; await w.check();
  assert.equal(sent.length, 2, 'no repeat');
  now += 60 * 60_000; lists = [coin(0, { usdPrice: 0.0126 })]; await w.check();
  assert.equal(sent.length, 3, 'again after another +25 %');
  // At most VERIFIED.perHour messages an hour.
  now += 13 * 3_600_000; lists = Array.from({ length: 10 }, (_, i) => coin(10 + i)); await w.check();
  assert.equal(sent.length - 3, VERIFIED.perHour);
  await ledger.close();
  const read = async (f: string) => f.endsWith('.gz') ? gunzipSync(await fs.readFile(path.join(dir, f))).toString() : await fs.readFile(path.join(dir, f), 'utf8');
  const recs = lines((await Promise.all((await fs.readdir(dir)).filter(f => f.startsWith('ev-')).sort().map(read))).join(''));
  const vt = recs.filter(r => r[0] === 'VT');
  assert.ok(vt.length >= 5 && vt.every(r => r[4] === 'J' || r[4] === 'W'), 'every watched coin is recorded at every check');
  assert.equal(recs.filter(r => r[0] === 'VINFO').length, sent.length);
});

test('R1/R2 (pre-registered 5 Oct): steady@300 s and organicXClean@120 s with its exit fixed in advance, nothing else', async () => {
  const { GROUPS, EXITS, exitsFor, groupDelays } = await import('../src/research/rules');
  const at = (g: string) => groupDelays().filter(x => x.group === g).map(x => x.delayS);
  assert.deepEqual(at('steady'), [300]); assert.deepEqual(at('organicXClean'), [120]);
  assert.equal(groupDelays().length, 42, '40 rules before, one more for each');
  const fixed = exitsFor('organicXClean');
  assert.equal(fixed.length, 1); assert.ok(EXITS.includes(fixed[0]!), 'the same object as in the menu: the gate matches exits by reference');
  assert.deepEqual(fixed[0], { tpPct: 100, slPct: 20, maxHoldMin: 60 });
  const base = { t: 300, mcapSol: 60, progress: 0.4, trades: 200, velocity30: 0.05, velocity60: 0.1, acceleration: 0, buyers: 80, newBuyers30: 5, newBuyersPrev30: 5,
    buyerAcceleration: 0, buySol: 40, sellSol: 10, netSol: 30, sellShare: 0.2, hhi: 0.05, top1: 0.1, top5: 0.3, effectiveBuyers: 20, devBuySol: 1, devSold: false,
    hasX: true, hasSite: false, hasTelegram: false, descLen: 10, metadataLinks: 1, xCaPost: null, xCaPostDelayS: null, xFollowers: null, xAccountAgeH: null,
    creatorLaunches: 0, creatorGraduations: 0, gapInWindow: false, chainBreaks: 0, mayhem: false };
  const steady = GROUPS.steady.test, clean = GROUPS.organicXClean.test;
  assert.equal(steady(base), true);
  for (const [k, v] of [['velocity60', 0.2], ['velocity60', 0], ['progress', 0.7], ['progress', 0.1], ['top1', 0.15], ['top5', 0.45], ['effectiveBuyers', 9],
    ['devSold', null], ['devSold', true], ['sellShare', 0.45], ['gapInWindow', true]] as const) assert.equal(steady({ ...base, [k]: v }), false, `${k} = ${v}`);
  assert.equal(clean(base), true);
  assert.equal(clean({ ...base, creatorLaunches: 2, creatorGraduations: 0 }), false, 'a serial creator who never graduated');
  assert.equal(clean({ ...base, creatorLaunches: 2, creatorGraduations: 1 }), true);
  assert.equal(clean({ ...base, top5: 0.6 }), false); assert.equal(clean({ ...base, hasX: false }), false);
});

test('call engine: live calls get the creator\'s history the way the look-back counts it (earlier launches, graduations by the decision time)', async () => {
  const { qualify } = await import('../src/research/qualify');
  const { CallEngine } = await import('../src/research/calls');
  const q = qualify(syntheticDataset(400, 2), freeCosts);
  for (const r of q.rules) r.qualified = false;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-calls-creator-'));
  const t0 = Date.parse('2026-10-03T00:00:00Z');
  let now = t0;
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const engine = new CallEngine({ ledger, now: () => now, notify: null, solUsd: () => 150, costs: freeCosts });
  engine.setQualification(q);
  // Three launches by one wallet, a minute apart; the first graduates 30 s after the third is created.
  const ls = [0, 1, 2].map(i => ({ ...syntheticLaunch(i, t0, false), creator: 'SERIAL' }));
  for (let s = 1; s <= 130; s++) { now = t0 + s * 1_000; engine.tick(ls.filter(l => l.createdObs <= now)); }
  ls[0]!.completeObs = ls[2]!.createdObs + 30_000;
  for (let s = 131; s <= 250; s++) { now = t0 + s * 1_000; engine.tick(ls.filter(l => l.createdObs <= now)); }
  await ledger.close();
  const read = async (f: string) => f.endsWith('.gz') ? gunzipSync(await fs.readFile(path.join(dir, f))).toString() : await fs.readFile(path.join(dir, f), 'utf8');
  const recs = lines((await Promise.all((await fs.readdir(dir)).filter(f => f.startsWith('ev-')).sort().map(read))).join(''));
  const dict = new Map<number, string>();
  for (const r of recs) if (r[0] === 'M') dict.set(r[1] as number, r[2] as string);
  const seen = (mint: string, delayS: number) => recs.find(r => r[0] === 'SIG' && String(r[3]).startsWith('all@') && String(r[3]).includes(`@${delayS}s/`)
    && (typeof r[2] === 'object' && r[2] !== null && '$m' in (r[2] as object) ? (r[2] as { $m: string }).$m : dict.get(r[2] as number)) === mint)?.[7] as { cl: number; cg: number } | undefined;
  assert.deepEqual(seen('M0', 5) && [seen('M0', 5)!.cl, seen('M0', 5)!.cg], [0, 0]);
  assert.deepEqual([seen('M2', 5)!.cl, seen('M2', 5)!.cg], [2, 0], 'two earlier launches, none graduated by 5 s');
  assert.deepEqual([seen('M2', 120)!.cl, seen('M2', 120)!.cg], [2, 1], 'the first one graduated before the 120 s decision');
});

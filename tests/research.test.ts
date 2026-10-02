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

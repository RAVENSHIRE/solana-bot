import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { KNOWN_RUGS, RISK, RugList, decodeCurve, insiderExit, readInsiders, tokenDeltas } from '../src/desk/launch-risk';
import { parseXPage, readXPage } from '../src/desk/social';
import { xReach } from '../src/desk/launches';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const NOW = Date.parse('2026-10-01T19:30:00Z');

// The shape x.com serves logged-out visitors (from the @MemeInds page on 1 Oct, shortened).
const X_PAGE = `<html><script>$R[16]={id:"VXNl",result:$R[17]={__typename:"User",core:$R[22]={created_at_ms:${NOW - 6 * 86_400_000},name:"Meme Industries",screen_name:"MemeInds"},` +
  `profile_bio:$R[30]={description:"Launch anything. Fund Everything.",entities:$R[31]={}},relationship_counts:$R[37]={followers:770,following:0},rest_id:"2103",` +
  `tweet_counts:$R[38]={tweets:16},verification:$R[39]={is_blue_verified:!0,verified:!1}}},` +
  `tweet_results:$R[101]={result:$R[102]={core:$R[104]={user_results:$R[105]={result:$R[106]={core:$R[108]={name:"Meme Industries",screen_name:"MemeInds"}}}},` +
  `counts:$R[115]={bookmark_count:1,favorite_count:41,quote_count:0,reply_count:14,retweet_count:5},details:$R[116]={cashtag_entities:$R[117]=[],created_at_ms:${NOW - 3_600_000},` +
  `display_text_range:$R[118]=[0,177],full_text:"meme industries is live!\\n\\nca: FFrRBPP9yWtSqnKjXXM9C77MBdLztfdgSnRE858zpump",hashtag_entities:$R[119]=[]},` +
  `views:$R[136]={count:"21711"}}}},entry_id:"tweet-2105738378847170635",sort_index:"1"}</script></html>`;

test('x.com profile page without a key: followers, account age, posts with views and likes, and the CA it posted', () => {
  const p = parseXPage('MemeInds', X_PAGE);
  assert.equal(p.found, true);
  assert.deepEqual({ ...p.profile, createdAt: null }, { handle: 'MemeInds', name: 'Meme Industries', createdAt: null, followers: 770, following: 0, tweets: 16, blueVerified: true,
    bio: 'Launch anything. Fund Everything.' });
  assert.equal(p.posts!.length, 1);
  assert.deepEqual({ ...p.posts![0]!, text: p.posts![0]!.text.split('\n')[0] }, { id: '2105738378847170635', author: 'MemeInds', at: NOW - 3_600_000,
    text: 'meme industries is live!', views: 21_711, likes: 41, replies: 14, reposts: 5, quotes: 0 });
  assert.deepEqual(p.claimed, ['FFrRBPP9yWtSqnKjXXM9C77MBdLztfdgSnRE858zpump']);
});

test('a deleted or suspended X account reads as NOT_FOUND, never as an error', async () => {
  const page = (body: string, status: number) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  assert.equal((await readXPage('PotPotato_Sol', page('<meta name="description" content="The user profile you&#x27;re looking for could not be found."/>', 404))).status, 'NOT_FOUND');
  assert.equal((await readXPage('gone', page('<div>Account suspended</div>', 200))).status, 'NOT_FOUND');
  const ok = await readXPage('MemeInds', page(X_PAGE, 200));
  assert.equal(ok.status, 'READ'); assert.equal(ok.profile!.followers, 770); assert.equal(ok.posts![0]!.views, 21_711);
  assert.equal((await readXPage('x', page('', 503))).status, 'UNAVAILABLE');
});

test('X reach: followers count most, then the views a recent post drew; a brand-new account with no audience loses a point', () => {
  const read = (followers: number, createdAt: number, views: number | null) => ({ handle: 'h', status: 'READ' as const, detail: '', addresses: [], claimed: [],
    profile: { handle: 'h', name: null, createdAt, followers, following: 0, tweets: 3, blueVerified: false, bio: null },
    posts: views === null ? [] : [{ id: '1', author: 'h', at: NOW - 600_000, text: 'gm', views, likes: 0, replies: 0, reposts: 0, quotes: 0 }] });
  // Ansemmas on 1 Oct: account 5 days old, 401 followers, a 21.7K-view post — a 20× runner.
  const ansem = xReach(read(401, NOW - 5 * 86_400_000, 21_711), NOW);
  assert.equal(ansem.points, 1 + 2); assert.deepEqual(ansem.reasons, ['401 followers (+1)', 'best post 21,711 views (+2)', 'X account 5 days old']);
  assert.equal(xReach(read(12_000, NOW - 400 * 86_400_000, 60_000), NOW).points, 4 + 3);
  const fresh = xReach(read(9, NOW - 2 * 3_600_000, 40), NOW);
  assert.equal(fresh.points, -2); assert.deepEqual(fresh.reasons, ['9 followers (-1)', 'best post 40 views', 'X account created 2 h ago (−1)']);
  assert.equal(xReach(null, NOW).points, 0);
});

test('insiders: the creator and every wallet that bought in the creation slot (the Potato pattern: dev 5.1% + one-SOL wallets)', async () => {
  const mint = key(51), dev = key(52), b1 = key(53), b2 = key(54), sniper = key(55);
  const bal = (owner: string, amount: bigint) => ({ mint, owner, uiTokenAmount: { amount: String(amount) } });
  const tx = (slot: number, owner: string, amount: bigint) => ({ slot, transaction: { message: { accountKeys: [owner] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [bal(owner, amount)] } });
  const txs: Record<string, ReturnType<typeof tx>> = { CREATE: tx(100, dev, 51_100_000_000_000n), B1: tx(100, b1, 31_400_000_000_000n), B2: tx(101, b2, 27_900_000_000_000n),
    LATE: tx(104, sniper, 24_300_000_000_000n) };
  assert.equal(tokenDeltas(txs.B1 as never, mint).get(b1), 31_400_000_000_000n);
  const conn = { getSignaturesForAddress: async () => [{ signature: 'LATE', slot: 104, err: null }, { signature: 'B2', slot: 101, err: null }, { signature: 'B1', slot: 100, err: null },
      { signature: 'CREATE', slot: 100, err: null }],
    _rpcRequest: async (_m: string, [sig]: [string]) => ({ result: txs[sig] }) };
  const rpc = { execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never;
  const ins = (await readInsiders(rpc, mint, dev, 'CREATE'))!;
  assert.deepEqual(ins.wallets, [dev, b1, b2], 'creator first; the sniper three slots later is not an insider');
  assert.equal(ins.creatorPct, 5.11); assert.equal(ins.insiderPct, 11.04);
  assert.equal(ins.detail, 'insiders hold 11.0%: dev 5.1% + 2 wallets in the creation slot');
  assert.equal(await readInsiders(rpc, mint, dev, 'UNKNOWN_SIG'), null, 'creation not found: unknown, never guessed');
});

test('insider exits: they sell → RUG; the curve is about to graduate while they still hold a bag → sell first (ETF −84%, Potato −90%)', () => {
  assert.match(insiderExit(14.7, 9, null)!, /^RUG insiders sold: they hold 9\.0% \(was 14\.7% at entry\)/);
  assert.equal(insiderExit(14.7, 12, null), null, 'a small trim is not a dump');
  assert.equal(insiderExit(1.2, 0.5, null), null, 'under one point of supply is noise, whatever the share');
  assert.match(insiderExit(4, 2.9, null)!, /^RUG insiders sold/);
  assert.match(insiderExit(14.7, 14.7, { progress: 0.92, complete: false, creator: null })!, /^PRE_GRADUATION curve 92% full while insiders hold 14\.7%/);
  assert.equal(insiderExit(6, 5, { progress: 0.95, complete: false, creator: null }), null, 'insiders with a small bag ride through graduation');
  assert.equal(insiderExit(14.7, 14.7, { progress: 0.6, complete: false, creator: null }), null);
  assert.equal(RISK.preGraduationProgress, 0.9);
});

test('bonding curve account: progress from the real token reserves, complete flag, creator (pump.fun layout)', () => {
  const b = Buffer.alloc(151), creator = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  b.writeBigUInt64LE(79_310_000_000_000n, 24); creator.toBuffer().copy(b, 49);
  assert.deepEqual(decodeCurve(b), { progress: 0.9, complete: false, creator: creator.toBase58() });
  b[48] = 1; assert.equal(decodeCurve(b)!.progress, 1);
  assert.equal(decodeCurve(Buffer.alloc(10)), null);
});

test('rug list: persisted; a launch by the same creator, X account or website is a rug; Potato is on it from the start', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rugs-')), 'rugs.json');
  const list = await RugList.open(file, KNOWN_RUGS);
  assert.match(list.match({ mint: 'GicwGn7XvWRKt1297uUKbZtY4hpma1sAWqjPBmMsEgYE', creator: null, xHandle: null, site: null })!, /^RUG HISTORY: this token rugged Potato on 2026-10-01/);
  assert.match(list.match({ mint: key(60), creator: '4P62ZD4KA4zmLjauG7VFEEiactvAVkbkyXtvuqL6ZJxC', xHandle: null, site: null })!, /its creator 4P62…ZJxC rugged Potato/);
  assert.match(list.match({ mint: key(61), creator: null, xHandle: 'PotPotato_Sol', site: null })!, /X account @potpotato_sol rugged Potato/);
  assert.equal(list.match({ mint: key(62), creator: key(63), xHandle: 'memeinds', site: 'onsolchain.lol' }), null);
  assert.equal(await list.add({ mint: key(64), symbol: 'FAKE', at: NOW, reason: 'RUG insiders sold: x', creator: key(65), xHandle: 'FakeProj', site: 'fake.lol' }), true);
  const again = await RugList.open(file, KNOWN_RUGS);
  assert.equal(again.all().length, 2, 'persisted, seed not duplicated');
  assert.match(again.match({ mint: key(66), creator: null, xHandle: 'fakeproj', site: null })!, /rugged FAKE on 2026-10-01 \(RUG insiders sold\)/);
});

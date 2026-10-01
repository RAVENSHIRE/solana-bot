import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { LaunchFeed, decodeCreate, projectSite, scoreLaunch, LAUNCH } from '../src/desk/launches';
import { parseXLink, type WebsiteCheck } from '../src/desk/social';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const str = (s: string) => { const b = Buffer.from(s, 'utf8'), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
/** pump.fun CreateEvent as it appears in the logs: discriminator, name, symbol, uri, mint, bonding curve, creator. */
const createLog = (name: string, symbol: string, uri: string, mint = key(1), creator = key(3)) =>
  `Program data: ${Buffer.concat([Buffer.alloc(8, 7), str(name), str(symbol), str(uri), mint.toBuffer(), key(2).toBuffer(), creator.toBuffer(), Buffer.alloc(16)]).toString('base64')}`;
const site = (patch: Partial<WebsiteCheck> = {}): WebsiteCheck => ({ url: 'https://onsolchain.lol/', status: 'AVAILABLE', httpStatus: 200, title: 'Meme Industries',
  description: 'We make memes', xHandles: ['memeinds'], detail: 'HTTP 200', ...patch });

test('the pump.fun create event is decoded from the logs; other program data is skipped', () => {
  const e = decodeCreate(['Program log: Instruction: Create', 'Program data: AAAA', createLog('Meme Industries', 'MEME', 'https://ipfs.io/ipfs/Qm1')])!;
  assert.deepEqual(e, { mint: key(1).toBase58(), name: 'Meme Industries', symbol: 'MEME', uri: 'https://ipfs.io/ipfs/Qm1', creator: key(3).toBase58() });
  assert.equal(decodeCreate(['Program log: Instruction: Buy']), null);
  assert.equal(decodeCreate([createLog('x', 'X', 'not-a-url')]), null);
});

test('launch score: own X account and a live project website that links back are what set a launch apart', () => {
  const meta = { description: 'Meme Industries: the factory for internet culture, onchain.', twitter: 'https://x.com/MemeInds', website: 'https://onsolchain.lol', telegram: null };
  const best = scoreLaunch(meta, parseXLink(meta.twitter), site());
  assert.equal(best.score, 9); assert.deepEqual(best.reasons, ['own X account @MemeInds', 'website onsolchain.lol ("Meme Industries")', 'website links the same X account', 'real description']);
  assert.equal(scoreLaunch(meta, parseXLink('https://x.com/someone/status/123'), null).score, 2, 'a post link and no site');
  assert.ok(scoreLaunch(meta, parseXLink(meta.twitter), null).score < LAUNCH.minScore, 'an X account alone is not enough');
  assert.equal(projectSite('https://www.reuters.com/business/x'), null); assert.equal(projectSite('https://x.com/a'), null);
  assert.equal(projectSite('http://onsolchain.lol'), null, 'https only'); assert.equal(projectSite('https://onsolchain.lol'), 'https://onsolchain.lol/');
});

test('the feed reads only new launches each poll, fetches metadata, and checks the website only when an X link exists', async () => {
  const sigs = [{ signature: 'S2', blockTime: 1_790_870_842, err: null }, { signature: 'S1', blockTime: 1_790_870_800, err: null }, { signature: 'S0', blockTime: 1, err: { x: 1 } }];
  const logs: Record<string, string[]> = { S2: [createLog('Meme Industries', 'MEME', 'https://meta/2', key(1))], S1: [createLog('Dont buy', 'TEST', 'https://meta/1', key(4))] };
  const untils: Array<string | undefined> = [], checked: string[] = [];
  const conn = {
    getSignaturesForAddress: async (_a: unknown, o: { until?: string }) => { untils.push(o.until); return o.until ? [] : sigs; },
    _rpcRequest: async (_m: string, [sig]: [string]) => ({ result: { meta: { logMessages: logs[sig] ?? [] } } }),
  };
  const rpc = { execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never;
  const fetcher = (async (url: string) => new Response(JSON.stringify(url.endsWith('/2')
    ? { description: 'Meme Industries: the factory for internet culture, onchain.', twitter: 'https://x.com/MemeInds', website: 'https://onsolchain.lol' }
    : { description: '' }))) as unknown as typeof fetch;
  const feed = new LaunchFeed(rpc, fetcher, async url => { checked.push(url!); return site(); });
  const fresh = await feed.poll(1_790_870_900_000);
  assert.deepEqual(fresh.map(l => [l.symbol, l.score]).sort(), [['MEME', 9], ['TEST', 0]]);
  assert.deepEqual(checked, ['https://onsolchain.lol/'], 'one website fetched: only the launch with an X link');
  assert.equal(fresh.find(l => l.symbol === 'MEME')!.at, 1_790_870_842_000);
  assert.deepEqual(await feed.poll(1_790_870_920_000), []); assert.deepEqual(untils, [undefined, 'S2'], 'the next poll starts after the newest signature');
  assert.equal(feed.recent(1_790_870_920_000).length, 2); assert.equal(feed.recent(1_790_870_900_000 + LAUNCH.keepMs + 60_000).length, 0, 'old launches age out');
});

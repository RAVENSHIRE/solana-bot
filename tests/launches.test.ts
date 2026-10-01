import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { LaunchFeed, decodeCreate, launchCa, projectSite, scoreLaunch, LAUNCH } from '../src/desk/launches';
import { caVerdict, checkWebsite, pageAddresses, parseXLink, readXPage, type WebsiteCheck, type XPageCheck } from '../src/desk/social';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const str = (s: string) => { const b = Buffer.from(s, 'utf8'), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
/** pump.fun CreateEvent as it appears in the logs: discriminator, name, symbol, uri, mint, bonding curve, creator. */
const createLog = (name: string, symbol: string, uri: string, mint = key(1), creator = key(3)) =>
  `Program data: ${Buffer.concat([Buffer.alloc(8, 7), str(name), str(symbol), str(uri), mint.toBuffer(), key(2).toBuffer(), creator.toBuffer(), Buffer.alloc(16)]).toString('base64')}`;
const site = (patch: Partial<WebsiteCheck> = {}): WebsiteCheck => ({ url: 'https://onsolchain.lol/', status: 'AVAILABLE', httpStatus: 200, title: 'Meme Industries',
  description: 'We make memes', xHandles: ['memeinds'], detail: 'HTTP 200', addresses: [], claimed: [], ...patch });
/** The X profile page as read: posts with these addresses, or none yet. */
const xp = (cas: string[] = []): XPageCheck => cas.length ? { handle: 'h', status: 'READ', detail: 'Profile page read', ...pageAddresses(cas.map(a => `full_text:"we are live!\\n\\nca: ${a}"`).join(',')) }
  : { handle: 'h', status: 'NO_POSTS', detail: 'No posts readable on the profile page', addresses: [], claimed: [] };

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
  const feed = new LaunchFeed(rpc, fetcher, async url => { checked.push(url!); return site(); }, async () => xp());
  const fresh = await feed.poll(1_790_870_900_000);
  assert.deepEqual(fresh.map(l => [l.symbol, l.score]).sort(), [['MEME', 9], ['TEST', 0]]);
  assert.equal(fresh.find(l => l.symbol === 'MEME')!.reasons.at(-1), 'CA not posted by @MemeInds yet');
  assert.deepEqual(checked, ['https://onsolchain.lol/'], 'one website fetched: only the launch with an X link');
  assert.equal(fresh.find(l => l.symbol === 'MEME')!.at, 1_790_870_842_000);
  assert.deepEqual(await feed.poll(1_790_870_920_000), []); assert.deepEqual(untils, [undefined, 'S2'], 'the next poll starts after the newest signature');
  assert.equal(feed.recent(1_790_870_920_000).length, 2); assert.equal(feed.recent(1_790_870_900_000 + LAUNCH.keepMs + 60_000).length, 0, 'old launches age out');
});

test('clones (same X account, website or name as an earlier launch) lose their score; only the original can be shortlisted', async () => {
  const sigs = [{ signature: 'C3', blockTime: 300, err: null }, { signature: 'C2', blockTime: 200, err: null }, { signature: 'C1', blockTime: 100, err: null }];
  const logs: Record<string, string[]> = { C1: [createLog('Kencoin', 'KEN', 'https://meta/1', key(11))], C2: [createLog('Kencoin', 'KEN', 'https://meta/2', key(12))],
    C3: [createLog('Other name', 'OTH', 'https://meta/3', key(13))] };
  const conn = { getSignaturesForAddress: async () => sigs, _rpcRequest: async (_m: string, [sig]: [string]) => ({ result: { meta: { logMessages: logs[sig] ?? [] } } }) };
  const rpc = { execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never;
  const meta = { description: 'The dog before doge, chapter zero of the story.', twitter: 'https://x.com/kenonpump', website: 'https://kendoge.lol' };
  const fetcher = (async () => new Response(JSON.stringify(meta))) as unknown as typeof fetch;
  const feed = new LaunchFeed(rpc, fetcher, async () => site({ url: 'https://kendoge.lol/', title: '$KEN', xHandles: ['kenonpump'] }), async () => xp());
  const fresh = await feed.poll(400_000);
  const by = (m: number) => fresh.find(l => l.mint === key(m).toBase58())!;
  assert.equal(by(11).score, 9, 'the first launch keeps its score');
  assert.equal(by(12).score, 0); assert.match(by(12).reasons[0]!, /^CLONE of KEN /);
  assert.equal(by(13).score, 0, 'a different name with the same X account and website is a clone too');
});

// The real cases of 1 Oct: stashd.fun's own token, the STASH impersonator 14 h later, and Potato (CA posted on X).
const STASHD = '3BdwhPScvutpfNF3oVzYtSb8enwtM8tiYjCNKLtMpump', FAKE = 'Fx5E1wKPpnx6PUoWX9yikogj1gYJNCQVaqKFPYA6HQyJ';
const POTATO = 'GicwGn7XvWRKt1297uUKbZtY4hpma1sAWqjPBmMsEgYE', JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

test('contract addresses on a page: the copy button, a CA label, a pump.fun link, a site config and an X post; program ids and SOL are not a CA', () => {
  const html = `<button aria-label="Copy contract address ${STASHD}"><span>STSH</span><span class="label">CA</span><span class="num text-[13px]">${STASHD}</span></button>
    <a href="https://pump.fun/coin/${STASHD}">View on pump.fun</a><script>const routers=["${JUP}","${PUMP_PROGRAM}","So11111111111111111111111111111111111111112"]</script>`;
  const page = pageAddresses(html);
  assert.deepEqual(page.claimed, [STASHD]); assert.ok(page.addresses.includes(JUP) && page.addresses.includes(STASHD));
  assert.deepEqual(pageAddresses(`t.s(["BRAND",0,{name:"Stashd",x:"stashdfun",ticker:"$STSH",ca:"${STASHD}"}])`).claimed, [STASHD], 'a site bundle config');
  assert.deepEqual(pageAddresses(`full_text:"stashd is officially live on @pumpfun!\\n\\nca: ${STASHD} https://t.co/7HP5apPMof"`).claimed, [STASHD], 'an X post as x.com embeds it');
  assert.deepEqual(pageAddresses(`gm, the mint is ${POTATO.slice(0, 20)} and contract address: soon`).claimed, [], 'no full address, no claim');
  assert.deepEqual(caVerdict(FAKE, page), { verdict: 'CONTRADICTED', other: STASHD });
  assert.deepEqual(caVerdict(STASHD, page), { verdict: 'CONFIRMED', other: null });
  assert.deepEqual(caVerdict(FAKE, pageAddresses(`router ${JUP}`)), { verdict: 'NONE', other: null }, 'an unlabelled program id says nothing');
  const basket = `<img src="/api/logo?mint=${JUP}&amp;u=1"/>{"CARDS":{"symbol":"CARDS","mint":"${PUMP_PROGRAM}"}}`;
  assert.deepEqual(pageAddresses(basket).claimed, [], 'a token list or logo URL names other tokens, not the site\'s CA');
});

test('CA verdict: the account posting this CA confirms; another CA on X or the website marks an impersonator (score 0); the post wins over a stale site', () => {
  const meta = { description: 'stop buying coins one at a time. stash the whole narrative in one click.', twitter: 'https://x.com/stashdfun', website: 'https://stashd.fun/', telegram: null };
  const x = parseXLink(meta.twitter), stashSite = site({ url: 'https://stashd.fun/', title: 'Stashd: buy the whole narrative on Solana', xHandles: ['stashdfun'], ...pageAddresses(`ca:"${STASHD}"`) });
  const fake = launchCa(FAKE, x, stashSite, xp([STASHD]));
  assert.deepEqual(fake, { status: 'IMPERSONATOR', detail: 'IMPERSONATOR: @stashdfun shows CA 3Bdw…pump, not this token' });
  const scored = scoreLaunch(meta, x, stashSite, fake);
  assert.equal(scored.score, 0); assert.equal(scored.reasons[0], fake.detail);
  assert.equal(launchCa(FAKE, x, stashSite, xp()).detail, 'IMPERSONATOR: stashd.fun shows CA 3Bdw…pump, not this token', 'the website alone exposes it too');
  const real = launchCa(STASHD, x, stashSite, xp([STASHD]));
  assert.deepEqual(real, { status: 'X', detail: '@stashdfun posted this CA' });
  assert.equal(scoreLaunch(meta, x, stashSite, real).score, 3 + 3 + 2 + 1 + 3);
  assert.equal(launchCa(STASHD, x, site({ ...pageAddresses(`ca:"${FAKE}"`) }), xp([STASHD])).status, 'X', 'the account\'s post wins over a stale site');
  assert.deepEqual(launchCa(STASHD, x, stashSite, xp()), { status: 'WEBSITE', detail: 'stashd.fun shows this CA' });
  assert.equal(launchCa(POTATO, parseXLink('https://x.com/PotPotato_Sol'), site({ url: 'https://potpotato.fun/' }), null).detail, 'CA not checked on X (not read yet)');
});

test('the radar re-reads the X page of unconfirmed launches: Potato is confirmed once its dev posts the CA; a front-run "original" is exposed', async () => {
  let page = xp(), clock = 1_790_880_000_000;
  const reads: string[] = [];
  const sigs = [{ signature: 'P2', blockTime: clock / 1000 - 40, err: null }, { signature: 'P1', blockTime: clock / 1000 - 50, err: null }];
  const logs: Record<string, string[]> = { P1: [createLog('Pot Potato', 'Potato', 'https://meta/1', key(21))], P2: [createLog('Pot Potato', 'Potato', 'https://meta/2', key(22))] };
  const conn = { getSignaturesForAddress: async (_a: unknown, o: { until?: string }) => o.until ? [] : sigs,
    _rpcRequest: async (_m: string, [sig]: [string]) => ({ result: { meta: { logMessages: logs[sig] ?? [] } } }) };
  const rpc = { execute: async (_l: string, fn: (c: never) => unknown) => fn(conn as never) } as never;
  const fetcher = (async () => new Response(JSON.stringify({ description: '', twitter: 'https://x.com/PotPotato_Sol', website: 'https://potpotato.fun/' }))) as unknown as typeof fetch;
  const feed = new LaunchFeed(rpc, fetcher, async () => site({ url: 'https://potpotato.fun/', title: 'Pot Potato', xHandles: [] }), async h => { reads.push(h); return page; });
  await feed.poll(clock);
  const first = feed.recent(clock).find(l => l.mint === key(21).toBase58())!, second = feed.recent(clock).find(l => l.mint === key(22).toBase58())!;
  assert.equal(first.score, 6); assert.equal(first.ca.status, 'UNCONFIRMED'); assert.match(second.reasons[0]!, /^CLONE of Potato/);
  assert.deepEqual(reads, ['PotPotato_Sol'], 'one X read per handle serves the original and its clone');
  // The dev posts the CA of the second launch: that one is the project's token, the first was a front-runner.
  page = xp([key(22).toBase58()]);
  clock += 10_000; await feed.poll(clock);
  assert.equal(reads.length, 1, 'not re-read before 30 s');
  clock += LAUNCH.reverifyMs; await feed.poll(clock);
  assert.equal(second.ca.status, 'X'); assert.equal(second.score, 3 + 3 + 3, 'the clone flag gives way to the account\'s own post');
  assert.equal(first.ca.status, 'IMPERSONATOR'); assert.equal(first.score, 0);
  clock += LAUNCH.reverifyMs; await feed.poll(clock);
  assert.equal(reads.length, 2, 'decided launches are not re-read');
  clock += LAUNCH.verifyForMs; page = xp();
  const late = feed.recent(clock).length; await feed.poll(clock);
  assert.equal(reads.length, 2, 'nothing re-read after the entry window'); assert.equal(late, 2);
});

test('website check: a client-rendered site\'s CA is found in its own scripts, never in another origin\'s; x.com pages are read without a key', async () => {
  const pub = async () => ['93.184.216.34'];
  const res = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
  const urls: string[] = [];
  const fetcher = (async (u: URL | string) => {
    const url = String(u); urls.push(url);
    if (url === 'https://stashd.fun/') return res('<html><title>Stashd</title><script src="/_next/a.js"></script><script src="https://cdn.other.io/b.js"></script><script src="/_next/c.js"></script></html>');
    if (url.endsWith('/_next/a.js')) return res('console.log(1)');
    if (url.endsWith('/_next/c.js')) return res(`t.s(["BRAND",0,{ca:"${STASHD}"}])`);
    return res(`ca:"${FAKE}"`);
  }) as unknown as typeof fetch;
  const plain = await checkWebsite('https://stashd.fun/', fetcher, pub);
  assert.deepEqual(plain.claimed, [], 'scripts are only read when asked');
  const deep = await checkWebsite('https://stashd.fun/', fetcher, pub, { scripts: 6 });
  assert.deepEqual(deep.claimed, [STASHD]); assert.ok(!urls.some(u => u.includes('cdn.other.io')), 'another origin is never fetched');
  const xFetch = (body: string, status = 200) => (async (u: string) => { urls.push(u); return res(body, status); }) as unknown as typeof fetch;
  const read = await readXPage('stashdfun', xFetch(`<div data-testid="tweetText">stashd is live! ca: ${STASHD}</div>`));
  assert.equal(read.status, 'READ'); assert.ok(read.addresses.includes(STASHD)); assert.equal(urls.at(-1), 'https://x.com/stashdfun');
  assert.equal((await readXPage('stashdfun', xFetch('<html>Log in</html>'))).status, 'NO_POSTS');
  assert.equal((await readXPage('stashdfun', xFetch('', 429))).detail, 'HTTP 429');
  assert.equal((await readXPage('bad/handle', xFetch(''))).status, 'UNAVAILABLE');
});

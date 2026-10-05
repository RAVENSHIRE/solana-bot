import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { addToWatchlist, checkCoin, verdict, type CoinCheck } from '../src/research/coin-check';
import type { HolderRpc } from '../src/research/holders';

const MINT = Keypair.fromSeed(new Uint8Array(32).fill(91)).publicKey.toBase58();
const SYSTEM = '11111111111111111111111111111111';

/** The SI (Super Intelligence) numbers of 3 Oct, as the sources reported them. */
function siLike(over: Partial<Omit<CoinCheck, 'verdict'>> = {}): Omit<CoinCheck, 'verdict'> {
  return { mint: MINT, at: Date.parse('2026-10-03T15:00:00Z'),
    token: { symbol: 'SI', name: 'Super Intelligence', dev: 'DEV', launchpad: 'pump.fun', createdAt: Date.parse('2026-09-29T22:44:00Z'), links: [] },
    market: { mcapUsd: 880_000, liquidityUsd: 124_000, volume24hUsd: 1.43e6, change1hPct: -27, change24hPct: -48, url: null },
    level: { tier: 'LOW', belowUsd: 100_000, nextUsd: 1e6, toNextX: 1.14 },
    history: { athUsd: 9.25e6, athAt: Date.parse('2026-09-30T18:00:00Z'), drawdownPct: -90.5, toAthX: 10.5, lowSinceAthUsd: 725_000, bars: 90, interval: 'hour' },
    security: { verdict: 'PASS', findings: [], goplus: 'OK', rugcheck: 'OK' },
    holders: { count: 12_154, change1hPct: 0.3, change24hPct: -7.4, topHoldersPct: 16.5, devMints: 19_410, devMigrations: 367,
      scan: { top20Pct: 30.9, programPct: 8.9, walletPct: 22, clusterPct: 0, teamPct: 0, freshPct: 6.9, largestWalletPct: 3.07, largestCluster: null } },
    demand: { organicScore: 75, realBuy1hUsd: 5_327, realSell1hUsd: 7_279, realBuy24hUsd: 73_040, realSell24hUsd: 74_548, realShare24hPct: 7.7, liquidityChange24hPct: -42.7, buyers1h: 23 },
    watched: false, errors: [], ...over };
}

test('coin check verdict: reads the numbers the way the owner\'s WWW and SI checks did', () => {
  const si = verdict(siLike());
  assert.equal(si.tone, 'bad');
  assert.equal(si.headline, 'Clean coin, demand is fading, no team behind it: not a buy signal.');
  assert.match(si.lines[0]!, /^Price: \$880\.0K, 91% below its \$9\.25M high \(2026-09-30 18:00 UTC\); 10\.5× back to it · next level \$1\.00M \(1\.1× away\)\.$/);
  assert.equal(si.lines[1], 'Contract: passes both security scans.');
  assert.match(si.lines[2]!, /the largest 20 hold 31% \(biggest wallet 3\.1%\); no group of wallets controlled by one person found; the team holds 0\.0%; the developer wallet created 19,410 coins \(367 reached the exchange\): a mass launcher/);
  assert.match(si.lines[3]!, /holders -7\.4% in 24 h \(12,154\); real buys\/sells last hour \$5\.3K \/ \$7\.3K; 24 h \$73\.0K \/ \$74\.5K; about 8% of trading is real/);
  assert.equal(si.lines.at(-1), 'It would become interesting if holders rise again and real buyers lead for several hours, with the price back above $1.00M.');
  // Holders rising and real buyers leading in both windows: worth a look, still not a call.
  const up = verdict(siLike({ holders: { ...siLike().holders, change24hPct: 4, devMints: 1 }, demand: { ...siLike().demand, realBuy1hUsd: 9_000, realSell1hUsd: 4_000, realBuy24hUsd: 90_000, realSell24hUsd: 60_000 } }));
  assert.equal(up.tone, 'good'); assert.match(up.headline, /^Demand is building: holders rising and real buyers leading\. Worth a closer look — not a qualified call\.$/);
  // A blocked contract overrides everything.
  const blocked = verdict(siLike({ security: { verdict: 'BLOCK', findings: [{ source: 'goplus', level: 'BLOCK', code: 'MINT', detail: 'live mint authority' }], goplus: 'OK', rugcheck: 'OK' } }));
  assert.equal(blocked.tone, 'bad'); assert.equal(blocked.headline, 'Do not touch: the contract scan blocks it.');
  assert.equal(blocked.lines[1], 'Contract: BLOCK: live mint authority.');
});

test('coin check: four sources in one result, a source that does not answer is listed, never fatal', async () => {
  const now = Date.parse('2026-10-03T15:00:00Z'), urls: string[] = [];
  const jup = { id: MINT, symbol: 'SI', name: 'Super Intelligence', dev: 'DEVW', launchpad: 'pump.fun', holderCount: 12_154, mcap: 890_000, liquidity: 111_000, organicScore: 75,
    firstPool: { createdAt: '2026-09-29T22:42:36Z' }, audit: { topHoldersPercentage: 16.5, devMints: 19_410, devMigrations: 367 },
    stats1h: { priceChange: -27, holderChange: 0.31, buyVolume: 103_892, sellVolume: 123_611, buyOrganicVolume: 5_327, sellOrganicVolume: 7_279, numOrganicBuyers: 23 },
    stats24h: { priceChange: -48.5, holderChange: -7.44, liquidityChange: -42.7, buyVolume: 934_958, sellVolume: 981_784, buyOrganicVolume: 73_040, sellOrganicVolume: 74_548 } };
  const pair = { chainId: 'solana', dexId: 'pumpswap', pairAddress: 'POOL', url: 'https://dexscreener.com/solana/pool', baseToken: { address: MINT, name: 'Super Intelligence', symbol: 'SI' },
    priceUsd: '0.00088', marketCap: 880_000, fdv: 880_000, liquidity: { usd: 124_000 }, volume: { h24: 1.43e6 }, priceChange: { h24: -47.9 }, txns: { h24: { buys: 13_796, sells: 9_135 } },
    pairCreatedAt: Date.parse('2026-09-29T22:44:00Z'), info: { websites: [{ url: 'https://otcdesks.cash' }] } };
  const hour = (h: number, hi: number, lo: number, c: number) => [Date.parse('2026-09-30T00:00:00Z') / 1000 + h * 3600, c, hi, lo, c, 1];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.includes('lite-api.jup.ag/tokens/v2/search')) return new Response(JSON.stringify([jup]));
    if (url.includes('dexscreener.com/latest/dex/tokens')) return new Response(JSON.stringify({ pairs: [pair] }));
    if (url.includes('geckoterminal.com') && url.includes('/ohlcv/hour')) return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [hour(18, 0.00925, 0.0041, 0.0048), hour(80, 0.00091, 0.000725, 0.00088)] } } }));
    if (url.includes('gopluslabs')) return new Response('rate limited', { status: 429 });
    if (url.includes('rugcheck')) return new Response(JSON.stringify({ score: 1, risks: [] }));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const holders: HolderRpc = {
    supply: async () => 1e9, largest: async () => [{ account: 'A1', amount: 7e7 }, { account: 'A2', amount: 3e7 }, { account: 'A3', amount: 1e7 }],
    owners: async () => ['POOLPROGRAMOWNED', 'W1', 'W2'], programs: async (a: string[]) => a.map(x => x === 'POOLPROGRAMOWNED' ? 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' : SYSTEM),
    history: async () => ({ count: 5, oldest: { signature: 'S', at: now - 86_400_000 } }), funder: async () => null };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coin-check-')), watchFile = path.join(dir, 'watch-tokens.json');
  await fs.writeFile(watchFile, JSON.stringify([{ mint: MINT, note: 'already watched' }]));
  const r = await checkCoin(MINT, { fetcher, holders, watchFile, now: () => now });
  assert.equal(r.token.symbol, 'SI'); assert.equal(r.market!.mcapUsd, 880_000); assert.equal(r.level.tier, 'LOW');
  assert.ok(r.history && Math.abs(r.history.athUsd - 9.25e6) < 1, `high from GeckoTerminal candles × supply (${r.history?.athUsd})`);
  assert.equal(r.holders.change24hPct, -7.44); assert.equal(r.holders.devMints, 19_410);
  const near = (a: number | null | undefined, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(r.holders.scan!.top20Pct, 11); near(r.holders.scan!.programPct, 7); near(r.holders.scan!.largestWalletPct, 3);
  assert.equal(r.demand.realSell1hUsd, 7_279); assert.ok(Math.abs(r.demand.realShare24hPct! - 7.7) < 0.1);
  assert.equal(r.security!.goplus.startsWith('ERROR') || r.security!.goplus === 'NOT_FOUND', true, r.security!.goplus);
  assert.equal(r.watched, true);
  assert.equal(r.verdict.tone, 'bad');
  assert.deepEqual(r.errors, [], 'a security source down is shown in the scan, not as a failed check');
  // Jupiter down: the rest still answers, and the failure is listed.
  const down = (async (url: string) => url.includes('jup.ag') ? new Response('down', { status: 503 }) : fetcher(url)) as typeof fetch;
  const partial = await checkCoin(MINT, { fetcher: down, holders: null, now: () => now });
  assert.ok(partial.errors.some(e => e.startsWith('Jupiter')), partial.errors.join('; '));
  assert.equal(partial.market!.mcapUsd, 880_000); assert.equal(partial.holders.scan, null);
  // The RPC refuses once (429: the desk and the observer use it too): the holder scan is tried again, not dropped.
  let refused = 0;
  const busy: HolderRpc = { ...holders, largest: async (m: string) => { if (!refused++) throw new Error('429 : Too Many Requests'); return holders.largest(m); } };
  const retried = await checkCoin(MINT, { fetcher, holders: busy, now: () => now, retryMs: 1 });
  assert.equal(refused, 2); assert.deepEqual(retried.errors, []); near(retried.holders.scan!.top20Pct, 11);
  await assert.rejects(checkCoin('not-a-mint'), /INVALID_MINT/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('watchlist: a checked coin is added once, as the observer reads it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchlist-')), file = path.join(dir, 'watch-tokens.json');
  assert.equal(await addToWatchlist(file, MINT, 'SI (Super Intelligence)\ncoin check'), true);
  assert.equal(await addToWatchlist(file, MINT, 'again'), false);
  const list = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(list, [{ mint: MINT, note: 'SI (Super Intelligence) coin check' }]);
  await assert.rejects(addToWatchlist(file, '0xabc', 'evm'), /INVALID_MINT/);
  await fs.rm(dir, { recursive: true, force: true });
});

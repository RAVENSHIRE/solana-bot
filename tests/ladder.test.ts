import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { ResearchLedger } from '../src/research/ledger';
import { ledgerFiles } from '../src/research/dataset';
import { LADDER, LadderWatch, levels, readLadder, tierOf } from '../src/research/ladder';
import { cohorts, ladderGroups, ladderSamples } from '../src/research/ladder-study';
import { scanHolders, type HolderRpc } from '../src/research/holders';

const addr = (i: number) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey.toBase58();
const SYSTEM = '11111111111111111111111111111111';

test('ladder: tiers and decade levels', () => {
  assert.equal(tierOf(1.15e6), 'MID'); assert.equal(tierOf(99_999), 'MICRO'); assert.equal(tierOf(2.5e8), 'LARGE');
  assert.deepEqual(levels(1.15e6), { below: 1e6, above: 1e7 });
  assert.deepEqual(levels(9_999), { below: 1_000, above: 10_000 });
  assert.deepEqual(levels(100_000), { below: 100_000, above: 1e6 });
});

/** A fake holder RPC: accounts, owners, programs, histories and funders from tables. */
function fakeRpc(o: { supply: number; holders: Array<[owner: string, amount: number, program?: string]>; history: Record<string, [count: number, at?: number]>; funders: Record<string, string> }): HolderRpc & { calls: number } {
  const rpc = {
    calls: 0,
    supply: async () => { rpc.calls++; return o.supply; },
    largest: async () => { rpc.calls++; return o.holders.map(([owner, amount], i) => ({ account: `acct${i}-${owner}`, amount })); },
    owners: async (accounts: string[]) => { rpc.calls++; return accounts.map(a => a.slice(a.indexOf('-') + 1)); },
    programs: async (addresses: string[]) => { rpc.calls++; return addresses.map(a => o.holders.find(h => h[0] === a)?.[2] ?? SYSTEM); },
    history: async (w: string) => { rpc.calls++; const [count, at] = o.history[w] ?? [0]; return { count, oldest: count ? { signature: `sig-${w}`, at: at ?? null } : null }; },
    funder: async (w: string) => { rpc.calls++; return o.funders[w] ?? null; },
  };
  return rpc;
}

test('holder scan: one funder behind several wallets is a cluster, busy funders are not, the developer\'s wallets are the team', async () => {
  const now = Date.parse('2026-10-03T12:00:00Z'), old = now - 90 * 86_400_000, fresh = now - 2 * 86_400_000;
  const rpc = fakeRpc({ supply: 1_000,
    holders: [['POOL', 300, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'], ['W1', 100], ['W2', 80], ['W3', 50], ['DEV', 20], ['W4', 15], ['W5', 10], ['W6', 5]],
    history: { W1: [5, fresh], W2: [8, fresh], W3: [2_000], DEV: [3, old], W4: [4, old], W5: [6, old], W6: [7, old], F: [12], G: [40], EXCH: [5_000] },
    funders: { W1: 'F', W2: 'F', DEV: 'G', W4: 'DEV', W5: 'EXCH', W6: 'EXCH' } });
  const s = await scanHolders(rpc, 'MINT', { dev: 'DEV', now });
  assert.equal(s.programPct, 30, 'the pool');
  assert.equal(s.walletPct, 28);
  assert.equal(s.clusterPct, 21.5, 'W1 and W2 share funder F (18 %); W4 was funded by the developer, a top holder (3.5 %); W5/W6 only share a busy exchange');
  assert.deepEqual(s.largest, { funder: 'F', pct: 18, wallets: 2 });
  assert.equal(s.teamPct, 3.5, 'the developer (2 %) and the wallet it funded (1.5 %)');
  assert.equal(s.freshPct, 18, 'W1 and W2 made their first transaction 2 days ago');
  assert.deepEqual(s.services, ['EXCH']);
  assert.equal(s.devFunder, 'G');
  assert.equal(s.holders.find(h => h.owner === 'W3')!.busy, true);
  assert.ok(rpc.calls < 50, `about 45 calls per token (${rpc.calls})`);
});

test('ladder watch: every chain, tracked after it leaves the lists, history and holder scans, recorded as facts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-ladder-'));
  let now = Date.parse('2026-10-03T02:00:00Z');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const www = addr(1), stable = addr(2), tiny = addr(3), solPool = addr(4), watched = addr(5);
  const jup = (id: string, o: Record<string, unknown> = {}) => ({ id, symbol: id === www ? 'www' : `S${id.slice(0, 3)}`, name: 'coin', usdPrice: 0.00115, mcap: 1.15e6, liquidity: 1.5e5,
    holderCount: 9_016, organicScore: 75, dev: 'DEVWALLET', audit: { topHoldersPercentage: 14.8, devBalancePercentage: 0 }, firstPool: { createdAt: '2026-10-02T03:24:00Z' },
    stats1h: { priceChange: -13.7, numBuys: 2571, numSells: 1950, buyVolume: 176_510, sellVolume: 193_586, buyOrganicVolume: 6_464, sellOrganicVolume: 16_748, numNetBuyers: 433, holderChange: -1.45 },
    stats6h: { priceChange: -69 }, stats24h: { priceChange: 2823, holderChange: 2432 }, ...o });
  let lists: unknown[] = [jup(www), jup(stable, { tags: ['stable'] }), jup(tiny, { mcap: 5_000 })];
  const rh = 'robinhood_0xa241395adcdf456f6dc04d1bc02b18e6f4c4052c';
  const pool = (id: string, base: string, o: Record<string, unknown> = {}) => ({ id, attributes: { address: id.split('_')[1], base_token_price_usd: '0.000326', market_cap_usd: '325359', reserve_in_usd: '51461',
    pool_created_at: '2026-09-25T16:33:59Z', price_change_percentage: { h1: '3.1', h6: '-1.4', h24: '-20.4' }, transactions: { h1: { buys: 687, sells: 652, buyers: 346, sellers: 347 } }, volume_usd: { h1: '51816' }, ...o },
    relationships: { base_token: { data: { id: base } }, network: { data: { id: base.slice(0, base.indexOf('_')) } } } });
  let trending: unknown = { data: [pool('robinhood_0xpool1', rh), pool('eth_0xwethpool', 'eth_0xweth'), pool(`solana_${solPool}pool`, `solana_${solPool}`, { market_cap_usd: '2000000', reserve_in_usd: '300000' })],
    included: [{ id: rh, attributes: { symbol: 'ROBINPEPE', name: 'Robin Pepe' } }, { id: 'eth_0xweth', attributes: { symbol: 'WETH' } }] };
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.includes('lite-api.jup.ag/tokens/v2/search')) return new Response(JSON.stringify(decodeURIComponent(url.split('query=')[1]!).split(',').map(m => jup(m))));
    if (url.includes('lite-api.jup.ag/tokens/v2/toptrending/1h')) return new Response(JSON.stringify(lists));
    if (url.includes('lite-api.jup.ag')) return new Response('[]');
    if (url.includes('networks/trending_pools?page=1')) return new Response(JSON.stringify(trending));
    if (url.includes('networks/trending_pools')) return new Response(JSON.stringify({ data: [] }));
    if (url.includes('/pools/multi/')) return new Response(JSON.stringify({ data: [pool('robinhood_0xpool1', rh, { market_cap_usd: '280000' })] }));
    if (url.includes('birdeye.so/defi/ohlcv')) return new Response(JSON.stringify({ data: { items: [
      { unixTime: Date.parse('2026-10-02T03:00:00Z') / 1000, h: 0.0007, l: 0.000003, c: 0.0006 }, { unixTime: Date.parse('2026-10-02T09:00:00Z') / 1000, h: 0.0082, l: 0.0037, c: 0.006 },
      { unixTime: Date.parse('2026-10-03T01:00:00Z') / 1000, h: 0.0013, l: 0.0009, c: 0.00115 }] } }));
    if (url.includes('ohlcv')) return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[Date.parse('2026-09-28T00:00:00Z') / 1000, 0, 0.0009, 0.0001, 0.0003, 1]] } } }));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const rpc = fakeRpc({ supply: 1e9, holders: [['POOL', 1e8, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'], ['W1', 5e7]], history: { W1: [3, now - 3_600_000] }, funders: {} });
  const watchFile = path.join(dir, 'watch-tokens.json'), stateFile = path.join(dir, 'ladder-state.json');
  await fs.writeFile(watchFile, JSON.stringify([{ mint: watched, note: 'mine' }]));
  const w = new LadderWatch({ ledger, stateFile, watchFile, fetcher, birdeyeApiKey: 'KEY', holders: rpc, now: () => now, sleep: async () => undefined });
  await w.check();
  const keys = w.tracked().sort();
  assert.deepEqual(keys, [`robinhood:0xa241395adcdf456f6dc04d1bc02b18e6f4c4052c`, `solana:${solPool}`, `solana:${watched}`, `solana:${www}`].sort(),
    'WWW, the Robinhood Chain coin, the Solana pool from GeckoTerminal and the watchlist; not the stablecoin, the $5K coin or WETH');
  assert.ok(urls.some(u => u.includes(`search?query=`) && u.includes(solPool) && u.includes(watched)), 'Solana coins seen only on GeckoTerminal or the watchlist are read from Jupiter');
  assert.ok(urls.some(u => u.includes('birdeye.so/defi/ohlcv') && u.includes(www) && !u.includes('KEY')), 'history from Birdeye, the key in a header only');
  // Second cycle, nothing on the lists: tracked coins are still recorded (Jupiter search, GeckoTerminal pools/multi).
  now += LADDER.everyMs; lists = []; trending = { data: [] };
  await w.check();
  // Eight days later without a listing: dropped, except the watchlist.
  now += 8 * 86_400_000;
  await w.check();
  assert.deepEqual(w.tracked(), [`solana:${watched}`]);
  await ledger.close();
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { tracks: unknown[] };
  assert.equal(state.tracks.length, 1, 'state saved for a restart');
  const data = readLadder(ledgerFiles(dir));
  const c = data.get(`solana:${www}`)!;
  assert.equal(c.symbol, 'www');
  assert.equal(c.snaps.length, 2, 'snapshotted on the list and as a tracked coin');
  assert.equal(c.snaps[0]!.mcap, 1_150_000); assert.equal(c.snaps[0]!.holderCh1h, -1.45); assert.equal(c.snaps[0]!.orgSellVol1h, 16_748); assert.equal(c.snaps[1]!.src, 'track');
  assert.equal(c.histories.length, 1);
  assert.ok(Math.abs(c.histories[0]!.athMcap - 8.2e6) < 1e3, `ATH from Birdeye candles × supply (${c.histories[0]!.athMcap})`);
  assert.equal(c.holders.length, 1, 'holder scan for a coin over $1M');
  const rob = data.get('robinhood:0xa241395adcdf456f6dc04d1bc02b18e6f4c4052c')!;
  assert.equal(rob.symbol, 'ROBINPEPE');
  assert.deepEqual(rob.snaps.map(s => [s.mcap, s.buyers1h, s.src]), [[325_359, 346, 'trending'], [280_000, 346, 'track']]);
});

test('ladder study: one sample a day, outcomes over 24 h and 7 days, cohorts by distance below the high', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-ladder-study-'));
  const t0 = Date.parse('2026-10-01T00:00:00Z'), H = 3_600_000;
  let now = t0;
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 5e9 });
  await ledger.start();
  const snap = (key: string, mcap: number, extra: unknown[] = []) => ledger.put(['LS', now, { $m: key }, 'list', key.slice(7, 10), mcap, 1e5, 0.001, 5_000, 70, 0, 0, 0, 10, 8, null, null, 1e4, null, null, 1e3, 5e2, null, null, 2, null, null, t0 - 30 * 86_400_000, ...extra]);
  // A: $1M, 87.5 % below an $8M high, doubles on day 2. B: $1M, halves on day 1.
  ledger.put(['LA', now, { $m: 'solana:AAAA' }, 'birdeye', '1H', 200, 8e6, t0 - 86_400_000, 9e5, t0, null]);
  for (let h = 0; h <= 9 * 24; h += 6) {
    now = t0 + h * H;
    snap('solana:AAAA', h >= 48 ? 2.5e6 : 1e6);
    snap('solana:BBBB', h >= 24 ? 4.5e5 : 1e6);
  }
  await ledger.close();
  const data = readLadder(ledgerFiles(dir));
  const samples = ladderSamples(data, now);
  const a = samples.filter(s => s.key === 'solana:AAAA');
  assert.equal(a.length, 10, 'one sample a day over 9 days');
  assert.equal(a[0]!.tier, 'MID'); assert.equal(a[0]!.drawdownPct, 87.5); assert.equal(a[0]!.organicFlow, 2);
  assert.deepEqual(a[0]!.outcome['24h'] && { up2x: a[0]!.outcome['24h'].up2x, next: a[0]!.outcome['24h'].nextLevel }, { up2x: false, next: false });
  assert.equal(a[0]!.outcome['7d']!.up2x, true); assert.equal(a[0]!.outcome['7d']!.ath, false); assert.equal(a[0]!.outcome['7d']!.maxRisePct, 150);
  assert.equal(a.at(-1)!.outcome['7d'], undefined, 'too recent for a 7-day outcome');
  const b = samples.find(s => s.key === 'solana:BBBB')!;
  assert.equal(b.drawdownPct, null, 'no price history read for B: distance below its high unknown');
  assert.equal(b.outcome['7d']!.halvedFirst, true);
  const groups = Object.fromEntries(ladderGroups(samples));
  const [www] = cohorts(samples, '7d', groups['Below the all-time high']!.filter(([l]) => l.startsWith('mid tier')));
  assert.equal(www!.n, 2, 'A on days 0 and 1 (87.5 % below); from day 2 it is 69 % below');
  assert.equal(www!.up2xPct, 100);
});

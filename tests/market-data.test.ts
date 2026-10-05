import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DataCache } from '../src/data/core/data-cache';
import { DataRuntime, defaultDataSettings } from '../src/data/core/data-runtime';
import { DataHealth } from '../src/data/core/data-health';
import { DataError, assertFresh, observation } from '../src/data/core/data-types';
import { address, exactNumber, parse, rawAmount } from '../src/data/core/data-validator';
import { RequestGate, requestScope } from '../src/data/core/request-scope';
import { HttpClient, retryAfter } from '../src/data/http-client';
import { DexScreenerClient, dexSnapshot, normalizeDexPairs } from '../src/data/dexscreener';
import { GeckoTerminalClient, geckoSnapshot, normalizeGeckoPool, normalizeOhlcv, normalizeTrades } from '../src/data/geckoterminal';
import { RaydiumClient, normalizeRaydiumPools } from '../src/data/raydium';
import { assessQuality, reconcile } from '../src/data/services/market-intelligence';
import { parseMintAccount, SolanaDataClient } from '../src/data/solana-rpc';
import { MarketDataStore, replay } from '../src/data/storage/market-data-store';
import { TokenSafetyChecker } from '../src/analysis/token-safety';
import { JupiterClient } from '../src/execution/jupiter-client';
import { LiveExecutor } from '../src/execution/live-executor';
import { parseOwnedTokenAccount } from '../src/execution/token-accounts';
import { validateQuote } from '../src/execution/quote-validation';
import { roundtripOutcome } from '../src/execution/roundtrip';
import { BaseStrategy } from '../src/strategies/base-strategy';
import { ReversalSniperStrategy } from '../src/strategies/reversal-sniper';
import { SuckUpTheRentStrategy } from '../src/strategies/suck-up-the-rent';
import { Engine } from '../src/core/engine';
import { PRICE_QUOTE_MINTS, USDC_MINT, USDT_MINT } from '../src/core/types';
import { TokenBucket } from '../src/utils/rate-limiter';
import { Logger, configureLogger } from '../src/utils/logger';
import { redact } from '../src/utils/redact';

// Deterministic synthetic fixtures ONLY. No fixture is imported by runtime code.
const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = '11111111111111111111111111111111';
const WALLET = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const NOW = 1_790_500_200_000; // Exact 5-minute boundary.
const log = new Logger('test'); configureLogger({ level: 'error', color: false });
const settings = { ...defaultDataSettings, dexRps: 1000, geckoRps: 1000, raydiumRps: 1000, retries: 0 };
const reply = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const dexRaw = () => ({ chainId: 'solana', dexId: 'test', pairAddress: POOL, baseToken: { address: MINT, symbol: 'SAME' }, quoteToken: { address: SOL },
  priceUsd: '0.01', liquidity: { usd: 10000 }, marketCap: null, fdv: 99999, pairCreatedAt: NOW - 86_400_000,
  priceChange: { m5: 1, h6: -20, h24: -30 }, volume: { h1: 100 }, txns: { h1: { buys: 30, sells: 20 } } });
const geckoRaw = () => ({ id: `solana_${POOL}`, attributes: { address: POOL, name: 'fixture/SOL', base_token_price_usd: '0.01', reserve_in_usd: '10000',
  pool_created_at: new Date(NOW - 86_400_000).toISOString(), volume_usd: { h1: '100' } }, relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: `solana_${SOL}` } } } });
const rayRaw = () => ({ id: POOL, type: 'Standard', pooltype: ['Amm'], mintA: { address: MINT, decimals: 6, symbol: 'A' }, mintB: { address: SOL, decimals: 9, symbol: 'B' },
  price: 0.001, tvl: 100000, feeRate: .0025, openTime: String((NOW - 86_400_000) / 1000), day: { volume: 10000, feeApr: 20, priceMin: .0009, priceMax: .0011 } });
const candleRaw = (rows: number[][]) => ({ data: { attributes: { ohlcv_list: rows } } });
const candle = (t: number) => [t / 1000, 10, 12, 9, 11, 100];
const trade = (id = 'event1', t = NOW - 1000) => ({ id, attributes: { tx_hash: 'transaction1', tx_from_address: WALLET,
  from_token_address: SOL, to_token_address: MINT, from_token_amount: '1', to_token_amount: '100', price_from_in_usd: '100', price_to_in_usd: '1',
  volume_in_usd: '100', block_timestamp: new Date(t).toISOString(), kind: 'buy' } });
const quoteRaw = (input = SOL, output = MINT, amount = '100000000', out = '1000000', min = '990000') => ({ inputMint: input, outputMint: output,
  inAmount: amount, outAmount: out, otherAmountThreshold: min, swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0.001',
  routePlan: [{ percent: 100, swapInfo: { ammKey: POOL, inputMint: input, outputMint: output, inAmount: amount, outAmount: out } }] });
const qcfg = { baseUrl: 'https://example.invalid', apiKey: undefined, maxRps: 1000, maxAccounts: 40, maxPriorityFeeLamports: 300000, priorityLevel: 'high' as const, quoteMaxAgeMs: 15_000 };

test('Dex: Solana identity, numeric parsing and unknown market cap stay distinct from FDV', () => {
  const [p] = normalizeDexPairs([dexRaw(), { chainId: 'ethereum' }], NOW);
  assert.equal(p!.priceUsd, .01); assert.equal(p!.marketCap, null); assert.equal(p!.fdv, 99999);
  assert.equal(dexSnapshot(p!).volumeUsd.h24, null); assert.equal(p!.meta.sourceAt, null);
  assert.equal(p!.meta.freshness, 'unknown');
});
test('Dex rejects malformed Solana fields, negatives, nonfinite prices and future pool time', () => {
  for (const patch of [{ pairAddress: 'bad' }, { priceUsd: 'Infinity' }, { liquidity: { usd: -1 } }, { pairCreatedAt: Date.now() + 100000 }])
    assert.throws(() => normalizeDexPairs([{ ...dexRaw(), ...patch }], NOW), DataError);
});
test('analytical pool selection records rejected alternatives and never keys by symbol', () => {
  const rows = normalizeDexPairs([dexRaw(), { ...dexRaw(), pairAddress: WALLET, liquidity: { usd: 1 } }], NOW);
  const choice = DexScreenerClient.selectPairs(rows, NOW);
  assert.equal(choice.selected.get(MINT)?.pairAddress, POOL); assert.equal(choice.rejected[0]?.pool, WALLET);
  assert.equal(DexScreenerClient.selectPairs(rows, NOW + 90001).selected.size, 0);
  assert.equal(DexScreenerClient.selectPairs([{ ...rows[0]!, liquidity: { usd: null } }], NOW).selected.size, 0);
});
test('USD valuation prices USDC from its USDC/USDT pool; discovery still rejects USDT quotes', () => {
  // DexScreener lists USDC only as the base of a USDC/USDT pool; without it every micro scan was USD_PRICE_MISSING.
  const rows = normalizeDexPairs([{ ...dexRaw(), baseToken: { address: USDC_MINT, symbol: 'USDC' }, quoteToken: { address: USDT_MINT }, priceUsd: '1.0003' }], NOW);
  assert.equal(DexScreenerClient.selectPairs(rows, NOW).rejected[0]?.reason, 'UNSUPPORTED_QUOTE');
  assert.equal(DexScreenerClient.selectPairs(rows, NOW, 90_000, PRICE_QUOTE_MINTS).selected.get(USDC_MINT)?.priceUsd, 1.0003);
});
test('Dex client batches 31 distinct mints into <=30 and shares concurrent discovery', async () => {
  const paths: string[] = []; const runtime = new DataRuntime(log, settings, undefined, async input => {
    const url = new URL(String(input)); paths.push(url.pathname);
    return reply(url.pathname.includes('boosts') ? [{ chainId: 'solana', tokenAddress: MINT }] : []);
  }); const client = new DexScreenerClient(log, runtime);
  await Promise.all([client.getLatestBoostedTokens(), client.getLatestBoostedTokens()]);
  await client.getPairsForTokens(Array.from({ length: 31 }, (_, n) => new PublicKey(new Uint8Array(32).fill(n + 1)).toBase58()));
  assert.equal(paths.length, 3); assert.ok(paths.slice(1).every(p => p.split('/').at(-1)!.split(',').length <= 30));
});
test('Gecko pool normalization verifies network, pool and token relationships', () => {
  const p = normalizeGeckoPool(geckoRaw(), NOW); assert.equal(p.volumeUsd.h24, null); assert.equal(p.baseTokenMint, MINT);
  assert.throws(() => normalizeGeckoPool({ ...geckoRaw(), id: `eth_${POOL}` }, NOW));
  assert.throws(() => normalizeGeckoPool({ ...geckoRaw(), id: `solana_${WALLET}` }, NOW));
});
test('OHLCV converts seconds, orders, deduplicates and separates current candle', () => {
  const series = normalizeOhlcv(candleRaw([candle(NOW), candle(NOW - 600000), candle(NOW - 300000), candle(NOW - 600000)]), POOL, MINT, 300000, NOW + 10000);
  assert.deepEqual(series.candles.map(c => c.t), [NOW - 600000, NOW - 300000]); assert.equal(series.partial.length, 1);
  assert.equal(series.meta.sourceAt, NOW); assert.deepEqual(series.missingIntervals, []);
});
test('OHLCV gaps stay missing; invalid relationships/future/conflicting duplicates fail', () => {
  const gap = normalizeOhlcv(candleRaw([candle(NOW - 900000), candle(NOW - 300000)]), POOL, MINT, 300000, NOW);
  assert.deepEqual(gap.missingIntervals, [NOW - 600000]);
  for (const rows of [[candle(NOW + 300000)], [[(NOW - 300000) / 1000, 10, 8, 9, 11, 1]], [candle(NOW - 300000), [(NOW - 300000) / 1000, 10, 12, 9, 10, 1]]])
    assert.throws(() => normalizeOhlcv(candleRaw(rows), POOL, MINT, 300000, NOW));
});
test('trade events preserve separate events per transaction and prove side from mint flow', () => {
  const second = trade('event2'); second.attributes.kind = 'sell'; // Provider label is not trusted for requested-token side.
  const out = normalizeTrades({ data: [trade(), trade(), second] }, POOL, MINT, NOW);
  assert.equal(out.length, 2); assert.equal(out[1]!.kind, 'buy'); assert.equal(out[0]!.walletVerified, false);
  assert.equal(normalizeTrades({ data: [trade()] }, POOL, SOL, NOW)[0]!.kind, 'sell');
  assert.throws(() => normalizeTrades({ data: [trade()] }, POOL, WALLET, NOW));
  assert.throws(() => normalizeTrades({ data: [trade(), { ...trade(), attributes: { ...trade().attributes, volume_in_usd: '200' } }] }, POOL, MINT, NOW));
});
test('Raydium retains nullable measurements and distinguishes CLMM/stable pools', () => {
  const p = normalizeRaydiumPools([rayRaw(), { ...rayRaw(), type: 'Concentrated' }, { ...rayRaw(), pooltype: ['StablePool'], tvl: null }], NOW);
  assert.deepEqual(p.map(x => x.constantProduct), [true, false, false]); assert.equal(p[2]!.tvl, null);
  assert.throws(() => normalizeRaydiumPools([{ ...rayRaw(), mintA: { address: MINT, decimals: -1, symbol: 'x' } }], NOW));
});
test('provider clients consume current Gecko and Raydium envelopes', async () => {
  const runtime = new DataRuntime(log, settings, undefined, async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('trending_pools')) return reply({ data: [geckoRaw()] });
    if (url.pathname.endsWith('list-v2')) { assert.equal(url.searchParams.get('size'), '100'); return reply({ success: true, data: { data: [rayRaw()] } }); }
    return reply({ success: true, data: [rayRaw(), null] });
  });
  assert.equal((await new GeckoTerminalClient(log, runtime).getTrendingPools())[0]?.baseTokenMint, MINT);
  const ray = new RaydiumClient(log, runtime); assert.equal((await ray.listPools({ sortField: 'volume24h', pageSize: 100 })).length, 1);
  assert.equal((await ray.getPoolsByIds([POOL])).length, 1);
});
test('reconciliation compares one token and pool without averaging or volume summation', () => {
  const now = Date.now(); const a = dexSnapshot(normalizeDexPairs([dexRaw()], now)[0]!); const b = geckoSnapshot(normalizeGeckoPool(geckoRaw(), now));
  assert.deepEqual(reconcile(a, b, 90000), []);
  assert.deepEqual(reconcile(a, { ...b, priceUsd: 100, liquidityUsd: null }, 90000), ['PRICE_DISAGREEMENT', 'UNKNOWN_LIQUIDITY']);
  assert.deepEqual(reconcile(a, { ...b, pool: { ...b.pool, address: WALLET } }, 90000), ['POOL_IDENTITY_MISMATCH']);
});
test('quality gate rejects gaps, stale candles and insufficient wallet evidence without changing scores', () => {
  const s = normalizeOhlcv(candleRaw([candle(NOW - 900000), candle(NOW - 300000)]), POOL, MINT, 300000, NOW);
  const quality = assessQuality(s, [], 600000, 60, NOW + 700000); assert.equal(quality.adequate, false);
  for (const code of ['MISSING_CANDLES', 'INSUFFICIENT_CANDLES', 'STALE_CANDLES', 'INSUFFICIENT_TRADE_SAMPLE']) assert.ok(quality.reasons.includes(code));
  assert.equal(quality.walletEvidence, 'heuristic-only');
});
test('cache shares in-flight work, clones values, expires, invalidates and bounds capacity', async () => {
  let now = 0; let calls = 0; const cache = new DataCache(2, () => now); const task = deferred<{ n: number }>();
  const first = cache.get('a', 10, () => { calls++; return task.promise; }); const second = cache.get('a', 10, () => { throw new Error('duplicate'); });
  task.resolve({ n: 1 }); const values = await Promise.all([first, second]); values[0]!.n = 99;
  assert.equal(values[1]!.n, 1); assert.equal((await cache.get('a', 10, async () => ({ n: 9 }))).n, 1); assert.equal(calls, 1);
  now = 10; assert.equal((await cache.get('a', 10, async () => ({ n: 2 }))).n, 2);
  cache.invalidate('a'); assert.equal(cache.size, 0);
  for (const key of ['a', 'b', 'c']) await cache.get(key, 10, async () => 1);
  assert.equal(cache.size, 2);
});
test('cache never caches failures or resurrects invalidated in-flight values', async () => {
  const cache = new DataCache(); const task = deferred<number>(); const pending = cache.get('a', 1000, () => task.promise);
  cache.invalidate(); task.resolve(1); await pending; assert.equal(cache.size, 0);
  await assert.rejects(cache.get('a', 1000, async () => { throw new Error('outage'); })); assert.equal(cache.size, 0);
});
function http(fetcher: typeof fetch, extra = {}) { return new HttpClient({ name: 'test', source: 'dexscreener', baseUrl: 'https://example.invalid', limiter: new TokenBucket(100, 1000), logger: log, timeoutMs: 20, retries: 0, fetch: fetcher, ...extra }); }
test('HTTP retries 5xx, respects 429 Retry-After and emits health counters', async () => {
  let calls = 0; const health = new DataHealth(); const client = http(async () => { calls++; return calls === 1 ? reply({}, 503) : calls === 2 ? reply({}, 429, { 'retry-after': '0' }) : reply({ ok: true }); }, { retries: 2, health });
  assert.deepEqual(await client.get('/test'), { ok: true }); assert.equal(health.status('dexscreener').retries, 2); assert.equal(health.status('dexscreener').rateLimits, 1);
  assert.equal(retryAfter('2', NOW), 2000); assert.equal(retryAfter(new Date(NOW + 5000).toUTCString(), NOW), 5000);
});
test('HTTP rejects invalid JSON, huge bodies, authorization failure without retries', async () => {
  for (const response of [new Response('not-json'), new Response('x'.repeat(100)), reply({}, 401)]) {
    let calls = 0; const client = http(async () => { calls++; return response; }, { maxBodyBytes: 30, retries: 2 });
    await assert.rejects(client.get('/test'), DataError); assert.equal(calls, 1);
  }
});
test('HTTP timeout and task cancellation never return fabricated observations', async () => {
  const client = http(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const keepAlive = setTimeout(() => {}, 100); try { await assert.rejects(client.get('/slow'), /timeout/); } finally { clearTimeout(keepAlive); }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestScope.run({ category: 'analysis', signal: controller.signal }, () => client.get('/cancelled')));
});
test('source cooldown rejects requests until expiry; another provider remains usable', async () => {
  let calls = 0; const client = http(async () => { calls++; return reply({}, 503); });
  for (let n = 0; n < 3; n++) await assert.rejects(client.get('/fail'));
  await assert.rejects(client.get('/fail'), /cooldown/); assert.equal(calls, 3);
  const runtime = new DataRuntime(log, settings, undefined, async input => String(input).includes('geckoterminal') ? reply({}, 503) : reply([dexRaw()]));
  const results = await Promise.allSettled([new GeckoTerminalClient(log, runtime).getTrendingPools(), new DexScreenerClient(log, runtime).getPairsForTokens([MINT])]);
  assert.equal(results[0]!.status, 'rejected'); assert.equal(results[1]!.status, 'fulfilled');
});
test('a refused request (HTTP 4xx such as no route) is not an outage: no retry, no cooldown, provider error code kept', async () => {
  let calls = 0; const client = http(async () => { calls++; return reply({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400); }, { retries: 2 });
  for (let n = 0; n < 5; n++) await assert.rejects(client.get('/quote'), (e: unknown) => e instanceof DataError && e.kind === 'rejected' && /HTTP 400 COULD_NOT_FIND_ANY_ROUTE$/.test(e.message));
  assert.equal(calls, 5, 'every request reaches the provider: one unroutable token never pauses the others');
  const bad = http(async () => reply({ errorCode: 'x'.repeat(200) }, 422));
  await assert.rejects(bad.get('/quote'), /HTTP 422$/);
});
test('priority gate reserves execution capacity and preserves originating request scope', async () => {
  const gate = new RequestGate(2); const first = deferred(); const order: string[] = [];
  const a = requestScope.run({ category: 'discovery', strategy: 'A' }, () => gate.run(async () => { order.push('a'); await first.promise; }));
  const b = requestScope.run({ category: 'discovery', strategy: 'B' }, () => gate.run(async () => { order.push(requestScope.getStore()!.strategy!); }));
  const c = requestScope.run({ category: 'execution' }, () => gate.run(async () => { order.push('execution'); }));
  await c; assert.deepEqual(order, ['a', 'execution']); first.resolve(); await Promise.all([a, b]); assert.equal(order[2], 'B');
});
test('raw supplies stay bigint; unsafe balance numbers and invalid addresses fail closed', () => {
  assert.equal(parse(rawAmount, '18446744073709551615', 'test'), 18446744073709551615n);
  assert.throws(() => exactNumber(9007199254740992n)); assert.equal(exactNumber(123n), 123);
  assert.throws(() => parse(address, 'javascript:alert(1)', 'test'));
  assert.throws(() => assertFresh(observation('dexscreener', NOW, MINT, POOL), 10, NOW + 11));
});
const mintAccount = () => ({ owner: TOKEN_PROGRAM_ID, data: { program: 'spl-token', parsed: { type: 'mint', info: {
  decimals: 6, supply: '18446744073709551615', mintAuthority: null, freezeAuthority: null, isInitialized: true } } } });
test('RPC mint validation verifies account owner, decimals, authorities and exact supply', () => {
  assert.equal(parseMintAccount(mintAccount()).supply, 18446744073709551615n);
  assert.throws(() => parseMintAccount({ ...mintAccount(), owner: new PublicKey(POOL) }));
  const invalid = mintAccount(); delete (invalid.data.parsed.info as any).freezeAuthority; assert.throws(() => parseMintAccount(invalid));
});
test('safety fresh check bypasses cache; RPC outage is unavailable rather than safe', async () => {
  let calls = 0; const checker = new TokenSafetyChecker({ execute: async () => { calls++; return { value: mintAccount() }; } } as any, log);
  assert.equal((await checker.safeCheck(MINT, { rejectMintAuthority: true })).ok, true);
  await checker.safeCheck(MINT, { rejectMintAuthority: true }); assert.equal(calls, 1);
  await checker.safeCheck(MINT, { rejectMintAuthority: true, fresh: true }); assert.equal(calls, 2);
  const down = new TokenSafetyChecker({ execute: async () => { throw new Error('RPC outage'); } } as any, log);
  assert.equal((await down.safeCheck(MINT, { rejectMintAuthority: true })).status, 'unavailable');
  const adapter = new SolanaDataClient({ execute: async () => { throw new Error('offline'); } } as any, new DataRuntime(log, settings));
  assert.equal((await adapter.verifyMint(MINT)).status, 'unavailable');
});
test('Jupiter validates mint, raw amount, impact and slippage; preserves exact bigints', () => {
  const raw = quoteRaw(); const request = { inputMint: SOL, outputMint: MINT, amountRaw: 100000000n, slippageBps: 100 };
  assert.equal(validateQuote(raw, request).outAmount, '1000000');
  for (const patch of [{ priceImpactPct: '' }, { priceImpactPct: 'NaN' }, { outputMint: SOL }, { inAmount: '99' }, { otherAmountThreshold: '1' }, { routePlan: [] }]) assert.throws(() => validateQuote({ ...raw, ...patch }, request));
});
test('Jupiter fetches every executable quote and rejects copied, mutated or stale authorization', async () => {
  let calls = 0; const jupiter = new JupiterClient(qcfg, log, undefined, async () => { calls++; return reply(quoteRaw()); });
  const params = { inputMint: SOL, outputMint: MINT, amountRaw: 100000000n, slippageBps: 100 };
  const q = await jupiter.quote(params); await jupiter.quote(params); assert.equal(calls, 2);
  assert.throws(() => jupiter.assertFresh(structuredClone(q))); q.outAmount = '1'; assert.throws(() => jupiter.assertFresh(q));
  let now = NOW;
  const short = new JupiterClient(qcfg, log, undefined, async () => reply(quoteRaw()), () => now);
  const fresh = await short.quote(params); now += 15001; assert.throws(() => short.assertFresh(fresh));
});
test('roundtrip uses both slippage minima, capped fees and unrecovered account rent', () => {
  const buy = quoteRaw(); const sell = quoteRaw(MINT, SOL, '990000', '102000000', '100980000');
  const outcome = roundtripOutcome(buy, sell, 300000n, true);
  assert.equal(outcome.costs, 615320n); assert.equal(outcome.edgeLamports, 364680n);
  assert.ok(roundtripOutcome(buy, sell, 300000n, false).edgeLamports < 0n);
  assert.throws(() => roundtripOutcome(buy, { ...sell, inAmount: '1000000' }, 0n, true));
});
test('history separates modes, serializes bigint, redacts secrets and applies cutoff without executor', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sim = new MarketDataStore(dir, 'SIMULATION', log); const live = new MarketDataStore(dir, 'LIVE', log);
  sim.append('quote', 'jupiter', { amount: 18446744073709551615n, apiKey: 'secret', url: 'https://host/rpc?api-key=secret' }, NOW);
  sim.append('decision', 'test', { value: 2 }, NOW + 1); live.append('trade', 'test', { mode: 'live' }, NOW);
  await Promise.all([sim.flush(), live.flush()]);
  const records = []; for await (const row of replay(dir, 'SIMULATION', NOW)) records.push(row);
  assert.equal(records.length, 1); assert.equal((records[0]!.payload as any).amount, '18446744073709551615');
  assert.ok(!JSON.stringify(records).includes('secret')); assert.equal(records[0]!.mode, 'SIMULATION');
});
test('history retention bounds disk size and oversized records are counted', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new MarketDataStore(dir, 'SIMULATION', log, 1, 1024);
  for (let i = 0; i < 20; i++) store.append('observation', 'test', { i, value: 'x'.repeat(200) });
  store.append('oversize', 'test', 'x'.repeat(2000)); await store.flush();
  const files = await fs.readdir(dir); let bytes = 0; for (const file of files) bytes += (await fs.stat(path.join(dir, file))).size;
  assert.ok(bytes <= 1024); assert.equal(store.dropped, 1);
});
test('secrets and authenticated URL paths are removed from log payloads', () => {
  const out = JSON.stringify(redact({ privateKey: 'secret', Authorization: 'secret', nested: { rpc: 'https://user:secret@example.com/secret?api-key=secret' }, error: new Error('API_KEY=secret') }));
  assert.ok(!out.includes('secret')); assert.ok(out.includes('redacted'));
});

class TestStrategy extends BaseStrategy {
  name = 'test'; enabled = true; scanIntervalMs = 1; manageIntervalMs = 1;
  async scan() {} open(p: any) { return this.openPosition(p); }
}
test('risk manager remains authoritative; no swap after risk refusal or task cancellation', async () => {
  let checks = 0; let swaps = 0;
  const ctx: any = { logger: log, portfolio: { positions: () => [] }, risk: { canOpen: () => { checks++; return { ok: false, reason: 'limit' }; } },
    executor: { getSolBalanceLamports: async () => 1n, swap: async () => { swaps++; } } };
  const strategy = new TestStrategy(ctx); assert.equal(await strategy.open({ mint: MINT, symbol: 'test', sizeLamports: 1n }), null);
  assert.equal(checks, 1); assert.equal(swaps, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestScope.run({ category: 'discovery', signal: controller.signal }, () => strategy.open({ mint: MINT })));
});
test('missing quotes retain positions beyond the former writeoff threshold', async () => {
  let patch: any; let closes = 0;
  const strategy = new TestStrategy({ logger: log, cfg: { execution: {} }, jupiter: { quote: async () => { throw new Error('offline'); } },
    portfolio: { positionsFor: () => [{ id: 'p', mint: MINT, symbol: 't', tokenAmountRaw: 1n, valuationMisses: 40 }],
      updatePosition: (_id: string, p: any) => { patch = p; }, closePosition: () => { closes++; } } } as any);
  await strategy.manage(); assert.equal(patch.valuationMisses, 41); assert.equal(closes, 0);
});
test('Reversal manages executable-quote exits before unavailable discovery analytics', async () => {
  const order: string[] = []; const rs: any = new ReversalSniperStrategy({ logger: log, cfg: { rs: { smartMoneyWallets: [] } },
    portfolio: { positionsFor: () => [{ id: 'p', mint: MINT, valuationMisses: 1 }] }, dex: { getPairsForTokens: async () => { order.push('analytics'); throw new Error('offline'); } } } as any);
  rs.manageOpenPositions = async () => { order.push('exits'); };
  await rs.manage(); assert.deepEqual(order, ['exits', 'analytics']);
});
test('SUTR rent recovery proceeds while discovery is unavailable', async () => {
  let rent = 0; const sutr = new SuckUpTheRentStrategy({ logger: log, cfg: { sutr: { arbEnabled: true, lpSimEnabled: false, rentReclaimEnabled: true, rentReclaimIntervalMs: 1 } },
    risk: { isHalted: () => false }, portfolio: { positionsFor: () => [], positions: () => [] },
    gecko: { getTrendingPools: async () => { throw new Error('offline'); }, getNewPools: async () => { throw new Error('offline'); } },
    executor: { mode: 'SIMULATION', reclaimEmptyAccounts: async () => { rent++; return { found: 0 }; } } } as any);
  await sutr.scan(); assert.equal(rent, 1);
});
test('engine timeout cancels task and waits for settlement before rescheduling', async () => {
  const finished = deferred(); let signal: AbortSignal | undefined; let scheduled = 0;
  const engine: any = new Engine({ logger: log, tickTimeoutMs: 5 } as any); engine.schedule = () => { scheduled++; };
  const state = { runs: 0, consecutiveErrors: 0, lastDurationMs: 0, controller: null };
  const task = engine.runTask({ name: 'test', scanIntervalMs: 1, scan: async () => { signal = requestScope.getStore()?.signal; await finished.promise; } }, 'scan', state);
  await wait(15); assert.equal(signal?.aborted, true); assert.equal(scheduled, 0); finished.resolve(); await task; assert.equal(scheduled, 1); assert.equal(state.consecutiveErrors, 1);
});
test('on-chain token accounts require matching owner/mint and exact amounts before rent recovery', () => {
  const owner = new PublicKey(WALLET);
  const account: any = { pubkey: new PublicKey(POOL), account: { owner: TOKEN_PROGRAM_ID, lamports: 2039280,
    data: { parsed: { type: 'account', info: { owner: WALLET, mint: MINT, state: 'initialized', tokenAmount: { amount: '0' } } } } } };
  assert.equal(parseOwnedTokenAccount(account, owner, MINT).closable, true);
  assert.throws(() => parseOwnedTokenAccount(account, new PublicKey(POOL), MINT));
  assert.throws(() => parseOwnedTokenAccount(account, owner, SOL));
  account.account.data.parsed.info.extensions = [{ extension: 'transferFeeAmount', state: {} }];
  assert.equal(parseOwnedTokenAccount(account, owner).closable, false);
  account.account.data.parsed.info.tokenAmount.amount = '18446744073709551615';
  assert.equal(parseOwnedTokenAccount(account, owner).amountRaw, 18446744073709551615n);
});
test('Jupiter build rejects excessive priority fee and never posts a copied quote', async () => {
  let posts = 0;
  const client = new JupiterClient(qcfg, log, undefined, async (_url, init) => {
    if (init?.method === 'POST') { posts++; return reply({ swapTransaction: 'AA==', lastValidBlockHeight: 1000, prioritizationFeeLamports: 300001 }); }
    return reply(quoteRaw());
  });
  const q = await client.quote({ inputMint: SOL, outputMint: MINT, amountRaw: 100000000n, slippageBps: 100 });
  await assert.rejects(client.buildSwap(structuredClone(q), WALLET), /copied/); assert.equal(posts, 0);
  await assert.rejects(client.buildSwap(q, WALLET), /priority fee/); assert.equal(posts, 1);
});
test('confirmed live fill without transaction metadata remains unknown, never booked from quote', async () => {
  const owner = new PublicKey(WALLET);
  const executor: any = new LiveExecutor({ owner } as any, { publicKey: owner } as any, {} as any);
  executor.fetchTransaction = async () => null;
  await assert.rejects(executor.parseFill({ side: 'BUY', mint: MINT }, quoteRaw(), 'confirmed-signature', Date.now()),
    (e: any) => e.stage === 'unknown' && e.signature === 'confirmed-signature');
});
test('live executor does not build or send an invalid executable quote', async () => {
  let sent = 0; const owner = new PublicKey(WALLET);
  const client = new JupiterClient(qcfg, log, undefined, async () => reply({ ...quoteRaw(), inAmount: '1' }));
  const executor = new LiveExecutor({ owner, jupiter: client, cfg: { execution: { maxPriceImpactPct: 3 } } } as any,
    { publicKey: owner } as any, { sendAndConfirm: async () => { sent++; } } as any);
  await assert.rejects(executor.swap({ side: 'BUY', mint: MINT, amountRaw: 100000000n, slippageBps: 100 })); assert.equal(sent, 0);
});
test('analytical cache cannot serve execution-critical quotes', async () => {
  const data = new DataRuntime(log, settings); let requested = false;
  await assert.rejects(data.read('jupiter', 'quote', 'execution', async () => { requested = true; return {}; }, x => x), /bypass/);
  assert.equal(requested, false);
});
test('LP outage retains paper position without inventing current APR or a pool-gone sale', async () => {
  let updated: any; let closed = 0;
  const sutr: any = new SuckUpTheRentStrategy({ logger: log, cfg: { sutr: {} },
    raydium: { getPoolsByIds: async () => [] }, portfolio: { lpPositions: () => [{ id: 'p', poolId: POOL, missedUpdates: 20 }],
      updateLp: (_id: string, patch: any) => { updated = patch; }, closeLp: () => { closed++; } } } as any);
  await sutr.updateLpPositions(); assert.equal(updated.missedUpdates, 21); assert.equal(updated.accruedFeesLamports, undefined); assert.equal(closed, 0);
});

test('pair selection: a pool quoted in another token wins when it holds the real liquidity (COMMIE/AMC); token age comes from the oldest pool', async () => {
  const { selectPair, tokenTimes, pairMetrics } = await import('../src/desk/discovery');
  const { normalizeDexPairs } = await import('../src/data/dexscreener');
  const now = Date.now(), mint = 'So11111111111111111111111111111111111111112'.replace('So1', 'Co1');
  const raw = (pairAddress: string, quote: { address: string; symbol: string }, liq: number, created: number, dexId = 'raydium') => ({ chainId: 'solana', dexId, pairAddress,
    baseToken: { address: mint, symbol: 'COMMIE' }, quoteToken: quote, priceUsd: '0.0012', liquidity: { usd: liq }, marketCap: 1_200_000, pairCreatedAt: created });
  const SOL = { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, AMC = { address: 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc', symbol: 'AMC' };
  const pairs = normalizeDexPairs([raw('Cmcfrs6r6dsCyXvhooFbwvbvNDqe3vDHeXcKmfWGAzrr', AMC, 116_050, now - 60 * 60_000), raw('9j9UhKT8N27F3hZC1kjYMG6i9gL59qB3kdJM7hKozL6P', SOL, 5_874, now - 58 * 60_000, 'meteora')], now);
  assert.equal(selectPair(pairs, mint, now)!.quoteToken.symbol, 'AMC');
  const solDeep = normalizeDexPairs([raw('Cmcfrs6r6dsCyXvhooFbwvbvNDqe3vDHeXcKmfWGAzrr', AMC, 116_050, now), raw('9j9UhKT8N27F3hZC1kjYMG6i9gL59qB3kdJM7hKozL6P', SOL, 40_000, now, 'meteora')], now);
  assert.equal(selectPair(solDeep, mint, now)!.quoteToken.symbol, 'SOL', 'a SOL pool with a fair share of the liquidity is preferred');
  const thin = normalizeDexPairs([raw('Cmcfrs6r6dsCyXvhooFbwvbvNDqe3vDHeXcKmfWGAzrr', AMC, 9_000, now)], now);
  assert.equal(selectPair(thin, mint, now), null, 'a thin pool in an odd quote token is not a market');
  const t = tokenTimes(pairs, mint);
  assert.equal(t.createdAt, now - 60 * 60_000);
  const m = pairMetrics(selectPair(pairs, mint, now)!, now, t);
  assert.equal(Math.round(m.tokenAgeMin!), 60); assert.equal(m.quote, 'AMC');
});

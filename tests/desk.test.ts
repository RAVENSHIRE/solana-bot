import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadConfig } from '../src/config/schema';
import { DataRuntime, defaultDataSettings } from '../src/data/core/data-runtime';
import { DexScreenerClient, normalizeDexPairs } from '../src/data/dexscreener';
import { GeckoTerminalClient } from '../src/data/geckoterminal';
import { JupiterClient } from '../src/execution/jupiter-client';
import { TokenSafetyChecker } from '../src/analysis/token-safety';
import { SigningError, type TransactionSigner } from '../src/execution/transaction-signer';
import { Logger, configureLogger } from '../src/utils/logger';
import { acquireProcessLock } from '../src/utils/fs';
import { SOL_MINT, USDC_MINT } from '../src/core/types';
import { CRASH_DEFAULTS, DESK, deskCapital, strategyProfiles } from '../src/desk/config';
import { pairMetrics, selectPair, tierFor, type Discovered } from '../src/desk/discovery';
import { assessAuthenticity, checkWebsite, parseXLink, XClient, type WebsiteCheck } from '../src/desk/social';
import { analyze } from '../src/desk/analysis';
import { DeskLedger } from '../src/desk/ledger';
import { DeskEngine } from '../src/desk/engine';
import { crashCheck, exitReason, scaleAdvice, strategyStats } from '../src/desk/strategies';
import { replayExit, sizedReturn } from '../src/desk/replay';
import type { DeskEvent, LedgerEntry } from '../src/desk/types';

// Synthetic, deterministic fixtures only. No request leaves the process and nothing is signed or submitted.
configureLogger({ level: 'error', color: false });
const log = new Logger('desk-test');
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const owner = key(7), MINT = key(8).toBase58(), POOL = key(9).toBase58(), SOL_POOL = key(10).toBase58();
const NOW = Date.now();
const pairRaw = (patch: Record<string, unknown> = {}) => ({ chainId: 'solana', dexId: 'raydium', pairAddress: POOL,
  baseToken: { address: MINT, symbol: 'ABC', name: 'Alpha' }, quoteToken: { address: SOL_MINT, symbol: 'SOL' }, priceUsd: '0.0005',
  liquidity: { usd: 50_000 }, marketCap: 500_000, fdv: 500_000, pairCreatedAt: NOW - 2 * 86_400_000,
  priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, volume: { m5: 30_000, h1: 120_000, h6: 400_000, h24: 900_000 },
  txns: { m5: { buys: 300, sells: 150 }, h1: { buys: 2000, sells: 1500 } },
  info: { websites: [{ label: 'Website', url: 'https://alpha.example' }], socials: [{ type: 'twitter', url: 'https://x.com/alphaproj' }] }, ...patch });
const pair = (patch: Record<string, unknown> = {}) => normalizeDexPairs([pairRaw(patch)], Date.now())[0]!;
const found = (): Discovered => ({ mint: MINT, sources: ['top-boosts'], boostAmount: 100, description: 'Alpha', links: [], geckoPool: null });
const site: WebsiteCheck = { url: 'https://alpha.example', status: 'AVAILABLE', httpStatus: 200, title: 'Alpha', description: null, xHandles: ['alphaproj'], detail: 'HTTP 200' };

test('capital: planned $5.45 and $2.00 base entry are the defaults; reserve and drag stay the project values', () => {
  const c = deskCapital({});
  assert.equal(c.plannedStartingCapitalUsd, 5.45); assert.equal(c.baseEntryUsd, 2);
  assert.equal(DESK.reserveLamports, 3_000_000n); assert.equal(DESK.maxDragBps, 150n);
  assert.equal(deskCapital({ DESK_PLANNED_CAPITAL_USD: '7' }).plannedStartingCapitalUsd, 7);
  assert.throws(() => deskCapital({ DESK_BASE_ENTRY_USD: '6' }), /exceeds/);
  assert.throws(() => deskCapital({ DESK_SLIPPAGE_BPS: '150' }));
});

test('tiers: ultra-early $2K–$10K, bonding curve monitored to $100K, trending below $1M, everything else filtered with a reason', () => {
  const m = (cap: number, dexId = 'raydium') => pairMetrics(pair({ marketCap: cap, dexId }), NOW);
  assert.deepEqual(tierFor(m(5_000)), { tier: 'ULTRA_EARLY' });
  assert.deepEqual(tierFor(m(60_000, 'pumpfun')), { tier: 'ULTRA_EARLY' });
  assert.match((tierFor(m(150_000, 'pumpfun')) as { filtered: string }).filtered, /Bonding curve above/);
  assert.deepEqual(tierFor(m(60_000)), { tier: 'TRENDING' });
  assert.match((tierFor(m(1_500_000)) as { filtered: string }).filtered, /≥ \$1M/);
  assert.match((tierFor(m(1_000)) as { filtered: string }).filtered, /< \$2000/);
  const metrics = pairMetrics(pair({ txns: { m5: { buys: 5, sells: 0 } } }), NOW);
  assert.equal(metrics.buySellRatio5m, null, 'zero sells is undefined, never infinite');
  assert.equal(pairMetrics(pair(), NOW).volumeAcceleration, 3);
  const curve = normalizeDexPairs([pairRaw({ dexId: 'pumpfun', liquidity: null, pairAddress: SOL_POOL })], Date.now());
  assert.equal(selectPair([...curve, pair()], MINT, Date.now())?.pairAddress, POOL, 'deepest liquidity wins over a bonding curve');
  assert.equal(selectPair(curve, MINT, Date.now())?.dexId, 'pumpfun');
});

test('X links: accounts, posts and communities are kept distinct', () => {
  assert.deepEqual(parseXLink('https://x.com/alphaproj'), { kind: 'ACCOUNT', handle: 'alphaproj', url: 'https://x.com/alphaproj' });
  assert.equal(parseXLink('https://x.com/someone/status/123?s=46').kind, 'POST');
  assert.equal(parseXLink('https://x.com/i/communities/2015156261436768350').kind, 'COMMUNITY');
  assert.equal(parseXLink('https://evil.example/x.com/alpha').kind, 'NONE');
});

test('authenticity: an old account is flagged, never rewarded; unknown stays UNVERIFIED', () => {
  const link = parseXLink('https://x.com/alphaproj');
  const recent = Array.from({ length: 10 }, (_, i) => ({ at: NOW - i * 3_600_000, engagement: 50 }));
  const account = (createdAt: number, followers = 2_000) => ({ handle: 'alphaproj', createdAt, followers, following: 10, posts: 500,
    profileUrl: 'https://alpha.example', description: '', recent });
  const project = NOW - 2 * 86_400_000;
  assert.equal(assessAuthenticity({ link, account: null, xApiConfigured: false, projectStartedAt: project, website: site, now: NOW }).authenticity, 'UNVERIFIED');
  const old = assessAuthenticity({ link, account: account(Date.parse('2015-03-01')), xApiConfigured: true, projectStartedAt: project, website: site, now: NOW });
  assert.equal(old.authenticity, 'UNCERTAIN'); assert.match(old.flags[0]!, /SOCIAL AGE MISMATCH: X account 2015/);
  const bought = assessAuthenticity({ link, account: { ...account(Date.parse('2015-03-01'), 80_000), recent: recent.map(r => ({ ...r, engagement: 1 })) },
    xApiConfigured: true, projectStartedAt: project, website: site, now: NOW });
  assert.equal(bought.authenticity, 'SUSPICIOUS');
  assert.equal(assessAuthenticity({ link, account: account(NOW - 5 * 86_400_000), xApiConfigured: true, projectStartedAt: project, website: site, now: NOW }).authenticity, 'VERIFIED');
});

test('website checks refuse http, private addresses and redirects into the local network', async () => {
  const ok: typeof fetch = async () => new Response('<title>Alpha</title><a href="https://x.com/alphaproj">x</a>', { status: 200 });
  const pub = async () => ['93.184.216.34'];
  assert.equal((await checkWebsite('http://alpha.example', ok, pub)).status, 'BLOCKED');
  assert.equal((await checkWebsite('https://localhost', ok, pub)).status, 'BLOCKED');
  assert.equal((await checkWebsite('https://alpha.example', ok, async () => ['10.0.0.2'])).status, 'BLOCKED');
  const good = await checkWebsite('https://alpha.example', ok, pub);
  assert.equal(good.status, 'AVAILABLE'); assert.equal(good.title, 'Alpha'); assert.deepEqual(good.xHandles, ['alphaproj']);
  let hops = 0;
  const redirect: typeof fetch = async () => (hops++ ? new Response('', { status: 200 }) : new Response('', { status: 302, headers: { location: 'https://internal.lan/admin' } }));
  assert.equal((await checkWebsite('https://alpha.example', redirect, pub)).status, 'BLOCKED');
});

test('gates show actual vs required; ultra-early tokens are discovered, never auto-qualified', () => {
  const watch = { firstSeenAt: NOW, observations: 1, lastLiquidityUsd: 50_000, lastPriceUsd: null, momentumStreak: 1 };
  const onchain = { safety: { mint: MINT, status: 'verified' as const, meta: normalizeDexPairs([pairRaw()], NOW)[0]!.meta, ok: true, decimals: 6, isToken2022: false,
    hasMintAuthority: false, hasFreezeAuthority: false, reasons: [], warnings: [] },
    holders: { supplyRaw: 10n ** 15n, decimals: 6, walletTop10Pct: 20, largestWalletPct: 2, programOwnedPct: 30, accountsInspected: 20 }, developer: null, flow: null, errors: {} };
  const launch = { launchedAt: NOW - 2 * 86_400_000, poolsChecked: 1, curvePool: null, migratedAfterSec: null, earlyHighMcUsd: 20_000, firstCandleMultiple: 1.2, windowMin: 5 };
  const base = { found: found(), pair: pair(), tier: 'TRENDING' as const, onchain, onchainAt: NOW, social: null, watch, now: NOW, maxWashRatio: 0.45, launch };
  const qualified = analyze({ ...base, metrics: pairMetrics(base.pair, NOW) });
  assert.equal(qualified.status, 'QUALIFIED'); assert.equal(qualified.momentumStreak, 2);
  const thin = pair({ volume: { m5: 8_200, h1: 120_000 } });
  const filtered = analyze({ ...base, pair: thin, metrics: pairMetrics(thin, NOW) });
  assert.equal(filtered.status, 'FILTERED'); assert.match(filtered.reasons[0]!, /^5m volume: \$8,200 \(> \$15,000\)$/);
  const unknown = analyze({ ...base, onchain: null, metrics: pairMetrics(base.pair, NOW) });
  assert.equal(unknown.status, 'WATCHLIST'); assert.match(unknown.reasons.join(), /Evidence missing: Mint authority revoked/);
  assert.equal(unknown.evidence.find(e => e.key === 'top10')!.display, 'UNKNOWN');
  assert.equal(unknown.evidence.find(e => e.key === 'utility')!.display, 'UNVERIFIED');
  const early = analyze({ ...base, tier: 'ULTRA_EARLY', metrics: pairMetrics(base.pair, NOW) });
  assert.equal(early.status, 'WATCHLIST'); assert.notEqual(early.classification, 'QUALIFIED');
  const fresh = analyze({ ...base, watch: { ...watch, momentumStreak: 0 }, metrics: pairMetrics(base.pair, NOW) });
  assert.equal(fresh.status, 'WAITING'); assert.match(fresh.reasons[0]!, /Momentum confirmed in 1\/2/);
  const insider = analyze({ ...base, launch: { ...launch, curvePool: POOL, migratedAfterSec: 0, earlyHighMcUsd: 446_271, firstCandleMultiple: 9 }, metrics: pairMetrics(base.pair, NOW) });
  assert.equal(insider.status, 'FILTERED');
  assert.match(insider.gates.find(g => g.key === 'fairLaunch')!.actual, /graduated 0 s after launch.*\$446,271 within first 5 min/);
  assert.equal(analyze({ ...base, launch: null, metrics: pairMetrics(base.pair, NOW) }).status, 'WATCHLIST', 'unknown launch history never qualifies');
  const curvePair = pair({ dexId: 'pumpfun', liquidity: null, marketCap: 6_000 });
  const curve = analyze({ ...base, tier: 'ULTRA_EARLY', pair: curvePair, metrics: pairMetrics(curvePair, NOW) });
  assert.equal(curve.gates.find(g => g.key === 'liquidity')!.actual, 'bonding curve — no AMM pool yet');
  assert.equal(qualified.scores.map(s => s.key).join(), 'FUNDAMENTAL,SOCIAL,MARKET,ONCHAIN,RISK,MOMENTUM');
});

test('ledger: TEST PnL books both network fees once; LIVE needs a signature; modes never share a file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-ledger-'));
  try {
    const paper = await DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'PAPER', null, NOW);
    paper.fundPaper(5.45, 100); assert.equal(paper.state.paperCashLamports, '54500000');
    const base = { mint: MINT, symbol: 'ABC', decimals: 6, pairAddress: POOL, router: 'Jupiter', route: 'Raydium', routerFeeUsd: null, txSignature: null, solUsd: 100, note: null };
    paper.book({ ...base, side: 'BUY', inAmountRaw: 20_000_000n, outAmountRaw: 4_000_000_000n, solDeltaLamports: -22_044_580n, feeLamports: 5_300n, rentLamports: 2_039_280n, at: NOW });
    const sell = paper.book({ ...base, side: 'SELL', inAmountRaw: 4_000_000_000n, outAmountRaw: 28_000_000n, solDeltaLamports: 27_994_700n, feeLamports: 5_300n, rentLamports: 0n, at: NOW + 1 });
    assert.ok(Math.abs(sell.grossPnlUsd! - 0.8) < 1e-9); assert.ok(Math.abs(sell.netPnlUsd! - (0.8 - 0.00106)) < 1e-9);
    assert.equal(paper.state.positions.length, 0); assert.equal(paper.state.paperCashLamports, String(54_500_000n - 20_000_000n - 5_300n - 2_039_280n + 27_994_700n));
    await paper.save();
    const live = await DeskLedger.open(path.join(dir, 'ledger-LIVE-x.json'), 'LIVE', owner.toBase58(), NOW);
    assert.throws(() => live.book({ ...base, side: 'BUY', inAmountRaw: 1n, outAmountRaw: 1n, solDeltaLamports: -1n, feeLamports: 0n, rentLamports: 0n, at: NOW }), /LIVE_FILL_WITHOUT_SIGNATURE/);
    await assert.rejects(DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'LIVE', owner.toBase58(), NOW), /LEDGER_IDENTITY_MISMATCH/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('process lock: a crashed owner is recovered; a live or unreadable owner still blocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-lock-')), lock = path.join(dir, 'desk.lock');
  try {
    const child = spawn(process.execPath, ['-e', '']); await new Promise(r => child.once('exit', r));
    await fs.writeFile(lock, String(child.pid));
    const handle = await acquireProcessLock(lock); assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await handle.close(); await fs.unlink(lock);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
    try { await fs.writeFile(lock, String(sleeper.pid)); await assert.rejects(acquireProcessLock(lock), /EEXIST/); } finally { sleeper.kill(); }
    await fs.writeFile(lock, ''); await assert.rejects(acquireProcessLock(lock), /EEXIST/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- full pipeline against a simulated network

interface Token { mint: string; symbol: string; pool: string; curve: string; patch: Record<string, unknown>; launch: 'fair' | 'insider' }
function world(patch: Record<string, unknown> = {}, launch: 'fair' | 'insider' = 'fair', more: Array<Omit<Token, 'curve'>> = []) {
  const tokens: Token[] = [{ mint: MINT, symbol: 'ABC', pool: POOL, curve: SOL_POOL, patch, launch }, ...more.map((t, i) => ({ ...t, curve: key(200 + i).toBase58() }))];
  const w = { priceFactor: 1, extraRent: 0, liquidity: 50_000, native: 45_000_000, sends: 0, signRequests: 0,
    last: null as null | { side: 'BUY' | 'SELL'; mint: string; inAmount: bigint; outAmount: bigint } };
  const holderMint = new Map<string, string>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const solPair = { chainId: 'solana', dexId: 'orca', pairAddress: SOL_POOL, baseToken: { address: SOL_MINT, symbol: 'SOL' }, quoteToken: { address: USDC_MINT, symbol: 'USDC' },
    priceUsd: '100', liquidity: { usd: 10_000_000 }, marketCap: 5e10, fdv: 6e10, pairCreatedAt: NOW - 1e10, txns: { h1: { buys: 5, sells: 5 } } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.dexscreener.com') {
      if (url.pathname.startsWith('/token-')) return json(tokens.map(t => ({ chainId: 'solana', tokenAddress: t.mint, description: 'Alpha does things', totalAmount: 100,
        links: [{ type: 'twitter', url: 'https://x.com/alphaproj' }, { label: 'Website', url: 'https://alpha.example' }] })));
      const mints = url.pathname.split('/').pop()!.split(',');
      return json([...(mints.includes(SOL_MINT) ? [solPair] : []), ...tokens.filter(t => mints.includes(t.mint)).map(t => pairRaw({ pairCreatedAt: NOW - 2 * 86_400_000,
        liquidity: { usd: w.liquidity }, pairAddress: t.pool, baseToken: { address: t.mint, symbol: t.symbol, name: t.symbol }, ...t.patch }))]);
    }
    if (url.hostname === 'api.geckoterminal.com') {
      const created = Math.floor((NOW - 2 * 86_400_000) / 60_000) * 60;
      const geckoPool = (address: string, dex: string, mint: string) => ({ id: `solana_${address}`, attributes: { address, name: 'ABC / SOL', base_token_price_usd: '0.0005',
        reserve_in_usd: '50000', market_cap_usd: null, fdv_usd: '500000', pool_created_at: new Date(created * 1000).toISOString(), volume_usd: { h1: '1000', h24: '9000' } },
        relationships: { base_token: { data: { id: `solana_${mint}` } }, quote_token: { data: { id: `solana_${SOL_MINT}` } }, dex: { data: { id: dex } } } });
      const token = tokens.find(t => url.pathname.endsWith(`/tokens/${t.mint}/pools`));
      if (token) return json({ data: token.launch === 'fair' ? [geckoPool(token.pool, 'raydium', token.mint)]
        : [geckoPool(token.curve, 'pump-fun', token.mint), geckoPool(token.pool, 'pumpswap', token.mint)] });
      if (url.pathname.includes('/ohlcv/minute')) {
        const of = tokens.find(t => url.pathname.includes(`/pools/${t.pool}/`) || url.pathname.includes(`/pools/${t.curve}/`));
        const top = of?.launch !== 'insider' ? 0.00002 : 0.00045;
        return json({ data: { attributes: { ohlcv_list: [[created, 0.00001, top, 0.00001, top, 5000], [created + 60, top, top, top, top, 900]] } } });
      }
      // No recorded trades (an empty list, as the API returns): trade flow stays UNKNOWN without tripping the provider cooldown.
      return json({ data: [] });
    }
    if (url.pathname.endsWith('/quote')) {
      const inputMint = url.searchParams.get('inputMint')!, outputMint = url.searchParams.get('outputMint')!, amount = BigInt(url.searchParams.get('amount')!);
      const slip = Number(url.searchParams.get('slippageBps')), buy = inputMint === SOL_MINT;
      const out = buy ? amount * 200n : amount * BigInt(Math.round(w.priceFactor * 1000)) / 200_000n;
      const q = { inputMint, outputMint, inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(out * BigInt(10_000 - slip) / 10_000n),
        swapMode: 'ExactIn', slippageBps: slip, priceImpactPct: '0.001', contextSlot: 1, timeTaken: 0.01,
        routePlan: [{ percent: 100, swapInfo: { ammKey: POOL, label: 'Raydium', inputMint, outputMint, inAmount: String(amount), outAmount: String(out), feeAmount: '0', feeMint: SOL_MINT } }] };
      return json(q);
    }
    if (url.pathname.endsWith('/swap')) {
      const body = JSON.parse(String(init!.body));
      const q = body.quoteResponse as { inputMint: string; inAmount: string; outAmount: string };
      const q2 = body.quoteResponse as { outputMint: string };
      w.last = { side: q.inputMint === SOL_MINT ? 'BUY' : 'SELL', mint: q.inputMint === SOL_MINT ? q2.outputMint : q.inputMint, inAmount: BigInt(q.inAmount), outAmount: BigInt(q.outAmount) };
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(body.userPublicKey), recentBlockhash: SystemProgram.programId.toBase58(), instructions: [] }).compileToV0Message());
      return json({ swapTransaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 100, prioritizationFeeLamports: 0, computeUnitLimit: 200_000 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('pool')], TOKEN_PROGRAM_ID)[0];
  const conn = {
    getBalance: async () => w.native,
    getTokenSupply: async () => ({ value: { amount: '1000000000000000', decimals: 6 } }),
    getTokenLargestAccounts: async (mint: PublicKey) => {
      const base = 40 + 11 * Math.max(0, tokens.findIndex(t => t.mint === mint.toBase58()));
      const rows = [{ address: key(base), amount: '300000000000000' }, ...Array.from({ length: 10 }, (_, i) => ({ address: key(base + 1 + i), amount: '20000000000000' }))];
      for (const r of rows) holderMint.set(r.address.toBase58(), mint.toBase58());
      return { value: rows };
    },
    getMultipleParsedAccounts: async (keys: PublicKey[]) => ({ value: keys.map((k, i) => ({ data: { parsed: { info: { owner: (i === 0 ? offCurve : key(150 + i)).toBase58(),
      mint: holderMint.get(k.toBase58()) ?? MINT } } } })) }),
    getParsedAccountInfo: async () => ({ value: { owner: TOKEN_PROGRAM_ID, data: { program: 'spl-token', parsed: { type: 'mint',
      info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true } } } } }),
    getAccountInfo: async () => null,
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 1000 }],
    getFeeForMessage: async () => ({ value: 5_300 }),
    getMultipleAccountsInfo: async () => [],
    simulateTransaction: async (_tx: unknown, config?: { accounts?: unknown }) => {
      if (!config?.accounts) return { value: { err: null, logs: [] } };
      // The wallet never holds TEST tokens, so a paper exit cannot simulate — exactly like the real chain.
      if (w.last?.side !== 'BUY') return { value: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ['insufficient funds'], accounts: null } };
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({ mint: new PublicKey(w.last.mint), owner, amount: w.last.outAmount, delegateOption: 0, delegate: SystemProgram.programId, state: 1,
        isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: SystemProgram.programId }, data);
      return { value: { err: null, logs: [], accounts: [
        { owner: SystemProgram.programId.toBase58(), lamports: w.native - Number(w.last.inAmount) - 5_300 - 2_039_280 - w.extraRent, data: ['', 'base64'], executable: false },
        { owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 2_039_280, data: [data.toString('base64'), 'base64'], executable: false }] } };
    },
  };
  const rpc = { execute: async (_label: string, fn: (c: typeof conn) => unknown) => fn(conn) };
  const cfg = loadConfig({ RPC_ENDPOINTS: 'https://rpc.example.invalid', JUPITER_API_KEY: 'synthetic-test-key', SIMULATION_MODE: 'true', JUPITER_MAX_RPS: '100' }, 'PHANTOM');
  const data = new DataRuntime(log, { ...defaultDataSettings, dexRps: 100, geckoRps: 100, cacheEnabled: false }, undefined, fetcher);
  const shared = { cfg, capital: deskCapital({}), logger: log, rpc: rpc as never, jupiter: new JupiterClient(cfg.jupiter, log, data, fetcher),
    dex: new DexScreenerClient(log, data), gecko: new GeckoTerminalClient(log, data), safety: new TokenSafetyChecker(rpc as never, log),
    x: new XClient(null), authorized: () => true, website: async () => site };
  return { w, shared };
}

const stages = (events: DeskEvent[]) => events.map(e => e.stage);

test('TEST runs the full production path — discovery to realized PnL — and never requests a signature or submits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-paper-')), { w, shared } = world();
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start();
    await engine.pulse();
    let view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.candidates[0]!.status, 'WAITING', 'first confirming scan only');
    assert.equal(view.capital.plannedStartingCapitalUsd, 5.45); assert.equal(view.capital.baseEntryUsd, 2);
    await engine.pulse();
    view = engine.status({ connected: true, address: owner.toBase58() });
    const order = stages(engine.events.list()).slice(stages(engine.events.list()).indexOf('QUOTE'));
    for (const s of ['QUOTE', 'ROUTE', 'SIMULATION', 'PREFLIGHT', 'SUBMITTED', 'POSITION']) assert.ok(order.includes(s as never), `missing ${s}`);
    assert.ok(!stages(engine.events.list()).includes('AWAITING_SIGNATURE')); assert.ok(!stages(engine.events.list()).includes('CONFIRMED'));
    const pre = view.preflights[0]!;
    assert.equal(pre.signature, 'NOT_REQUESTED_TEST'); assert.equal(pre.outcome, 'PAPER_FILLED'); assert.equal(pre.simulation.status, 'PASSED');
    assert.equal(pre.route, 'Raydium'); assert.equal(pre.entrySizeUsd, 2); assert.equal(pre.accountRentLamports, '2039280');
    assert.equal(view.positions.length, 1); assert.equal(view.positions[0]!.qtyRaw, '4000000000');
    assert.equal(view.ledger[0]!.status, 'PAPER_FILLED'); assert.equal(view.ledger[0]!.txSignature, null);
    w.priceFactor = 1.4;
    await engine.pulse();
    view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.positions.length, 0, 'take-profit exit closed the TEST position');
    assert.ok(engine.events.list().some(e => e.stage === 'SIMULATION' && /NOT POSSIBLE/.test(e.message)));
    assert.ok(engine.events.list().some(e => e.stage === 'EXIT' && /TAKE_PROFIT/.test(e.message)));
    assert.ok(engine.events.list().some(e => e.stage === 'PNL'));
    const sell = view.ledger[0]!;
    assert.equal(sell.side, 'SELL'); assert.ok(Math.abs(sell.grossPnlUsd! - 0.8) < 1e-6); assert.ok(sell.netPnlUsd! < sell.grossPnlUsd!);
    assert.ok(view.capital.realizedPnlUsd > 0.79 && view.capital.realizedPnlUsd < 0.8);
    assert.equal(w.sends, 0);
    assert.equal(view.ledger.filter(e => e.side === 'BUY').length, 1, 'no immediate re-entry after exit');
    engine.stop(); await engine.persist();
    const reopened = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(reopened.status({ connected: false, address: null }).ledger.length, 2, 'ledger survives a restart');
    assert.ok(reopened.events.list().length > 10, 'telemetry survives a restart');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('TEST probe runs the real pre-flight path, books nothing, and is refused in LIVE', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-probe-')), { w, shared } = world();
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse(); engine.stop();
    await engine.probe(MINT);
    const view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.preflights[0]!.outcome, 'PROBE_NOT_BOOKED'); assert.equal(view.preflights[0]!.simulation.status, 'PASSED');
    assert.equal(view.ledger.length, 0); assert.equal(view.positions.length, 0); assert.equal(w.sends, 0);
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    await assert.rejects(live.probe(MINT), /PROBE_TEST_ONLY/);
    assert.equal(live.strategies.CRASH.enabled, false, 'LIVE starts every session with CRASH off');
    await assert.rejects(live.resetTest(), /RESET_TEST_ONLY/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('TEST drill opens a marked paper position when nothing qualifies; without drill nothing is entered', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-drill-')), { shared } = world({ priceChange: { m5: -5, h1: 5 } });
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse(); await engine.pulse();
    let view = engine.status({ connected: false, address: null });
    assert.equal(view.candidates[0]!.status, 'WAITING'); assert.equal(view.positions.length, 0);
    engine.drill = true; await engine.pulse();
    view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 1); assert.match(view.ledger[0]!.note!, /^DRILL — strategy gates bypassed/);
    assert.equal(view.wallet.source, 'CONFIGURED'); assert.equal(view.wallet.address, owner.toBase58());
    assert.equal(view.preflights[0]!.signature, 'NOT_REQUESTED_TEST');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('venue account rent within the reserved budget passes and is booked; beyond it the simulation is rejected', async () => {
  for (const [extra, fills] of [[1_300_000, true], [3_000_000, false]] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-rent-')), { w, shared } = world();
    try {
      w.extraRent = extra;
      const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
      engine.start(); await engine.pulse(); await engine.pulse();
      const view = engine.status({ connected: true, address: owner.toBase58() });
      assert.equal(view.positions.length, fills ? 1 : 0);
      if (fills) assert.equal(view.ledger[0]!.solDeltaLamports, String(-(20_000_000 + 5_300 + 2_039_280 + extra)));
      else assert.ok(engine.events.list().some(e => /SIMULATED_BUY_MISMATCH/.test(e.message)));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('an insider launch (instant graduation, $446K first candles) is never entered, not even by the drill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-insider-')), { shared } = world({}, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); engine.drill = true; await engine.pulse(); await engine.pulse(); await engine.pulse();
    const view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.candidates[0]!.status, 'FILTERED'); assert.equal(view.positions.length, 0);
    assert.ok(engine.events.list().some(e => e.stage === 'FILTERED' && /Fair launch: graduated 0 s after launch/.test(e.message)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('exits are never blocked by TEST cash, and a liquidity collapse exits before the stop-loss', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-exit-')), { w, shared } = world();
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse(); await engine.pulse();
    assert.equal(engine.status({ connected: true, address: owner.toBase58() }).positions.length, 1);
    // Drain TEST cash below zero: the exit must still go through.
    const ledgerFile = path.join(dir, 'ledger-PAPER.json');
    await engine.persist();
    const state = JSON.parse(await fs.readFile(ledgerFile, 'utf8')); state.paperCashLamports = '-1';
    (engine as unknown as { ledgers: Map<string, { state: unknown }> }).ledgers.get('PAPER')!.state = state;
    w.liquidity = 20_000; // -60% since entry; price unchanged, so no stop-loss yet
    await engine.pulse();
    const view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.positions.length, 0);
    assert.ok(engine.events.list().some(e => e.stage === 'EXIT' && /LIQUIDITY_DROP \$20,000 vs \$50,000/.test(e.message)));
    assert.ok(!engine.events.list().some(e => /TEST_CAPITAL_INSUFFICIENT/.test(e.message)));
    assert.equal(view.ledger[0]!.side, 'SELL');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('LIVE reaches pre-flight and the Phantom signature request, and nothing is submitted without a signature', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-live-')), { w, shared } = world();
  try {
    const signer: TransactionSigner = { publicKey: owner, signTransaction: async () => { w.signRequests++; throw new SigningError('WALLET_SIGNATURE_REJECTED'); } };
    const sender = { sendAndConfirm: async () => { w.sends++; throw new Error('must not send'); } };
    const engine = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: sender as never, wallet: () => ({ owner, signer }) });
    engine.start();
    await engine.pulse(); await engine.pulse();
    const events = stages(engine.events.list());
    const at = (s: string) => events.indexOf(s as never);
    assert.ok(at('PREFLIGHT') >= 0 && at('AWAITING_SIGNATURE') > at('PREFLIGHT'), 'signature is requested only after pre-flight');
    assert.equal(w.signRequests, 1); assert.equal(w.sends, 0);
    const view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.preflights[0]!.signature, 'REJECTED'); assert.equal(view.preflights[0]!.outcome, 'BLOCKED');
    assert.equal(view.execution, false, 'a rejected signature pauses execution'); assert.equal(view.halted, null);
    assert.equal(view.positions.length, 0); assert.equal(view.ledger.length, 0, 'no fabricated LIVE entry');
    assert.match(engine.events.list().find(e => e.stage === 'FAILED')!.message, /blocked at Phantom signature: Phantom: WALLET_SIGNATURE_REJECTED/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- CRASH strategy and parallel strategies

const YOUNG_PUMP = { pairCreatedAt: NOW - 10 * 60_000, priceChange: { m5: 25, h1: 40 }, volume: { m5: 25_000, h1: 50_000 } };
const tokenKey = (n: number) => key(n).toBase58();

test('CRASH rules: +100% take profit, profit lock after a +40% peak, 4-minute time stop, stop loss; FAIR keeps its trailing stop', () => {
  const p = strategyProfiles({}, deskCapital({}), { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 });
  const c = p.CRASH.exits, f = p.FAIR.exits;
  assert.equal(p.CRASH.entryUsd, 2); assert.equal(p.CRASH.capitalUsd, CRASH_DEFAULTS.capitalUsd); assert.equal(p.CRASH.maxDragBps, 500n);
  const x = (pnlPct: number, peakPct = pnlPct, heldMs = 60_000, fromPeakPct = 0) => ({ pnlPct, peakPct, fromPeakPct, heldMs });
  assert.match(exitReason(c, x(101))!, /^TAKE_PROFIT/, '+100% = $2 unrealized on $2');
  assert.equal(exitReason(c, x(35, 38)), null, 'below the +40% lock, a pullback is held');
  assert.match(exitReason(c, x(30, 46))!, /^PROFIT_LOCK \+30\.00% after a \+46\.00% peak/);
  assert.equal(exitReason(c, x(33, 46)), null);
  assert.match(exitReason(c, x(5, 5, 4 * 60_000))!, /^MAX_HOLD 4 min/);
  assert.match(exitReason(c, x(-15.5))!, /^STOP_LOSS/);
  assert.match(exitReason(f, x(10, 20, 60_000, -9))!, /^TRAILING_STOP/);
  assert.equal(exitReason(f, x(101)) !== null && exitReason(f, x(29)) === null, true);
  assert.throws(() => strategyProfiles({ CRASH_SLIPPAGE_BPS: '500' }, deskCapital({}), { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 }), /below CRASH_MAX_DRAG_BPS/);
  assert.equal(strategyProfiles({ CRASH_ENABLED: 'false' }, deskCapital({}), { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 0, maxHoldMin: 60 }).FAIR.exits.trailing, null);
});

test('CRASH entry check: a young pump with passing safety signals without a fair launch; an old pool or active mint authority never does', () => {
  const watch = { firstSeenAt: NOW, observations: 0, lastLiquidityUsd: null, lastPriceUsd: null, momentumStreak: 0 };
  const safety = { mint: MINT, status: 'verified' as const, meta: normalizeDexPairs([pairRaw()], NOW)[0]!.meta, ok: true, decimals: 6, isToken2022: false,
    hasMintAuthority: false, hasFreezeAuthority: false, reasons: [], warnings: [] };
  const onchain = { safety, holders: { supplyRaw: 10n ** 15n, decimals: 6, walletTop10Pct: 20, largestWalletPct: 2, programOwnedPct: 30, accountsInspected: 20 }, developer: null, flow: null, errors: {} };
  const insider = { launchedAt: NOW - 600_000, poolsChecked: 2, curvePool: SOL_POOL, migratedAfterSec: 0, earlyHighMcUsd: 617_026, firstCandleMultiple: 9, windowMin: 5 };
  const run = (patch: Record<string, unknown>, o: typeof onchain = onchain) => {
    const p = pair(patch);
    return crashCheck(analyze({ found: found(), pair: p, metrics: pairMetrics(p, NOW), tier: 'TRENDING', onchain: o, onchainAt: NOW, social: null, watch, now: NOW, maxWashRatio: 0.45, launch: insider }));
  };
  const young = run(YOUNG_PUMP);
  assert.equal(young.signal, true, young.summary); assert.match(young.summary, /^25\.0% in 5m · pool 10 min/);
  assert.equal(young.checks.find(g => g.key === 'fairLaunch')!.status, 'FAIL', 'the insider launch is shown…');
  assert.equal(young.checks.find(g => g.key === 'fairLaunch')!.blocking, false, '…but never required for CRASH');
  assert.match(run({ ...YOUNG_PUMP, pairCreatedAt: NOW - 3 * 3_600_000 }).summary, /^Pool age: 180 min/);
  assert.match(run({ ...YOUNG_PUMP, priceChange: { m5: 350 } }).summary, /^5m price change: 350\.0%/, 'a vertical candle is not chased');
  assert.equal(run(YOUNG_PUMP, { ...onchain, safety: { ...safety, hasMintAuthority: true } }).signal, false);
  assert.equal(run(YOUNG_PUMP, { ...onchain, safety: null } as never).signal, false, 'unknown safety never signals');
});

test('strategy stats pair each exit with its entry, exclude drill trades, and scale readiness stays advisory', () => {
  const row = (side: 'BUY' | 'SELL', at: number, mint: string, net: number | null, note: string | null = null): LedgerEntry => ({ id: `${at}`, at, mode: 'PAPER', txSignature: null,
    mint, symbol: 'X', router: 'Jupiter', route: 'r', side, quantity: '1000', qtyRaw: '1000000000', entryPriceUsd: 0.002, exitPriceUsd: null, grossPnlUsd: net,
    networkFeeLamports: '5000', networkFeeUsd: 0, routerFeeUsd: 0, totalFeesUsd: 0, netPnlUsd: net, solDeltaLamports: '0', status: 'PAPER_FILLED', note });
  const s = strategyStats([row('BUY', 0, 'a', null), row('SELL', 90_000, 'a', 2), row('BUY', 100_000, 'b', null), row('SELL', 160_000, 'b', -0.3),
    row('BUY', 200_000, 'c', null, 'DRILL — x'), row('SELL', 210_000, 'c', 5, 'DRILL — x')]);
  assert.equal(s.trades, 2); assert.equal(s.drillTrades, 1); assert.equal(s.wins, 1); assert.equal(s.winRatePct, 50);
  assert.ok(Math.abs(s.netPnlUsd - 1.7) < 1e-9); assert.equal(s.bestReturnPct, 100); assert.equal(s.avgHoldSec, 75); assert.ok(Math.abs(s.profitFactor! - 2 / 0.3) < 1e-9);
  const p = strategyProfiles({}, deskCapital({}), { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 }).CRASH;
  const advice = scaleAdvice(p, s, 'PAPER');
  assert.equal(advice.nextEntryUsd, 10); assert.equal(advice.ready, false); assert.match(advice.checks[0]!.actual, /^2$/);
  assert.equal(scaleAdvice(p, { ...s, trades: 25, losses: 5, profitFactor: 2 }, 'LIVE').ready, true);
  assert.equal(scaleAdvice({ ...p, entryUsd: 100 }, s, 'LIVE').nextMinLiquidityUsd, 50_000);
});

test('CRASH enters a young pump in its first scan (no fair launch needed), exits at +100% on the fast position loop, and TEST can be reset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-crash-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.setStrategy('CRASH', false); engine.start(); await engine.pulse();
    assert.equal(engine.status({ connected: true, address: owner.toBase58() }).positions.length, 0, 'a disabled strategy never enters');
    engine.setStrategy('CRASH', true); await engine.pulse();
    let view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.positions.length, 1); assert.equal(view.positions[0]!.strategy, 'CRASH');
    assert.equal(view.candidates[0]!.status, 'FILTERED', 'FAIR rejects the insider launch'); assert.equal(view.candidates[0]!.crash!.signal, true);
    assert.equal(view.preflights[0]!.slippageBps, 250); assert.equal(view.ledger[0]!.strategy, 'CRASH');
    const crash = view.strategies.find(s => s.id === 'CRASH')!;
    assert.equal(crash.openPositions, 1); assert.ok(Math.abs(crash.cashUsd! - (10 - 2.00053 - 0.2039280)) < 1e-3, `sleeve ${crash.cashUsd}`);
    assert.equal(view.strategies.find(s => s.id === 'FAIR')!.cashUsd, 5.45, 'FAIR sleeve untouched');
    w.priceFactor = 2.05;
    (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0;
    engine.tick(); await engine.settled();
    view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.positions.length, 0, 'the fast loop took the profit between scans');
    assert.ok(engine.events.list().some(e => e.stage === 'EXIT' && /^CRASH · exit signal: TAKE_PROFIT 10[45]\.\d+% ≥ 100%/.test(e.message)));
    assert.equal(engine.events.list().filter(e => e.stage === 'QUOTE').at(-1)!.detail!.slippageBps, 1000, 'CRASH exits use the wider exit slippage');
    await engine.persist();
    const tape = (await fs.readFile(path.join(dir, 'tape-PAPER.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.ok(tape.some(r => r.mint === MINT && r.signal === true && r.poolAgeMin > 9 && r.liquidityUsd === 50_000), 'every CRASH signal is on the replay tape');
    const stats = view.strategies.find(s => s.id === 'CRASH')!.stats;
    assert.equal(stats.trades, 1); assert.equal(stats.wins, 1); assert.ok(stats.netPnlUsd > 2);
    await fs.access(path.join(dir, 'ledger-PAPER-CRASH.json'));
    await assert.rejects(engine.resetTest(), /STOP_TEST_FIRST/);
    engine.stop(); await engine.settled();
    const archived = await engine.resetTest();
    assert.equal(archived.length, 1); assert.match(archived[0]!, /^ledger-PAPER-CRASH\.archived-/);
    await fs.access(path.join(dir, archived[0]!));
    view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.ledger.length, 0); assert.equal(view.strategies.find(s => s.id === 'CRASH')!.cashUsd, 10);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('CRASH locks the profit when a +60% spike fades to +40%', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-lock-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const check = async () => { (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled(); };
    engine.start(); await engine.pulse();
    w.priceFactor = 1.6; await check();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 1, '+60% is below the take profit: held');
    w.priceFactor = 1.4; await check();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 0);
    assert.ok(engine.events.list().some(e => /CRASH · exit signal: PROFIT_LOCK \+39\.\d+% after a \+59\.\d+% peak/.test(e.message)));
    assert.ok(engine.status({ connected: false, address: null }).ledger[0]!.netPnlUsd! > 0.7);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('several coins at once: FAIR fills both slots in one scan while CRASH trades in parallel, and a coin is never held by two strategies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-multi-'));
  const [M2, M3, M4] = [tokenKey(101), tokenKey(102), tokenKey(103)];
  const { shared } = world({}, 'fair', [
    { mint: M2, symbol: 'BBB', pool: tokenKey(111), patch: {}, launch: 'fair' },
    { mint: M3, symbol: 'CCC', pool: tokenKey(112), patch: {}, launch: 'fair' },
    // Young pump with a fair launch: CRASH takes it first; FAIR must not buy it as well.
    { mint: M4, symbol: 'DDD', pool: tokenKey(113), patch: YOUNG_PUMP, launch: 'fair' }]);
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    let view = engine.status({ connected: true, address: owner.toBase58() });
    assert.deepEqual(view.positions.map(p => [p.strategy, p.symbol]), [['CRASH', 'DDD']], 'CRASH entered in the first scan');
    await engine.pulse();
    view = engine.status({ connected: true, address: owner.toBase58() });
    const fair = view.positions.filter(p => p.strategy === 'FAIR').map(p => p.symbol).sort();
    assert.deepEqual(fair, ['ABC', 'BBB'], 'both FAIR slots filled in the same scan');
    await engine.pulse(); await engine.pulse();
    view = engine.status({ connected: true, address: owner.toBase58() });
    assert.equal(view.positions.length, 3);
    assert.equal(view.positions.filter(p => p.mint === M4).length, 1, 'one coin, one strategy');
    assert.equal(view.candidates.find(c => c.mint === M4)!.status, 'QUALIFIED', 'FAIR would qualify it, but CRASH already holds it');
    assert.ok(engine.events.list().some(e => /^FAIR · 1 candidate\(s\), but 2\/2 positions are open$/.test(e.message)));
    assert.equal(engine.events.list().filter(e => /slots|positions are open/.test(e.message)).length, 1, 'the full-slots note is logged once, not every scan');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('drill with an empty TEST sleeve waits instead of requesting quotes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-drill-empty-')), { shared } = world({ priceChange: { m5: -5, h1: 5 } });
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    (engine as unknown as { ledgers: Map<string, { state: { paperCashLamports: string } }> }).ledgers.get('PAPER')!.state.paperCashLamports = '597000';
    engine.drill = true; await engine.pulse(); await engine.pulse();
    assert.ok(!engine.events.list().some(e => e.stage === 'QUOTE'), 'no quote is requested for an unfundable entry');
    assert.equal(engine.events.list().filter(e => /^DRILL paused: FAIR · TEST sleeve/.test(e.message)).length, 1, 'logged once');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('replay: pessimistic minute-candle exits and constant-product size impact', () => {
  const t0 = Date.UTC(2026, 8, 29, 21, 9, 0), entryAt = t0 + 5_000, entry = 1;
  const c = (i: number, o: number, h: number, l: number, cl: number) => ({ t: t0 + i * 60_000, o, h, l, c: cl });
  const crash = { takeProfitPct: 100, stopLossPct: 15, maxHoldMin: 4, trailing: null, giveback: { lockPeakPct: 40, points: 15 } };
  // The entry candle only contributes its close; a later candle reaching +100% takes profit at the target.
  assert.deepEqual(replayExit([c(0, 0.9, 5, 0.5, 1.1), c(1, 1.1, 2.2, 1.05, 2)], entryAt, entry, crash, 30 * 60_000),
    { exitAt: t0 + 60_000, exitPrice: 2, reason: 'TAKE_PROFIT', peakPct: 120.00000000000001 });
  // Within one candle the low is assumed first: after a +60% peak, a dip to +30% locks the profit before any high counts.
  const lock = replayExit([c(0, 1, 1, 1, 1), c(1, 1, 1.6, 1.2, 1.5), c(2, 1.5, 2.5, 1.3, 2.4)], entryAt, entry, crash, 30 * 60_000);
  assert.equal(lock.reason, 'PROFIT_LOCK'); assert.ok(Math.abs(lock.exitPrice - 1.45) < 1e-9);
  assert.equal(replayExit([c(0, 1, 1, 1, 1), c(1, 1, 1.05, 0.8, 0.9)], entryAt, entry, crash, 30 * 60_000).reason, 'STOP_LOSS');
  assert.equal(replayExit([0, 1, 2, 3, 4].map(i => c(i, 1, 1.05, 0.97, 1.02)), entryAt, entry, crash, 30 * 60_000).reason, 'MAX_HOLD');
  // $2 on a $12.8K reserve barely moves the price; $10K into the same pool loses even on a +110% move.
  assert.ok(Math.abs(sizedReturn(2, 1, 2.1, 12_800, 1) - 1.1) < 0.001);
  assert.ok(sizedReturn(10_000, 1, 2.1, 12_800, 1) < 0);
});

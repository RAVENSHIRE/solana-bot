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
import { CRASH_DEFAULTS, DESK, deskCapital, liveSignerSettings, strategyProfiles } from '../src/desk/config';
import { pairMetrics, selectPair, tierFor, type Discovered } from '../src/desk/discovery';
import { assessAuthenticity, checkWebsite, parseXLink, XClient, type WebsiteCheck } from '../src/desk/social';
import { analyze } from '../src/desk/analysis';
import { DeskLedger } from '../src/desk/ledger';
import { DeskEngine } from '../src/desk/engine';
import { OPENING_SCREEN_ALERT_CONFIG } from '../src/desk/opening-alerts';
import type { NotifyOptions } from '../src/desk/watch';
import { crashCheck, exitReason, exitRuleText, scaleAdvice, strategyStats } from '../src/desk/strategies';
import { replayExit, sizedReturn } from '../src/desk/replay';
import { signals, simulatePool, summarize, type EntryRule, type PoolSeries } from '../src/desk/backtest';
import { GraduationFeed } from '../src/desk/migrations';
import { localKeySigner } from '../src/desk/local-signer';
import { reclaimRent } from '../src/desk/rent';
import { PRESETS, parseRuleSpec, ruleMarketChecks, ruleProfile, RUNNER_PRESET, type RuleSpecInput } from '../src/desk/custom';
import bs58 from 'bs58';
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
const site: WebsiteCheck = { url: 'https://alpha.example', status: 'AVAILABLE', httpStatus: 200, title: 'Alpha', description: null, xHandles: ['alphaproj'], detail: 'HTTP 200', addresses: [], claimed: [] };

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

test('ledger: TEST PnL books both network fees once and account rent until it is reclaimed; LIVE needs a signature; modes never share a file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-ledger-'));
  try {
    const paper = await DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'PAPER', null, NOW);
    paper.fundPaper(5.45, 100); assert.equal(paper.state.paperCashLamports, '54500000');
    const base = { mint: MINT, symbol: 'ABC', decimals: 6, pairAddress: POOL, router: 'Jupiter', route: 'Raydium', routerFeeUsd: null, txSignature: null, solUsd: 100, note: null };
    paper.book({ ...base, side: 'BUY', inAmountRaw: 20_000_000n, outAmountRaw: 4_000_000_000n, solDeltaLamports: -22_044_580n, feeLamports: 5_300n, rentLamports: 2_039_280n, at: NOW });
    const sell = paper.book({ ...base, side: 'SELL', inAmountRaw: 4_000_000_000n, outAmountRaw: 28_000_000n, solDeltaLamports: 27_994_700n, feeLamports: 5_300n, rentLamports: 0n, at: NOW + 1 });
    assert.ok(Math.abs(sell.grossPnlUsd! - 0.8) < 1e-9); assert.ok(Math.abs(sell.netPnlUsd! - (0.8 - 0.00106 - 0.203928)) < 1e-9, 'the unreclaimed account rent is a cost');
    assert.equal(sell.rentOutstandingLamports, '2039280'); assert.deepEqual(paper.rentOutstandingMints(), [MINT]);
    assert.equal(paper.state.positions.length, 0); assert.equal(paper.state.paperCashLamports, String(54_500_000n - 20_000_000n - 5_300n - 2_039_280n + 27_994_700n));
    paper.rentReclaimed({ mint: MINT, lamports: 2_039_280n, feeLamports: 5_000n, signature: null, solUsd: 100 });
    assert.ok(Math.abs(sell.netPnlUsd! - (0.8 - 0.00106 - 0.0005)) < 1e-9, 'closing the account returns the rent, minus its fee');
    assert.equal(sell.rentOutstandingLamports, undefined); assert.deepEqual(paper.rentOutstandingMints(), []);
    assert.ok(Math.abs(paper.state.realizedPnlUsd - (0.8 - 0.00106 - 0.0005)) < 1e-9);
    assert.equal(paper.state.paperCashLamports, String(54_500_000n - 20_000_000n - 5_300n + 27_994_700n - 5_000n));
    await paper.save();
    const live = await DeskLedger.open(path.join(dir, 'ledger-LIVE-x.json'), 'LIVE', owner.toBase58(), NOW);
    assert.throws(() => live.book({ ...base, side: 'BUY', inAmountRaw: 1n, outAmountRaw: 1n, solDeltaLamports: -1n, feeLamports: 0n, rentLamports: 0n, at: NOW }), /LIVE_FILL_WITHOUT_SIGNATURE/);
    await assert.rejects(DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'LIVE', owner.toBase58(), NOW), /LEDGER_IDENTITY_MISMATCH/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('power cut: zero-byte TEST ledgers and event files are moved aside and start fresh; a damaged LIVE ledger still stops the desk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-damaged-')), NOW = Date.parse('2026-10-05T12:00:00Z');
  try {
    // Raven, 3 Oct: every file written in the last second before the shutdown held only zero bytes.
    for (const f of ['ledger-PAPER.json', 'ledger-PAPER-CRASH.json', 'ledger-LIVE-x.json', 'events-PAPER.json']) await fs.writeFile(path.join(dir, f), Buffer.alloc(3_672));
    const paper = await DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'PAPER', null, NOW);
    assert.equal(paper.state.entries.length, 0); assert.equal(paper.state.createdAt, NOW);
    assert.equal(paper.damaged, path.join(dir, 'ledger-PAPER.json.damaged-2026-10-05T12-00-00-000Z'));
    assert.equal((await fs.stat(paper.damaged!)).size, 3_672, 'kept for a look');
    await paper.save();
    assert.equal((await DeskLedger.open(path.join(dir, 'ledger-PAPER.json'), 'PAPER', null, NOW)).damaged, null, 'the fresh one reads back');
    await assert.rejects(DeskLedger.open(path.join(dir, 'ledger-LIVE-x.json'), 'LIVE', 'x', NOW), /LEDGER_INVALID/);
    assert.equal((await fs.stat(path.join(dir, 'ledger-LIVE-x.json'))).size, 3_672, 'a LIVE ledger is never moved');
    // The whole TEST engine opens, and says once what it moved.
    const engine = await DeskEngine.create({ ...world().shared, mode: 'PAPER', dir, sender: null, wallet: () => null });
    const said = engine.status({ connected: false, address: null }).events.filter(e => e.stage === 'FAILED' && /moved aside/.test(e.message));
    assert.equal(said.length, 1); assert.match(said[0]!.message, /TEST starts fresh: events-PAPER\.json\.damaged-.*ledger-PAPER-CRASH\.json\.damaged-/);
    assert.ok((await fs.readdir(dir)).some(f => f.startsWith('events-PAPER.json.damaged-')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('process lock: a crashed owner is recovered; a live owner or a fresh empty lock still blocks; an old empty lock is stale', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-lock-')), lock = path.join(dir, 'desk.lock');
  try {
    const child = spawn(process.execPath, ['-e', '']); await new Promise(r => child.once('exit', r));
    await fs.writeFile(lock, String(child.pid));
    const handle = await acquireProcessLock(lock); assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await handle.close(); await fs.unlink(lock);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
    try { await fs.writeFile(lock, String(sleeper.pid)); await assert.rejects(acquireProcessLock(lock), /EEXIST/); } finally { sleeper.kill(); }
    await fs.writeFile(lock, ''); await assert.rejects(acquireProcessLock(lock), /EEXIST/, 'an owner that just created it may not have written its pid yet');
    // An empty lock from before a hard shutdown (Raven, 3 Oct): stale after a minute, so the desk can start again.
    const old = new Date(Date.now() - 2 * 60_000); await fs.utimes(lock, old, old);
    const again = await acquireProcessLock(lock); assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await again.close(); await fs.unlink(lock);
    // What Raven's lock actually held after the shutdown: five zero bytes, not nothing.
    await fs.writeFile(lock, Buffer.alloc(5)); await fs.utimes(lock, old, old);
    const zeros = await acquireProcessLock(lock); assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await zeros.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- full pipeline against a simulated network

interface Token { mint: string; symbol: string; pool: string; curve: string; patch: Record<string, unknown>; launch: 'fair' | 'insider'; listed?: boolean }
function world(patch: Record<string, unknown> = {}, launch: 'fair' | 'insider' = 'fair', more: Array<Omit<Token, 'curve'>> = []) {
  const tokens: Token[] = [{ mint: MINT, symbol: 'ABC', pool: POOL, curve: SOL_POOL, patch, launch }, ...more.map((t, i) => ({ ...t, curve: key(200 + i).toBase58() }))];
  const w = { priceFactor: 1, extraRent: 0, liquidity: 50_000, native: 45_000_000, sends: 0, signRequests: 0,
    graduations: [] as Array<{ signature: string; mint: string; ok: boolean; migrate: boolean; broken?: boolean }>,
    priorityCaps: [] as Array<{ side: 'BUY' | 'SELL'; maxLamports: number; notional: bigint }>,
    dasUnsupported: false, noRoute: false, sellQuotes: 0, searchPairs: [] as unknown[], searches: 0,
    /** Launch insiders: what they hold (raw) and the bonding curve account, for the rug exits. */
    insider: null as string | null, insiderRaw: 0n, curve: null as Buffer | null,
    last: null as null | { side: 'BUY' | 'SELL'; mint: string; inAmount: bigint; outAmount: bigint } };
  const holderMint = new Map<string, string>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const solPair = { chainId: 'solana', dexId: 'orca', pairAddress: SOL_POOL, baseToken: { address: SOL_MINT, symbol: 'SOL' }, quoteToken: { address: USDC_MINT, symbol: 'USDC' },
    priceUsd: '100', liquidity: { usd: 10_000_000 }, marketCap: 5e10, fdv: 6e10, pairCreatedAt: NOW - 1e10, txns: { h1: { buys: 5, sells: 5 } } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.dexscreener.com') {
      if (url.pathname === '/latest/dex/search') { w.searches++; return json({ schemaVersion: '1.0.0', pairs: w.searchPairs }); }
      if (url.pathname.startsWith('/token-')) return json(tokens.filter(t => t.listed !== false).map(t => ({ chainId: 'solana', tokenAddress: t.mint, description: 'Alpha does things', totalAmount: 100,
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
      if (!buy) w.sellQuotes++;
      // Jupiter's answer for a token whose pool was drained or delisted.
      if (!buy && w.noRoute) return json({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400);
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
      w.priorityCaps.push({ side: w.last.side, maxLamports: body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports, notional: w.last.side === 'BUY' ? w.last.inAmount : w.last.outAmount });
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
    getAccountInfo: async () => w.curve ? { data: w.curve, owner: SystemProgram.programId, lamports: 1, executable: false } : null,
    getParsedTokenAccountsByOwner: async (owner: PublicKey) => ({ value: w.insider && owner.toBase58() === w.insider && w.insiderRaw > 0n
      ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(w.insiderRaw), decimals: 6 } } } } } }] : [] }),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 1000 }],
    getFeeForMessage: async () => ({ value: 5_300 }),
    getMultipleAccountsInfo: async () => [],
    getSignaturesForAddress: async () => w.graduations.map(g => ({ signature: g.signature, blockTime: Math.floor(Date.now() / 1000) - 30, err: g.ok ? null : { InstructionError: [0, 'x'] } })),
    _rpcRequest: async (method: string, args: unknown) => {
      // DAS holder count: two owners with a balance (one of them with two accounts) and an emptied account.
      if (method === 'getTokenAccounts') return w.dasUnsupported ? { error: { code: -32601, message: 'Method not found' } }
        : { result: { token_accounts: [{ owner: key(160).toBase58(), amount: 5 }, { owner: key(161).toBase58(), amount: 0 }, { owner: key(160).toBase58(), amount: 3 }, { owner: key(162).toBase58(), amount: '7' }] } };
      if (method !== 'getTransaction') throw new Error(`unexpected ${method}`);
      const [sig, config] = args as [string, { maxSupportedTransactionVersion?: number }];
      const g = w.graduations.find(x => x.signature === sig)!, lp = key(222).toBase58();
      // Migrations may be version 1 transactions: a client that asks for version 0 at most is refused, like the real RPC.
      if ((config.maxSupportedTransactionVersion ?? -1) < 1) return { error: { message: 'Transaction version (1) is not supported by the requesting client' } };
      if (g.broken) throw new Error('RPC timeout');
      return { result: { meta: { err: null, logMessages: g.migrate ? ['Program log: Instruction: MigrateV2', 'Program log: Instruction: CreatePool'] : ['Program log: Instruction: Buy'],
        preTokenBalances: [{ mint: g.mint }, { mint: SOL_MINT }], postTokenBalances: [{ mint: g.mint }, { mint: SOL_MINT }, { mint: lp }] } } };
    },
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
    // One EXEC record per order: how long each step took after the decision, what the simulation filled against the quote.
    const exec = engine.events.list().filter(e => e.stage === 'EXEC');
    assert.equal(exec.length, 1);
    assert.match(exec[0]!.message, /^BUY PAPER FILLED · quote \d+ ms · built \d+ ms · simulated \d+ ms · pre-flight \d+ ms · done \d+ ms · [+-]\d+\.\d\d % vs quote · priority \d+ lamports$/);
    const ed = exec[0]!.detail!;
    assert.equal(ed.outcome, 'PAPER_FILLED'); assert.equal(ed.reverted, false); assert.equal(ed.signedMs, undefined, 'TEST never signs');
    assert.ok(typeof ed.quotedMs === 'number' && typeof ed.simulatedMs === 'number' && (ed.simulatedMs as number) >= (ed.quotedMs as number));
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
    await engine.prepareStart();
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

test('LIVE restart refuses unresolved orders and token holdings missing from the connected wallet', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-restart-')), { shared } = world();
  try {
    const file = path.join(dir, `ledger-LIVE-${owner.toBase58()}.json`);
    const ledger = await DeskLedger.open(file, 'LIVE', owner.toBase58(), NOW);
    ledger.state.pending = { side: 'BUY', mint: MINT, at: NOW, signature: null }; await ledger.save();
    const args = { ...shared, mode: 'LIVE' as const, dir, sender: null, wallet: () => ({ owner, signer: null }) };
    const pending = await DeskEngine.create(args);
    await assert.rejects(() => pending.prepareStart(), /TRANSACTION_RECONCILIATION_REQUIRED/);
    assert.throws(() => pending.start(), /LIVE_RECONCILIATION_REQUIRED/);
    ledger.state.pending = null;
    ledger.book({ side: 'BUY', mint: MINT, symbol: 'ABC', decimals: 6, pairAddress: POOL, router: 'Jupiter', route: 'Raydium',
      routerFeeUsd: null, txSignature: 'fixture-confirmed', solUsd: 100, at: NOW, note: null,
      inAmountRaw: 20_000_000n, outAmountRaw: 1_000_000n, solDeltaLamports: -20_005_000n, feeLamports: 5_000n, rentLamports: 0n });
    await ledger.save();
    const missing = await DeskEngine.create(args);
    await assert.rejects(() => missing.prepareStart(), /LIVE_HOLDINGS_MISMATCH/);
    assert.throws(() => missing.start(), /LIVE_RECONCILIATION_REQUIRED/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- CRASH strategy and parallel strategies

const YOUNG_PUMP = { pairCreatedAt: NOW - 10 * 60_000, priceChange: { m5: 25, h1: 40 }, volume: { m5: 60_000, h1: 120_000 }, marketCap: 200_000, fdv: 200_000 };
const tokenKey = (n: number) => key(n).toBase58();

test('CRASH rules (from the backtest): +100% take profit, 35% stop, 10-minute time stop, no profit lock unless configured; FAIR keeps its trailing stop', () => {
  const rs = { takeProfitPct: 30, stopLossPct: 12, trailingActivationPct: 15, trailingStopPct: 8, maxHoldMin: 60 };
  const p = strategyProfiles({}, deskCapital({}), rs);
  const c = p.CRASH.exits, f = p.FAIR.exits;
  assert.equal(p.CRASH.entryUsd, 2); assert.equal(p.CRASH.capitalUsd, CRASH_DEFAULTS.capitalUsd); assert.equal(p.CRASH.maxDragBps, 500n);
  const x = (pnlPct: number, peakPct = pnlPct, heldMs = 60_000, fromPeakPct = 0) => ({ pnlPct, peakPct, fromPeakPct, heldMs });
  assert.match(exitReason(c, x(101))!, /^TAKE_PROFIT/, '+100% = $2 unrealized on $2');
  assert.equal(c.giveback, null); assert.equal(exitReason(c, x(30, 46)), null, 'no profit lock by default: a pullback from a peak is held');
  assert.equal(exitReason(c, x(-25)), null, 'normal volatility is not stopped out');
  assert.match(exitReason(c, x(-35.5))!, /^STOP_LOSS/);
  assert.equal(exitReason(c, x(5, 5, 9 * 60_000)), null); assert.match(exitReason(c, x(5, 5, 10 * 60_000))!, /^MAX_HOLD 10 min/);
  const locked = strategyProfiles({ CRASH_LOCK_PEAK_PCT: '40' }, deskCapital({}), rs).CRASH.exits;
  assert.equal(exitReason(locked, x(35, 38)), null, 'below the +40% lock, a pullback is held');
  assert.match(exitReason(locked, x(30, 46))!, /^PROFIT_LOCK \+30\.00% after a \+46\.00% peak/);
  assert.equal(exitReason(locked, x(33, 46)), null);
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
  const run = (patch: Record<string, unknown>, o: typeof onchain = onchain, times?: { createdAt?: number | null; firstPoolAt?: number | null }) => {
    const p = pair(patch);
    return crashCheck(analyze({ found: found(), pair: p, metrics: pairMetrics(p, NOW, times), tier: 'TRENDING', onchain: o, onchainAt: NOW, social: null, watch, now: NOW, maxWashRatio: 0.45, launch: insider }));
  };
  const young = run(YOUNG_PUMP);
  assert.equal(young.signal, true, young.summary); assert.match(young.summary, /^25\.0% in 5m · graduated 10 min ago/);
  // A fresh extra pool on an old token is not a young graduation (SI Strategy: five new pools on 1 Oct, graduated 30 Sep).
  assert.match(run(YOUNG_PUMP, onchain, { createdAt: NOW - 20 * 3_600_000, firstPoolAt: NOW - 19 * 3_600_000 }).summary, /^Since first AMM pool \(graduation\): 1140 min/);
  assert.equal(young.checks.find(g => g.key === 'fairLaunch')!.status, 'FAIL', 'the insider launch is shown…');
  assert.equal(young.checks.find(g => g.key === 'fairLaunch')!.blocking, false, '…but never required for CRASH');
  assert.match(run({ ...YOUNG_PUMP, pairCreatedAt: NOW - 3 * 3_600_000 }).summary, /^Since first AMM pool \(graduation\): 180 min/);
  assert.match(run({ ...YOUNG_PUMP, priceChange: { m5: 45 } }).summary, /^5m price change: 45\.0%/, 'a move already above +30% in five minutes is not chased');
  assert.match(run({ ...YOUNG_PUMP, pairCreatedAt: NOW - 20 * 60_000 }).summary, /^Since first AMM pool \(graduation\): 20 min/, 'only the first 15 minutes after graduation');
  assert.match(run({ ...YOUNG_PUMP, volume: { m5: 30_000, h1: 60_000 } }).summary, /^5m volume: \$30,000/, 'thin volume is not traded');
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
    assert.match(view.ledger.find(e => e.side === 'SELL')!.exitReason!, /^TAKE_PROFIT /, 'the exit rule is on the ledger row');
    const level = view.levels!.rows.find(r => r.id === 'CRASH')!;
    assert.equal(view.levels!.chain, 'Solana'); assert.equal(level.trades, 1); assert.ok(level.avgPct! > 90, `average ${level.avgPct}`);
    assert.equal(level.checks.trades, false); assert.equal(level.testPassed, false);
    assert.ok(!view.levels!.rows.some(r => r.id === 'OPEN'), 'retired strategies are not on the level card');
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

test('a coin named after a real company is never bought (owner, 5 Oct: brand-name coins are scams)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-brand-')), { shared } = world({ ...YOUNG_PUMP, baseToken: { address: MINT, symbol: 'NVDA', name: 'NVIDIA AI' } }, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'CRASH signals it, but no strategy buys it');
    assert.equal(view.candidates[0]!.crash!.signal, true);
    assert.match(view.candidates[0]!.entryNotes!.CRASH!, /^BRAND_NAME: "nvidia" names NVIDIA/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('with the optional profit lock configured, CRASH locks the profit when a +60% spike fades to +40%', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-lock-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const strategies = strategyProfiles({ CRASH_LOCK_PEAK_PCT: '40' }, deskCapital({}), shared.cfg.rs);
    const engine = await DeskEngine.create({ ...shared, strategies, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
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
    assert.equal(engine.events.list().filter(e => /positions are open/.test(e.message)).length, 1, 'the full-slots note is logged once, not every scan');
    assert.equal(engine.events.list().filter(e => /^FAIR · entry skipped: all 2 FAIR slots in use$/.test(e.message)).length, 1, 'and the token\'s skip reason once');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an empty TEST sleeve with nothing open is archived as a cycle and re-funded; stats continue across cycles', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-cycle-')), { w, shared } = world();
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const ledgers = (engine as unknown as { ledgers: Map<string, { state: { paperCashLamports: string } }> }).ledgers;
    engine.start(); await engine.pulse(); await engine.pulse();
    w.priceFactor = 1.4; await engine.pulse(); w.priceFactor = 1;
    assert.equal(engine.status({ connected: false, address: null }).strategies.find(s => s.id === 'FAIR')!.stats.trades, 1);
    ledgers.get('PAPER')!.state.paperCashLamports = '597000';
    await engine.pulse();
    const cycle = (await fs.readdir(dir)).filter(n => n.startsWith('ledger-PAPER.cycle-'));
    assert.equal(cycle.length, 1, 'the dry sleeve was archived as a cycle');
    assert.ok(engine.events.list().some(e => /^FAIR · TEST sleeve ran dry with no open position: cycle 1 archived/.test(e.message)));
    const fair = engine.status({ connected: false, address: null }).strategies.find(s => s.id === 'FAIR')!;
    assert.equal(fair.cashUsd, 5.45, 're-funded to the planned capital'); assert.equal(fair.cycles, 1);
    assert.equal(fair.stats.trades, 1, 'the archived trade still counts'); assert.ok(fair.realizedPnlUsd > 0.79);
    // A restart reloads the cycle history; RESET TEST archives it away.
    engine.stop(); await engine.settled();
    const reopened = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(reopened.status({ connected: false, address: null }).strategies.find(s => s.id === 'FAIR')!.stats.trades, 1);
    await reopened.resetTest();
    assert.equal((await fs.readdir(dir)).filter(n => n.startsWith('ledger-PAPER.cycle-')).length, 0);
    assert.equal(reopened.status({ connected: false, address: null }).strategies.find(s => s.id === 'FAIR')!.stats.trades, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('execution events survive a flood of scanner events; candidates show why they were not entered and when they went stale', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-window-')), { shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    for (let i = 0; i < 1_000; i++) engine.events.add('FILTERED', `noise ${i}`);
    const view = engine.status({ connected: false, address: null });
    assert.ok(view.events.some(e => e.stage === 'POSITION' && /CRASH · position opened/.test(e.message)), 'the entry is still in the telemetry window');
    // FAIR sees the same token as a candidate but CRASH holds it.
    engine.setStrategy('CRASH', false); await engine.pulse(); await engine.pulse();
    const c = engine.status({ connected: false, address: null }).candidates.find(x => x.mint === MINT)!;
    assert.equal(c.stale, false);
    const internals = engine as unknown as { lastCompletedScanAt: number };
    internals.lastCompletedScanAt = Date.now() + 1;
    assert.equal(engine.status({ connected: false, address: null }).candidates.find(x => x.mint === MINT)!.stale, true);
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

test('backtest: minute signals use the trailing five minutes; trades pay impact, fees and costs; re-entry waits for the cooldown', () => {
  const t0 = Date.UTC(2026, 8, 30, 0, 0), m = 60_000;
  // Flat for 6 minutes, +50% in one minute on $30K volume, then +150% over 3 minutes, back to +20%, then a second pump.
  const closes = [1, 1, 1, 1, 1, 1, 1.5, 1.8, 2.2, 2.5, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.9, 2.0, 2.0, 2.0];
  const candles = closes.map((c, i) => ({ t: t0 + i * m, o: i ? closes[i - 1]! : 1, h: Math.max(c, i ? closes[i - 1]! : 1), l: Math.min(c, i ? closes[i - 1]! : 1), c, v: i === 6 || i === 26 ? 30_000 : 1_000 }));
  const s: PoolSeries = { mint: 'M', symbol: 'M', pool: 'P', createdAt: t0, supply: 1e5, liquidityRefUsd: 40_000, priceRef: 1, candles };
  const e: EntryRule = { maxPoolAgeMin: 60, minChange5mPct: 10, maxChange5mPct: 200, minVolume5mUsd: 20_000, minLiquidityUsd: 10_000, minLiquidityToMarketCap: 0.03,
    maxMarketCapUsd: Infinity, pullbackPct: 0, pullbackWindowMin: 0 };
  const sig = signals(s, e);
  assert.equal(sig[0]!.at, t0 + 7 * m, 'the +50% minute closes at 00:07'); assert.ok(Math.abs(sig[0]!.change5mPct - 50) < 1e-9);
  assert.equal(signals(s, { ...e, maxPoolAgeMin: 5 }).length, 0, 'too old');
  const exit = { takeProfitPct: 50, stopLossPct: 20, maxHoldMin: 30, trailing: null, giveback: null };
  const costs = { sizeUsd: 2, venueFeePct: 0.3, fixedUsd: 0.02, stopSlipPct: 3 };
  const trades = simulatePool(s, e, exit, costs, 10);
  assert.equal(trades.length, 2, 'take profit, then a new signal after the 10-minute cooldown');
  assert.equal(trades[0]!.reason, 'TAKE_PROFIT'); assert.ok(trades[0]!.returnPct < 50 && trades[0]!.returnPct > 45, 'fees, impact and fixed costs are paid');
  assert.ok(trades[1]!.entryAt >= trades[0]!.exitAt + 10 * m);
  const sum = summarize(trades);
  assert.equal(sum.trades, 2); assert.ok(Math.abs(sum.totalUsd - trades.reduce((a, x) => a + x.pnlUsd, 0)) < 1e-12);
  assert.equal(simulatePool(s, e, exit, costs, 30).length, 1, 'a longer cooldown skips the second pump');
});

test('every pump.fun graduation is discovered from the chain, even when no listing or new-pool page shows it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-grad-')), GRAD = tokenKey(120);
  const { w, shared } = world({}, 'fair', [{ mint: GRAD, symbol: 'GRAD', pool: tokenKey(121), patch: YOUNG_PUMP, launch: 'insider', listed: false }]);
  // An unreadable transaction listed first must not hide the graduations after it.
  w.graduations = [{ signature: 'sig-broken', mint: tokenKey(124), ok: true, migrate: true, broken: true }, { signature: 'sig-grad', mint: GRAD, ok: true, migrate: true },
    { signature: 'sig-failed', mint: tokenKey(122), ok: false, migrate: true }, { signature: 'sig-swap', mint: tokenKey(123), ok: true, migrate: false }];
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.sources['Pump.fun graduations (on-chain)'], 'OK');
    assert.deepEqual(view.positions.map(p => [p.strategy, p.symbol]), [['CRASH', 'GRAD']], 'CRASH entered the graduated token in the first scan');
    const c = view.candidates.find(x => x.mint === GRAD)!;
    assert.ok(c.sources.includes('graduated'));
    const feed = await new GraduationFeed(shared.rpc as never).poll();
    assert.deepEqual(feed.map(g => g.mint), [GRAD], 'failed txs, non-migrations and the new LP mint are ignored');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('RIDE mode has no take profit and trails the move; CRASH may re-enter after its own shorter cooldown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-ride-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const strategies = strategyProfiles({ CRASH_EXIT_MODE: 'ride' }, deskCapital({}), shared.cfg.rs);
    assert.equal(strategies.CRASH.exits.takeProfitPct, Infinity); assert.deepEqual(strategies.CRASH.exits.trailing, { activationPct: 50, stopPct: 35 });
    assert.equal(strategies.CRASH.reentryCooldownMs, 10 * 60_000); assert.equal(strategies.FAIR.reentryCooldownMs, DESK.reentryCooldownMs);
    const engine = await DeskEngine.create({ ...shared, strategies, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const check = async () => { (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled(); };
    engine.start(); await engine.pulse();
    w.priceFactor = 2.5; await check();
    w.priceFactor = 5; await check();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 1, '+400% is held: no take profit in RIDE');
    w.priceFactor = 3.4; await check();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 1, '−32% from the peak is inside the 35% trail');
    w.priceFactor = 3; await check();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0);
    assert.ok(engine.events.list().some(e => /CRASH · exit signal: TRAILING_STOP -40\.00% from peak/.test(e.message)));
    assert.ok(view.ledger[0]!.netPnlUsd! > 3.9, 'rode a 5× peak out at 3×');
    assert.match(view.strategies.find(s => s.id === 'CRASH')!.exitRules.join(' | '), /Exit mode RIDE \| No take profit/);
    w.priceFactor = 1; await engine.pulse();
    assert.match(engine.status({ connected: false, address: null }).candidates.find(c => c.mint === MINT)!.entryNotes!.CRASH!, /^re-entry cooldown until \d\d:\d\d$/);
    // The skip reason is in the event log too, once: a later scan with the same reason adds nothing.
    const skips = () => engine.events.list().filter(e => e.mint === MINT && /^CRASH · entry skipped: re-entry cooldown until \d\d:\d\d$/.test(e.message));
    assert.equal(skips().length, 1);
    await engine.pulse();
    assert.equal(skips().length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('CRASH variants in TEST: C1 and C2 take the same signal and hold the same coin as CRASH; C2 sells at the previous resistance −3 %; C1 skips a coin without structure', async () => {
  for (const scenario of ['structure', 'no-candles'] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `desk-variants-${scenario}-`)), { shared } = world(YOUNG_PUMP, 'insider');
    try {
      // The pool's minutes (market caps): a $190K swing high, closed above at $198K; the current minute is still running.
      const start = Date.now() - 4.5 * 60_000, m = (i: number, o: number, h: number, l: number, c: number) => ({ t: start + i * 60_000, o, h, l, c });
      const watch = { mint: MINT, symbol: 'ABC', startAt: start, lastUsd: 200_000, lastSampleAt: Date.now(),
        bars: [m(0, 150e3, 170e3, 150e3, 165e3), m(1, 165e3, 190e3, 160e3, 180e3), m(2, 180e3, 185e3, 170e3, 175e3), m(3, 175e3, 200e3, 175e3, 198e3), m(4, 198e3, 201e3, 197e3, 200e3)] };
      const followed: number[] = [];
      const tracker = { watchGraduations: () => undefined, hold: () => undefined, followYoung: (ms: number) => { followed.push(ms); }, poll: async () => [],
        get: (x: string) => scenario === 'structure' && x === MINT ? { ...watch, lastSampleAt: Date.now() } : null, list: () => [], counts: () => ({ IMPULSE: 0, DIP: 0, BROKEN_OUT: 0, ENTRY: 0, FAILED: 0, EXPIRED: 0, watched: 1 }) };
      const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }), golden: tracker as never });
      for (const id of ['CRASH_C1', 'CRASH_C2'] as const) await engine.defineStrategy(parseRuleSpec(PRESETS[id]!));
      assert.equal(engine.goldenWanted(), true, 'C1/C2 need the pools sampled');
      engine.start(); await engine.pulse();
      let view = engine.status({ connected: false, address: null });
      const held = view.positions.map(p => p.strategy).sort();
      if (scenario === 'no-candles') {
        assert.deepEqual(held, ['CRASH', 'CRASH_C2'], 'C1 skips a coin without pool candles; C2 enters with the fixed stop');
        assert.match(view.candidates.find(c => c.mint === MINT)!.rules!.CRASH_C1!.summary, /^Structural stop distance: no pool candles yet/);
        assert.doesNotMatch(await fs.readFile(path.join(dir, 'ledger-PAPER-CRASH_C2.json'), 'utf8'), /"stopUsd"/);
        continue;
      }
      assert.deepEqual(held, ['CRASH', 'CRASH_C1', 'CRASH_C2'], 'the same coin, held side by side in TEST');
      assert.ok(engine.events.list().some(e => /^CRASH_C1 entry selected: .*stop \$184\.3K \(prev\. resistance \$190\.0K, −8 %\)/.test(e.message)));
      assert.match(await fs.readFile(path.join(dir, 'ledger-PAPER-CRASH_C2.json'), 'utf8'), /"stopUsd": 184300/);
      await engine.goldenPass();
      assert.equal(followed.at(-1), 15 * 60_000, 'young pools sampled for CRASH\'s 15 minutes');
      // The pool trades under the structural stop: C2 sells; CRASH and C1 (−35 % fixed stop) hold.
      watch.lastUsd = 180_000;
      for (const id of ['CRASH', 'CRASH_C1', 'CRASH_C2']) (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt[id] = 0;
      engine.tick(); await engine.settled();
      view = engine.status({ connected: false, address: null });
      assert.deepEqual(view.positions.map(p => p.strategy).sort(), ['CRASH', 'CRASH_C1']);
      assert.ok(engine.events.list().some(e => /^CRASH_C2 · exit signal: STRUCTURE_STOP \$180,000 ≤ \$184,300 \(previous resistance −3 %\)/.test(e.message)));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('OPEN is retired: off in TEST and LIVE whatever a saved switch says, cannot be switched on; its breakouts still reach the phone (owner, 6 Oct)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-retired-')), { shared } = world();
  try {
    await fs.writeFile(path.join(dir, 'settings-PAPER.json'), JSON.stringify({ strategies: { OPEN: true } }));
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const open = engine.status({ connected: false, address: null }).strategies.find(s => s.id === 'OPEN')!;
    assert.equal(open.enabled, false); assert.equal(open.retired, true); assert.match(open.summary, /^RETIRED 5 Oct/);
    assert.throws(() => engine.setStrategy('OPEN', true), /STRATEGY_RETIRED/);
    engine.setStrategy('OPEN', false);
    assert.equal(engine.status({ connected: false, address: null }).strategies.find(s => s.id === 'CRASH')!.retired, false);
    // A breakout with the opening-screen phone switch on: sent (owner, 6 Oct), though OPEN never buys it.
    const at = Date.now(), sprint = { mint: key(60).toBase58(), symbol: 'S0', name: 'Sprint', at: at - 68_000, status: 'SIGNAL' as const, openHighUsd: 10_000, lowUsd: 7_000,
      lastUsd: 28_900, peakUsd: 28_900, firstSampleAt: at - 65_000, lastSampleAt: at, signalAt: at, signalUsd: 28_900, detail: '$10.0K open → $28.9K', samples: [] };
    let pending = [sprint];
    const tracker = { observe: () => undefined, poll: async () => { const out = pending; pending = []; return out; }, get: () => null, list: () => [], counts: () => ({}) };
    const alerts: string[] = [], dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-retired-phone-'));
    const phone = await DeskEngine.create({ ...world().shared, mode: 'PAPER', dir: dir2, sender: null, wallet: () => ({ owner, signer: null }), opening: tracker as never,
      notify: async t => { alerts.push(t); }, alerts: new Set(['open']) });
    await phone.openingPass();
    assert.deepEqual(alerts, ['OPEN S0 x-- at $28.9K']);
    assert.ok(phone.events.list().some(e => /^OPEN screen: S0/.test(e.message)), 'the opening screen shows it');
    assert.equal(phone.status({ connected: false, address: null }).positions.length, 0, 'never bought');
    await fs.rm(dir2, { recursive: true, force: true });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('held positions ask Jupiter only when due: a quiet price is re-quoted every 10 s, a price near the stop at every check', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-quote-')), patch: Record<string, unknown> = { ...YOUNG_PUMP }, { w, shared } = world(patch, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const inner = engine as unknown as { lastPositionCheckAt: Record<string, number>; lastQuote: Map<string, { at: number; dexPrice: number | null }> };
    const check = async () => { inner.lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled(); };
    engine.start(); await engine.pulse();
    assert.deepEqual(engine.status({ connected: false, address: null }).positions.map(p => p.strategy), ['CRASH']);
    await check();
    const quoted = w.sellQuotes;
    await check(); await check(); await check();
    assert.equal(w.sellQuotes, quoted, 'DexScreener shows the entry price: no Jupiter quote within 10 s of the last one');
    assert.match(engine.status({ connected: false, address: null }).path.find(s => s.layer === 'Quote')!.provider, /\(3 checks needed no quote\)/);
    inner.lastQuote.get(MINT)!.at -= 10_000; await check();
    assert.equal(w.sellQuotes, quoted + 1, 'a 10-second-old quote is renewed');
    patch.priceUsd = '0.00048'; await check();
    assert.equal(w.sellQuotes, quoted + 1, 'a 4 % move is under the 5 % trigger');
    patch.priceUsd = '0.00045'; await check();
    assert.equal(w.sellQuotes, quoted + 2, '−10 % since the last quote is over it');
    patch.priceUsd = '0.00037'; await check(); await check();
    assert.equal(w.sellQuotes, quoted + 4, '−26 % on DexScreener is within 12 points of the 35 % stop: quoted at every check');
    w.priceFactor = 0.6; patch.priceUsd = '0.0003'; await check();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 0);
    assert.ok(engine.events.list().some(e => /^CRASH · exit signal: STOP_LOSS -4\d\.\d\d% ≤ -35%/.test(e.message)), 'the stop is decided on the Jupiter quote');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a fall in the on-chain pool price is re-quoted at once, while DexScreener still shows the entry price', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-onchain-quote-')), { w, shared } = world({ ...YOUNG_PUMP }, 'insider');
  const pool = { lastUsd: 100_000 };
  const golden = { get: (mint: string) => mint === MINT ? { mint, lastUsd: pool.lastUsd, lastSampleAt: Date.now() } : null, counts: () => ({}), list: () => [] };
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }), golden: golden as never, alerts: new Set() });
    engine.setStrategy('GOLDEN', false);
    const inner = engine as unknown as { lastPositionCheckAt: Record<string, number> };
    const check = async () => { inner.lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled(); };
    engine.start(); await engine.pulse();
    assert.deepEqual(engine.status({ connected: false, address: null }).positions.map(p => p.strategy), ['CRASH']);
    await check();
    const quoted = w.sellQuotes;
    await check(); assert.equal(w.sellQuotes, quoted, 'pool and DexScreener quiet: no quote');
    pool.lastUsd = 97_000; await check(); assert.equal(w.sellQuotes, quoted, '−3 % on-chain is under the 5 % trigger');
    pool.lastUsd = 90_000; w.priceFactor = 0.9; await check(); assert.equal(w.sellQuotes, quoted + 1, '−10 % on-chain: quoted at once');
    pool.lastUsd = 72_000; w.priceFactor = 0.72; await check(); await check();
    assert.equal(w.sellQuotes, quoted + 3, 'about −28 % on the pool, within 12 points of the 35 % stop: quoted at every check');
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 1, 'above the stop: still held');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('pausing stops entries only: an open position still takes its exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-pause-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    engine.pause();
    w.priceFactor = 2.05;
    (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.execution, false); assert.equal(view.positions.length, 0, 'the take profit executed while entries were paused');
    assert.ok(engine.events.list().some(e => /Entries PAUSED/.test(e.message)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('EXIT NOW sells an open position at once, while the desk runs and after STOP; an unknown token is refused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-exit-now-'));
  try {
    for (const afterStop of [false, true]) {
      const { shared } = world(YOUNG_PUMP, 'insider'), sub = path.join(dir, String(afterStop));
      await fs.mkdir(sub);
      const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir: sub, sender: null, wallet: () => ({ owner, signer: null }) });
      engine.start(); await engine.pulse();
      let view = engine.status({ connected: false, address: null });
      assert.equal(view.positions.length, 1); const mint = view.positions[0]!.mint;
      if (afterStop) engine.stop();
      assert.throws(() => engine.requestExit(key(9).toBase58()), /POSITION_NOT_FOUND/);
      engine.requestExit(mint);
      if (!afterStop) { assert.equal(engine.status({ connected: false, address: null }).positions[0]!.exitRequested, true); engine.tick(); }
      await engine.settled();
      view = engine.status({ connected: false, address: null });
      assert.equal(view.positions.length, 0, `sold with no exit rule met (${afterStop ? 'desk stopped' : 'desk running'})`);
      assert.equal(view.ledger[0]!.side, 'SELL');
      assert.ok(engine.events.list().some(e => /CRASH · exit signal: EXIT NOW \(manual\)/.test(e.message)));
      assert.throws(() => engine.requestExit(mint), /POSITION_NOT_FOUND/, 'nothing left to sell');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a held token without a Jupiter route never pauses Jupiter for other tokens; it is re-quoted every 2 min and TEST writes it off after 30 min', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-no-route-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    const cost = engine.status({ connected: false, address: null }).positions[0]!.costUsd;
    w.noRoute = true; engine.nextScanAt = Number.POSITIVE_INFINITY;
    const check = async () => { (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled(); };
    await check();
    let view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 1); assert.ok(view.positions[0]!.noRouteSince, 'the position shows since when it has no route');
    assert.ok(engine.events.list().some(e => /no Jupiter route to sell \(Jupiter: HTTP 400 COULD_NOT_FIND_ANY_ROUTE\).*retrying every 2 min/.test(e.message)));
    // The old client paused every Jupiter call for 30 s after three refusals, so no other token could be bought or sold.
    for (let n = 0; n < 4; n++)
      await assert.rejects(shared.jupiter.quote({ inputMint: MINT, outputMint: SOL_MINT, amountRaw: 1_000n, slippageBps: 100 }), /HTTP 400 COULD_NOT_FIND_ANY_ROUTE/);
    assert.ok(await shared.jupiter.quote({ inputMint: SOL_MINT, outputMint: MINT, amountRaw: 1_000n, slippageBps: 100 }), 'a buy quote still works');
    const quoted = w.sellQuotes;
    await check(); await check();
    assert.equal(w.sellQuotes, quoted, 'not re-quoted on every 5-second check');
    const realNow = Date.now;
    const clock = t.mock.method(Date, 'now', () => realNow() + 31 * 60_000);
    try { await check(); } finally { clock.mock.restore(); }
    view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'TEST writes the unsellable position off');
    const row = view.ledger.find(e => e.side === 'SELL')!;
    assert.match(row.note!, /^WRITE-OFF — no Jupiter route since \d\d:\d\d/); assert.ok(row.netPnlUsd! <= -cost * 0.99, 'booked at zero');
    assert.ok(engine.events.list().some(e => /exit signal: NO_ROUTE for 3\d min/.test(e.message)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the four play presets are valid specs; consolidation plays are never stopped out in their first minute', () => {
  for (const id of ['RUNNER', 'MIGRATION', 'CONSOL', 'SCALP', 'CRASH_V1', 'CRASH_70K']) assert.equal(parseRuleSpec(PRESETS[id]!).id, id);
  // CRASH 70K+: CRASH's band narrowed to $70K+ and 5–15 min, checked as often as CRASH (short holds every 2 s).
  const k70 = ruleProfile(parseRuleSpec(PRESETS.CRASH_70K!), true);
  assert.equal(k70.positionCheckMs, CRASH_DEFAULTS.positionCheckMs); assert.equal(ruleProfile(parseRuleSpec(PRESETS.CONSOL!), true).positionCheckMs, DESK.exits.positionCheckMs);
  assert.deepEqual([k70.exits.takeProfitPct, k70.exits.stopLossPct, k70.exits.maxHoldMin], [100, 35, 10], 'the same exits as CRASH');
  const consol = strategyProfiles({}, deskCapital({}), { takeProfitPct: 20, stopLossPct: 12, trailingActivationPct: 8, trailingStopPct: 6, maxHoldMin: 240 }) && ruleProfile(parseRuleSpec(PRESETS.CONSOL!), true);
  const at = (heldMs: number, pnlPct: number) => exitReason(consol.exits, { pnlPct, peakPct: Math.max(pnlPct, 0), fromPeakPct: pnlPct, heldMs });
  assert.equal(at(30_000, -45), null, 'a −45% wick in the first 30 s does not stop out');
  assert.match(at(61_000, -45)!, /^STOP_LOSS/);
  assert.ok(consol.exits.graceMs === 60_000 && exitRuleText(consol).some(r => r === 'Stop loss at -30% (not in the first 60 s)'));
  const volMc = parseRuleSpec({ ...PRESETS.MIGRATION!, entry: { minVolume1hToMcapPct: 30, minLiquidityUsd: 1_000 } });
  const metrics = { marketCapUsd: 100_000, volume1hUsd: 20_000, liquidityUsd: 20_000, migration: 'MIGRATED' } as never;
  assert.deepEqual(ruleMarketChecks(volMc, metrics).find(g => g.key === 'ruleVolMc'), { key: 'ruleVolMc', label: '1h volume / market cap', status: 'FAIL', actual: '20.0%', required: '≥ 30%', blocking: true });
});

test('custom strategy specs are validated: built-in ids, inverted bands, slippage above the drag cap and half a trailing stop are refused', () => {
  const ok = parseRuleSpec(RUNNER_PRESET);
  assert.equal(ok.entry.minHolders, 1_000); assert.equal(ok.exits.takeProfitPct, null); assert.equal(ok.entry.requireXAccount, false);
  const bad = (patch: (s: RuleSpecInput) => void, re: RegExp) => { const s = structuredClone(RUNNER_PRESET); patch(s); assert.throws(() => parseRuleSpec(s), re); };
  bad(s => { s.id = 'CRASH'; }, /^Error: INVALID_STRATEGY_SPEC: id: FAIR, CRASH, LAUNCH, OPEN and GOLDEN are built in/);
  bad(s => { s.id = 'x y'; }, /INVALID_STRATEGY_SPEC: id/);
  bad(s => { s.entry.minMarketCapUsd = 30_000_000; }, /market cap: minimum above maximum/);
  bad(s => { s.sizing.slippageBps = 900; s.sizing.exitSlippageBps = 900; }, /must stay below/);
  bad(s => { s.exits.trailingStopPct = null; }, /needs both activation and stop/);
  bad(s => { s.entry.minLiquidityUsd = 0; }, /entry\.minLiquidityUsd/);
  bad(s => { (s.entry as Record<string, unknown>).secret = 1; }, /INVALID_STRATEGY_SPEC/);
});

const BIG: RuleSpecInput = { id: 'BIG', label: 'BIG RUNNER', summary: 'test',
  entry: { minMarketCapUsd: 1_000_000, maxMarketCapUsd: 20_000_000, minHolders: 2, minPoolAgeMin: 60, minPriceChange1hPct: 0, maxPriceChange1hPct: 25,
    minPriceChange5mPct: 1, maxPriceChange5mPct: 15, minVolume1hUsd: 100_000, minBuySellRatio: 1.1, minLiquidityUsd: 20_000, maxTop10WalletPct: 40, maxLargestWalletPct: 10 },
  exits: { takeProfitPct: null, stopLossPct: 25, trailingActivationPct: 30, trailingStopPct: 25, maxHoldMin: 10_080, marketCapTargetUsd: 9_000_000 },
  sizing: { capitalUsd: 5, entryUsd: 2, maxOpenPositions: 2, slippageBps: 300, exitSlippageBps: 500, maxDragPct: 8 } };

test('the candidate trim keeps this scan\'s entry signals: a custom strategy still enters when the desk holds more tokens than it keeps', async () => {
  const patch = { marketCap: 5_000_000, fdv: 5_000_000, priceChange: { m5: 3, h1: 10 }, volume: { m5: 30_000, h1: 300_000 } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-trim-')), seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-trim-seed-'));
  type Inner = { candidates: Map<string, { mint: string; status: string; updatedAt: number; rules?: unknown }> };
  try {
    // A real candidate as the template for the filler tokens.
    const seeder = await DeskEngine.create({ ...world(patch).shared, mode: 'PAPER', dir: seedDir, sender: null, wallet: () => ({ owner, signer: null }) });
    await seeder.defineStrategy(parseRuleSpec(BIG)); seeder.start(); await seeder.pulse();
    const seed = structuredClone((seeder as unknown as Inner).candidates.get(MINT)!);
    assert.ok(seed, 'template candidate');
    const engine = await DeskEngine.create({ ...world(patch).shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start();
    // More tokens than the desk keeps, all ranked above this one by FAIR's status (FAIR filters a $5M token).
    const inner = engine as unknown as Inner;
    for (let i = 0; i < DESK.maxCandidates + 10; i++) inner.candidates.set(tokenKey(300 + i), { ...structuredClone(seed), mint: tokenKey(300 + i), status: 'WATCHLIST', rules: undefined, updatedAt: Date.now() + 3_600_000 });
    await engine.defineStrategy(parseRuleSpec(BIG)); await engine.pulse();
    const view = engine.status({ connected: false, address: null });
    assert.deepEqual(view.positions.map(p => p.strategy), ['BIG'], 'trimmed before the custom strategies looked, it was never bought');
    assert.ok(inner.candidates.has(MINT)); assert.ok(inner.candidates.size <= DESK.maxCandidates + 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(seedDir, { recursive: true, force: true }); }
});

test('a custom strategy trades a $5M token FAIR filters out: holders and safety checked, own ledger, market-cap target exit, saved for restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-custom-')), { w, shared } = world({ marketCap: 5_000_000, fdv: 5_000_000, priceChange: { m5: 3, h1: 10 }, volume: { m5: 30_000, h1: 300_000 } });
  try {
    let engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    assert.equal(engine.status({ connected: false, address: null }).candidates.length, 0, 'without a custom strategy a $5M token is filtered');
    await engine.defineStrategy(parseRuleSpec(BIG));
    await engine.pulse();
    let view = engine.status({ connected: false, address: null });
    const c = view.candidates.find(x => x.mint === MINT)!;
    assert.equal(c.tier, 'CUSTOM'); assert.equal(c.status, 'WATCHLIST', 'never a FAIR entry');
    assert.equal(c.rules!.BIG!.signal, true, c.rules!.BIG!.summary);
    assert.ok(c.rules!.BIG!.checks.some(g => g.key === 'ruleHolders' && g.status === 'PASS' && g.actual === '2'));
    assert.equal(view.positions.length, 1); assert.equal(view.positions[0]!.strategy, 'BIG');
    assert.ok(engine.events.list().some(e => e.stage === 'QUALIFIED' && /^BIG entry selected: \$5,000,000 cap · 2 holders/.test(e.message)));
    const big = view.strategies.find(s => s.id === 'BIG')!;
    assert.equal(big.enabled, true, 'a new strategy starts ON in TEST'); assert.equal(big.spec!.exits.marketCapTargetUsd, 9_000_000);
    assert.ok(big.exitRules.includes('Exit when the market cap reaches $9,000,000') && big.exitRules.includes('Time stop after 7 days'), big.exitRules.join(' | '));
    await fs.access(path.join(dir, 'ledger-PAPER-BIG.json'));
    await assert.rejects(engine.removeStrategy('BIG'), /STRATEGY_HAS_POSITIONS/);
    await assert.rejects(engine.removeStrategy('FAIR'), /BUILTIN_STRATEGY/);
    w.priceFactor = 2;
    (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.BIG = 0; engine.tick(); await engine.settled();
    view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'sold at the market-cap target');
    assert.ok(engine.events.list().some(e => /^BIG · exit signal: MCAP_TARGET \$10,000,000 ≥ \$9,000,000/.test(e.message)));
    engine.setStrategy('BIG', false); engine.stop(); await engine.settled(); await engine.persist();
    engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const again = engine.status({ connected: false, address: null }).strategies.find(s => s.id === 'BIG')!;
    assert.equal(again.enabled, false, 'the switch survives a restart'); assert.equal(again.stats.trades, 1);
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, wallet: () => null });
    assert.equal(live.strategies.BIG!.enabled, false, 'LIVE starts every custom strategy OFF');
    await engine.removeStrategy('BIG');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'strategies.json'), 'utf8')).strategies, []);
    await fs.access(path.join(dir, 'ledger-PAPER-BIG.json'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a copycat (same ticker as an older token 3× bigger) is never entered: the second "Jane" that rugged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-copycat-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const original = pairRaw({ pairAddress: key(77).toBase58(), baseToken: { address: key(76).toBase58(), symbol: 'abc', name: 'Alpha original' },
      marketCap: 1_400_000, fdv: 1_400_000, pairCreatedAt: NOW - 3 * 3_600_000 });
    w.searchPairs = [original, { ...original, chainId: 'bsc' }, { chainId: 'solana', broken: true }];
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'the clone is refused');
    assert.ok(engine.events.list().some(e => /^CRASH · entry refused: COPYCAT of abc .+ \(\$1,400,000 · 1\d\d min older\)$/.test(e.message)),
      engine.events.list().filter(e => /COPYCAT|entry/.test(e.message)).map(e => e.message).join(' | '));
    assert.match(view.candidates.find(c => c.mint === MINT)!.entryNotes!.CRASH!, /^COPYCAT/);
    // WIRED on 1 Oct: the namesake was 5 days older and quieter — a revival, not a clone; it ran $75K → $2.7M.
    w.searchPairs = [{ ...original, pairCreatedAt: NOW - 5 * 86_400_000, volume: { m5: 100, h1: 2_000 } }];
    const revival = await DeskEngine.create({ ...shared, mode: 'PAPER', dir: await fs.mkdtemp(path.join(os.tmpdir(), 'desk-copycat-3-')), sender: null, wallet: () => ({ owner, signer: null }) });
    revival.start(); await revival.pulse();
    assert.equal(revival.status({ connected: false, address: null }).positions.length, 1, 'an old, quiet namesake does not make a copycat');
    w.searchPairs = [];
    const fresh = await DeskEngine.create({ ...shared, mode: 'PAPER', dir: await fs.mkdtemp(path.join(os.tmpdir(), 'desk-copycat-2-')), sender: null, wallet: () => ({ owner, signer: null }) });
    fresh.start(); await fresh.pulse();
    assert.equal(fresh.status({ connected: false, address: null }).positions.length, 1, 'without a bigger namesake the same signal is entered');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('LAUNCH: a fresh pump.fun launch with its own X account and website is bought on the curve 3–12 min after creation (CA not shown yet), with alerts', async () => {
  const curve = { dexId: 'pumpfun', liquidity: null, marketCap: 20_000, fdv: 20_000, pairCreatedAt: NOW - 5 * 60_000, priceChange: { m5: 12, h1: 40 } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-launch-')), { shared } = world(curve);
  try {
    const launch = { mint: MINT, name: 'Alpha', symbol: 'ABC', uri: 'https://meta/1', creator: null, at: Date.now() - 5 * 60_000, signature: 'S',
      meta: { description: 'Alpha does things on chain, every day.', twitter: 'https://x.com/alphaproj', website: 'https://alpha.example', telegram: null },
      x: parseXLink('https://x.com/alphaproj'), site, score: 8, reasons: ['own X account @alphaproj', 'website alpha.example ("Alpha")', 'website links the same X account'], shortlistedAt: null,
      xPage: null, xCheckedAt: null, siteCheckedAt: null, ca: { status: 'UNCONFIRMED' as const, detail: 'CA not posted by @alphaproj yet' }, clone: null,
      insiders: { wallets: [owner.toBase58()], creatorPct: 2, insiderPct: 9, slot: 1, detail: 'insiders hold 9.0%: dev 2.0% + 1 wallet in the creation slot' } };
    const alerts: Array<{ title: string; body: string }> = [];
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }),
      launches: { poll: async () => [launch], recent: () => [launch] }, notify: async (title, body) => { alerts.push({ title, body }); }, alerts: new Set(['launch']) });
    engine.setStrategy('CRASH', false); engine.start(); await engine.pulse();
    const view = engine.status({ connected: false, address: null });
    const c = view.candidates.find(x => x.mint === MINT)!;
    assert.equal(c.tier, 'ULTRA_EARLY'); assert.equal(c.launch!.signal.signal, true, c.launch!.signal.summary);
    assert.equal(view.positions.length, 1); assert.equal(view.positions[0]!.strategy, 'LAUNCH');
    assert.ok(engine.events.list().some(e => /^LAUNCH radar: ABC "Alpha" 5 min old · score 8 · own X account @alphaproj/.test(e.message)));
    assert.ok(engine.events.list().some(e => /^LAUNCH entry selected: score 8 · 5\.\d min old · \$20,000 cap/.test(e.message)));
    assert.deepEqual(alerts.map(a => a.title), ['LAUNCH entry-ready: ABC'], 'the shortlist itself is radar news: not on the phone unless asked for');
    assert.match(alerts[0]!.body, new RegExp(`https://fomo.family/tokens/solana/${MINT}$`));
    assert.equal(view.launches![0]!.status, 'held by LAUNCH'); assert.equal(view.launches![0]!.marketCapUsd, 20_000);
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, wallet: () => null });
    assert.equal(live.strategies.LAUNCH.enabled, false, 'LIVE starts LAUNCH off');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('LAUNCH: the project posting the CA on X allows an entry from 1 min; unconfirmed waits for 3 min; an exposed impersonator is never bought', async () => {
  const curve = { dexId: 'pumpfun', liquidity: null, marketCap: 9_000, fdv: 9_000, pairCreatedAt: NOW - 90_000, priceChange: { m5: 12, h1: 40 } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-launch-ca-')), { shared } = world(curve);
  try {
    const launch = { mint: MINT, name: 'Pot Potato', symbol: 'ABC', uri: 'https://meta/1', creator: null, at: Date.now() - 90_000, signature: 'S',
      meta: { description: null, twitter: 'https://x.com/alphaproj', website: 'https://alpha.example', telegram: null },
      x: parseXLink('https://x.com/alphaproj'), site, score: 8, reasons: ['own X account @alphaproj', 'website alpha.example ("Alpha")', 'website links the same X account'],
      shortlistedAt: null, xPage: null, xCheckedAt: null, siteCheckedAt: null, clone: null,
      ca: { status: 'UNCONFIRMED' as 'UNCONFIRMED' | 'X' | 'IMPERSONATOR', detail: 'CA not posted by @alphaproj yet' },
      insiders: { wallets: [owner.toBase58()], creatorPct: 2, insiderPct: 9, slot: 1, detail: 'insiders hold 9.0%: dev 2.0% + 1 wallet in the creation slot' } as { wallets: string[]; creatorPct: number; insiderPct: number; slot: number; detail: string } | undefined };
    const alerts: string[] = [];
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }),
      launches: { poll: async () => [], recent: () => [launch] }, notify: async title => { alerts.push(title); } });
    engine.setStrategy('CRASH', false); engine.start(); await engine.pulse();
    let view = engine.status({ connected: false, address: null }), c = view.candidates.find(x => x.mint === MINT)!;
    assert.equal(view.positions.length, 0); assert.match(c.launch!.signal.summary, /^Minutes since launch: 1\.\d min \(3–12 min \(1 min once the CA is confirmed\)\)/);
    // The radar's next X read finds the dev's post with this CA.
    Object.assign(launch, { score: 11, ca: { status: 'X', detail: '@alphaproj posted this CA' } });
    await engine.pulse();
    view = engine.status({ connected: false, address: null }); c = view.candidates.find(x => x.mint === MINT)!;
    assert.equal(view.positions.length, 1, c.launch!.signal.summary); assert.equal(view.positions[0]!.strategy, 'LAUNCH');
    assert.ok(engine.events.list().some(e => /^LAUNCH radar: ABC @alphaproj posted this CA \(\d min old\) · score 11/.test(e.message)));
    assert.ok(engine.events.list().some(e => /^LAUNCH entry selected: score 11 · 1\.\d min old · \$9,000 cap .* · @alphaproj posted this CA$/.test(e.message)));
    assert.equal(view.launches![0]!.ca!.status, 'X');

    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-launch-fake-'));
    const fake = { ...launch, at: Date.now() - 2 * 60_000, score: 8, ca: { status: 'UNCONFIRMED' as const, detail: 'CA not posted by @alphaproj yet' } };
    const other = await DeskEngine.create({ ...shared, mode: 'PAPER', dir: dir2, sender: null, wallet: () => ({ owner, signer: null }),
      launches: { poll: async () => [], recent: () => [fake] }, notify: async title => { alerts.push(title); }, alerts: new Set(['radar', 'launch']) });
    other.setStrategy('CRASH', false);
    Object.assign(fake, { score: 0, ca: { status: 'IMPERSONATOR', detail: 'IMPERSONATOR: @alphaproj shows CA 3Bdw…pump, not this token' } });
    other.start(); await other.pulse();
    assert.equal(other.status({ connected: false, address: null }).launches!.length, 0, 'an impersonator never reaches the shortlist');
    // Shortlisted while unconfirmed (2 min old: waiting), exposed on a later read: reported once, never bought, not even after 3 min.
    Object.assign(fake, { score: 8, ca: { status: 'UNCONFIRMED', detail: '' } }); await other.pulse();
    assert.equal(other.status({ connected: false, address: null }).positions.length, 0);
    Object.assign(fake, { score: 0, at: Date.now() - 5 * 60_000, ca: { status: 'IMPERSONATOR', detail: 'IMPERSONATOR: @alphaproj shows CA 3Bdw…pump, not this token' } });
    await other.pulse(); await other.pulse();
    const v2 = other.status({ connected: false, address: null }), c2 = v2.candidates.find(x => x.mint === MINT)!;
    assert.equal(v2.positions.length, 0); assert.equal(c2.launch!.signal.signal, false);
    assert.equal(c2.launch!.signal.checks.find(g => g.key === 'launchCa')!.status, 'FAIL');
    assert.equal(other.events.list().filter(e => /^LAUNCH radar: ABC IMPERSONATOR: @alphaproj shows CA 3Bdw…pump, not this token — never bought$/.test(e.message)).length, 1);
    assert.equal(alerts.filter(a => a === 'LAUNCH radar: ABC is an IMPERSONATOR').length, 1);
    await fs.rm(dir2, { recursive: true, force: true });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('LAUNCH rug defence: insiders selling is a RUG exit (remembered); insiders still holding at 92% curve progress means selling before graduation; what they sold before the entry is not a sale', async () => {
  const curve = { dexId: 'pumpfun', liquidity: null, marketCap: 20_000, fdv: 20_000, pairCreatedAt: NOW - 5 * 60_000, priceChange: { m5: 12, h1: 40 } };
  const INS = key(77).toBase58();
  for (const scenario of ['dump', 'graduation', 'sold-before'] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `desk-rug-${scenario}-`)), { w, shared } = world(curve);
    try {
      // The radar measured 14.7 % at launch; in 'sold-before' the insiders already hold only 9 % when the desk buys.
      w.insider = INS; w.insiderRaw = scenario === 'sold-before' ? 90_000_000_000_000n : 147_000_000_000_000n;
      const launch = { mint: MINT, name: 'Pot Potato', symbol: 'ABC', uri: 'https://meta/1', creator: INS, at: Date.now() - 5 * 60_000, signature: 'S',
        meta: { description: null, twitter: 'https://x.com/alphaproj', website: 'https://alpha.example', telegram: null }, x: parseXLink('https://x.com/alphaproj'), site,
        score: 8, reasons: ['own X account @alphaproj'], shortlistedAt: null, xPage: null, xCheckedAt: null, siteCheckedAt: null, clone: null,
        ca: { status: 'UNCONFIRMED' as const, detail: '' }, insiders: { wallets: [INS], creatorPct: 5.1, insiderPct: 14.7, slot: 1, detail: 'insiders hold 14.7%: dev 5.1% + 3 wallets in the creation slot' } };
      const rugs: Array<{ mint: string; reason: string }> = [], alerts: string[] = [];
      const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }), notify: async t => { alerts.push(t); },
        alerts: scenario === 'dump' ? new Set(['rug']) : undefined,
        launches: { poll: async () => [], recent: () => [launch], markRug: async (mint, reason) => { rugs.push({ mint, reason }); } } });
      engine.setStrategy('CRASH', false); engine.start(); await engine.pulse();
      let view = engine.status({ connected: false, address: null });
      assert.equal(view.positions.length, 1, view.candidates[0]?.launch?.signal.summary);
      const held = (await fs.readFile(path.join(dir, 'ledger-PAPER-LAUNCH.json'), 'utf8'));
      assert.match(held, /"insiders": \[\s*"[^"]+"\s*\]/); assert.match(held, /"insiderPctAtEntry": 14\.7/); assert.match(held, /"onCurve": true/);
      const inner = engine as unknown as { insiderChecks: Map<string, number>; creatorChecks: Map<string, number>; ledgerOf(id: string): { position(m: string): { insiderPctAtEntry?: number | null; creatorPctAtEntry?: number | null } | null } };
      if (scenario === 'sold-before') {
        await engine.pulse(); inner.insiderChecks.clear(); inner.creatorChecks.clear(); await engine.pulse();
        view = engine.status({ connected: false, address: null });
        assert.equal(view.positions.length, 1, 'held: the insiders sold before the entry, not after it');
        assert.equal(engine.events.list().filter(e => e.stage === 'EXIT').length, 0);
        const p = inner.ledgerOf('LAUNCH').position(MINT)!;
        assert.equal(p.insiderPctAtEntry, 9, 'the baseline is what they held at the first check after the entry');
        assert.equal(p.creatorPctAtEntry, 9);
        assert.equal(rugs.length, 0);
        continue;
      }
      if (scenario === 'dump') { await engine.pulse(); inner.insiderChecks.clear(); w.insiderRaw = 90_000_000_000_000n; }
      else { const b = Buffer.alloc(151); b.writeBigUInt64LE(63_448_000_000_000n, 24); w.curve = b; }
      await engine.pulse();
      view = engine.status({ connected: false, address: null });
      assert.equal(view.positions.length, 0, `${scenario}: sold`);
      const exit = engine.events.list().find(e => e.stage === 'EXIT' && /exit signal/.test(e.message))!.message;
      if (scenario === 'dump') {
        assert.match(exit, /^LAUNCH · exit signal: RUG insiders sold: they hold 9\.0% \(was 14\.7% at entry\)$/);
        assert.deepEqual(rugs.map(r => r.mint), [MINT], 'remembered: its creator, X account and website never get an entry again');
        assert.ok(alerts.includes('ABC: RUG — selling'), 'with DESK_ALERTS=rug the rug sale reaches the phone');
      } else {
        assert.match(exit, /^LAUNCH · exit signal: PRE_GRADUATION curve 92% full while insiders hold 14\.7%/);
        assert.equal(rugs.length, 0, 'a precaution, not a rug');
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('OPEN: a breakout above a strong opening candle is bought, scaled into at 2× and 4×, held to 6×, then trailed', async () => {
  const curve = { dexId: 'pumpfun', liquidity: null, marketCap: 28_000, fdv: 28_000, pairCreatedAt: NOW - 6 * 60_000, priceChange: { m5: 12, h1: 40 } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-open-')), { w, shared } = world(curve);
  try {
    const signal = { mint: MINT, symbol: 'ABC', name: 'Fantasy Index 6900', at: Date.now() - 6 * 60_000, status: 'SIGNAL' as const, openHighUsd: 20_000, lowUsd: 7_000,
      lastUsd: 27_000, peakUsd: 27_000, firstSampleAt: Date.now() - 350_000, lastSampleAt: Date.now(), signalAt: Date.now(), signalUsd: 27_000,
      detail: '$20.0K open → low $7.0K (held $6.7K) → $27.0K: broke above the opening high', samples: [] };
    let pending = [signal];
    const tracker = { observe: () => undefined, poll: async () => { const out = pending; pending = []; return out; }, get: () => null, list: () => [signal],
      counts: () => ({ OPENING: 3, STRONG: 1, SIGNAL: 1, WEAK: 9, RUG: 2, GRADUATED: 0, EXPIRED: 0, UNKNOWN_OPEN: 0 }) };
    const alerts: Array<{ title: string; body: string; click: string | null | undefined }> = [];
    // No 60 s settling period in this test (positions are seconds old).
    const profiles = strategyProfiles({}, shared.capital, shared.cfg.rs);
    profiles.OPEN = { ...profiles.OPEN, exits: { ...profiles.OPEN.exits, graceMs: 0 } };
    const engine = await DeskEngine.create({ ...shared, strategies: profiles, mode: 'PAPER', retired: new Set(), dir, sender: null, wallet: () => ({ owner, signer: null }), opening: tracker as never,
      notify: async (title, body, o) => { alerts.push({ title, body, click: o?.click }); }, alerts: new Set(['open']) });
    engine.setStrategy('CRASH', false); engine.setStrategy('LAUNCH', false); engine.start();
    await engine.pulse();
    const fresh = await engine.openingPass();
    assert.equal(fresh.length, 1);
    assert.deepEqual(alerts.map(a => a.title), ['OPEN ABC x-- at $27.0K'], 'every breakout reaches the phone (owner, 6 Oct), the 6-min one too');
    assert.ok(engine.events.list().some(e => /^OPEN screen: ABC "Fantasy Index 6900"/.test(e.message)));
    await engine.pulse();
    let view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 1, view.candidates.find(c => c.mint === MINT)?.open?.signal.summary); assert.equal(view.positions[0]!.strategy, 'OPEN');
    assert.ok(engine.events.list().some(e => /^OPEN entry selected: open \$20\.0K · breakout \$27\.0K/.test(e.message)));
    assert.equal(view.opening!.counts.SIGNAL, 1);
    // 2× and 4× the first entry: one add each, in order.
    w.priceFactor = 2.1; await engine.pulse();
    w.priceFactor = 4.3; await engine.pulse();
    view = engine.status({ connected: false, address: null });
    const p = view.positions[0]!;
    // (The test world quotes buys at a fixed price, so the average price itself does not move here.)
    assert.equal(p.adds, 2); assert.ok(p.firstEntryPriceUsd! > 0, 'the first entry price is kept for the multiples');
    assert.equal(engine.events.list().filter(e => /^OPEN · position increased \(add [12]\)/.test(e.message)).length, 2);
    // A 35% pullback at 4.3× is held ("stay in for at least 6×"); after 6× the trailing stop sells.
    w.priceFactor = 2.8; await engine.pulse();
    assert.equal(engine.status({ connected: false, address: null }).positions.length, 1, 'held below 6×');
    w.priceFactor = 7; await engine.pulse(); w.priceFactor = 4.5; await engine.pulse();
    view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'sold by the trailing stop after 6×');
    assert.ok(engine.events.list().some(e => /^OPEN · exit signal: TRAILING_STOP/.test(e.message)));
    const stats = view.strategies.find(s => s.id === 'OPEN')!.stats;
    assert.equal(stats.trades, 1, 'the adds belong to one trade'); assert.ok(stats.netPnlUsd > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('OPEN screen: a copycat breakout (bigger, older namesake) is never alerted or bought', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-open-copy-')), { w, shared } = world({ dexId: 'pumpfun', liquidity: null, marketCap: 28_000, fdv: 28_000 });
  try {
    w.searchPairs = [pairRaw({ pairAddress: key(78).toBase58(), baseToken: { address: key(79).toBase58(), symbol: 'ABC', name: 'Fantasy Index 6900' },
      marketCap: 520_000, fdv: 520_000, pairCreatedAt: Date.now() - 30 * 60_000 })];
    const signal = { mint: MINT, symbol: 'ABC', name: 'Fantasy Index 6900', at: Date.now() - 4 * 60_000, status: 'SIGNAL' as const, openHighUsd: 12_000, lowUsd: 8_000,
      lastUsd: 16_000, peakUsd: 16_000, firstSampleAt: null, lastSampleAt: Date.now(), signalAt: Date.now(), signalUsd: 16_000, detail: 'x', samples: [] };
    let pending = [signal];
    const tracker = { observe: () => undefined, poll: async () => { const out = pending; pending = []; return out; }, get: () => null, list: () => [], counts: () => ({}) };
    const alerts: string[] = [];
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }), opening: tracker as never, notify: async t => { alerts.push(t); } });
    engine.start(); await engine.pulse();
    assert.deepEqual(await engine.openingPass(), []);
    assert.deepEqual(alerts, []);
    assert.ok(engine.events.list().some(e => /^OPEN screen: ABC broke out \(x\) but COPYCAT of ABC .+ \(\$520,000, \d+ min older\) — no alert, never bought$/.test(e.message)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('opening screen on the phone: every breakout, coloured by its speed (×2.1–2.9 the target), tap opens FOMO; an own channel and an hourly cap when configured', async () => {
  const curve = { dexId: 'pumpfun', liquidity: null, marketCap: 28_000, fdv: 28_000, pairCreatedAt: NOW - 6 * 60_000, priceChange: { m5: 12, h1: 40 } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-open-phone-')), { shared } = world(curve);
  try {
    const at = Date.now();
    // First read → breakout at $28.9K: ×8.5 (fast), ×2.4 (the target band), ×1.5 (standard).
    const sprint = (i: number, secs: number, firstUsd: number) => ({ mint: key(60 + i).toBase58(), symbol: `S${i}`, name: `Sprint ${i}`, at: at - secs * 1000, status: 'SIGNAL' as const,
      openHighUsd: 10_000, lowUsd: 7_000, lastUsd: 28_900, peakUsd: 31_000, firstSampleAt: at - secs * 1000 + 3_000, lastSampleAt: at, signalAt: at, signalUsd: 28_900,
      detail: '$10.0K open → $28.9K: broke above the opening high', samples: [[at - secs * 1000 + 3_000, firstUsd]] as Array<[number, number]> });
    const tracker = (list: ReturnType<typeof sprint>[]) => {
      let pending = list;
      return { observe: () => undefined, poll: async () => { const out = pending; pending = []; return out; }, get: () => null, list: () => [], counts: () => ({}) };
    };
    type Sent = { title: string; body: string; click: string | null | undefined; priority: string | undefined; tags: string[] | undefined };
    const alerts: Sent[] = [], own: Sent[] = [];
    const push = (to: Sent[]) => async (title: string, body: string, o?: NotifyOptions) => { to.push({ title, body, click: o?.click, priority: o?.priority, tags: o?.tags }); };
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', retired: new Set(), dir, sender: null, wallet: () => ({ owner, signer: null }),
      opening: tracker([sprint(0, 68, 3_400), sprint(1, 300, 12_000), sprint(2, 62, 19_300)]) as never, notify: push(alerts), alerts: new Set(['open']) });
    for (const id of ['FAIR', 'CRASH', 'LAUNCH', 'OPEN', 'GOLDEN']) engine.setStrategy(id, false);
    await engine.openingPass();
    assert.deepEqual(alerts.map(a => [a.title, a.priority, a.tags?.[0]]), [['OPEN S0 x8.5 at $28.9K', 'default', 'red_circle'], ['OPEN S1 x2.4 at $28.9K', 'high', 'yellow_circle'],
      ['OPEN S2 x1.5 at $28.9K', 'low', 'large_blue_circle']], 'every breakout, the 5-minute one too, with its colour');
    assert.match(alerts[1]!.body, /^🎯 \[TARGET SWEET SPOT\] Sprint 1 \(\$S1\)\n• Velocity Speed: 2\.4\n• Open: \$10\.0K ➔ Now: \$28\.9K\n• Low: \$7\.0K \| Peak: \$31\.0K\n• Age: 5m\n• CA: `/);
    assert.match(alerts[0]!.body, /^⚡ \[HIGH SPEED\]/); assert.match(alerts[2]!.body, /^👀 \[STANDARD DETECT\]/); assert.match(alerts[0]!.body, /Not a qualified call/);
    assert.equal(alerts[0]!.click, `https://fomo.family/tokens/solana/${key(60).toBase58()}`, 'tapping the notification opens the coin in FOMO');
    assert.equal(engine.events.list().filter(e => /^OPEN screen: S\d/.test(e.message)).length, 3, 'every breakout is shown');
    // An own channel (DESK_OPENING_NTFY_TOPIC) and an hourly cap from the config block.
    const cap = OPENING_SCREEN_ALERT_CONFIG.maxPerHour;
    OPENING_SCREEN_ALERT_CONFIG.maxPerHour = 1;
    try {
      const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-open-own-')), main: Sent[] = [];
      const capped = await DeskEngine.create({ ...world(curve).shared, mode: 'PAPER', retired: new Set(), dir: dir2, sender: null, wallet: () => ({ owner, signer: null }),
        opening: tracker([sprint(3, 60, 12_000), sprint(4, 61, 12_000)]) as never, notify: push(main), openingNotify: push(own), alerts: new Set(['open']) });
      await capped.openingPass();
      assert.deepEqual(own.map(a => a.title), ['OPEN S3 x2.4 at $28.9K'], 'the second breakout this hour is over the cap of 1');
      assert.deepEqual(main, [], 'the main channel (rug alerts) is not used');
      await fs.rm(dir2, { recursive: true, force: true });
    } finally { OPENING_SCREEN_ALERT_CONFIG.maxPerHour = cap; }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('GOLDEN POCKET: an only-up fill on a fresh pool is alerted, bought in TEST with the pattern stop, and sold when the pool trades under it; a retest is shown only', async () => {
  const pool = { pairCreatedAt: Date.now() - 3 * 60_000, priceChange: { m5: 30, h1: 30 }, volume: { m5: 60_000, h1: 60_000 }, marketCap: 113_000, fdv: 113_000 };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-golden-')), { shared } = world(pool);
  try {
    const at = Date.now();
    const entry = { kind: 'ONLY_UP' as const, at, price: 112_000, stop: 104_500, resistance: 112_000, zone: [110_000, 123_200] as [number, number],
      detail: 'first 2 candles only up to $112.0K → back to $112.0K, within 12% of candle 2 ($110.0K), stop $104.5K' };
    const retest = { ...entry, kind: 'RETEST' as const, detail: '$162.8K → $107.7K → $225.0K → retest at $167.7K' };
    const watch = { mint: MINT, symbol: 'ABC', startAt: at - 3 * 60_000, state: { phase: 'ENTRY', high: null, low: null, top: null, detail: entry.detail, entry },
      pool: 'P', vaults: null, resolveTries: 0, lastUsd: 113_000, lastSampleAt: Date.now(), peakUsd: 113_000 };
    const other = key(81).toBase58();
    const rug = key(82).toBase58();
    let pending = [{ mint: MINT, symbol: 'ABC', entry, at, pool: 'P', poolJumpX: 1.1 }, { mint: other, symbol: 'RET', entry: retest, at, pool: 'Q' },
      { mint: rug, symbol: 'RUG', entry: { ...entry, price: 5_260_000 }, at, pool: 'R', poolJumpX: 109 }];
    const held: string[][] = [];
    const tracker = { watchGraduations: () => undefined, hold: (m: string[]) => { held.push(m); }, poll: async () => { const out = pending; pending = []; return out; },
      get: (m: string) => m === MINT ? { ...watch, lastSampleAt: Date.now() } : null, list: () => [watch], counts: () => ({ IMPULSE: 4, DIP: 2, BROKEN_OUT: 1, ENTRY: 1, FAILED: 9, EXPIRED: 0, watched: 17 }) };
    const alerts: string[] = [], bodies: string[] = [], phone = new Set<'golden'>(['golden']);
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }), golden: tracker as never,
      notify: async (title, body) => { alerts.push(title); bodies.push(body); }, alerts: phone });
    for (const id of ['FAIR', 'CRASH', 'LAUNCH', 'OPEN']) engine.setStrategy(id, false);
    engine.setStrategy('GOLDEN', true);
    engine.start(); await engine.pulse();
    const fresh = await engine.goldenPass();
    assert.deepEqual(fresh.map(f => f.symbol), ['ABC'], 'the retest is not a GOLDEN entry by default');
    assert.deepEqual(alerts, ['GOLDEN POCKET: ABC at $112.0K'], 'the pool that opened at 109× its graduation value is not alerted');
    assert.match(bodies[0]!, /pool opened at 1\.1× its graduation value/); assert.match(bodies[0]!, /Not a qualified call/);
    assert.ok(engine.events.list().some(e => /^GOLDEN POCKET: RUG filled .* but its pool opened at 109\.0× its graduation value \(> 3×\) — no alert, never bought$/.test(e.message)));
    assert.ok(engine.events.list().some(e => /^GOLDEN POCKET \(shown only\): RET · \$162\.8K/.test(e.message)));
    await engine.pulse();
    let view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 1, view.candidates.find(c => c.mint === MINT)?.golden?.signal.summary); assert.equal(view.positions[0]!.strategy, 'GOLDEN');
    assert.ok(engine.events.list().some(e => /^GOLDEN POCKET entry selected: first 2 candles only up/.test(e.message)));
    assert.match(await fs.readFile(path.join(dir, 'ledger-PAPER-GOLDEN.json'), 'utf8'), /"stopUsd": 104500/);
    assert.equal(view.golden!.counts.watched, 17); assert.equal(view.golden!.list[0]!.entry!.stopUsd, 104_500); assert.deepEqual(view.golden!.entryKinds, ['ONLY_UP']);
    await engine.goldenPass();
    assert.ok(held.at(-1)!.includes(MINT), 'a held token stays sampled for its exits');
    // The pool trades under the pattern stop: sold at once, whatever the percentage loss.
    watch.lastUsd = 104_000;
    await engine.pulse();
    view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0);
    assert.ok(engine.events.list().some(e => /^GOLDEN · exit signal: POCKET_STOP \$104,000 ≤ \$104,500/.test(e.message)));
    // The pools are read only while someone uses them: GOLDEN on, golden phone alerts, or a GOLDEN position.
    engine.setStrategy('GOLDEN', false);
    assert.equal(engine.goldenWanted(), true, 'golden alerts still go to the phone');
    phone.delete('golden');
    assert.equal(engine.goldenWanted(), false);
    await engine.pulse();
    assert.match(engine.status({ connected: false, address: null }).sources['Golden pocket (graduated pools, every 4 s)']!, /^paused/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a sell spends at most 1% of its value on priority fee (floor 50,000 lamports), and TEST closes the emptied token account on paper', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-exit-fee-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    engine.start(); await engine.pulse();
    w.priceFactor = 0.6;
    (engine as unknown as { lastPositionCheckAt: Record<string, number> }).lastPositionCheckAt.CRASH = 0; engine.tick(); await engine.settled();
    const view = engine.status({ connected: false, address: null });
    assert.equal(view.positions.length, 0, 'the stop loss sold');
    const sell = w.priorityCaps.filter(c => c.side === 'SELL').at(-1)!;
    assert.equal(sell.maxLamports, Number(sell.notional / 100n), '1% of the ~0.012 SOL the sell returns, not the full 300,000-lamport cap');
    assert.ok(sell.maxLamports < 300_000);
    const row = view.ledger.find(e => e.side === 'SELL')!;
    assert.equal(row.rentOutstandingLamports, undefined); assert.match(row.note ?? '', /account rent 0\.00203928 SOL reclaimed/);
    assert.ok(engine.events.list().some(e => /TEST — token account closed on paper: 0\.002039 SOL rent returned/.test(e.message)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rent reclaim closes only empty desk-token accounts, simulates first, and never signs a transaction that would pay the wallet more', async () => {
  const kp = Keypair.fromSeed(new Uint8Array(32).fill(7)), me = kp.publicKey, [SOLD, HELD, OTHER] = [tokenKey(140), tokenKey(141), tokenKey(142)];
  const account = (n: number, mint: string, amount: string) => ({ pubkey: key(150 + n), account: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0,
    data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint, owner: me.toBase58(), state: 'initialized', tokenAmount: { amount, decimals: 6, uiAmount: 0, uiAmountString: '0' } } } } } });
  let gain = 2_039_280 - 5_080, signed = 0, sent: VersionedTransaction | null = null;
  const conn = {
    getParsedTokenAccountsByOwner: async (_o: PublicKey, f: { programId?: PublicKey }) => ({ value: f.programId?.equals(TOKEN_PROGRAM_ID) ? [account(0, SOLD, '0'), account(1, HELD, '5'), account(2, OTHER, '0')] : [] }),
    getLatestBlockhash: async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: 5_080 }), getBalance: async () => 10_000_000,
    simulateTransaction: async () => ({ value: { err: null, accounts: [{ lamports: 10_000_000 + gain, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false }] } }),
  };
  const rpc = { execute: (_l: string, fn: (c: typeof conn) => unknown) => fn(conn) };
  const signer: TransactionSigner = { publicKey: me, signTransaction: async tx => { signed++; tx.sign([kp]); return tx; } };
  const sender = { sendAndConfirm: async (tx: VersionedTransaction) => { sent = tx; return { signature: 'close-sig', slot: 1 }; } };
  const d = { rpc: rpc as never, sender: sender as never, owner: me, signer };
  const r = await reclaimRent({ ...d, mints: [SOLD, HELD] });
  assert.equal(r!.signature, 'close-sig'); assert.deepEqual(r!.accounts.map(a => a.mint), [SOLD], 'a non-empty account and a token the desk never traded are left alone');
  assert.equal(r!.reclaimedLamports, 2_039_280n); assert.equal(r!.feeLamports, 5_080n); assert.equal(signed, 1);
  const ix = sent!.message.compiledInstructions.map(i => sent!.message.staticAccountKeys[i.programIdIndex]!.toBase58());
  assert.deepEqual(ix, ['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', TOKEN_PROGRAM_ID.toBase58()], 'only compute budget and one CloseAccount');
  assert.equal(await reclaimRent({ ...d, mints: [OTHER.slice(0, 5)] }), null, 'nothing to close');
  gain = 3_000_000;
  await assert.rejects(reclaimRent({ ...d, mints: [SOLD] }), /RENT_SIMULATION_MISMATCH/); assert.equal(signed, 1, 'not signed');
});

test('holders: count of owners with a balance, largest holders marked wallet/program, and a clear note when the RPC cannot count', async () => {
  for (const unsupported of [false, true]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-holders-')), { w, shared } = world(YOUNG_PUMP, 'insider');
    w.dasUnsupported = unsupported;
    try {
      const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
      engine.start(); await engine.pulse();
      const h = engine.status({ connected: false, address: null }).candidates.find(c => c.mint === MINT)!.holders!;
      assert.equal(h.top[0]!.kind, 'PROGRAM', 'the pool vault (off-curve owner) is shown but not counted as a whale'); assert.equal(h.top[0]!.pct, 30);
      assert.equal(h.top.filter(x => x.kind === 'WALLET').length, 10); assert.equal(h.top10WalletPct, 20);
      if (!unsupported) { assert.equal(h.count, 2, 'distinct owners with a non-zero balance'); assert.equal(h.countCapped, false); }
      else { assert.equal(h.count, null); assert.match(h.countNote!, /DAS getTokenAccounts/); }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('strategy and drill toggles survive a restart; LIVE keeps CRASH off until the owner switches it on', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-settings-')), { shared } = world();
  try {
    const paper = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    paper.setStrategy('FAIR', false); paper.setDrill(true); await paper.settled();
    const again = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(again.strategies.FAIR.enabled, false); assert.equal(again.drill, true);
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(live.strategies.CRASH.enabled, false, 'never on by default with real funds');
    assert.throws(() => live.setDrill(true), /DRILL_TEST_ONLY/);
    live.setStrategy('CRASH', true); await live.settled();
    const liveAgain = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(liveAgain.strategies.CRASH.enabled, true, "the owner's explicit choice is kept across restarts");
    assert.equal(liveAgain.strategies.FAIR.enabled, true, 'TEST toggles never leak into LIVE');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('local-key signer: opt-in only, reads the key from .env, checks it against the public key and never reveals it', async () => {
  assert.deepEqual(liveSignerSettings({}), { signer: 'PHANTOM', maxEntries: 10 });
  assert.deepEqual(liveSignerSettings({ DESK_LIVE_SIGNER: 'local-key', DESK_LIVE_MAX_ENTRIES: '4' }), { signer: 'LOCAL_KEY', maxEntries: 4 });
  assert.throws(() => liveSignerSettings({ DESK_LIVE_SIGNER: 'yes' }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-key-'));
  try {
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(7)), secret = bs58.encode(kp.secretKey);
    await fs.writeFile(path.join(dir, '.env'), `WALLET_PRIVATE_KEY=${secret}\nWALLET_PUBLIC_KEY=${kp.publicKey.toBase58()}\n`);
    const signer = await localKeySigner(dir);
    assert.equal(signer.publicKey.toBase58(), owner.toBase58());
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [] }).compileToV0Message());
    const signed = await signer.signTransaction(tx, { expiresAt: Date.now() + 10_000 });
    assert.ok(signed.signatures[0]!.some(b => b !== 0), 'signed');
    assert.ok(!JSON.stringify(signer).includes(secret), 'the secret is not reachable from the signer object');
    await fs.writeFile(path.join(dir, '.env'), `WALLET_PRIVATE_KEY=${secret}\nWALLET_PUBLIC_KEY=${key(9).toBase58()}\n`);
    const mismatch = await localKeySigner(dir).then(() => null, (e: Error) => e);
    assert.match(mismatch!.message, /LOCAL_KEY_MISMATCH/); assert.ok(!mismatch!.message.includes(secret), 'errors never contain the key');
    await fs.writeFile(path.join(dir, '.env'), 'WALLET_PRIVATE_KEY=not-a-key\n');
    await assert.rejects(localKeySigner(dir), /LOCAL_KEY_INVALID/);
    await fs.writeFile(path.join(dir, '.env'), 'WALLET_PUBLIC_KEY=x\n');
    await assert.rejects(localKeySigner(dir), /LOCAL_KEY_MISSING/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('LIVE with the local key signs without any approval, persists the signature before broadcast, halts on an unknown outcome, and caps entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-live-key-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const signer: TransactionSigner = { publicKey: kp.publicKey, signTransaction: async tx => { w.signRequests++; tx.sign([kp]); return tx; } };
    const sender = { sendAndConfirm: async () => { w.sends++; throw new Error('RPC unreachable'); } };
    const engine = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: sender as never, signerKind: 'LOCAL_KEY', liveMaxEntries: 2,
      authorized: () => true, wallet: () => ({ owner: kp.publicKey, signer }) });
    engine.setStrategy('CRASH', true); await engine.prepareStart(); engine.start();
    let view = engine.status({ connected: false, address: null });
    assert.equal(view.signer, 'LOCAL_KEY'); assert.equal(view.entriesLeft, 2); assert.equal(view.wallet.source, 'LOCAL_KEY');
    assert.match(view.label, /SIGNED BY THE LOCAL KEY/);
    await engine.pulse();
    view = engine.status({ connected: false, address: null });
    assert.equal(w.signRequests, 1, 'signed locally, no browser involved'); assert.equal(w.sends, 1);
    assert.ok(engine.events.list().some(e => /^Signed by the local key; signature persisted before broadcast: \w+/.test(e.message)));
    assert.equal(view.halted, 'TRANSACTION_RECONCILIATION_REQUIRED', 'a signed order whose outcome is unknown halts; nothing is retried');
    assert.equal(view.scanner, false); assert.equal(view.ledger[0]!.status, 'UNKNOWN');
    assert.throws(() => engine.start(), /TRANSACTION_RECONCILIATION_REQUIRED/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('WATCH sale: only LIVE with the local key, through the guarded path; a sale the wallet cannot cover is never signed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-watch-sell-')), { w, shared } = world(YOUNG_PUMP, 'insider');
  try {
    const sale = { mint: MINT, symbol: 'ABC', amountRaw: 1_000_000_000n, decimals: 6, reason: 'MCAP_FLOOR $29.00M ≤ $30.00M', onSigned: async () => {} };
    const paper = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    await assert.rejects(paper.sellHolding(sale), /LOCAL_KEY_REQUIRED/);
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const signer: TransactionSigner = { publicKey: kp.publicKey, signTransaction: async tx => { w.signRequests++; tx.sign([kp]); return tx; } };
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: { sendAndConfirm: async () => { w.sends++; throw new Error('unreachable'); } } as never,
      signerKind: 'LOCAL_KEY', authorized: () => true, wallet: () => ({ owner: kp.publicKey, signer }) });
    // The fixture wallet holds none of the token: the guard refuses before anything is built, signed or sent.
    await assert.rejects(live.sellHolding(sale));
    assert.equal(w.signRequests, 0); assert.equal(w.sends, 0);
    const events = live.events.list().map(e => e.message);
    assert.ok(events.some(m => /^WATCH · exit signal: MCAP_FLOOR \$29\.00M ≤ \$30\.00M; selling 1000 from the wallet$/.test(m)), events.slice(0, 5).join(' | '));
    assert.ok(events.includes('WATCH · sale failed: UNTRACKED_POSITION'), 'the guard checks the wallet really holds what it sells');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the wallet balance is read while the scanner is off, so the dashboard shows it before a session starts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-idle-')), { w, shared } = world();
  try {
    const engine = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    assert.equal(engine.status({ connected: false, address: null }).capital.walletSol, null);
    engine.tick(); await engine.settled();
    const c = engine.status({ connected: false, address: null }).capital;
    assert.equal(c.walletSol, w.native / 1e9); assert.equal(c.solUsd, 100); assert.ok(c.lastWalletSync);
    engine.tick(); await engine.settled();
    assert.equal(engine.events.list().filter(e => e.stage === 'SCANNING').length, 0, 'no scan, no order: a balance read only');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('execution path: built from the running desk — every enabled strategy, and the wallet and signer as they really are (address only in TEST, local key or Phantom in LIVE)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-path-')), { shared } = world();
  try {
    const layer = (p: Array<{ layer: string; provider: string }>, name: RegExp) => p.find(x => name.test(x.layer))?.provider ?? '';
    const paper = await DeskEngine.create({ ...shared, mode: 'PAPER', dir, sender: null, wallet: () => ({ owner, signer: null }) });
    const p = paper.status({ connected: false, address: null }).path;
    const short = `${owner.toBase58().slice(0, 4)}…${owner.toBase58().slice(-4)}`;
    assert.match(layer(p, /^Strategies \(\d+ on/), /FAIR LAUNCH.*CRASH.*LAUNCH/);
    assert.doesNotMatch(layer(p, /^Strategies/), /OPEN/, 'OPEN is retired: never running');
    assert.doesNotMatch(layer(p, /^Strategies/), /GOLDEN POCKET/, 'off by default, so not listed as running');
    assert.equal(layer(p, /^Wallet$/), `${short}: an address only, TEST never holds a key`);
    assert.match(layer(p, /^Signer$/), /^None/);
    assert.match(layer(p, /^DEX$/), /Jupiter routes/); assert.doesNotMatch(layer(p, /^DEX$/), /Phantom/);
    const signer = { publicKey: owner, signTransaction: async () => { throw new Error('not in this test'); } } as unknown as TransactionSigner;
    const live = await DeskEngine.create({ ...shared, mode: 'LIVE', dir, sender: null, signerKind: 'LOCAL_KEY', authorized: () => true, wallet: () => ({ owner, signer }) });
    const l = live.status({ connected: false, address: null }).path;
    assert.match(layer(l, /^Wallet$/), /local key on this PC \(WALLET_PRIVATE_KEY\), Phantom not needed/);
    assert.match(layer(l, /^Signer$/), /no approval per trade/);
    assert.match(layer(l, /^Submission$/), /sendTransaction/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALE_RULES } from '../src/desk/strategies';
import { MAX_IMPACT_SHARE_OF_LIQUIDITY, capacityUsd, milestoneContext, tierOf } from '../src/research/fundamentals/levels';
import { athSummary, crossings, rate, reclaims, studyLevels, summarizeCrossings, summarizeReclaims, type Bar } from '../src/research/fundamentals/history';
import { mainPair, ohlcvToBars, impliedSupply } from '../src/research/fundamentals/market';
import { flag, scanToken } from '../src/research/fundamentals/scanner';

const DAY = 86_400_000, T0 = Date.UTC(2026, 8, 1);
const bar = (day: number, c: number, h = c, l = c): Bar => ({ t: T0 + day * DAY, o: c, h, l, c });
const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('tiers follow the owner ladder: $100K, $1M, $10M, $100M', () => {
  assert.equal(tierOf(99_999)?.id, 'MICRO');
  assert.equal(tierOf(100_000)?.id, 'LOW');
  assert.equal(tierOf(1_100_000)?.id, 'MID');
  assert.equal(tierOf(10_000_000)?.id, 'HIGH');
  assert.equal(tierOf(250_000_000)?.id, 'LARGE');
  assert.equal(tierOf(null), null); assert.equal(tierOf(0), null); assert.equal(tierOf(Number.NaN), null);
});

test('milestone context: the next round market cap and how far through the decade', () => {
  const m = milestoneContext(1_100_000);
  assert.equal(m.belowUsd, 1_000_000); assert.equal(m.nextUsd, 10_000_000);
  near(m.toNextX, 10_000_000 / 1_100_000);
  near(m.decadePosition, Math.log10(1.1));
  const tiny = milestoneContext(5_000);
  assert.equal(tiny.belowUsd, null); assert.equal(tiny.nextUsd, 10_000); near(tiny.decadePosition, Math.log10(5));
  assert.equal(milestoneContext(2e9).nextUsd, null);
});

test('capacity uses the desk scale-up rule (2 % of pool liquidity)', () => {
  assert.equal(MAX_IMPACT_SHARE_OF_LIQUIDITY, SCALE_RULES.maxImpactShareOfLiquidity);
  assert.equal(capacityUsd(210_000), 4_200);
  assert.equal(capacityUsd(null), null);
});

test('old high: drawdown and the multiple back to it, from the last close', () => {
  const a = athSummary([bar(2, 1_100_000, 1_300_000, 900_000), bar(0, 2_000_000), bar(1, 7_000_000, 8_000_000, 3_000_000)])!;
  assert.equal(a.athUsd, 8_000_000); assert.equal(a.athAt, T0 + DAY);
  assert.equal(a.currentUsd, 1_100_000); near(a.drawdownPct, (1.1 / 8 - 1) * 100); near(a.toAthX, 8 / 1.1);
  assert.equal(a.lowSinceAthUsd, 900_000); assert.equal(a.bars, 3);
  assert.equal(athSummary([]), null);
});

test('crossings: first upward close per level, outcomes within the horizon, round vs control', () => {
  // Starts at $600K: above the $537K control level, so only $1M (round) and ≈ $2.34M (control) are crossed.
  const bars = [bar(0, 600_000), bar(1, 1_200_000), bar(2, 2_400_000, 2_500_000, 1_900_000), bar(3, 900_000, 1_000_000, 800_000)];
  const cs = crossings(bars, { horizonMs: 2 * DAY, asOf: T0 + 30 * DAY });
  // $100K is never crossed: the coin was already above it on its first bar.
  assert.ok(!cs.some(c => c.levelUsd === 100_000));
  assert.equal(cs.length, 2);
  const m1 = cs.find(c => c.levelUsd === 1_000_000)!;
  assert.equal(m1.round, true); assert.equal(m1.at, T0 + DAY);
  assert.equal(m1.reached2x, true); assert.equal(m1.reached10x, false); assert.equal(m1.heldAbove, false);
  near(m1.maxGainPct, (2.5 / 1.2 - 1) * 100); near(m1.maxDrawdownPct, (0.8 / 1.2 - 1) * 100);
  const control = cs.find(c => !c.round)!;
  near(control.levelUsd, 1_000_000 * 10 ** 0.37, 1e-3); assert.equal(control.at, T0 + 2 * DAY);
  assert.equal(control.reached2x, false); assert.equal(control.heldAbove, false);
  const s = summarizeCrossings(cs);
  assert.equal(s.round.crossings, 1); assert.equal(s.control.crossings, 1);
  assert.equal(s.round.reached2x.hits, 1); assert.equal(s.byDecade.length, 1); assert.equal(s.byDecade[0]!.milestoneUsd, 1_000_000);
  assert.equal(studyLevels().filter(l => l.round).length, 6);
});

test('crossings: a horizon still running when the history was read is censored, unless the outcome already happened', () => {
  const bars = [bar(0, 500_000), bar(1, 1_200_000), bar(2, 2_100_000)];
  const [c] = crossings(bars, { horizonMs: 10 * DAY, asOf: T0 + 2 * DAY, levels: [{ usd: 1_000_000, round: true }] });
  assert.equal(c!.reached2x, true, 'already reached: known');
  assert.equal(c!.reached10x, null); assert.equal(c!.heldAbove, null); assert.equal(c!.maxGainPct, null);
  // A dead coin stops trading: no bars, but the horizon is over, so the outcome is known (and negative).
  const [dead] = crossings([bar(0, 500_000), bar(1, 1_100_000)], { horizonMs: 5 * DAY, asOf: T0 + 60 * DAY, levels: [{ usd: 1_000_000, round: true }] });
  assert.equal(dead!.reached2x, false); assert.equal(dead!.heldAbove, true);
});

test('old-high study: the first deep fall, and whether the high came back in time', () => {
  const back = reclaims([bar(0, 1_000_000), bar(1, 7_000_000, 8_000_000), bar(3, 1_100_000), bar(20, 8_200_000, 8_300_000)],
    { drawdownPct: 80, horizonMs: 30 * DAY, asOf: T0 + 90 * DAY })!;
  assert.equal(back.athUsd, 8_000_000); assert.equal(back.triggerAt, T0 + 3 * DAY); near(back.drawdownPct, (1.1 / 8 - 1) * 100);
  assert.equal(back.ageAtTriggerMs, 3 * DAY); assert.equal(back.reclaimed, true); assert.equal(back.reclaimedAt, T0 + 20 * DAY);
  const never = reclaims([bar(0, 7_000_000, 8_000_000), bar(2, 1_000_000), bar(10, 2_000_000)], { drawdownPct: 80, horizonMs: 30 * DAY, asOf: T0 + 90 * DAY })!;
  assert.equal(never.reclaimed, false); near(never.maxGainPct, 100);
  const open = reclaims([bar(0, 7_000_000, 8_000_000), bar(2, 1_000_000)], { drawdownPct: 80, horizonMs: 30 * DAY, asOf: T0 + 5 * DAY })!;
  assert.equal(open.reclaimed, null); assert.equal(open.maxGainPct, null);
  assert.equal(reclaims([bar(0, 1_000_000), bar(1, 600_000)], { drawdownPct: 80, horizonMs: DAY, asOf: T0 + 9 * DAY }), null, 'no deep fall');
  const s = summarizeReclaims([back, never, open]);
  assert.equal(s.all.events, 3); assert.equal(s.all.censored, 1); assert.equal(s.all.reclaimed.n, 2); assert.equal(s.all.reclaimed.hits, 1);
  assert.equal(s.young.events, 3); assert.equal(s.older.events, 0);
});

test('rates leave unknown outcomes out and carry a Wilson interval', () => {
  const r = rate([true, false, null, true]);
  assert.equal(r.n, 3); assert.equal(r.hits, 2); near(r.rate, 2 / 3);
  assert.ok(r.low! > 0 && r.low! < 2 / 3 && r.high! > 2 / 3 && r.high! < 1);
  assert.deepEqual(rate([null]), { n: 0, hits: 0, rate: null, low: null, high: null });
});

test('market: the main pair is the deepest pair with the token as base on that chain', () => {
  const token = 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H';
  const pair = (o: Record<string, unknown>) => ({ chainId: 'solana', dexId: 'pumpswap', pairAddress: 'P1', baseToken: { address: token, name: 'worldwideweb', symbol: 'www' },
    priceUsd: '0.0011', marketCap: 1_100_000, fdv: 1_100_000, liquidity: { usd: 210_000 }, volume: { h24: 1_200_000 }, priceChange: { h24: 12.5 },
    txns: { h24: { buys: 900, sells: 800 } }, pairCreatedAt: T0 + DAY, info: { websites: [{ url: 'https://www.example' }], socials: [{ type: 'twitter', url: 'https://x.com/www' }] }, ...o });
  const raw = { pairs: [pair({}), pair({ pairAddress: 'P2', dexId: 'raydium', liquidity: { usd: 20_000 }, pairCreatedAt: T0 }),
    pair({ pairAddress: 'Q', baseToken: { address: 'other' }, liquidity: { usd: 9e9 } }), pair({ chainId: 'base', pairAddress: 'B', liquidity: { usd: 9e9 } })] };
  const m = mainPair(raw, 'solana', token)!;
  assert.equal(m.pairAddress, 'P1'); assert.equal(m.pairs, 2); assert.equal(m.firstPairAt, T0);
  assert.equal(m.priceUsd, 0.0011); assert.equal(m.liquidityUsd, 210_000); assert.equal(m.buys24h, 900);
  assert.deepEqual(m.links, ['https://www.example', 'https://x.com/www']);
  near(impliedSupply(m), 1e9, 1e-3);
  assert.equal(mainPair({ pairs: null }, 'solana', token), null);
  // EVM addresses compare case-insensitively.
  assert.equal(mainPair({ pairs: [pair({ chainId: 'base', baseToken: { address: '0xABC' } })] }, 'base', '0xabc')?.pairAddress, 'P1');
});

test('market: GeckoTerminal OHLCV becomes market-cap bars, oldest first, bad rows dropped', () => {
  const bars = ohlcvToBars({ data: { attributes: { ohlcv_list: [[1_790_086_400, 0.002, 0.003, 0.001, 0.0025, 5], [1_790_000_000, 0.001, 0.002, 0.0009, 0.002, 1], [1, 0, 0, 0, 0, 0], 'x'] } } }, 1e9);
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.t, 1_790_000_000_000); near(bars[0]!.c, 2_000_000, 1e-6); near(bars[1]!.h, 3_000_000, 1e-6);
  assert.deepEqual(ohlcvToBars(null, 1e9), []);
});

function fakeFetch(routes: Array<[RegExp, number, unknown]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) throw new Error(`offline: ${url}`);
    return new Response(JSON.stringify(hit[2]), { status: hit[1] });
  }) as typeof fetch;
}

test('scanner flags parse tolerantly: unknown shapes read as unknown', () => {
  assert.equal(flag('1'), true); assert.equal(flag(0), false); assert.equal(flag({ status: '1' }), true);
  assert.equal(flag('yes'), null); assert.equal(flag(undefined), null); assert.equal(flag({}), null);
});

test('scanner: an EVM honeypot with a high sell tax is blocked', async () => {
  const token = '0xAbC0000000000000000000000000000000000001';
  const r = await scanToken('base', token, { fetcher: fakeFetch([[/token_security\/8453/, 200, { code: 1, result: { [token.toLowerCase()]: {
    is_honeypot: '1', sell_tax: '0.25', buy_tax: '0.04', is_open_source: '1', is_mintable: '0',
    holders: [{ address: 'a', percent: '0.30', is_contract: 0, is_locked: 0 }, { address: 'lp', percent: '0.60', is_contract: 1, is_locked: 1 }] } } }]]) });
  assert.equal(r.verdict, 'BLOCK'); assert.equal(r.sources.goplus, 'OK'); assert.equal(r.sources.rugcheck, 'NOT_COVERED');
  const codes = r.findings.map(f => `${f.level}:${f.code}`);
  for (const c of ['BLOCK:IS_HONEYPOT', 'BLOCK:SELL_TAX', 'WARN:BUY_TAX', 'WARN:LARGEST_HOLDER']) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.ok(!codes.includes('WARN:IS_MINTABLE'));
  assert.equal(r.findings[0]!.level, 'BLOCK', 'blocks first');
});

test('scanner: Solana with a live mint authority is blocked; RugCheck dangers warn', async () => {
  const mint = 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H';
  const r = await scanToken('solana', mint, { fetcher: fakeFetch([
    [/gopluslabs.*solana/, 200, { code: 1, result: { [mint]: { mintable: { status: '1', authority: [] }, freezable: { status: '0' }, metadata_mutable: { status: '1' },
      holders: [{ account: 'w1', percent: '8.5' }, { account: 'w2', percent: '30' }, { account: 'pool', percent: '40', is_locked: 1 }] } } }],
    [/rugcheck/, 200, { score_normalised: 41, risks: [{ name: 'Top 10 holders high ownership', level: 'danger', value: '' }, { name: 'Low Liquidity', level: 'warn', value: '$4,000' }] }],
  ]) });
  assert.equal(r.verdict, 'BLOCK');
  const codes = r.findings.map(f => `${f.source}:${f.level}:${f.code}`);
  for (const c of ['goplus:BLOCK:MINTABLE', 'goplus:INFO:METADATA_MUTABLE', 'goplus:WARN:LARGEST_HOLDER', 'rugcheck:WARN:TOP_10_HOLDERS_HIGH_OWNERSHIP', 'rugcheck:INFO:LOW_LIQUIDITY', 'rugcheck:INFO:SCORE'])
    assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.ok(!codes.includes('goplus:BLOCK:FREEZABLE'));
  // Shares above 1 are percents already: the 30 % wallet reads as 30 %, not 3,000 %.
  assert.match(r.findings.find(f => f.code === 'LARGEST_HOLDER')!.detail, /30\.0 %/);
});

test('scanner: clean answers pass; no answers are UNKNOWN, never PASS', async () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const clean = await scanToken('solana', mint, { fetcher: fakeFetch([
    [/gopluslabs/, 200, { code: 1, result: { [mint]: { mintable: { status: '0' }, freezable: { status: '0' } } } }], [/rugcheck/, 200, { risks: [] }]]) });
  assert.equal(clean.verdict, 'PASS'); assert.deepEqual(clean.findings, []);
  const down = await scanToken('solana', mint, { fetcher: fakeFetch([[/gopluslabs/, 503, {}], [/rugcheck/, 404, {}]]) });
  assert.equal(down.verdict, 'UNKNOWN'); assert.equal(down.sources.goplus, 'ERROR: HTTP 503'); assert.equal(down.sources.rugcheck, 'NOT_FOUND');
  const offline = await scanToken('ethereum', '0x1', { fetcher: fakeFetch([]) });
  assert.equal(offline.verdict, 'UNKNOWN'); assert.match(offline.sources.goplus, /^ERROR: offline/);
  const missing = await scanToken('solana', mint, { fetcher: fakeFetch([[/gopluslabs/, 200, { code: 1, result: {} }], [/rugcheck/, 500, 'oops']]) });
  assert.equal(missing.verdict, 'UNKNOWN'); assert.equal(missing.sources.goplus, 'NOT_FOUND');
});

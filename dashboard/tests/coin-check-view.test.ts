import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoinCheckResult } from '../src/Desk';
import type { CoinCheck } from '../../src/research/coin-check';

test('coin check view: the reading on top, every number below, a failed source listed', () => {
  const r: CoinCheck = { mint: '9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj', at: Date.parse('2026-10-03T15:00:00Z'),
    token: { symbol: 'SI', name: 'Super Intelligence', dev: 'DEV', launchpad: 'pump.fun', createdAt: Date.parse('2026-09-29T22:44:00Z'), links: ['https://otcdesks.cash/coin/x'] },
    market: { mcapUsd: 880_000, liquidityUsd: 124_000, volume24hUsd: 1.43e6, change1hPct: -27, change24hPct: -48, url: 'https://dexscreener.com/solana/pool' },
    level: { tier: 'LOW', belowUsd: 100_000, nextUsd: 1e6, toNextX: 1.14 },
    history: { athUsd: 9.25e6, athAt: Date.parse('2026-09-30T18:00:00Z'), drawdownPct: -90.5, toAthX: 10.5, lowSinceAthUsd: 725_000, bars: 90, interval: 'hour' },
    security: { verdict: 'PASS', findings: [{ source: 'rugcheck', level: 'INFO', code: 'SCORE', detail: 'RugCheck risk score 1' }], goplus: 'OK', rugcheck: 'OK' },
    holders: { count: 12_154, change1hPct: 0.3, change24hPct: -7.4, topHoldersPct: 16.5, devMints: 19_410, devMigrations: 367,
      scan: { top20Pct: 30.9, programPct: 8.9, walletPct: 22, clusterPct: 0, teamPct: 0, freshPct: 6.9, largestWalletPct: 3.07, largestCluster: null } },
    demand: { organicScore: 75, realBuy1hUsd: 5_327, realSell1hUsd: 7_279, realBuy24hUsd: 73_040, realSell24hUsd: 74_548, realShare24hPct: 7.7, liquidityChange24hPct: -42.7, buyers1h: 23 },
    verdict: { tone: 'bad', headline: 'Clean coin, demand is fading, no team behind it: not a buy signal.', lines: ['Contract: passes both security scans.'] },
    watched: false, errors: ['price history: HTTP 429'] };
  const html = renderToStaticMarkup(createElement(CoinCheckResult, { r, adding: false, onAdd: () => {} }));
  assert.match(html, /class="coin-verdict bad"><strong>Clean coin, demand is fading, no team behind it: not a buy signal\.<\/strong>/);
  assert.match(html, /Add to watchlist/);
  assert.match(html, /\$880\.0K · tier LOW · next level \$1\.00M \(1\.1×\)/);
  assert.match(html, /developer created 19,410 coins \(367 reached the exchange\)/);
  assert.match(html, /top 20 30\.9% \(pools 8\.9%, wallets 22\.0%\) · clusters 0\.0% · team 0\.0%/);
  assert.match(html, /price history: HTTP 429/);
  assert.match(html, /href="https:\/\/fomo\.family\/tokens\/solana\/9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj"/);
  const watched = renderToStaticMarkup(createElement(CoinCheckResult, { r: { ...r, watched: true, history: null, holders: { ...r.holders, scan: null } }, adding: false, onAdd: () => {} }));
  assert.match(watched, /On the watchlist/); assert.doesNotMatch(watched, /Add to watchlist/);
});

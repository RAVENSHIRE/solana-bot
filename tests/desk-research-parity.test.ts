import test from 'node:test';
import assert from 'node:assert/strict';
import { CRASH_DEFAULTS, CRASH_ENTRY } from '../src/desk/config';
import { notifier } from '../src/desk/watch';
import { CRASH_V001 } from '../src/research/strategy/catalog';

/**
 * Needs the project's dependencies (zod via the desk modules): runs in `npm test`, not in the dependency-free research
 * build. If this fails, the desk's CRASH rule changed: register crash_v002 in src/research/strategy/catalog.ts with
 * parent crash_v001 — never edit v001, experiments already refer to it.
 */
test('crash_v001 is exactly the desk CRASH rule', () => {
  const rule = (feature: string) => CRASH_V001.entry.find(r => r.feature === feature)!.value;
  assert.equal(rule('pool_age_min@v1'), CRASH_ENTRY.maxPoolAgeMin);
  assert.deepEqual(rule('price_change_5m_pct@v1'), [CRASH_ENTRY.minPriceChange5mPct, CRASH_ENTRY.maxPriceChange5mPct]);
  assert.equal(rule('volume_5m_usd@v1'), CRASH_ENTRY.minVolume5mUsd);
  assert.equal(rule('buy_sell_ratio_5m@v1'), CRASH_ENTRY.minBuySellRatio);
  assert.equal(rule('buys_5m@v1'), CRASH_ENTRY.minBuys5m);
  assert.equal(rule('liquidity_usd@v1'), CRASH_ENTRY.minLiquidityUsd);
  assert.equal(rule('liquidity_to_mcap@v1'), CRASH_ENTRY.minLiquidityToMarketCap);
  assert.equal(rule('market_cap_usd@v1'), CRASH_ENTRY.maxMarketCapUsd);
  assert.equal(rule('top10_pct@v1'), CRASH_ENTRY.maxTop10WalletPct);
  assert.equal(rule('largest_wallet_pct@v1'), CRASH_ENTRY.maxLargestWalletPct);
  assert.equal(CRASH_V001.exit.stopLossPct, CRASH_DEFAULTS.stopLossPct);
  assert.equal(CRASH_V001.exit.takeProfitPct, CRASH_DEFAULTS.takeProfitPct);
  assert.equal(CRASH_V001.exit.maxHoldMin, CRASH_DEFAULTS.maxHoldMin);
  assert.equal(CRASH_V001.sizing.usd, CRASH_DEFAULTS.entryUsd);
});

test('the notifier reports each channel\'s delivery without leaking the bot token, and notify still never throws', async () => {
  const fetcher = (async (url: string | URL) => {
    if (String(url).includes('ntfy')) return { ok: false, status: 429 } as Response;
    throw new TypeError(`fetch failed for ${String(url)}`);
  }) as typeof fetch;
  const n = notifier({ DESK_NTFY_TOPIC: 'raven-desk-8f3k2', DESK_TELEGRAM_BOT_TOKEN: '123:abc_DEF', DESK_TELEGRAM_CHAT_ID: '-42' }, fetcher);
  const results = await n.deliver('T', 'B');
  assert.deepEqual(results, [{ channel: 'ntfy', ok: false, status: 429, error: null }, { channel: 'Telegram', ok: false, status: null, error: 'TypeError' }]);
  assert.ok(!JSON.stringify(results).includes('abc_DEF'));
  await n.notify('T', 'B');
  assert.deepEqual(await notifier({}, fetcher).deliver('T', 'B'), []);
});

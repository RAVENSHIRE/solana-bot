import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { normalizeDexPairs } from '../src/data/dexscreener';
import { SOL_MINT } from '../src/core/types';
import { HoldingsWatch, WATCH, notifier, watchReason, type WatchDeps, type WatchSell } from '../src/desk/watch';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const MINT = key(31), WALLET = key(32), FOMO = key(33), POOL = key(34);

function harness(o: { sellWallet?: string | null; balance?: bigint; sellFails?: boolean } = {}) {
  let now = Date.now(), cap = 44_000_000;
  const notes: Array<{ title: string; body: string }> = [], sells: WatchSell[] = [];
  const pairRaw = () => ({ chainId: 'solana', dexId: 'pumpswap', pairAddress: POOL, baseToken: { address: MINT, symbol: 'SINU', name: 'Super Inu' },
    quoteToken: { address: SOL_MINT, symbol: 'SOL' }, priceUsd: String(cap / 1e9), liquidity: { usd: 2_000_000 }, marketCap: cap, fdv: cap,
    pairCreatedAt: now - 5 * 86_400_000, priceChange: { m5: 0, h1: 0 }, volume: { m5: 10_000, h1: 100_000 }, txns: { m5: { buys: 10, sells: 10 } } });
  const deps = (file: string): WatchDeps => ({ file, clock: () => now, channels: ['ntfy'],
    dex: { getPairsForTokens: async () => normalizeDexPairs([pairRaw()], now) },
    balance: async () => ({ raw: o.balance ?? 5_000_000_000n, decimals: 6 }),
    notify: async (title, body) => { notes.push({ title, body }); },
    sell: o.sellWallet === null ? null : async s => { sells.push(s); await s.onSigned('SIG123'); if (o.sellFails) throw new Error('SIMULATION_FAILED'); return { signature: 'SIG123', detail: 'Sold 5000 for 1.2 SOL' }; },
    sellWallet: o.sellWallet === undefined ? WALLET : o.sellWallet });
  return { notes, sells, deps, setCap: (v: number) => { cap = v; }, step: () => { now += WATCH.checkMs; } };
}
async function tmp() { return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'watch-')), 'watch.json'); }

test('watch reasons: the floor protects first, the trailing stop measures from the peak, the target takes profit', () => {
  const r = { marketCapFloorUsd: 30_000_000, marketCapTargetUsd: 80_000_000, trailingStopPct: 25, peakMarketCapUsd: 60_000_000 };
  assert.match(watchReason(r, 29_000_000)!, /^MCAP_FLOOR \$29\.00M ≤ \$30\.00M/);
  assert.match(watchReason(r, 44_000_000)!, /^TRAILING_STOP \$44\.00M is 26\.7% below the peak \$60\.00M \(stop 25%\)/);
  assert.equal(watchReason(r, 46_000_000), null);
  assert.match(watchReason({ ...r, peakMarketCapUsd: 90_000_000, trailingStopPct: null }, 85_000_000)!, /^MCAP_TARGET/);
});

test('a floor alert needs two checks in a row: one bad data point never triggers; a trigger alerts once', async () => {
  const h = harness(), file = await tmp(), watch = await HoldingsWatch.open(h.deps(file));
  watch.add({ mint: MINT, wallet: FOMO, marketCapFloorUsd: 30_000_000, note: 'my last entry' });
  await watch.check();
  let r = watch.view().rules[0]!;
  assert.equal(r.symbol, 'SINU'); assert.equal(r.lastMarketCapUsd, 44_000_000); assert.equal(r.peakMarketCapUsd, 44_000_000); assert.equal(r.balanceRaw, '5000000000');
  h.setCap(29_000_000); h.step(); await watch.check();
  assert.equal(watch.view().rules[0]!.pending!.count, 1); assert.equal(h.notes.length, 0, 'one check below the floor is not enough');
  h.setCap(31_000_000); h.step(); await watch.check();
  assert.equal(watch.view().rules[0]!.pending, null, 'recovered: the count starts over');
  h.setCap(28_000_000); h.step(); await watch.check(); h.step(); await watch.check();
  r = watch.view().rules[0]!;
  assert.equal(r.triggered!.outcome, 'ALERTED'); assert.match(r.triggered!.reason, /^MCAP_FLOOR/);
  assert.equal(h.notes.length, 1); assert.match(h.notes[0]!.title, /^SINU: MCAP FLOOR/); assert.match(h.notes[0]!.body, /sell it in your wallet\. Note: my last entry$/);
  h.step(); await watch.check();
  assert.equal(h.notes.length, 1, 'a triggered rule stays quiet until re-armed');
  watch.rearm(r.id);
  assert.equal(watch.view().rules[0]!.triggered, null); assert.equal(watch.view().rules[0]!.peakMarketCapUsd, 28_000_000);
  const again = await HoldingsWatch.open(h.deps(file));
  assert.equal(again.view().rules.length, 1, 'rules survive a restart'); assert.equal(again.view().alerts[0]!.title, h.notes[0]!.title);
});

test('SELL with the local key: the trailing stop sells the whole balance, persists the signature first, and reports the result', async () => {
  const h = harness(), watch = await HoldingsWatch.open(h.deps(await tmp()));
  assert.throws(() => watch.add({ mint: MINT, wallet: FOMO, trailingStopPct: 25, action: 'SELL' }), /WATCH_SELL_NEEDS_LOCAL_KEY/);
  assert.throws(() => watch.add({ mint: MINT, wallet: WALLET }), /INVALID_WATCH: marketCapFloorUsd: set a floor, a target or a trailing stop/);
  assert.throws(() => watch.add({ mint: 'nope', wallet: WALLET, trailingStopPct: 25 }), /INVALID_WATCH: mint/);
  watch.add({ mint: MINT, wallet: WALLET, trailingStopPct: 25, action: 'SELL' });
  await watch.check(); h.setCap(60_000_000); h.step(); await watch.check();
  assert.equal(watch.view().rules[0]!.peakMarketCapUsd, 60_000_000);
  h.setCap(44_000_000); h.step(); await watch.check(); h.step(); await watch.check();
  const r = watch.view().rules[0]!;
  assert.equal(h.sells.length, 1); assert.equal(h.sells[0]!.amountRaw, 5_000_000_000n); assert.equal(h.sells[0]!.decimals, 6);
  assert.match(h.sells[0]!.reason, /^TRAILING_STOP \$44\.00M is 26\.7% below the peak \$60\.00M/);
  assert.equal(r.triggered!.outcome, 'SOLD'); assert.equal(r.triggered!.signature, 'SIG123');
  assert.deepEqual(h.notes.map(n => n.title), ['SINU: TRAILING STOP', 'SINU: SOLD']);
});

test('SELL that fails, a wallet that holds none, and a restart during a sale never sell twice', async () => {
  const fail = harness({ sellFails: true }), file = await tmp(), watch = await HoldingsWatch.open(fail.deps(file));
  watch.add({ mint: MINT, wallet: WALLET, marketCapFloorUsd: 50_000_000, action: 'SELL' });
  await watch.check(); fail.step(); await watch.check();
  assert.equal(watch.view().rules[0]!.triggered!.outcome, 'SELL_FAILED'); assert.match(fail.notes.at(-1)!.body, /SIMULATION_FAILED — sell it in your wallet now/);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.rules[0].triggered.outcome = 'SELLING';
  await fs.writeFile(file, JSON.stringify(saved));
  const restarted = await HoldingsWatch.open(fail.deps(file));
  assert.equal(restarted.view().rules[0]!.triggered!.outcome, 'SELL_FAILED'); assert.match(restarted.view().rules[0]!.triggered!.detail, /Interrupted by a restart; check SIG123/);
  const none = harness({ balance: 0n }), w2 = await HoldingsWatch.open(none.deps(await tmp()));
  w2.add({ mint: MINT, wallet: WALLET, marketCapFloorUsd: 50_000_000, action: 'SELL' });
  await w2.check(); none.step(); await w2.check();
  assert.equal(w2.view().rules[0]!.triggered!.outcome, 'ALERT_ONLY'); assert.equal(none.sells.length, 0);
  const noKey = harness({ sellWallet: null }), w3 = await HoldingsWatch.open(noKey.deps(await tmp()));
  assert.throws(() => w3.add({ mint: MINT, wallet: WALLET, marketCapFloorUsd: 50_000_000, action: 'SELL' }), /WATCH_SELL_NEEDS_LOCAL_KEY/);
});

test('phone notifications are opt-in: ntfy topic and Telegram bot, never blocking; invalid settings are ignored', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); throw new Error('offline'); }) as unknown as typeof fetch;
  const n = notifier({ DESK_NTFY_TOPIC: 'raven-desk-8f3k2', DESK_TELEGRAM_BOT_TOKEN: '123:abc_DEF', DESK_TELEGRAM_CHAT_ID: '-42' }, fetcher);
  assert.deepEqual(n.channels, ['ntfy', 'Telegram']);
  await n.notify('SINU: MCAP FLOOR', 'below $30M');
  assert.equal(calls[0]!.url, 'https://ntfy.sh/raven-desk-8f3k2'); assert.equal((calls[0]!.init.headers as Record<string, string>).Title, 'SINU: MCAP FLOOR');
  assert.equal(calls[1]!.url, 'https://api.telegram.org/bot123:abc_DEF/sendMessage'); assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { chat_id: '-42', text: 'SINU: MCAP FLOOR\nbelow $30M' });
  assert.deepEqual(notifier({ DESK_NTFY_TOPIC: 'a b', DESK_TELEGRAM_BOT_TOKEN: 'x' }).channels, []);
});

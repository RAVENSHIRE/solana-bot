import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, contentId } from '../src/research/core/canonical';
import { makeEvent, sanitizeUrl, EventRejected } from '../src/research/events/factory';
import { FileEventStore, MemoryEventStore, MultiStoreReader, knowledgeOrder, verifyStore } from '../src/research/events/store';
import type { EventInput } from '../src/research/events/types';

const MINT = 'So11111111111111111111111111111111111111112';
const MINT2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'research-store-'));
const snap = (over: Partial<EventInput> = {}): EventInput => ({ event_type: 'MarketSnapshot', token: MINT, timestamp: T0, observed_at: T0 + 800, source: 'dexscreener',
  payload: { price_usd: 0.01, market_cap_usd: 10_000_000, liquidity_usd: 500_000 }, ...over });

test('canonical JSON is key-order independent and refuses values without a canonical form', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), canonicalJson({ a: [2, { c: null, d: 1 }], b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: 10n, c: -0 }), '{"b":"10","c":0}');
  assert.throws(() => canonicalJson({ x: NaN }), /non-finite/);
  assert.throws(() => canonicalJson(new Map()), /plain objects/);
  const loop: Record<string, unknown> = {}; loop.self = loop;
  assert.throws(() => canonicalJson(loop), /cycle/);
  assert.equal(contentId('x', { a: 1, b: 2 }), contentId('x', { b: 2, a: 1 }));
});

test('event ids depend on content, not on when or how often it was observed', () => {
  const a = makeEvent(snap(), T0 + 1_000), b = makeEvent(snap({ observed_at: T0 + 5_000 }), T0 + 9_000);
  assert.equal(a.event_id, b.event_id);
  assert.notEqual(a.event_id, makeEvent(snap({ payload: { price_usd: 0.02 } }), T0 + 1_000).event_id);
  assert.equal(a.ingestion_latency_ms, 800);
  assert.equal(a.available_at, a.observed_at);
  assert.equal(a.quality.status, 'OK');
  assert.equal(a.schema_version, 1);
});

test('quality is graded, never silently fixed', () => {
  assert.equal(makeEvent(snap({ token: null }), T0).quality.status, 'INVALID');
  assert.ok(makeEvent(snap({ token: null }), T0).quality.issues.includes('TOKEN_MISSING'));
  // Knowable before it happened would leak the future into point-in-time views.
  const leaky = makeEvent(snap({ available_at: T0 - 60_000 }), T0 + 1_000);
  assert.equal(leaky.quality.status, 'INVALID');
  assert.ok(leaky.quality.issues.includes('AVAILABLE_BEFORE_TIMESTAMP'));
  // Backfill without an availability model is only known from the download: conservative, never leaks.
  const backfill = makeEvent(snap({ capture: 'BACKFILL', observed_at: T0 + 86_400_000 }), T0 + 86_400_000);
  assert.equal(backfill.available_at, T0 + 86_400_000);
  assert.ok(backfill.quality.issues.includes('AVAILABILITY_UNKNOWN'));
  assert.equal(makeEvent(snap({ observed_at: T0 + 600_000 }), T0 + 600_000).quality.issues.includes('STALE_ON_ARRIVAL'), true);
  const nan = makeEvent(snap({ payload: { price_usd: Number.NaN, market_cap_usd: 1 } }), T0 + 1_000);
  assert.equal(nan.payload.price_usd, null);
  assert.ok(nan.quality.issues.includes('NON_FINITE_NUMBER:$.price_usd'));
  assert.equal(makeEvent({ ...snap(), event_type: 'Candle', payload: { interval_ms: 60_000, o: 1, h: 2, l: 0.5 } }, T0).quality.status, 'INVALID');
  assert.throws(() => makeEvent({ ...snap(), event_type: 'Nope' as 'Buy' }, T0), EventRejected);
  assert.throws(() => makeEvent(snap({ timestamp: Number.NaN }), T0), EventRejected);
});

test('secrets never reach the store; evidence links stay readable', () => {
  const e = makeEvent(snap({ payload: { price_usd: 1, apiKey: 'abc', rpc: 'https://mainnet.helius-rpc.com/?api-key=SECRET', x: 'https://x.com/project/status/123',
    site: 'https://user:pw@example.com/page?token=SECRET&ref=1', ntfy: 'https://ntfy.sh/my-private-topic', nested: { private_key: [1, 2] } } }), T0 + 1_000);
  const text = JSON.stringify(e);
  assert.ok(!text.includes('SECRET') && !text.includes('abc') && !text.includes('my-private-topic') && !text.includes('pw@'));
  assert.equal(e.payload.x, 'https://x.com/project/status/123');
  assert.equal((e.payload.nested as Record<string, unknown>).private_key, '[redacted]');
  assert.equal(sanitizeUrl('https://api.telegram.org/bot123:abc/sendMessage'), 'https://api.telegram.org/[redacted]');
});

test('memory store: duplicates are ignored, re-sent identities with new content are kept as CONFLICT', async () => {
  const store = new MemoryEventStore(() => T0 + 2_000);
  const trade = (amount: number): EventInput => ({ event_type: 'Buy', token: MINT, timestamp: T0, source: 'geckoterminal', natural_key: 'tx1:0',
    payload: { wallet: 'W1', amount_usd: amount } });
  assert.equal((await store.append(trade(100)))[0]!.status, 'APPENDED');
  assert.equal((await store.append(trade(100)))[0]!.status, 'DUPLICATE');
  const [conflict] = await store.append(trade(999));
  assert.equal(conflict!.status, 'CONFLICT_APPENDED');
  assert.equal(conflict!.event.quality.status, 'CONFLICT');
  assert.equal((await store.stats()).events, 2);
  assert.equal((await store.stats()).duplicatesIgnored, 1);
});

test('point-in-time filter: OBSERVED vs AVAILABLE knowledge', async () => {
  const store = new MemoryEventStore(() => T0);
  await store.append([
    snap({ timestamp: T0, observed_at: T0 + 1_000 }),
    // Downloaded a day later, but a real-time system would have had it 60 s after the bar closed.
    { ...snap({ timestamp: T0 + 60_000, observed_at: T0 + 86_400_000, available_at: T0 + 120_000, capture: 'BACKFILL' }), event_type: 'Candle',
      payload: { interval_ms: 60_000, o: 1, h: 1, l: 1, c: 1 } },
  ]);
  const at = T0 + 200_000;
  assert.equal((await store.query({ knownBy: { at, mode: 'OBSERVED' } })).length, 1);
  assert.equal((await store.query({ knownBy: { at, mode: 'AVAILABLE' } })).length, 2);
  const ordered = (await store.query()).sort(knowledgeOrder('OBSERVED'));
  assert.equal(ordered[0]!.event_type, 'MarketSnapshot');
});

test('file store: append-only, reopened without duplicates, verified end to end', async () => {
  const dir = await tmp();
  let clock = T0 + 1_000;
  const store = await FileEventStore.open(dir, { clock: () => clock, maxSegmentBytes: 2_000 });
  for (let i = 0; i < 12; i++) { clock += 1_000; await store.append(snap({ timestamp: T0 + i * 1_000, observed_at: clock, token: i % 2 ? MINT : MINT2 })); }
  assert.equal(store.size, 12);
  await store.close();
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  assert.ok(files.length > 1, 'segments rotate at maxSegmentBytes');

  const again = await FileEventStore.open(dir, { clock: () => clock });
  assert.equal(again.size, 12);
  assert.equal((await again.append(snap({ timestamp: T0, observed_at: T0 + 2_000, token: MINT2 })))[0]!.status, 'DUPLICATE');
  assert.equal((await again.query({ tokens: [MINT] })).length, 6);
  const report = await again.verify();
  assert.equal(report.ok, true);
  assert.equal(report.lines, 12);
  await again.close();
});

test('file store: a second writer is refused while the first holds the lock', async () => {
  const dir = await tmp();
  const first = await FileEventStore.open(dir);
  await assert.rejects(() => FileEventStore.open(dir));
  await first.close();
  const second = await FileEventStore.open(dir);
  await second.close();
});

test('tampering anywhere in history is detected', async () => {
  const dir = await tmp();
  const store = await FileEventStore.open(dir, { clock: () => T0 + 5_000 });
  for (let i = 0; i < 5; i++) await store.append(snap({ timestamp: T0 + i, observed_at: T0 + 1_000 + i }));
  await store.close();
  const [file] = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  const full = path.join(dir, file!), lines = (await fs.readFile(full, 'utf8')).split('\n');
  // Edit the price of the third observation (a "better" historical fill, say).
  lines[2] = lines[2]!.replace('"price_usd":0.01', '"price_usd":0.02');
  await fs.writeFile(full, lines.join('\n'));
  const report = await verifyStore(dir);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(i => i.kind === 'HASH_MISMATCH'));
  assert.equal(report.idMismatches.length, 1);
});

test('a torn write is never repaired: it is reported and writing continues in a new segment', async () => {
  const dir = await tmp();
  const store = await FileEventStore.open(dir, { clock: () => T0 + 5_000 });
  await store.append(snap());
  await store.close();
  const [file] = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  await fs.appendFile(path.join(dir, file!), '{"seq":2,"prev_hash":"abc');
  const reopened = await FileEventStore.open(dir, { clock: () => T0 + 6_000 });
  assert.equal(reopened.openIssues[0]!.kind, 'TORN_LINE');
  await reopened.append(snap({ timestamp: T0 + 1 }));
  await reopened.close();
  assert.equal((await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).length, 2);
  const report = await verifyStore(dir);
  assert.equal(report.lines, 2);
  assert.ok(report.issues.some(i => i.kind === 'TORN_LINE'));
  // The torn bytes are still on disk: history is evidence, including of the crash.
  assert.ok((await fs.readFile(path.join(dir, file!), 'utf8')).endsWith('"prev_hash":"abc'));
});

test('several collectors, one research view', async () => {
  const a = await tmp(), b = await tmp();
  const sa = await FileEventStore.open(a, { clock: () => T0 + 3_000 }), sb = await FileEventStore.open(b, { clock: () => T0 + 3_000 });
  await sa.append(snap()); await sb.append(snap()); await sb.append(snap({ timestamp: T0 + 1 }));
  await sa.close(); await sb.close();
  const reader = new MultiStoreReader([a, b]);
  assert.equal((await reader.query()).length, 2);
  assert.equal((await reader.stats()).events, 2);
});

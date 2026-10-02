import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { canonicalJson, sha256Hex } from '../src/research/core/canonical';
import { makeEvent } from '../src/research/events/factory';
import { FileEventStore, MemoryEventStore, queryDir, verifyStore } from '../src/research/events/store';
import type { EventInput, ResearchEvent } from '../src/research/events/types';
import { alertDeliveredEvent, alertGeneratedEvent, buildAlertEvidence, formatAlertMessage, type AlertInput, type CandidateLike } from '../src/research/alerts/evidence';
import { DeskResearchRecorder } from '../src/research/integration/desk-recorder';
import { explainMissingAlert } from '../src/research/observability/why';
import { HealthRegistry } from '../src/research/observability/health';
import { deskArtifactInputs, deskEventToInput, ledgerStrategy, tapeToInputs, type TapeRow } from '../src/research/ingest/desk-artifacts';
import { backtestCacheInputs } from '../src/research/ingest/backtest-cache';
import { observerInputs } from '../src/research/ingest/observer-ledger';
import { KnowledgeIndex } from '../src/research/pit/view';
import { computeFeatures } from '../src/research/features/registry';
import { standardRegistry } from '../src/research/features/library';
import { evaluateEntry } from '../src/research/strategy/versioning';
import { CRASH_V001 } from '../src/research/strategy/catalog';

const MINT = 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H';
const T0 = Date.UTC(2026, 9, 2, 3, 12, 0);
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'research-alerts-'));

const candidate = (over: Partial<CandidateLike> = {}): CandidateLike => ({
  mint: MINT, symbol: 'AGENCY', name: 'Agency', pair: { address: 'PoolAddr1111111111111111111111111111111111', dex: 'pumpswap', url: `https://dexscreener.com/solana/${MINT}` },
  status: 'QUALIFIED', reasons: [], metrics: { marketCapUsd: 112_000, liquidityUsd: 31_000, volume5mUsd: 64_000, priceChange5mPct: 18.4, buys5m: 140, sells5m: 70, top10WalletPct: 22, poolAgeMin: 6 },
  evidence: [{ key: 'mcap', label: 'Market cap', kind: 'OBSERVED', value: 112_000, source: 'dexscreener', at: T0 - 4_000 },
    { key: 'holders', label: 'Top-10', kind: 'OBSERVED', value: 22, source: 'rpc', at: T0 - 90_000 }],
  gates: [{ key: 'mint', label: 'Mint authority revoked', status: 'PASS', actual: 'yes', required: 'yes', blocking: true }],
  golden: { kind: 'ONLY_UP', detail: 'two green minutes', signalAt: T0 - 1_000,
    signal: { signal: true, summary: 'ONLY_UP fill', checks: [{ label: 'fill age', status: 'PASS', actual: '1 s', required: '< 180 s' }, { label: 'largest wallet', status: 'PASS', actual: '6 %', required: '≤ 20 %' }] } },
  updatedAt: T0 - 2_000, firstSeenAt: T0 - 400_000, ...over,
});
const input = (over: Partial<AlertInput> = {}): AlertInput => ({ key: `golden:${MINT}`, kind: 'golden', title: 'GOLDEN POCKET: AGENCY at $112.0K', body: `only up\nhttps://fomo.family/tokens/solana/${MINT}`,
  at: T0, mode: 'PAPER', token: MINT, symbol: 'AGENCY', candidate: candidate(), solUsd: 151.2, delivery: { decision: 'SENT', channels: ['ntfy'], selectedKinds: ['rug', 'golden'] }, ...over });

test('alert evidence: what happened, why, what was known and when, quality, links', () => {
  const e = buildAlertEvidence(input());
  assert.equal(e.why_triggered.summary, 'ONLY_UP fill');
  assert.equal(e.why_triggered.checks.length, 2);
  assert.equal(e.when_it_knew.decision_time, T0);
  assert.equal(e.when_it_knew.max_input_age_ms, 90_000);
  assert.equal(e.key_features.marketCapUsd, 112_000);
  assert.equal(e.market_state.sol_usd, 151.2);
  assert.equal(e.data_quality.status, 'OK');
  assert.equal(e.links.dexscreener, `https://dexscreener.com/solana/${MINT}`);
  assert.equal(e.links.evidence, `research:alert/${e.alert_id}`);
  assert.equal(e.delivery.decision, 'SENT');
  // The id is the content: same knowledge, same id; any different input, another id.
  assert.equal(buildAlertEvidence(input()).alert_id, e.alert_id);
  assert.notEqual(buildAlertEvidence(input({ candidate: candidate({ metrics: { marketCapUsd: 150_000 } }) })).alert_id, e.alert_id);
  const { snapshot_hash, ...rest } = e;
  assert.equal(sha256Hex(canonicalJson(rest)), snapshot_hash);
  const text = formatAlertMessage(e);
  assert.ok(text.startsWith(input().body));
  assert.match(text, /knew 03:11:58Z · oldest input 90s · data OK/);
  assert.match(text, /mcap \$112K · liq \$31\.0K · v5m \$64\.0K · 5m \+18%/);
  assert.ok(text.endsWith(`evidence ${e.alert_id}`));
});

test('alert evidence grades its own data quality', () => {
  const unknownGate = buildAlertEvidence(input({ candidate: candidate({ gates: [{ label: 'Top-10', status: 'UNKNOWN', blocking: true }], updatedAt: T0 - 600_000 }) }));
  assert.equal(unknownGate.data_quality.status, 'DEGRADED');
  assert.ok(unknownGate.data_quality.issues.some(i => i.startsWith('CANDIDATE_STALE')));
  assert.ok(unknownGate.data_quality.issues.some(i => i.startsWith('UNKNOWN_GATE Top-10 (blocking)')));
  const none = buildAlertEvidence(input({ candidate: null, key: `rug:${MINT}`, kind: 'rug' }));
  assert.equal(none.data_quality.status, 'UNKNOWN');
});

test('the evidence is stored as an immutable event and reads back identical', async () => {
  const dir = await tmp(), store = await FileEventStore.open(dir, { clock: () => T0 + 1 });
  const e = buildAlertEvidence(input());
  await store.append([alertGeneratedEvent(e), alertDeliveredEvent(e, T0 + 900, [{ channel: 'ntfy', ok: true, status: 200, error: null }])]);
  await store.close();
  const [gen, del] = await queryDir(dir);
  assert.deepEqual(gen!.payload, e as unknown as Record<string, unknown>);
  assert.equal(del!.payload.status, 'DELIVERED');
  assert.equal(del!.payload.latency_ms, 900);
  assert.equal((await verifyStore(dir)).ok, true);
});

test('desk recorder: alerts, deliveries, tape and health are recorded without ever throwing', async () => {
  const dir = await tmp();
  const rec = await DeskResearchRecorder.open(dir, { clock: () => T0 + 5, flushMs: 60_000, recordTape: true });
  const { evidence, body } = rec.alert(input());
  assert.ok(evidence && body.includes(evidence.alert_id));
  rec.delivered(evidence!, [{ channel: 'ntfy', ok: false, status: 500, error: null }]);
  rec.tape({ at: T0, mint: MINT, priceUsd: 0.0001, marketCapUsd: 100_000, signal: true, summary: 'all pass' }, 'PAPER');
  rec.tape({ at: Number.NaN, mint: 'not-a-mint' }, 'PAPER');
  rec.heartbeat({ modes: { PAPER: { scanner: true, lastScanAt: T0 } } });
  const plain = await DeskResearchRecorder.open(await tmp(), { enrichMessages: false });
  assert.equal(plain.alert(input()).body, input().body, 'DESK_ALERT_EVIDENCE=off keeps the phone text');
  await plain.close();
  await rec.close();
  const types = (await queryDir(dir)).map(e => e.event_type).sort();
  assert.deepEqual(types, ['AlertDelivered', 'AlertGenerated', 'HealthSnapshot', 'MarketSnapshot', 'SignalEvaluated']);
  assert.equal(rec.status.failures, 0);
  // After close: still no throw; the failure is counted.
  assert.doesNotThrow(() => rec.alert(input({ key: `golden:other`, at: T0 + 10 })));
  await rec.flush();
  assert.ok(rec.status.failures + rec.status.dropped > 0);
});

const ev = (i: EventInput) => makeEvent(i, i.observed_at ?? i.timestamp);
const scan = (at: number) => ev(deskEventToInput({ id: at, at, mode: 'PAPER', stage: 'SCANNING', mint: null, symbol: null, message: 'Scan started' })!);
const scans = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / 30_000) + 1 }, (_, i) => scan(from + i * 30_000));

test('why did I not get an alert: every stage of the pipeline has an answer', () => {
  const W = { token: MINT, from: T0, to: T0 + 600_000 };
  assert.equal(explainMissingAlert([], W).verdict, 'SYSTEM_NOT_RUNNING');
  const running = scans(T0, T0 + 600_000);
  assert.equal(explainMissingAlert(running, W).verdict, 'NEVER_OBSERVED');
  const gap = explainMissingAlert([...scans(T0, T0 + 100_000), ...scans(T0 + 500_000, T0 + 600_000)], W);
  assert.equal(gap.verdict, 'NEVER_OBSERVED');
  assert.match(gap.explanation, /interrupted for 7 min/);

  const filtered = [...running, ...[1, 2, 3].map(i => ev(deskEventToInput({ id: 900 + i, at: T0 + i * 30_000, mode: 'PAPER', stage: 'FILTERED', mint: MINT, symbol: 'AGENCY', message: 'buy/sell 1.1 < 1.4' })!))];
  const f = explainMissingAlert(filtered, W);
  assert.equal(f.verdict, 'FILTERED');
  assert.equal(f.reasons[0]!.count, 3);
  assert.match(f.explanation, /buy\/sell 1\.1 < 1\.4/);

  const tape = (signal: boolean, at: number) => tapeToInputs({ at, mint: MINT, priceUsd: 0.0001, signal, summary: signal ? 'all pass' : '5m volume $31K < $50K' }, 'PAPER').map(ev);
  assert.equal(explainMissingAlert([...running, ...tape(false, T0 + 60_000)], W).verdict, 'NO_SIGNAL');
  assert.equal(explainMissingAlert([...running, ...tape(true, T0 + 60_000)], W).verdict, 'SIGNAL_WITHOUT_ALERT');

  const alert = (decision: AlertInput['delivery']['decision']) => buildAlertEvidence(input({ at: T0 + 120_000, delivery: { decision, channels: decision === 'NO_CHANNEL' ? [] : ['ntfy'], selectedKinds: ['rug'] } }));
  const suppressed = explainMissingAlert([...running, ev(alertGeneratedEvent(alert('SUPPRESSED_BY_CONFIG')))], W);
  assert.equal(suppressed.verdict, 'SUPPRESSED_BY_CONFIG');
  assert.match(suppressed.explanation, /DESK_ALERTS selects only rug/);
  assert.equal(explainMissingAlert([...running, ev(alertGeneratedEvent(alert('NO_CHANNEL')))], W).verdict, 'NO_CHANNEL');
  const sent = alert('SENT');
  const failed = [...running, ev(alertGeneratedEvent(sent)), ev(alertDeliveredEvent(sent, T0 + 121_000, [{ channel: 'ntfy', ok: false, status: 429, error: null }]))];
  assert.equal(explainMissingAlert(failed, W).verdict, 'DELIVERY_FAILED');
  const ok = [...running, ev(alertGeneratedEvent(sent)), ev(alertDeliveredEvent(sent, T0 + 121_000, [{ channel: 'ntfy', ok: true, status: 200, error: null }]))];
  const delivered = explainMissingAlert(ok, W);
  assert.equal(delivered.verdict, 'DELIVERED');
  assert.match(delivered.explanation, /delivered \(DELIVERED\) 1 s later/);
});

test('health registry grades components and gives the system verdict', () => {
  let now = T0;
  const h = new HealthRegistry(() => now);
  h.register({ name: 'scan', expectedEveryMs: 30_000, critical: true });
  h.register({ name: 'xfeed', expectedEveryMs: 30_000, critical: false });
  assert.equal(h.snapshot(false).healthy, false, 'never seen');
  h.beat('scan'); h.latency('scan', 1200); h.latency('scan', 4000); h.gauge('queue', 3);
  now += 50_000;
  const s = h.snapshot(false);
  assert.equal(s.healthy, true);
  assert.equal(s.components.find(c => c.name === 'xfeed')!.status, 'NEVER_SEEN');
  assert.equal(s.latencies.scan!.max, 4000);
  now += 400_000;
  assert.equal(h.snapshot(false).healthy, false);
});

test('desk artifacts import: event log, rotated tape, ledgers; re-import adds nothing', async () => {
  const dir = await tmp();
  const log = [
    { id: 1, at: T0, mode: 'PAPER', stage: 'SCANNING', mint: null, symbol: null, message: 'Scan started' },
    { id: 2, at: T0 + 1, mode: 'PAPER', stage: 'FILTERED', mint: MINT, symbol: 'AGENCY', message: 'liquidity < $10K' },
    { id: 3, at: T0 + 2, mode: 'PAPER', stage: 'PREFLIGHT', mint: MINT, symbol: 'AGENCY', message: 'drag 1.2 %', detail: { dragPct: 1.2 } },
    { id: 4, at: T0 + 3, mode: 'PAPER', stage: 'CONFIRMED', mint: MINT, symbol: 'AGENCY', message: 'paper fill' },
  ];
  await fs.writeFile(path.join(dir, 'events-PAPER.log.jsonl'), log.map(r => JSON.stringify(r)).join('\n') + '\n{broken\n');
  const row: TapeRow = { at: T0, mint: MINT, symbol: 'AGENCY', priceUsd: 0.00012, marketCapUsd: 120_000, liquidityUsd: 30_000, poolAgeMin: 6, volume5mUsd: 70_000,
    buys5m: 150, sells5m: 80, priceChange5mPct: 15, top10WalletPct: null, largestWalletPct: null, signal: true, summary: 'all CRASH checks pass' };
  await fs.writeFile(path.join(dir, 'tape-PAPER.jsonl'), JSON.stringify(row) + '\n');
  await fs.writeFile(path.join(dir, 'tape-PAPER.jsonl.1'), JSON.stringify({ ...row, at: T0 - 600_000, signal: false }) + '\n');
  await fs.writeFile(path.join(dir, 'tape-PAPER.jsonl.2026-10-02T03-00-00-000Z'), JSON.stringify({ ...row, at: T0 - 300_000, signal: false }) + '\n');
  const entry = { id: 'e1', at: T0 + 3, mode: 'PAPER', mint: MINT, symbol: 'AGENCY', side: 'BUY', status: 'PAPER_FILLED', txSignature: null, netPnlUsd: null };
  await fs.writeFile(path.join(dir, 'ledger-PAPER-CRASH.json'), JSON.stringify({ entries: [entry] }));
  await fs.writeFile(path.join(dir, 'ledger-PAPER-CRASH.cycle-2026-10-01T12-00-00-000Z.json'), JSON.stringify({ entries: [{ ...entry, id: 'e0', at: T0 - 86_400_000 }] }));
  assert.deepEqual(ledgerStrategy('ledger-LIVE-CRASH-9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin.json'), { mode: 'LIVE', strategy: 'CRASH', wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', kind: 'current' });
  assert.equal(ledgerStrategy('ledger-PAPER.json')!.strategy, 'FAIR');

  const { inputs, report } = await deskArtifactInputs(dir);
  assert.equal(report.badLines, 1);
  assert.equal(report.files.length, 6);
  const store = new MemoryEventStore(() => T0 + 1_000);
  const first = await store.append(inputs);
  assert.ok(first.every(r => r.status === 'APPENDED'));
  assert.ok((await store.append((await deskArtifactInputs(dir)).inputs)).every(r => r.status === 'DUPLICATE'));
  const byType = (await store.stats()).byType;
  assert.deepEqual(byType, { PipelineStage: 1, ScanDecision: 1, ExecutionAttempt: 1, ExecutionResult: 3, MarketSnapshot: 3, SignalEvaluated: 3 });

  // Research features on the tape reproduce what the desk's CRASH rule decided live, for the gates it models.
  const view = new KnowledgeIndex(store.all(), 'OBSERVED').at(T0);
  const values = computeFeatures(standardRegistry(), CRASH_V001.entry.map(r => r.feature), view, MINT).values;
  assert.equal(values['pool_age_min@v1'], 6);
  assert.equal(values['buy_sell_ratio_5m@v1'], 150 / 80);
  assert.equal(evaluateEntry(CRASH_V001, values).signal, true);
});

test('backtest cache import keeps the download-time pool snapshot out of earlier decisions (AUDIT #4)', async () => {
  const dir = await tmp(), downloaded = T0 + 6 * 3_600_000, sec = (t: number) => Math.floor(t / 1000);
  await fs.mkdir(path.join(dir, 'birdeye'), { recursive: true });
  await fs.writeFile(path.join(dir, 'graduations.json'), JSON.stringify({ sig1: { mint: MINT, at: T0 }, sig2: { mint: null, at: T0 } }));
  await fs.writeFile(path.join(dir, 'pools.json'), JSON.stringify({ [MINT]: { mint: MINT, symbol: 'AGENCY', pool: 'PoolAddr1111111111111111111111111111111111', dex: 'pumpswap',
    createdAt: T0, priceUsd: 0.0002, liquidityUsd: 80_000, marketCapUsd: 200_000, volume24hUsd: 2e6 } }));
  const bars = Array.from({ length: 5 }, (_, i) => ({ unixTime: sec(T0) + i * 60, o: 0.0001, h: 0.00012, l: 0.00009, c: 0.00011, v: 1e8 }));
  await fs.writeFile(path.join(dir, 'birdeye', `${MINT}-${sec(T0) - 60}-${sec(T0) + 600}.json`), JSON.stringify(bars));
  for (const f of ['graduations.json', 'pools.json', `birdeye/${MINT}-${sec(T0) - 60}-${sec(T0) + 600}.json`]) await fs.utimes(path.join(dir, f), downloaded / 1000, downloaded / 1000);
  const { inputs, report } = await backtestCacheInputs(dir);
  assert.deepEqual([report.graduations, report.pools, report.candles, report.skipped], [1, 1, 5, 1]);
  const events: ResearchEvent[] = inputs.map(i => makeEvent(i, downloaded));
  const idx = new KnowledgeIndex(events, 'AVAILABLE'), r = standardRegistry();
  const early = computeFeatures(r, ['liquidity_usd@v1', 'price_usd@v1', 'pool_age_min@v1', 'market_cap_usd@v1'], idx.at(T0 + 3 * 60_000 + 1_000), MINT).values;
  assert.equal(early['liquidity_usd@v1'], null, 'the later liquidity observation is not known during the pump');
  assert.equal(early['price_usd@v1'], 0.00011);
  assert.equal(early['market_cap_usd@v1'], 0.00011 * 1e6 * 1_000 / 1_000 * 1_000);
  assert.equal(early['pool_age_min@v1'], 3 + 1 / 60);
  const late = computeFeatures(r, ['liquidity_usd@v1'], idx.at(downloaded + 1), MINT).values;
  assert.equal(late['liquidity_usd@v1'], 80_000);
});

test('observer ledger import: launches, trades, curve, X posts and gaps as canonical events', async () => {
  const dir = await tmp(), sec = (t: number) => Math.floor(t / 1000);
  const lines = [
    ['M', 0, MINT], ['W', 0, 'Creator11111111111111111111111111111111111'], ['W', 1, 'Buyer111111111111111111111111111111111111'],
    ['PC', T0 + 400, 0, 0, 'sigpc', 'Agency', 'AGENCY', 'ipfs://x', 1.5, 5e13, 28, 0],
    ['C', T0 + 300, sec(T0), 100, 0, 0, null, 'sigc', 'Agency', 'AGENCY', 'ipfs://x'],
    ['T', T0 + 5_000, sec(T0) + 4, 110, 0, 1, 1, 2e9, 6e13, 32e9, 1.0e15, 7.0e14, 'sigt1'],
    ['T', T0 + 9_000, sec(T0) + 8, 115, 0, 0, 0, 5e8, 1e13, 31e9, 1.0e15, 7.1e14, 'sigt2'],
    ['K', sec(T0), 0, 30, 34, 29, 33, 4e9, 5e8, 5, 1, 4, 4, 0.12],
    ['META', T0 + 2_000, 0, { tw: 'https://x.com/agency', web: 'https://agency.example', tg: null, desc: 'Agency' }],
    ['XT', T0 + 360_000, 0, 'agency', '1974', T0 + 120_000, { a: 'agency', t: 'CA: …', v: 5_000, mint: 1 }],
    ['GAP', T0 + 50_000, 'rpc-logs', 'stalled 12 s'],
  ];
  await fs.writeFile(path.join(dir, 'ev-20261002-03.jsonl.gz'), gzipSync(lines.map(l => JSON.stringify(l)).join('\n') + '\n'));
  await fs.writeFile(path.join(dir, 'ignored.txt'), 'x');
  const { inputs, report } = await observerInputs(dir, { solUsd: () => 150 });
  assert.equal(report.files, 1);
  const events = inputs.map(i => makeEvent(i, T0 + 400_000));
  const types = events.map(e => e.event_type).sort();
  assert.deepEqual(types, ['Buy', 'Candle', 'CreatorBuy', 'CreatorSell', 'CurveProgress', 'DataQualityIssue', 'SocialLinkDiscovered', 'SocialLinkDiscovered',
    'TokenCreated', 'TokenCreated', 'XContractAddressPost'].sort());
  const buy = events.find(e => e.event_type === 'Buy')!;
  assert.equal(buy.timestamp, (sec(T0) + 4) * 1000);
  assert.equal(buy.payload.amount_usd, 300);
  assert.equal(buy.ingestion_latency_ms, T0 + 5_000 - (sec(T0) + 4) * 1000);
  assert.equal(events.find(e => e.event_type === 'CreatorSell')!.payload.wallet, 'Creator11111111111111111111111111111111111');
  const post = events.find(e => e.event_type === 'XContractAddressPost')!;
  assert.equal(post.available_at, T0 + 150_000, 'known 30 s after posting');
  assert.equal(post.observed_at, T0 + 360_000, 'though this collector read it at +6 min');
  assert.equal(post.payload.own_account, true);
  const candle = events.find(e => e.event_type === 'Candle')!;
  assert.equal(candle.payload.c, 33 * 150 / 1e9);
  assert.equal(events.find(e => e.event_type === 'CurveProgress')!.payload.progress_pct, 12);
  // The own-account CA post is a feature only from when it was knowable.
  const idx = new KnowledgeIndex(events, 'AVAILABLE'), r = standardRegistry();
  assert.equal(computeFeatures(r, ['ca_post_latency_ms@v1'], idx.at(T0 + 140_000), MINT).values['ca_post_latency_ms@v1'], null);
  assert.equal(computeFeatures(r, ['ca_post_latency_ms@v1'], idx.at(T0 + 151_000), MINT).values['ca_post_latency_ms@v1'], 120_000);
});

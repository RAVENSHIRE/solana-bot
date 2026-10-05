import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeskEngine } from '../src/desk/engine';
import { savedPhoneAlerts } from '../src/desk/runtime';
import { notifier } from '../src/desk/watch';
import { ResearchLedger } from '../src/research/ledger';
import { readDataset, features, type LaunchFacts } from '../src/research/dataset';

// Regression tests for the CTO quality ledger (docs/cto/QUALITY-LEDGER.md). Synthetic fixtures only.

test('CTO-01: a failing telemetry write (event log, tape) never skips saving the ledgers', async () => {
  const saved: string[] = [];
  const engine = {
    events: { flush: async () => { throw new Error('EPERM: events-LIVE.json is locked'); } },
    tape: [{ mint: 'X' }], d: { dir: path.join(os.tmpdir(), 'cto-missing-dir', 'nested'), mode: 'LIVE' },
    books: () => [{ id: 'FAIR', ledger: { save: async () => { saved.push('FAIR'); } } }, { id: 'CRASH', ledger: { save: async () => { saved.push('CRASH'); } } }],
  };
  await assert.rejects(DeskEngine.prototype.persist.call(engine as never), /EPERM/, 'the failure is still reported');
  assert.deepEqual(saved, ['FAIR', 'CRASH'], 'positions and orders are saved even though the telemetry write failed');
});

test('CTO-02: an unreadable phone-alerts.json sends nothing to the phone instead of silently falling back to DESK_ALERTS', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-phone-')), file = path.join(dir, 'phone-alerts.json');
  assert.equal(await savedPhoneAlerts(file), null, 'no file: no choice made, DESK_ALERTS applies');
  await fs.writeFile(file, '{"kinds":["op');
  const kinds = await savedPhoneAlerts(file);
  assert.ok(kinds, 'a choice was made but cannot be read: it is not treated as "no choice"');
  assert.deepEqual([...kinds], []);
});

test('CTO-03: the notifier keeps a delivery health record (HTTP refusals and network errors count as failures)', async () => {
  let reply: () => Promise<Response> = async () => new Response('', { status: 200 });
  const failures: string[] = [];
  const n = notifier({ DESK_NTFY_TOPIC: 'raven-desk-8f3k2' }, (async () => reply()) as unknown as typeof fetch, { onFailure: r => failures.push(`${r.channel} ${r.status ?? r.error}`) });
  await n.notify('A', 'ok');
  reply = async () => new Response('', { status: 429 });
  await n.notify('B', 'rate limited');
  reply = async () => { throw new TypeError('fetch failed'); };
  await n.notify('C', 'offline');
  const h = n.health();
  assert.equal(h.sent, 3); assert.equal(h.delivered, 1); assert.equal(h.failed, 2);
  assert.ok(h.lastOkAt !== null && h.lastFailureAt !== null && h.lastFailureAt >= h.lastOkAt);
  assert.equal(h.lastError, 'ntfy TypeError');
  assert.deepEqual(failures, ['ntfy 429', 'ntfy TypeError']);
});

test('CTO-04: a failed research-ledger write is counted, recorded as a GAP, and does not orphan later records of the same mint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-ledger-'));
  const now = Date.parse('2026-10-02T10:30:00Z'), file = path.join(dir, 'ev-20261002-10.jsonl');
  const ledger = new ResearchLedger({ dir, now: () => now, freeBytes: async () => 10_000 * 1048576 });
  await ledger.start();
  // The hour's file cannot be written (a directory in its place stands for a locked or full disk).
  await fs.mkdir(file);
  ledger.put(['T', now, { $m: 'MINT1' }, { $w: 'W1' }, 1]);
  await ledger.flush();
  assert.equal(ledger.writeErrors, 1);
  await fs.rmdir(file);
  ledger.put(['T', now + 1, { $m: 'MINT1' }, { $w: 'W1' }, 0]);
  await ledger.close();
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as unknown[]);
  assert.ok(rows.some(r => r[0] === 'GAP' && r[2] === 'ledger'), 'the lost lines are recorded as a gap');
  assert.ok(rows.some(r => r[0] === 'M' && r[2] === 'MINT1'), 'the dictionary line is written again');
  const ds = readDataset([file]);
  assert.ok(ds.gaps.some(g => g.source === 'ledger'));
});

test('CTO-05: X account facts read after the decision time do not leak into its features', () => {
  const t0 = Date.parse('2026-10-02T12:00:00Z');
  const l: LaunchFacts = { mint: 'MINTA', createdObs: t0, createdTs: t0, creator: null, creatorW: null, devBuySol: null, name: 'A', symbol: 'A', mayhem: false,
    trades: [], candles: [], completeObs: null, migrateObs: null, meta: { tw: 'https://x.com/tryagency', web: null, tg: null, desc: null }, metaError: false,
    xReads: [{ obs: t0 + 6 * 60_000, st: 'OK', followers: 5_000, joined: t0 - 86_400_000, statuses: 10 }], xPosts: [], sites: [] };
  const at60 = features(l, 60, { creatorLaunches: 0, creatorGraduations: 0 }, []);
  assert.equal(at60.xFollowers, null, 'the profile was first read at +6 min');
  assert.equal(at60.xAccountAgeH, null);
  const at600 = features(l, 600, { creatorLaunches: 0, creatorGraduations: 0 }, []);
  assert.equal(at600.xFollowers, 5_000);
});

test('CTO-06 (Q-19): a failed event-log write is retried on the next flush, and no history row is lost', async () => {
  const { EventLog } = await import('../src/desk/events');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-events-')), dir = path.join(root, 'later'), file = path.join(dir, 'events-PAPER.json');
  const log = new EventLog('PAPER', file, () => 1_000);
  log.add('SYSTEM', 'first');
  await assert.rejects(log.flush(), 'the folder does not exist yet');
  await fs.mkdir(dir);
  await log.flush();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).length, 1, 'retried without a new event');
  const history = (await fs.readFile(path.join(dir, 'events-PAPER.log.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(history.length, 1);
});

test('CTO-07 (Q-20, OPEN cap): sent alerts and the OPEN phone cap survive a restart', async () => {
  const { ALERT_MEMORY } = await import('../src/desk/engine');
  const proto = DeskEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-alerts-')), now = Date.now();
  const engine = () => {
    const e: Record<string, unknown> = { d: { dir, mode: 'PAPER', alerts: new Set(['open']) }, launchAlerts: new Map<string, number>(), openPhoneSent: [] as number[],
      alertWrite: Promise.resolve(), event: () => undefined };
    for (const m of ['alertMemoryFile', 'loadAlertMemory', 'saveAlertMemory', 'openPhoneSlot']) e[m] = proto[m]!.bind(e);
    return e as { launchAlerts: Map<string, number>; openPhoneSent: number[]; alertWrite: Promise<void>; loadAlertMemory: () => Promise<void>; saveAlertMemory: () => void; openPhoneSlot: (n: number) => boolean };
  };
  const before = engine();
  for (let i = 0; i < 4; i++) assert.equal(before.openPhoneSlot(now - 50 * 60_000 + i * 60_000), true);
  assert.equal(before.openPhoneSlot(now), false, '4 an hour');
  before.launchAlerts.set('open:MINT1', now - 60_000);
  before.launchAlerts.set('radar:OLD', now - ALERT_MEMORY.keepMs - 60_000);
  before.saveAlertMemory(); await before.alertWrite;
  const after = engine();
  await after.loadAlertMemory();
  assert.ok(after.launchAlerts.has('open:MINT1'), 'a coin alerted before the restart is not alerted again');
  assert.ok(!after.launchAlerts.has('radar:OLD'), 'keys older than the memory window are dropped');
  assert.equal(after.openPhoneSent.length, 4);
  assert.equal(after.openPhoneSlot(now), false, 'the restart does not reset the OPEN cap');
  assert.equal(after.openPhoneSlot(now + 11 * 60_000), true, 'the oldest slot expires after an hour');
});

test('CTO-08 (Q-17): the daily ALIVE message goes out once a day from 07:00 UTC, also across restarts', async () => {
  const { AliveReporter } = await import('../src/research/alive');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-alive-')), file = path.join(dir, 'alive.json'), sent: string[] = [];
  let now = Date.parse('2026-10-05T06:59:00Z');
  const reporter = () => new AliveReporter({ file, now: () => now, notify: async (t, b) => { sent.push(`${t}|${b}`); }, lines: () => ['desk last read the feed 2 s ago'] });
  const a = reporter();
  assert.equal(await a.tick(), false, 'not before 07:00 UTC');
  now = Date.parse('2026-10-05T07:00:30Z');
  assert.equal(await a.tick(), true); assert.equal(await a.tick(), false, 'once a day');
  assert.equal(await reporter().tick(), false, 'a restart the same day does not send it again');
  now = Date.parse('2026-10-06T09:15:00Z');
  assert.equal(await reporter().tick(), true, 'the next day');
  assert.equal(sent.length, 2); assert.match(sent[0]!, /^ALIVE: research observer\|desk last read the feed/);
});

test('CTO-09 (Q-17): the desk reads the observer\'s /health and the dashboard strip flags a silent observer or a failing phone', async () => {
  const { LocalFeed } = await import('../src/research/local-feed');
  const { LocalPumpStream } = await import('../src/desk/pump-stream');
  const { healthLines } = await import('../src/desk/health');
  const feed = new LocalFeed(() => true, () => ({ startedAt: Date.now() - 3_600_000, ledger: { writeErrors: 2 }, phone: { sent: 3, delivered: 2, failed: 1, lastOkAt: 1, lastFailureAt: 2, lastError: 'ntfy HTTP 429' } }));
  await feed.listen(0);
  const port = ((feed as unknown as { server: { address(): { port: number } } }).server).address().port;
  try {
    const stream = new LocalPumpStream(`http://127.0.0.1:${port}/pump/events`);
    await stream.poll();
    // /health is read beside the poll (never blocking it): wait for it.
    for (let i = 0; i < 50 && !stream.observer().report; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(feed.lastPollAt !== null, 'the observer knows when the desk last read it');
    const seen = stream.observer();
    assert.ok(seen.seenAt !== null && seen.report !== null);
    const now = Date.now(), lines = healthLines({ observer: seen, streamOff: false, phone: null, channels: 0 }, now);
    const obs = lines.find(l => l.label === 'Research observer')!, phone = lines.find(l => l.label.startsWith('Observer phone'))!;
    assert.equal(obs.bad, true, '2 ledger write errors'); assert.match(obs.text, /2 ledger write errors/);
    assert.equal(phone.bad, true, 'the last delivery failed'); assert.match(phone.text, /ntfy HTTP 429/);
    const later = healthLines({ observer: seen, streamOff: false, phone: null, channels: 0 }, now + 5 * 60_000);
    assert.match(later.find(l => l.label === 'Research observer')!.text, /DOWN\?/, 'no answer for 5 min');
    const never = healthLines({ observer: { seenAt: null, streamHealthy: false, report: null, reportAt: null }, streamOff: false, phone: null, channels: 0 }, now);
    assert.equal(never[0]!.bad, true);
    const recovered = healthLines({ observer: null, streamOff: true, channels: 1, phone: { sent: 2, delivered: 1, failed: 1, lastOkAt: now, lastFailureAt: now - 1_000, lastError: 'ntfy TypeError' } }, now);
    assert.equal(recovered.find(l => l.label.startsWith('Desk phone'))!.bad, false, 'a delivery after the failure clears the warning');
  } finally { feed.close(); }
});

test('CTO-10 (Q-11): the requalification heap is a share of free memory, capped, and postponed when memory is short', async () => {
  const { qualifyHeapMb, QUALIFY_MEMORY } = await import('../src/research/qualify');
  const MB = 1048576;
  assert.equal(qualifyHeapMb(4_000 * MB), QUALIFY_MEMORY.maxHeapMb, 'plenty free: the old 1.5 GB cap');
  assert.equal(qualifyHeapMb(1_700 * MB), 1_020, 'Raven with 1.7 GB free: 60 % of it, not 1.5 GB');
  assert.equal(qualifyHeapMb(600 * MB), null, 'under ~850 MB free: postponed, the previous qualification stays');
});

test('CTO-11 (Q-16): by default no desk alert reaches the phone; it is still recorded once; a selected kind is sent', async () => {
  const { DEFAULT_ALERTS } = await import('../src/desk/engine');
  assert.equal(DEFAULT_ALERTS.size, 0, 'owner, 2 Oct: nothing on the phone unless chosen');
  const proto = DeskEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fake = (alerts?: Set<string>) => {
    const sent: string[] = [];
    const e: Record<string, unknown> = { d: { notify: async (t: string) => { sent.push(t); }, alerts, research: null, mode: 'PAPER' }, launchAlerts: new Map(), saveAlertMemory: () => undefined };
    for (const m of ['alertOnce', 'recordAlert']) e[m] = proto[m]!.bind(e);
    return { e: e as { alertOnce: (k: string, t: string, b: string, kind: string, phone?: boolean) => void; launchAlerts: Map<string, number> }, sent };
  };
  const quiet = fake();
  for (const kind of ['golden', 'rug', 'open', 'launch', 'radar']) quiet.e.alertOnce(`${kind}:MINT`, `${kind} title`, 'body', kind);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(quiet.sent, [], 'DEFAULT_ALERTS: nothing sent');
  assert.equal(quiet.e.launchAlerts.size, 5, 'each alert is still remembered (dashboard, event log)');
  const chosen = fake(new Set(['rug']));
  chosen.e.alertOnce('rug:MINT', 'RUG', 'b', 'rug'); chosen.e.alertOnce('rug:MINT', 'RUG again', 'b', 'rug'); chosen.e.alertOnce('radar:MINT', 'radar', 'b', 'radar');
  chosen.e.alertOnce('rug:OTHER', 'RUG over the cap', 'b', 'rug', false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(chosen.sent, ['RUG'], 'once per key, only selected kinds, never when the caller says no phone');
});

test('CTO-12 (Q-21): a save that fails after a TEST probe is reported in the event log, not swallowed', async () => {
  const proto = DeskEngine.prototype as unknown as { probe: (this: unknown, mint: string) => Promise<void> };
  const events: string[] = [];
  const e = { d: { mode: 'PAPER' }, work: null as Promise<void> | null, candidates: new Map(),
    syncWallet: async () => { throw new Error('wallet unavailable'); },
    persist: async () => { throw new Error('EPERM: ledger-PAPER.json'); },
    event: (stage: string, message: string) => { events.push(`${stage} ${message}`); } };
  await assert.rejects(proto.probe.call(e, 'MINT'), /wallet unavailable/);
  assert.ok(events.some(x => x.startsWith('FAILED Saving desk state failed: EPERM')), events.join(' | '));
  assert.equal(e.work, null);
});

test('CTO-13 (Q-25, Q-26, Q-30): the docs say what the code does', async () => {
  const { DEFAULT_ALERTS } = await import('../src/desk/engine');
  const desk = await fs.readFile(path.join(process.cwd(), 'docs', 'DESK.md'), 'utf8');
  const engine = await fs.readFile(path.join(process.cwd(), 'src', 'desk', 'engine.ts'), 'utf8');
  assert.equal(DEFAULT_ALERTS.size, 0);
  assert.match(desk, /The default is \*\*none\*\*/, 'DESK.md: no desk alert on the phone by default');
  assert.doesNotMatch(engine, /Default: rug sales of held positions only/, 'engine comment matches DEFAULT_ALERTS');
  assert.doesNotMatch(desk, /^- Empty token accounts are not closed automatically/m, 'the local key closes them after each exit');
  const pm2 = await fs.readFile(path.join(process.cwd(), 'ecosystem.config.js'), 'utf8');
  assert.match(pm2, /LEGACY/);
  assert.deepEqual([...pm2.matchAll(/script: '([^']+)'/g)].map(m => m[1]), ['./dist/index.js', './dist/dashboard/server.js'], 'PM2 runs only the legacy bot and its dashboard');
});

test('CTO-14 (review): ALIVE never throws on a damaged alive.json or a failing status, and the alert memory survives a null file', async () => {
  const { AliveReporter } = await import('../src/research/alive');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-review-')), file = path.join(dir, 'alive.json'), sent: string[] = [];
  const now = Date.parse('2026-10-05T08:00:00Z');
  for (const damaged of ['', 'null', '{"day":', '[1,2]']) {
    await fs.writeFile(file, damaged);
    const a = new AliveReporter({ file, now: () => now, notify: async t => { sent.push(t); }, lines: () => { throw new Error('observer not ready'); } });
    assert.equal(await a.tick(), true, `damaged file ${JSON.stringify(damaged)} means "not sent today"`);
  }
  assert.equal(sent.length, 4);
  const proto = DeskEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  await fs.writeFile(path.join(dir, 'alerts-sent-PAPER.json'), 'null');
  const e: Record<string, unknown> = { d: { dir, mode: 'PAPER' }, launchAlerts: new Map(), openPhoneSent: [] };
  for (const m of ['alertMemoryFile', 'loadAlertMemory']) e[m] = proto[m]!.bind(e);
  await (e.loadAlertMemory as () => Promise<void>)();
  assert.equal((e.launchAlerts as Map<string, number>).size, 0, 'a null file starts empty instead of stopping the desk');
});

test('CTO-15 (review): the OPEN phone slot is only taken for a new alert; a burst of alerts is saved in one or two writes', async () => {
  const proto = DeskEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  let asked = 0, writes = 0;
  const e: Record<string, unknown> = { d: { notify: async () => undefined, alerts: new Set(['open']), research: null, mode: 'PAPER', dir: os.tmpdir() },
    launchAlerts: new Map([['open:MINT', Date.now()]]), alertWrite: Promise.resolve(), alertSavePending: false, event: () => undefined,
    alertMemoryFile: () => { writes++; return path.join(os.tmpdir(), `cto-alerts-${process.pid}.json`); }, openPhoneSent: [] };
  for (const m of ['alertOnce', 'recordAlert', 'saveAlertMemory']) e[m] = proto[m]!.bind(e);
  const alertOnce = e.alertOnce as (k: string, t: string, b: string, kind: string, phone?: boolean | (() => boolean)) => void;
  alertOnce('open:MINT', 'again', 'b', 'open', () => { asked++; return true; });
  assert.equal(asked, 0, 'an alert already sent never asks for (and uses up) a phone slot');
  for (let i = 0; i < 40; i++) alertOnce(`radar:M${i}`, 't', 'b', 'radar');
  await (e.alertWrite as Promise<void>);
  assert.ok(writes >= 1 && writes <= 2, `${writes} writes for 40 alerts`);
});

test('CTO-16 (review): a channel that always fails is flagged even while another delivers; stale observer reports and failed qualifications show', async () => {
  const { healthLines } = await import('../src/desk/health');
  const { LocalPumpStream } = await import('../src/desk/pump-stream');
  const n = notifier({ DESK_NTFY_TOPIC: 'raven-desk-8f3k2', DESK_TELEGRAM_BOT_TOKEN: '123:abc_DEF', DESK_TELEGRAM_CHAT_ID: '-42' },
    (async (url: string) => new Response('', { status: String(url).includes('telegram') ? 401 : 200 })) as unknown as typeof fetch);
  await n.notify('A', 'b'); await n.notify('B', 'b');
  assert.deepEqual(n.health().failing, ['Telegram']);
  const now = Date.now(), desk = healthLines({ observer: null, streamOff: true, phone: n.health(), channels: 2 }, now).find(l => l.label.startsWith('Desk phone'))!;
  assert.equal(desk.bad, true); assert.match(desk.text, /FAILING: Telegram/);
  // A report older than 90 s is dropped by the stream; the strip then shows no uptime or counters for a dead observer.
  const stream = new LocalPumpStream('http://127.0.0.1:9/pump/events');
  Object.assign(stream as unknown as Record<string, unknown>, { lastOkAt: now - 120_000, upstreamHealthy: true, report: { startedAt: now - 3_600_000 }, reportAt: now - 120_000 });
  assert.equal(stream.observer(now).report, null);
  const lines = healthLines({ observer: { seenAt: now - 120_000, streamHealthy: true, report: { startedAt: now - 3_600_000 }, reportAt: now - 120_000 }, streamOff: false, phone: null, channels: 0 }, now);
  assert.doesNotMatch(lines[0]!.text, /up \d/, 'no uptime for an observer that stopped answering');
  const q = healthLines({ observer: { seenAt: now, streamHealthy: true, reportAt: now, report: { qualification: { okAt: now - 7 * 3_600_000, failedAt: now - 60_000, error: 'exit 134 (out of heap)' } } }, streamOff: false, phone: null, channels: 0 }, now)
    .find(l => l.label.startsWith('Qualification'))!;
  assert.equal(q.bad, true); assert.match(q.text, /out of heap/);
});

test('CTO-17 (review): event history kept for retry is bounded while the history file stays unwritable', async () => {
  const { EventLog, EVENT_HISTORY_MAX_PENDING } = await import('../src/desk/events');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cto-history-'));
  await fs.mkdir(path.join(dir, 'events-PAPER.log.jsonl')); // a directory in its place: every append fails
  const log = new EventLog('PAPER', path.join(dir, 'events-PAPER.json'), () => 1_000);
  const priv = log as unknown as { unlogged: unknown[]; droppedHistory: number };
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < EVENT_HISTORY_MAX_PENDING / 2; i++) log.add('FILTERED', `token ${i}`);
    await assert.rejects(log.flush());
  }
  assert.equal(priv.unlogged.length, EVENT_HISTORY_MAX_PENDING, 'bounded');
  assert.equal(priv.droppedHistory, EVENT_HISTORY_MAX_PENDING / 2, 'the oldest rows are dropped and counted');
});

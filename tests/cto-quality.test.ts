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

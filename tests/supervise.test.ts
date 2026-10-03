import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JavaScript (runs on the PC without a build step)
import { SUPERVISE, Supervisor, claim, envKeys, nextDelay, rotate } from '../ops/supervise.mjs';

test('supervisor: restarts a stopped process, backs off while it keeps crashing, tells the phone once per half hour, quiet on a requested restart', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-'));
  let now = Date.parse('2026-10-03T16:00:00Z'), nextPid = 100;
  const running = new Set<number>(), started: string[] = [], phone: string[] = [];
  const s = new Supervisor({ repo, now: () => now, alive: (pid: number) => running.has(pid), notify: async (t: string) => { phone.push(t); },
    spawn: (c: { name: string }) => { const pid = nextPid++; running.add(pid); started.push(c.name); return pid; } });
  // Started by hand earlier: watched, not started twice.
  s.adopt([{ pid: 7, cmd: 'node --import tsx src/scripts/research-observe.ts' }]);
  running.add(7);
  s.tick();
  assert.deepEqual(started, ['dashboard'], 'the observer already runs');
  // The dashboard crashes after 2 h: started again after 3 s, one phone message.
  const dash = () => s.children.find((c: { name: string }) => c.name === 'dashboard');
  now += 2 * 3_600_000; running.delete(dash().pid); s.tick();
  assert.equal(dash().pid, null); assert.equal(dash().delayMs, SUPERVISE.firstDelayMs);
  assert.deepEqual(phone, ['Desk restarted: dashboard']);
  now += 2_000; s.tick(); assert.equal(started.length, 1, 'still waiting');
  now += 1_500; s.tick(); assert.equal(started.length, 2);
  // It keeps dying within seconds: 6 s, 12 s, … up to 5 min; no second message within 30 min.
  for (const expected of [6_000, 12_000, 24_000]) {
    now += 1_000; running.delete(dash().pid); s.tick();
    assert.equal(dash().delayMs, expected);
    now += expected; s.tick();
  }
  assert.equal(phone.length, 1);
  assert.equal(nextDelay(1_000, 4 * 60_000), SUPERVISE.maxDelayMs); assert.equal(nextDelay(SUPERVISE.stableMs, 4 * 60_000), SUPERVISE.firstDelayMs);
  // A requested restart (git pull): first delay, no message.
  now += SUPERVISE.alertGapMs;
  fs.mkdirSync(path.join(repo, 'data-desk'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data-desk', 'supervisor-restart.json'), JSON.stringify({ at: now }));
  running.delete(dash().pid); s.tick();
  assert.equal(dash().delayMs, SUPERVISE.firstDelayMs); assert.equal(phone.length, 1);
  assert.equal(s.status().children.find((c: { name: string }) => c.name === 'dashboard').restarts, 5);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('supervisor: one at a time (a fresh lock of a live process wins, a stale or dead one is taken over), logs rotated, .env read for the phone only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-lock-')), lock = path.join(dir, 'supervisor.lock');
  assert.equal(claim(lock, Date.now(), process.pid), true);
  assert.equal(claim(lock, Date.now(), 999_999), false, 'held by this live process');
  fs.writeFileSync(lock, '999998');
  assert.equal(claim(lock, Date.now(), process.pid), true, 'a dead process\'s lock is taken over');
  const old = new Date(Date.now() - SUPERVISE.staleMs - 1_000);
  fs.utimesSync(lock, old, old);
  assert.equal(claim(lock, Date.now(), 999_999), true, 'a lock without a heartbeat for 2 min is stale');
  const log = path.join(dir, 'dashboard.log');
  fs.writeFileSync(log, 'x'.repeat(2_000));
  assert.equal(rotate(log, 10_000), false);
  assert.equal(rotate(log, 1_000), true);
  assert.equal(fs.existsSync(log), false); assert.equal(fs.statSync(`${log}.1`).size, 2_000);
  const env = envKeys('WALLET_PRIVATE_KEY=secret\nDESK_NTFY_TOPIC="raven-topic-123"\n# DESK_NTFY_SERVER=x\nANTHROPIC_API_KEY=sk\n', ['DESK_NTFY_TOPIC', 'DESK_NTFY_SERVER']);
  assert.deepEqual(env, { DESK_NTFY_TOPIC: 'raven-topic-123' }, 'nothing but the phone channel');
  fs.rmSync(dir, { recursive: true, force: true });
});

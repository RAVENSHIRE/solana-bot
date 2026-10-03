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

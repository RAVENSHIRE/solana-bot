import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { TradingService, tradingEnvironment, deskFactory, type DeskFactory, type DeskHandle } from '../server/trading';
import { DeskReject } from '../../src/desk/guard';
import type { DeskEngine } from '../../src/desk/engine';
import type { DeskMode } from '../../src/desk/types';

// Minimal engine double: records control calls; the real pipeline is covered by tests/desk.test.ts.
function engine(mode: DeskMode) {
  const e = { mode, scanner: false, execution: false, busy: false, nextScanAt: null as number | null, pulses: 0,
    start() { e.scanner = true; e.execution = true; }, stop() { e.scanner = false; e.execution = false; },
    pause() { e.execution = false; }, resume() { if (!e.scanner) throw new DeskReject('SCANNER_OFF'); e.execution = true; },
    pulse: async () => { e.pulses++; }, tick: () => {}, settled: async () => {}, persist: async () => {}, events: { add: () => {} },
    status: (wallet: { connected: boolean; address: string | null }) => ({ mode, scanner: e.scanner, execution: e.execution, wallet }) };
  return e;
}
function service() {
  const engines = { PAPER: engine('PAPER'), LIVE: engine('LIVE') };
  let wallets: Parameters<DeskFactory>[0] | null = null;
  const factory: DeskFactory = async context => { wallets = context;
    return { engines: engines as unknown as Record<DeskMode, DeskEngine>, capital: { plannedStartingCapitalUsd: 5.45, baseEntryUsd: 2, slippageBps: 100 }, close: async () => {} } as DeskHandle; };
  return { trading: new TradingService(factory), engines, context: () => wallets! };
}
async function serve(trading: TradingService) {
  const server = http.createServer((req, res) => { void trading.handleRequest(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const post = (action: string, body: object, extra: Record<string, string> = {}) => fetch(`${base}/api/trading/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...extra }, body: JSON.stringify(body) });
  return { base, post, close: async () => { await trading.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}

test('desk API: same-origin capability, TEST without signing, LIVE only with a live Phantom session, never both at once', async (t) => {
  const { trading, engines, context } = service();
  const { base, post, close } = await serve(trading);
  try {
    const address = Keypair.fromSeed(new Uint8Array(32).fill(64)).publicKey.toBase58();
    assert.equal((await post('desk', { action: 'start-test' })).status, 403, 'capability required');
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    assert.equal((await post('desk', { action: 'start-test' }, { ...headers, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('desk', { action: 'start-test' }, headers)).status, 200);
    assert.equal(engines.PAPER.scanner, true); assert.equal(context().wallet('PAPER'), null, 'TEST without Phantom has no wallet, and never a signer');
    assert.equal((await (await post('desk', { action: 'select-mode', mode: 'LIVE' }, headers)).json()).message, 'STOP_CURRENT_MODE_FIRST');
    assert.equal((await (await post('desk', { action: 'start-live' }, headers)).json()).message, 'SESSION_REQUIRED');
    const s = await (await post('connect', { address }, headers)).json();
    assert.equal(context().wallet('PAPER')!.signer, null, 'TEST gets the address for simulation only');
    assert.ok(context().wallet('LIVE')!.signer, 'LIVE signs through the Phantom broker');
    assert.equal((await (await post('desk', { action: 'start-live', sessionId: s.sessionId }, headers)).json()).message, 'STOP_TEST_FIRST');
    assert.equal((await post('desk', { action: 'stop-test' }, headers)).status, 200);
    assert.equal((await post('desk', { action: 'start-live', sessionId: s.sessionId }, headers)).status, 200);
    assert.equal(engines.LIVE.scanner, true);
    const publicView = await (await fetch(`${base}/api/trading`)).json();
    assert.equal(publicView.session, null); assert.equal(publicView.pending, null); assert.equal(publicView.mode, 'LIVE');
    assert.equal((await fetch(`${base}/api/trading`, { headers: { 'X-Wallet-Session': s.sessionId } })).status, 403);
    const realNow = Date.now;
    const clock = t.mock.method(Date, 'now', () => realNow() + 13_000);
    await fetch(`${base}/api/trading`, { headers: { ...headers, 'X-Wallet-Session': s.sessionId } });
    clock.mock.restore();
    assert.equal(engines.LIVE.scanner, false, 'a late heartbeat ends LIVE and never resumes it');
    assert.equal((await post('desk', { action: 'start-live', sessionId: s.sessionId }, headers)).status, 200);
    assert.equal((await post('desk', { action: 'pause', sessionId: s.sessionId }, headers)).status, 200);
    assert.equal(engines.LIVE.execution, false); assert.equal(engines.LIVE.scanner, true, 'pause keeps scanning');
    assert.equal((await post('disconnect', { sessionId: s.sessionId }, headers)).status, 200);
    assert.equal(engines.LIVE.scanner, false, 'disconnecting Phantom stops LIVE');
    assert.equal((await post('desk', { action: 'resume', sessionId: s.sessionId }, headers)).status, 400);
  } finally { await close(); }
});

test('desk settings come from an allowlist that never loads the local private key', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.trading-test-'));
  try {
    await fs.writeFile(path.join(dir, '.env'), 'RPC_ENDPOINTS=https://fixture.invalid\nJUPITER_API_KEY=fixture-key\nWALLET_PRIVATE_KEY=never-load-this-test-value\n' +
      'SIMULATION_MODE=false\nDESK_PLANNED_CAPITAL_USD=5.45\nRS_STOP_LOSS_PCT=12\n');
    const env = await tradingEnvironment(dir);
    assert.equal(env.WALLET_PRIVATE_KEY, undefined); assert.equal(env.SIMULATION_MODE, 'true');
    assert.equal(env.DESK_PLANNED_CAPITAL_USD, '5.45'); assert.equal(env.RS_STOP_LOSS_PCT, '12');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a desk that cannot start reports why instead of pretending to scan', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.trading-test-'));
  const trading = new TradingService(deskFactory(dir));
  const { base, close } = await serve(trading);
  try {
    const view = await (await fetch(`${base}/api/trading`)).json();
    assert.equal(view.desk, null); assert.equal(view.deskError, 'RPC_NOT_CONFIGURED');
  } finally { await close(); await fs.rm(dir, { recursive: true, force: true }); }
});

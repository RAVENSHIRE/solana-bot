import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { TradingService, tradingEnvironment, deskFactory, type DeskFactory, type DeskHandle } from '../server/trading';
import { DeskReject } from '../../src/desk/guard';
import { deskOperational } from '../../src/desk/config';
import { RUNNER_PRESET } from '../../src/desk/custom';
import type { DeskEngine } from '../../src/desk/engine';
import type { DeskMode } from '../../src/desk/types';

// Minimal engine double: records control calls; the real pipeline is covered by tests/desk.test.ts.
function engine(mode: DeskMode) {
  const e = { mode, scanner: false, execution: false, busy: false, nextScanAt: null as number | null, pulses: 0, resets: 0,
    strategies: { FAIR: { enabled: true }, CRASH: { enabled: mode === 'PAPER' } } as Record<string, { enabled: boolean }>,
    setStrategy(id: string, enabled: boolean) { e.strategies[id]!.enabled = enabled; }, drill: false, setDrill(on: boolean) { e.drill = on; },
    exits: [] as string[], requestExit(mint: string) { e.exits.push(mint); },
    specs: [] as string[], held: 0,
    async defineStrategy(spec: { id: string }) { e.specs.push(spec.id); e.strategies[spec.id] = { enabled: mode === 'PAPER' }; },
    strategyPositions: (_id: string) => e.held,
    async removeStrategy(id: string) { delete e.strategies[id]; e.specs = e.specs.filter(x => x !== id); },
    resetTest: async () => { if (e.scanner) throw new DeskReject('STOP_TEST_FIRST'); e.resets++; return []; },
    prepared: 0, async prepareStart() { e.prepared++; },
    start() { e.scanner = true; e.execution = true; }, stop() { e.scanner = false; e.execution = false; },
    pause() { e.execution = false; }, resume() { if (!e.scanner) throw new DeskReject('SCANNER_OFF'); e.execution = true; },
    pulse: async () => { e.pulses++; }, tick: () => {}, settled: async () => {}, persist: async () => {}, events: { add: () => {} },
    status: (wallet: { connected: boolean; address: string | null }) => ({ mode, scanner: e.scanner, execution: e.execution, wallet }) };
  return e;
}
function service(liveSigner: DeskHandle['liveSigner'] = 'PHANTOM', locked = false, options: ConstructorParameters<typeof TradingService>[1] = {}, extra: Partial<DeskHandle> = {}) {
  const engines = { PAPER: engine('PAPER'), LIVE: engine('LIVE') }, phone: string[] = [];
  let wallets: Parameters<DeskFactory>[0] | null = null;
  const factory: DeskFactory = async context => { wallets = context;
    return { engines: engines as unknown as Record<DeskMode, DeskEngine>, capital: { plannedStartingCapitalUsd: 5.45, baseEntryUsd: 2, slippageBps: 100 }, liveSigner,
      operational: locked ? deskOperational({ DESK_DEPLOYMENT_MODE: 'LOCKED' }) : undefined, notify: async (title: string) => { phone.push(title); },
      close: async () => {}, ...extra } as DeskHandle; };
  return { trading: new TradingService(factory, options), engines, context: () => wallets!, phone };
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
    assert.equal((await (await post('desk', { action: 'reset-test' }, headers)).json()).message, 'STOP_TEST_FIRST');
    assert.equal((await post('desk', { action: 'strategy', strategy: 'CRASH', enabled: false }, headers)).status, 200);
    assert.equal(engines.PAPER.strategies.CRASH!.enabled, false); assert.equal(engines.LIVE.strategies.CRASH!.enabled, false, 'toggles apply to the selected mode only');
    assert.equal((await (await post('desk', { action: 'strategy', strategy: 'MOON', enabled: true }, headers)).json()).message, 'INVALID_STRATEGY');
    assert.equal((await (await post('desk', { action: 'strategy', strategy: 'FAIR', enabled: 'yes' }, headers)).json()).message, 'INVALID_STRATEGY');
    assert.equal((await (await post('desk', { action: 'select-mode', mode: 'LIVE' }, headers)).json()).message, 'STOP_CURRENT_MODE_FIRST');
    assert.equal((await (await post('desk', { action: 'start-live' }, headers)).json()).message, 'SESSION_REQUIRED');
    assert.equal((await post('desk', { action: 'exit', mint: 'MintA' }, headers)).status, 200, 'EXIT NOW in TEST sells on paper');
    assert.deepEqual(engines.PAPER.exits, ['MintA']);
    const s = await (await post('connect', { address }, headers)).json();
    assert.equal(context().wallet('PAPER')!.signer, null, 'TEST gets the address for simulation only');
    assert.ok(context().wallet('LIVE')!.signer, 'LIVE signs through the Phantom broker');
    assert.equal((await (await post('desk', { action: 'start-live', sessionId: s.sessionId }, headers)).json()).message, 'STOP_TEST_FIRST');
    assert.equal((await post('desk', { action: 'stop-test' }, headers)).status, 200);
    assert.equal((await post('desk', { action: 'reset-test' }, headers)).status, 200); assert.equal(engines.PAPER.resets, 1);
    assert.equal((await post('desk', { action: 'start-live', sessionId: s.sessionId }, headers)).status, 200);
    assert.equal((await (await post('desk', { action: 'reset-test' }, headers)).json()).message, 'RESET_TEST_ONLY');
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

test('locked deployment blocks UI overrides but preserves emergency stop; LIVE prepares before start', async () => {
  const { trading, engines } = service('LOCAL_KEY', true);
  const { base, post, close } = await serve(trading);
  try {
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    assert.equal((await (await post('desk', { action: 'strategy', strategy: 'CRASH', enabled: false }, headers)).json()).message, 'CONFIG_LOCKED');
    assert.equal(engines.PAPER.strategies.CRASH!.enabled, true);
    assert.equal((await post('desk', { action: 'start-live' }, headers)).status, 200);
    assert.equal(engines.LIVE.prepared, 1);
    assert.equal((await post('desk', { action: 'stop-live' }, headers)).status, 200);
    assert.equal(engines.LIVE.scanner, false);
  } finally { await close(); }
});

test('LIVE with the local key starts without a Phantom session and is not stopped by a missing browser heartbeat', async (t) => {
  const { trading, engines } = service('LOCAL_KEY');
  const { base, post, close } = await serve(trading);
  try {
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    assert.equal((await post('desk', { action: 'start-live' })).status, 403, 'still same-origin and capability-checked');
    assert.equal((await post('desk', { action: 'start-live' }, headers)).status, 200);
    assert.equal(engines.LIVE.scanner, true);
    const realNow = Date.now;
    const clock = t.mock.method(Date, 'now', () => realNow() + 60_000);
    await new Promise(r => setTimeout(r, 1_100));
    clock.mock.restore();
    assert.equal(engines.LIVE.scanner, true, 'no browser heartbeat is required with the local key');
    assert.equal((await post('desk', { action: 'pause' }, headers)).status, 200);
    assert.equal((await post('desk', { action: 'resume' }, headers)).status, 200, 'resume needs no Phantom session');
    assert.equal((await post('desk', { action: 'exit', mint: 'MintA' }, headers)).status, 200, 'EXIT NOW needs no Phantom session');
    assert.deepEqual(engines.LIVE.exits, ['MintA']);
    assert.equal((await (await post('desk', { action: 'exit' }, headers)).json()).message, 'INVALID_MINT');
    assert.equal((await post('desk', { action: 'stop-live' }, headers)).status, 200);
    assert.equal(engines.LIVE.scanner, false);
  } finally { await close(); }
});

test('custom strategies: one validated spec for both modes, toggled per mode, refused while it holds a position or when locked', async () => {
  const { trading, engines } = service('LOCAL_KEY');
  const { base, post, close } = await serve(trading);
  try {
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    const spec = { ...RUNNER_PRESET, id: 'MINE', label: 'Mine' };
    assert.equal((await post('desk', { action: 'strategy-save', spec }, headers)).status, 200);
    assert.deepEqual(engines.PAPER.specs, ['MINE']); assert.deepEqual(engines.LIVE.specs, ['MINE']);
    assert.equal(engines.PAPER.strategies.MINE!.enabled, true); assert.equal(engines.LIVE.strategies.MINE!.enabled, false);
    const bad = await (await post('desk', { action: 'strategy-save', spec: { ...spec, sizing: { ...spec.sizing, entryUsd: 50 } } }, headers)).json();
    assert.equal(bad.message, 'INVALID_STRATEGY_SPEC'); assert.equal(bad.detail, 'sizing.entryUsd: entry exceeds the TEST capital');
    assert.equal((await post('desk', { action: 'strategy', strategy: 'MINE', enabled: false }, headers)).status, 200);
    assert.equal(engines.PAPER.strategies.MINE!.enabled, false);
    assert.equal((await (await post('desk', { action: 'strategy', strategy: 'constructor', enabled: true }, headers)).json()).message, 'INVALID_STRATEGY');
    engines.LIVE.held = 1;
    assert.equal((await (await post('desk', { action: 'strategy-delete', strategy: 'MINE' }, headers)).json()).message, 'STRATEGY_HAS_POSITIONS');
    engines.LIVE.held = 0;
    assert.equal((await post('desk', { action: 'strategy-delete', strategy: 'MINE' }, headers)).status, 200);
    assert.deepEqual(engines.PAPER.specs, []); assert.equal(engines.LIVE.strategies.MINE, undefined);
  } finally { await close(); }
  const locked = service('LOCAL_KEY', true), server = await serve(locked.trading);
  try {
    const { capability } = await (await fetch(`${server.base}/api/trading/bootstrap`)).json();
    assert.equal((await (await server.post('desk', { action: 'strategy-save', spec: RUNNER_PRESET }, { 'X-Local-Capability': capability })).json()).message, 'CONFIG_LOCKED');
  } finally { await server.close(); }
});

test('strategy assistant: capability-checked, chat validated, wallet swaps read once and cached, proposals only returned', async () => {
  const engines = { PAPER: engine('PAPER'), LIVE: engine('LIVE') };
  (engines.PAPER.strategies as Record<string, unknown>).MINE = { enabled: true, rule: { id: 'MINE' } };
  const asked: Array<{ messages: unknown[]; strategies: unknown[]; walletHistory?: string | null }> = [];
  let reads = 0, configured = false;
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
  const factory: DeskFactory = async () => ({ engines: engines as unknown as Record<DeskMode, DeskEngine>, capital: { plannedStartingCapitalUsd: 5.45, baseEntryUsd: 2, slippageBps: 100 },
    liveSigner: 'LOCAL_KEY', close: async () => {},
    assistant: configured ? { ask: async (o: typeof asked[number]) => { asked.push(o); return { reply: 'Try RUNNER', strategy: null, specError: null, model: 'claude-opus-5-5', stopReason: 'end_turn' }; } } as never : null,
    walletHistory: async (w: string) => { reads++; return { wallet: w, scanned: 5, trades: 1, note: 'n', tokens: [] }; } }) as DeskHandle;
  const { base, post, close } = await serve(new TradingService(factory));
  try {
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    const chat = [{ role: 'user', content: 'I buy after sideways hours' }];
    assert.equal((await post('assistant', { messages: chat })).status, 403, 'capability required');
    assert.equal((await (await post('assistant', { messages: chat }, headers)).json()).message, 'ASSISTANT_NOT_CONFIGURED');
    assert.equal((await (await fetch(`${base}/api/trading`)).json()).assistant, false);
  } finally { await close(); }
  configured = true;
  const second = await serve(new TradingService(factory));
  try {
    const { capability } = await (await fetch(`${second.base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    assert.equal((await (await fetch(`${second.base}/api/trading`)).json()).assistant, true);
    assert.equal((await (await second.post('assistant', { messages: [{ role: 'assistant', content: 'x' }] }, headers)).json()).message, 'INVALID_CHAT');
    assert.equal((await (await second.post('assistant', { messages: [{ role: 'user', content: 'x' }], wallet: 'nope' }, headers)).json()).message, 'INVALID_ADDRESS');
    const long = [{ role: 'user', content: 'a'.repeat(5_000) }, { role: 'assistant', content: 'b'.repeat(5_000) }, { role: 'user', content: 'and now?' }];
    const r = await (await second.post('assistant', { messages: long, wallet }, headers)).json();
    assert.equal(r.reply, 'Try RUNNER', 'a chat longer than 8 KB is accepted on this route'); assert.equal(r.wallet.wallet, wallet);
    assert.deepEqual(asked[0]!.strategies, [{ id: 'MINE' }]); assert.match(asked[0]!.walletHistory!, new RegExp(`^Wallet ${wallet}: no token swaps found`));
    await second.post('assistant', { messages: [{ role: 'user', content: 'again' }], wallet }, headers);
    assert.equal(reads, 1, 'the wallet is read once and reused');
  } finally { await second.close(); }
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

test('session restore: TEST comes back after a restart, LIVE (local key) comes back with exits only, Phantom LIVE never by itself', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-session-'));
  const sessionFile = path.join(dir, 'desk-session.json');
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    // A running TEST is saved by the service's own timer…
    const first = service('PHANTOM', false, { sessionFile });
    assert.equal(await first.trading.restoreSession(), null, 'nothing saved yet');
    const { base, post, close } = await serve(first.trading);
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    assert.equal((await post('desk', { action: 'start-test' }, { 'X-Local-Capability': capability })).status, 200);
    await wait(1_300);
    assert.deepEqual({ ...JSON.parse(await fs.readFile(sessionFile, 'utf8')), at: undefined }, { mode: 'PAPER', running: true, paused: false, at: undefined });
    // …and a shutdown (deploy, reboot) keeps it: the next start resumes TEST.
    await close();
    const second = service('PHANTOM', false, { sessionFile });
    assert.equal(await second.trading.restoreSession(), 'TEST');
    assert.equal(second.engines.PAPER.scanner, true); assert.equal(second.engines.PAPER.execution, true);
    assert.deepEqual(second.phone, [], 'TEST restores quietly');
    await second.trading.close();

    // LIVE with the local key: reconciled, started, and paused at once (exits only); the phone is told.
    await fs.writeFile(sessionFile, JSON.stringify({ mode: 'LIVE', running: true, paused: false, at: 'x' }));
    const live = service('LOCAL_KEY', false, { sessionFile });
    assert.equal(await live.trading.restoreSession(), 'LIVE_EXITS_ONLY');
    assert.equal(live.engines.LIVE.prepared, 1, 'holdings reconciled first');
    assert.equal(live.engines.LIVE.scanner, true); assert.equal(live.engines.LIVE.execution, false, 'no new entries until Resume');
    assert.deepEqual(live.phone, ['LIVE restored: exits only']);
    await live.trading.close();

    // LIVE with Phantom: it cannot sign by itself, so it is never resumed; the owner is told.
    const phantom = service('PHANTOM', false, { sessionFile });
    assert.equal(await phantom.trading.restoreSession(), 'LIVE_NOT_RESUMED');
    assert.equal(phantom.engines.LIVE.scanner, false);
    assert.deepEqual(phantom.phone, ['LIVE stopped by a restart']);
    await phantom.trading.close();

    // A failing reconciliation (RPC still starting) is retried; after the last try the owner is told.
    const failing = service('LOCAL_KEY', false, { sessionFile, restoreRetryMs: 20, restoreAttempts: 3 });
    let tries = 0;
    failing.engines.LIVE.prepareStart = async () => { tries++; if (tries < 3) throw new DeskReject('RPC_UNAVAILABLE'); };
    await failing.trading.restoreSession();
    await wait(150);
    assert.equal(tries, 3); assert.equal(failing.engines.LIVE.execution, false); assert.equal(failing.engines.LIVE.scanner, true);
    assert.deepEqual(failing.phone, ['LIVE restored: exits only']);
    await failing.trading.close();
    const giveUp = service('LOCAL_KEY', false, { sessionFile, restoreRetryMs: 10, restoreAttempts: 2 });
    giveUp.engines.LIVE.prepareStart = async () => { throw new DeskReject('LIVE_HOLDINGS_MISMATCH'); };
    await giveUp.trading.restoreSession();
    await wait(100);
    assert.equal(giveUp.engines.LIVE.scanner, false);
    assert.deepEqual(giveUp.phone, ['LIVE NOT restored']);
    await giveUp.trading.close();

    // The desk itself cannot open (e.g. a stale lock): retried, then reported as TEST (the saved mode), never as LIVE.
    await fs.writeFile(sessionFile, JSON.stringify({ mode: 'PAPER', running: true, paused: false, at: 'x' }));
    const lines: string[] = [];
    const locked = new TradingService(async () => { throw new DeskReject('INSTANCE_LOCK'); }, { sessionFile, restoreRetryMs: 10, restoreAttempts: 2, log: l => { lines.push(l); } });
    await locked.restoreSession();
    await wait(80);
    assert.ok(lines.some(l => /^TEST NOT restored: .*INSTANCE_LOCK/.test(l)), lines.join(' | '));
    assert.ok(!lines.some(l => /LIVE/.test(l)));
    await locked.close();

    // A TEST that cannot start (an unresolved order) is reported, never thrown: a crash would loop under the supervisor.
    await fs.writeFile(sessionFile, JSON.stringify({ mode: 'PAPER', running: true, paused: false, at: 'x' }));
    const blocked = service('PHANTOM', false, { sessionFile });
    blocked.engines.PAPER.start = () => { throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED'); };
    assert.equal(await blocked.trading.restoreSession(), null);
    await blocked.trading.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('coin check API: a Solana address only, one check at a time, the same coin again within 2 min from the cache; watchlist add', async () => {
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(77)).publicKey.toBase58(), calls: string[] = [], added: Array<[string, string]> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const { trading } = service('PHANTOM', false, {}, {
    coinCheck: async (m: string) => { calls.push(m); await gate; return { mint: m, verdict: { tone: 'bad', headline: 'demand is fading', lines: [] }, watched: false } as never; },
    watchlistAdd: async (m: string, note: string) => { added.push([m, note]); return true; } });
  const { base, post, close } = await serve(trading);
  try {
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    assert.equal((await post('coin-check', { mint }, {})).status, 403, 'capability required');
    const bad = await post('coin-check', { mint: '0x1234' }, headers);
    assert.notEqual(bad.status, 200); assert.equal((await bad.json()).message, 'INVALID_MINT');
    const first = post('coin-check', { mint }, headers);
    await new Promise(r => setTimeout(r, 50));
    const busy = await post('coin-check', { mint: Keypair.fromSeed(new Uint8Array(32).fill(78)).publicKey.toBase58() }, headers);
    assert.equal((await busy.json()).message, 'COIN_CHECK_BUSY');
    release();
    const result = await (await first).json();
    assert.equal(result.verdict.headline, 'demand is fading');
    assert.equal((await post('coin-check', { mint }, headers)).status, 200);
    assert.deepEqual(calls, [mint], 'the second check of the same coin came from the cache');
    const add = await (await post('watchlist-add', { mint, note: 'SI coin check' }, headers)).json();
    assert.deepEqual(add, { added: true }); assert.deepEqual(added, [[mint, 'SI coin check']]);
    assert.equal((await (await post('coin-check', { mint }, headers)).json()).watched, true, 'the cached result knows it is watched now');
  } finally { await close(); }
});

test('phone alerts (CTO Q-16): capability-checked, only known kinds, saved through the desk handle', async () => {
  let saved: string[] | null = null;
  const { trading } = service('PHANTOM', false, {}, { phoneAlerts: { kinds: () => [], set: async kinds => { saved = [...kinds]; } } });
  const { base, post, close } = await serve(trading);
  try {
    assert.equal((await post('desk', { action: 'phone-alerts', kinds: ['open'] })).status, 403, 'capability required');
    assert.equal(saved, null);
    const { capability } = await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers = { 'X-Local-Capability': capability };
    const bad = await post('desk', { action: 'phone-alerts', kinds: ['open', 'everything'] }, headers);
    assert.notEqual(bad.status, 200); assert.equal((await bad.json()).message, 'INVALID_ALERT_KINDS'); assert.equal(saved, null);
    assert.equal((await (await post('desk', { action: 'phone-alerts', kinds: 'open' }, headers)).json()).message, 'INVALID_ALERT_KINDS');
    assert.equal((await post('desk', { action: 'phone-alerts', kinds: ['open', 'rug'] }, headers)).status, 200);
    assert.deepEqual(saved, ['open', 'rug']);
    assert.equal((await post('desk', { action: 'phone-alerts', kinds: [] }, headers)).status, 200, 'switching every kind off is allowed');
    assert.deepEqual(saved, []);
  } finally { await close(); }
});

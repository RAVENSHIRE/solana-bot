import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { SigningBroker } from '../../src/phantom/signing-broker';
import type { DeskWallet } from '../../src/desk/engine';
import { DeskReject } from '../../src/desk/guard';
import { parseRuleSpec } from '../../src/desk/custom';
import { createDesk, deskEnvironment, type DeskContext, type DeskHandle } from '../../src/desk/runtime';
import type { DeskMode, DeskStatus } from '../../src/desk/types';
import type { WatchView } from '../../src/desk/watch';

export { deskEnvironment as tradingEnvironment, type DeskHandle };
export type DeskFactory = (context: DeskContext) => Promise<DeskHandle>;
export const deskFactory = (repo: string): DeskFactory => context => createDesk({ envDir: repo, dataDir: path.join(repo, 'data-desk') }, context);

const DESK_ACTIONS = new Set(['select-mode', 'strategy-save', 'strategy-delete', 'watch-add', 'watch-remove', 'watch-rearm', 'start-test', 'stop-test', 'start-live', 'pause', 'resume', 'stop-live', 'probe', 'drill-on', 'drill-off',
  'strategy', 'reset-test', 'exit']);

/**
 * The reject code of a DeskReject or SigningError. Matched by name, not instanceof: the dashboard is an ES module
 * package and the desk is CommonJS, so the desk's classes can be a second instance of the same module.
 */
function rejectCode(error: unknown): string | null {
  if (!(error instanceof Error) || (error.name !== 'DeskReject' && error.name !== 'SigningError')) return null;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
/** The human-readable part of a rejection (`CODE: detail`), e.g. which field of a strategy spec is invalid. */
function rejectDetail(error: unknown, code: string): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : undefined;
}

export class TradingService {
  readonly broker = new SigningBroker({ sessionTtlMs: 900_000 });
  private capability = randomBytes(32).toString('base64url');
  private sessionId: string | null = null;
  private heartbeat = 0;
  private mode: DeskMode = 'PAPER';
  private desk: DeskHandle | null = null;
  private opening: Promise<DeskHandle> | null = null;
  private deskError: string | null = null;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly factory: DeskFactory) {
    this.timer = setInterval(() => {
      if (this.closed || !this.desk) return;
      const live = this.desk.engines.LIVE;
      // With Phantom, a lost browser session ends LIVE (never resumed automatically). The local key does not need one.
      if (live.scanner && !this.localKey() && !this.authorized()) { live.stop('Phantom session ended or browser closed'); this.broker.cancel(); }
      for (const engine of Object.values(this.desk.engines)) engine.tick();
      // Watch rules run whether the desk scans or not: a floor can break while TEST and LIVE are stopped.
      this.desk.watch?.tick();
    }, 1000);
    this.timer.unref();
  }
  private authorized = () => this.broker.connection().connected && Date.now() - this.heartbeat < 12_000;
  /** LIVE signs with WALLET_PRIVATE_KEY (DESK_LIVE_SIGNER=local-key): no Phantom session is involved. */
  private localKey = () => this.desk?.liveSigner === 'LOCAL_KEY';
  private wallet = (mode: DeskMode): DeskWallet | null => {
    const c = this.broker.connection();
    if (!c.connected || !c.address || !this.sessionId) return null;
    return { owner: new PublicKey(c.address), signer: mode === 'LIVE' ? this.broker.signer(this.sessionId) : null };
  };

  /** Opens the desk once; a failure is reported and retried on the next request. */
  private ensureDesk(): Promise<DeskHandle> {
    if (this.desk) return Promise.resolve(this.desk);
    this.opening ??= this.factory({ wallet: this.wallet, authorized: this.authorized }).then(handle => {
      if (this.closed) return handle.close().then(() => { throw new DeskReject('SERVICE_CLOSED'); });
      this.desk = handle; this.deskError = null; return handle;
    }).catch(error => {
      this.deskError = rejectCode(error) ?? 'DESK_UNAVAILABLE';
      throw error;
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.broker.cancel();
    const handle = this.desk ?? await this.opening?.catch(() => null) ?? null;
    this.desk = null;
    await handle?.close();
  }

  private json(res: ServerResponse, status: number, value: unknown) {
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  }
  private validCapability(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const expected = Buffer.from(this.capability), actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(expected, actual);
  }

  private view(sessionId?: string): { session: { address: string; expiresAt: number } | null; pending: { id: string; transactionBase64: string; expiresAt: number } | null;
    mode: DeskMode; desk: DeskStatus | null; deskError: string | null; watch: WatchView | null } {
    let session = null, pending = null;
    if (sessionId) {
      const s = this.broker.status(sessionId); session = { address: s.address, expiresAt: s.expiresAt };
      const p = this.broker.pending(sessionId); if (p) pending = { id: p.requestId, transactionBase64: p.transactionBase64, expiresAt: p.expiresAt };
    }
    const c = this.broker.connection();
    const desk = this.desk?.engines[this.mode].status({ connected: c.connected, address: c.address }) ?? null;
    return { session, pending, mode: this.mode, desk, deskError: this.deskError, watch: this.desk?.watch?.view() ?? null };
  }

  private async deskAction(action: string, body: Record<string, unknown>, handle: DeskHandle): Promise<void> {
    const { PAPER: paper, LIVE: live } = handle.engines;
    if (handle.operational?.deploymentMode === 'LOCKED' && ['strategy', 'strategy-save', 'strategy-delete', 'drill-on', 'drill-off', 'reset-test'].includes(action))
      throw new DeskReject('CONFIG_LOCKED');
    const requireSession = () => {
      if (typeof body.sessionId !== 'string') throw new DeskReject('SESSION_REQUIRED');
      this.broker.status(body.sessionId);
      if (!this.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    };
    switch (action) {
      case 'select-mode': {
        const mode = body.mode;
        if (mode !== 'PAPER' && mode !== 'LIVE') throw new DeskReject('INVALID_MODE');
        // TEST and LIVE never run at the same time, and switching never carries data across.
        if (mode !== this.mode && (paper.scanner || live.scanner)) throw new DeskReject('STOP_CURRENT_MODE_FIRST');
        this.mode = mode; return;
      }
      case 'start-test':
        if (live.scanner) throw new DeskReject('STOP_LIVE_FIRST');
        this.mode = 'PAPER'; paper.start(); return;
      case 'stop-test': paper.stop(); return;
      case 'start-live':
        // Still same-origin and capability-checked; the local key only removes the need for a Phantom session.
        if (!this.localKey()) requireSession();
        if (paper.scanner) throw new DeskReject('STOP_TEST_FIRST');
        if (live.scanner) throw new DeskReject('ALREADY_RUNNING');
        await live.prepareStart?.(); this.mode = 'LIVE'; live.start(); return;
      case 'stop-live': live.stop(); this.broker.cancel(); return;
      // Pause stops new entries only; a pending request may be an exit, which must still be signable.
      case 'pause': handle.engines[this.mode].pause(); return;
      case 'resume': if (this.mode === 'LIVE' && !this.localKey()) requireSession(); handle.engines[this.mode].resume(); return;
      case 'drill-on': case 'drill-off':
        // Drill entries exist only in TEST; LIVE never bypasses a strategy gate.
        if (this.mode !== 'PAPER') throw new DeskReject('DRILL_TEST_ONLY');
        paper.setDrill(action === 'drill-on'); return;
      case 'probe':
        // Never available in LIVE: a probe must not be able to produce a signature request.
        if (this.mode !== 'PAPER' || typeof body.mint !== 'string') throw new DeskReject('PROBE_TEST_ONLY');
        await paper.probe(body.mint); return;
      case 'strategy': {
        // Applies to the selected mode only; LIVE starts every session with CRASH (and every new custom strategy) off.
        const engine = handle.engines[this.mode];
        if (typeof body.strategy !== 'string' || !Object.hasOwn(engine.strategies, body.strategy) || typeof body.enabled !== 'boolean') throw new DeskReject('INVALID_STRATEGY');
        engine.setStrategy(body.strategy, body.enabled); return;
      }
      case 'strategy-save': {
        // One spec for both modes; each mode keeps its own on/off switch and ledger.
        let spec;
        try { spec = parseRuleSpec(body.spec); } catch (error) { throw new DeskReject('INVALID_STRATEGY_SPEC', (error as Error).message.replace(/^INVALID_STRATEGY_SPEC: /, '')); }
        await paper.defineStrategy(spec); await live.defineStrategy(spec); return;
      }
      case 'strategy-delete': {
        if (typeof body.strategy !== 'string') throw new DeskReject('INVALID_STRATEGY');
        if (paper.strategyPositions(body.strategy) || live.strategyPositions(body.strategy)) throw new DeskReject('STRATEGY_HAS_POSITIONS');
        await paper.removeStrategy(body.strategy); await live.removeStrategy(body.strategy); return;
      }
      case 'reset-test':
        if (this.mode !== 'PAPER') throw new DeskReject('RESET_TEST_ONLY');
        await paper.resetTest(); return;
      case 'watch-add': case 'watch-remove': case 'watch-rearm': {
        // Watch rules only ever sell (never buy), so they stay available in a LOCKED deployment.
        const watch = handle.watch;
        if (!watch) throw new DeskReject('WATCH_UNAVAILABLE');
        try {
          if (action === 'watch-add') watch.add(body.rule);
          else if (typeof body.id !== 'string') throw new Error('WATCH_NOT_FOUND');
          else if (action === 'watch-remove') watch.remove(body.id); else watch.rearm(body.id);
        } catch (error) {
          const [code, ...rest] = (error as Error).message.split(': ');
          throw new DeskReject(/^[A-Z_]+$/.test(code ?? '') ? code! : 'INVALID_WATCH', rest.join(': '));
        }
        return;
      }
      case 'exit':
        // EXIT NOW only reduces risk: it sells an open position through the normal guarded SELL path.
        if (typeof body.mint !== 'string') throw new DeskReject('INVALID_MINT');
        if (this.mode === 'LIVE' && !this.localKey()) requireSession();
        handle.engines[this.mode].requestExit(body.mint); return;
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/trading')) return false;
    try {
      if (this.closed) throw new DeskReject('SERVICE_CLOSED');
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new DeskReject('LOCAL_ORIGIN_REQUIRED');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new DeskReject('LOCAL_ORIGIN_REQUIRED');
      if (req.method === 'GET' && url.pathname === '/api/trading/bootstrap') { this.json(res, 200, { capability: this.capability }); return true; }
      const supplied = req.headers['x-local-capability'];
      if (req.method === 'GET' && url.pathname === '/api/trading/health') {
        if (!this.validCapability(supplied)) throw new DeskReject('CAPABILITY_REQUIRED');
        const engine = this.desk?.engines[this.mode];
        const state = engine?.status({ connected: this.broker.connection().connected, address: this.broker.connection().address });
        const stale = !!state?.scanner && (!state.lastScanAt || Date.now() - state.lastScanAt > 50_000);
        const issue = this.deskError ?? state?.halted ?? (stale ? 'SCAN_STALE' : null);
        this.json(res, issue ? 503 : 200, { ready: !!state && !issue, mode: this.mode, scanner: state?.scanner ?? false,
          execution: state?.execution ?? false, lastScanAt: state?.lastScanAt ?? null, issue }); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/trading') {
        const sid = req.headers['x-wallet-session'];
        if (sid && (!this.validCapability(supplied) || typeof sid !== 'string')) throw new DeskReject('CAPABILITY_REQUIRED');
        if (typeof sid === 'string') {
          // A late heartbeat ends LIVE; renewing the session afterwards never resumes it.
          if (!this.localKey() && !this.authorized() && this.desk?.engines.LIVE.scanner) { this.desk.engines.LIVE.stop('Phantom session heartbeat lost'); this.broker.cancel(); }
          this.broker.heartbeat(sid); this.heartbeat = Date.now();
        }
        await this.ensureDesk().catch(() => null);
        this.json(res, 200, this.view(typeof sid === 'string' ? sid : undefined)); return true;
      }
      if (req.method !== 'POST') { this.json(res, 405, { message: 'METHOD_NOT_ALLOWED' }); return true; }
      if (req.headers.origin !== origin || !this.validCapability(supplied)) throw new DeskReject('CAPABILITY_REQUIRED');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new DeskReject('JSON_REQUIRED');
      let text = '', size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) throw new DeskReject('BODY_TOO_LARGE'); text += chunk; }
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DeskReject('INVALID_BODY');
      const action = url.pathname.slice('/api/trading/'.length);
      if (action === 'connect') {
        if (typeof body.address !== 'string') throw new DeskReject('INVALID_ADDRESS');
        const previous = this.broker.connection().address;
        // A different wallet can never inherit a LIVE session or its pending signature.
        if (previous !== body.address && !this.localKey()) this.desk?.engines.LIVE.stop('wallet changed');
        const session = this.broker.connect(body.address);
        this.sessionId = session.sessionId; this.heartbeat = Date.now();
        await this.ensureDesk().catch(() => null);
        this.json(res, 200, session); return true;
      }
      if (action === 'desk') {
        if (typeof body.action !== 'string' || !DESK_ACTIONS.has(body.action)) throw new DeskReject('INVALID_ACTION');
        await this.deskAction(body.action, body, await this.ensureDesk());
        this.json(res, 200, { ok: true }); return true;
      }
      if (typeof body.sessionId !== 'string') throw new DeskReject('SESSION_REQUIRED');
      this.broker.status(body.sessionId);
      this.heartbeat = Date.now();
      if (action === 'disconnect') {
        if (!this.localKey()) this.desk?.engines.LIVE.stop('wallet disconnected');
        this.broker.disconnect(body.sessionId); this.sessionId = null;
      } else if (action === 'signed' || action === 'reject') {
        if (typeof body.requestId !== 'string') throw new DeskReject('REQUEST_REQUIRED');
        if (action === 'reject') this.broker.reject(body.sessionId, body.requestId);
        else {
          if (typeof body.transactionBase64 !== 'string') throw new DeskReject('SIGNATURE_REQUIRED');
          this.broker.resolve(body.sessionId, body.requestId, body.transactionBase64);
        }
      } else { this.json(res, 404, { message: 'NOT_FOUND' }); return true; }
      this.json(res, 200, { ok: true });
    } catch (error) {
      const code = rejectCode(error) ?? 'TRADING_REQUEST_FAILED', detail = ['INVALID_STRATEGY_SPEC', 'INVALID_WATCH'].includes(code) ? rejectDetail(error, code) : undefined;
      this.json(res, code.includes('CAPABILITY') || code.includes('ORIGIN') ? 403 : 400, { message: code, ...(detail ? { detail } : {}) });
    }
    return true;
  }
}

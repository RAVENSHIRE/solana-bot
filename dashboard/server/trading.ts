import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { SigningBroker } from '../../src/phantom/signing-broker';
import { SigningError } from '../../src/execution/transaction-signer';
import type { DeskWallet } from '../../src/desk/engine';
import { DeskReject } from '../../src/desk/guard';
import { createDesk, deskEnvironment, type DeskContext, type DeskHandle } from '../../src/desk/runtime';
import type { DeskMode, DeskStatus } from '../../src/desk/types';

export { deskEnvironment as tradingEnvironment, type DeskHandle };
export type DeskFactory = (context: DeskContext) => Promise<DeskHandle>;
export const deskFactory = (repo: string): DeskFactory => context => createDesk({ envDir: repo, dataDir: path.join(repo, 'data-desk') }, context);

const DESK_ACTIONS = new Set(['select-mode', 'start-test', 'stop-test', 'start-live', 'pause', 'resume', 'stop-live', 'probe', 'drill-on', 'drill-off']);

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
      // A lost browser session ends the LIVE session; it is never resumed automatically.
      if (live.scanner && !this.authorized()) { live.stop('Phantom session ended or browser closed'); this.broker.cancel(); }
      for (const engine of Object.values(this.desk.engines))
        if (engine.scanner && !engine.busy && (engine.nextScanAt ?? 0) <= Date.now()) void engine.pulse();
    }, 1000);
    this.timer.unref();
  }
  private authorized = () => this.broker.connection().connected && Date.now() - this.heartbeat < 12_000;
  private wallet = (mode: DeskMode): DeskWallet | null => {
    const c = this.broker.connection();
    if (!c.connected || !c.address || !this.sessionId) return null;
    return { owner: new PublicKey(c.address), signer: mode === 'LIVE' ? this.broker.signer(this.sessionId) : null };
  };

  /** Opens the desk once; a failure is reported and retried on the next request. */
  private ensureDesk(): Promise<DeskHandle> {
    if (this.desk) return Promise.resolve(this.desk);
    this.opening ??= this.factory({ wallet: this.wallet, authorized: this.authorized }).then(handle => {
      if (this.closed) { void handle.close(); throw new DeskReject('SERVICE_CLOSED'); }
      this.desk = handle; this.deskError = null; return handle;
    }).catch(error => {
      this.deskError = error instanceof DeskReject ? error.code : error instanceof Error ? error.message.slice(0, 160) : 'DESK_UNAVAILABLE';
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
    mode: DeskMode; desk: DeskStatus | null; deskError: string | null } {
    let session = null, pending = null;
    if (sessionId) {
      const s = this.broker.status(sessionId); session = { address: s.address, expiresAt: s.expiresAt };
      const p = this.broker.pending(sessionId); if (p) pending = { id: p.requestId, transactionBase64: p.transactionBase64, expiresAt: p.expiresAt };
    }
    const c = this.broker.connection();
    const desk = this.desk?.engines[this.mode].status({ connected: c.connected, address: c.address }) ?? null;
    return { session, pending, mode: this.mode, desk, deskError: this.deskError };
  }

  private async deskAction(action: string, body: Record<string, unknown>, handle: DeskHandle): Promise<void> {
    const { PAPER: paper, LIVE: live } = handle.engines;
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
        requireSession();
        if (paper.scanner) throw new DeskReject('STOP_TEST_FIRST');
        this.mode = 'LIVE'; live.start(); return;
      case 'stop-live': live.stop(); this.broker.cancel(); return;
      case 'pause': handle.engines[this.mode].pause(); if (this.mode === 'LIVE') this.broker.cancel(); return;
      case 'resume': if (this.mode === 'LIVE') requireSession(); handle.engines[this.mode].resume(); return;
      case 'drill-on': case 'drill-off':
        // Drill entries exist only in TEST; LIVE never bypasses a strategy gate.
        if (this.mode !== 'PAPER') throw new DeskReject('DRILL_TEST_ONLY');
        paper.drill = action === 'drill-on'; paper.events.add('SYSTEM', `TEST drill ${paper.drill ? 'ON: paper entries may bypass strategy gates (safety gates and guard still apply)' : 'OFF'}`);
        return;
      case 'probe':
        // Never available in LIVE: a probe must not be able to produce a signature request.
        if (this.mode !== 'PAPER' || typeof body.mint !== 'string') throw new DeskReject('PROBE_TEST_ONLY');
        await paper.probe(body.mint); return;
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
      if (req.method === 'GET' && url.pathname === '/api/trading') {
        const sid = req.headers['x-wallet-session'];
        if (sid && (!this.validCapability(supplied) || typeof sid !== 'string')) throw new DeskReject('CAPABILITY_REQUIRED');
        if (typeof sid === 'string') {
          // A late heartbeat ends LIVE; renewing the session afterwards never resumes it.
          if (!this.authorized() && this.desk?.engines.LIVE.scanner) { this.desk.engines.LIVE.stop('Phantom session heartbeat lost'); this.broker.cancel(); }
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
        if (previous !== body.address) this.desk?.engines.LIVE.stop('wallet changed');
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
        this.desk?.engines.LIVE.stop('wallet disconnected');
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
      const code = error instanceof DeskReject || error instanceof SigningError ? error.code : 'TRADING_REQUEST_FAILED';
      this.json(res, code.includes('CAPABILITY') || code.includes('ORIGIN') ? 403 : 400, { message: code });
    }
    return true;
  }
}

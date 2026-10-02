import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ResearchApi, ROLE_CAPABILITIES, toolManifest, type AgentRole, type Principal } from './tools';

/**
 * HTTP surface of the research API for agents on the same machine or a private network:
 *
 *   GET  /health                 liveness (no auth)
 *   GET  /tools                  the tool manifest for the caller's role (auth)
 *   POST /tools/<name>           body: JSON arguments → { ok, data | error } (auth)
 *
 * Auth: `Authorization: Bearer <token>`; each token maps to one principal (id + role) given at start, so a token can
 * never call outside its role's capabilities. Loopback only unless `allowRemote` (put TLS and a network boundary in
 * front before doing that). Bodies are limited to 256 KB. There is nothing here that can trade.
 */
export interface ServerOptions { host?: string; port?: number; principals: ReadonlyMap<string, Principal>; allowRemote?: boolean }

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function principalFor(header: string | undefined, principals: ReadonlyMap<string, Principal>): Principal | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  const given = Buffer.from(m[1]!);
  for (const [token, p] of principals) {
    const want = Buffer.from(token);
    if (want.length === given.length && timingSafeEqual(want, given)) return p;
  }
  return null;
}

/** Parses RESEARCH_API_TOKENS: `role:id:token` entries separated by commas. Tokens must be ≥ 24 characters. */
export function parsePrincipals(raw: string | undefined): Map<string, Principal> {
  const out = new Map<string, Principal>();
  for (const part of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [role, id, token] = part.split(':');
    if (!role || !id || !token || !(role in ROLE_CAPABILITIES) || token.length < 24) throw new Error('RESEARCH_API_TOKENS: entries are role:id:token with a known role and a token of ≥ 24 characters');
    out.set(token, { id, role: role as AgentRole });
  }
  return out;
}

export function startServer(api: ResearchApi, o: ServerOptions): Promise<http.Server> {
  const host = o.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && !o.allowRemote) return Promise.reject(new Error('Research API binds to loopback only (allowRemote to override)'));
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'bigint' ? v.toString() : v)));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    const who = principalFor(req.headers.authorization, o.principals);
    if (!who) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'bearer token required' } });
    if (req.method === 'GET' && url.pathname === '/tools') return send(res, 200, { ok: true, data: { principal: who, tools: toolManifest(who.role) } });
    const m = /^\/tools\/([a-z_]{1,64})$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'POST /tools/<name>' } });
    const chunks: Buffer[] = []; let size = 0, aborted = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 256 * 1024) { aborted = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (aborted) return;
      let args: Record<string, unknown> = {};
      try { const text = Buffer.concat(chunks).toString('utf8'); if (text.trim()) args = JSON.parse(text) as Record<string, unknown>; }
      catch { return send(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'body must be a JSON object' } }); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'body must be a JSON object' } });
      void api.call(who, m[1]!, args).then(r => send(res, r.ok ? 200 : r.error.code === 'CAPABILITY_DENIED' ? 403 : r.error.code === 'UNKNOWN_TOOL' || r.error.code === 'TRADING_NOT_AVAILABLE' ? 404 : 400, r));
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 8790, host, () => resolve(server)); });
}

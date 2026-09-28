/**
 * Lokaler Dashboard-Server (eigener Prozess, unabhängig vom Bot).
 *   npm run dashboard   →   http://127.0.0.1:8787
 *
 * - Beobachtet state-{MODE}.json und dashboard-{MODE}.json im STATE_DIR (fs.watch + Polling-Fallback)
 * - Baut daraus den BotState-Vertrag und streamt Änderungen per Server-Sent Events (/events)
 * - Liest ausschließlich Dateien; braucht weder Private Key noch RPC-Zugang
 */
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { stateReviver, type PersistedState } from '../core/portfolio';
import { telemetryFileName, type TelemetryFile } from '../core/telemetry';
import { buildBotState } from './build-state';
import type { BotState, Mode } from './contract';

const env = process.env;
const MODE: Mode = (env.DASHBOARD_MODE?.toUpperCase() ??
  (['false', '0', 'no', 'off'].includes((env.SIMULATION_MODE ?? 'true').trim().toLowerCase()) ? 'LIVE' : 'SIMULATION')) === 'LIVE'
  ? 'LIVE'
  : 'SIMULATION';
const STATE_DIR = path.resolve(env.STATE_DIR?.trim() || './data');
const PORT = Number(env.DASHBOARD_PORT ?? 8787);
const HOST = env.DASHBOARD_HOST?.trim() || '127.0.0.1';
const STATE_FILE = path.join(STATE_DIR, `state-${MODE}.json`);
const TELEMETRY_FILE = path.join(STATE_DIR, telemetryFileName(MODE));
// Funktioniert aus src/ (tsx) und dist/ (kompiliert): beide liegen zwei Ebenen unter dem Projekt
const HTML_FILE = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

const log = (msg: string): void => {
  process.stdout.write(`${new Date().toISOString()} [dashboard] ${msg}\n`);
};

// ---------------------------------------------------------------------------- Zustand

let current: BotState | null = null;
let currentJson = '';
let fingerprint = '';
const clients = new Set<http.ServerResponse>();

async function readJson<T>(file: string, reviver?: (k: string, v: unknown) => unknown): Promise<{ data: T | null; mtime: number | null; error: string | null }> {
  // Mehrere Versuche: der Bot ersetzt Dateien per rename, kurzzeitig kann ein Lesezugriff scheitern
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [raw, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
      return { data: JSON.parse(raw, reviver) as T, mtime: st.mtimeMs, error: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { data: null, mtime: null, error: null };
      if (attempt === 2) return { data: null, mtime: null, error: `${path.basename(file)}: ${(e as Error).message}` };
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  return { data: null, mtime: null, error: null };
}

async function rebuild(): Promise<void> {
  const [st, tel] = await Promise.all([
    readJson<PersistedState>(STATE_FILE, stateReviver),
    readJson<TelemetryFile>(TELEMETRY_FILE),
  ]);
  const errors = [st.error, tel.error].filter((e): e is string => e !== null);
  // Bei Lesefehler den letzten gültigen Stand behalten statt das UI zu leeren
  if (errors.length > 0 && current) {
    log(`Lesefehler (letzter Stand bleibt aktiv): ${errors.join('; ')}`);
    return;
  }
  const next = buildBotState({
    mode: MODE,
    state: st.data,
    telemetry: tel.data,
    stateFile: STATE_FILE,
    telemetryFile: TELEMETRY_FILE,
    stateMtimeMs: st.mtime,
    telemetryMtimeMs: tel.mtime,
    errors,
    now: Date.now(),
  });
  const { generated_at: _ignored, ...rest } = next;
  const fp = JSON.stringify(rest);
  if (fp === fingerprint) return;
  fingerprint = fp;
  current = next;
  currentJson = JSON.stringify(next);
  broadcast();
}

function broadcast(): void {
  const frame = `event: state\ndata: ${currentJson}\n\n`;
  for (const res of clients) res.write(frame);
}

let pending: NodeJS.Timeout | null = null;
function scheduleRebuild(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    rebuild().catch((e) => log(`Rebuild fehlgeschlagen: ${(e as Error).message}`));
  }, 120);
}

function watchFiles(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const names = new Set([path.basename(STATE_FILE), path.basename(TELEMETRY_FILE)]);
  try {
    // Verzeichnis beobachten: Dateien werden atomar per rename ersetzt (Datei-Handles würden veralten)
    fs.watch(STATE_DIR, (_evt, filename) => {
      if (!filename || names.has(filename.toString())) scheduleRebuild();
    });
  } catch (e) {
    log(`fs.watch nicht verfügbar (${(e as Error).message}) – nutze nur Polling`);
  }
  // Fallback (Netzlaufwerke, Docker-Volumes, WSL): stat-Polling
  for (const f of [STATE_FILE, TELEMETRY_FILE]) fs.watchFile(f, { interval: 1_000 }, () => scheduleRebuild());
  // Periodisch neu bauen, damit "bot_online" auch ohne Dateiänderung kippt
  setInterval(scheduleRebuild, 10_000).unref();
}

// ---------------------------------------------------------------------------- HTTP

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET') {
    res.writeHead(405, SECURITY_HEADERS).end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end(`index.html nicht gefunden: ${HTML_FILE}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS }).end(html);
    });
    return;
  }

  if (url.pathname === '/api/state') {
    res
      .writeHead(current ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS })
      .end(current ? currentJson : JSON.stringify({ error: 'Zustand noch nicht geladen' }));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 3000\n\n');
    if (current) res.write(`event: state\ndata: ${currentJson}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS }).end(
      JSON.stringify({ ok: true, clients: clients.size, bot_online: current?.source.bot_online ?? false }),
    );
    return;
  }

  res.writeHead(404, SECURITY_HEADERS).end();
});

async function main(): Promise<void> {
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65_535) throw new Error(`Ungültiger DASHBOARD_PORT: ${env.DASHBOARD_PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    log(`WARNUNG: DASHBOARD_HOST=${HOST} macht das Dashboard im Netzwerk sichtbar (ohne Login!). Empfohlen: 127.0.0.1 + SSH-Tunnel.`);
  }
  await rebuild();
  watchFiles();
  server.listen(PORT, HOST, () => {
    log(`Modus ${MODE} – beobachte ${STATE_FILE} und ${TELEMETRY_FILE}`);
    log(`Dashboard läuft: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  });
}

const shutdown = (): void => {
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e: NodeJS.ErrnoException) => {
  log(e.code === 'EADDRINUSE' ? `Port ${PORT} ist belegt – anderen DASHBOARD_PORT in .env setzen.` : `Serverfehler: ${e.message}`);
  process.exit(1);
});

main().catch((e) => {
  log(`Start fehlgeschlagen: ${(e as Error).message}`);
  process.exit(1);
});

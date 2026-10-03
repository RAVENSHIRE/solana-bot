// The desk's supervisor on the owner's PC: keeps the research observer and the dashboard (which runs TEST and LIVE)
// running. A process that stops is started again, after 3 s at first and up to 5 min while it keeps crashing; a phone
// message says so. Started hidden at logon and by a 5-minute watchdog task (ops/install-autostart.cmd), so it also
// comes back by itself. Only one supervisor runs at a time (data-desk/supervisor.lock).
//
//   node ops/supervise.mjs            supervise in this process (exits at once if a supervisor already runs)
//   node ops/supervise.mjs --restart  restart both processes (e.g. after a git pull), no phone message; then exits
//   node ops/supervise.mjs --stop     stop the supervisor and both processes, and keep the watchdog from starting them
//   node ops/supervise.mjs --start    allow the watchdog again and start a hidden supervisor; then exits
//   node ops/supervise.mjs --status   print the last heartbeat
// --restart and --start also start a hidden supervisor when none runs.
//
// What a restart brings back is the desk's own job: the dashboard restores TEST as it was, and LIVE with exits only
// (data-desk/desk-session.json). This file never reads keys other than the phone channel from .env.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUPERVISE = Object.freeze({
  checkMs: 5_000, heartbeatMs: 30_000,
  /** A process that ran this long was stable: its next restart waits the first delay again. */
  stableMs: 10 * 60_000, firstDelayMs: 3_000, maxDelayMs: 5 * 60_000,
  /** A lock or heartbeat older than this belongs to a supervisor that is gone. */
  staleMs: 2 * 60_000,
  /** Logs over this size are moved to `.1` before a start (the older `.1` is dropped). */
  maxLogBytes: 50 * 1024 * 1024,
  alertGapMs: 30 * 60_000, quietAfterRestartMs: 3 * 60_000,
});

export const CHILDREN = Object.freeze([
  { name: 'research', cwd: '.', args: ['--import', 'tsx', 'src/scripts/research-observe.ts'], log: 'data-desk/research/observer.log', marker: /research-observe\.ts/ },
  { name: 'dashboard', cwd: 'dashboard', args: ['--import', 'tsx', 'server/index.ts'], log: 'data-desk/dashboard.log', marker: /server[\\/]index\.ts/ },
]);

/** The wait before the next start: doubles while a process keeps dying young, back to the first delay once it was stable. */
export function nextDelay(uptimeMs, previousMs) {
  if (uptimeMs >= SUPERVISE.stableMs || !previousMs) return SUPERVISE.firstDelayMs;
  return Math.min(previousMs * 2, SUPERVISE.maxDelayMs);
}

/** Only the named keys of a .env text (the phone channel); everything else is never read into memory as a value. */
export function envKeys(text, keys) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && keys.includes(m[1])) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Moves a log over the size limit to `<log>.1` (replacing an older one); a log held open by another process stays. */
export function rotate(file, maxBytes = SUPERVISE.maxLogBytes) {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch { return false; }
}

export const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Takes the supervisor lock unless a live supervisor holds a fresh one. */
export function claim(lockFile, now = Date.now(), pid = process.pid) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lockFile, String(pid), { flag: 'wx' }); return true; } catch {
      let other = 0, mtime = 0;
      try { other = Number(fs.readFileSync(lockFile, 'utf8')); mtime = fs.statSync(lockFile).mtimeMs; } catch { continue; }
      if (other !== pid && alive(other) && now - mtime < SUPERVISE.staleMs) return false;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return false;
}

/** Node processes and their command lines (to find desk processes started earlier, by hand or by a previous supervisor). */
export function nodeProcesses() {
  try {
    if (process.platform === 'win32') {
      const json = execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      return [].concat(JSON.parse(json || '[]')).map(p => ({ pid: p.ProcessId, cmd: p.CommandLine ?? '' }));
    }
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .map(m => ({ pid: Number(m[1]), cmd: m[2] })).filter(p => /\bnode(\.exe)?\b/.test(p.cmd));
  } catch { return []; }
}

function kill(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

const fmt = ms => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round(ms % 3_600_000 / 60_000)} min` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

export class Supervisor {
  constructor(o) {
    this.repo = o.repo; this.now = o.now ?? Date.now; this.log = o.log ?? (() => undefined); this.notify = o.notify ?? (async () => undefined);
    this.spawnChild = o.spawn ?? ((c, logFile) => {
      const fd = fs.openSync(logFile, 'a');
      // The child writes to the log itself: it keeps running and logging if this supervisor stops.
      const child = spawn(process.execPath, c.args, { cwd: path.join(this.repo, c.cwd), stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
      fs.closeSync(fd);
      return child.pid ?? null;
    });
    this.isAlive = o.alive ?? alive;
    this.children = (o.children ?? CHILDREN).map(c => ({ ...c, pid: null, startedAt: null, restarts: 0, delayMs: 0, nextStartAt: 0, lastStop: null, lastAlertAt: 0 }));
    this.restartFile = path.join(this.repo, 'data-desk', 'supervisor-restart.json');
  }

  /** Processes already running (started by hand or by an earlier supervisor) are watched, never started twice. */
  adopt(processes) {
    for (const c of this.children) {
      const found = processes.find(p => c.marker.test(p.cmd));
      if (found) { c.pid = found.pid; c.startedAt = this.now(); this.log(`${c.name}: already running (pid ${found.pid}), watching it`); }
    }
  }

  restartRequested() {
    try { return this.now() - JSON.parse(fs.readFileSync(this.restartFile, 'utf8')).at < SUPERVISE.quietAfterRestartMs; } catch { return false; }
  }

  /** One check: starts what is not running, once its wait is over. */
  tick() {
    const now = this.now();
    for (const c of this.children) {
      if (c.pid && this.isAlive(c.pid)) continue;
      if (c.pid) {
        const ran = now - (c.startedAt ?? now), planned = this.restartRequested();
        c.delayMs = planned ? SUPERVISE.firstDelayMs : nextDelay(ran, c.delayMs);
        c.nextStartAt = now + c.delayMs; c.lastStop = { at: now, ranMs: ran, planned };
        c.pid = null; c.restarts++;
        this.log(`${c.name}: stopped after ${fmt(ran)}${planned ? ' (restart requested)' : ''}; starting again in ${fmt(c.delayMs)}`);
        if (!planned && now - c.lastAlertAt >= SUPERVISE.alertGapMs) {
          c.lastAlertAt = now;
          void this.notify(`Desk restarted: ${c.name}`, `The ${c.name} process stopped after ${fmt(ran)} and is started again in ${fmt(c.delayMs)} ` +
            `(restart ${c.restarts}).${c.name === 'dashboard' ? ' TEST comes back as it was; LIVE comes back with exits only.' : ''}`).catch(() => undefined);
        }
      }
      if (now < c.nextStartAt) continue;
      const logFile = path.join(this.repo, c.log);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (rotate(logFile)) this.log(`${c.name}: log over ${SUPERVISE.maxLogBytes / 1048576} MB moved to ${path.basename(logFile)}.1`);
      try {
        c.pid = this.spawnChild(c, logFile); c.startedAt = now;
        this.log(`${c.name}: started (pid ${c.pid})`);
      } catch (e) {
        c.delayMs = nextDelay(0, c.delayMs || SUPERVISE.firstDelayMs); c.nextStartAt = now + c.delayMs;
        this.log(`${c.name}: could not start (${e.message}); next try in ${fmt(c.delayMs)}`);
      }
    }
  }

  status() {
    return { pid: process.pid, at: new Date(this.now()).toISOString(),
      children: this.children.map(c => ({ name: c.name, pid: c.pid, since: c.startedAt ? new Date(c.startedAt).toISOString() : null, restarts: c.restarts, lastStop: c.lastStop })) };
  }
}

/** ntfy (DESK_NTFY_TOPIC, DESK_NTFY_SERVER) and Telegram (DESK_TELEGRAM_BOT_TOKEN, DESK_TELEGRAM_CHAT_ID), as the desk does. */
export function phone(repo) {
  let env = {};
  try { env = envKeys(fs.readFileSync(path.join(repo, '.env'), 'utf8'), ['DESK_NTFY_TOPIC', 'DESK_NTFY_SERVER', 'DESK_TELEGRAM_BOT_TOKEN', 'DESK_TELEGRAM_CHAT_ID']); } catch { /* no .env */ }
  return async (title, body) => {
    const sends = [];
    if (env.DESK_NTFY_TOPIC && /^[A-Za-z0-9_-]{8,64}$/.test(env.DESK_NTFY_TOPIC)) {
      const server = (env.DESK_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
      sends.push(fetch(`${server}/${env.DESK_NTFY_TOPIC}`, { method: 'POST', body, headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: 'high', Tags: 'warning' }, signal: AbortSignal.timeout(10_000) }));
    }
    if (env.DESK_TELEGRAM_BOT_TOKEN && env.DESK_TELEGRAM_CHAT_ID) {
      sends.push(fetch(`https://api.telegram.org/bot${env.DESK_TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.DESK_TELEGRAM_CHAT_ID, text: `${title}\n${body}` }), signal: AbortSignal.timeout(10_000) }));
    }
    await Promise.allSettled(sends);
  };
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dir = path.join(repo, 'data-desk');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'supervisor.lock'), statusFile = path.join(dir, 'supervisor.json'), offFile = path.join(dir, 'supervisor-off');
  const logFile = path.join(dir, 'supervisor.log');
  const log = line => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* disk full */ } };
  const args = process.argv.slice(2), desk = () => nodeProcesses().filter(p => CHILDREN.some(c => c.marker.test(p.cmd)));
  if (args.includes('--status')) { try { console.log(fs.readFileSync(statusFile, 'utf8')); } catch { console.log('no supervisor heartbeat yet'); } return; }
  if (args.includes('--stop')) {
    fs.writeFileSync(offFile, new Date().toISOString());
    try { const pid = Number(fs.readFileSync(lockFile, 'utf8')); if (pid && pid !== process.pid) kill(pid); } catch { /* none */ }
    fs.rmSync(lockFile, { force: true });
    for (const p of desk()) kill(p.pid);
    log('stopped by --stop (the watchdog stays off until --start)'); console.log('supervisor and desk processes stopped'); return;
  }
  if (args.includes('--start') || args.includes('--restart')) {
    fs.rmSync(offFile, { force: true });
    if (args.includes('--restart')) {
      fs.writeFileSync(path.join(dir, 'supervisor-restart.json'), JSON.stringify({ at: Date.now() }));
      for (const p of desk()) kill(p.pid);
      log('restart requested');
    }
    // A hidden supervisor of its own (no console window); a supervisor that already runs makes it exit at once.
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: repo, stdio: 'ignore', windowsHide: true, detached: true }).unref();
    console.log(args.includes('--restart') ? 'desk processes stopped; the supervisor starts them again in a few seconds' : 'supervisor started');
    return;
  }
  if (fs.existsSync(offFile)) return;
  if (!claim(lockFile)) return;
  // Down for a while (a reboot, sleep, or the supervisor itself stopped): say so once.
  let last = null;
  try { last = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* first run */ }
  const notify = phone(repo), s = new Supervisor({ repo, log, notify });
  s.adopt(desk());
  const gap = last?.at ? Date.now() - Date.parse(last.at) : 0;
  log(`supervisor started (pid ${process.pid})${gap > SUPERVISE.staleMs ? `, ${fmt(gap)} after the last heartbeat` : ''}`);
  if (gap > SUPERVISE.staleMs && s.children.some(c => !c.pid)) void notify('Desk back on Raven', `The desk was not supervised for ${fmt(gap)} (reboot, sleep or a crash). Its processes are starting now.`).catch(() => undefined);
  const beat = () => {
    try { fs.writeFileSync(statusFile, JSON.stringify(s.status(), null, 1)); const t = new Date(); fs.utimesSync(lockFile, t, t); } catch { /* disk full */ }
  };
  s.tick(); beat();
  setInterval(() => s.tick(), SUPERVISE.checkMs);
  setInterval(beat, SUPERVISE.heartbeatMs);
  const release = () => { try { if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile, { force: true }); } catch { /* gone */ } process.exit(0); };
  process.on('SIGINT', release); process.on('SIGTERM', release);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(`supervise: ${e.message}`); process.exit(1); });

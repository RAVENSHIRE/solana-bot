import fs from 'node:fs';
import { sleep } from './retry';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Schreibt eine Datei atomar (tmp + rename). Unter Windows schlägt rename fehl, solange ein
 * anderer Prozess (z. B. das Dashboard) die Zieldatei gerade liest → kurze Wiederholungen.
 */
const chains = new Map<string, Promise<void>>();

export function atomicWriteFile(file: string, data: string, attempts = 8): Promise<void> {
  // Schreibvorgänge pro Datei serialisieren (sonst kollidieren parallele Flushes auf derselben tmp-Datei)
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => writeOnce(file, data, attempts));
  chains.set(file, next);
  void next.finally(() => {
    if (chains.get(file) === next) chains.delete(file);
  }).catch(() => undefined);
  return next;
}

/**
 * Exklusiver Instanz-Lock mit PID. Ein Lock, dessen Prozess nicht mehr existiert (Absturz, geschlossenes
 * Fenster), wird einmal ersetzt; ein lebender Besitzer bleibt geschützt. Ein leerer oder unlesbarer Lock schützt
 * nur, solange er jünger als `EMPTY_LOCK_STALE_MS` ist: ein lebender Besitzer schreibt seine PID sofort nach dem
 * Anlegen. Älter heisst, der Prozess starb dazwischen oder der Inhalt ging beim Abschalten verloren (Raven, 3 Oct:
 * ein leerer Lock blockierte den Desk nach dem Neustart zwei Tage lang).
 */
export const EMPTY_LOCK_STALE_MS = 60_000;

export async function acquireProcessLock(file: string): Promise<fs.promises.FileHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await fs.promises.open(file, 'wx');
      try {
        await handle.writeFile(String(process.pid));
      } catch (e) {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(file, { force: true });
        throw e;
      }
      return handle;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      const owner = await deadLockOwner(file);
      // Erneut lesen: nur exakt diesen toten Besitzer entfernen, nie einen inzwischen neuen Lock.
      if (owner === null || (await deadLockOwner(file)) !== owner) throw e;
      await fs.promises.rm(file, { force: true });
    }
  }
}

async function deadLockOwner(file: string): Promise<number | null> {
  const text = (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim();
  if (!/^\d{1,10}$/.test(text)) {
    const age = await fs.promises.stat(file).then(st => Date.now() - st.mtimeMs, () => 0);
    return age > EMPTY_LOCK_STALE_MS ? 0 : null;
  }
  const pid = Number(text);
  if (pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? pid : null;
  }
}

/**
 * Legt eine unlesbare Datei beiseite (`<file>.damaged-<Zeit>`), damit eine neue beginnen kann; die beschädigte bleibt
 * zum Nachsehen liegen. Gibt den neuen Namen zurück.
 */
export async function setAside(file: string, now = Date.now()): Promise<string> {
  const to = `${file}.damaged-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  await fs.promises.rename(file, to);
  return to;
}

async function writeOnce(file: string, data: string, attempts: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  // Auf die Platte zwingen, bevor umbenannt wird: sonst kann ein Stromausfall den neuen Namen mit Nullen statt Daten
  // hinterlassen (Raven, 3 Oct: alle TEST-Ledger nur noch Null-Bytes, der Desk startete nicht mehr).
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  for (let i = 1; ; i++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || i >= attempts) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      await sleep(25 * i);
    }
  }
}

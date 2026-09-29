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
 * Fenster), wird einmal ersetzt; ein lebender oder unlesbarer Besitzer bleibt geschützt.
 */
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
  if (!/^\d{1,10}$/.test(text)) return null;
  const pid = Number(text);
  if (pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? pid : null;
  }
}

async function writeOnce(file: string, data: string, attempts: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
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

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

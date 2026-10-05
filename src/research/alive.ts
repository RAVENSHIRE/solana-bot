import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../utils/fs';

/**
 * A dead-man message: once a day, at or after `hourUtc`, the observer tells the phone it is alive and how the desk and
 * the phone have been. If the message does not come, something is down (the observer, the PC, the network or ntfy),
 * and the owner learns it from the missing message instead of from a missed coin. The day it was sent is saved, so a
 * restart never sends it twice.
 */
export const ALIVE = Object.freeze({ hourUtc: 7 });
export interface AliveDeps {
  file: string;
  notify: (title: string, body: string) => Promise<void>;
  /** The lines of the message: uptime, desk last seen, phone deliveries, write errors… */
  lines: (now: number) => string[];
  hourUtc?: number;
  now?: () => number;
}

export class AliveReporter {
  private lastDay: string | null | undefined;
  private busy = false;
  constructor(private readonly d: AliveDeps) {}

  /** Sends the day's message when it is due; true when it was sent now. Never throws. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const now = (this.d.now ?? Date.now)(), day = new Date(now).toISOString().slice(0, 10);
      if (new Date(now).getUTCHours() < (this.d.hourUtc ?? ALIVE.hourUtc)) return false;
      if (this.lastDay === undefined) this.lastDay = await fs.readFile(this.d.file, 'utf8').then(t => (JSON.parse(t) as { day?: string }).day ?? null, () => null);
      if (this.lastDay === day) return false;
      this.lastDay = day;
      await atomicWriteFile(this.d.file, `${JSON.stringify({ day, at: now })}\n`).catch(() => undefined);
      await this.d.notify('ALIVE: research observer', this.d.lines(now).join('\n')).catch(() => undefined);
      return true;
    } finally { this.busy = false; }
  }
}

export const aliveFile = (dir: string) => path.join(dir, 'alive.json');

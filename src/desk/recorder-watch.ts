import fs from 'node:fs/promises';
import path from 'node:path';
import type { Notify } from './watch';

/**
 * Dead-man alert for the research observer (owner-approved 5 Oct, research gate gap 6: it was down about 32 h,
 * 4 Oct 00:xx – 5 Oct 08:56 UTC, and nobody knew). The observer writes its ledger (`ev-YYYYMMDD-HH.jsonl`) all the
 * time: pump.fun alone launches dozens of coins a minute. When no ledger file has changed for 10 minutes while the desk
 * runs, one phone message says so; one more says when it records again. The desk's own start counts as the last write,
 * so a restart of both processes never alerts. A PC that is off cannot send anything: this catches a dead or hung
 * observer on a running PC.
 */
export const RECORDER_WATCH = Object.freeze({ silentMs: 10 * 60_000, checkMs: 60_000 });

/** The newest change of a ledger file in the directory, or null when there is none. */
export async function lastLedgerWrite(dir: string): Promise<number | null> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return null; }
  let last: number | null = null;
  for (const n of names.filter(x => /^ev-\d{8}-\d{2}\.jsonl(\.gz)?$/.test(x)).sort().slice(-3)) {
    try { const m = (await fs.stat(path.join(dir, n))).mtimeMs; last = last === null ? m : Math.max(last, m); } catch { /* rotated away */ }
  }
  return last;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export class RecorderWatch {
  private downSince: number | null = null;
  private last: number | null = null;
  constructor(private readonly dir: string, private readonly notify: Notify, private readonly startedAt = Date.now(),
    private readonly lastWrite: (dir: string) => Promise<number | null> = lastLedgerWrite) {}

  async check(now = Date.now()): Promise<'DOWN' | 'UP' | null> {
    this.last = await this.lastWrite(this.dir).catch(() => null);
    const ref = Math.max(this.last ?? 0, this.startedAt), silent = now - ref;
    if (silent >= RECORDER_WATCH.silentMs && this.downSince === null) {
      this.downSince = ref;
      await this.notify('Research recorder silent', `No new research record since ${hhmm(ref)} UTC (${Math.round(silent / 60_000)} min). INFO alerts, the call rules and the ladder are not recording. ` +
        'A crashed recorder is restarted by the supervisor; a hung one needs node ops\\supervise.mjs --restart on Raven.', { tags: ['warning'] }).catch(() => undefined);
      return 'DOWN';
    }
    if (silent < RECORDER_WATCH.silentMs && this.downSince !== null) {
      const gap = Math.round((ref - this.downSince) / 60_000);
      this.downSince = null;
      await this.notify('Research recorder back', `Recording again since ${hhmm(ref)} UTC, after about ${gap} min without records.`, { tags: ['white_check_mark'] }).catch(() => undefined);
      return 'UP';
    }
    return null;
  }

  status(now = Date.now()): string {
    if (this.downSince !== null) return `SILENT since ${hhmm(this.downSince)} UTC — the phone was told`;
    return this.last === null ? 'no ledger file yet' : `last record ${Math.max(0, Math.round((now - this.last) / 1000))} s ago · phone alert after ${RECORDER_WATCH.silentMs / 60_000} min of silence`;
  }
}

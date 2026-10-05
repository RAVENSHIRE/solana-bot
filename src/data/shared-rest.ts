import fs from 'node:fs';

/**
 * A rest every process on this PC respects for one provider. GeckoTerminal's free limit (about 30 calls a minute) is
 * per machine, and both the desk (dashboard process: scans, coin check) and the ladder (research observer) call it.
 * A 429 in either writes "rest until" to a small file; both read it (at most every 2 s) before calling, so one refusal
 * pauses everybody instead of each process hammering on alone. A missing or unreadable file means no rest.
 */
export class SharedRest {
  private cached = { at: -Infinity, until: 0 };
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  until(): number {
    const t = this.now();
    if (t - this.cached.at > 2_000) {
      let until = 0;
      try { const v = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { until?: unknown }).until; until = typeof v === 'number' && Number.isFinite(v) ? v : 0; } catch { /* no rest */ }
      this.cached = { at: t, until };
    }
    return this.cached.until;
  }
  resting(): boolean { return this.now() < this.until(); }
  /** Rests at least `ms` from now (never shortens a longer rest another process set). */
  rest(ms: number): void {
    const until = Math.max(this.until(), this.now() + ms);
    this.cached = { at: this.now(), until };
    try { fs.writeFileSync(this.file, `${JSON.stringify({ until, at: this.now() })}\n`); } catch { /* the in-process rest still holds */ }
  }
}

/** GeckoTerminal: a 429 rests every caller this long at least (its 429 carries no Retry-After). */
export const GECKO_REST_MS = 60_000;
export const geckoRestFile = (dataDesk: string) => `${dataDesk.replace(/[\\/]+$/, '')}/geckoterminal-rest.json`;

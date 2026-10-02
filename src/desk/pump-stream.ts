import type { LaunchEvent } from './launches';
import type { Graduation } from './migrations';

/**
 * New pump.fun launches and graduations from the research observer's live stream on this machine (see
 * research/local-feed.ts), instead of polling the RPC for signatures and one transaction per launch. `healthy()` is
 * false when the observer is not running or its upstream is down; the feeds then fall back to the RPC.
 */
export interface PumpEventSource {
  healthy(now: number): boolean;
  drainCreates(): LaunchEvent[];
  /** The graduations seen recently (not drained: the TEST and LIVE engines each keep their own feed and read it). */
  migrations(): Graduation[];
}

export class LocalPumpStream implements PumpEventSource {
  private after = 0;
  private lastOkAt = 0;
  private upstreamHealthy = false;
  private creates: LaunchEvent[] = [];
  private recentMigrations: Graduation[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  polls = 0; failures = 0;
  constructor(private readonly url = 'http://127.0.0.1:3101/pump/events', private readonly fetcher: typeof fetch = fetch, private readonly everyMs = 1_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  healthy(now = Date.now()): boolean { return this.upstreamHealthy && now - this.lastOkAt < 10_000; }
  drainCreates(): LaunchEvent[] { const out = this.creates; this.creates = []; return out; }
  migrations(): Graduation[] { return this.recentMigrations; }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.polls++;
    try {
      const res = await this.fetcher(`${this.url}?after=${this.after}`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { seq: number; healthy: boolean; creates: Array<LaunchEvent & { seq: number }>; migrations: Array<Graduation & { seq: number }> };
      // A restarted observer starts its sequence again: everything it has is new to us.
      const restarted = j.seq < this.after;
      if (restarted) this.after = 0;
      for (const c of j.creates) if (restarted || c.seq > this.after) this.creates.push({ mint: c.mint, name: c.name, symbol: c.symbol, uri: c.uri, creator: c.creator, at: c.at, signature: c.signature });
      for (const m of j.migrations) if (restarted || m.seq > this.after) this.recentMigrations.push({ mint: m.mint, signature: m.signature, at: m.at });
      if (this.creates.length > 5_000) this.creates.splice(0, this.creates.length - 5_000);
      if (this.recentMigrations.length > 2_000) this.recentMigrations.splice(0, this.recentMigrations.length - 2_000);
      this.after = j.seq; this.upstreamHealthy = j.healthy; this.lastOkAt = Date.now();
    } catch { this.failures++; }
    finally { this.busy = false; }
  }
}

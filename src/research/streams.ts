/**
 * Long-lived websocket feeds that reconnect by themselves. Every disconnect is reported (it becomes a GAP record), so
 * the dataset always says when it was blind. A feed that stays silent longer than `idleMs` is treated as dead.
 */
export interface SocketLike {
  send(data: string): void; close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;
export const defaultSocket: SocketFactory = url => new WebSocket(url) as unknown as SocketLike;

export interface FeedOptions { minRetryMs?: number; maxRetryMs?: number; idleMs?: number; factory?: SocketFactory }

export class ReconnectingFeed {
  private socket: SocketLike | null = null;
  private retryMs: number;
  private lastMessageAt = 0;
  private stopped = true;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  connects = 0;
  messages = 0;

  constructor(
    readonly name: string, private readonly url: string,
    private readonly handlers: { open: (send: (data: string) => void) => void; message: (data: string) => void; gap: (detail: string) => void },
    private readonly o: FeedOptions = {},
  ) { this.retryMs = o.minRetryMs ?? 1_000; }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.socket && this.lastMessageAt && Date.now() - this.lastMessageAt > (this.o.idleMs ?? 60_000)) {
        this.handlers.gap(`${this.name}: no message for ${Math.round((Date.now() - this.lastMessageAt) / 1000)} s, reconnecting`);
        this.drop();
      }
    }, 5_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const s = this.socket; this.socket = null;
    try { s?.close(); } catch { /* already closed */ }
  }

  private connect(): void {
    if (this.stopped) return;
    let s: SocketLike;
    try { s = (this.o.factory ?? defaultSocket)(this.url); } catch (error) { this.handlers.gap(`${this.name}: ${(error as Error).message}`); this.schedule(); return; }
    this.socket = s;
    s.onopen = () => {
      this.connects++; this.retryMs = this.o.minRetryMs ?? 1_000; this.lastMessageAt = Date.now();
      try { this.handlers.open(d => s.send(d)); } catch { /* a failed subscribe shows up as silence */ }
    };
    s.onmessage = ev => {
      if (this.socket !== s) return;
      this.lastMessageAt = Date.now(); this.messages++;
      try { this.handlers.message(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { /* one bad message never stops the feed */ }
    };
    s.onerror = () => { /* followed by onclose */ };
    s.onclose = ev => {
      if (this.socket !== s) return;
      this.socket = null;
      this.handlers.gap(`${this.name}: closed${ev?.code ? ` (${ev.code})` : ''}`);
      this.schedule();
    };
  }

  private drop(): void {
    const s = this.socket; this.socket = null;
    try { s?.close(); } catch { /* ignore */ }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.o.maxRetryMs ?? 60_000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, wait);
    this.retryTimer.unref?.();
  }
}

/** A bounded set of recently seen keys (transaction signatures delivered by more than one feed). */
export class RecentSet {
  private readonly items = new Set<string>();
  constructor(private readonly max = 100_000) {}
  /** True the first time a key is seen. */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.max) for (const k of this.items) { this.items.delete(k); if (this.items.size <= this.max * 0.9) break; }
    return true;
  }
}

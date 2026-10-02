import http from 'node:http';

/**
 * The observer's live pump.fun stream, shared with the desk on this machine (127.0.0.1 only). PumpPortal asks for one
 * websocket per client, and the desk would otherwise poll the RPC for every launch and graduation; it reads new
 * creations and migrations from here instead, and falls back to the RPC when the observer is not running.
 *
 *   GET /pump/events?after=<seq>  →  { seq, healthy, creates: [...], migrations: [...] }
 */
export interface FeedCreate { seq: number; mint: string; name: string; symbol: string; uri: string; creator: string | null; signature: string; at: number }
export interface FeedMigration { seq: number; mint: string; signature: string; at: number }
export const LOCAL_FEED = Object.freeze({ port: 3101, keep: 5_000 });

export class LocalFeed {
  private seq = 0;
  private creates: FeedCreate[] = [];
  private migrations: FeedMigration[] = [];
  private readonly seenCreates = new Set<string>();
  private server: http.Server | null = null;
  constructor(private readonly healthy: () => boolean = () => true) {}

  addCreate(c: Omit<FeedCreate, 'seq'>): void {
    if (this.seenCreates.has(c.mint)) return;
    this.seenCreates.add(c.mint);
    if (this.seenCreates.size > LOCAL_FEED.keep * 4) this.seenCreates.clear();
    this.creates.push({ ...c, seq: ++this.seq });
    if (this.creates.length > LOCAL_FEED.keep) this.creates.splice(0, this.creates.length - LOCAL_FEED.keep);
  }
  addMigration(m: Omit<FeedMigration, 'seq'>): void {
    this.migrations.push({ ...m, seq: ++this.seq });
    if (this.migrations.length > LOCAL_FEED.keep) this.migrations.splice(0, this.migrations.length - LOCAL_FEED.keep);
  }
  since(after: number): { seq: number; healthy: boolean; creates: FeedCreate[]; migrations: FeedMigration[] } {
    return { seq: this.seq, healthy: this.healthy(), creates: this.creates.filter(c => c.seq > after), migrations: this.migrations.filter(m => m.seq > after) };
  }

  listen(port: number = LOCAL_FEED.port): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/pump/events') { res.writeHead(404).end(); return; }
        const after = Number(url.searchParams.get('after') ?? 0);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(this.since(Number.isFinite(after) ? after : 0)));
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }
  close(): void { this.server?.close(); this.server = null; }
}

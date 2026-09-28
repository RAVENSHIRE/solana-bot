import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecMode } from '../../core/types';
import type { Logger } from '../../utils/logger';
import { redact } from '../../utils/redact';

export const HistoryRecord = z.object({ version: z.literal(1), id: z.string(), mode: z.enum(['SIMULATION', 'LIVE']),
  receivedAt: z.number().int().nonnegative(), kind: z.string(), source: z.string(), payload: z.unknown() });
export type HistoryRecord = z.infer<typeof HistoryRecord>;
export class MarketDataStore {
  private queue: Promise<void> = Promise.resolve(); private pending = 0;
  private lastCleanup = 0; private sequence = 0; private file = ''; private fileBytes = 0;
  dropped = 0;
  constructor(private readonly dir: string, private readonly mode: ExecMode, private readonly log: Logger,
    private readonly retentionDays = 7, private readonly maxBytes = 128 * 1024 * 1024) {}
  append(kind: string, source: string, payload: unknown, receivedAt = Date.now()): void {
    const row = JSON.stringify({ version: 1, id: randomUUID(), mode: this.mode, receivedAt, kind, source, payload: redact(payload) }) + '\n';
    if (Buffer.byteLength(row) > Math.min(this.maxBytes, 2 * 1024 * 1024) || this.pending >= 500) {
      this.dropped++; this.log.warn('History record dropped: bounded queue/record size', { dropped: this.dropped }); return;
    }
    this.pending++;
    this.queue = this.queue.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const day = new Date(receivedAt).toISOString().slice(0, 10);
      let rotated = false;
      if (!this.file.includes(`-${day}-`) || this.fileBytes + Buffer.byteLength(row) > Math.min(this.maxBytes, 8 * 1024 * 1024)) {
        this.file = path.join(this.dir, `market-${this.mode}-${day}-${Date.now()}-${process.pid}-${String(this.sequence++).padStart(6, '0')}.jsonl`); this.fileBytes = 0; rotated = true;
      }
      await fs.appendFile(this.file, row, { mode: 0o600 }); this.fileBytes += Buffer.byteLength(row);
      if (rotated || Date.now() - this.lastCleanup > 60_000) await this.cleanup();
    }).catch(() => { this.dropped++; this.log.error('History write failed', { dropped: this.dropped }); }).finally(() => { this.pending--; });
  }
  async cleanup(now = Date.now()): Promise<void> {
    this.lastCleanup = now;
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    const files = await Promise.all(entries.filter(e => e.isFile() && e.name.startsWith(`market-${this.mode}-`) && e.name.endsWith('.jsonl')).map(async e => ({ name: e.name, stat: await fs.stat(path.join(this.dir, e.name)) })));
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
    let kept = 0;
    for (const f of files) {
      const expired = now - f.stat.mtimeMs > this.retentionDays * 86_400_000;
      if (expired || kept + f.stat.size > this.maxBytes) await fs.unlink(path.join(this.dir, f.name));
      else kept += f.stat.size;
    }
  }
  async flush(): Promise<void> { await this.queue; await this.cleanup(); }
}

/** Read-only inspection/replay: imports no network, wallet or execution modules. */
export async function* replay(dir: string, mode: ExecMode, asOf: number): AsyncGenerator<HistoryRecord> {
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('Invalid replay cutoff');
  const files = (await fs.readdir(dir, { withFileTypes: true })).filter(f => f.isFile() && f.name.startsWith(`market-${mode}-`) && f.name.endsWith('.jsonl')).map(f => f.name).sort();
  for (const file of files) {
    const input = createReadStream(path.join(dir, file));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) {
      const row = HistoryRecord.parse(JSON.parse(line));
      if (row.mode !== mode) throw new Error('Replay mode mismatch');
      if (row.receivedAt <= asOf) yield row;
    } } finally { lines.close(); input.destroy(); }
  }
}

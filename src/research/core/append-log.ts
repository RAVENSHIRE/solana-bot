import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireProcessLock } from '../../utils/fs';
import { canonicalJson, sha256Hex } from './canonical';

/**
 * Append-only, hash-chained JSONL log split into segments. The event store and the experiment registry are built on it.
 *
 * - Lines are never rewritten or deleted. A segment is closed when it reaches `maxSegmentBytes` and a new one starts.
 * - Every line carries `seq`, `prev_hash` and `hash = sha256(canonical({seq, prev_hash, data}))`, so `verify()` detects
 *   an edited, reordered or removed line anywhere in the history.
 * - One writer per directory (PID lock; a lock left by a crashed process is replaced, see utils/fs). Any number of
 *   readers: they only read complete lines.
 * - A line torn by a crash is left as it is (history is not "repaired"); the writer continues in a new segment and
 *   the torn line is reported by `verify()`.
 */

export interface LogLine<T> { seq: number; prev_hash: string; hash: string; data: T }
export const GENESIS_HASH = '0'.repeat(64);

export interface AppendLogOptions {
  dir: string;
  /** File name prefix of the segments, e.g. `events` → events-000000000001.jsonl. */
  prefix: string;
  maxSegmentBytes?: number;
}

export const lineHash = (seq: number, prevHash: string, data: unknown): string => sha256Hex(canonicalJson({ seq, prev_hash: prevHash, data }));

const SEGMENT = (prefix: string) => new RegExp(`^${prefix.replace(/[^A-Za-z0-9_-]/g, '')}-(\\d{12})\\.jsonl$`);

export async function listSegments(dir: string, prefix: string): Promise<string[]> {
  const re = SEGMENT(prefix);
  const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return [] as string[]; throw e; });
  return names.filter(n => re.test(n)).sort().map(n => path.join(dir, n));
}

export interface ReadIssue { file: string; line: number; kind: 'TORN_LINE' | 'UNPARSEABLE_LINE' }

/**
 * Reads every complete line of every segment in order. A final line without its newline is a write in progress (or a
 * torn write) and is skipped; an unparseable line elsewhere is reported through `onIssue`.
 */
export async function* readLog<T>(dir: string, prefix: string, onIssue?: (i: ReadIssue) => void): AsyncGenerator<LogLine<T>> {
  for (const file of await listSegments(dir, prefix)) {
    const text = await fs.readFile(file, 'utf8');
    // After split, the last element is '' when the file ends with a newline, otherwise an unterminated line.
    const lines = text.split('\n'), complete = lines.length - 1;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      if (!raw) continue;
      if (i >= complete) { onIssue?.({ file, line: i + 1, kind: 'TORN_LINE' }); continue; }
      let parsed: LogLine<T>;
      try { parsed = JSON.parse(raw) as LogLine<T>; } catch { onIssue?.({ file, line: i + 1, kind: 'UNPARSEABLE_LINE' }); continue; }
      yield parsed;
    }
  }
}

export interface VerifyReport {
  ok: boolean; lines: number; segments: number; lastSeq: number; lastHash: string;
  issues: Array<ReadIssue | { file: string; line: number; kind: 'HASH_MISMATCH' | 'CHAIN_BREAK' | 'SEQ_GAP'; seq: number }>;
}

/** Recomputes the whole chain. `ok` is false on any edit, gap, reorder or unreadable line (torn tails included). */
export async function verifyLog(dir: string, prefix: string): Promise<VerifyReport> {
  const issues: VerifyReport['issues'] = [];
  let prev = GENESIS_HASH, expected = 1, lines = 0;
  const segments = await listSegments(dir, prefix);
  for (const file of segments) {
    const text = await fs.readFile(file, 'utf8');
    const rows = text.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      if (!raw) continue;
      if (i === rows.length - 1 && !text.endsWith('\n')) { issues.push({ file, line: i + 1, kind: 'TORN_LINE' }); continue; }
      let row: LogLine<unknown>;
      try { row = JSON.parse(raw) as LogLine<unknown>; } catch { issues.push({ file, line: i + 1, kind: 'UNPARSEABLE_LINE' }); continue; }
      lines++;
      if (row.seq !== expected) issues.push({ file, line: i + 1, kind: 'SEQ_GAP', seq: row.seq });
      if (row.prev_hash !== prev) issues.push({ file, line: i + 1, kind: 'CHAIN_BREAK', seq: row.seq });
      if (lineHash(row.seq, row.prev_hash, row.data) !== row.hash) issues.push({ file, line: i + 1, kind: 'HASH_MISMATCH', seq: row.seq });
      prev = row.hash; expected = row.seq + 1;
    }
  }
  return { ok: issues.length === 0, lines, segments: segments.length, lastSeq: expected - 1, lastHash: prev, issues };
}

export class AppendLog<T> {
  private seq = 0;
  private prevHash = GENESIS_HASH;
  private file = '';
  private fileBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Torn or unparseable lines found when the log was opened (history is never modified to remove them). */
  readonly openIssues: ReadIssue[] = [];

  private constructor(private readonly o: Required<AppendLogOptions>, private readonly lock: fs.FileHandle | null) {}

  /**
   * Opens the log for writing: takes the writer lock, replays the chain to find its head and passes every existing
   * record to `onExisting` (to rebuild indexes). `lock: false` is for single-process tests only.
   */
  static async open<T>(o: AppendLogOptions & { lock?: boolean }, onExisting?: (line: LogLine<T>) => void): Promise<AppendLog<T>> {
    const opts = { maxSegmentBytes: 32 * 1024 * 1024, ...o } as Required<AppendLogOptions>;
    if (!/^[A-Za-z0-9_-]+$/.test(opts.prefix)) throw new Error('AppendLog: invalid prefix');
    await fs.mkdir(opts.dir, { recursive: true });
    const lock = o.lock === false ? null : await acquireProcessLock(path.join(opts.dir, `.${opts.prefix}.writer.lock`));
    const log = new AppendLog<T>(opts, lock);
    try {
      let torn = false;
      for await (const line of readLog<T>(opts.dir, opts.prefix, i => { log.openIssues.push(i); torn = true; })) {
        log.seq = line.seq; log.prevHash = line.hash;
        onExisting?.(line);
      }
      const segments = await listSegments(opts.dir, opts.prefix);
      const last = segments.at(-1);
      // Continue in the newest segment unless it ends in a torn line: then that segment stays as it is.
      if (last && !torn) { log.file = last; log.fileBytes = (await fs.stat(last)).size; }
    } catch (error) {
      await log.close();
      throw error;
    }
    return log;
  }

  get head(): { seq: number; hash: string } { return { seq: this.seq, hash: this.prevHash }; }

  /** Appends records in order, as one write. Resolves after the bytes were handed to the file system. */
  append(records: readonly T[]): Promise<Array<LogLine<T>>> {
    if (this.closed) return Promise.reject(new Error('AppendLog: closed'));
    const job = this.queue.then(async () => {
      const lines: Array<LogLine<T>> = [];
      for (const data of records) {
        const seq = this.seq + 1, hash = lineHash(seq, this.prevHash, data);
        lines.push({ seq, prev_hash: this.prevHash, hash, data });
        this.seq = seq; this.prevHash = hash;
      }
      if (!lines.length) return lines;
      const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n', bytes = Buffer.byteLength(text);
      if (!this.file || this.fileBytes + bytes > this.o.maxSegmentBytes) {
        this.file = path.join(this.o.dir, `${this.o.prefix}-${String(lines[0]!.seq).padStart(12, '0')}.jsonl`);
        this.fileBytes = 0;
      }
      try {
        await fs.appendFile(this.file, text, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        // The in-memory head moved ahead of the file: stop writing rather than leave a gap in the chain.
        this.closed = true;
        throw error;
      }
      this.fileBytes += bytes;
      return lines;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async flush(): Promise<void> { await this.queue; }

  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    if (this.lock) {
      await this.lock.close().catch(() => undefined);
      await fs.rm(path.join(this.o.dir, `.${this.o.prefix}.writer.lock`), { force: true });
    }
  }
}

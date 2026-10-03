import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/**
 * The research ledger: an append-only record of what was observed, when. Nothing in it is a score or a decision.
 *
 * One JSON array per line, the first element its type (see RESEARCH.md). Files are hourly (`ev-YYYYMMDD-HH.jsonl`,
 * UTC) and gzipped once the hour is over. Mints and wallets are written once per file as dictionary lines
 * (`["M", i, mint]`, `["W", i, wallet]`) and referenced by number, which keeps a day of trades small enough for
 * a nearly full disk. Bulk records (trades, candles) stop while free disk space is below `minFreeMb`.
 */
export type Ref = { $m: string } | { $w: string };
export type Field = string | number | boolean | null | Ref | Record<string, unknown> | readonly unknown[];

export interface LedgerOptions {
  dir: string;
  now?: () => number;
  /** Bulk records stop below this much free disk space, and resume 100 MB above it. */
  minFreeMb?: number;
  flushMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
}

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '').replace(/^(\d{8})(\d{2})$/, '$1-$2');
const isRef = (v: unknown): v is Ref => !!v && typeof v === 'object' && !Array.isArray(v) && ('$m' in v || '$w' in v) && Object.keys(v).length === 1;

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export class ResearchLedger {
  private readonly now: () => number;
  private key: string | null = null;
  private lines: string[] = [];
  private mints = new Map<string, number>();
  private wallets = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  /** True while free disk space is low: callers skip bulk records. */
  lowDisk = false;
  bytes = 0;
  records = 0;
  /** Failed appends (their lines are lost) and the last error; each is also written as a `GAP` record once writing works again. */
  writeErrors = 0;
  lastWriteError: string | null = null;

  constructor(private readonly o: LedgerOptions) { this.now = o.now ?? Date.now; }

  file(key = this.key): string { return path.join(this.o.dir, `ev-${key}.jsonl`); }

  /** Compresses plain files left by an earlier run (any hour but the current one) and starts the flush and disk timers. */
  async start(): Promise<void> {
    await fsp.mkdir(this.o.dir, { recursive: true });
    const current = hourKey(this.now());
    for (const name of await fsp.readdir(this.o.dir)) {
      const m = /^ev-(\d{8}-\d{2})\.jsonl$/.exec(name);
      if (m && m[1] !== current) await this.compress(path.join(this.o.dir, name));
    }
    await this.checkDisk();
    this.timers.push(setInterval(() => void this.flush(), this.o.flushMs ?? 2_000), setInterval(() => void this.checkDisk(), 60_000));
    for (const t of this.timers) t.unref?.();
  }

  /** Appends one record; `{ $m }` and `{ $w }` fields become this file's dictionary numbers. */
  put(rec: readonly Field[]): void {
    const key = hourKey(this.now());
    if (key !== this.key) this.rotate(key);
    const out = rec.map(v => isRef(v) ? ('$m' in v ? this.ref(this.mints, 'M', v.$m) : this.ref(this.wallets, 'W', v.$w)) : v);
    this.push(JSON.stringify(out));
  }

  async flush(): Promise<void> {
    if (!this.lines.length || !this.key) return this.chain;
    const file = this.file(), text = this.lines.join('\n') + '\n';
    this.lines = [];
    this.bytes += Buffer.byteLength(text);
    const lost = text.split('\n').length - 1;
    this.chain = this.chain.then(() => fsp.appendFile(file, text)).catch((error: unknown) => this.writeFailed(file, error, lost));
    return this.chain;
  }

  /**
   * An append failed (disk full, file locked): its lines are gone. The failure is counted and recorded as a GAP, and if
   * it hit the current hour's file the dictionaries start over, so later records never point at a mint or wallet whose
   * dictionary line was in the lost batch (readers apply dictionary lines in order, so a re-numbered entry is safe).
   */
  private writeFailed(file: string, error: unknown, lost: number): void {
    this.writeErrors++;
    this.lastWriteError = `${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`;
    if (file === this.file()) { this.mints = new Map(); this.wallets = new Map(); }
    this.push(JSON.stringify(['GAP', this.now(), 'ledger', `write failed, ${lost} lines lost: ${this.lastWriteError}`]));
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.flush();
    await this.chain;
  }

  private push(line: string): void { this.lines.push(line); this.records++; if (this.lines.length >= 5_000) void this.flush(); }

  private ref(map: Map<string, number>, tag: 'M' | 'W', value: string): number {
    let i = map.get(value);
    if (i === undefined) { i = map.size; map.set(value, i); this.push(JSON.stringify([tag, i, value])); }
    return i;
  }

  private rotate(key: string): void {
    const previous = this.key;
    if (previous) void this.flush();
    this.key = key; this.mints = new Map(); this.wallets = new Map();
    if (previous) {
      const file = this.file(previous);
      this.chain = this.chain.then(() => this.compress(file)).catch((error: unknown) => { this.writeErrors++; this.lastWriteError = `gzip ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`; });
    }
  }

  private async compress(file: string): Promise<void> {
    if (!fs.existsSync(file)) return;
    await pipeline(fs.createReadStream(file), createGzip({ level: 9 }), fs.createWriteStream(`${file}.gz`));
    await fsp.unlink(file);
  }

  private async checkDisk(): Promise<void> {
    try {
      const free = await (this.o.freeBytes ?? defaultFreeBytes)(this.o.dir), min = (this.o.minFreeMb ?? 700) * 1024 * 1024;
      if (!this.lowDisk && free < min) { this.lowDisk = true; this.put(['GAP', this.now(), 'disk', `free disk ${Math.round(free / 1048576)} MB: trades and candles paused`]); }
      else if (this.lowDisk && free > min + 100 * 1048576) { this.lowDisk = false; this.put(['GAP', this.now(), 'disk', `free disk ${Math.round(free / 1048576)} MB: trades and candles resumed`]); }
    } catch { /* statfs unavailable: keep writing */ }
  }
}

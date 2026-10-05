import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile, setAside } from '../utils/fs';
import { DESK } from './config';
import type { DeskEvent, DeskMode, Stage } from './types';

const detail = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const eventSchema = z.object({ id: z.number().int().nonnegative(), at: z.number().int().positive(), mode: z.enum(['PAPER', 'LIVE']),
  stage: z.string(), mint: z.string().nullable(), symbol: z.string().nullable(), message: z.string(), detail: detail.optional() });

/** Per-token scanner outcomes: dozens per scan. Kept in their own window so they never push out execution events. */
const NOISE = new Set<string>(['FILTERED', 'WATCHLIST', 'SCANNING']);

/** History rows kept for retry while the .log.jsonl cannot be written; older ones are dropped and counted. */
export const EVENT_HISTORY_MAX_PENDING = 20_000;

/** Timestamped pipeline telemetry for one mode. Persisted so stopping never loses it. */
export class EventLog {
  private events: DeskEvent[] = [];
  private next = 1;
  private dirty = false;
  /** Every event is also appended to a JSONL history so long runs are reviewable beyond the on-screen window. */
  private unlogged: DeskEvent[] = [];
  /** History rows dropped because the history file stayed unwritable. */
  droppedHistory = 0;
  constructor(readonly mode: DeskMode, private readonly file: string | null, private readonly now: () => number = Date.now) {}

  /** Where an unreadable events file was moved before this log started empty. */
  damaged: string | null = null;

  /** An unreadable file (e.g. all zero bytes after a power cut) is moved aside: events are telemetry, the .log.jsonl history stays. */
  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const rows = z.array(eventSchema).parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.events = rows.filter(e => e.mode === this.mode) as DeskEvent[];
      this.trim();
      this.next = (this.events.at(-1)?.id ?? 0) + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.damaged = await setAside(this.file, this.now());
    }
  }

  add(stage: Stage, message: string, context: { mint?: string | null; symbol?: string | null; detail?: DeskEvent['detail'] } = {}): DeskEvent {
    const event: DeskEvent = { id: this.next++, at: this.now(), mode: this.mode, stage, mint: context.mint ?? null,
      symbol: context.symbol ?? null, message, ...(context.detail ? { detail: context.detail } : {}) };
    this.events.push(event); this.unlogged.push(event);
    this.trim();
    this.dirty = true;
    return event;
  }

  /** Keeps the newest maxEvents of each kind: scanner outcomes and everything else (signals, orders, positions, PnL). */
  private trim(): void {
    const noise = this.events.filter(e => NOISE.has(e.stage)), rest = this.events.filter(e => !NOISE.has(e.stage));
    if (noise.length <= DESK.maxEvents && rest.length <= DESK.maxEvents) return;
    this.events = [...noise.slice(-DESK.maxEvents), ...rest.slice(-DESK.maxEvents)].sort((a, b) => a.id - b.id);
  }

  /** The newest `limit` events of each kind, oldest first. */
  list(limit: number = DESK.maxEvents): DeskEvent[] {
    const noise = this.events.filter(e => NOISE.has(e.stage)).slice(-limit), rest = this.events.filter(e => !NOISE.has(e.stage)).slice(-limit);
    return [...noise, ...rest].sort((a, b) => a.id - b.id);
  }

  async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    // Cleared before the write (events added meanwhile set it again) and restored when the write fails, so the next
    // flush retries instead of waiting for another event.
    this.dirty = false;
    try { await atomicWriteFile(this.file, JSON.stringify(this.events)); } catch (error) { this.dirty = true; throw error; }
    const rows = this.unlogged.splice(0), history = this.file.replace(/\.json$/, '.log.jsonl');
    if (!rows.length) return;
    try {
      const size = await fs.stat(history).then(st => st.size, () => 0);
      // A unique suffix: renaming to `.1` overwrote the previous rotation and destroyed older history.
      if (size > 20 * 1024 * 1024) await fs.rename(history, `${history}.${new Date().toISOString().replace(/[:.]/g, '-')}`).catch(() => undefined);
      await fs.appendFile(history, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    } catch (error) {
      // Kept for the next flush, but bounded: a history file that stays locked must not grow memory without end.
      this.unlogged.unshift(...rows);
      if (this.unlogged.length > EVENT_HISTORY_MAX_PENDING) { this.droppedHistory += this.unlogged.length - EVENT_HISTORY_MAX_PENDING; this.unlogged.splice(0, this.unlogged.length - EVENT_HISTORY_MAX_PENDING); }
      this.dirty = true; throw error;
    }
  }
}

import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile } from '../utils/fs';
import { DESK } from './config';
import type { DeskEvent, DeskMode, Stage } from './types';

const detail = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const eventSchema = z.object({ id: z.number().int().nonnegative(), at: z.number().int().positive(), mode: z.enum(['PAPER', 'LIVE']),
  stage: z.string(), mint: z.string().nullable(), symbol: z.string().nullable(), message: z.string(), detail: detail.optional() });

/** Timestamped pipeline telemetry for one mode. Persisted so stopping never loses it. */
export class EventLog {
  private events: DeskEvent[] = [];
  private next = 1;
  private dirty = false;
  constructor(readonly mode: DeskMode, private readonly file: string | null, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const rows = z.array(eventSchema).parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.events = rows.filter(e => e.mode === this.mode).slice(-DESK.maxEvents) as DeskEvent[];
      this.next = (this.events.at(-1)?.id ?? 0) + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DESK_EVENTS_INVALID');
    }
  }

  add(stage: Stage, message: string, context: { mint?: string | null; symbol?: string | null; detail?: DeskEvent['detail'] } = {}): DeskEvent {
    const event: DeskEvent = { id: this.next++, at: this.now(), mode: this.mode, stage, mint: context.mint ?? null,
      symbol: context.symbol ?? null, message, ...(context.detail ? { detail: context.detail } : {}) };
    this.events.push(event);
    if (this.events.length > DESK.maxEvents) this.events.splice(0, this.events.length - DESK.maxEvents);
    this.dirty = true;
    return event;
  }

  list(limit: number = DESK.maxEvents): DeskEvent[] { return this.events.slice(-limit); }

  async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await atomicWriteFile(this.file, JSON.stringify(this.events));
  }
}

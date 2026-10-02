import { AppendLog, readLog, verifyLog, type VerifyReport } from '../core/append-log';
import { quantile } from '../core/stats';
import { eventIdOf, makeEvent, type FactoryOptions } from './factory';
import { knownAt, type EventInput, type EventType, type KnowledgeMode, type QualityStatus, type ResearchEvent } from './types';

export interface EventFilter {
  tokens?: readonly (string | null)[];
  types?: readonly EventType[];
  sources?: readonly string[];
  timestampFrom?: number;
  timestampTo?: number;
  /** Point in time: only events known by `at` under `mode` (and that had happened by then). */
  knownBy?: { at: number; mode: KnowledgeMode };
  correlationId?: string;
  /** INVALID events are excluded unless asked for. */
  includeInvalid?: boolean;
  limit?: number;
}

export type AppendStatus = 'APPENDED' | 'DUPLICATE' | 'CONFLICT_APPENDED';
export interface AppendResult { status: AppendStatus; event: ResearchEvent; conflictsWith?: string }

export interface StoreStats {
  events: number; duplicatesIgnored: number; conflicts: number;
  byType: Record<string, number>; bySource: Record<string, number>; byQuality: Record<string, number>; byCapture: Record<string, number>;
  firstTimestamp: number | null; lastTimestamp: number | null; lastObservedAt: number | null;
  /** Ingestion latency (observed_at − timestamp) per source, live captures with a real timestamp only. */
  latencyMs: Record<string, { n: number; p50: number | null; p95: number | null; max: number | null }>;
}

export interface EventReader {
  query(filter?: EventFilter): Promise<ResearchEvent[]>;
  get(eventId: string): Promise<ResearchEvent | null>;
  stats(): Promise<StoreStats>;
}
export interface EventWriter {
  append(inputs: EventInput | readonly EventInput[]): Promise<AppendResult[]>;
}
export type EventStore = EventReader & EventWriter;

export function matches(e: ResearchEvent, f: EventFilter): boolean {
  if (!f.includeInvalid && e.quality.status === 'INVALID') return false;
  if (f.tokens && !f.tokens.includes(e.token)) return false;
  if (f.types && !f.types.includes(e.event_type)) return false;
  if (f.sources && !f.sources.includes(e.source)) return false;
  if (f.timestampFrom !== undefined && e.timestamp < f.timestampFrom) return false;
  if (f.timestampTo !== undefined && e.timestamp > f.timestampTo) return false;
  if (f.correlationId !== undefined && e.correlation_id !== f.correlationId) return false;
  if (f.knownBy && (knownAt(e, f.knownBy.mode) > f.knownBy.at || e.timestamp > f.knownBy.at)) return false;
  return true;
}

/** The order in which knowledge arrived: known-at, then event time, then id (a total, deterministic order). */
export function knowledgeOrder(mode: KnowledgeMode): (a: ResearchEvent, b: ResearchEvent) => number {
  return (a, b) => knownAt(a, mode) - knownAt(b, mode) || a.timestamp - b.timestamp || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
}
/** Event-time order (what happened when), ties by id. */
export const timeOrder = (a: ResearchEvent, b: ResearchEvent): number =>
  a.timestamp - b.timestamp || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);

export function computeStats(events: Iterable<ResearchEvent>, duplicatesIgnored = 0, conflicts = 0): StoreStats {
  const s: StoreStats = { events: 0, duplicatesIgnored, conflicts, byType: {}, bySource: {}, byQuality: {}, byCapture: {},
    firstTimestamp: null, lastTimestamp: null, lastObservedAt: null, latencyMs: {} };
  const lat = new Map<string, number[]>();
  for (const e of events) {
    s.events++;
    s.byType[e.event_type] = (s.byType[e.event_type] ?? 0) + 1;
    s.bySource[e.source] = (s.bySource[e.source] ?? 0) + 1;
    s.byQuality[e.quality.status] = (s.byQuality[e.quality.status] ?? 0) + 1;
    s.byCapture[e.capture] = (s.byCapture[e.capture] ?? 0) + 1;
    s.firstTimestamp = s.firstTimestamp === null ? e.timestamp : Math.min(s.firstTimestamp, e.timestamp);
    s.lastTimestamp = s.lastTimestamp === null ? e.timestamp : Math.max(s.lastTimestamp, e.timestamp);
    s.lastObservedAt = s.lastObservedAt === null ? e.observed_at : Math.max(s.lastObservedAt, e.observed_at);
    if (e.capture === 'LIVE' && e.ingestion_latency_ms !== null) {
      const list = lat.get(e.source) ?? []; list.push(e.ingestion_latency_ms); lat.set(e.source, list);
    }
  }
  for (const [src, xs] of lat) s.latencyMs[src] = { n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: Math.max(...xs) };
  return s;
}

/** Shared dedupe / conflict bookkeeping of both stores. */
class Index {
  readonly ids = new Set<string>();
  readonly natural = new Map<string, string>();
  duplicates = 0;
  conflicts = 0;

  /** Returns how the event would be appended; mutates nothing but the counters. */
  classify(e: ResearchEvent): { status: AppendStatus; conflictsWith?: string } {
    if (this.ids.has(e.event_id)) { this.duplicates++; return { status: 'DUPLICATE' }; }
    const key = e.natural_key ? `${e.source}|${e.event_type}|${e.natural_key}` : null;
    const other = key ? this.natural.get(key) : undefined;
    if (other && other !== e.event_id) { this.conflicts++; return { status: 'CONFLICT_APPENDED', conflictsWith: other }; }
    return { status: 'APPENDED' };
  }
  add(e: ResearchEvent): void {
    this.ids.add(e.event_id);
    if (e.natural_key) { const key = `${e.source}|${e.event_type}|${e.natural_key}`; if (!this.natural.has(key)) this.natural.set(key, e.event_id); }
  }
}

/** A provider re-sent an identity with different content: kept (it is what was observed) and marked CONFLICT. */
function markConflict(e: ResearchEvent, other: string): ResearchEvent {
  const status: QualityStatus = e.quality.status === 'INVALID' ? 'INVALID' : 'CONFLICT';
  return { ...e, quality: { status, issues: [...new Set([...e.quality.issues, `CONFLICTS_WITH:${other}`])].sort() } };
}

/** In-memory store with the same semantics as the file store: for tests, backtests and agents' scratch work. */
export class MemoryEventStore implements EventStore {
  private readonly events: ResearchEvent[] = [];
  private readonly byId = new Map<string, ResearchEvent>();
  private readonly index = new Index();
  constructor(private readonly clock: () => number = Date.now, private readonly factory: FactoryOptions = {}) {}

  async append(inputs: EventInput | readonly EventInput[]): Promise<AppendResult[]> {
    return this.appendEvents((Array.isArray(inputs) ? inputs : [inputs as EventInput]).map(i => makeEvent(i, this.clock(), this.factory)));
  }
  /** Adds already-built events (e.g. read from another store). Their ids are recomputed and must match. */
  appendEvents(events: readonly ResearchEvent[]): AppendResult[] {
    return events.map(raw => {
      if (eventIdOf(raw) !== raw.event_id) throw new Error(`Event id mismatch for ${raw.event_id}: content was changed`);
      const c = this.index.classify(raw);
      if (c.status === 'DUPLICATE') return { status: c.status, event: this.byId.get(raw.event_id)! };
      const e = c.conflictsWith ? markConflict(raw, c.conflictsWith) : raw;
      this.index.add(e); this.events.push(e); this.byId.set(e.event_id, e);
      return { status: c.status, event: e, ...(c.conflictsWith ? { conflictsWith: c.conflictsWith } : {}) };
    });
  }
  async query(f: EventFilter = {}): Promise<ResearchEvent[]> { return this.querySync(f); }
  querySync(f: EventFilter = {}): ResearchEvent[] {
    const out: ResearchEvent[] = [];
    for (const e of this.events) { if (matches(e, f)) { out.push(e); if (f.limit && out.length >= f.limit) break; } }
    return out;
  }
  async get(id: string): Promise<ResearchEvent | null> { return this.byId.get(id) ?? null; }
  async stats(): Promise<StoreStats> { return computeStats(this.events, this.index.duplicates, this.index.conflicts); }
  all(): readonly ResearchEvent[] { return this.events; }
}

export interface FileStoreOptions extends FactoryOptions {
  maxSegmentBytes?: number;
  clock?: () => number;
  /** Single-process tests only. */
  lock?: boolean;
}

/**
 * The durable store: one directory, hash-chained JSONL segments (see core/append-log), one writer. The dedupe index is
 * rebuilt from the files when the store is opened, so a re-import or a restart never duplicates an observation.
 */
export class FileEventStore implements EventStore {
  private readonly index = new Index();
  private count = 0;
  private constructor(readonly dir: string, private readonly log: AppendLog<ResearchEvent>, private readonly o: FileStoreOptions) {}

  static async open(dir: string, o: FileStoreOptions = {}): Promise<FileEventStore> {
    const index = new Index();
    let count = 0;
    const log = await AppendLog.open<ResearchEvent>({ dir, prefix: 'events', maxSegmentBytes: o.maxSegmentBytes, lock: o.lock },
      line => { index.add(line.data); count++; });
    const store = new FileEventStore(dir, log, o);
    for (const id of index.ids) store.index.ids.add(id);
    for (const [k, v] of index.natural) store.index.natural.set(k, v);
    store.count = count;
    return store;
  }

  get size(): number { return this.count; }
  get openIssues() { return this.log.openIssues; }

  async append(inputs: EventInput | readonly EventInput[]): Promise<AppendResult[]> {
    const clock = this.o.clock ?? Date.now;
    return this.appendEvents((Array.isArray(inputs) ? inputs : [inputs as EventInput]).map(i => makeEvent(i, clock(), this.o)));
  }

  async appendEvents(events: readonly ResearchEvent[]): Promise<AppendResult[]> {
    const results: AppendResult[] = [], fresh: ResearchEvent[] = [];
    for (const raw of events) {
      if (eventIdOf(raw) !== raw.event_id) throw new Error(`Event id mismatch for ${raw.event_id}: content was changed`);
      const c = this.index.classify(raw);
      if (c.status === 'DUPLICATE') { results.push({ status: 'DUPLICATE', event: raw }); continue; }
      const e = c.conflictsWith ? markConflict(raw, c.conflictsWith) : raw;
      this.index.add(e); fresh.push(e);
      results.push({ status: c.status, event: e, ...(c.conflictsWith ? { conflictsWith: c.conflictsWith } : {}) });
    }
    if (fresh.length) { await this.log.append(fresh); this.count += fresh.length; }
    return results;
  }

  async query(f: EventFilter = {}): Promise<ResearchEvent[]> { return queryDir(this.dir, f); }
  async get(id: string): Promise<ResearchEvent | null> {
    if (!this.index.ids.has(id)) return null;
    for await (const line of readLog<ResearchEvent>(this.dir, 'events')) if (line.data.event_id === id) return line.data;
    return null;
  }
  async stats(): Promise<StoreStats> {
    const all: ResearchEvent[] = [];
    for await (const line of readLog<ResearchEvent>(this.dir, 'events')) all.push(line.data);
    return computeStats(all, this.index.duplicates, this.index.conflicts);
  }
  verify(): Promise<StoreVerifyReport> { return verifyStore(this.dir); }
  flush(): Promise<void> { return this.log.flush(); }
  close(): Promise<void> { return this.log.close(); }
}

export async function queryDir(dir: string, f: EventFilter = {}): Promise<ResearchEvent[]> {
  const out: ResearchEvent[] = [];
  for await (const line of readLog<ResearchEvent>(dir, 'events')) {
    if (matches(line.data, f)) { out.push(line.data); if (f.limit && out.length >= f.limit) break; }
  }
  return out;
}

export interface StoreVerifyReport extends VerifyReport { idMismatches: string[] }

/** Chain integrity plus content integrity: every event id must still match its content. */
export async function verifyStore(dir: string): Promise<StoreVerifyReport> {
  const chain = await verifyLog(dir, 'events'), idMismatches: string[] = [];
  for await (const line of readLog<ResearchEvent>(dir, 'events')) if (eventIdOf(line.data) !== line.data.event_id) idMismatches.push(line.data.event_id);
  return { ...chain, ok: chain.ok && idMismatches.length === 0, idMismatches };
}

/** Read-only view over several store directories (each collector owns one; research reads all of them). */
export class MultiStoreReader implements EventReader {
  constructor(readonly dirs: readonly string[]) {}
  async query(f: EventFilter = {}): Promise<ResearchEvent[]> {
    const seen = new Set<string>(), out: ResearchEvent[] = [];
    for (const dir of this.dirs) for (const e of await queryDir(dir, { ...f, limit: undefined })) {
      if (seen.has(e.event_id)) continue;
      seen.add(e.event_id); out.push(e);
    }
    out.sort(timeOrder);
    return f.limit ? out.slice(0, f.limit) : out;
  }
  async get(id: string): Promise<ResearchEvent | null> {
    for (const dir of this.dirs) for await (const line of readLog<ResearchEvent>(dir, 'events')) if (line.data.event_id === id) return line.data;
    return null;
  }
  async stats(): Promise<StoreStats> { return computeStats(await this.query({ includeInvalid: true })); }
}

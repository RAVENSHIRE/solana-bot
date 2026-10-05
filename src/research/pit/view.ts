import { knownAt, type EventType, type KnowledgeMode, type ResearchEvent } from '../events/types';

/**
 * Point-in-time access to events.
 *
 * A `PointInTimeView` at decision time t holds only events that were known at t (under OBSERVED or AVAILABLE
 * semantics, see events/types) and that had happened by t. It cannot return anything else: there is no method that
 * reaches past t, and a request for a window that ends after t throws `LeakageError`, which turns an off-by-one into a
 * test failure instead of a silently better backtest.
 */

export class LeakageError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'LeakageError'; }
}

interface Entry { e: ResearchEvent; known: number }
const EMPTY: readonly Entry[] = Object.freeze([]);

/** Upper bound: number of entries with known ≤ t (entries sorted by known). */
function bound(list: readonly Entry[], t: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]!.known <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Events indexed by token, type and token+type, each sorted by known-at, so a view at any t is a binary search away.
 * Build one per backtest (or per dataset) and derive many views from it.
 */
export class KnowledgeIndex {
  private readonly byToken = new Map<string | null, Entry[]>();
  private readonly byType = new Map<EventType, Entry[]>();
  private readonly byTokenType = new Map<string, Entry[]>();
  private readonly all: Entry[];
  readonly excludedInvalid: number;

  /** `sorted`: the events are already in knowledge order for this mode (see knowledgeOrder), so the sort is skipped. */
  constructor(events: readonly ResearchEvent[], readonly mode: KnowledgeMode = 'AVAILABLE', o: { includeInvalid?: boolean; sorted?: boolean } = {}) {
    const usable = events.filter(e => o.includeInvalid || e.quality.status !== 'INVALID');
    this.excludedInvalid = events.length - usable.length;
    this.all = usable.map(e => ({ e, known: knownAt(e, mode) }));
    if (!o.sorted) this.all.sort((a, b) => a.known - b.known || a.e.timestamp - b.e.timestamp || (a.e.event_id < b.e.event_id ? -1 : 1));
    const push = <K>(m: Map<K, Entry[]>, k: K, x: Entry) => { const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); };
    for (const x of this.all) {
      push(this.byToken, x.e.token, x);
      push(this.byType, x.e.event_type, x);
      push(this.byTokenType, `${x.e.token}|${x.e.event_type}`, x);
    }
  }

  get size(): number { return this.all.length; }
  tokens(): Array<string | null> { return [...this.byToken.keys()]; }
  /** Latest known-at in the index (the end of the data). */
  get horizon(): number { return this.all.at(-1)?.known ?? 0; }

  at(decisionTime: number): PointInTimeView { return new PointInTimeView(this, decisionTime); }

  /** @internal Entries known by t for the narrowest matching partition. */
  entries(t: number, token: string | null | undefined, types: readonly EventType[] | undefined): Entry[] {
    const lists: Array<readonly Entry[]> = [];
    if (token !== undefined && types) for (const ty of types) lists.push(this.byTokenType.get(`${token}|${ty}`) ?? EMPTY);
    else if (token !== undefined) lists.push(this.byToken.get(token) ?? EMPTY);
    else if (types) for (const ty of types) lists.push(this.byType.get(ty) ?? EMPTY);
    else lists.push(this.all);
    const out: Entry[] = [];
    for (const l of lists) { const n = bound(l, t); for (let i = 0; i < n; i++) out.push(l[i]!); }
    return out;
  }
}

export interface ViewQuery {
  types?: readonly EventType[];
  /** A token, or null for market-wide events; omitted: every token. */
  token?: string | null;
  /** Event-time window [from, to]; `to` defaults to the decision time and may not exceed it. */
  from?: number;
  to?: number;
}

export class PointInTimeView {
  /** Events known by t whose own timestamp is after t: impossible data (clock or provider error), excluded and counted. */
  futureDated = 0;
  /** Number of queries served and the latest event time handed out, for provenance. */
  reads = 0;
  maxTimestampRead = 0;
  maxKnownRead = 0;

  constructor(private readonly index: KnowledgeIndex, readonly decisionTime: number) {
    if (!Number.isFinite(decisionTime)) throw new LeakageError('INVALID_DECISION_TIME', String(decisionTime));
  }

  get mode(): KnowledgeMode { return this.index.mode; }

  /** Events matching the query, in event-time order (ties by id): only what was known at the decision time. */
  events(q: ViewQuery = {}): ResearchEvent[] {
    const t = this.decisionTime, to = q.to ?? t;
    if (to > t) throw new LeakageError('WINDOW_PAST_DECISION', `window ends ${to - t} ms after the decision time`);
    const from = q.from ?? -Infinity;
    const out: ResearchEvent[] = [];
    for (const x of this.index.entries(t, q.token, q.types)) {
      if (x.e.timestamp > t) { this.futureDated++; continue; }
      if (x.e.timestamp < from || x.e.timestamp > to) continue;
      out.push(x.e);
      if (x.known > this.maxKnownRead) this.maxKnownRead = x.known;
      if (x.e.timestamp > this.maxTimestampRead) this.maxTimestampRead = x.e.timestamp;
    }
    this.reads++;
    return out.sort((a, b) => a.timestamp - b.timestamp || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  }

  /** Events in the trailing window [t − lookbackMs, t]. */
  window(lookbackMs: number, q: Omit<ViewQuery, 'from' | 'to'> = {}): ResearchEvent[] {
    if (!(lookbackMs >= 0)) throw new LeakageError('INVALID_LOOKBACK', String(lookbackMs));
    return this.events({ ...q, from: this.decisionTime - lookbackMs, to: this.decisionTime });
  }

  /** The most recent event (by event time) of these types, or null. */
  latest(types: readonly EventType[], token?: string | null): ResearchEvent | null {
    return this.events({ types, token }).at(-1) ?? null;
  }

  /** The earliest known event of these types, or null (e.g. the token's creation). */
  first(types: readonly EventType[], token?: string | null): ResearchEvent | null {
    return this.events({ types, token })[0] ?? null;
  }
}

/** Convenience for one-off views (tests, single decisions); use a KnowledgeIndex for many decisions. */
export function viewAt(events: readonly ResearchEvent[], decisionTime: number, mode: KnowledgeMode = 'AVAILABLE'): PointInTimeView {
  return new KnowledgeIndex(events, mode).at(decisionTime);
}

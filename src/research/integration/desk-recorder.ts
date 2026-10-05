import { makeEvent } from '../events/factory';
import { FileEventStore } from '../events/store';
import type { ResearchEvent } from '../events/types';
import type { EventInput } from '../events/types';
import { alertDeliveredEvent, alertGeneratedEvent, buildAlertEvidence, formatAlertMessage, type AlertEvidence, type AlertInput, type ChannelResult } from '../alerts/evidence';
import { tapeToInputs, type TapeRow } from '../ingest/desk-artifacts';

/**
 * What the desk engine calls. Every method is synchronous for the caller and never throws: research recording must not
 * delay or break a scan, an alert or an exit. Writes are batched in the background.
 */
export interface DeskResearchHooks {
  /** Once per new alert key. Returns the evidence and the message body to send (evidence appended unless disabled). */
  alert(input: AlertInput): { evidence: AlertEvidence | null; body: string };
  /** Per-channel delivery outcome of an alert that was sent. */
  delivered(evidence: AlertEvidence, results: readonly ChannelResult[]): void;
  /** One signal-tape row, as the engine appends it to tape-<MODE>.jsonl. */
  tape(row: Record<string, unknown>, mode: string): void;
  /** A periodic health record of the desk (scanner state, last scan, store status). */
  heartbeat(payload: Record<string, unknown>): void;
}

export interface RecorderStatus { dir: string; queued: number; written: number; duplicates: number; dropped: number; failures: number; lastError: string | null }

/**
 * Durable recorder over a FileEventStore (its own directory: one writer). Opened by src/desk/runtime.ts unless
 * DESK_RESEARCH=off; DESK_ALERT_EVIDENCE=off keeps the phone text exactly as before (the evidence is still recorded).
 */
export class DeskResearchRecorder implements DeskResearchHooks {
  private queue: EventInput[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly s: RecorderStatus;

  private constructor(private readonly store: FileEventStore, private readonly o: { enrichMessages: boolean; recordTape: boolean; clock: () => number; maxQueue: number }) {
    this.s = { dir: store.dir, queued: 0, written: 0, duplicates: 0, dropped: 0, failures: 0, lastError: null };
  }

  /**
   * `recordTape`: also record every tape row live (≈ 140 MB a day). Off by default: the desk already writes the same rows
   * to tape-<MODE>.jsonl, and importing that file later yields identical events (same ids).
   */
  static async open(dir: string, o: { enrichMessages?: boolean; recordTape?: boolean; clock?: () => number; flushMs?: number; maxQueue?: number } = {}): Promise<DeskResearchRecorder> {
    const store = await FileEventStore.open(dir);
    const r = new DeskResearchRecorder(store, { enrichMessages: o.enrichMessages ?? true, recordTape: o.recordTape ?? false, clock: o.clock ?? Date.now, maxQueue: o.maxQueue ?? 50_000 });
    r.timer = setInterval(() => void r.flush(), o.flushMs ?? 2_000);
    r.timer.unref?.();
    return r;
  }

  get status(): RecorderStatus { return { ...this.s, queued: this.queue.length }; }

  private enqueue(inputs: readonly EventInput[]): void {
    if (this.queue.length + inputs.length > this.o.maxQueue) { this.s.dropped += inputs.length; return; }
    this.queue.push(...inputs);
    if (this.queue.length >= 500) void this.flush();
  }

  alert(input: AlertInput): { evidence: AlertEvidence | null; body: string } {
    try {
      const evidence = buildAlertEvidence(input);
      this.enqueue([alertGeneratedEvent(evidence)]);
      void this.flush();
      return { evidence, body: this.o.enrichMessages ? formatAlertMessage(evidence) : input.body };
    } catch (error) {
      this.s.failures++; this.s.lastError = error instanceof Error ? error.name : 'error';
      return { evidence: null, body: input.body };
    }
  }

  delivered(evidence: AlertEvidence, results: readonly ChannelResult[]): void {
    try { this.enqueue([alertDeliveredEvent(evidence, this.o.clock(), results)]); void this.flush(); }
    catch (error) { this.s.failures++; this.s.lastError = error instanceof Error ? error.name : 'error'; }
  }

  tape(row: Record<string, unknown>, mode: string): void {
    if (!this.o.recordTape) return;
    try { this.enqueue(tapeToInputs(row as unknown as TapeRow, mode)); }
    catch (error) { this.s.failures++; this.s.lastError = error instanceof Error ? error.name : 'error'; }
  }

  heartbeat(payload: Record<string, unknown>): void {
    const at = this.o.clock();
    this.enqueue([{ event_type: 'HealthSnapshot', token: null, timestamp: at, observed_at: at, source: 'desk:health', payload: { ...payload, recorder: this.status },
      producer: { component: 'desk', version: '1' } }]);
  }

  /** Writes what is queued. Failures are counted, never thrown; a failed batch is dropped (and counted) rather than retried forever. */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.queue.length) return;
      const batch = this.queue.splice(0, this.queue.length), events: ResearchEvent[] = [];
      // Built one by one: a single malformed record is dropped (and counted), never the whole batch.
      for (const input of batch) {
        try { events.push(makeEvent(input, this.o.clock())); }
        catch (error) { this.s.dropped++; this.s.lastError = error instanceof Error ? error.message.slice(0, 120) : 'error'; }
      }
      try {
        for (const r of await this.store.appendEvents(events)) { if (r.status === 'DUPLICATE') this.s.duplicates++; else this.s.written++; }
      } catch (error) {
        this.s.failures++; this.s.dropped += events.length; this.s.lastError = error instanceof Error ? error.message.slice(0, 120) : 'error';
      }
    });
    return this.writing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    await this.store.close();
  }
}

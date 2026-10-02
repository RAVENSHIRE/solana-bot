import { quantile } from '../core/stats';
import type { EventInput } from '../events/types';

/**
 * In-process health: component heartbeats, latency distributions, error counters, gauges (queue depth, open positions,
 * store size…). `snapshot()` grades each component and gives the system verdict the risk engine uses; `snapshotEvent()`
 * persists it, so "was the system healthy at 03:12?" can be answered later from the event store.
 */

export interface ComponentSpec { name: string; expectedEveryMs: number; critical: boolean }
export type ComponentStatus = 'OK' | 'LATE' | 'DOWN' | 'NEVER_SEEN';
export interface HealthSnapshot {
  at: number;
  healthy: boolean;
  components: Array<{ name: string; status: ComponentStatus; lastBeatAt: number | null; ageMs: number | null; critical: boolean; note: string | null }>;
  latencies: Record<string, { n: number; p50: number | null; p95: number | null; max: number | null }>;
  errors: Record<string, number>;
  gauges: Record<string, number>;
  process: { rssMb: number; heapMb: number; uptimeS: number } | null;
}

export class HealthRegistry {
  private readonly specs = new Map<string, ComponentSpec>();
  private readonly beats = new Map<string, { at: number; note: string | null }>();
  private readonly lat = new Map<string, number[]>();
  private readonly errs = new Map<string, number>();
  private readonly gaugeValues = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now, private readonly reservoir = 512) {}

  register(spec: ComponentSpec): void { this.specs.set(spec.name, spec); }
  beat(name: string, note: string | null = null): void { this.beats.set(name, { at: this.clock(), note }); }
  latency(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const l = this.lat.get(name) ?? [];
    l.push(ms); if (l.length > this.reservoir) l.splice(0, l.length - this.reservoir);
    this.lat.set(name, l);
  }
  error(name: string): void { this.errs.set(name, (this.errs.get(name) ?? 0) + 1); }
  gauge(name: string, value: number): void { if (Number.isFinite(value)) this.gaugeValues.set(name, value); }

  snapshot(includeProcess = true): HealthSnapshot {
    const now = this.clock();
    const components = [...this.specs.values()].map(s => {
      const b = this.beats.get(s.name), age = b ? now - b.at : null;
      const status: ComponentStatus = !b ? 'NEVER_SEEN' : age! <= s.expectedEveryMs * 2 ? 'OK' : age! <= s.expectedEveryMs * 6 ? 'LATE' : 'DOWN';
      return { name: s.name, status, lastBeatAt: b?.at ?? null, ageMs: age, critical: s.critical, note: b?.note ?? null };
    });
    const latencies = Object.fromEntries([...this.lat].map(([k, v]) => [k, { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v.length ? Math.max(...v) : null }]));
    const mem = includeProcess ? process.memoryUsage() : null;
    return {
      at: now, healthy: components.filter(c => c.critical).every(c => c.status === 'OK' || c.status === 'LATE'),
      components, latencies, errors: Object.fromEntries(this.errs), gauges: Object.fromEntries(this.gaugeValues),
      process: mem ? { rssMb: Math.round(mem.rss / 1_048_576), heapMb: Math.round(mem.heapUsed / 1_048_576), uptimeS: Math.round(process.uptime()) } : null,
    };
  }
}

export function snapshotEvent(s: HealthSnapshot, source: string): EventInput {
  return { event_type: 'HealthSnapshot', token: null, timestamp: s.at, observed_at: s.at, source, payload: s as unknown as Record<string, unknown>,
    producer: { component: 'health', version: '1' } };
}

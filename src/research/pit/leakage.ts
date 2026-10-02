import { canonicalJson } from '../core/canonical';
import { seededRng } from '../core/random';
import { knownAt, type KnowledgeMode, type ResearchEvent } from '../events/types';
import { knowledgeOrder } from '../events/store';
import { KnowledgeIndex, LeakageError, type PointInTimeView } from './view';

/**
 * Leakage detection, at four levels:
 *
 * 1. Structure: features read through a PointInTimeView, which holds nothing after the decision time and throws on a
 *    window that reaches past it.
 * 2. Sandbox: while a feature or signal is computed, the wall clock (`Date.now()`, `new Date()`) and `Math.random()`
 *    throw. A value that depends on when or how often it is computed is not reproducible and can smuggle in the present.
 * 3. Data: `auditEvents` flags events that claim to be known before they happened, derived events known before their
 *    inputs, and bars stamped before they closed.
 * 4. Differential: any function of a wider input (a candle series, a pool object…) is computed on the full input and on
 *    the input truncated at t, and again with the future replaced by adversarial values. Any difference is look-ahead.
 */

export type ViolationKind = 'WINDOW_PAST_DECISION' | 'WALL_CLOCK' | 'RANDOMNESS' | 'NONDETERMINISM' | 'TRUNCATION_MISMATCH' |
  'FUTURE_SENSITIVITY' | 'KNOWN_BEFORE_HAPPENED' | 'DERIVED_BEFORE_INPUTS' | 'BAR_STAMPED_BEFORE_CLOSE' | 'ERROR';
export interface Violation { kind: ViolationKind; subject: string; at?: number; detail: string }
export interface LeakageReport { passed: boolean; checked: number; violations: Violation[] }

let sandboxDepth = 0;

/**
 * Runs `fn` with the wall clock and Math.random trapped. Synchronous code only: research features are pure and
 * synchronous by contract. Nested calls share one trap.
 */
export function sandboxed<T>(fn: () => T): T {
  if (sandboxDepth > 0) return fn();
  const RealDate = Date, realRandom = Math.random;
  class TrapDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) throw new LeakageError('WALL_CLOCK', 'new Date() during a point-in-time computation');
      super(...(args as [number]));
    }
    static override now(): number { throw new LeakageError('WALL_CLOCK', 'Date.now() during a point-in-time computation'); }
  }
  sandboxDepth++;
  (globalThis as { Date: DateConstructor }).Date = TrapDate as unknown as DateConstructor;
  Math.random = () => { throw new LeakageError('RANDOMNESS', 'Math.random() during a point-in-time computation'); };
  try { return fn(); }
  finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
    Math.random = realRandom;
    sandboxDepth--;
  }
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  try { return canonicalJson(a) === canonicalJson(b); } catch { return Object.is(a, b); }
};

function asViolation(error: unknown, subject: string, at: number): Violation {
  if (error instanceof LeakageError) {
    const kind = (['WINDOW_PAST_DECISION', 'WALL_CLOCK', 'RANDOMNESS'] as const).find(k => error.code === k) ?? 'ERROR';
    return { kind, subject, at, detail: error.message };
  }
  return { kind: 'ERROR', subject, at, detail: error instanceof Error ? error.message : String(error) };
}

/** Multiplies every number in a payload by a log-uniform random factor in [1/20, 20]: an adversarial "other future". */
function scaled(value: unknown, rng: () => number): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value * Math.exp((rng() * 2 - 1) * Math.log(20)) : value;
  if (Array.isArray(value)) return value.map(v => scaled(v, rng));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scaled(v, rng)]));
  return value;
}

/**
 * Checks a view-based computation (a feature, a signal) at many decision times:
 * - sandboxed, computed twice on the same view (must agree: NONDETERMINISM),
 * - recomputed on an index built only from what was known at t (must agree: TRUNCATION_MISMATCH),
 * - recomputed after the payloads of every event not yet known at t were replaced in place by adversarial values, then
 *   restored (must agree: FUTURE_SENSITIVITY). This last check also catches code that bypasses the view and reads the
 *   same event objects through a closure.
 */
export function viewLeakageTest<R>(subject: string, compute: (view: PointInTimeView) => R, events: readonly ResearchEvent[],
  decisionTimes: readonly number[], mode: KnowledgeMode = 'AVAILABLE', o: { perturbFuture?: boolean; seed?: number } = {}): LeakageReport {
  return viewLeakageCases(subject, decisionTimes.map(t => ({ t, compute })), events, mode, o);
}

/**
 * viewLeakageTest for (decision time, computation) pairs, e.g. one token per case; the full index is built once. With a
 * `token` on the case, every not-yet-known event of that token is perturbed and a random fifth of all others (enough to
 * catch reads of other tokens' futures without copying the whole dataset per case).
 */
export function viewLeakageCases<R>(subject: string, cases: ReadonlyArray<{ t: number; token?: string; compute: (view: PointInTimeView) => R }>, events: readonly ResearchEvent[],
  mode: KnowledgeMode = 'AVAILABLE', o: { perturbFuture?: boolean; seed?: number } = {}): LeakageReport {
  const ordered = events.filter(e => e.quality.status !== 'INVALID').sort(knowledgeOrder(mode)), known = ordered.map(e => knownAt(e, mode));
  const full = new KnowledgeIndex(ordered, mode, { sorted: true }), violations: Violation[] = [], rng = seededRng(o.seed ?? 11);
  const upTo = (t: number) => { let lo = 0, hi = known.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (known[m]! <= t) lo = m + 1; else hi = m; } return lo; };
  for (const { t, token, compute } of cases) {
    let a: R, b: R, c: R;
    try {
      a = sandboxed(() => compute(full.at(t)));
      b = sandboxed(() => compute(full.at(t)));
      c = sandboxed(() => compute(new KnowledgeIndex(ordered.slice(0, upTo(t)), mode, { sorted: true }).at(t)));
    } catch (error) { violations.push(asViolation(error, subject, t)); continue; }
    if (!sameValue(a, b)) violations.push({ kind: 'NONDETERMINISM', subject, at: t, detail: 'two computations on the same view differ' });
    if (!sameValue(a, c)) violations.push({ kind: 'TRUNCATION_MISMATCH', subject, at: t, detail: 'value changes when the future is removed from the data' });
    if (o.perturbFuture === false) continue;
    const future = ordered.slice(upTo(t)).filter(e => token === undefined || e.token === token || rng() < 0.2), saved = future.map(e => e.payload);
    let d: R;
    try {
      future.forEach(e => { (e as { payload: unknown }).payload = scaled(e.payload, rng); });
      d = sandboxed(() => compute(full.at(t)));
    } catch (error) { violations.push(asViolation(error, subject, t)); continue; }
    finally { future.forEach((e, i) => { (e as { payload: unknown }).payload = saved[i]; }); }
    if (!sameValue(a, d)) violations.push({ kind: 'FUTURE_SENSITIVITY', subject, at: t, detail: 'value changes when only data not yet known at t changes' });
  }
  return { passed: violations.length === 0, checked: cases.length, violations };
}

/**
 * Look-ahead test for functions that take a wider input than a view (legacy signal functions over candle series,
 * pool objects with reference observations…). For each t, f(full, t) must equal f(truncate(full, t), t), and must not
 * change when everything after t is replaced by `perturb` (adversarial future: other prices, volumes, liquidity).
 */
export function differentialLeakageTest<U, R>(subject: string, f: (input: U, t: number) => R, full: U, decisionTimes: readonly number[],
  truncate: (input: U, t: number) => U, perturb?: (input: U, t: number, rng: () => number) => U, seed = 7): LeakageReport {
  const violations: Violation[] = [], rng = seededRng(seed);
  for (const t of decisionTimes) {
    try {
      const a = sandboxed(() => f(full, t)), b = sandboxed(() => f(truncate(full, t), t));
      if (!sameValue(a, b)) { violations.push({ kind: 'TRUNCATION_MISMATCH', subject, at: t, detail: 'output differs when data after t is removed' }); continue; }
      if (perturb) {
        const c = sandboxed(() => f(perturb(full, t, rng), t));
        if (!sameValue(a, c)) violations.push({ kind: 'FUTURE_SENSITIVITY', subject, at: t, detail: 'output changes when only data after t changes' });
      }
    } catch (error) { violations.push(asViolation(error, subject, t)); }
  }
  return { passed: violations.length === 0, checked: decisionTimes.length, violations };
}

/** Data-level audit of a dataset before it is used for research. */
export function auditEvents(events: readonly ResearchEvent[], o: { clockSkewMs?: number } = {}): LeakageReport {
  const skew = o.clockSkewMs ?? 5_000, violations: Violation[] = [], byId = new Map(events.map(e => [e.event_id, e]));
  for (const e of events) {
    if (e.available_at + skew < e.timestamp || e.observed_at + skew < e.timestamp)
      violations.push({ kind: 'KNOWN_BEFORE_HAPPENED', subject: e.event_id, at: e.timestamp, detail: `${e.event_type} known ${e.timestamp - Math.min(e.available_at, e.observed_at)} ms before it happened` });
    for (const id of e.causation_ids) {
      const input = byId.get(id);
      if (input && (input.available_at > e.available_at || input.observed_at > e.observed_at))
        violations.push({ kind: 'DERIVED_BEFORE_INPUTS', subject: e.event_id, at: e.timestamp, detail: `${e.event_type} is known before its input ${id}` });
    }
    if (e.event_type === 'Candle') {
      const start = e.payload.start, interval = e.payload.interval_ms;
      if (typeof start === 'number' && typeof interval === 'number' && e.timestamp < start + interval)
        violations.push({ kind: 'BAR_STAMPED_BEFORE_CLOSE', subject: e.event_id, at: e.timestamp, detail: 'a bar is only complete at its close; stamping it earlier leaks its high, low and close' });
    }
  }
  return { passed: violations.length === 0, checked: events.length, violations };
}

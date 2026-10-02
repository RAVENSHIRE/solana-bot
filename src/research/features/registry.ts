import { deepFreeze, fingerprint, sha256Hex } from '../core/canonical';
import type { EventType } from '../events/types';
import { sandboxed } from '../pit/leakage';
import { LeakageError, type PointInTimeView } from '../pit/view';

/**
 * Versioned feature definitions. A feature is a pure, synchronous function of a point-in-time view. Its metadata says
 * what it measures and how it can go wrong; its id is `name@vN`. A registered version is frozen: registering the same
 * id with a different definition throws, so a feature cannot change silently under an existing experiment. Change a
 * feature by registering `name@v(N+1)`.
 */

export type LeakageRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FeatureContext {
  token: string;
  /** Values of the declared dependencies, already computed at the same decision time. */
  deps: Readonly<Record<string, number | null>>;
}

export interface FeatureDefinition {
  name: string;
  version: number;
  /** What it measures, precisely enough to re-implement. */
  definition: string;
  unit: string;
  /** Event types read. */
  sources: readonly EventType[];
  /** Trailing window in ms, or null when it uses everything known about the token (e.g. its creation). */
  lookbackMs: number | null;
  /** Always the decision time: the value is the knowledge state at t, never a later revision. */
  timestamp: 'DECISION_TIME';
  /** Missing inputs give null (never a default); a strategy rule on a null feature is UNKNOWN, not PASS. */
  missing: 'NULL';
  /** Values older than this are stale and give null (snapshot-type features). */
  maxStalenessMs?: number;
  dependencies: readonly string[];
  leakageRisk: LeakageRisk;
  leakageNotes: string;
  compute: (view: PointInTimeView, ctx: FeatureContext) => number | null;
}

export interface RegisteredFeature extends Readonly<FeatureDefinition> {
  id: string;
  /** Stable across machines: hash of the metadata (definition text, version, window, sources, dependencies). */
  specFingerprint: string;
  /** Hash of the compiled function text: detects a code change under an unchanged version in one runtime. */
  codeFingerprint: string;
}

export const featureId = (name: string, version: number): string => `${name}@v${version}`;

export function specOf(d: FeatureDefinition): Record<string, unknown> {
  return { name: d.name, version: d.version, definition: d.definition, unit: d.unit, sources: [...d.sources].sort(), lookbackMs: d.lookbackMs,
    timestamp: d.timestamp, missing: d.missing, maxStalenessMs: d.maxStalenessMs ?? null, dependencies: [...d.dependencies].sort(), leakageRisk: d.leakageRisk };
}

export class FeatureRegistry {
  private readonly features = new Map<string, RegisteredFeature>();

  register(def: FeatureDefinition): RegisteredFeature {
    if (!/^[a-z][a-z0-9_]*$/.test(def.name) || !Number.isInteger(def.version) || def.version < 1) throw new Error(`Invalid feature name/version: ${def.name}@${def.version}`);
    if (!def.definition.trim() || !def.leakageNotes.trim()) throw new Error(`Feature ${def.name}: definition and leakage notes are required`);
    const id = featureId(def.name, def.version);
    for (const dep of def.dependencies) if (!this.features.has(dep)) throw new Error(`Feature ${id}: unknown dependency ${dep} (register it first)`);
    const registered: RegisteredFeature = { ...def, id, specFingerprint: fingerprint(specOf(def)), codeFingerprint: sha256Hex(def.compute.toString()) };
    const existing = this.features.get(id);
    if (existing) {
      if (existing.specFingerprint !== registered.specFingerprint || existing.codeFingerprint !== registered.codeFingerprint)
        throw new Error(`FEATURE_VERSION_IMMUTABLE: ${id} is already registered with a different definition; register ${featureId(def.name, def.version + 1)}`);
      return existing;
    }
    const frozen = deepFreeze({ ...registered, sources: [...def.sources], dependencies: [...def.dependencies] });
    this.features.set(id, frozen);
    return frozen;
  }

  get(id: string): RegisteredFeature {
    const f = this.features.get(id);
    if (!f) throw new Error(`Unknown feature ${id}`);
    return f;
  }
  has(id: string): boolean { return this.features.has(id); }
  list(): RegisteredFeature[] { return [...this.features.values()].sort((a, b) => a.id.localeCompare(b.id)); }

  /** The ids with all their dependencies, dependencies first. */
  closure(ids: readonly string[]): string[] {
    const out: string[] = [], seen = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (seen.has(id)) return;
      if (path.includes(id)) throw new Error(`Feature dependency cycle: ${[...path, id].join(' → ')}`);
      for (const d of this.get(id).dependencies) visit(d, [...path, id]);
      seen.add(id); out.push(id);
    };
    for (const id of ids) visit(id, []);
    return out;
  }

  /** Spec fingerprints of the given features (and their dependencies), for experiment and run records. */
  fingerprints(ids: readonly string[]): Record<string, string> {
    return Object.fromEntries(this.closure(ids).map(id => [id, this.get(id).specFingerprint]));
  }
}

export type FeatureStatus = 'OK' | 'MISSING' | 'ERROR';
export interface FeatureVector {
  token: string;
  decisionTime: number;
  mode: PointInTimeView['mode'];
  values: Record<string, number | null>;
  status: Record<string, FeatureStatus>;
  errors: Record<string, string>;
  /** Latest event time and known-at actually read: must never exceed the decision time. */
  provenance: { maxTimestampRead: number; maxKnownRead: number; reads: number; futureDatedExcluded: number };
}

/**
 * Computes features (and their dependencies) at the view's decision time. Each computation is sandboxed: the wall clock
 * and Math.random throw. A feature that throws is recorded as ERROR with its reason and counts as missing.
 */
export function computeFeatures(registry: FeatureRegistry, ids: readonly string[], view: PointInTimeView, token: string): FeatureVector {
  const values: Record<string, number | null> = {}, status: Record<string, FeatureStatus> = {}, errors: Record<string, string> = {};
  for (const id of registry.closure(ids)) {
    const f = registry.get(id);
    const deps = Object.fromEntries(f.dependencies.map(d => [d, values[d] ?? null]));
    try {
      const v = sandboxed(() => f.compute(view, { token, deps }));
      if (v !== null && !Number.isFinite(v)) throw new Error('non-finite value');
      values[id] = v; status[id] = v === null ? 'MISSING' : 'OK';
    } catch (error) {
      values[id] = null; status[id] = 'ERROR';
      errors[id] = error instanceof LeakageError ? `LEAKAGE ${error.message}` : error instanceof Error ? error.message : String(error);
    }
  }
  if (view.maxTimestampRead > view.decisionTime || view.maxKnownRead > view.decisionTime)
    throw new LeakageError('PROVENANCE', `features read data after the decision time (${view.maxKnownRead})`);
  return { token, decisionTime: view.decisionTime, mode: view.mode, values, status, errors,
    provenance: { maxTimestampRead: view.maxTimestampRead, maxKnownRead: view.maxKnownRead, reads: view.reads, futureDatedExcluded: view.futureDated } };
}

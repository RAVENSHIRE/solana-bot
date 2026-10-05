import { deepFreeze, fingerprint } from '../core/canonical';
import type { FeatureRegistry } from '../features/registry';

/**
 * Immutable strategy versions. A strategy version is data: entry rules over versioned features, exit rules, sizing and
 * cooldown. Its fingerprint is the hash of exactly that data, so `crash_v001` means the same thing in every experiment,
 * on every machine. Changing anything means registering `crash_v002` with `parent: 'crash_v001'`: lineage is kept and
 * an existing id can never be redefined.
 */

export type Op = '<' | '<=' | '>' | '>=' | 'between';
export interface RuleCheck {
  /** A feature id, `name@vN`. */
  feature: string;
  op: Op;
  value: number | readonly [number, number];
  /** When the feature is unknown (null): FAIL (default, conservative) or PASS (the live rule's "when known"). */
  whenUnknown?: 'FAIL' | 'PASS';
  label?: string;
}

export interface ExitSpec {
  stopLossPct: number;
  /** null: no take profit (ride). */
  takeProfitPct: number | null;
  trailing: { activationPct: number; stopPct: number } | null;
  maxHoldMin: number;
}

export interface StrategySpec {
  /** `family_vNNN`, e.g. `crash_v001`. */
  id: string;
  family: string;
  description: string;
  entry: readonly RuleCheck[];
  exit: ExitSpec;
  sizing: { usd: number };
  /** No new entry in the same token for this long after an exit. */
  cooldownMin: number;
  parent: string | null;
  provenance: { source: string; commit?: string | null; notModelled?: readonly string[]; notes?: string };
}

export interface StrategyVersion extends StrategySpec {
  version: number;
  /** Feature ids the entry rules read. */
  features: readonly string[];
  /** SHA-256 of the canonical spec (provenance notes excluded: they document, they do not change behaviour). */
  fingerprint: string;
}

const ID = /^([a-z][a-z0-9_]*)_v(\d{3})$/;

export function strategyFingerprint(spec: StrategySpec): string {
  const { provenance, description: _d, ...behaviour } = spec;
  return fingerprint({ ...behaviour, provenance: { source: provenance.source, notModelled: [...(provenance.notModelled ?? [])].sort() } });
}

export class StrategyRegistry {
  private readonly versions = new Map<string, StrategyVersion>();
  constructor(private readonly features?: FeatureRegistry) {}

  register(spec: StrategySpec): StrategyVersion {
    const m = ID.exec(spec.id);
    if (!m) throw new Error(`Strategy id must look like family_v001: ${spec.id}`);
    if (m[1] !== spec.family) throw new Error(`Strategy ${spec.id}: family must be ${m[1]}`);
    validateSpec(spec);
    if (spec.parent && !this.versions.has(spec.parent)) throw new Error(`Strategy ${spec.id}: unknown parent ${spec.parent}`);
    for (const r of spec.entry) if (this.features && !this.features.has(r.feature)) throw new Error(`Strategy ${spec.id}: unknown feature ${r.feature}`);
    const version: StrategyVersion = { ...spec, version: Number(m[2]), features: [...new Set(spec.entry.map(r => r.feature))].sort(), fingerprint: strategyFingerprint(spec) };
    const existing = this.versions.get(spec.id);
    if (existing) {
      if (existing.fingerprint !== version.fingerprint) throw new Error(`STRATEGY_VERSION_IMMUTABLE: ${spec.id} exists with another definition; register a new version`);
      return existing;
    }
    const frozen = deepFreeze(structuredClone(version));
    this.versions.set(spec.id, frozen);
    return frozen;
  }

  /** A new version from a parent and a patch; the id is the next free `family_vNNN`. */
  derive(parentId: string, patch: Partial<Omit<StrategySpec, 'id' | 'family' | 'parent'>>, notes: string): StrategyVersion {
    const parent = this.get(parentId);
    const next = Math.max(...this.list().filter(v => v.family === parent.family).map(v => v.version)) + 1;
    const { version: _v, features: _f, fingerprint: _fp, ...base } = structuredClone(parent) as StrategyVersion;
    return this.register({ ...base, ...patch, id: `${parent.family}_v${String(next).padStart(3, '0')}`, parent: parentId,
      provenance: { ...base.provenance, ...(patch.provenance ?? {}), notes } });
  }

  get(id: string): StrategyVersion {
    const v = this.versions.get(id);
    if (!v) throw new Error(`Unknown strategy ${id}`);
    return v;
  }
  has(id: string): boolean { return this.versions.has(id); }
  list(): StrategyVersion[] { return [...this.versions.values()].sort((a, b) => a.id.localeCompare(b.id)); }

  /** Oldest ancestor first. */
  lineage(id: string): StrategyVersion[] {
    const out: StrategyVersion[] = [];
    for (let v: StrategyVersion | undefined = this.get(id); v; v = v.parent ? this.versions.get(v.parent) : undefined) out.unshift(v);
    return out;
  }

  /** What changed between two versions, as dotted paths. */
  diff(a: string, b: string): string[] {
    const out: string[] = [];
    const walk = (x: unknown, y: unknown, p: string) => {
      if (fingerprint(x ?? null) === fingerprint(y ?? null)) return;
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], p ? `${p}.${k}` : k);
      } else out.push(p);
    };
    const strip = (v: StrategyVersion) => ({ entry: v.entry, exit: v.exit, sizing: v.sizing, cooldownMin: v.cooldownMin });
    walk(strip(this.get(a)), strip(this.get(b)), '');
    return out;
  }
}

function validateSpec(s: StrategySpec): void {
  const bad = (why: string) => { throw new Error(`Strategy ${s.id}: ${why}`); };
  if (!s.entry.length) bad('no entry rules');
  for (const r of s.entry) {
    if (r.op === 'between') { if (!Array.isArray(r.value) || r.value.length !== 2 || !(r.value[0] <= r.value[1])) bad(`rule on ${r.feature}: between needs [low, high]`); }
    else if (typeof r.value !== 'number' || !Number.isFinite(r.value)) bad(`rule on ${r.feature}: value must be a finite number`);
  }
  const x = s.exit;
  if (!(x.stopLossPct > 0 && x.stopLossPct < 100)) bad('stop loss must be in (0, 100)');
  if (x.takeProfitPct !== null && !(x.takeProfitPct > 0)) bad('take profit must be > 0 or null');
  if (x.trailing && !(x.trailing.activationPct >= 0 && x.trailing.stopPct > 0 && x.trailing.stopPct < 100)) bad('invalid trailing stop');
  if (!(x.maxHoldMin > 0)) bad('max hold must be > 0');
  if (!(s.sizing.usd > 0)) bad('size must be > 0');
  if (!(s.cooldownMin >= 0)) bad('cooldown must be ≥ 0');
}

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export interface EntryCheck { feature: string; label: string; status: CheckStatus; actual: number | null; required: string }
export interface EntryVerdict { signal: boolean; checks: EntryCheck[]; summary: string }

const describe = (r: RuleCheck) => r.op === 'between' ? `${(r.value as readonly number[])[0]}…${(r.value as readonly number[])[1]}` : `${r.op} ${r.value}`;

/** Every rule must pass. An unknown feature fails unless the rule says PASS when unknown. */
export function evaluateEntry(v: Pick<StrategySpec, 'entry'>, values: Readonly<Record<string, number | null>>): EntryVerdict {
  const checks = v.entry.map((r): EntryCheck => {
    const actual = values[r.feature] ?? null, label = r.label ?? r.feature, required = describe(r);
    if (actual === null) return { feature: r.feature, label, actual, required, status: r.whenUnknown === 'PASS' ? 'PASS' : 'UNKNOWN' };
    const ok = r.op === 'between' ? actual >= (r.value as readonly number[])[0]! && actual <= (r.value as readonly number[])[1]!
      : r.op === '<' ? actual < (r.value as number) : r.op === '<=' ? actual <= (r.value as number) : r.op === '>' ? actual > (r.value as number) : actual >= (r.value as number);
    return { feature: r.feature, label, actual, required, status: ok ? 'PASS' : 'FAIL' };
  });
  const signal = checks.every(c => c.status === 'PASS'), miss = checks.find(c => c.status !== 'PASS');
  return { signal, checks, summary: signal ? 'all entry rules pass' : `${miss!.label} ${miss!.status === 'UNKNOWN' ? 'unknown' : `${miss!.actual} not ${miss!.required}`}` };
}

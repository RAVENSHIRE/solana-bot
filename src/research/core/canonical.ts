import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` object members dropped (as JSON does).
 * Everything that is hashed (event ids, strategy and dataset fingerprints, evidence snapshots) goes through this, so the
 * same content always yields the same id on every machine and Node version.
 *
 * Refused on purpose: NaN / ±Infinity (callers store null for "unknown"), Map / Set / class instances (no canonical form)
 * and cycles. bigint is written as its decimal string, which is how raw token amounts are stored anyway.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'bigint': return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number (store null for unknown)');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object': break;
    default: throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: cycle');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map(v => (v === undefined ? 'null' : write(v, seen))).join(',')}]`;
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects');
    const keys = Object.keys(obj).filter(k => (obj as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${write((obj as Record<string, unknown>)[k], seen)}`).join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** `prefix_` + 32 hex characters (128 bits) of the SHA-256 of the canonical content. */
export const contentId = (prefix: string, value: unknown): string => `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 32)}`;

/** Full SHA-256 of the canonical content: for fingerprints that must be compared exactly. */
export const fingerprint = (value: unknown): string => sha256Hex(canonicalJson(value));

/** Deep-freezes plain data so a registered definition cannot be mutated after it was fingerprinted. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

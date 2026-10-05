import { contentId } from '../core/canonical';
import {
  EVENT_SCHEMA, EVENT_SCHEMA_VERSION, EVENT_TYPES, QUALITY_LEVELS, isEventType,
  type EventInput, type Payload, type Quality, type QualityStatus, type ResearchEvent,
} from './types';

export class EventRejected extends Error {
  constructor(readonly code: string) { super(`Event rejected: ${code}`); this.name = 'EventRejected'; }
}

export interface FactoryOptions {
  /** Clock skew tolerated between a source timestamp and our observation (default 5 s). */
  clockSkewMs?: number;
  /** A LIVE observation older than this on arrival is flagged STALE_ON_ARRIVAL (default 5 min). */
  staleOnArrivalMs?: number;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Pseudo-tokens for market-wide reference series (BTC, SOL…) are upper-case tickers prefixed with `REF:`. */
const REFERENCE = /^REF:[A-Z0-9]{2,12}$/;
export const isTokenId = (s: string): boolean => BASE58.test(s) || REFERENCE.test(s);

const SECRET_KEY = /^(?:.*api.?key|.*private.?key|.*secret.?key|.*seed.?phrase|authorization|secret|password|bearer|signingMaterial|swapTransaction)$/i;
const KEYED_HOST = /(helius|quiknode|alchemy|triton|rpcpool|ankr|chainstack|getblock|syndica|shyft|extrnode|ironforge|ntfy|telegram\.org|birdeye)/i;
const KEYED_QUERY = /^(api[-_]?key|apikey|key|token|secret|auth|access[-_]?token|x-api-key)$/i;

/**
 * Keeps evidence links useful (a website or an X post must stay recognisable) while removing credentials: userinfo
 * always, key-like query parameters always, and the whole path for hosts that put keys or private topics in it
 * (keyed RPCs, ntfy topics, Telegram bot tokens).
 */
export function sanitizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  if (!['http:', 'https:', 'wss:', 'ws:'].includes(url.protocol)) return value;
  url.username = ''; url.password = '';
  for (const k of [...url.searchParams.keys()]) if (KEYED_QUERY.test(k)) url.searchParams.set(k, '[redacted]');
  if (KEYED_HOST.test(url.hostname)) { url.pathname = '/[redacted]'; url.search = ''; }
  return url.toString();
}

/** Copies the payload into plain JSON data: secrets redacted, URLs sanitised, bigint → string, non-finite → null (reported). */
export function sanitizePayload(value: unknown, issues: string[], at = '$', seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === 'string') return /^(https?|wss?):\/\//i.test(value) ? sanitizeUrl(value) : value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') { if (Number.isFinite(value)) return value; issues.push(`NON_FINITE_NUMBER:${at}`); return null; }
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') { issues.push(`UNSUPPORTED_VALUE:${at}`); return null; }
  if (seen.has(value)) { issues.push(`CYCLE:${at}`); return null; }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v, i) => { const s = sanitizePayload(v, issues, `${at}[${i}]`, seen); return s === undefined ? null : s; });
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (value instanceof Set) return sanitizePayload([...value], issues, at, seen);
    if (value instanceof Map) return sanitizePayload(Object.fromEntries(value), issues, at, seen);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue; }
      const s = sanitizePayload(v, issues, `${at}.${k}`, seen);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const severity = (s: QualityStatus) => QUALITY_LEVELS.indexOf(s);
export function worst(a: QualityStatus, b: QualityStatus): QualityStatus { return severity(a) >= severity(b) ? a : b; }

function checkField(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string' && value.length > 0;
    case 'string?': return value === null || value === undefined || typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'number?': return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

/**
 * Builds an immutable event: fills the times, grades quality and derives the id from content. Structurally unusable
 * input (unknown type, non-finite times) is rejected; everything else is kept and graded, because a doubtful
 * observation is still a fact about what the system saw.
 */
export function makeEvent<P extends Payload>(input: EventInput<P>, now: number, o: FactoryOptions = {}): ResearchEvent<P> {
  if (!isEventType(input.event_type)) throw new EventRejected('UNKNOWN_EVENT_TYPE');
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0) throw new EventRejected('INVALID_TIMESTAMP');
  if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 120) throw new EventRejected('INVALID_SOURCE');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new EventRejected('INVALID_PAYLOAD');
  const capture = input.capture ?? 'LIVE';
  const observed = input.observed_at ?? now;
  if (!Number.isSafeInteger(observed) || observed <= 0) throw new EventRejected('INVALID_OBSERVED_AT');
  const issues: Array<{ issue: string; status: QualityStatus }> = [...(input.quality_issues ?? [])];
  let available = input.available_at;
  if (available === undefined) {
    available = observed;
    // Conservative: data downloaded later is only "known" from the download, so it can never leak into the past.
    if (capture === 'BACKFILL') issues.push({ issue: 'AVAILABILITY_UNKNOWN', status: 'UNVERIFIED' });
  }
  if (!Number.isSafeInteger(available) || available <= 0) throw new EventRejected('INVALID_AVAILABLE_AT');

  const spec = EVENT_TYPES[input.event_type];
  const token = input.token ?? null;
  if (spec.token === 'REQUIRED' && !token) issues.push({ issue: 'TOKEN_MISSING', status: 'INVALID' });
  if (spec.token === 'NONE' && token) issues.push({ issue: 'TOKEN_NOT_EXPECTED', status: 'DEGRADED' });
  if (token && !isTokenId(token)) issues.push({ issue: 'TOKEN_NOT_A_MINT', status: 'INVALID' });

  const payloadIssues: string[] = [];
  const payload = sanitizePayload(input.payload, payloadIssues) as P;
  for (const p of payloadIssues) issues.push({ issue: p, status: 'DEGRADED' });
  for (const [field, type] of Object.entries((spec as { fields?: Record<string, string> }).fields ?? {}))
    if (!checkField((payload as Payload)[field], type)) issues.push({ issue: `PAYLOAD_FIELD:${field}`, status: 'INVALID' });
  if ((spec as { derived?: boolean }).derived && !(input.causation_ids?.length)) issues.push({ issue: 'DERIVED_WITHOUT_INPUTS', status: 'INVALID' });

  const skew = o.clockSkewMs ?? 5_000;
  if (input.timestamp > observed + skew) issues.push({ issue: 'OBSERVED_BEFORE_TIMESTAMP', status: 'DEGRADED' });
  // Knowable before it happened is impossible and would leak the future into point-in-time views.
  if (available + skew < input.timestamp) issues.push({ issue: 'AVAILABLE_BEFORE_TIMESTAMP', status: 'INVALID' });
  if (available > observed + skew) issues.push({ issue: 'AVAILABLE_AFTER_OBSERVED', status: 'DEGRADED' });
  const latency = input.timestamp_estimated ? null : observed - input.timestamp;
  if (input.timestamp_estimated) issues.push({ issue: 'TIMESTAMP_ESTIMATED', status: 'UNVERIFIED' });
  if (capture === 'LIVE' && latency !== null && latency > (o.staleOnArrivalMs ?? 300_000)) issues.push({ issue: 'STALE_ON_ARRIVAL', status: 'DEGRADED' });

  const quality: Quality = { status: issues.reduce<QualityStatus>((s, i) => worst(s, i.status), 'OK'), issues: [...new Set(issues.map(i => i.issue))].sort() };
  const natural = input.natural_key ?? null;
  const payloadVersion = input.payload_version ?? 1;
  const event_id = contentId('ev', { event_type: input.event_type, token, timestamp: input.timestamp, source: input.source, natural_key: natural, payload, payload_version: payloadVersion });
  return {
    schema: EVENT_SCHEMA, schema_version: EVENT_SCHEMA_VERSION, event_id, event_type: input.event_type, token,
    timestamp: input.timestamp, observed_at: observed, available_at: available, recorded_at: now, source: input.source,
    payload, payload_version: payloadVersion, ingestion_latency_ms: latency, quality, capture, natural_key: natural,
    correlation_id: input.correlation_id ?? null, causation_ids: [...(input.causation_ids ?? [])],
    producer: input.producer ?? { component: 'unknown', version: '0' },
  };
}

/** Recomputes an event's id from its identity fields; a stored event whose id differs was edited after it was written. */
export function eventIdOf(e: Pick<ResearchEvent, 'event_type' | 'token' | 'timestamp' | 'source' | 'natural_key' | 'payload' | 'payload_version'>): string {
  return contentId('ev', { event_type: e.event_type, token: e.token, timestamp: e.timestamp, source: e.source, natural_key: e.natural_key, payload: e.payload, payload_version: e.payload_version });
}

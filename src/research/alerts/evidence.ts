import { canonicalJson, contentId, sha256Hex } from '../core/canonical';
import { sanitizePayload } from '../events/factory';
import type { EventInput } from '../events/types';

/**
 * Every alert is a research observation. At the moment an alert is generated, an immutable evidence snapshot is built
 * from what the system knew then: what happened, why it triggered (the rule checks), the inputs with their observation
 * times, key features, market state, data quality and links. Its hash (`alert_id`) is printed in the phone message, so
 * the message can always be matched to the record, and later data can never change what the record says.
 *
 * Inputs are typed loosely on purpose: the desk passes its Candidate object (src/desk/types.ts) as it is; this module
 * has no dependency on the desk.
 */

export interface CheckLike { key?: string; label?: string; status?: string; actual?: unknown; required?: unknown; blocking?: boolean }
export interface SignalLike { signal?: boolean; summary?: string; checks?: CheckLike[] }
export interface CandidateLike {
  mint?: string; symbol?: string | null; name?: string | null; tier?: string; sources?: string[];
  pair?: { address?: string; dex?: string; url?: string; quote?: string | null };
  status?: string; reasons?: string[];
  /** Typed as `object` so the desk's interfaces (no index signature) are accepted as they are. */
  metrics?: object;
  evidence?: Array<{ key?: string; label?: string; kind?: string; value?: unknown; source?: string; at?: number | null }>;
  gates?: CheckLike[];
  crash?: SignalLike | null;
  launch?: { score?: number; reasons?: string[]; signal?: SignalLike; ca?: unknown; launchedAt?: number } | null;
  open?: { signal?: SignalLike; detail?: string; signalAt?: number } | null;
  golden?: { signal?: SignalLike; detail?: string; signalAt?: number; kind?: string } | null;
  rules?: Record<string, SignalLike>;
  holders?: { count?: number | null; top10WalletPct?: number; largestWalletPct?: number; at?: number } | null;
  social?: object;
  onchain?: object;
  riskFlags?: string[];
  firstSeenAt?: number; updatedAt?: number; deepAnalyzedAt?: number | null; observations?: number;
}

export type DeliveryDecision = 'SENT' | 'SUPPRESSED_BY_CONFIG' | 'NO_CHANNEL';
export interface AlertInput {
  key: string; kind: string; title: string; body: string;
  /** When the alert was generated (the decision time). */
  at: number;
  mode: string;
  token: string | null; symbol: string | null;
  candidate?: CandidateLike | null;
  position?: Record<string, unknown> | null;
  heldBy?: string | null;
  solUsd?: number | null;
  regime?: string | null;
  delivery: { decision: DeliveryDecision; channels: string[]; selectedKinds: string[] };
}

export interface AlertEvidence {
  schema: 'solana-research/alert-evidence'; version: 1;
  alert_id: string;
  key: string; kind: string; mode: string; token: string | null; symbol: string | null;
  generated_at: number;
  what_happened: { title: string; body: string };
  why_triggered: { summary: string | null; checks: Array<{ label: string; status: string; actual: string; required: string }> };
  what_system_knew: {
    metrics: Record<string, unknown>; gates: unknown[]; evidence: Array<Record<string, unknown>>; holders: unknown; social: unknown; onchain: unknown;
    risk_flags: string[]; position: unknown; held_by: string | null; status: string | null; reasons: string[];
  };
  when_it_knew: { decision_time: number; candidate_updated_at: number | null; first_seen_at: number | null; oldest_input_at: number | null;
    newest_input_at: number | null; max_input_age_ms: number | null; inputs: number };
  key_features: Record<string, number | string | boolean | null>;
  market_state: { sol_usd: number | null; regime: string | null };
  data_quality: { status: 'OK' | 'DEGRADED' | 'UNKNOWN'; issues: string[] };
  links: { dexscreener: string | null; solscan: string | null; fomo: string | null; pair: string | null; evidence: string };
  delivery: AlertInput['delivery'];
  /** SHA-256 of everything above (canonical JSON). */
  snapshot_hash: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? 'UNKNOWN' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The rule checks behind this kind of alert. */
function signalFor(kind: string, c: CandidateLike | null | undefined): SignalLike | null {
  if (!c) return null;
  if (kind === 'golden') return c.golden?.signal ?? null;
  if (kind === 'open') return c.open?.signal ?? null;
  if (kind === 'launch' || kind === 'radar') return c.launch?.signal ?? null;
  return c.crash ?? null;
}

const KEY_METRICS = ['marketCapUsd', 'liquidityUsd', 'volume5mUsd', 'volume1hUsd', 'priceChange5mPct', 'priceChange1hPct', 'buys5m', 'sells5m', 'buySellRatio5m',
  'top10WalletPct', 'largestWalletPct', 'developerPct', 'poolAgeMin', 'tokenAgeMin', 'firstPoolAgeMin', 'priceUsd'] as const;

export function buildAlertEvidence(i: AlertInput, o: { staleAfterMs?: number; evidenceBaseUrl?: string } = {}): AlertEvidence {
  const c = i.candidate ?? null, sig = signalFor(i.kind, c), stale = o.staleAfterMs ?? 120_000, issues: string[] = [];
  const inputs = (c?.evidence ?? []).map(e => ({ key: e.key ?? null, label: e.label ?? null, kind: e.kind ?? null, value: e.value ?? null, source: e.source ?? null,
    at: num(e.at), age_ms: num(e.at) === null ? null : i.at - (e.at as number) }));
  const times = [...inputs.map(x => x.at), num(c?.updatedAt), num(c?.holders?.at)].filter((t): t is number => t !== null && t <= i.at);
  const newest = times.length ? Math.max(...times) : null, oldest = times.length ? Math.min(...times) : null;
  if (!c) issues.push('NO_CANDIDATE_SNAPSHOT: the token was not in the scanner\'s candidate set at alert time');
  if (c?.updatedAt !== undefined && i.at - c.updatedAt > stale) issues.push(`CANDIDATE_STALE (${Math.round((i.at - c.updatedAt) / 1000)} s since its last assessment)`);
  for (const g of c?.gates ?? []) if (g.status === 'UNKNOWN') issues.push(`UNKNOWN_GATE ${g.label ?? g.key}${g.blocking ? ' (blocking)' : ''}`);
  for (const x of inputs) if (x.value === null) issues.push(`UNKNOWN_INPUT ${x.label ?? x.key}`);
  const metrics = (c?.metrics ?? {}) as Record<string, unknown>;
  const key_features: AlertEvidence['key_features'] = {};
  for (const k of KEY_METRICS) { const v = metrics[k]; key_features[k] = typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null; }
  if (c?.launch?.score !== undefined) key_features.launchScore = c.launch.score;
  const mint = i.token;
  const body: Omit<AlertEvidence, 'alert_id' | 'snapshot_hash' | 'links'> & { links: Omit<AlertEvidence['links'], 'evidence'> } = {
    schema: 'solana-research/alert-evidence', version: 1, key: i.key, kind: i.kind, mode: i.mode, token: mint, symbol: i.symbol,
    generated_at: i.at,
    what_happened: { title: i.title, body: i.body },
    why_triggered: { summary: sig?.summary ?? null, checks: (sig?.checks ?? []).map(k => ({ label: k.label ?? k.key ?? '?', status: k.status ?? '?', actual: str(k.actual), required: str(k.required) })) },
    what_system_knew: {
      metrics, gates: c?.gates ?? [], evidence: inputs, holders: c?.holders ?? null, social: c?.social ?? null, onchain: c?.onchain ?? null,
      risk_flags: c?.riskFlags ?? [], position: i.position ?? null, held_by: i.heldBy ?? null, status: c?.status ?? null, reasons: c?.reasons ?? [],
    },
    when_it_knew: { decision_time: i.at, candidate_updated_at: num(c?.updatedAt), first_seen_at: num(c?.firstSeenAt), oldest_input_at: oldest, newest_input_at: newest,
      max_input_age_ms: oldest === null ? null : i.at - oldest, inputs: inputs.length },
    key_features,
    market_state: { sol_usd: i.solUsd ?? null, regime: i.regime ?? null },
    data_quality: { status: !c ? 'UNKNOWN' : issues.length ? 'DEGRADED' : 'OK', issues },
    links: {
      dexscreener: mint ? `https://dexscreener.com/solana/${mint}` : null, solscan: mint ? `https://solscan.io/token/${mint}` : null,
      fomo: mint ? `https://fomo.family/tokens/solana/${mint}` : null, pair: c?.pair?.url ?? null,
    },
    delivery: i.delivery,
  };
  // Plain JSON only (no secrets, no class instances) before hashing: the record must hash identically when re-read.
  const clean = sanitizePayload(body, []) as typeof body;
  const alert_id = contentId('al', clean);
  const evidence = { ...clean, alert_id, links: { ...clean.links, evidence: o.evidenceBaseUrl ? `${o.evidenceBaseUrl.replace(/\/$/, '')}/alerts/${alert_id}/evidence` : `research:alert/${alert_id}` } };
  return { ...evidence, snapshot_hash: sha256Hex(canonicalJson(evidence)) } as AlertEvidence;
}

const k$ = (v: number | string | boolean | null | undefined) => (typeof v === 'number' ? (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K` : `$${v.toFixed(0)}`) : '?');

/**
 * The phone text: the original message, then one line of evidence (when the system knew it, data quality, key numbers)
 * and the evidence id. Kept short: ntfy and Telegram notifications show a few lines.
 */
export function formatAlertMessage(e: AlertEvidence): string {
  const f = e.key_features, knew = new Date(e.when_it_knew.newest_input_at ?? e.generated_at).toISOString().slice(11, 19);
  const age = e.when_it_knew.max_input_age_ms === null ? '' : ` · oldest input ${Math.round(e.when_it_knew.max_input_age_ms / 1000)}s`;
  const q = e.data_quality.status === 'OK' ? 'data OK' : `data ${e.data_quality.status}${e.data_quality.issues.length ? ` (${e.data_quality.issues.length})` : ''}`;
  const nums = [`mcap ${k$(f.marketCapUsd)}`, `liq ${k$(f.liquidityUsd)}`, `v5m ${k$(f.volume5mUsd)}`,
    typeof f.priceChange5mPct === 'number' ? `5m ${f.priceChange5mPct >= 0 ? '+' : ''}${f.priceChange5mPct.toFixed(0)}%` : null].filter(Boolean).join(' · ');
  return `${e.what_happened.body}\nknew ${knew}Z${age} · ${q}\n${nums}\nevidence ${e.alert_id}`;
}

/** The immutable AlertGenerated event (the evidence is its payload). */
export function alertGeneratedEvent(e: AlertEvidence, producer = { component: 'desk', version: '1' }): EventInput {
  return { event_type: 'AlertGenerated', token: e.token, timestamp: e.generated_at, observed_at: e.generated_at, source: `desk:alerts:${e.mode}`,
    payload: e as unknown as Record<string, unknown>, natural_key: e.alert_id, correlation_id: e.alert_id, producer };
}

export interface ChannelResult { channel: string; ok: boolean; status: number | null; error: string | null }
export function alertDeliveredEvent(e: AlertEvidence, at: number, results: readonly ChannelResult[], producer = { component: 'desk', version: '1' }): EventInput {
  const status = !results.length ? 'NO_CHANNEL' : results.every(r => r.ok) ? 'DELIVERED' : results.some(r => r.ok) ? 'PARTIAL' : 'FAILED';
  return { event_type: 'AlertDelivered', token: e.token, timestamp: at, observed_at: at, source: `desk:alerts:${e.mode}`,
    payload: { alert_id: e.alert_id, status, results: results.map(r => ({ ...r })), latency_ms: at - e.generated_at }, natural_key: `${e.alert_id}:delivery`,
    correlation_id: e.alert_id, producer };
}

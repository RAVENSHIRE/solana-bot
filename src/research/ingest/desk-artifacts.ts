import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { EventInput, EventType } from '../events/types';

/**
 * Converts what the desk already writes (data-desk/) into research events, offline and read-only:
 *
 *   events-<MODE>.log.jsonl (+ rotated)  → PipelineStage / ScanDecision / ExecutionAttempt / ExecutionResult
 *   tape-<MODE>.jsonl (+ rotated)        → MarketSnapshot + SignalEvaluated (what CRASH saw, scan by scan)
 *   ledger-*.json (+ cycles, archives)   → ExecutionResult per ledger row
 *
 * Re-running the import never duplicates anything (event ids are content hashes, natural keys detect conflicts).
 */

const PRODUCER = { component: 'ingest:desk', version: '1' };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SCANNER = new Set(['SCANNING', 'FILTERED', 'WATCHLIST', 'WAITING', 'QUALIFIED']);
const ATTEMPT = new Set(['QUOTE', 'ROUTE', 'SIMULATION', 'PREFLIGHT', 'AWAITING_SIGNATURE', 'SUBMITTED']);
const RESULT = new Set(['CONFIRMED', 'FAILED']);

export interface DeskEventRow { id: number; at: number; mode: string; stage: string; mint: string | null; symbol: string | null; message: string; detail?: Record<string, unknown> }

export function deskEventToInput(r: DeskEventRow): EventInput | null {
  if (!Number.isSafeInteger(r.at) || typeof r.stage !== 'string') return null;
  const token = r.mint && BASE58.test(r.mint) ? r.mint : null;
  const type: EventType = token && SCANNER.has(r.stage) ? 'ScanDecision' : token && ATTEMPT.has(r.stage) ? 'ExecutionAttempt' : token && RESULT.has(r.stage) ? 'ExecutionResult' : 'PipelineStage';
  return { event_type: type, token, timestamp: r.at, observed_at: r.at, source: `desk:events:${r.mode}`, capture: 'IMPORT',
    payload: { stage: r.stage, message: r.message, symbol: r.symbol, mode: r.mode, desk_event_id: r.id, detail: r.detail ?? null },
    natural_key: `${r.mode}:${r.id}:${r.at}`, producer: PRODUCER };
}

export interface TapeRow {
  at: number; mint: string; symbol?: string | null; pool?: string; dex?: string; priceUsd?: number | null; marketCapUsd?: number | null; liquidityUsd?: number | null;
  poolAgeMin?: number | null; volume5mUsd?: number | null; volume1hUsd?: number | null; buys5m?: number | null; sells5m?: number | null;
  priceChange5mPct?: number | null; priceChange1hPct?: number | null; top10WalletPct?: number | null; largestWalletPct?: number | null;
  signal?: boolean; summary?: string | null; held?: string | null; blockedBy?: string;
}

/**
 * One tape row is what the scanner had for a pumping young pool at scan time `at`. The providers' own observation
 * times were not recorded, so the timestamp is the scan time (TIMESTAMP_ESTIMATED).
 */
export function tapeToInputs(r: TapeRow, mode: string): EventInput[] {
  if (!Number.isSafeInteger(r.at) || !BASE58.test(r.mint ?? '')) return [];
  const key = `tape:${mode}:${r.at}:${r.mint}`;
  const snapshot: EventInput = { event_type: 'MarketSnapshot', token: r.mint, timestamp: r.at, observed_at: r.at, source: `desk:tape:${mode}`, timestamp_estimated: true,
    payload: { price_usd: r.priceUsd ?? null, market_cap_usd: r.marketCapUsd ?? null, liquidity_usd: r.liquidityUsd ?? null, volume_5m_usd: r.volume5mUsd ?? null,
      volume_1h_usd: r.volume1hUsd ?? null, buys_5m: r.buys5m ?? null, sells_5m: r.sells5m ?? null, price_change_5m_pct: r.priceChange5mPct ?? null,
      price_change_1h_pct: r.priceChange1hPct ?? null, top10_pct: r.top10WalletPct ?? null, largest_wallet_pct: r.largestWalletPct ?? null,
      pool: r.pool ?? null, dex: r.dex ?? null, symbol: r.symbol ?? null,
      pool_created_at: typeof r.poolAgeMin === 'number' ? Math.round(r.at - r.poolAgeMin * 60_000) : null },
    natural_key: key, producer: PRODUCER };
  const signal: EventInput = { event_type: 'SignalEvaluated', token: r.mint, timestamp: r.at, observed_at: r.at, source: `desk:tape:${mode}`,
    payload: { strategy: 'CRASH', signal: r.signal === true, summary: r.summary ?? null, held: r.held ?? null, blocked_by: r.blockedBy ?? null, mode },
    natural_key: `${key}:signal`, producer: PRODUCER };
  return [snapshot, signal];
}

const LEDGER = /^ledger-(PAPER|LIVE)(?:-([A-Z][A-Z0-9_]*))?(?:-([1-9A-HJ-NP-Za-km-z]{32,44}))?(?:\.(cycle|archived)-[^.]+)?\.json$/;
export function ledgerStrategy(file: string): { mode: string; strategy: string; wallet: string | null; kind: 'current' | 'cycle' | 'archived' } | null {
  const m = LEDGER.exec(path.basename(file));
  return m ? { mode: m[1]!, strategy: m[2] ?? 'FAIR', wallet: m[3] ?? null, kind: (m[4] as 'cycle' | 'archived' | undefined) ?? 'current' } : null;
}

export interface LedgerRow { id: string; at: number; mint: string; symbol: string | null; side: string; status: string; txSignature: string | null; [k: string]: unknown }
export function ledgerToInputs(rows: readonly LedgerRow[], meta: { mode: string; strategy: string; wallet: string | null }): EventInput[] {
  return rows.filter(r => Number.isSafeInteger(r.at) && BASE58.test(r.mint)).map(r => ({
    event_type: 'ExecutionResult' as const, token: r.mint, timestamp: r.at, observed_at: r.at, source: `desk:ledger:${meta.mode}`, capture: 'IMPORT' as const,
    payload: { ...r, strategy: meta.strategy, mode: meta.mode, wallet: meta.wallet }, natural_key: `${meta.mode}:${meta.strategy}:${r.id}`, producer: PRODUCER,
  }));
}

/** Lines of a JSONL file (plain or gzipped); unparseable lines are counted, never guessed. */
export async function readJsonl<T>(file: string): Promise<{ rows: T[]; bad: number }> {
  const raw = await fs.readFile(file);
  const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const rows: T[] = []; let bad = 0;
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line) as T); } catch { bad++; } }
  return { rows, bad };
}

export interface DeskImportReport { files: string[]; inputs: number; badLines: number }

/** Every desk artifact in a data directory, converted. Rotated files (`.1`, `.<timestamp>`) are included. */
export async function deskArtifactInputs(dir: string): Promise<{ inputs: EventInput[]; report: DeskImportReport }> {
  const names = await fs.readdir(dir).catch(() => [] as string[]), inputs: EventInput[] = [], report: DeskImportReport = { files: [], inputs: 0, badLines: 0 };
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const ev = /^events-(PAPER|LIVE)\.log\.jsonl(\..+)?$/.exec(name), tape = /^tape-(PAPER|LIVE)\.jsonl(\..+)?$/.exec(name), ledger = ledgerStrategy(name);
    if (ev) {
      const { rows, bad } = await readJsonl<DeskEventRow>(file);
      for (const r of rows) { const i = deskEventToInput(r); if (i) inputs.push(i); }
      report.badLines += bad; report.files.push(name);
    } else if (tape) {
      const { rows, bad } = await readJsonl<TapeRow>(file);
      for (const r of rows) inputs.push(...tapeToInputs(r, tape[1]!));
      report.badLines += bad; report.files.push(name);
    } else if (ledger) {
      try {
        const state = JSON.parse(await fs.readFile(file, 'utf8')) as { entries?: LedgerRow[] };
        inputs.push(...ledgerToInputs(state.entries ?? [], ledger)); report.files.push(name);
      } catch { report.badLines++; }
    }
  }
  report.inputs = inputs.length;
  return { inputs, report };
}

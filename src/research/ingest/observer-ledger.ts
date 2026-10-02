import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { EventInput } from '../events/types';

/**
 * Converts the research observer's compact ledger (data-desk/research/ev-YYYYMMDD-HH.jsonl[.gz], see docs/RESEARCH.md)
 * into canonical events. The observer is the edge collector (small files on a nearly full disk); the canonical store is
 * for research workers. Import a window, not everything: ~80 trades/s become ~7 M events a day.
 *
 *   PC / C → TokenCreated (+ CreatorBuy for the dev buy)   T → Buy / Sell / CreatorBuy / CreatorSell
 *   K → Candle (curve market cap → USD) + CurveProgress     X / G → Graduation      META → SocialLinkDiscovered
 *   XP → (profile facts on SocialLinkDiscovered x)          XT → XPost / XContractAddressPost   S → WebsiteActivity
 *   GAP → DataQualityIssue
 *
 * Amounts are in SOL on the curve. USD needs the SOL price at the time of the record: from `solUsd(ts)` (e.g. the
 * REF:SOL series), else the trade keeps `amount_sol` only and USD-based features stay null for it.
 */

const PRODUCER = { component: 'ingest:observer', version: '1' };
const PUMP_SUPPLY = 1_000_000_000;
const CURVE_TOKENS_RAW = 793_100_000_000_000;

export interface ObserverImportOptions {
  from?: number; to?: number;
  tokens?: ReadonlySet<string>;
  /** SOL/USD at a time (ms); null when unknown. */
  solUsd?: (ts: number) => number | null;
  /** An X post counts as known this long after its post time (the observer's own rule: 30 s). */
  xPostLatencyMs?: number;
}
export interface ObserverImportReport { files: number; records: number; inputs: number; skipped: number; byTag: Record<string, number> }

export function observerFiles(names: readonly string[]): string[] { return names.filter(f => /^ev-\d{8}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort(); }

export async function observerInputs(dir: string, o: ObserverImportOptions = {}): Promise<{ inputs: EventInput[]; report: ObserverImportReport }> {
  const report: ObserverImportReport = { files: 0, records: 0, inputs: 0, skipped: 0, byTag: {} }, inputs: EventInput[] = [];
  const creators = new Map<string, string>();
  for (const name of observerFiles(await fs.readdir(dir).catch(() => [] as string[]))) {
    const raw = await fs.readFile(path.join(dir, name));
    const text = name.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    report.files++;
    const mints: string[] = [], wallets: string[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: unknown[];
      try { r = JSON.parse(line) as unknown[]; } catch { report.skipped++; continue; }
      const tag = String(r[0]);
      if (tag === 'M') { mints[r[1] as number] = r[2] as string; continue; }
      if (tag === 'W') { wallets[r[1] as number] = r[2] as string; continue; }
      report.records++; report.byTag[tag] = (report.byTag[tag] ?? 0) + 1;
      const out = convert(tag, r, mints, wallets, creators, o);
      if (!out) { report.skipped++; continue; }
      for (const i of out) {
        if (o.from !== undefined && i.observed_at! < o.from) continue;
        if (o.to !== undefined && i.observed_at! > o.to) continue;
        if (o.tokens && i.token && !o.tokens.has(i.token)) continue;
        inputs.push(i);
      }
    }
  }
  report.inputs = inputs.length;
  return { inputs, report };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function convert(tag: string, r: unknown[], mints: string[], wallets: string[], creators: Map<string, string>, o: ObserverImportOptions): EventInput[] | null {
  const mint = (i: unknown) => (typeof i === 'number' ? mints[i] ?? null : null), wallet = (i: unknown) => (typeof i === 'number' ? wallets[i] ?? null : null);
  const base = (type: EventInput['event_type'], token: string | null, ts: number, obs: number, payload: Record<string, unknown>, key: string): EventInput =>
    ({ event_type: type, token, timestamp: ts, observed_at: obs, source: `observer:${tag}`, payload, natural_key: key, producer: PRODUCER });
  const usd = (sol: number | null, ts: number) => { const p = o.solUsd?.(ts) ?? null; return sol === null || p === null ? null : sol * p; };
  switch (tag) {
    case 'PC': {
      const m = mint(r[2]), obs = num(r[1]); if (!m || obs === null) return null;
      const creator = wallet(r[3]); if (creator) creators.set(m, creator);
      const out = [base('TokenCreated', m, obs, obs, { creator, name: s(r[5]), symbol: s(r[6]), uri: s(r[7]), launchpad: 'pump.fun', market_cap_sol: num(r[10]), mayhem: r[11] === 1 }, `pc:${m}`)];
      const dev = num(r[8]);
      if (creator && dev && dev > 0) out.push(base('CreatorBuy', m, obs, obs, { wallet: creator, amount_sol: dev, amount_usd: usd(dev, obs), token_amount: num(r[9]), dev_buy: true }, `devbuy:${m}`));
      return out;
    }
    case 'C': {
      const m = mint(r[4]), obs = num(r[1]), ts = num(r[2]); if (!m || obs === null) return null;
      const creator = wallet(r[6]) ?? wallet(r[5]); if (creator) creators.set(m, creator);
      return [base('TokenCreated', m, ts !== null ? ts * 1000 : obs, obs, { creator, name: s(r[8]), symbol: s(r[9]), uri: s(r[10]), launchpad: 'pump.fun', slot: num(r[3]) }, `c:${m}`)];
    }
    case 'T': {
      const m = mint(r[4]), obs = num(r[1]), ts = num(r[2]), w = wallet(r[5]); if (!m || obs === null || ts === null || !w) return null;
      const buy = r[6] === 1, sol = num(r[7]) === null ? null : num(r[7])! / 1e9, creator = creators.get(m) === w;
      const vSol = num(r[9]), vTok = num(r[10]), realTok = num(r[11]);
      const mcapSol = vSol !== null && vTok !== null && vTok > 0 ? (vSol / 1e9) / (vTok / 1e6) * PUMP_SUPPLY : null;
      return [base(buy ? (creator ? 'CreatorBuy' : 'Buy') : (creator ? 'CreatorSell' : 'Sell'), m, ts * 1000, obs,
        { wallet: w, amount_sol: sol, amount_usd: usd(sol, ts * 1000), token_amount: num(r[8]), slot: num(r[3]), market_cap_sol: mcapSol,
          progress_pct: realTok === null ? null : Math.max(0, Math.min(1, 1 - realTok / CURVE_TOKENS_RAW)) * 100, sig: s(r[12]) },
        `t:${s(r[12]) ?? `${m}:${ts}:${w}`}:${num(r[3])}:${r[7]}`)];
    }
    case 'K': {
      const minute = num(r[1]), m = mint(r[2]); if (!m || minute === null) return null;
      const start = minute * 1000, close = start + 60_000, sol = o.solUsd?.(close) ?? null;
      const [op, hi, lo, cl] = [num(r[3]), num(r[4]), num(r[5]), num(r[6])];
      const out: EventInput[] = [];
      const progress = num(r[13]);
      // The observer writes curve progress as a fraction (0–1).
      if (progress !== null) out.push(base('CurveProgress', m, close, close, { progress_pct: progress * 100, market_cap_sol: cl }, `kp:${m}:${minute}`));
      if (sol !== null && op && hi && lo && cl) {
        const px = (mc: number) => mc * sol / PUMP_SUPPLY;
        const buyUsd = num(r[7]) === null ? 0 : num(r[7])! / 1e9 * sol, sellUsd = num(r[8]) === null ? 0 : num(r[8])! / 1e9 * sol;
        out.push(base('Candle', m, close, close, { interval_ms: 60_000, start, o: px(op), h: px(hi), l: px(lo), c: px(cl), v: buyUsd + sellUsd, supply: PUMP_SUPPLY,
          buys: num(r[9]), sells: num(r[10]), unique_buyers: num(r[11]), first_time_buyers: num(r[12]), venue: 'curve' }, `k:${m}:${minute}`));
      }
      return out.length ? out : null;
    }
    case 'X': { const m = mint(r[3]), obs = num(r[1]), ts = num(r[2]); return m && obs !== null ? [base('Graduation', m, ts !== null ? ts * 1000 : obs, obs, { kind: 'curve-complete' }, `x:${m}`)] : null; }
    case 'G': { const m = mint(r[2]), obs = num(r[1]); return m && obs !== null ? [base('Graduation', m, obs, obs, { kind: 'migrated', pool: s(r[4]) }, `g:${m}`)] : null; }
    case 'META': {
      const m = mint(r[2]), obs = num(r[1]), meta = r[3] as Record<string, unknown> | null;
      if (!m || obs === null || !meta || 'error' in meta) return null;
      // The metadata is an immutable document named in the creation transaction: its links are facts from creation.
      const links: Array<[string, unknown]> = [['x', meta.tw], ['website', meta.web], ['telegram', meta.tg]];
      return links.filter(([, u]) => typeof u === 'string' && u).map(([kind, url]) =>
        base('SocialLinkDiscovered', m, obs, obs, { kind, url, description: s(meta.desc), source_doc: 'launch-metadata' }, `meta:${m}:${kind}`));
    }
    case 'XP': {
      const m = mint(r[2]), obs = num(r[1]), x = r[4] as Record<string, unknown> | null;
      if (!m || obs === null || !x) return null;
      return [base('SocialLinkDiscovered', m, obs, obs, { kind: 'x-profile', url: `https://x.com/${String(r[3])}`, status: s(x.st), followers: num(x.f), following: num(x.fg),
        posts: num(x.n), joined_at: num(x.j), verified: x.v === 1 || x.v === true, website: s(x.web) }, `xp:${m}:${obs}`)];
    }
    case 'XT': {
      const m = mint(r[2]), obs = num(r[1]), at = num(r[5]), x = r[6] as Record<string, unknown> | null;
      if (!m || obs === null || at === null || !x) return null;
      const handle = String(r[3]), own = typeof x.a === 'string' ? x.a.toLowerCase() === handle.toLowerCase() : null;
      // Known when a poller would have seen it (post time + latency), never before; and never before we fetched it live.
      return [{ ...base(x.mint === 1 ? 'XContractAddressPost' : 'XPost', m, at, obs, { author: s(x.a) ?? handle, handle, own_account: own, post_id: String(r[4]),
        views: num(x.v), likes: num(x.l), reposts: num(x.rp), replies: num(x.c), is_repost: x.rt === 1, other_ca: s(x.ca) }, `xt:${String(r[4])}`),
        available_at: Math.min(obs, at + (o.xPostLatencyMs ?? 30_000)) }];
    }
    case 'S': {
      const m = mint(r[2]), obs = num(r[1]), x = r[3] as Record<string, unknown> | null;
      if (!m || obs === null || !x) return null;
      return [base('WebsiteActivity', m, obs, obs, { url: s(x.u), status: s(x.st), http: num(x.h), title: s(x.ti), ca_verdict: s(x.v), other_address: s(x.o) }, `s:${m}:${obs}`)];
    }
    case 'GAP': {
      const obs = num(r[1]); if (obs === null) return null;
      return [base('DataQualityIssue', null, obs, obs, { issue: 'FEED_GAP', source: String(r[2]), detail: String(r[3]) }, `gap:${obs}:${String(r[2])}`)];
    }
    default: return null;
  }
}

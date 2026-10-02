import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseXLink } from '../desk/social';
import { projectSite } from '../desk/launches';
import { curveMcapSol, curveProgress } from './pump-events';

/**
 * Reads the research ledger back into per-launch facts and computes, for each decision time, the features a trader
 * could have known then (point in time) and the outcomes that followed (labels). See docs/RESEARCH.md.
 *
 * Point-in-time rules:
 *   - trades and curve state: observed at or before creation + T
 *   - metadata (an immutable IPFS document named in the creation transaction): known from creation
 *   - an X post: known 30 s after its post time (a reader polling the account would see it), never before
 *   - X account facts (followers, join date): as first read, which is after T for early decision times (flagged)
 *   - the creator's history: only earlier launches by the same wallet whose outcome was known by creation + T
 */
export const DECISION_S = [60, 120, 300, 600] as const;
export const HORIZONS_MIN = [5, 15, 60, 360] as const;
export const X_POST_LATENCY_MS = 30_000;
/** A standard pump.fun curve starts at 30 SOL / 1,073,000,000 tokens (≈ 27.96 SOL market cap) and never trades below it. */
export const NORMAL_CURVE_FLOOR_SOL = 27.5;
const MULTIPLES = [2, 5, 10] as const;

interface Trade { obs: number; ts: number; slot: number; w: number; buy: boolean; lamports: number; vSol: number; vTok: number; realTok: number }
interface Candle { m: number; h: number; l: number; c: number }
export interface LaunchFacts {
  mint: string; createdObs: number; createdTs: number | null; creator: string | null; creatorW: number | null; devBuySol: number | null; name: string | null; symbol: string | null; mayhem: boolean;
  trades: Trade[]; candles: Candle[]; completeObs: number | null; migrateObs: number | null;
  meta: { tw: string | null; web: string | null; tg: string | null; desc: string | null } | null; metaError: boolean;
  xReads: Array<{ obs: number; st: string; followers: number | null; joined: number | null; statuses: number | null }>;
  xPosts: Array<{ obs: number; at: number; mint: boolean; author: string | null; views: number | null }>;
  sites: Array<{ obs: number; verdict: string | null }>;
}
export interface Gap { obs: number; source: string; detail: string }
/** The observer's runs: when each started and how many trade feeds it merged (one feed down is covered by another). */
export interface Run { start: number; sources: number }
export interface Dataset { launches: Map<string, LaunchFacts>; gaps: Gap[]; runs: Run[]; first: number; last: number; files: number; wallets: number }

/** Ledger files in time order (gzipped or the open hour). */
export function ledgerFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => /^ev-\d{8}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort().map(f => path.join(dir, f));
}

export function readDataset(files: string[], o: { from?: number; to?: number } = {}): Dataset {
  const launches = new Map<string, LaunchFacts>(), gaps: Gap[] = [], runs: Run[] = [], walletIds = new Map<string, number>();
  let first = Infinity, last = 0;
  const launch = (mint: string, obs: number): LaunchFacts => {
    let l = launches.get(mint);
    if (!l) {
      l = { mint, createdObs: obs, createdTs: null, creator: null, creatorW: null, devBuySol: null, name: null, symbol: null, mayhem: false, trades: [], candles: [], completeObs: null, migrateObs: null,
        meta: null, metaError: false, xReads: [], xPosts: [], sites: [] };
      launches.set(mint, l);
    }
    return l;
  };
  for (const file of files) {
    const raw = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const mints: string[] = [], wallets: string[] = [];
    const intern = (w: string) => { let g = walletIds.get(w); if (g === undefined) { g = walletIds.size; walletIds.set(w, g); } return g; };
    const gid = (i: number) => intern(wallets[i]!);
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: unknown[];
      try { r = JSON.parse(line) as unknown[]; } catch { continue; }
      const tag = r[0];
      if (tag === 'M') { mints[r[1] as number] = r[2] as string; continue; }
      if (tag === 'W') { wallets[r[1] as number] = r[2] as string; continue; }
      // A candle's field 1 is its minute (unix minutes); it is complete, i.e. known, when the minute ends.
      const obs = tag === 'K' ? (r[1] as number) * 60_000 + 60_000 : r[1] as number;
      if (typeof obs !== 'number') continue;
      if ((o.from !== undefined && obs < o.from) || (o.to !== undefined && obs > o.to)) continue;
      if (tag !== 'STAT') { first = Math.min(first, obs); last = Math.max(last, obs); }
      const mintOf = (i: unknown) => typeof i === 'number' ? mints[i] ?? null : null;
      switch (tag) {
        case 'PC': {
          const mint = mintOf(r[2]); if (!mint) break;
          const l = launch(mint, obs);
          l.createdObs = Math.min(l.createdObs, obs);
          l.creator ??= typeof r[3] === 'number' ? wallets[r[3]] ?? null : null;
          if (l.creator) l.creatorW = intern(l.creator);
          l.name ??= r[5] as string; l.symbol ??= r[6] as string; l.devBuySol = r[8] as number; l.mayhem = r[11] === 1;
          break;
        }
        case 'C': {
          const mint = mintOf(r[4]); if (!mint) break;
          const l = launch(mint, obs);
          l.createdObs = Math.min(l.createdObs, obs); l.createdTs = typeof r[2] === 'number' ? (r[2] as number) * 1000 : l.createdTs;
          const creator = typeof r[6] === 'number' ? wallets[r[6]] : typeof r[5] === 'number' ? wallets[r[5]] : null;
          l.creator ??= creator ?? null; l.name ??= r[8] as string; l.symbol ??= r[9] as string;
          if (l.creator) l.creatorW = intern(l.creator);
          break;
        }
        case 'T': {
          const mint = mintOf(r[4]), l = mint ? launches.get(mint) : undefined;
          if (!l || typeof r[5] !== 'number') break;
          l.trades.push({ obs, ts: r[2] as number, slot: (r[3] as number) ?? 0, w: gid(r[5]), buy: r[6] === 1, lamports: r[7] as number, vSol: r[9] as number, vTok: r[10] as number, realTok: r[11] as number });
          break;
        }
        case 'K': {
          const l = launches.get(mintOf(r[2]) ?? '');
          if (l) l.candles.push({ m: (r[1] as number) * 60_000, h: r[4] as number, l: r[5] as number, c: r[6] as number });
          break;
        }
        case 'X': { const l = launches.get(mintOf(r[3]) ?? ''); if (l) l.completeObs ??= obs; break; }
        case 'G': { const l = launches.get(mintOf(r[2]) ?? ''); if (l) { l.migrateObs ??= obs; l.completeObs ??= obs; } break; }
        case 'META': {
          const l = launches.get(mintOf(r[2]) ?? ''), m = r[3] as Record<string, string | null> | null;
          if (!l || !m) break;
          if ('error' in m) l.metaError = true; else l.meta = { tw: m.tw ?? null, web: m.web ?? null, tg: m.tg ?? null, desc: m.desc ?? null };
          break;
        }
        case 'XP': {
          const l = launches.get(mintOf(r[2]) ?? ''), x = r[4] as Record<string, unknown> | null;
          if (l && x) l.xReads.push({ obs, st: String(x.st), followers: (x.f as number | null) ?? null, joined: (x.j as number | null) ?? null, statuses: (x.n as number | null) ?? null });
          break;
        }
        case 'XT': {
          const l = launches.get(mintOf(r[2]) ?? ''), x = r[6] as Record<string, unknown> | null;
          if (l && x) l.xPosts.push({ obs, at: r[5] as number, mint: x.mint === 1, author: (x.a as string | null) ?? null, views: (x.v as number | null) ?? null });
          break;
        }
        case 'S': {
          const l = launches.get(mintOf(r[2]) ?? ''), x = r[3] as Record<string, unknown> | null;
          if (l && x) l.sites.push({ obs, verdict: (x.v as string | null) ?? null });
          break;
        }
        case 'GAP': gaps.push({ obs, source: String(r[2]), detail: String(r[3]) }); break;
        case 'START': runs.push({ start: obs, sources: Number((r[2] as { sources?: number } | null)?.sources ?? 1) }); break;
        default: break;
      }
    }
  }
  for (const l of launches.values()) {
    l.trades.sort((a, b) => a.slot - b.slot || a.obs - b.obs);
    l.candles.sort((a, b) => a.m - b.m);
    // A normal curve never trades below its starting market cap (~27.96 SOL); one that does is a mayhem-mode or other
    // non-standard curve even when PumpPortal's creation message (with the flag) was missed.
    if (!l.mayhem && l.trades.some(t => curveMcapSol(t.vSol, t.vTok) < NORMAL_CURVE_FLOOR_SOL)) l.mayhem = true;
  }
  return { launches, gaps, runs, first: Number.isFinite(first) ? first : 0, last, files: files.length, wallets: walletIds.size };
}

// ------------------------------------------------------------------ features

export interface Features {
  t: number; mcapSol: number | null; progress: number | null; trades: number;
  velocity30: number | null; velocity60: number | null; acceleration: number | null;
  buyers: number; newBuyers30: number; newBuyersPrev30: number; buyerAcceleration: number | null;
  buySol: number; sellSol: number; netSol: number; sellShare: number | null;
  hhi: number | null; top1: number | null; top5: number | null; effectiveBuyers: number | null;
  devBuySol: number | null; devSold: boolean | null;
  hasX: boolean | null; hasSite: boolean | null; hasTelegram: boolean | null; descLen: number | null; metadataLinks: number | null;
  xCaPost: boolean | null; xCaPostDelayS: number | null; xFollowers: number | null; xAccountAgeH: number | null;
  creatorLaunches: number; creatorGraduations: number;
  /** A logs-feed disconnect inside [creation, creation + t]: the trades in it may be incomplete. */
  gapInWindow: boolean;
  /** Trades whose reported curve state does not follow from the previous one (missing trades), up to t. */
  chainBreaks: number;
  /**
   * pump.fun "mayhem mode" (PumpPortal flag) or any curve that traded below a standard curve's start: its price does
   * not follow the trades alone, so chain breaks are expected and its multiples are not comparable.
   */
  mayhem: boolean;
}

/** The launch's price path (market cap in SOL): trades in the raw window, minute candles after. */
function pathAfter(l: LaunchFacts, from: number): Array<{ at: number; h: number; l: number; c: number }> {
  const out: Array<{ at: number; h: number; l: number; c: number }> = [];
  let lastTradeObs = from;
  for (const t of l.trades) if (t.obs > from) { const mc = curveMcapSol(t.vSol, t.vTok); out.push({ at: t.obs, h: mc, l: mc, c: mc }); lastTradeObs = t.obs; }
  for (const k of l.candles) if (k.m > lastTradeObs) out.push({ at: k.m, h: k.h, l: k.l, c: k.c });
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Moments when the observer could have missed trades: its own restarts (a run starting), and a feed disconnect while
 * the run had only one feed, or while another feed was disconnected within the same few seconds.
 */
export function blindSpots(ds: Pick<Dataset, 'gaps' | 'runs'>): number[] {
  const out = ds.runs.map(r => r.start).slice(1);
  const logs = ds.gaps.filter(g => g.source.startsWith('logs')).sort((a, b) => a.obs - b.obs);
  for (const g of logs) {
    const run = [...ds.runs].reverse().find(r => r.start <= g.obs);
    if (!run || run.sources <= 1 || logs.some(o => o.source !== g.source && Math.abs(o.obs - g.obs) <= 10_000)) out.push(g.obs);
  }
  return out.sort((a, b) => a - b);
}

export function features(l: LaunchFacts, tS: number, history: { creatorLaunches: number; creatorGraduations: number }, blind: number[]): Features {
  const end = l.createdObs + tS * 1000, seen = l.trades.filter(t => t.obs <= end), last = seen.at(-1);
  const progressAt = (ms: number) => { const tr = l.trades.filter(t => t.obs <= ms).at(-1); return tr ? curveProgress(tr.realTok) : 0; };
  const p = last ? curveProgress(last.realTok) : null;
  const vel = (ms: number) => p === null ? null : (p - progressAt(end - ms)) / (ms / 60_000);
  const v30 = tS >= 30 ? vel(30_000) : null, v60 = tS >= 60 ? vel(60_000) : null;
  const prev30 = tS >= 60 && p !== null ? (progressAt(end - 30_000) - progressAt(end - 60_000)) / 0.5 : null;
  const firstBuy = new Map<number, number>(), spent = new Map<number, number>();
  let buySol = 0, sellSol = 0, devSold = false, breaks = 0;
  // Each trade's curve state before it must be the state after an earlier trade (or the first trade seen): trades in
  // one slot can arrive in any order, so it is checked against every earlier state, not only the previous one.
  const states = new Set<number>();
  for (const [i, t] of seen.entries()) {
    const before = t.buy ? t.vSol - t.lamports : t.vSol + t.lamports;
    if (i > 0 && !states.has(before)) breaks++;
    states.add(t.vSol);
    if (t.buy) { buySol += t.lamports / 1e9; spent.set(t.w, (spent.get(t.w) ?? 0) + t.lamports); if (!firstBuy.has(t.w)) firstBuy.set(t.w, t.obs); }
    else { sellSol += t.lamports / 1e9; if (t.w === l.creatorW) devSold = true; }
  }
  const newIn = (a: number, b: number) => [...firstBuy.values()].filter(x => x > a && x <= b).length;
  const n30 = newIn(end - 30_000, end), nPrev = newIn(end - 60_000, end - 30_000);
  const shares = [...spent.values()].map(v => v / (buySol * 1e9)).sort((a, b) => b - a);
  const hhi = shares.length ? shares.reduce((s, x) => s + x * x, 0) : null;
  const m = l.meta;
  const x = parseXLink(m?.tw);
  const caPost = l.xPosts.filter(post => post.mint && post.at + X_POST_LATENCY_MS <= end && post.at >= l.createdObs - 72 * 3_600_000).sort((a, b) => a.at - b.at)[0];
  const xr = l.xReads.find(r => r.st === 'OK');
  const created = l.createdTs ?? l.createdObs;
  return {
    t: tS, mcapSol: last ? curveMcapSol(last.vSol, last.vTok) : null, progress: p, trades: seen.length,
    velocity30: v30, velocity60: v60, acceleration: v30 !== null && prev30 !== null ? v30 - prev30 : null,
    buyers: firstBuy.size, newBuyers30: n30, newBuyersPrev30: nPrev, buyerAcceleration: tS >= 60 ? (n30 + 1) / (nPrev + 1) : null,
    buySol, sellSol, netSol: buySol - sellSol, sellShare: buySol + sellSol > 0 ? sellSol / (buySol + sellSol) : null,
    hhi, top1: shares[0] ?? null, top5: shares.length ? shares.slice(0, 5).reduce((s, v) => s + v, 0) : null, effectiveBuyers: hhi ? 1 / hhi : null,
    devBuySol: l.devBuySol, devSold: l.creator ? devSold : null,
    hasX: l.meta ? x.kind === 'ACCOUNT' : null, hasSite: l.meta ? !!projectSite(m!.web) : null, hasTelegram: l.meta ? !!m!.tg : null,
    descLen: l.meta ? (m!.desc ?? '').length : null, metadataLinks: l.meta ? [x.kind === 'ACCOUNT', !!projectSite(m!.web), !!m!.tg].filter(Boolean).length : null,
    xCaPost: l.meta && x.kind === 'ACCOUNT' ? !!caPost : null, xCaPostDelayS: caPost ? Math.round((caPost.at - created) / 1000) : null,
    xFollowers: xr?.followers ?? null, xAccountAgeH: xr?.joined ? (created - xr.joined) / 3_600_000 : null,
    creatorLaunches: history.creatorLaunches, creatorGraduations: history.creatorGraduations,
    gapInWindow: blind.some(at => at >= l.createdObs && at <= end), chainBreaks: breaks, mayhem: l.mayhem,
  };
}

// ------------------------------------------------------------------ labels

/**
 * Outcomes after the decision time. Every label of a horizon is null until the data covers that whole horizon, so
 * an early report never counts the fast hits while the misses are still open.
 */
export interface Labels {
  /** Max gain and max drawdown (fractions of the decision price) within each horizon (minutes). */
  mfe: Record<number, number | null>; mae: Record<number, number | null>;
  /** Reached k× the decision price within 60 min and within 6 h. */
  reached: Record<number, boolean | null>; reached6h: Record<number, boolean | null>;
  /** 2× before the price halved, within 60 min (a take-profit / stop pair; pessimistic within a minute). */
  twoBeforeHalf: boolean | null;
  /** The curve completed (graduated) within 60 min / 6 h. */
  graduated: boolean | null; graduated6h: boolean | null; graduatedMin: number | null; peakMin: number | null;
}

export function labels(l: LaunchFacts, tS: number, entryMcap: number | null, dataEnd: number): Labels {
  const from = l.createdObs + tS * 1000;
  const out: Labels = { mfe: {}, mae: {}, reached: {}, reached6h: {}, twoBeforeHalf: null, graduated: null, graduated6h: null, graduatedMin: null, peakMin: null };
  if (!entryMcap || entryMcap <= 0) return out;
  // A curve that completed is worth its graduation price at least: the path is capped there (the pool is not observed).
  const path = pathAfter(l, from);
  const within = (min: number) => path.filter(p => p.at <= from + min * 60_000);
  const covered = (min: number) => from + min * 60_000 <= dataEnd;
  for (const h of HORIZONS_MIN) {
    if (!covered(h)) { out.mfe[h] = null; out.mae[h] = null; continue; }
    const seg = within(h);
    out.mfe[h] = seg.length ? Math.max(...seg.map(p => p.h)) / entryMcap - 1 : 0;
    out.mae[h] = seg.length ? Math.min(...seg.map(p => p.l)) / entryMcap - 1 : 0;
  }
  const hour = within(60), day = within(360);
  for (const k of MULTIPLES) {
    out.reached[k] = covered(60) ? hour.some(p => p.h >= entryMcap * k) : null;
    out.reached6h[k] = covered(360) ? day.some(p => p.h >= entryMcap * k) : null;
  }
  if (covered(60)) {
    let result = false;
    for (const p of hour) {
      if (p.l <= entryMcap * 0.5) break;
      if (p.h >= entryMcap * 2) { result = true; break; }
    }
    out.twoBeforeHalf = result;
  }
  const gradAt = l.completeObs !== null && l.completeObs > from ? l.completeObs : null;
  out.graduated = covered(60) ? gradAt !== null && gradAt <= from + 60 * 60_000 : null;
  out.graduated6h = covered(360) ? gradAt !== null && gradAt <= from + 360 * 60_000 : null;
  out.graduatedMin = gradAt !== null ? (gradAt - l.createdObs) / 60_000 : null;
  const seg = covered(360) ? day : hour;
  if (seg.length) { const peak = seg.reduce((a, b) => (b.h > a.h ? b : a)); out.peakMin = (peak.at - l.createdObs) / 60_000; }
  return out;
}

export interface Row { mint: string; symbol: string | null; createdObs: number; f: Features; y: Labels }

/** Every launch with a creation record, at one decision time; launches already complete by then are left out. */
export function rows(ds: Dataset, tS: number): Row[] {
  const list = [...ds.launches.values()].filter(l => l.createdObs >= ds.first).sort((a, b) => a.createdObs - b.createdObs);
  const byCreator = new Map<string, LaunchFacts[]>(), blind = blindSpots(ds);
  const out: Row[] = [];
  for (const l of list) {
    const end = l.createdObs + tS * 1000, earlier = l.creator ? byCreator.get(l.creator) ?? [] : [];
    if (end <= ds.last && (l.completeObs === null || l.completeObs > end)) {
      const history = { creatorLaunches: earlier.length, creatorGraduations: earlier.filter(e => e.completeObs !== null && e.completeObs <= end).length };
      const f = features(l, tS, history, blind);
      out.push({ mint: l.mint, symbol: l.symbol, createdObs: l.createdObs, f, y: labels(l, tS, f.mcapSol, ds.last) });
    }
    if (l.creator) byCreator.set(l.creator, [...earlier, l]);
  }
  return out;
}

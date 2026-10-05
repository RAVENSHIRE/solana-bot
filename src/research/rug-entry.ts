import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * Rugs at entry (research, docs/research/literature/RUG-AT-ENTRY.md, pre-registered 5 Oct 23:00 UTC): what the
 * observer's curve trades say about a coin at its graduation, before a CRASH-type entry 1–4 min later. Descriptive:
 * the features and their pre-registered thresholds, nothing here decides a trade.
 *
 * Net balances come from curve trades only (tokens bought − tokens sold up to the graduation); tokens moved between
 * wallets by transfer are not seen, so a wallet that sold transferred tokens counts as zero, never negative.
 *
 * Also the frozen bot list R (MAYHEM.md, M2b and B1): wallets that were the top buyer of at least 100 launches created
 * before the freeze. "Top buyer" = the most SOL bought in the launch's first 120 s (M2b's decision time).
 */
export const SUPPLY_RAW = 1e15;
export const BOT_LIST = Object.freeze({ frozenAt: Date.parse('2026-10-05T17:00:00Z'), minLaunches: 100, windowS: 120 });
export const RUG_THRESHOLDS = Object.freeze({ insiderAtGrad: 0.10, top10AtGrad: 0.35, sniperAtGrad: 0.15, botAtGrad: 0.10, preGradSellShare: 0.45, holdersAtGrad: 150 });
/** A rug: the price at or below −70 % of the entry within 10 min of it. */
export const RUG_LABEL = Object.freeze({ dropPct: 70, withinMin: 10 });

export interface CurveLaunch { mint: string; created: number; createdSlot: number | null; creator: string | null; complete: number | null }
export interface CurveTrade { obs: number; slot: number; wallet: string; buy: boolean; lamports: number; tok: number; vSol: number }

export interface LedgerScan {
  launches: Map<string, CurveLaunch>;
  /** Curve trades of the requested mints, in chain order. */
  trades: Map<string, CurveTrade[]>;
  /** Launches each wallet was the top buyer of (created before the freeze). */
  topBuyer: Map<string, number>;
  topBuyerLaunches: number;
  files: number; first: number; last: number;
}

/**
 * One pass over the ledger files: every launch's creator and graduation (for the creator history), the curve trades
 * of `mints`, and the top buyer of each launch created before `frozenAt`. Only launches in their 120-s window are
 * held for the bot list, so memory stays small over days of files.
 */
export function scanLedger(files: readonly string[], mints: ReadonlySet<string>, o: { frozenAt?: number; windowS?: number } = {}): LedgerScan {
  const frozenAt = o.frozenAt ?? BOT_LIST.frozenAt, windowMs = (o.windowS ?? BOT_LIST.windowS) * 1000;
  const launches = new Map<string, CurveLaunch>(), trades = new Map<string, CurveTrade[]>(), topBuyer = new Map<string, number>();
  const early = new Map<string, { created: number; spent: Map<string, number> }>();
  let topBuyerLaunches = 0, first = Infinity, last = 0;
  const close = (mint: string) => {
    const e = early.get(mint);
    early.delete(mint);
    if (!e?.spent.size) return;
    let top: string | null = null, max = -1;
    for (const [w, v] of e.spent) if (v > max) { max = v; top = w; }
    topBuyerLaunches++;
    topBuyer.set(top!, (topBuyer.get(top!) ?? 0) + 1);
  };
  const sweep = (now: number) => { for (const [m, e] of early) if (e.created + windowMs + 60_000 < now) close(m); };
  for (const file of files) {
    const raw = fs.readFileSync(file), text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const ms: string[] = [], ws: string[] = [];
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: unknown[];
      try { r = JSON.parse(line) as unknown[]; } catch { continue; }
      const tag = r[0];
      if (tag === 'M') { ms[r[1] as number] = r[2] as string; continue; }
      if (tag === 'W') { ws[r[1] as number] = r[2] as string; continue; }
      if (tag !== 'PC' && tag !== 'C' && tag !== 'T' && tag !== 'X' && tag !== 'G') continue;
      const obs = r[1] as number;
      if (typeof obs !== 'number') continue;
      first = Math.min(first, obs); last = Math.max(last, obs);
      if (++n % 20_000 === 0) sweep(obs);
      const mintAt = (i: number) => typeof r[i] === 'number' ? ms[r[i] as number] ?? null : null, walletAt = (i: number) => typeof r[i] === 'number' ? ws[r[i] as number] ?? null : null;
      if (tag === 'PC' || tag === 'C') {
        const mint = mintAt(tag === 'PC' ? 2 : 4);
        if (!mint) continue;
        const creator = tag === 'PC' ? walletAt(3) : walletAt(6) ?? walletAt(5);
        const l = launches.get(mint) ?? { mint, created: obs, createdSlot: null, creator: null, complete: null };
        l.created = Math.min(l.created, obs); l.creator ??= creator;
        if (tag === 'C' && typeof r[3] === 'number') l.createdSlot = r[3];
        launches.set(mint, l);
        if (l.created < frozenAt && !early.has(mint)) early.set(mint, { created: l.created, spent: new Map() });
      } else if (tag === 'T') {
        const mint = mintAt(4), wallet = walletAt(5);
        if (!mint || !wallet) continue;
        const buy = r[6] === 1, lamports = r[7] as number;
        const e = early.get(mint);
        if (e && buy && obs <= e.created + windowMs) e.spent.set(wallet, (e.spent.get(wallet) ?? 0) + lamports);
        if (mints.has(mint)) {
          const list = trades.get(mint) ?? [];
          list.push({ obs, slot: (r[3] as number | null) ?? 0, wallet, buy, lamports, tok: r[8] as number, vSol: r[9] as number });
          trades.set(mint, list);
        }
      } else {
        const mint = mintAt(tag === 'X' ? 3 : 2), l = mint ? launches.get(mint) : undefined;
        if (l) l.complete ??= obs;
      }
    }
    sweep(last);
  }
  for (const m of [...early.keys()]) close(m);
  for (const list of trades.values()) list.sort((a, b) => a.slot - b.slot || a.obs - b.obs);
  return { launches, trades, topBuyer, topBuyerLaunches, files: files.length, first: Number.isFinite(first) ? first : 0, last };
}

/** R: the wallets that were the top buyer of at least `minLaunches` launches, most launches first. */
export function botList(scan: Pick<LedgerScan, 'topBuyer'>, minLaunches = BOT_LIST.minLaunches): Array<{ wallet: string; launches: number }> {
  return [...scan.topBuyer].filter(([, n]) => n >= minLaunches).map(([wallet, launches]) => ({ wallet, launches })).sort((a, b) => b.launches - a.launches);
}

export interface GradFeatures {
  gradAt: number | null;
  /** Curve trades up to the graduation, and how many did not follow from an earlier curve state (missed trades). */
  trades: number; chainBreaks: number;
  insiderAtGrad: number | null; top10AtGrad: number | null; sniperAtGrad: number | null; botAtGrad: number | null;
  preGradSellShare: number | null; serialCreator: boolean | null; holdersAtGrad: number | null;
  creatorLaunches: number; creatorGraduations: number;
}

/** Earlier launches by the same creator, and how many of them had graduated by `at` (point in time). */
export function creatorHistory(launches: ReadonlyMap<string, CurveLaunch>, l: CurveLaunch, at: number): { launches: number; graduations: number } {
  if (!l.creator) return { launches: 0, graduations: 0 };
  let n = 0, g = 0;
  for (const o of launches.values()) if (o.mint !== l.mint && o.creator === l.creator && o.created < l.created) { n++; if (o.complete !== null && o.complete <= at) g++; }
  return { launches: n, graduations: g };
}

/** RUG-AT-ENTRY's seven features at the graduation, from the curve trades. */
export function gradFeatures(l: CurveLaunch, all: readonly CurveTrade[], bots: ReadonlySet<string>, history: { launches: number; graduations: number }): GradFeatures {
  const g = l.complete, base = { gradAt: g, creatorLaunches: history.launches, creatorGraduations: history.graduations };
  if (g === null) return { ...base, trades: 0, chainBreaks: 0, insiderAtGrad: null, top10AtGrad: null, sniperAtGrad: null, botAtGrad: null, preGradSellShare: null, serialCreator: null, holdersAtGrad: null };
  const seen = all.filter(t => t.obs <= g), net = new Map<string, number>(), states = new Set<number>();
  const slot0 = l.createdSlot ?? (seen.length ? Math.min(...seen.map(t => t.slot)) : 0);
  const insiders = new Set<string>(l.creator ? [l.creator] : []), snipers = new Set<string>();
  let breaks = 0, buyLam = 0, sellLam = 0;
  for (const [i, t] of seen.entries()) {
    const before = t.buy ? t.vSol - t.lamports : t.vSol + t.lamports;
    if (i > 0 && !states.has(before)) breaks++;
    states.add(t.vSol);
    net.set(t.wallet, (net.get(t.wallet) ?? 0) + (t.buy ? t.tok : -t.tok));
    if (t.buy && t.slot <= slot0 + 1) insiders.add(t.wallet);
    if (t.buy && t.slot <= slot0 + 2 && t.wallet !== l.creator) snipers.add(t.wallet);
    if (t.obs > g - 120_000) { if (t.buy) buyLam += t.lamports; else sellLam += t.lamports; }
  }
  const held = [...net].filter(([, v]) => v > 0), share = (ws: Iterable<string>) => { let s = 0; for (const w of ws) s += Math.max(0, net.get(w) ?? 0); return s / SUPPLY_RAW; };
  const top10 = held.map(([, v]) => v).sort((a, b) => b - a).slice(0, 10).reduce((a, v) => a + v, 0) / SUPPLY_RAW;
  return { ...base, trades: seen.length, chainBreaks: breaks,
    insiderAtGrad: share(insiders), top10AtGrad: top10, sniperAtGrad: share(snipers), botAtGrad: share([...net.keys()].filter(w => bots.has(w))),
    preGradSellShare: buyLam + sellLam > 0 ? sellLam / (buyLam + sellLam) : null,
    serialCreator: l.creator ? history.launches >= 2 && history.graduations === 0 : null, holdersAtGrad: held.length };
}

/** Which pre-registered thresholds a coin is past (true), short of (false) or unknown for (null). */
export function pastThresholds(f: GradFeatures): Record<keyof typeof RUG_THRESHOLDS | 'serialCreator', boolean | null> {
  const k = RUG_THRESHOLDS, ge = (v: number | null, t: number) => v === null ? null : v >= t;
  return { insiderAtGrad: ge(f.insiderAtGrad, k.insiderAtGrad), top10AtGrad: ge(f.top10AtGrad, k.top10AtGrad), sniperAtGrad: ge(f.sniperAtGrad, k.sniperAtGrad),
    botAtGrad: ge(f.botAtGrad, k.botAtGrad), preGradSellShare: ge(f.preGradSellShare, k.preGradSellShare), serialCreator: f.serialCreator,
    holdersAtGrad: f.holdersAtGrad === null ? null : f.holdersAtGrad < k.holdersAtGrad };
}

/** The 10-minute label from minute candles (USD price): RUG, NO, or PENDING while the window is still open. */
export function rugLabel(entryUsd: number, at: number, candles: ReadonlyArray<{ t: number; h: number; l: number; c: number }>, now: number): { label: 'RUG' | 'NO' | 'PENDING' | 'NO_DATA'; minPct: number | null; maxPct: number | null } {
  const end = at + RUG_LABEL.withinMin * 60_000;
  // A candle counts from the minute holding the entry (its low may be before the entry: conservative towards RUG).
  const inside = candles.filter(k => k.t + 60_000 > at && k.t < end);
  if (!inside.length) return { label: now < end ? 'PENDING' : 'NO_DATA', minPct: null, maxPct: null };
  const minPct = (Math.min(...inside.map(k => k.l)) / entryUsd - 1) * 100, maxPct = (Math.max(...inside.map(k => k.h)) / entryUsd - 1) * 100;
  if (minPct <= -RUG_LABEL.dropPct) return { label: 'RUG', minPct, maxPct };
  return { label: now < end ? 'PENDING' : 'NO', minPct, maxPct };
}

import { parseXLink, checkWebsite, caVerdict, type WebsiteCheck } from '../desk/social';
import { metadataUrl, projectSite } from '../desk/launches';
import type { ResearchLedger } from './ledger';
import { pumpEvents, curveMcapSol, curveProgress, PUMP_PROGRAM_ID, type PumpTrade } from './pump-events';
import { ReconnectingFeed, RecentSet, type SocketFactory } from './streams';
import { readXTimeline, postAddresses, type XRead } from './xread';
import { NORMAL_CURVE_FLOOR_SOL, type LaunchFacts } from './dataset';
import type { CallEngine } from './calls';

/**
 * The research observer: every pump.fun launch from its creation, recorded as facts with the time they were observed.
 *
 *   creations, migrations   PumpPortal's free stream (dev buy, metadata URI), and the program's own CreateEvent
 *   trades                  pump.fun TradeEvents from RPC logs (wallet, SOL, tokens, curve reserves after the trade):
 *                           raw for the first 10 minutes (an hour for curves past 25 %), minute candles for 6 hours
 *   metadata                the launch's JSON (X, website, Telegram, description)
 *   X                       the linked account's profile and recent posts at +6 min, and at +15/+30 min while active
 *   website                 whether it shows this contract address, at +6 min and +20 min while active
 *
 * No scores, no filters on outcome: the dataset is what a trader could have seen, kept for later study.
 */
export const OBSERVE = Object.freeze({
  rawWindowMs: 10 * 60_000, extendProgress: 0.25, extendWindowMs: 60 * 60_000,
  candleForMs: 6 * 3_600_000, dropIdleMs: 30 * 60_000, dropAfterCompleteMs: 10 * 60_000,
  /** Candles of a minute are closed this long after it ended (trades arrive a few seconds late). */
  candleGraceMs: 20_000,
  x: { atMs: [6 * 60_000], activeAtMs: [15 * 60_000, 30 * 60_000], gapMs: 1_200, maxLateMs: 5 * 60_000, handleCacheMs: 60_000, backoffMs: 60_000, maxBackoffMs: 10 * 60_000 },
  site: { atMs: [6 * 60_000], activeAtMs: [20 * 60_000], concurrency: 2 },
  active: { buyers: 10, progress: 0.05 },
  meta: { concurrency: 6, timeoutMs: 5_000, retryMs: 30_000 },
  postsBeforeCreateMs: 72 * 3_600_000, textChars: 100, maxBuyers: 5_000,
  statMs: 10 * 60_000,
});
export const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
export const PUBLIC_RPC_WS = 'wss://api.mainnet-beta.solana.com';
/** A second free websocket: on 2 Oct each of the two missed transactions the other one delivered; merged they covered both. */
export const PUBLICNODE_WS = 'wss://solana-rpc.publicnode.com';

interface Candle { minute: number; o: number; h: number; l: number; c: number; buy: number; sell: number; nb: number; ns: number; buyers: Set<string>; fresh: number; progress: number }
interface Read { at: number; kind: 'x' | 'site'; active: boolean }
interface Track {
  mint: string; createdMs: number; uri: string | null; buyers: Set<string>; progress: number; lastTradeMs: number; candle: Candle | null;
  completeMs: number | null; xHandle: string | null; site: string | null; reads: Read[]; metaTries: number; metaDone: boolean; posts: Set<string>;
}

export interface ObserverDeps {
  ledger: ResearchLedger;
  now?: () => number;
  fetcher?: typeof fetch;
  xRead?: (handle: string) => Promise<XRead>;
  site?: (url: string) => Promise<WebsiteCheck>;
  factory?: SocketFactory;
  /** Websocket URLs for the pump.fun logs (several are merged, each transaction once). */
  tradeSources?: string[];
  pumpPortalUrl?: string | null;
  log?: (line: string) => void;
  /** Live calls from the research layer (qualified rules to the phone, shadow calls recorded). */
  calls?: CallEngine | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const zero = () => ({ createsPortal: 0, createsLog: 0, trades: 0, tradesLogged: 0, untracked: 0, completes: 0, migrations: 0, candles: 0,
  metaOk: 0, metaFail: 0, xReads: 0, xCached: 0, xLimited: 0, xErrors: 0, xLate: 0, xInactive: 0, siteReads: 0, siteInactive: 0, gaps: 0 });

export class ResearchObserver {
  readonly tracks = new Map<string, Track>();
  /**
   * The same facts the research dataset reads back from the ledger, kept live for the call engine: one code path for
   * features in the look-back and in live calls.
   */
  readonly facts = new Map<string, LaunchFacts>();
  private readonly walletIds = new Map<string, number>();
  private readonly now: () => number;
  private readonly seen = new RecentSet(200_000);
  private readonly feeds: ReconnectingFeed[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly metaQueue: string[] = [];
  private metaBusy = 0;
  private siteBusy = 0;
  private xNextAt = 0;
  private xBackoffMs: number = OBSERVE.x.backoffMs;
  private xBusy = false;
  private readonly xCache = new Map<string, { at: number; read: XRead }>();
  stats = zero();
  totals = zero();

  constructor(private readonly d: ObserverDeps) { this.now = d.now ?? Date.now; }

  start(): void {
    const gap = (source: string) => (detail: string) => { this.count('gaps'); this.d.ledger.put(['GAP', this.now(), source, detail]); };
    if (this.d.pumpPortalUrl !== null) {
      this.feeds.push(new ReconnectingFeed('pumpportal', this.d.pumpPortalUrl ?? PUMPPORTAL_URL, {
        open: send => { send(JSON.stringify({ method: 'subscribeNewToken' })); send(JSON.stringify({ method: 'subscribeMigration' })); },
        message: data => this.onPortal(data), gap: gap('pumpportal'),
      }, { factory: this.d.factory }));
    }
    for (const [i, url] of (this.d.tradeSources ?? [PUBLIC_RPC_WS]).entries()) {
      const name = `logs${i}`;
      this.feeds.push(new ReconnectingFeed(name, url, {
        open: send => send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }] })),
        message: data => this.onLogs(data), gap: gap(name),
      }, { factory: this.d.factory, idleMs: 30_000 }));
    }
    for (const f of this.feeds) f.start();
    this.timers.push(setInterval(() => this.tick(), 5_000), setInterval(() => this.pump(), 250), setInterval(() => this.stat(), OBSERVE.statMs),
      setInterval(() => { try { this.d.calls?.tick(this.facts.values()); } catch (error) { this.d.log?.(`calls: ${(error as Error).message}`); } }, 1_000));
    for (const t of this.timers) t.unref?.();
    this.d.ledger.put(['START', this.now(), { sources: (this.d.tradeSources ?? [PUBLIC_RPC_WS]).length, portal: this.d.pumpPortalUrl !== null, version: 1 }]);
  }

  stop(): void {
    for (const f of this.feeds) f.stop();
    for (const t of this.timers) clearInterval(t);
    for (const t of this.tracks.values()) this.closeCandle(t);
    this.d.ledger.put(['STOP', this.now(), this.totals]);
  }

  // ------------------------------------------------------------------ feeds

  onPortal(data: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(data); } catch { return; }
    const mint = typeof m.mint === 'string' ? m.mint : null;
    if (!mint) return;
    const now = this.now(), sig = typeof m.signature === 'string' ? m.signature.slice(0, 12) : null;
    if (m.txType === 'create') {
      this.count('createsPortal');
      const trader = typeof m.traderPublicKey === 'string' ? m.traderPublicKey : null;
      this.d.ledger.put(['PC', now, { $m: mint }, trader ? { $w: trader } : null, sig, String(m.name ?? '').slice(0, 40), String(m.symbol ?? '').slice(0, 20),
        typeof m.uri === 'string' ? m.uri.slice(0, 200) : null, Number(m.solAmount ?? 0), Number(m.initialBuy ?? 0), r3(Number(m.marketCapSol ?? 0)), m.is_mayhem_mode ? 1 : 0]);
      this.register(mint, now, typeof m.uri === 'string' ? m.uri : null);
      const l = this.fact(mint, now);
      l.creator ??= trader; l.devBuySol = Number(m.solAmount ?? 0); l.name ??= String(m.name ?? '').slice(0, 40); l.symbol ??= String(m.symbol ?? '').slice(0, 20);
      if (m.is_mayhem_mode) l.mayhem = true;
      if (l.creator) l.creatorW = this.wallet(l.creator);
    } else if (m.txType === 'migrate') {
      this.count('migrations');
      this.d.ledger.put(['G', now, { $m: mint }, sig, typeof m.pool === 'string' ? m.pool : null]);
      const t = this.tracks.get(mint);
      if (t) { this.closeCandle(t); t.completeMs ??= now; }
      const l = this.facts.get(mint);
      if (l) { l.migrateObs ??= now; l.completeObs ??= now; }
    }
  }

  onLogs(data: string): void {
    let m: { params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } } };
    try { m = JSON.parse(data); } catch { return; }
    const v = m.params?.result?.value, slot = m.params?.result?.context?.slot ?? null;
    if (!v?.signature || v.err || !v.logs || !this.seen.add(v.signature)) return;
    const now = this.now(), sig = v.signature.slice(0, 12);
    for (const ev of pumpEvents(v.logs)) {
      if (ev.kind === 'create') {
        this.count('createsLog');
        const e = ev.e;
        this.d.ledger.put(['C', now, e.ts, slot, { $m: e.mint }, { $w: e.user }, e.creator && e.creator !== e.user ? { $w: e.creator } : null, sig,
          e.name.slice(0, 40), e.symbol.slice(0, 20), e.uri.slice(0, 200)]);
        this.register(e.mint, now, e.uri);
        const l = this.fact(e.mint, now);
        l.createdTs = e.ts !== null ? e.ts * 1000 : l.createdTs; l.creator ??= e.creator ?? e.user; l.name ??= e.name.slice(0, 40); l.symbol ??= e.symbol.slice(0, 20);
        if (l.creator) l.creatorW = this.wallet(l.creator);
      } else if (ev.kind === 'trade') this.onTrade(ev.e, slot, sig, now);
      else {
        this.count('completes');
        this.d.ledger.put(['X', now, ev.e.ts, { $m: ev.e.mint }]);
        const t = this.tracks.get(ev.e.mint);
        if (t) { this.closeCandle(t); t.completeMs ??= now; }
        const l = this.facts.get(ev.e.mint);
        if (l) l.completeObs ??= now;
      }
    }
  }

  private onTrade(e: PumpTrade, slot: number | null, sig: string, now: number): void {
    this.count('trades');
    const t = this.tracks.get(e.mint);
    if (!t) { this.count('untracked'); return; }
    const mc = curveMcapSol(e.vSol, e.vTok), progress = curveProgress(e.realTok), minute = Math.floor(e.ts / 60);
    if (t.candle && t.candle.minute !== minute) this.closeCandle(t);
    const c = t.candle ??= { minute, o: mc, h: mc, l: mc, c: mc, buy: 0, sell: 0, nb: 0, ns: 0, buyers: new Set(), fresh: 0, progress };
    c.h = Math.max(c.h, mc); c.l = Math.min(c.l, mc); c.c = mc; c.progress = progress;
    if (e.isBuy) {
      c.buy += e.lamports; c.nb++; c.buyers.add(e.user);
      if (!t.buyers.has(e.user)) { c.fresh++; if (t.buyers.size < OBSERVE.maxBuyers) t.buyers.add(e.user); }
    } else { c.sell += e.lamports; c.ns++; }
    t.progress = progress; t.lastTradeMs = now;
    const age = now - t.createdMs;
    const l = this.facts.get(e.mint);
    if (l && (age <= OBSERVE.rawWindowMs || (progress >= OBSERVE.extendProgress && age <= OBSERVE.extendWindowMs) || this.d.calls?.holding(e.mint))) {
      l.trades.push({ obs: now, ts: e.ts, slot: slot ?? 0, w: this.wallet(e.user), buy: e.isBuy, lamports: e.lamports, vSol: e.vSol, vTok: e.vTok, realTok: e.realTok });
      if (mc < NORMAL_CURVE_FLOOR_SOL) l.mayhem = true;
    }
    if (!this.d.ledger.lowDisk && (age <= OBSERVE.rawWindowMs || (progress >= OBSERVE.extendProgress && age <= OBSERVE.extendWindowMs))) {
      this.count('tradesLogged');
      this.d.ledger.put(['T', now, e.ts, slot, { $m: e.mint }, { $w: e.user }, e.isBuy ? 1 : 0, e.lamports, e.tokens, e.vSol, e.vTok, e.realTok, sig]);
    }
  }

  // ------------------------------------------------------------------ tracking

  private wallet(w: string): number {
    let i = this.walletIds.get(w);
    if (i === undefined) { i = this.walletIds.size; this.walletIds.set(w, i); if (this.walletIds.size > 2_000_000) this.walletIds.clear(); }
    return i;
  }

  private fact(mint: string, now: number): LaunchFacts {
    let l = this.facts.get(mint);
    if (!l) {
      l = { mint, createdObs: now, createdTs: null, creator: null, creatorW: null, devBuySol: null, name: null, symbol: null, mayhem: false, trades: [], candles: [],
        completeObs: null, migrateObs: null, meta: null, metaError: false, xReads: [], xPosts: [], sites: [] };
      this.facts.set(mint, l);
    }
    return l;
  }

  private register(mint: string, now: number, uri: string | null): void {
    const t = this.tracks.get(mint);
    if (t) { if (!t.uri && uri) { t.uri = uri; if (!t.metaDone) this.metaQueue.push(mint); } return; }
    this.tracks.set(mint, { mint, createdMs: now, uri, buyers: new Set(), progress: 0, lastTradeMs: now, candle: null, completeMs: null,
      xHandle: null, site: null, reads: [], metaTries: 0, metaDone: false, posts: new Set() });
    if (uri) this.metaQueue.push(mint);
  }

  private closeCandle(t: Track): void {
    const c = t.candle;
    if (!c) return;
    t.candle = null;
    this.facts.get(t.mint)?.candles.push({ m: c.minute * 60_000, h: c.h, l: c.l, c: c.c });
    if (this.d.ledger.lowDisk || this.now() - t.createdMs > OBSERVE.candleForMs) return;
    this.count('candles');
    this.d.ledger.put(['K', c.minute, { $m: t.mint }, r3(c.o), r3(c.h), r3(c.l), r3(c.c), c.buy, c.sell, c.nb, c.ns, c.buyers.size, c.fresh, Math.round(c.progress * 10_000) / 10_000]);
  }

  private active(t: Track): boolean { return t.buyers.size >= OBSERVE.active.buyers || t.progress >= OBSERVE.active.progress; }

  tick(): void {
    const now = this.now(), closedBefore = Math.floor((now - OBSERVE.candleGraceMs) / 60_000);
    for (const [mint, t] of this.tracks) {
      if (t.candle && t.candle.minute < closedBefore) this.closeCandle(t);
      const age = now - t.createdMs;
      const done = (t.completeMs !== null && now - t.completeMs > OBSERVE.dropAfterCompleteMs) || age > OBSERVE.candleForMs
        || (age > OBSERVE.rawWindowMs && now - t.lastTradeMs > OBSERVE.dropIdleMs && !t.reads.some(r => !r.active));
      if (done) { this.closeCandle(t); this.tracks.delete(mint); }
    }
    for (const mint of this.facts.keys()) if (!this.tracks.has(mint) && !this.d.calls?.holding(mint)) this.facts.delete(mint);
  }

  /** Metadata fetches, X reads and website reads that are due. */
  pump(): void {
    while (this.metaBusy < OBSERVE.meta.concurrency && this.metaQueue.length) {
      const t = this.tracks.get(this.metaQueue.shift()!);
      if (t && !t.metaDone && t.uri) { this.metaBusy++; void this.meta(t).finally(() => { this.metaBusy--; }); }
    }
    const now = this.now();
    if (!this.xBusy && now >= this.xNextAt) {
      const due = this.due('x', now);
      if (due) { this.xBusy = true; this.xNextAt = now + OBSERVE.x.gapMs; void this.readX(due.t, due.r).finally(() => { this.xBusy = false; }); }
    }
    while (this.siteBusy < OBSERVE.site.concurrency) {
      const due = this.due('site', now);
      if (!due) break;
      this.siteBusy++; void this.readSite(due.t, due.r).finally(() => { this.siteBusy--; });
    }
  }

  /** The earliest due read of a kind; reads too late or for tokens no longer active are dropped (and counted). */
  private due(kind: 'x' | 'site', now: number): { t: Track; r: Read } | null {
    let best: { t: Track; r: Read } | null = null;
    for (const t of this.tracks.values()) for (const r of t.reads) if (r.kind === kind && r.at <= now && (!best || r.at < best.r.at)) best = { t, r };
    if (!best) return null;
    best.t.reads = best.t.reads.filter(r => r !== best!.r);
    if (kind === 'x' && now - best.r.at > OBSERVE.x.maxLateMs) { this.count('xLate'); return this.due(kind, now); }
    if (best.r.active && !this.active(best.t)) { this.count(kind === 'x' ? 'xInactive' : 'siteInactive'); return this.due(kind, now); }
    return best;
  }

  private async meta(t: Track): Promise<void> {
    t.metaTries++;
    try {
      // pump.fun's gateway first; the second try asks Pinata's public gateway. Never ipfs.io: the desk's radar needs its budget.
      const url = t.metaTries === 1 ? metadataUrl(t.uri!) : metadataUrl(t.uri!).replace('https://pump.mypinata.cloud/', 'https://gateway.pinata.cloud/');
      const res = await (this.d.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(OBSERVE.meta.timeoutMs), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as Record<string, unknown>;
      const s = (v: unknown, n = 200) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
      const twitter = s(j.twitter), website = s(j.website), telegram = s(j.telegram), description = s(j.description, 300);
      t.metaDone = true; this.count('metaOk');
      const lf = this.facts.get(t.mint);
      if (lf) lf.meta = { tw: twitter, web: website, tg: telegram, desc: description };
      this.d.ledger.put(['META', this.now(), { $m: t.mint }, { tw: twitter, web: website, tg: telegram, desc: description, img: s(j.image, 120), keys: Object.keys(j).length }]);
      const x = parseXLink(twitter);
      if (x.kind === 'ACCOUNT' && x.handle) {
        t.xHandle = x.handle;
        for (const at of OBSERVE.x.atMs) t.reads.push({ at: t.createdMs + at, kind: 'x', active: false });
        for (const at of OBSERVE.x.activeAtMs) t.reads.push({ at: t.createdMs + at, kind: 'x', active: true });
      }
      const site = projectSite(website);
      if (site) {
        t.site = site;
        for (const at of OBSERVE.site.atMs) t.reads.push({ at: t.createdMs + at, kind: 'site', active: false });
        for (const at of OBSERVE.site.activeAtMs) t.reads.push({ at: t.createdMs + at, kind: 'site', active: true });
      }
    } catch (error) {
      if (t.metaTries < 2) setTimeout(() => this.metaQueue.push(t.mint), OBSERVE.meta.retryMs).unref?.();
      else {
        this.count('metaFail'); this.d.ledger.put(['META', this.now(), { $m: t.mint }, { error: (error as Error).message.slice(0, 80) }]);
        const lf = this.facts.get(t.mint);
        if (lf) lf.metaError = true;
      }
    }
  }

  private async readX(t: Track, r: Read): Promise<void> {
    const handle = t.xHandle!, key = handle.toLowerCase(), now = this.now(), hit = this.xCache.get(key);
    let read: XRead;
    if (hit && now - hit.at < OBSERVE.x.handleCacheMs) { read = hit.read; this.count('xCached'); }
    else {
      read = await (this.d.xRead ?? readXTimeline)(handle);
      this.count('xReads');
      if (read.status === 'RATE_LIMITED') {
        this.count('xLimited');
        this.xNextAt = this.now() + this.xBackoffMs; this.xBackoffMs = Math.min(this.xBackoffMs * 2, OBSERVE.x.maxBackoffMs);
        t.reads.push(r);
        return;
      }
      this.xBackoffMs = OBSERVE.x.backoffMs;
      if (read.status === 'ERROR') this.count('xErrors');
      this.xCache.set(key, { at: now, read });
      for (const [k, v] of this.xCache) if (now - v.at > OBSERVE.x.handleCacheMs) this.xCache.delete(k);
    }
    const obs = this.now(), p = read.profile;
    this.d.ledger.put(['XP', obs, { $m: t.mint }, handle, { st: read.status, http: read.http, f: p?.followers ?? null, fg: p?.following ?? null, n: p?.statuses ?? null,
      j: p?.joinedAt ?? null, v: p?.verified ?? null, web: p?.website?.slice(0, 100) ?? null, bio: p?.bio?.slice(0, OBSERVE.textChars) ?? null, posts: read.posts.length }]);
    for (const post of read.posts) {
      if (post.at < t.createdMs - OBSERVE.postsBeforeCreateMs || t.posts.has(post.id)) continue;
      t.posts.add(post.id);
      const a = postAddresses(post.raw, t.mint);
      this.d.ledger.put(['XT', obs, { $m: t.mint }, handle, post.id, post.at, { a: post.author, t: post.text.slice(0, OBSERVE.textChars), v: post.views, l: post.likes,
        rp: post.reposts, c: post.replies, q: post.quotes, rt: post.repost ? 1 : 0, re: post.replyTo, mint: a.mint ? 1 : 0, ca: a.other }]);
    }
  }

  private async readSite(t: Track, _r: Read): Promise<void> {
    const site = await (this.d.site ?? (u => checkWebsite(u, this.d.fetcher ?? fetch, undefined, { scripts: 2 })))(t.site!).catch(() => null);
    this.count('siteReads');
    const v = site?.status === 'AVAILABLE' ? caVerdict(t.mint, site) : null;
    this.d.ledger.put(['S', this.now(), { $m: t.mint }, { u: t.site!.slice(0, 120), st: site?.status ?? 'ERROR', h: site?.httpStatus ?? null, ti: site?.title?.slice(0, 60) ?? null,
      v: v?.verdict ?? null, o: v?.other ?? null, x: site?.xHandles.slice(0, 3) ?? [] }]);
  }

  // ------------------------------------------------------------------ status

  private count(k: keyof ReturnType<typeof zero>): void { this.stats[k]++; this.totals[k]++; }

  private stat(): void {
    const now = this.now();
    this.d.ledger.put(['STAT', now, { ...this.stats, tracked: this.tracks.size, lowDisk: this.d.ledger.lowDisk ? 1 : 0, bytes: this.d.ledger.bytes }]);
    this.d.log?.(this.status());
    this.stats = zero();
  }

  status(): string {
    const s = this.stats;
    return `${new Date(this.now()).toISOString().slice(0, 19)} · tracked ${this.tracks.size} · creates ${s.createsPortal}/${s.createsLog} (portal/logs) · trades ${s.trades} (logged ${s.tradesLogged}, untracked ${s.untracked}) · ` +
      `completes ${s.completes} · migrations ${s.migrations} · meta ${s.metaOk} ok/${s.metaFail} failed · X ${s.xReads} reads (${s.xLimited} limited, ${s.xErrors} errors, ${s.xLate} late) · ` +
      `sites ${s.siteReads} · gaps ${s.gaps} · ${(this.d.ledger.bytes / 1048576).toFixed(1)} MB written${this.d.ledger.lowDisk ? ' · LOW DISK: trades paused' : ''}` +
      (this.d.calls ? ` · calls ${this.d.calls.stats.calls} sent, ${this.d.calls.stats.shadows} shadow, ${this.d.calls.stats.judged} judged` : '');
  }
}

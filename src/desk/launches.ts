import { PublicKey, type Connection } from '@solana/web3.js';
import { caVerdict, checkWebsite, parseXLink, readXPage, type WebsiteCheck, type XLink, type XPageCheck } from './social';
import { readInsiders, RISK, type Insiders, type RugList } from './launch-risk';
import { reviewPoints, type LaunchReview, type ReviewInput } from './review';

/**
 * Launch radar: every new pump.fun token, read from the chain seconds after it is created, with the X account, website
 * and Telegram from its metadata. It reproduces how @glabuz entered Meme Industries (FFrRBPP9…pump) at ~$20K on 1 Oct:
 *
 *   16:07:22 UTC  created on pump.fun (~$6K → $14K in the first minute)
 *   16:08:41      the project's own X account (@MemeInds) posts — 79 s after creation; a custom website (onsolchain.lol)
 *   16:09–16:11   flat at ~$16K while the post spreads
 *   16:12         first jump $17.5K → $30K; graduation 16:16 at ~$47K; $800K+ two hours later
 *
 * The signal is the quality of the launch itself — an own X account, a real project website that links back to it —
 * which only a small share of the ~50 launches per minute have. Jupiter quotes curve tokens 3–12 s after creation
 * (measured on 1 Oct), so the entry window is set by the evidence, not by routing.
 *
 * Impersonators copy a real project's X account and website into their own metadata (STASH Fx5E1… on 1 Oct, 14 h after
 * the real stashd.fun token 3Bdwh…pump): the metadata alone proves nothing. The radar therefore reads the X profile page
 * and the website for the contract address they show. This mint written there confirms the launch; another token's CA
 * there and never this one marks an impersonator.
 */
export const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
export const LAUNCH = Object.freeze({
  /** Launches kept in memory (and on the radar). */
  keepMs: 45 * 60_000,
  /** Signatures read per poll; at ~50 launches a minute a 20 s scan needs ~20. */
  pollLimit: 60,
  metadataTimeoutMs: 4_000,
  metadataConcurrency: 8,
  /** Score needed to be shortlisted: an own X account (3) plus a live project website (3), or the account posting this CA (3). */
  minScore: 6,
  /** Unconfirmed launches with an own X account are re-read at least this far apart, this long: projects post the CA after creation. */
  reverifyMs: 30_000,
  verifyForMs: 12 * 60_000,
  reverifyPerPoll: 6,
  /** The website is re-read less often (a few requests each). */
  siteReverifyMs: 120_000,
  /** One X page read per handle serves every launch (and clone) that links it within this time. */
  xCacheMs: 25_000,
  /** Held launches: their X account is re-read this often (a deleted account is a rug). */
  heldReverifyMs: 60_000,
  /** Insiders are read for launches at or above this score (a few RPC calls each), at most this many at once. */
  insiderMinScore: 5, insiderConcurrency: 2,
  /** Launches at or above the shortlist score get a Claude review (rate-limited by the reviewer). */
  reviewConcurrency: 2,
});

export interface LaunchEvent { mint: string; name: string; symbol: string; uri: string; creator: string | null; at: number; signature: string }
export interface LaunchMeta { description: string | null; twitter: string | null; website: string | null; telegram: string | null }
/** Where this mint is confirmed as the project's token: X (the account posted it), WEBSITE, or IMPERSONATOR (another CA there). */
export interface LaunchCa { status: 'X' | 'WEBSITE' | 'IMPERSONATOR' | 'UNCONFIRMED'; detail: string }
/** A post found by the X feed (X API search) that names this mint. */
export interface XSignal { mint: string; handle: string; followers: number | null; accountCreatedAt: number | null; postId: string; postAt: number; views: number | null; likes: number; text: string }
/**
 * The X account's reach as read from its profile page. `own`: the project's own account; otherwise the launch links
 * someone else's post or a big established account (a celebrity, a company): that is the narrative, not the project's audience.
 */
export interface XReach { followers: number | null; bestViews: number | null; accountAgeDays: number | null; points: number; reasons: string[]; own?: boolean }
export interface Launch extends LaunchEvent {
  meta: LaunchMeta | null; x: XLink; site: WebsiteCheck | null; score: number; reasons: string[];
  /** The X profile page as last read, and when; the website's last read. */
  xPage: XPageCheck | null; xCheckedAt: number | null; siteCheckedAt: number | null;
  ca: LaunchCa;
  /** Set when an earlier launch shares this one's X account, website or name. */
  clone: string | null;
  /** Set once the launch first reached the shortlist (alerted once). */
  shortlistedAt: number | null;
  /** When the X account was first seen to exist; later "not found" reads (two in a row) mean it was deleted. */
  xSeenAt?: number | null; xMissing?: number; xMissingAt?: number | null;
  reach?: XReach | null;
  insiders?: Insiders | null; insidersTries?: number; insidersRetryAt?: number;
  review?: LaunchReview | null;
  /** Posts from the X feed that name this mint. */
  xSignals?: XSignal[];
  /** Why this launch is a rug (deleted X account, rug history, SCAM review); never bought. */
  rug?: string | null;
}

const readString = (b: Buffer, o: number): [string, number] => {
  const n = b.readUInt32LE(o);
  if (n > 400 || o + 4 + n > b.length) throw new Error('bad string');
  return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n];
};
/** pump.fun's CreateEvent from the transaction logs: name, symbol, metadata URI, mint, bonding curve, creator. */
export function decodeCreate(logs: string[]): Omit<LaunchEvent, 'at' | 'signature'> | null {
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    try {
      const b = Buffer.from(line.slice(14), 'base64');
      let o = 8, name: string, symbol: string, uri: string;
      [name, o] = readString(b, o); [symbol, o] = readString(b, o); [uri, o] = readString(b, o);
      if (!/^https?:\/\//.test(uri) || b.length < o + 96) continue;
      const mint = new PublicKey(b.subarray(o, o + 32)).toBase58();
      const creator = new PublicKey(b.subarray(o + 64, o + 96)).toBase58();
      return { mint, name: name.trim(), symbol: symbol.trim(), uri, creator };
    } catch { /* another event in the same transaction */ }
  }
  return null;
}

/** Links to platforms, news sites and aggregators are not a project website. */
const NOT_A_PROJECT_SITE = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(me|org)|pump\.fun|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|reddit\.com|linktr\.ee|medium\.com|github\.com|google\.[a-z.]+|dexscreener\.com|birdeye\.so|solscan\.io|gmgn\.ai|discord\.(gg|com)|twitch\.tv|kick\.com|wikipedia\.org|reuters\.com|bbc\.(com|co\.uk)|cnn\.com|nytimes\.com|bloomberg\.com|coindesk\.com|cointelegraph\.com|theguardian\.com|foxnews\.com|apple\.com|amazon\.[a-z.]+|ipfs\.io|imgur\.com|giphy\.com)$/i;
export function projectSite(raw: string | null): string | null {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' && !NOT_A_PROJECT_SITE.test(u.hostname) ? u.toString() : null; } catch { return null; }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const host = (site: WebsiteCheck | null) => { try { return new URL(site!.url!).hostname.replace(/^www\./, ''); } catch { return 'the website'; } };

/** Whether the project's own X account and website show this mint, another one, or none yet. A post by the account wins. */
export function launchCa(mint: string, x: XLink, site: WebsiteCheck | null, xPage: XPageCheck | null): LaunchCa {
  const onX = xPage?.status === 'READ' ? caVerdict(mint, xPage) : null;
  const onSite = site?.status === 'AVAILABLE' ? caVerdict(mint, site) : null;
  if (onX?.verdict === 'CONFIRMED') return { status: 'X', detail: `@${x.handle} posted this CA` };
  // A linked post's author (often a dev or a caller) posts many CAs: only the project's own account can contradict.
  if (onX?.verdict === 'CONTRADICTED' && x.kind === 'ACCOUNT') return { status: 'IMPERSONATOR', detail: `IMPERSONATOR: @${x.handle} shows CA ${short(onX.other!)}, not this token` };
  if (onSite?.verdict === 'CONTRADICTED') return { status: 'IMPERSONATOR', detail: `IMPERSONATOR: ${host(site)} shows CA ${short(onSite.other!)}, not this token` };
  if (onSite?.verdict === 'CONFIRMED') return { status: 'WEBSITE', detail: `${host(site)} shows this CA` };
  if (x.kind !== 'ACCOUNT') return { status: 'UNCONFIRMED', detail: 'CA not confirmed (no own X account to check)' };
  return { status: 'UNCONFIRMED', detail: xPage?.status === 'READ' || xPage?.status === 'NO_POSTS' ? `CA not posted by @${x.handle} yet`
    : `CA not checked on X (${xPage?.detail ?? 'not read yet'})` };
}

const DAY = 86_400_000;
/**
 * The X account's reach from its profile page: followers (more is better), the views its own posts drew in the last
 * three days (Ansemmas: a 5-day-old account with 401 followers and a 21.7K-view post), and whether it is brand new.
 */
export const REACH = Object.freeze({
  /** An "own" account this big and old that never posted the CA is someone else's (Bankcoin linked Circle's CEO, 198K followers). */
  bigAccountFollowers: 50_000, bigAccountAgeDays: 365,
});
const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether the linked X account is the project's own: its handle matches the name or ticker, the website links it, or it posted the CA. */
export function ownAccount(l: { name: string; symbol: string; x: XLink; site: WebsiteCheck | null; ca?: LaunchCa | null }, page: XPageCheck | null, now = Date.now()): boolean {
  const h = norm(l.x.handle);
  if (!h) return false;
  if (l.ca?.status === 'X') return true;
  const p = page?.profile;
  const big = (p?.followers ?? 0) >= REACH.bigAccountFollowers && p?.createdAt != null && now - p.createdAt > REACH.bigAccountAgeDays * DAY;
  if (l.x.kind === 'ACCOUNT') return !big;
  const n = norm(l.name), s = norm(l.symbol), linked = !!l.site?.xHandles.includes(l.x.handle!.toLowerCase());
  return !big && (linked || [n, s].some(t => t.length >= 3 && (h.includes(t) || t.includes(h))));
}

/**
 * The X account's reach from its profile page: followers (more is better), the views its own posts drew in the last
 * three days (Ansemmas: a 5-day-old account with 401 followers and a 21.7K-view post), and whether it is brand new.
 * For someone else's account (a linked post by a celebrity or caller) only the linked post's views count, as narrative.
 */
export function xReach(page: XPageCheck | null, now: number, o: { own?: boolean; postId?: string | null } = {}): XReach {
  const p = page?.profile ?? null, own = o.own ?? true;
  if (!page || (page.status !== 'READ' && page.status !== 'NO_POSTS') || !p) return { followers: null, bestViews: null, accountAgeDays: null, points: 0, reasons: [], own };
  const reasons: string[] = []; let points = 0;
  const f = p.followers, age = p.createdAt ? (now - p.createdAt) / DAY : null;
  if (!own) {
    const post = o.postId ? (page.posts ?? []).find(x => x.id === o.postId) ?? null : null;
    const views = post?.views ?? null, add = views === null ? 0 : views >= 1_000_000 ? 2 : views >= 100_000 ? 1 : 0;
    reasons.push(`narrative: @${page.handle} (${(f ?? 0).toLocaleString('en-US')} followers) is not the project's account${views !== null ? `; the linked post has ${views.toLocaleString('en-US')} views${add ? ` (+${add})` : ''}` : ''}`);
    return { followers: f, bestViews: views, accountAgeDays: age, points: add, reasons, own };
  }
  if (f !== null) {
    const add = f >= 10_000 ? 4 : f >= 2_000 ? 3 : f >= 500 ? 2 : f >= 100 ? 1 : f < 25 ? -1 : 0;
    points += add; reasons.push(`${f.toLocaleString('en-US')} followers${add ? ` (${add > 0 ? '+' : ''}${add})` : ''}`);
  }
  const ownPosts = (page.posts ?? []).filter(x => (!x.author || x.author.toLowerCase() === page.handle.toLowerCase()) && now - x.at <= 3 * DAY);
  const best = ownPosts.reduce<number | null>((m, x) => x.views !== null && (m === null || x.views > m) ? x.views : m, null);
  if (best !== null) {
    const add = best >= 50_000 ? 3 : best >= 10_000 ? 2 : best >= 2_000 ? 1 : 0;
    points += add; reasons.push(`best post ${best.toLocaleString('en-US')} views${add ? ` (+${add})` : ''}`);
  }
  if (age !== null) {
    if (age < 1 && (f ?? 0) < 500) { points -= 1; reasons.push(`X account created ${Math.max(1, Math.round(age * 24))} h ago (−1)`); }
    else reasons.push(`X account ${age < 60 ? `${Math.round(age)} days` : `${(age / 365).toFixed(1)} years`} old`);
  }
  return { followers: f, bestViews: best, accountAgeDays: age, points, reasons, own };
}

export interface ScoreExtra { reach?: XReach | null; xPage?: XPageCheck | null; xSeenAt?: number | null; review?: LaunchReview | null; insiders?: Insiders | null;
  rug?: string | null; xSignals?: XSignal[] }
/**
 * How much this launch looks like a real project: own X account with reach, a live website that links back to it,
 * Telegram, a description, the account or website showing this very contract address, posts about it on X, and
 * Claude's review. An impersonator, a SCAM review or a rug scores 0.
 */
export function scoreLaunch(meta: LaunchMeta | null, x: XLink, site: WebsiteCheck | null, ca?: LaunchCa, e: ScoreExtra = {}): { score: number; reasons: string[] } {
  let score = 0; const reasons: string[] = [];
  if (x.kind === 'ACCOUNT') { score += 3; reasons.push(`own X account @${x.handle}`); }
  else if (x.kind === 'POST') { score += 1; reasons.push(`links an X post by @${x.handle}`); }
  else if (x.kind === 'COMMUNITY') reasons.push('X community, no account');
  else reasons.push('no X link');
  if (site?.status === 'AVAILABLE' && site.title) {
    score += 3; reasons.push(`website ${new URL(site.url!).hostname} ("${site.title.slice(0, 40)}")`);
    if (x.handle && site.xHandles.includes(x.handle.toLowerCase())) { score += 2; reasons.push('website links the same X account'); }
  } else if (meta?.website) reasons.push(projectSite(meta.website) ? `website ${site?.detail ?? 'not checked'}` : 'website is a platform or news link');
  else reasons.push('no website');
  if (meta?.telegram) { score += 1; reasons.push('Telegram'); }
  if ((meta?.description ?? '').trim().length >= 40) { score += 1; reasons.push('real description'); }
  if (e.rug) return { score: 0, reasons: [e.rug, ...reasons] };
  if (e.review?.verdict === 'SCAM') return { score: 0, reasons: [`SCAM (Claude review): ${e.review.summary}`, ...reasons] };
  if (ca?.status === 'IMPERSONATOR') return { score: 0, reasons: [ca.detail, ...reasons] };
  if (e.xPage?.status === 'NOT_FOUND' && x.handle) { score -= 3; reasons.push(`@${x.handle} does not exist on X (−3)`); }
  if (ca?.status === 'X') { score += 3; reasons.push(ca.detail); }
  else if (ca?.status === 'WEBSITE') { score += 2; reasons.push(ca.detail); }
  else if (ca && x.kind === 'ACCOUNT') reasons.push(ca.detail);
  if (e.reach) { score += e.reach.points; reasons.push(...e.reach.reasons); }
  const posts = (e.xSignals ?? []).filter(p => p.handle.toLowerCase() !== x.handle?.toLowerCase());
  if (posts.length) {
    const top = [...posts].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0]!;
    const add = (top.views ?? 0) >= 10_000 || (top.followers ?? 0) >= 10_000 ? 2 : 1;
    score += add; reasons.push(`posted on X by ${posts.length > 1 ? `${posts.length} accounts, top ` : ''}@${top.handle} (${(top.followers ?? 0).toLocaleString('en-US')} followers, ${(top.views ?? 0).toLocaleString('en-US')} views) (+${add})`);
  }
  if (e.insiders) reasons.push(e.insiders.detail);
  if (e.review) {
    const add = reviewPoints(e.review);
    score += add; reasons.push(`Claude: ${e.review.verdict} · idea ${e.review.idea}/10 · site ${e.review.professionalism}/10${e.review.aiGenerated === 'LIKELY' ? ' · looks AI-made' : ''}${add ? ` (${add > 0 ? '+' : ''}${add})` : ''}`);
  }
  return { score: Math.max(0, score), reasons };
}

/** What a clone copies: the X handle, the website host, the name with ticker. */
export function launchKeys(l: Pick<Launch, 'x' | 'site' | 'meta' | 'name' | 'symbol'>): string[] {
  const keys = [`name:${l.name.trim().toLowerCase()}|${l.symbol.trim().toLowerCase()}`];
  if (l.x.handle) keys.push(`x:${l.x.handle.toLowerCase()}`);
  const site = l.site?.url ?? projectSite(l.meta?.website ?? null);
  if (site) { try { keys.push(`site:${new URL(site).hostname.replace(/^www\./, '')}`); } catch { /* unparsable */ } }
  return keys;
}

export interface LaunchSource {
  poll(now: number): Promise<Launch[]>; recent(now: number): Launch[];
  /** Mints the desk holds: their X account keeps being re-read (a deleted account is a rug). */
  hold?(mints: string[]): void;
  /** A held launch rugged: remembered with its creator, X account and website. */
  markRug?(mint: string, reason: string): Promise<void>;
  /** Posts from the X feed that name a mint. */
  addXSignals?(signals: XSignal[], now: number): void;
  /** X-feed mints the radar has not seen launch (older, or from another launchpad). */
  xOnly?(now: number): XSignal[];
}

export interface LaunchFeedOptions {
  /** Persistent list of rugged launches (creator, X account, website). */
  rugs?: RugList | null;
  /** Claude review of a shortlisted launch; null when off or over budget. */
  review?: ((input: ReviewInput, now: number) => Promise<LaunchReview | null>) | null;
  reviewAvailable?: (now: number) => boolean;
  /** The insiders reader; defaults to the chain (creation-slot buyers). */
  insiders?: ((l: Launch) => Promise<Insiders | null>) | null;
}

/** Reads new launches from the pump.fun mint authority's signatures, one poll per scan. Never throws. */
export class LaunchFeed implements LaunchSource {
  private readonly launches = new Map<string, Launch>();
  private readonly xPages = new Map<string, { at: number; page: Promise<XPageCheck> }>();
  private readonly held = new Set<string>();
  private readonly signals = new Map<string, XSignal[]>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly insiderBusy = new Set<string>();
  private readonly reviewBusy = new Set<string>();
  private newest: string | null = null;
  constructor(
    private readonly rpc: { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> },
    private readonly fetcher: typeof fetch = fetch,
    private readonly website: (url: string | null) => Promise<WebsiteCheck> = url => checkWebsite(url, fetch, undefined, { scripts: 6 }),
    private readonly xPage: (handle: string) => Promise<XPageCheck> = handle => readXPage(handle),
    private readonly o: LaunchFeedOptions = {},
  ) {}

  recent(now: number): Launch[] {
    for (const [mint, l] of this.launches) if (now - l.at > LAUNCH.keepMs && !this.held.has(mint)) this.launches.delete(mint);
    return [...this.launches.values()].sort((a, b) => b.at - a.at);
  }

  hold(mints: string[]): void { this.held.clear(); for (const m of mints) this.held.add(m); }

  /** Waits for background insider reads and reviews (tests, shutdown). */
  async settle(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }

  async markRug(mint: string, reason: string): Promise<void> {
    const l = this.launches.get(mint);
    if (!this.o.rugs) return;
    await this.o.rugs.add({ mint, symbol: l?.symbol ?? null, at: Date.now(), reason, creator: l?.creator ?? null, xHandle: l?.x.handle ?? null,
      site: l?.site?.url ? new URL(l.site.url).hostname.replace(/^www\./, '') : null });
    if (l) { l.rug = reason; this.rate(l, Date.now()); }
  }

  addXSignals(signals: XSignal[], now: number): void {
    for (const sig of signals) {
      const list = this.signals.get(sig.mint) ?? [];
      if (!list.some(x => x.postId === sig.postId)) list.push(sig);
      this.signals.set(sig.mint, list.slice(-10));
      const l = this.launches.get(sig.mint);
      if (l) { l.xSignals = this.signals.get(sig.mint); this.rate(l, now); }
    }
    for (const [mint, list] of this.signals) if (list.every(x => now - x.postAt > 2 * 60 * 60_000)) this.signals.delete(mint);
  }

  xOnly(now: number): XSignal[] {
    return [...this.signals.entries()].filter(([mint, list]) => !this.launches.has(mint) && list.some(x => now - x.postAt <= 2 * 60 * 60_000))
      .map(([, list]) => [...list].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0]!);
  }

  async poll(now: number): Promise<Launch[]> {
    let sigs: Array<{ signature: string; blockTime?: number | null; err: unknown }> = [];
    try {
      sigs = await this.rpc.execute('launches:signatures', c => c.getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY),
        { limit: LAUNCH.pollLimit, ...(this.newest ? { until: this.newest } : {}) }, 'confirmed'));
    } catch { sigs = []; }
    if (sigs.length) this.newest = sigs[0]!.signature;
    const events: LaunchEvent[] = [];
    await Promise.all(sigs.filter(s => !s.err).map(async s => {
      try {
        const tx = await this.rpc.execute('launches:tx', async c => {
          const raw = c as unknown as { _rpcRequest(m: string, a: unknown[]): Promise<{ result?: { meta?: { logMessages?: string[] | null } | null } | null; error?: { message: string } }> };
          const res = await raw._rpcRequest('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
          if (res.error) throw new Error(res.error.message);
          return res.result ?? null;
        });
        const e = decodeCreate(tx?.meta?.logMessages ?? []);
        if (e && !this.launches.has(e.mint)) events.push({ ...e, at: (s.blockTime ?? Math.floor(now / 1000)) * 1000, signature: s.signature });
      } catch { /* one unreadable transaction never stops the radar */ }
    }));
    const fresh: Launch[] = [];
    for (let i = 0; i < events.length; i += LAUNCH.metadataConcurrency) {
      fresh.push(...await Promise.all(events.slice(i, i + LAUNCH.metadataConcurrency).map(e => this.enrich(e, now))));
    }
    // Clones copy the original's X account, website or name within minutes (KEN ×3 and ROPAD ×2 on the first live run).
    // Only the earliest launch keeps its score; every later one is marked a clone and never shortlisted — unless the
    // project's own account posts the clone's CA, which makes it the real token launched after a front-runner.
    for (const l of fresh.sort((a, b) => a.at - b.at)) {
      const keys = launchKeys(l), original = [...this.launches.values()].find(o => o.mint !== l.mint && o.at <= l.at && launchKeys(o).some(k => keys.includes(k)));
      if (original) l.clone = `CLONE of ${original.symbol} ${short(original.mint)} (same X account, website or name, launched earlier)`;
      l.xSignals = this.signals.get(l.mint);
      this.rate(l, now);
      this.launches.set(l.mint, l);
    }
    await this.reverify(now);
    this.background(now);
    this.recent(now);
    return fresh;
  }

  /**
   * Re-reads the X page (and now and then the website) of recent launches whose CA is not confirmed yet, and of held
   * launches every minute: a project posts its CA after creation; a rugger deletes the account after the dump.
   */
  private async reverify(now: number): Promise<void> {
    const due = [...this.launches.values()].filter(l => l.x.handle && (l.x.kind === 'ACCOUNT' || l.x.kind === 'POST') && !l.rug && (this.held.has(l.mint)
      ? now - (l.xCheckedAt ?? 0) >= LAUNCH.heldReverifyMs
      : l.ca.status === 'UNCONFIRMED' && now - l.at <= LAUNCH.verifyForMs && now - (l.xCheckedAt ?? 0) >= Math.max(LAUNCH.reverifyMs, (now - l.at) / 3)))
      .sort((a, b) => Number(this.held.has(b.mint)) - Number(this.held.has(a.mint)) || b.score - a.score || b.at - a.at).slice(0, LAUNCH.reverifyPerPoll);
    // Every 30 s in the first minutes, then a third of the launch's age (≈ 8 reads in 12 min): x.com is read sparingly.
    await Promise.all(due.map(async l => {
      const siteDue = l.site?.status === 'AVAILABLE' && now - (l.siteCheckedAt ?? 0) >= LAUNCH.siteReverifyMs && !this.held.has(l.mint);
      const [page, site] = await Promise.all([this.readX(l.x.handle!, now), siteDue ? this.website(l.site!.url).catch(() => null) : Promise.resolve(null)]);
      l.xPage = page; l.xCheckedAt = now;
      if (site) { l.site = site; l.siteCheckedAt = now; }
      this.rate(l, now);
    }));
  }

  /** Insider reads and Claude reviews run in the background; their results re-score the launch when they land. */
  private background(now: number): void {
    const list = [...this.launches.values()].filter(l => !l.rug && now - l.at <= LAUNCH.verifyForMs).sort((a, b) => b.score - a.score);
    const readInsidersFor = this.o.insiders === null ? null : this.o.insiders ?? ((l: Launch) => readInsiders(this.rpc, l.mint, l.creator, l.signature));
    if (readInsidersFor) for (const l of list) {
      if (this.insiderBusy.size >= LAUNCH.insiderConcurrency) break;
      if (l.insiders !== undefined || this.insiderBusy.has(l.mint) || l.score < LAUNCH.insiderMinScore || now - l.at < 15_000 || now < (l.insidersRetryAt ?? 0)) continue;
      this.insiderBusy.add(l.mint);
      // A failed read is retried twice, 20 s apart; after that the insiders stay unknown (null), which does not block.
      this.track(readInsidersFor(l).catch(() => null).then(v => {
        const tries = (l.insidersTries ?? 0) + 1;
        if (v === null && tries < 3) { l.insidersTries = tries; l.insidersRetryAt = Date.now() + 20_000; return; }
        l.insiders = v; this.rate(l, Date.now());
      }).finally(() => this.insiderBusy.delete(l.mint)));
    }
    const review = this.o.review;
    if (review) for (const l of list) {
      if (this.reviewBusy.size >= LAUNCH.reviewConcurrency || (this.o.reviewAvailable && !this.o.reviewAvailable(now))) break;
      if (l.review !== undefined || this.reviewBusy.has(l.mint) || l.score < LAUNCH.minScore || !l.xCheckedAt) continue;
      this.reviewBusy.add(l.mint);
      this.track(review(this.reviewInput(l, now), now).catch(() => null).then(v => { l.review = v; this.rate(l, Date.now()); }).finally(() => this.reviewBusy.delete(l.mint)));
    }
  }

  private track(p: Promise<void>): void { this.tasks.add(p); void p.finally(() => this.tasks.delete(p)); }

  private reviewInput(l: Launch, now: number): ReviewInput {
    const p = l.xPage?.profile ?? null;
    return { mint: l.mint, name: l.name, symbol: l.symbol, description: l.meta?.description ?? null, ageMin: (now - l.at) / 60_000,
      x: l.x.handle ? { handle: l.x.handle, kind: l.x.kind, followers: p?.followers ?? null, createdAt: p?.createdAt ?? null, bio: p?.bio ?? null,
        posts: (l.xPage?.posts ?? []).map(x => ({ text: x.text, views: x.views, likes: x.likes, at: x.at })) } : null,
      website: l.site ? { url: l.site.url, title: l.site.title, description: l.site.description, text: l.site.text ?? null } : null,
      ca: l.ca.detail, insiders: l.insiders?.detail ?? null };
  }

  private rate(l: Launch, now: number): void {
    // An account that existed and is gone now was deleted or suspended: what ruggers do after the dump (Potato).
    // Two "not found" reads in a row (≥ 30 s apart), so one x.com hiccup never sells a position.
    const st = l.xPage?.status;
    if ((st === 'READ' || st === 'NO_POSTS') && l.xPage?.profile) { l.xSeenAt ??= now; l.xMissing = 0; }
    if (st === 'NOT_FOUND' && l.xSeenAt && l.xCheckedAt !== l.xMissingAt) { l.xMissing = (l.xMissing ?? 0) + 1; l.xMissingAt = l.xCheckedAt; }
    if (st === 'NOT_FOUND' && l.xSeenAt && (l.xMissing ?? 0) >= 2 && !l.rug) l.rug = `RUG: X account @${l.x.handle} was deleted after launch`;
    if (!l.rug && this.o.rugs) {
      const site = l.site?.url ? new URL(l.site.url).hostname.replace(/^www\./, '') : null;
      l.rug = this.o.rugs.match({ mint: l.mint, creator: l.creator, xHandle: l.x.handle, site });
    }
    if (!l.rug && l.review?.verdict === 'SCAM') l.rug = `SCAM (Claude review): ${l.review.summary}`;
    l.ca = launchCa(l.mint, l.x, l.site, l.xPage);
    // The project's own account posting this CA through the X feed confirms it like its profile page would.
    if (l.ca.status === 'UNCONFIRMED' && l.x.handle && (l.xSignals ?? []).some(x => x.handle.toLowerCase() === l.x.handle!.toLowerCase()))
      l.ca = { status: 'X', detail: `@${l.x.handle} posted this CA` };
    l.reach = xReach(l.xPage, now, { own: ownAccount(l, l.xPage, now), postId: /\/status\/(\d+)/.exec(l.x.url ?? '')?.[1] ?? null });
    const { score, reasons } = scoreLaunch(l.meta, l.x, l.site, l.ca, { reach: l.reach, xPage: l.xPage, xSeenAt: l.xSeenAt, review: l.review, insiders: l.insiders,
      rug: l.rug, xSignals: l.xSignals });
    const clone = l.clone && l.ca.status !== 'X' ? l.clone : null;
    Object.assign(l, clone ? { score: 0, reasons: [clone, ...reasons] } : { score, reasons });
  }

  private readX(handle: string, now: number): Promise<XPageCheck> {
    const key = handle.toLowerCase(), hit = this.xPages.get(key);
    if (hit && now - hit.at < LAUNCH.xCacheMs) return hit.page;
    const page = this.xPage(handle).catch((): XPageCheck => ({ handle, status: 'UNAVAILABLE', detail: 'Read failed', addresses: [], claimed: [] }));
    this.xPages.set(key, { at: now, page });
    for (const [k, v] of this.xPages) if (now - v.at > LAUNCH.xCacheMs) this.xPages.delete(k);
    return page;
  }

  private async enrich(e: LaunchEvent, now: number): Promise<Launch> {
    let meta: LaunchMeta | null = null;
    try {
      const res = await this.fetcher(e.uri, { signal: AbortSignal.timeout(LAUNCH.metadataTimeoutMs), headers: { Accept: 'application/json' } });
      if (res.ok) {
        const j = await res.json() as Record<string, unknown>;
        const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null;
        meta = { description: str(j.description), twitter: str(j.twitter), website: str(j.website), telegram: str(j.telegram) };
      }
    } catch { /* metadata host slow or down */ }
    const x = parseXLink(meta?.twitter);
    // Only launches with an X link get their website fetched and their account's X page read: a few requests per scan.
    const [site, xPage] = await Promise.all([
      x.kind !== 'NONE' && projectSite(meta?.website ?? null) ? this.website(projectSite(meta!.website)).catch(() => null) : Promise.resolve(null),
      x.handle && (x.kind === 'ACCOUNT' || x.kind === 'POST') ? this.readX(x.handle, now) : Promise.resolve(null),
    ]);
    const l: Launch = { ...e, meta, x, site, xPage, xCheckedAt: xPage ? now : null, siteCheckedAt: site ? now : null,
      ca: { status: 'UNCONFIRMED', detail: '' }, clone: null, score: 0, reasons: [], shortlistedAt: null };
    this.rate(l, now);
    return l;
  }
}

/** Never bought: insiders own most of the curve. */
export const insidersBlock = (i: Insiders | null | undefined) => !!i && i.insiderPct >= RISK.maxInsiderPctAtEntry;

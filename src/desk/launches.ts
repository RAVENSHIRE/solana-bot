import { PublicKey, type Connection } from '@solana/web3.js';
import { caVerdict, checkWebsite, parseXLink, readXPage, type WebsiteCheck, type XLink, type XPageCheck } from './social';

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
});

export interface LaunchEvent { mint: string; name: string; symbol: string; uri: string; creator: string | null; at: number; signature: string }
export interface LaunchMeta { description: string | null; twitter: string | null; website: string | null; telegram: string | null }
/** Where this mint is confirmed as the project's token: X (the account posted it), WEBSITE, or IMPERSONATOR (another CA there). */
export interface LaunchCa { status: 'X' | 'WEBSITE' | 'IMPERSONATOR' | 'UNCONFIRMED'; detail: string }
export interface Launch extends LaunchEvent {
  meta: LaunchMeta | null; x: XLink; site: WebsiteCheck | null; score: number; reasons: string[];
  /** The X profile page as last read, and when; the website's last read. */
  xPage: XPageCheck | null; xCheckedAt: number | null; siteCheckedAt: number | null;
  ca: LaunchCa;
  /** Set when an earlier launch shares this one's X account, website or name. */
  clone: string | null;
  /** Set once the launch first reached the shortlist (alerted once). */
  shortlistedAt: number | null;
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
  if (onX?.verdict === 'CONTRADICTED') return { status: 'IMPERSONATOR', detail: `IMPERSONATOR: @${x.handle} shows CA ${short(onX.other!)}, not this token` };
  if (onSite?.verdict === 'CONTRADICTED') return { status: 'IMPERSONATOR', detail: `IMPERSONATOR: ${host(site)} shows CA ${short(onSite.other!)}, not this token` };
  if (onSite?.verdict === 'CONFIRMED') return { status: 'WEBSITE', detail: `${host(site)} shows this CA` };
  if (x.kind !== 'ACCOUNT') return { status: 'UNCONFIRMED', detail: 'CA not confirmed (no own X account to check)' };
  return { status: 'UNCONFIRMED', detail: xPage?.status === 'READ' || xPage?.status === 'NO_POSTS' ? `CA not posted by @${x.handle} yet`
    : `CA not checked on X (${xPage?.detail ?? 'not read yet'})` };
}

/**
 * How much this launch looks like a real project: own X account, live website that links back to it, Telegram, a
 * description, and above all the account or website showing this very contract address. An impersonator scores 0.
 */
export function scoreLaunch(meta: LaunchMeta | null, x: XLink, site: WebsiteCheck | null, ca?: LaunchCa): { score: number; reasons: string[] } {
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
  if (ca?.status === 'IMPERSONATOR') return { score: 0, reasons: [ca.detail, ...reasons] };
  if (ca?.status === 'X') { score += 3; reasons.push(ca.detail); }
  else if (ca?.status === 'WEBSITE') { score += 2; reasons.push(ca.detail); }
  else if (ca && x.kind === 'ACCOUNT') reasons.push(ca.detail);
  return { score, reasons };
}

/** What a clone copies: the X handle, the website host, the name with ticker. */
export function launchKeys(l: Pick<Launch, 'x' | 'site' | 'meta' | 'name' | 'symbol'>): string[] {
  const keys = [`name:${l.name.trim().toLowerCase()}|${l.symbol.trim().toLowerCase()}`];
  if (l.x.handle) keys.push(`x:${l.x.handle.toLowerCase()}`);
  const site = l.site?.url ?? projectSite(l.meta?.website ?? null);
  if (site) { try { keys.push(`site:${new URL(site).hostname.replace(/^www\./, '')}`); } catch { /* unparsable */ } }
  return keys;
}

export interface LaunchSource { poll(now: number): Promise<Launch[]>; recent(now: number): Launch[] }

/** Reads new launches from the pump.fun mint authority's signatures, one poll per scan. Never throws. */
export class LaunchFeed implements LaunchSource {
  private readonly launches = new Map<string, Launch>();
  private readonly xPages = new Map<string, { at: number; page: Promise<XPageCheck> }>();
  private newest: string | null = null;
  constructor(
    private readonly rpc: { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> },
    private readonly fetcher: typeof fetch = fetch,
    private readonly website: (url: string | null) => Promise<WebsiteCheck> = url => checkWebsite(url, fetch, undefined, { scripts: 6 }),
    private readonly xPage: (handle: string) => Promise<XPageCheck> = handle => readXPage(handle),
  ) {}

  recent(now: number): Launch[] {
    for (const [mint, l] of this.launches) if (now - l.at > LAUNCH.keepMs) this.launches.delete(mint);
    return [...this.launches.values()].sort((a, b) => b.at - a.at);
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
      this.rate(l);
      this.launches.set(l.mint, l);
    }
    await this.reverify(now);
    this.recent(now);
    return fresh;
  }

  /** Re-reads the X page (and now and then the website) of recent launches whose CA is not confirmed yet. */
  private async reverify(now: number): Promise<void> {
    // Every 30 s in the first minutes, then a third of the launch's age (≈ 8 reads in 12 min): x.com is read sparingly.
    const due = [...this.launches.values()].filter(l => l.x.kind === 'ACCOUNT' && l.ca.status === 'UNCONFIRMED' && now - l.at <= LAUNCH.verifyForMs &&
      now - (l.xCheckedAt ?? 0) >= Math.max(LAUNCH.reverifyMs, (now - l.at) / 3)).sort((a, b) => b.score - a.score || b.at - a.at).slice(0, LAUNCH.reverifyPerPoll);
    await Promise.all(due.map(async l => {
      const siteDue = l.site?.status === 'AVAILABLE' && now - (l.siteCheckedAt ?? 0) >= LAUNCH.siteReverifyMs;
      const [page, site] = await Promise.all([this.readX(l.x.handle!, now), siteDue ? this.website(l.site!.url).catch(() => null) : Promise.resolve(null)]);
      l.xPage = page; l.xCheckedAt = now;
      if (site) { l.site = site; l.siteCheckedAt = now; }
      this.rate(l);
    }));
  }

  private rate(l: Launch): void {
    l.ca = launchCa(l.mint, l.x, l.site, l.xPage);
    const { score, reasons } = scoreLaunch(l.meta, l.x, l.site, l.ca);
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
    // Only launches with an X link get their website fetched, and only own accounts their X page: a few requests per scan.
    const [site, xPage] = await Promise.all([
      x.kind !== 'NONE' && projectSite(meta?.website ?? null) ? this.website(projectSite(meta!.website)).catch(() => null) : Promise.resolve(null),
      x.kind === 'ACCOUNT' ? this.readX(x.handle!, now) : Promise.resolve(null),
    ]);
    const l: Launch = { ...e, meta, x, site, xPage, xCheckedAt: xPage ? now : null, siteCheckedAt: site ? now : null,
      ca: { status: 'UNCONFIRMED', detail: '' }, clone: null, score: 0, reasons: [], shortlistedAt: null };
    this.rate(l);
    return l;
  }
}

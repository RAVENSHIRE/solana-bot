import { PublicKey, type Connection } from '@solana/web3.js';
import { checkWebsite, parseXLink, type WebsiteCheck, type XLink } from './social';

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
 * which only a small share of the ~50 launches per minute have. Jupiter routes curve tokens a few minutes after creation
 * ("Pump.fun" route), which is the entry window.
 */
export const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
export const LAUNCH = Object.freeze({
  /** Launches kept in memory (and on the radar). */
  keepMs: 45 * 60_000,
  /** Signatures read per poll; at ~50 launches a minute a 20 s scan needs ~20. */
  pollLimit: 60,
  metadataTimeoutMs: 4_000,
  metadataConcurrency: 8,
  /** Score needed to be shortlisted: an own X account (3) plus a live project website (3). */
  minScore: 6,
});

export interface LaunchEvent { mint: string; name: string; symbol: string; uri: string; creator: string | null; at: number; signature: string }
export interface LaunchMeta { description: string | null; twitter: string | null; website: string | null; telegram: string | null }
export interface Launch extends LaunchEvent {
  meta: LaunchMeta | null; x: XLink; site: WebsiteCheck | null; score: number; reasons: string[];
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

/** How much this launch looks like a real project: own X account, live website that links back to it, Telegram, a description. */
export function scoreLaunch(meta: LaunchMeta | null, x: XLink, site: WebsiteCheck | null): { score: number; reasons: string[] } {
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
  return { score, reasons };
}

export interface LaunchSource { poll(now: number): Promise<Launch[]>; recent(now: number): Launch[] }

/** Reads new launches from the pump.fun mint authority's signatures, one poll per scan. Never throws. */
export class LaunchFeed implements LaunchSource {
  private readonly launches = new Map<string, Launch>();
  private newest: string | null = null;
  constructor(
    private readonly rpc: { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> },
    private readonly fetcher: typeof fetch = fetch,
    private readonly website: (url: string | null) => Promise<WebsiteCheck> = url => checkWebsite(url),
  ) {}

  recent(now: number): Launch[] {
    for (const [mint, l] of this.launches) if (now - l.at > LAUNCH.keepMs) this.launches.delete(mint);
    return [...this.launches.values()].sort((a, b) => b.at - a.at);
  }

  async poll(now: number): Promise<Launch[]> {
    let sigs: Array<{ signature: string; blockTime?: number | null; err: unknown }>;
    try {
      sigs = await this.rpc.execute('launches:signatures', c => c.getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY),
        { limit: LAUNCH.pollLimit, ...(this.newest ? { until: this.newest } : {}) }, 'confirmed'));
    } catch { return []; }
    if (!sigs.length) return [];
    this.newest = sigs[0]!.signature;
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
      fresh.push(...await Promise.all(events.slice(i, i + LAUNCH.metadataConcurrency).map(e => this.enrich(e))));
    }
    for (const l of fresh) this.launches.set(l.mint, l);
    this.recent(now);
    return fresh;
  }

  private async enrich(e: LaunchEvent): Promise<Launch> {
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
    // Only launches with an X link get their website fetched: that keeps the radar to a few requests per scan.
    const site = x.kind !== 'NONE' && projectSite(meta?.website ?? null) ? await this.website(projectSite(meta!.website)).catch(() => null) : null;
    const { score, reasons } = scoreLaunch(meta, x, site);
    return { ...e, meta, x, site, score, reasons, shortlistedAt: null };
  }
}

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { Authenticity } from './types';

// ---------------------------------------------------------------- X links

export interface XLink { kind: 'ACCOUNT' | 'POST' | 'COMMUNITY' | 'NONE'; handle: string | null; url: string | null }
const RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'settings', 'messages']);

/** A post or community link is not an account: the distinction is kept, never collapsed. */
export function parseXLink(raw: string | null | undefined): XLink {
  if (!raw) return { kind: 'NONE', handle: null, url: null };
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'NONE', handle: null, url: null }; }
  if (!/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return { kind: 'NONE', handle: null, url: null };
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i' && parts[1] === 'communities') return { kind: 'COMMUNITY', handle: null, url: url.toString() };
  const handle = parts[0] ?? '';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || RESERVED.has(handle.toLowerCase())) return { kind: 'NONE', handle: null, url: url.toString() };
  return { kind: parts[1] === 'status' ? 'POST' : 'ACCOUNT', handle, url: url.toString() };
}

// ---------------------------------------------------------------- Website

export interface WebsiteCheck {
  url: string | null; status: 'AVAILABLE' | 'UNAVAILABLE' | 'BLOCKED' | 'NONE';
  httpStatus: number | null; title: string | null; description: string | null; xHandles: string[]; detail: string;
  /** Every Solana address written on the page (and, if asked, its own scripts); `claimed`: the ones it presents as its token. */
  addresses: string[]; claimed: string[];
}

// ---------------------------------------------------------------- Contract addresses on a page

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDRESS = new RegExp(`(?<![1-9A-HJ-NP-Za-km-z])${B58}{32,44}(?![1-9A-HJ-NP-Za-km-z])`, 'g');
/** Links that name a token mint (not a pool): pump.fun, Solscan, Birdeye, GMGN, Jupiter, FOMO, Raydium swap. */
const TOKEN_LINK = new RegExp(`(?:pump\\.fun/(?:coin/)?|solscan\\.io/token/|birdeye\\.so/token/|gmgn\\.ai/sol/token/(?:[A-Za-z0-9]+_)?|jup\\.ag/(?:tokens/|swap/[A-Za-z0-9]+-)|fomo\\.family/tokens/solana/|outputMint=|outputCurrency=)(${B58}{32,44})`, 'gi');
/** "CA: …", "contract address …", ca:"…" (a site's own config), "mint: …". */
const LABELLED = new RegExp(`(?:\\bca\\b|contract(?:[\\s_-]*address)?|token[\\s_-]*address|\\bmint\\b)["'\\s:=\\-–>]{0,6}(${B58}{32,44})`, 'gi');
/** Launchpad vanity suffixes: pump.fun and letsbonk mints. */
const VANITY = /(?:pump|bonk)$/;
const NOT_A_TOKEN = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const isAddress = (s: string) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };

/** The Solana addresses in a page or post, and the ones it presents as a token's contract address. */
export function pageAddresses(text: string): { addresses: string[]; claimed: string[] } {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|\\n/g, ' ');
  const addresses = new Set<string>(), claimed = new Set<string>();
  for (const t of [text, plain]) {
    for (const m of t.matchAll(ADDRESS)) if (addresses.size < 2_000 && isAddress(m[0])) addresses.add(m[0]);
    for (const re of [TOKEN_LINK, LABELLED]) for (const m of t.matchAll(re)) if (isAddress(m[1]!)) claimed.add(m[1]!);
  }
  for (const a of addresses) if (VANITY.test(a)) claimed.add(a);
  for (const a of NOT_A_TOKEN) claimed.delete(a);
  return { addresses: [...addresses], claimed: [...claimed].slice(0, 20) };
}

export type CaVerdict = 'CONFIRMED' | 'CONTRADICTED' | 'NONE';
/** CONFIRMED: the page writes this mint. CONTRADICTED: it presents another token as its contract address and never this one. */
export function caVerdict(mint: string, page: { addresses: string[]; claimed: string[] } | null): { verdict: CaVerdict; other: string | null } {
  if (!page) return { verdict: 'NONE', other: null };
  if (page.addresses.includes(mint) || page.claimed.includes(mint)) return { verdict: 'CONFIRMED', other: null };
  return page.claimed.length ? { verdict: 'CONTRADICTED', other: page.claimed[0]! } : { verdict: 'NONE', other: null };
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !PRIVATE_V4.some(r => r.test(ip));
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff'));
}

type Resolver = (host: string) => Promise<string[]>;
const resolveAll: Resolver = async host => (await lookup(host, { all: true })).map(a => a.address);

/** Project websites are untrusted input: https only, public addresses only, bounded size and time. */
export async function checkWebsite(raw: string | null, fetcher: typeof fetch = fetch, resolve: Resolver = resolveAll, o: { scripts?: number } = {}): Promise<WebsiteCheck> {
  const none: WebsiteCheck = { url: raw, status: 'NONE', httpStatus: null, title: null, description: null, xHandles: [], detail: 'No website listed', addresses: [], claimed: [] };
  if (!raw) return none;
  let url: URL;
  try { url = new URL(raw); } catch { return { ...none, status: 'BLOCKED', detail: 'Invalid URL' }; }
  for (let hop = 0; hop < 4; hop++) {
    const blocked = await unsafeTarget(url, resolve);
    if (blocked) return { ...none, url: url.toString(), status: 'BLOCKED', detail: blocked };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const res = await fetcher(url, { redirect: 'manual', signal: controller.signal, credentials: 'omit',
        headers: { Accept: 'text/html', 'User-Agent': 'solana-desk-evidence/1.0' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url);
        continue;
      }
      if (!res.ok) return { ...none, url: url.toString(), status: 'UNAVAILABLE', httpStatus: res.status, detail: `HTTP ${res.status}` };
      const html = await boundedText(res, 300_000);
      const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() ?? null;
      const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i.exec(html)?.[1]?.trim() ?? null;
      const xHandles = [...new Set([...html.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=[/"'?#\s])/gi)]
        .map(m => m[1]!.toLowerCase()).filter(h => !RESERVED.has(h)))].slice(0, 5);
      let found = pageAddresses(html);
      // Client-rendered sites keep their contract address in their own script bundles (stashd.fun: ca:"3Bdwh…pump").
      if (o.scripts && !found.claimed.length) found = mergeAddresses(found, await siteScripts(url, html, o.scripts, fetcher, resolve));
      return { url: url.toString(), status: 'AVAILABLE', httpStatus: res.status, title, description, xHandles, detail: `HTTP ${res.status}`, ...found };
    } catch (error) {
      return { ...none, url: url.toString(), status: 'UNAVAILABLE', detail: (error as Error).name === 'AbortError' ? 'Timed out' : 'Connection failed' };
    } finally { clearTimeout(timer); }
  }
  return { ...none, url: url.toString(), status: 'UNAVAILABLE', detail: 'Too many redirects' };
}

const mergeAddresses = (a: { addresses: string[]; claimed: string[] }, b: { addresses: string[]; claimed: string[] }) =>
  ({ addresses: [...new Set([...a.addresses, ...b.addresses])], claimed: [...new Set([...a.claimed, ...b.claimed])].slice(0, 20) });

/** The site's own (same-origin) scripts, newest-loaded last, bounded in count, size and time. */
async function siteScripts(page: URL, html: string, max: number, fetcher: typeof fetch, resolve: Resolver): Promise<{ addresses: string[]; claimed: string[] }> {
  let found = { addresses: [] as string[], claimed: [] as string[] };
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => { try { return new URL(m[1]!, page); } catch { return null; } })
    .filter((u): u is URL => !!u && u.origin === page.origin).map(u => u.toString()))].slice(-max);
  for (const src of srcs) {
    const url = new URL(src);
    if (await unsafeTarget(url, resolve)) continue;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const res = await fetcher(url, { redirect: 'manual', signal: controller.signal, credentials: 'omit', headers: { 'User-Agent': 'solana-desk-evidence/1.0' } });
      if (res.ok) found = mergeAddresses(found, pageAddresses(await boundedText(res, 600_000)));
    } catch { /* one slow script never fails the website check */ } finally { clearTimeout(timer); }
    if (found.claimed.length) break;
  }
  return found;
}

async function unsafeTarget(url: URL, resolve: Resolver): Promise<string | null> {
  if (url.protocol !== 'https:') return 'Only https websites are checked';
  if (url.username || url.password || (url.port && url.port !== '443')) return 'Credentials or non-standard port';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || /^(localhost|.*\.(local|internal|lan|home|localhost))$/i.test(host)) return 'Private or literal host';
  try {
    const addresses = await resolve(host);
    if (!addresses.length || !addresses.every(isPublicAddress)) return 'Resolves to a private address';
  } catch { return 'DNS lookup failed'; }
  return null;
}

async function boundedText(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value); size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

// ---------------------------------------------------------------- X account data (optional API access)

export interface XAccount {
  handle: string; createdAt: number; followers: number; following: number; posts: number;
  profileUrl: string | null; description: string; recent: Array<{ at: number; engagement: number }>;
}
const xUser = z.object({ data: z.object({ id: z.string(), username: z.string(), created_at: z.string().datetime(), description: z.string().default(''),
  url: z.string().nullish(), entities: z.object({ url: z.object({ urls: z.array(z.object({ expanded_url: z.string().optional() })).optional() }).optional() }).optional(),
  public_metrics: z.object({ followers_count: z.number(), following_count: z.number(), tweet_count: z.number() }) }) });
const xPosts = z.object({ data: z.array(z.object({ created_at: z.string().datetime(),
  public_metrics: z.object({ like_count: z.number(), reply_count: z.number(), retweet_count: z.number(), quote_count: z.number().default(0) }) })).default([]) });

/** Reads public account metrics with the user's own X API bearer token. Without one, every X field stays UNVERIFIED. */
export class XClient {
  private readonly cache = new Map<string, { at: number; value: XAccount | null }>();
  constructor(private readonly token: string | null, private readonly fetcher: typeof fetch = fetch) {}
  get configured(): boolean { return !!this.token; }
  async account(handle: string): Promise<XAccount | null> {
    if (!this.token) return null;
    const key = handle.toLowerCase(), cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.value;
    let value: XAccount | null = null;
    try {
      const user = xUser.parse(await this.get(`/2/users/by/username/${encodeURIComponent(handle)}?user.fields=created_at,public_metrics,description,url,entities`)).data;
      const posts = xPosts.parse(await this.get(`/2/users/${user.id}/tweets?max_results=10&tweet.fields=created_at,public_metrics`)).data;
      value = { handle: user.username, createdAt: Date.parse(user.created_at), followers: user.public_metrics.followers_count,
        following: user.public_metrics.following_count, posts: user.public_metrics.tweet_count, description: user.description,
        profileUrl: user.entities?.url?.urls?.[0]?.expanded_url ?? user.url ?? null,
        recent: posts.map(p => ({ at: Date.parse(p.created_at), engagement: p.public_metrics.like_count + p.public_metrics.reply_count + p.public_metrics.retweet_count + p.public_metrics.quote_count })) };
    } catch { value = null; }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
  private async get(path: string): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await this.fetcher(`https://api.x.com${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
      if (!res.ok) throw new Error(`X API ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
}

// ---------------------------------------------------------------- X profile page (no API key)

export interface XPageCheck {
  handle: string; status: 'READ' | 'NO_POSTS' | 'UNAVAILABLE'; detail: string;
  /** Addresses in the account's recent posts as x.com serves them without login. */
  addresses: string[]; claimed: string[];
}
/**
 * The account's public profile page: x.com renders its recent posts (pinned first) into the page for logged-out
 * browsers, which is where a project posts "ca: …". Bounded in size and time; any failure is UNAVAILABLE, never an error.
 */
export async function readXPage(handle: string, fetcher: typeof fetch = fetch): Promise<XPageCheck> {
  const none = { addresses: [], claimed: [] };
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { handle, status: 'UNAVAILABLE', detail: 'Invalid handle', ...none };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetcher(`https://x.com/${handle}`, { redirect: 'follow', signal: controller.signal, credentials: 'omit',
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' } });
    if (!res.ok) return { handle, status: 'UNAVAILABLE', detail: `HTTP ${res.status}`, ...none };
    const html = await boundedText(res, 2_000_000);
    if (!/full_text|tweetText/.test(html)) return { handle, status: 'NO_POSTS', detail: 'No posts readable on the profile page', ...none };
    return { handle, status: 'READ', detail: 'Profile page read', ...pageAddresses(html) };
  } catch (error) {
    return { handle, status: 'UNAVAILABLE', detail: (error as Error).name === 'AbortError' ? 'Timed out' : 'Connection failed', ...none };
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- Authenticity

export interface AuthenticityInput {
  link: XLink; account: XAccount | null; xApiConfigured: boolean;
  projectStartedAt: number | null; website: WebsiteCheck; now: number;
}
export interface AuthenticityResult {
  authenticity: Authenticity; flags: string[]; posts7d: number | null; engagementRatePct: number | null; identityLinked: boolean | null;
}
const DAY = 86_400_000;
/** Old accounts are never proof of legitimacy: a gap between account and project age is surfaced, not rewarded. */
export function assessAuthenticity(i: AuthenticityInput): AuthenticityResult {
  const flags: string[] = [];
  if (i.link.kind === 'NONE') return { authenticity: 'UNVERIFIED', flags: ['No X account linked'], posts7d: null, engagementRatePct: null, identityLinked: null };
  if (i.link.kind === 'COMMUNITY') return { authenticity: 'UNVERIFIED', flags: ['Links an X community, not an account'], posts7d: null, engagementRatePct: null, identityLinked: null };
  if (i.link.kind === 'POST') flags.push(`Links a single post by @${i.link.handle}, not the project account`);
  const a = i.account;
  if (!a) {
    flags.push(i.xApiConfigured ? `X account data for @${i.link.handle} unavailable` : 'X account data not available (no X API access configured)');
    return { authenticity: 'UNVERIFIED', flags, posts7d: null, engagementRatePct: null, identityLinked: null };
  }
  const posts7d = a.recent.filter(p => i.now - p.at <= 7 * DAY).length;
  const engagement = a.recent.length ? a.recent.reduce((s, p) => s + p.engagement, 0) / a.recent.length : 0;
  const engagementRatePct = a.followers > 0 ? engagement / a.followers * 100 : null;
  const host = i.website.status === 'AVAILABLE' && i.website.url ? new URL(i.website.url).hostname.replace(/^www\./, '') : null;
  const identityLinked = host ? i.website.xHandles.includes(a.handle.toLowerCase()) &&
    `${a.profileUrl ?? ''} ${a.description}`.toLowerCase().includes(host) : null;
  let mismatch = false, anomaly = false;
  if (i.projectStartedAt !== null && i.projectStartedAt - a.createdAt > 365 * DAY) {
    mismatch = true;
    flags.push(`SOCIAL AGE MISMATCH: X account ${new Date(a.createdAt).getUTCFullYear()}, project activity ${new Date(i.projectStartedAt).getUTCFullYear()}; continuous project identity UNVERIFIED`);
  }
  if (a.followers >= 5_000 && engagementRatePct !== null && engagementRatePct < 0.05) {
    anomaly = true; flags.push(`Engagement ${engagementRatePct.toFixed(3)}% is far below ${a.followers.toLocaleString('en-US')} followers`);
  }
  if (posts7d === 0) flags.push('No posts in the last 7 days');
  flags.push('Username/profile change history: UNVERIFIED (not exposed by the X API)');
  const authenticity: Authenticity = mismatch && (anomaly || posts7d === 0) ? 'SUSPICIOUS' : mismatch || anomaly ? 'UNCERTAIN'
    : identityLinked && posts7d > 0 ? 'VERIFIED' : posts7d > 0 ? 'LIKELY' : 'UNCERTAIN';
  return { authenticity, flags, posts7d, engagementRatePct, identityLinked };
}

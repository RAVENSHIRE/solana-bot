import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
export async function checkWebsite(raw: string | null, fetcher: typeof fetch = fetch, resolve: Resolver = resolveAll): Promise<WebsiteCheck> {
  const none: WebsiteCheck = { url: raw, status: 'NONE', httpStatus: null, title: null, description: null, xHandles: [], detail: 'No website listed' };
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
      return { url: url.toString(), status: 'AVAILABLE', httpStatus: res.status, title, description, xHandles, detail: `HTTP ${res.status}` };
    } catch (error) {
      return { ...none, url: url.toString(), status: 'UNAVAILABLE', detail: (error as Error).name === 'AbortError' ? 'Timed out' : 'Connection failed' };
    } finally { clearTimeout(timer); }
  }
  return { ...none, url: url.toString(), status: 'UNAVAILABLE', detail: 'Too many redirects' };
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

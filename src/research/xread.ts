/**
 * An X account's profile and recent posts without the X API: the fxtwitter mirror's public JSON (no login, no key).
 * A post's time comes from the mirror and, failing that, from its id (X ids carry their creation time), so a CA post
 * is dated exactly however late it is read. Unofficial service: errors and rate limits are expected and recorded.
 */
export interface XProfileFacts {
  handle: string; followers: number | null; following: number | null; statuses: number | null; joinedAt: number | null;
  /** A checkmark, and its kind: "individual" (blue, bought), "business" (gold, an organisation), "government" (grey). */
  verified: boolean | null; verifiedType: string | null; website: string | null; bio: string | null;
}
export interface XPostFacts {
  id: string; at: number; author: string | null; text: string; views: number | null; likes: number | null; reposts: number | null;
  replies: number | null; quotes: number | null; repost: boolean; replyTo: string | null;
  /** The post's text, link facets, card and quoted text as JSON (not the author's profile): searched for contract addresses. */
  raw: string;
}
export interface XRead { status: 'OK' | 'NOT_FOUND' | 'RATE_LIMITED' | 'ERROR'; http: number | null; profile: XProfileFacts | null; posts: XPostFacts[]; detail: string }

export const snowflakeMs = (id: string): number | null => { try { return Number((BigInt(id) >> 22n) + 1288834974657n); } catch { return null; } };
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown) => typeof v === 'string' ? v : null;

type FxAuthor = { screen_name?: string; followers?: number; following?: number; statuses?: number; tweets?: number; joined?: string; description?: string;
  website?: { url?: string } | null; verification?: { verified?: boolean; type?: string | null } | null };
type FxPost = { id?: string; text?: string; author?: FxAuthor; created_timestamp?: number; views?: number; likes?: number; reposts?: number; replies?: number; quotes?: number;
  reposted_by?: unknown; replying_to?: string | null; raw_text?: unknown; card?: unknown; quote?: { text?: string } | null };

export function profileFacts(handle: string, a: FxAuthor | null | undefined): XProfileFacts | null {
  if (!a) return null;
  const joined = a.joined ? Date.parse(a.joined) : NaN;
  return { handle: a.screen_name ?? handle, followers: num(a.followers), following: num(a.following), statuses: num(a.statuses ?? a.tweets),
    joinedAt: Number.isFinite(joined) ? joined : null, verified: typeof a.verification?.verified === 'boolean' ? a.verification.verified : null,
    verifiedType: a.verification?.verified ? text(a.verification.type) : null,
    website: text(a.website?.url), bio: text(a.description) };
}

export function postFacts(p: FxPost): XPostFacts | null {
  if (!p.id || !/^\d+$/.test(p.id)) return null;
  const at = typeof p.created_timestamp === 'number' ? p.created_timestamp * 1000 : snowflakeMs(p.id);
  if (at === null) return null;
  return { id: p.id, at, author: p.author?.screen_name ?? null, text: p.text ?? '', views: num(p.views), likes: num(p.likes), reposts: num(p.reposts),
    replies: num(p.replies), quotes: num(p.quotes), repost: !!p.reposted_by, replyTo: text(p.replying_to),
    raw: JSON.stringify({ t: p.text ?? '', r: p.raw_text ?? null, c: p.card ?? null, q: p.quote?.text ?? null }) };
}

async function getJson(url: string, fetcher: typeof fetch): Promise<{ http: number; body: Record<string, unknown> | null }> {
  const res = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { http: res.status, body };
}

export async function readXTimeline(handle: string, fetcher: typeof fetch = fetch): Promise<XRead> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { status: 'ERROR', http: null, profile: null, posts: [], detail: 'invalid handle' };
  try {
    const r = await getJson(`https://api.fxtwitter.com/2/profile/${handle}/statuses`, fetcher);
    if (r.http === 429) return { status: 'RATE_LIMITED', http: 429, profile: null, posts: [], detail: 'rate limited' };
    const results = Array.isArray(r.body?.results) ? r.body!.results as FxPost[] : [];
    const posts = results.map(postFacts).filter((p): p is XPostFacts => !!p);
    const own = results.find(p => p.author?.screen_name?.toLowerCase() === handle.toLowerCase())?.author;
    if (own) return { status: 'OK', http: r.http, profile: profileFacts(handle, own), posts, detail: `${posts.length} posts` };
    // No own post on the timeline (a new account, or reposts only): the profile endpoint has the account itself.
    const p = await getJson(`https://api.fxtwitter.com/${handle}`, fetcher);
    if (p.http === 429) return { status: 'RATE_LIMITED', http: 429, profile: null, posts, detail: 'rate limited' };
    const user = p.body?.user as FxAuthor | undefined;
    if (p.http === 404 || p.body?.code === 404 || (!user && r.http === 404)) return { status: 'NOT_FOUND', http: p.http, profile: null, posts: [], detail: 'account not found' };
    if (!user) return { status: 'ERROR', http: p.http, profile: null, posts, detail: `no profile (HTTP ${p.http})` };
    return { status: 'OK', http: p.http, profile: profileFacts(handle, user), posts, detail: `${posts.length} posts` };
  } catch (error) {
    return { status: 'ERROR', http: null, profile: null, posts: [], detail: (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message.slice(0, 80) };
  }
}

const B58 = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
/** Whether a post names this mint, and the first other contract-like address it names (a pump.fun one preferred). */
export function postAddresses(raw: string, mint: string): { mint: boolean; other: string | null } {
  const found = [...new Set(raw.match(B58) ?? [])];
  const others = found.filter(a => a !== mint && !/^\d+$/.test(a));
  return { mint: found.includes(mint), other: others.find(a => a.endsWith('pump')) ?? others[0] ?? null };
}

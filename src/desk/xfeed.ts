import { z } from 'zod';
import { pageAddresses } from './social';
import type { XSignal } from './launches';

/**
 * X feed: recent posts on X that name a Solana token, read with the owner's X API bearer token (X_BEARER_TOKEN in .env).
 * This is the direct "project posts its CA" signal — the @glabuz entry came 79 s after Meme Industries' first post —
 * plus callers and communities posting a fresh CA. Each post becomes an XSignal: the mint, the author's followers and
 * account age, the post's views and likes. The launch radar scores it; X-feed tokens it did not see launch are scanned
 * like any other candidate.
 *
 * Polled every 30 s (recent search; the Basic tier allows 60 requests per 15 min). Without a token the feed is off.
 */
export const XFEED = Object.freeze({
  pollMs: 30_000,
  /** Default search: launch posts and CA posts on Solana, no reposts. Override with DESK_X_QUERY. */
  query: '("ca:" OR "CA:" OR "pump.fun" OR "contract address" OR "just launched" OR "now live") (solana OR $SOL OR pump OR sol) -is:retweet',
  maxResults: 100,
  timeoutMs: 10_000,
  /** After 401/402/403 (token, plan or no credits): asked again only this much later. */
  hardFailureMs: 6 * 3_600_000,
});

const Post = z.object({ id: z.string(), text: z.string(), author_id: z.string().optional(), created_at: z.string().datetime(),
  note_tweet: z.object({ text: z.string() }).optional(),
  entities: z.object({ urls: z.array(z.object({ expanded_url: z.string().optional() })).optional() }).optional(),
  public_metrics: z.object({ like_count: z.number().default(0), impression_count: z.number().optional() }).optional() });
const User = z.object({ id: z.string(), username: z.string(), created_at: z.string().datetime().optional(),
  public_metrics: z.object({ followers_count: z.number() }).optional() });
const Search = z.object({ data: z.array(Post).default([]), includes: z.object({ users: z.array(User).default([]) }).default({ users: [] }),
  meta: z.object({ newest_id: z.string().optional() }).optional() });

export interface XFeedStatus { configured: boolean; lastPollAt: number | null; lastError: string | null; posts: number; signals: number; nextAllowedAt: number | null }

/** The tokens a post names: pump.fun / launchpad mints, labelled CAs, token links in the text or its expanded URLs. */
export function postMints(text: string, urls: string[]): string[] {
  return pageAddresses(`${text}\n${urls.join('\n')}`).claimed;
}

export class XFeed {
  private sinceId: string | null = null;
  private lastPoll = 0;
  private readonly state: XFeedStatus;
  constructor(private readonly token: string | null, private readonly fetcher: typeof fetch = fetch, private readonly query: string = XFEED.query) {
    this.state = { configured: !!token, lastPollAt: null, lastError: token ? null : 'X_BEARER_TOKEN not set in .env', posts: 0, signals: 0, nextAllowedAt: null };
  }
  get configured(): boolean { return !!this.token; }
  status(): XFeedStatus { return { ...this.state }; }

  /** New posts since the last poll that name a token; [] when off, rate-limited or between polls. Never throws. */
  async poll(now: number): Promise<XSignal[]> {
    if (!this.token || now - this.lastPoll < XFEED.pollMs || (this.state.nextAllowedAt && now < this.state.nextAllowedAt)) return [];
    this.lastPoll = now;
    const params = new URLSearchParams({ query: this.query, max_results: String(XFEED.maxResults), expansions: 'author_id',
      'tweet.fields': 'created_at,public_metrics,entities,note_tweet,author_id', 'user.fields': 'created_at,public_metrics,username' });
    if (this.sinceId) params.set('since_id', this.sinceId);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), XFEED.timeoutMs);
    try {
      const res = await this.fetcher(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        this.state.nextAllowedAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 15 * 60_000;
        this.state.lastError = 'X API rate limit; waiting for the window to reset';
        return [];
      }
      if (!res.ok) {
        // 402: the X developer account has no paid search access or credits; 401/403: token or plan. Neither fixes
        // itself, so the feed asks again only every 6 h (a restart after a change to the plan or .env asks at once).
        const hard = [401, 402, 403].includes(res.status);
        if (hard) this.state.nextAllowedAt = now + XFEED.hardFailureMs;
        const next = hard ? ` · paused, next try ${new Date(this.state.nextAllowedAt!).toISOString().slice(11, 16)} UTC` : '';
        this.state.lastError = (res.status === 402 ? 'X API HTTP 402: payment required — this X developer account has no search credits or paid plan'
          : `X API HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (token invalid or plan without search)' : ''}`) + next;
        return [];
      }
      const body = Search.safeParse(await res.json());
      if (!body.success) { this.state.lastError = 'X API answered in an unexpected format'; return []; }
      this.state.lastError = null; this.state.nextAllowedAt = null; this.state.lastPollAt = now;
      if (body.data.meta?.newest_id) this.sinceId = body.data.meta.newest_id;
      const users = new Map(body.data.includes.users.map(u => [u.id, u]));
      const out: XSignal[] = [];
      for (const p of body.data.data) {
        const u = p.author_id ? users.get(p.author_id) : undefined;
        const text = p.note_tweet?.text ?? p.text, urls = (p.entities?.urls ?? []).map(x => x.expanded_url ?? '').filter(Boolean);
        for (const mint of postMints(text, urls)) out.push({ mint, handle: u?.username ?? 'unknown', followers: u?.public_metrics?.followers_count ?? null,
          accountCreatedAt: u?.created_at ? Date.parse(u.created_at) : null, postId: p.id, postAt: Date.parse(p.created_at),
          views: p.public_metrics?.impression_count ?? null, likes: p.public_metrics?.like_count ?? 0, text: text.slice(0, 280) });
      }
      this.state.posts += body.data.data.length; this.state.signals += out.length;
      return out;
    } catch (error) {
      this.state.lastError = (error as Error).name === 'AbortError' ? 'X API timed out' : 'X API unreachable';
      return [];
    } finally { clearTimeout(timer); }
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

/**
 * Launch review: Claude reads what a new launch shows the world — the idea, the website, the X account and its posts —
 * and rates it the way the owner does by eye (the @glabuz / Meme Industries pattern: a real idea, a designed website,
 * a demo, a young account whose launch post draws thousands of views), and looks for scam signs: a copied brand,
 * a drainer warning, a "send SOL" giveaway, a stolen identity. One short request per shortlisted launch, rate-limited;
 * the desk uses the verdict as one more score component, and SCAM blocks the entry.
 *
 * Everything sent is public (metadata, website text, public posts). The API key stays in the local server.
 */
export const REVIEW_MODEL = 'claude-opus-5-5';
export const REVIEW = Object.freeze({ maxPerHour: 20, timeoutMs: 45_000 });

const Verdict = z.object({
  verdict: z.enum(['STRONG', 'OK', 'WEAK', 'SCAM']).describe('STRONG: a real, original, well-built project with traction; OK: plausible; WEAK: low effort or generic; SCAM: clear signs of fraud or impersonation'),
  idea: z.number().describe('0–10: how original and catchy the idea or narrative is for the memecoin space right now'),
  professionalism: z.number().describe('0–10: website and X presence — design, real content, demo or product, consistency'),
  aiGenerated: z.enum(['LIKELY', 'POSSIBLE', 'UNLIKELY']).describe('Whether the website and posts look like low-effort AI output'),
  scamSignals: z.array(z.string()).describe('Concrete scam or rug signs seen in the material, empty if none'),
  summary: z.string().describe('One or two sentences for the trader'),
});
export type LaunchReview = z.infer<typeof Verdict> & { model: string; at: number };

export interface ReviewInput {
  mint: string; name: string; symbol: string; description: string | null; ageMin: number;
  x: { handle: string | null; kind: string; followers: number | null; createdAt: number | null; bio: string | null;
    posts: Array<{ text: string; views: number | null; likes: number; at: number }> } | null;
  website: { url: string | null; title: string | null; description: string | null; text: string | null } | null;
  ca: string; insiders: string | null;
}

const SYSTEM = `You review brand-new Solana memecoin launches (pump.fun) for a trader who buys minutes after launch with very small size.

You get what the launch shows publicly: token name and description, the project website (title, meta description, visible text), and the linked X account (followers, creation date, bio, recent posts with view counts). Judge it like an experienced memecoin trader:
- Strong launches have a fresh, catchy idea that fits what the space is excited about now (a product, a culture moment, a funny or clever narrative), a designed website with real content (not a template or one line), an X account whose launch post draws real views (thousands of views for an account created days or weeks ago is strong), demo videos or a working product, and a consistent identity across token, site and X.
- Weak launches are generic, copied from a trending coin, empty websites, AI-written filler, accounts with no reach.
- Scam signs: the website or X shows a different contract address, warnings about drainers or fake links, giveaways asking to send SOL, impersonation of a known brand or person, wallet-connect "claim" pages, a deleted or brand-new account pretending to be established.
Be calibrated: most launches are WEAK. STRONG is rare. Say SCAM only for concrete signs. Never invent facts that are not in the material; missing information is not a scam sign.`;

const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function reviewPrompt(i: ReviewInput, now: number): string {
  const day = (t: number | null) => t ? `${Math.max(0, Math.round((now - t) / 86_400_000))} days ago` : 'unknown';
  const lines = [
    `Token: ${clip(i.name, 80)} ($${clip(i.symbol, 20)}), launched ${Math.round(i.ageMin)} min ago, mint ${i.mint}`,
    `Description: ${clip(i.description, 600) || '(none)'}`,
    `Contract address check: ${i.ca}`,
    i.insiders ? `On-chain: ${i.insiders}` : null,
    i.website ? `Website ${i.website.url ?? ''}\n  title: ${clip(i.website.title, 160)}\n  meta description: ${clip(i.website.description, 300)}\n  visible text: ${clip(i.website.text, 2_500) || '(none)'}` : 'Website: none',
    i.x ? `X (${i.x.kind.toLowerCase()} link) @${i.x.handle ?? '?'}: ${i.x.followers ?? 'unknown'} followers, account created ${day(i.x.createdAt)}\n  bio: ${clip(i.x.bio, 300)}\n  recent posts:\n${
      i.x.posts.slice(0, 8).map(p => `  - [${Math.max(0, Math.round((now - p.at) / 60_000))} min ago, ${p.views ?? '?'} views, ${p.likes} likes] ${clip(p.text, 280)}`).join('\n') || '  (none readable)'}` : 'X: none',
  ];
  return lines.filter(Boolean).join('\n');
}

/** One launch reviewer (Claude, Gemini, or several in turn). */
export interface Reviewer {
  available(now: number): boolean;
  status(): string;
  review(input: ReviewInput, now?: number): Promise<LaunchReview | null>;
  /** Out of service after a hard failure (no credits, key rejected) until this time; 0 when fine. */
  downUntil(): number;
}
/** Hard failures (no credits, a rejected key) take a reviewer out of the rotation this long. */
export const REVIEWER_COOLDOWN_MS = 30 * 60_000;

export class LaunchReviewer implements Reviewer {
  private readonly client: Anthropic;
  private readonly used: number[] = [];
  private readonly stats = { sent: 0, ok: 0, failed: 0, lastError: null as string | null };
  private down = 0;
  downUntil(): number { return this.down; }
  constructor(apiKey: string, client?: Anthropic, private readonly maxPerHour: number = REVIEW.maxPerHour) {
    this.client = client ?? new Anthropic({ apiKey, timeout: REVIEW.timeoutMs, maxRetries: 1 });
  }

  /** Whether another review fits in the hourly budget (counted when a request is sent). */
  available(now: number): boolean {
    while (this.used.length && now - this.used[0]! > 3_600_000) this.used.shift();
    return this.used.length < this.maxPerHour;
  }

  /** For the dashboard: reviews sent, answered, failed, and the last failure. */
  status(): string {
    const s = this.stats;
    return `Claude review: ${s.ok} done${s.failed ? `, ${s.failed} failed (${s.lastError})` : ''}, ${this.used.length}/${this.maxPerHour} this hour`;
  }

  /** Null on any failure, refusal or cut-off answer: a missing review never blocks or boosts a launch. */
  async review(input: ReviewInput, now = Date.now()): Promise<LaunchReview | null> {
    if (!this.available(now)) return null;
    this.used.push(now); this.stats.sent++;
    try {
      const response = await this.client.beta.messages.parse({
        model: REVIEW_MODEL, max_tokens: 4_000, system: SYSTEM,
        messages: [{ role: 'user', content: reviewPrompt(input, now) }],
        // Low effort: a quick, calibrated read in seconds, not a research task.
        output_config: { effort: 'low', format: betaZodOutputFormat(Verdict) },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' || !response.parsed_output) {
        this.stats.failed++; this.stats.lastError = response.stop_reason ?? 'no answer'; return null;
      }
      const out = response.parsed_output;
      this.stats.ok++;
      return { ...out, idea: Math.max(0, Math.min(10, out.idea)), professionalism: Math.max(0, Math.min(10, out.professionalism)),
        scamSignals: out.scamSignals.slice(0, 5).map(s => clip(s, 160)), summary: clip(out.summary, 300), model: response.model, at: now };
    } catch (error) {
      this.stats.failed++;
      if (/credit balance is too low/i.test((error as Error).message ?? '') || error instanceof Anthropic.AuthenticationError) this.down = now + REVIEWER_COOLDOWN_MS;
      this.stats.lastError = /credit balance is too low/i.test((error as Error).message ?? '') ? 'no API credits — add credits under Plans & Billing in the Anthropic console'
        : error instanceof Anthropic.AuthenticationError ? 'API key rejected' : error instanceof Anthropic.RateLimitError ? 'rate limited'
        : error instanceof Anthropic.APIConnectionError ? 'offline' : error instanceof Anthropic.APIError ? `API ${error.status}` : 'failed';
      return null;
    }
  }
}

/**
 * Gemini as a second reviewer (GEMINI_API_KEY): the same prompt and verdict schema through Google's REST API. The
 * model comes from GEMINI_MODEL; if Google no longer serves it, the newest "flash" model the key can use is picked.
 */
export const GEMINI = Object.freeze({ base: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash' });
const GEMINI_SCHEMA = {
  type: 'OBJECT', required: ['verdict', 'idea', 'professionalism', 'aiGenerated', 'scamSignals', 'summary'],
  properties: {
    verdict: { type: 'STRING', enum: ['STRONG', 'OK', 'WEAK', 'SCAM'] }, idea: { type: 'NUMBER' }, professionalism: { type: 'NUMBER' },
    aiGenerated: { type: 'STRING', enum: ['LIKELY', 'POSSIBLE', 'UNLIKELY'] }, scamSignals: { type: 'ARRAY', items: { type: 'STRING' } }, summary: { type: 'STRING' },
  },
};
export class GeminiReviewer implements Reviewer {
  private readonly used: number[] = [];
  private readonly stats = { sent: 0, ok: 0, failed: 0, lastError: null as string | null };
  private down = 0;
  private modelChecked = false;
  constructor(private readonly apiKey: string, private model: string = GEMINI.defaultModel, private readonly fetcher: typeof fetch = fetch,
    private readonly maxPerHour: number = REVIEW.maxPerHour) {}
  downUntil(): number { return this.down; }
  available(now: number): boolean {
    while (this.used.length && now - this.used[0]! > 3_600_000) this.used.shift();
    return this.used.length < this.maxPerHour;
  }
  status(): string {
    const s = this.stats;
    return `Gemini review (${this.model}): ${s.ok} done${s.failed ? `, ${s.failed} failed (${s.lastError})` : ''}, ${this.used.length}/${this.maxPerHour} this hour`;
  }
  private async call(input: ReviewInput, now: number): Promise<Response> {
    return this.fetcher(`${GEMINI.base}/models/${this.model}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(REVIEW.timeoutMs),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: reviewPrompt(input, now) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.2, maxOutputTokens: 2_048 } }) });
  }
  /** The newest "flash" model this key can call, when the configured one is gone. */
  private async pickModel(): Promise<boolean> {
    if (this.modelChecked) return false;
    this.modelChecked = true;
    const res = await this.fetcher(`${GEMINI.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.apiKey }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const list = res?.ok ? ((await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> }).models ?? [] : [];
    const flash = list.filter(m => m.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini-[\d.]+-flash$/.test(m.name))
      .map(m => m.name.slice('models/'.length)).sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)));
    if (!flash[0] || flash[0] === this.model) return false;
    this.model = flash[0];
    return true;
  }
  async review(input: ReviewInput, now = Date.now()): Promise<LaunchReview | null> {
    if (!this.available(now)) return null;
    this.used.push(now); this.stats.sent++;
    try {
      let res = await this.call(input, now);
      if (res.status === 404 && await this.pickModel()) res = await this.call(input, now);
      if (res.status === 401 || res.status === 403) { this.down = now + REVIEWER_COOLDOWN_MS; throw new Error(`API key rejected (HTTP ${res.status})`); }
      if (res.status === 429) throw new Error('rate limited or out of quota');
      if (!res.ok) throw new Error(`API ${res.status}`);
      const body = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> };
      const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      const out = Verdict.safeParse(JSON.parse(text));
      if (!out.success) throw new Error(`unreadable answer (${body.candidates?.[0]?.finishReason ?? 'no reason'})`);
      this.stats.ok++;
      const v = out.data;
      return { ...v, idea: Math.max(0, Math.min(10, v.idea)), professionalism: Math.max(0, Math.min(10, v.professionalism)),
        scamSignals: v.scamSignals.slice(0, 5).map(x => clip(x, 160)), summary: clip(v.summary, 300), model: this.model, at: now };
    } catch (error) {
      this.stats.failed++; this.stats.lastError = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message.slice(0, 80);
      return null;
    }
  }
}

/** Several reviewers in turn: the first one in service answers; one that ran out of credits steps aside for a while. */
export class RotatingReviewer implements Reviewer {
  constructor(private readonly list: Reviewer[]) {}
  private pick(now: number): Reviewer | null { return this.list.find(r => r.downUntil() <= now && r.available(now)) ?? null; }
  available(now: number): boolean { return this.pick(now) !== null; }
  downUntil(): number { return Math.min(...this.list.map(r => r.downUntil())); }
  status(): string { return this.list.map(r => r.status()).join(' · '); }
  async review(input: ReviewInput, now = Date.now()): Promise<LaunchReview | null> {
    const first = this.pick(now);
    if (!first) return null;
    const out = await first.review(input, now);
    if (out || first.downUntil() <= now) return out;
    // The first one just went out of service (no credits): the next one answers this launch.
    const next = this.pick(now);
    return next && next !== first ? next.review(input, now) : null;
  }
}

/** Score points for a review: STRONG +3, OK +1, WEAK −1; SCAM is handled as a block. */
export function reviewPoints(r: LaunchReview | null): number {
  return !r ? 0 : r.verdict === 'STRONG' ? 3 : r.verdict === 'OK' ? 1 : r.verdict === 'WEAK' ? -1 : 0;
}

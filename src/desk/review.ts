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

export class LaunchReviewer {
  private readonly client: Anthropic;
  private readonly used: number[] = [];
  constructor(apiKey: string, client?: Anthropic, private readonly maxPerHour: number = REVIEW.maxPerHour) {
    this.client = client ?? new Anthropic({ apiKey, timeout: REVIEW.timeoutMs, maxRetries: 1 });
  }

  /** Whether another review fits in the hourly budget (counted when a request is sent). */
  available(now: number): boolean {
    while (this.used.length && now - this.used[0]! > 3_600_000) this.used.shift();
    return this.used.length < this.maxPerHour;
  }

  /** Null on any failure, refusal or cut-off answer: a missing review never blocks or boosts a launch. */
  async review(input: ReviewInput, now = Date.now()): Promise<LaunchReview | null> {
    if (!this.available(now)) return null;
    this.used.push(now);
    try {
      const response = await this.client.beta.messages.parse({
        model: REVIEW_MODEL, max_tokens: 4_000, system: SYSTEM,
        messages: [{ role: 'user', content: reviewPrompt(input, now) }],
        // Low effort: a quick, calibrated read in seconds, not a research task.
        output_config: { effort: 'low', format: betaZodOutputFormat(Verdict) },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' || !response.parsed_output) return null;
      const out = response.parsed_output;
      return { ...out, idea: Math.max(0, Math.min(10, out.idea)), professionalism: Math.max(0, Math.min(10, out.professionalism)),
        scamSignals: out.scamSignals.slice(0, 5).map(s => clip(s, 160)), summary: clip(out.summary, 300), model: response.model, at: now };
    } catch { return null; }
  }
}

/** Score points for a review: STRONG +3, OK +1, WEAK −1; SCAM is handled as a block. */
export function reviewPoints(r: LaunchReview | null): number {
  return !r ? 0 : r.verdict === 'STRONG' ? 3 : r.verdict === 'OK' ? 1 : r.verdict === 'WEAK' ? -1 : 0;
}

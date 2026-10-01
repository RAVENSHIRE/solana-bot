import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { parseRuleSpec, type RuleSpec } from './custom';

/**
 * Strategy assistant: a chat with Claude that turns the owner's description of how they trade — and, optionally, the
 * swaps of a wallet they name — into a custom rule strategy for the desk. Claude only proposes: the spec is validated
 * like any other, opened in the dashboard's editor for review, and a new strategy starts in TEST.
 *
 * The API key (ANTHROPIC_API_KEY in .env) stays in the local server; the browser never sees it.
 */
export const ASSISTANT_MODEL = 'claude-opus-5-5';

const n = z.number().nullable();
const SpecShape = z.object({
  id: z.string().describe('2–16 characters A–Z, 0–9, _; starts with a letter; not FAIR or CRASH'),
  label: z.string(), summary: z.string().describe('One sentence: the idea, in the owner\'s words'),
  entry: z.object({
    minMarketCapUsd: n, maxMarketCapUsd: n, minHolders: n, minPoolAgeMin: n, maxPoolAgeMin: n,
    minPriceChange5mPct: n, maxPriceChange5mPct: n, minPriceChange1hPct: n, maxPriceChange1hPct: n,
    minVolume5mUsd: n, minVolume1hUsd: n, minVolume1hToMcapPct: n, minBuySellRatio: n, minLiquidityUsd: z.number(),
    maxTop10WalletPct: n, maxLargestWalletPct: n, requireXAccount: z.boolean(),
  }),
  exits: z.object({ takeProfitPct: n, stopLossPct: z.number(), trailingActivationPct: n, trailingStopPct: n, maxHoldMin: z.number(), graceSec: z.number(), marketCapFloorUsd: n, marketCapTargetUsd: n }),
  sizing: z.object({ capitalUsd: z.number(), entryUsd: z.number(), maxOpenPositions: z.number(), slippageBps: z.number(), exitSlippageBps: z.number(), maxDragPct: z.number() }),
  reentryCooldownMin: z.number(),
});
const Reply = z.object({
  reply: z.string().describe('Your answer to the owner, plain text, short paragraphs'),
  strategy: SpecShape.nullable().describe('A complete proposed strategy, or null while you still need answers'),
});

const SYSTEM = `You help the owner of a Solana memecoin trading desk turn the way they trade into a rule strategy the desk can run by itself.

How the desk works:
- Every ~20 s it scans tokens found on DexScreener, GeckoTerminal and pump.fun graduations. For each token it knows: market cap, pool age (minutes), 5m and 1h price change (%), 5m and 1h volume ($), 5m buy/sell ratio, AMM liquidity ($), holder count (owners with a balance), top-10 and largest wallet share (%), and whether an X account is linked. It does NOT know FOMO's verified badge, chart patterns beyond these numbers, or anything social beyond the X link.
- A custom strategy enters when every rule that is set passes. Mint authority, freeze authority and dangerous token extensions are always checked and cannot be configured.
- Exits are checked every 5 s with an executable quote: stop loss (% below cost), optional take profit (%), optional trailing stop (activates at +X%, exits Y% below the peak value), optional market-cap floor and target, and a max hold time (minutes; up to 43,200).
- Sizing: TEST capital (a paper sleeve), entry size in $, max open positions (1–10), slippage and exit slippage in basis points (exit ≥ entry), max drag % (fees + price impact + slippage; slippage must stay below it; 0.5–25). Re-entry cooldown in minutes after an exit.

Strategy fields (null = no rule): entry.minMarketCapUsd, maxMarketCapUsd, minHolders, minPoolAgeMin, maxPoolAgeMin, minPriceChange5mPct, maxPriceChange5mPct, minPriceChange1hPct, maxPriceChange1hPct, minVolume5mUsd, minVolume1hUsd, minVolume1hToMcapPct (1h volume as % of market cap), minBuySellRatio, minLiquidityUsd (required, ≥ 1000), maxTop10WalletPct, maxLargestWalletPct, requireXAccount; exits.takeProfitPct (null = ride), stopLossPct (required), trailingActivationPct + trailingStopPct (both or neither), maxHoldMin (required), graceSec (seconds after entry without stop loss or trailing stop, 0–3600), marketCapFloorUsd < marketCapTargetUsd; sizing.*; reentryCooldownMin. Minimums must not exceed maximums.

The owner's four plays (their framework; the desk sells a position in one piece, so a profit ladder becomes a trailing stop that activates at the first ladder step):
1. Ultra-early (2K–12K market cap, bonding curve): volume spike in the first 3 minutes, enter after a 50–80% retrace. The desk cannot trade bonding curves yet: say so if asked.
2. Migration (60K–300K, first hour after a pump.fun graduation): holder growth, 1h Vol/MC > 30%, organic social; ladder 2×/5×/10×, trail the rest 30%; exit if −50%.
3. Consolidation re-entry ("Crash Strategy", 800K–1.2M after a 1–5M+ pump and dump): 12–72 h sideways base, volume steady, holders still growing; stop −30%; never stop out in the first minute (graceSec 60). Not the desk's built-in CRASH strategy, which trades young pumping pools for minutes.
4. 15-minute scalp (400K–1M, catalyst): big candle + volume + buyers; take +20–100%, stop −30%, out within 15–30 minutes.
Presets MIGRATION, CONSOL and SCALP implement 2–4; RUNNER rides established tokens with >1,000 holders.

What the owner has told the desk about their style (use it, don't repeat it back):
- Trades mostly on FOMO, picking from its trending and migrated lists.
- Holder count above 1,000 is a strong sign of a real project; verified tokens are preferred.
- Re-enters strong tokens after a sideways consolidation (e.g. Effective Acceleration, +140%).
- Caught big runners early (Super Inu from ~$3M to ~$65M market cap; Super Intelligence from ~$300K to ~$6M) and rides them; wants exits that protect a big gain (they missed selling Super Inu near the $60M top).
- Small account: entries around $2, TEST sleeve around $5.

How to answer:
- Answer in the owner's language (they often write German or English, sometimes by voice: expect typos).
- If their trades are attached, read them for patterns: market caps at entry and exit, hold times, winners vs losers, re-entries. Say concretely what you see, with numbers.
- Propose a strategy when you have enough to go on; otherwise ask at most two short questions and return strategy = null. When you propose, say in two or three sentences why each important rule is there, and what the desk cannot check from their description.
- Be honest: these rules are not backtested; the owner should let them run in TEST first. Never promise profits.
- Keep a new strategy's sizing small (entry ≈ $2, capital ≈ $5.45) unless the owner asks otherwise.`;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export interface AssistantResult { reply: string; strategy: RuleSpec | null; specError: string | null; model: string; stopReason: string | null }

export class StrategyAssistant {
  private readonly client: Anthropic;
  constructor(apiKey: string, client?: Anthropic) { this.client = client ?? new Anthropic({ apiKey }); }

  async ask(o: { messages: ChatTurn[]; strategies: RuleSpec[]; walletHistory?: string | null }): Promise<AssistantResult> {
    const context = [
      o.strategies.length ? `The owner's current custom strategies (JSON):\n${JSON.stringify(o.strategies)}` : 'The owner has no custom strategies yet.',
      o.walletHistory ? `Swaps read from the chain for the wallet the owner named:\n${o.walletHistory}` : null,
    ].filter(Boolean).join('\n\n');
    // The context goes first in the first user turn, so the conversation stays an append-only, cacheable prefix.
    const messages: Anthropic.Beta.BetaMessageParam[] = o.messages.map((m, i) => ({ role: m.role, content: i === 0 ? `${context}\n\n---\n\n${m.content}` : m.content }));
    const response = await this.client.beta.messages.parse({
      model: ASSISTANT_MODEL, max_tokens: 16000, system: SYSTEM, messages,
      output_config: { effort: 'medium', format: betaZodOutputFormat(Reply) },
      // A safety decline is re-run on Anthropic's recommended fallback model instead of failing the chat.
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal') return { reply: 'Claude declined this request. Rephrase it, or describe the rules you want directly.', strategy: null, specError: null, model: response.model, stopReason: 'refusal' };
    if (response.stop_reason === 'max_tokens') return { reply: 'The answer was cut off. Ask for a shorter answer or one strategy at a time.', strategy: null, specError: null, model: response.model, stopReason: 'max_tokens' };
    const out = response.parsed_output;
    if (!out) return { reply: 'Claude answered in an unexpected format; try again.', strategy: null, specError: null, model: response.model, stopReason: response.stop_reason };
    let strategy: RuleSpec | null = null, specError: string | null = null;
    if (out.strategy) {
      try { strategy = parseRuleSpec(out.strategy); } catch (error) { specError = (error as Error).message.replace(/^INVALID_STRATEGY_SPEC: /, ''); }
    }
    return { reply: out.reply, strategy, specError, model: response.model, stopReason: response.stop_reason };
  }
}

/** Untrusted chat history from the browser: roles alternate from the user, sizes bounded. */
export function parseChat(input: unknown): ChatTurn[] {
  const turns = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(6_000) }).strict()).min(1).max(30).safeParse(input);
  if (!turns.success) throw new Error('INVALID_CHAT');
  const list = turns.data;
  if (list[0]!.role !== 'user' || list.at(-1)!.role !== 'user' || list.some((t, i) => i > 0 && t.role === list[i - 1]!.role)) throw new Error('INVALID_CHAT');
  return list;
}

/** A stable code for the dashboard: what went wrong talking to Claude, without leaking request details. */
export function assistantErrorCode(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return 'ASSISTANT_AUTH';
  if (error instanceof Anthropic.RateLimitError) return 'ASSISTANT_RATE_LIMITED';
  if (error instanceof Anthropic.BadRequestError) return 'ASSISTANT_BAD_REQUEST';
  if (error instanceof Anthropic.APIConnectionError) return 'ASSISTANT_OFFLINE';
  if (error instanceof Anthropic.APIError) return 'ASSISTANT_UNAVAILABLE';
  return 'ASSISTANT_FAILED';
}

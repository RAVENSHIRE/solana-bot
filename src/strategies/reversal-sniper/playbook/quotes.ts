import { z } from 'zod';
import { JupiterClient, type JupiterQuote, type QuoteParams } from '../../../execution/jupiter-client';
import { NonRetryableError } from '../../../utils/errors';

const amount = z.string().regex(/^\d+$/);
const schema = z.object({ inputMint: z.string(), outputMint: z.string(), inAmount: amount,
  outAmount: amount, otherAmountThreshold: amount, swapMode: z.literal('ExactIn'),
  slippageBps: z.number().int().nonnegative(),
  priceImpactPct: z.string().min(1).refine(s => Number.isFinite(Number(s))),
  routePlan: z.array(z.object({ percent: z.number().nonnegative(), swapInfo: z.object({ ammKey: z.string(), label: z.string().optional(),
    inputMint: z.string(), outputMint: z.string(), inAmount: amount, outAmount: amount,
  }).passthrough() }).passthrough()).min(1),
}).passthrough();
export function validateQuote(raw: unknown, request: QuoteParams): JupiterQuote {
  const q = schema.parse(raw);
  if (q.inputMint !== request.inputMint || q.outputMint !== request.outputMint || BigInt(q.inAmount) !== request.amountRaw ||
    q.slippageBps !== request.slippageBps || BigInt(q.outAmount) <= 0n || BigInt(q.otherAmountThreshold) <= 0n ||
    BigInt(q.otherAmountThreshold) > BigInt(q.outAmount)) throw new NonRetryableError('Quote does not match requested swap');
  return q as JupiterQuote;
}
export class PlaybookQuotes extends JupiterClient {
  override async quote(p: QuoteParams): Promise<JupiterQuote> {
    return validateQuote(await super.quote(p), p);
  }
}

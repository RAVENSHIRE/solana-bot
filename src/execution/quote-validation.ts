import { z } from 'zod';
import type { JupiterQuote, QuoteParams } from './jupiter-client';
import { address, parse, safeInteger } from '../data/core/data-validator';
import { DataError } from '../data/core/data-types';
const amount = z.string().regex(/^\d+$/);
const schema = z.object({ inputMint: address, outputMint: address, inAmount: amount, outAmount: amount, otherAmountThreshold: amount,
  swapMode: z.literal('ExactIn'), slippageBps: z.number().int().min(0).max(10_000),
  priceImpactPct: z.string().regex(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i).refine(s => Number.isFinite(Number(s))),
  routePlan: z.array(z.object({ percent: z.number().min(0).max(100), swapInfo: z.object({ ammKey: address, label: z.string().optional(),
    inputMint: address, outputMint: address, inAmount: amount, outAmount: amount, feeAmount: amount.optional(), feeMint: address.optional(),
  }).passthrough() }).passthrough()).min(1), contextSlot: safeInteger.optional(), timeTaken: z.number().finite().nonnegative().optional(),
}).passthrough();
export function validateQuote(raw: unknown, request: QuoteParams): JupiterQuote {
  const q = parse(schema, raw, 'jupiter'); const out = BigInt(q.outAmount); const minimum = BigInt(q.otherAmountThreshold);
  if (q.inputMint !== request.inputMint || q.outputMint !== request.outputMint || BigInt(q.inAmount) !== request.amountRaw ||
    q.slippageBps !== request.slippageBps || out <= 0n || minimum <= 0n || minimum > out ||
    minimum < out * BigInt(10_000 - request.slippageBps) / 10_000n)
    throw new DataError('critical-execution-data', 'jupiter', 'quote does not match requested swap or slippage bound');
  return q as JupiterQuote;
}

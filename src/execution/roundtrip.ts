import { BASE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS } from '../core/types';
import { JupiterClient, type JupiterQuote } from './jupiter-client';
export function roundtripOutcome(buy: JupiterQuote, sell: JupiterQuote, priorityCap: bigint, recoverRent: boolean): { edgeLamports: bigint; edgeBps: number; costs: bigint } {
  const input = BigInt(buy.inAmount);
  if (input <= 0n || sell.inputMint !== buy.outputMint || sell.outputMint !== buy.inputMint || BigInt(sell.inAmount) !== BigInt(buy.otherAmountThreshold)) throw new Error('Mismatched conservative roundtrip legs');
  if (JupiterClient.priceImpactPct(buy) > 1 || JupiterClient.priceImpactPct(sell) > 1) throw new Error('Roundtrip price impact exceeds limit');
  // Swap fees are already included in Jupiter output. Both slippage minima are used.
  // Existing one-account close: 16,000 CU at 20,000 micro-lamports/CU = 320 lamports.
  const costs = 2n * (BASE_FEE_LAMPORTS + priorityCap) + (recoverRent ? BASE_FEE_LAMPORTS + 320n : TOKEN_ACCOUNT_RENT_LAMPORTS);
  const edgeLamports = BigInt(sell.otherAmountThreshold) - input - costs;
  return { edgeLamports, edgeBps: Number(edgeLamports * 10_000n / input), costs };
}

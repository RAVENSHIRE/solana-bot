import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { DataError } from './data-types';

export const address = z.string().refine(s => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }, 'Invalid Solana address');
export const decimal = z.union([z.number(), z.string().regex(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i)])
  .transform(Number).pipe(z.number().finite());
export const nonnegative = decimal.refine(n => n >= 0, 'Negative value');
export const positive = decimal.refine(n => n > 0, 'Non-positive value');
export const optionalNumber = nonnegative.nullish().transform(n => n ?? null);
export const rawAmount = z.string().regex(/^\d+$/).transform(BigInt);
export const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const timestamp = safeInteger.refine(t => t <= Date.now() + 1000 && t > 0, 'Invalid timestamp');
export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, source: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new DataError('invalid-response', source, `schema validation failed (${result.error.issues.map(i => i.path.join('.')).slice(0, 5).join(', ')})`);
  return result.data;
}
export function unixSeconds(value: number, now = Date.now()): number {
  const ms = value * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > now + 1000) throw new DataError('invalid-response', 'timestamp', 'invalid Unix seconds');
  return ms;
}
export function exactNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new DataError('invalid-response', 'numeric', 'unsafe integer conversion');
  return Number(value);
}

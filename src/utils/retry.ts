import {
  HttpError,
  NetworkError,
  NonRetryableError,
  TimeoutError,
  TxFailedError,
  errorMessage,
} from './errors';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_PATTERNS = [
  '429',
  'too many requests',
  'rate limit',
  'fetch failed',
  'socket hang up',
  'network',
  'timeout',
  'timed out',
  'econnreset',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'node is behind',
  'node is unhealthy',
  '-32005',
  '-32004',
  'block not available',
  'minimum context slot',
];

export function isRateLimitError(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 429;
  const msg = errorMessage(e).toLowerCase();
  return msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit');
}

/** Entscheidet, ob ein Fehler durch Wiederholung/Failover behebbar ist. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof NonRetryableError || e instanceof TxFailedError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status === 408 || e.status >= 500;
  if (e instanceof NetworkError) return true;
  const holder = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = holder?.code ?? holder?.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const msg = errorMessage(e).toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

/** Exponentielles Backoff mit "Equal Jitter". */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      const retryable = o.isRetryable ? o.isRetryable(e) : isTransientError(e);
      if (!retryable || attempt >= o.retries) throw e;
      const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
      const delay = Math.floor(exp / 2 + Math.random() * (exp / 2));
      o.onRetry?.(e, attempt + 1, delay);
      await sleep(delay);
      attempt++;
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

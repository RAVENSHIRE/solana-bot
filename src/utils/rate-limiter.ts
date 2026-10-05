import { setTimeout as delay } from 'node:timers/promises';

/**
 * Token-Bucket-Limiter. Mehrere gleichzeitige Aufrufer werden fair gedrosselt,
 * bei HTTP 429 kann der Bucket für eine Zeitspanne pausiert werden.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private pausedUntil = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    if (capacity < 1 || refillPerSecond <= 0) {
      throw new Error('TokenBucket: capacity und refillPerSecond müssen > 0 sein');
    }
    this.tokens = capacity;
  }

  /** Callers waiting, per rank: a token goes to the most urgent rank first. */
  private readonly waiting = new Map<number, number>();

  /**
   * `rank`: lower is more urgent (request-scope priority: execution 0, position 1, analysis 2, discovery 3). While a
   * more urgent caller waits, a less urgent one does not take the next token: a stop-loss quote never queues behind
   * scan or entry quotes.
   */
  async acquire(signal?: AbortSignal, rank = 2): Promise<void> {
    this.waiting.set(rank, (this.waiting.get(rank) ?? 0) + 1);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const now = Date.now();
        if (now < this.pausedUntil) {
          await delay(Math.min(60_000, this.pausedUntil - now), undefined, { signal });
          continue;
        }
        this.refill(now);
        const ahead = [...this.waiting].some(([r, n]) => r < rank && n > 0);
        if (this.tokens >= 1 && !ahead) {
          this.tokens -= 1;
          return;
        }
        const waitMs = ahead ? 10 : Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
        await delay(Math.max(10, waitMs), undefined, { signal });
      }
    } finally {
      const n = (this.waiting.get(rank) ?? 1) - 1;
      if (n > 0) this.waiting.set(rank, n); else this.waiting.delete(rank);
    }
  }

  /** Pausiert den Bucket (z. B. nach 429 mit Retry-After). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.tokens = 0;
  }

  private refill(now: number): void {
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
  }
}

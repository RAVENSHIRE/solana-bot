import { sleep } from './retry';

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
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new Error('TokenBucket: capacity und refillPerSecond müssen > 0 sein');
    }
    this.tokens = capacity;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
      await sleep(Math.max(10, waitMs));
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

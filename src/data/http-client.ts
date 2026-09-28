import { HttpError, NetworkError, errorMessage } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { TokenBucket } from '../utils/rate-limiter';
import { withRetry } from '../utils/retry';

export type Query = Record<string, string | number | boolean | undefined>;

export interface HttpClientOptions {
  name: string;
  baseUrl: string;
  limiter: TokenBucket;
  logger: Logger;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/** Schlanker JSON-HTTP-Client auf Basis von Node-fetch (undici). */
export class HttpClient {
  constructor(private readonly o: HttpClientOptions) {}

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  private buildUrl(path: string, query?: Query): string {
    const base = this.o.baseUrl.replace(/\/+$/, '');
    const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request<T>(method: 'GET' | 'POST', path: string, query?: Query, body?: unknown): Promise<T> {
    const url = this.buildUrl(path, query);
    const target = `${this.o.name} ${method} ${path.split('?')[0]}`;

    return withRetry(
      async () => {
        await this.o.limiter.acquire();
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers: {
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...this.o.headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
          });
        } catch (e) {
          throw new NetworkError(`${target}: ${errorMessage(e)}`, { cause: e });
        }

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          this.o.limiter.pause(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000);
        }
        const text = await res.text().catch(() => '');
        if (!res.ok) throw new HttpError(res.status, target, text.slice(0, 300));
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(res.status, target, `Ungültiges JSON: ${text.slice(0, 120)}`);
        }
      },
      {
        retries: this.o.retries ?? 3,
        baseDelayMs: 600,
        maxDelayMs: 10_000,
        onRetry: (e, attempt, delay) =>
          this.o.logger.debug(`${target} – Retry ${attempt} in ${delay} ms`, { error: errorMessage(e) }),
      },
    );
  }
}

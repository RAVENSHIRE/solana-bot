import type { Logger } from '../utils/logger';
import type { TokenBucket } from '../utils/rate-limiter';
import { withRetry } from '../utils/retry';
import { DataError, type Source } from './core/data-types';
import type { DataHealth } from './core/data-health';
import { checkTask, priority, requestScope, RequestGate } from './core/request-scope';

export interface HttpOptions {
  name: string; baseUrl: string; limiter: TokenBucket; logger: Logger; timeoutMs: number; retries: number;
  headers?: Record<string, string>; gate?: RequestGate; health?: DataHealth; source?: Source;
  fetch?: typeof fetch; clock?: () => number; maxBodyBytes?: number;
}
const defaultGate = new RequestGate(4);
export function retryAfter(value: string | null, now = Date.now()): number {
  if (value === null) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}
export class HttpClient {
  private failures = 0; private cooldownUntil = 0;
  constructor(private readonly o: HttpOptions) {
    const url = new URL(o.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new DataError('configuration', o.name, 'invalid provider URL');
  }
  get<T>(route: string, query: Record<string, string | number | boolean> = {}): Promise<T> { return this.request<T>('GET', route, query); }
  post<T>(route: string, body: unknown, beforeSend?: () => void): Promise<T> { return this.request<T>('POST', route, {}, body, beforeSend); }
  private async request<T>(method: string, route: string, query: Record<string, string | number | boolean>, body?: unknown, beforeSend?: () => void): Promise<T> {
    checkTask();
    const clock = this.o.clock ?? Date.now;
    if (clock() < this.cooldownUntil) throw new DataError('unavailable-provider', this.o.name, 'provider cooldown', this.cooldownUntil - clock());
    const url = new URL(this.o.baseUrl.replace(/\/$/, '') + route);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const source = this.o.source;
    const health = source ? this.o.health?.status(source) : undefined;
    try {
      const result = await withRetry(async () => {
        checkTask(); await this.o.limiter.acquire(requestScope.getStore()?.signal); checkTask();
        return (this.o.gate ?? defaultGate).run(async () => {
          checkTask(); beforeSend?.();
          const started = clock(); if (health) health.requests++;
          const timeout = AbortSignal.timeout(this.o.timeoutMs);
          const scopeSignal = requestScope.getStore()?.signal;
          const signal = scopeSignal ? AbortSignal.any([timeout, scopeSignal]) : timeout;
          try {
            const res = await (this.o.fetch ?? fetch)(url, { method, redirect: 'error',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...this.o.headers },
              body: body === undefined ? undefined : JSON.stringify(body), signal });
            if (!res.ok) {
              await res.body?.cancel();
              if (res.status === 429) {
                const pause = retryAfter(res.headers.get('retry-after'), clock());
                this.o.limiter.pause(pause);
                if (health) health.cooldownUntil = clock() + pause;
                throw new DataError('rate-limited', this.o.name, 'HTTP 429', pause);
              }
              throw new DataError(res.status >= 500 || res.status === 408 ? 'transient' : res.status === 401 || res.status === 403 ? 'configuration' : 'invalid-response', this.o.name, `HTTP ${res.status}`);
            }
            const limit = this.o.maxBodyBytes ?? 8 * 1024 * 1024;
            const reader = res.body?.getReader();
            if (!reader) throw new DataError('invalid-response', this.o.name, 'empty response');
            const chunks: Uint8Array[] = []; let size = 0;
            for (;;) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.byteLength;
              if (size > limit) { await reader.cancel(); throw new DataError('invalid-response', this.o.name, 'response too large'); }
              chunks.push(part.value);
            }
            let raw: unknown;
            try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw new DataError('invalid-response', this.o.name, 'invalid JSON'); }
            if (health) { health.latencyMs = clock() - started; health.lastSuccessAt = clock(); health.cooldownUntil = 0; }
            this.o.logger.debug('Data request complete', { source: this.o.name, latencyMs: clock() - started });
            return raw as T;
          } catch (err) {
            const error = err instanceof DataError ? err : new DataError(scopeSignal?.aborted ? 'unavailable-provider' : 'transient', this.o.name, timeout.aborted ? 'request timeout' : 'network request failed');
            if (source) this.o.health?.failure(source, error.kind);
            this.o.logger.warn('Data request failed', { source: this.o.name, category: error.kind, latencyMs: clock() - started });
            throw error;
          }
        }, priority());
      }, { retries: this.o.retries, baseDelayMs: 250, maxDelayMs: 5000,
        isRetryable: e => e instanceof DataError && ['transient', 'rate-limited'].includes(e.kind),
        onRetry: (_e, attempt) => { if (health) health.retries++; this.o.logger.debug('Data request retry', { source: this.o.name, attempt }); } });
      this.failures = 0; return result;
    } catch (err) {
      this.failures++;
      if (err instanceof DataError && err.kind === 'rate-limited') this.cooldownUntil = clock() + err.retryAfterMs;
      else if (this.failures >= 3) this.cooldownUntil = clock() + 30_000;
      if (health) health.cooldownUntil = Math.max(health.cooldownUntil, this.cooldownUntil);
      throw err;
    }
  }
}

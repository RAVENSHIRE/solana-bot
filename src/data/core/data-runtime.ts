import type { Logger } from '../../utils/logger';
import type { SharedRest } from '../shared-rest';
import { TokenBucket } from '../../utils/rate-limiter';
import { HttpClient } from '../http-client';
import type { MarketDataStore } from '../storage/market-data-store';
import { DataCache } from './data-cache';
import { DataHealth } from './data-health';
import { DataError, type Category, type Source } from './data-types';
import { RequestGate, requestScope, checkTask } from './request-scope';

export interface DataSettings {
  maxPriceDifferencePct: number; maxLiquidityDifferencePct: number;
  cacheEnabled: boolean; discoveryTtlMs: number; analysisTtlMs: number; positionTtlMs: number;
  maxConcurrent: number; retries: number; timeoutMs: number; maxPriceAgeMs: number; maxCandleAgeMs: number;
  dexRps: number; geckoRps: number; raydiumRps: number; persistHistory: boolean; retentionDays: number; historyMaxBytes: number;
}
export const defaultDataSettings: DataSettings = { maxPriceDifferencePct: 20, maxLiquidityDifferencePct: 50, cacheEnabled: true, discoveryTtlMs: 60_000, analysisTtlMs: 15_000, positionTtlMs: 3000,
  maxConcurrent: 4, retries: 2, timeoutMs: 10_000, maxPriceAgeMs: 90_000, maxCandleAgeMs: 600_000,
  dexRps: 1, geckoRps: 8 / 60, raydiumRps: 1, persistHistory: true, retentionDays: 7, historyMaxBytes: 128 * 1024 * 1024 };
export class DataRuntime {
  readonly cache = new DataCache(); readonly health = new DataHealth(); readonly gate: RequestGate;
  private readonly clients = new Map<Source, HttpClient>();
  constructor(readonly log: Logger, readonly settings: DataSettings = defaultDataSettings, readonly history?: MarketDataStore, private readonly fetcher?: typeof fetch) {
    this.gate = new RequestGate(settings.maxConcurrent);
  }
  private readonly rests = new Map<Source, { rest: SharedRest; minPauseMs: number }>();
  /** Before the source's client is created: a rest shared with other processes, and the least pause after a 429. */
  shareRest(source: Source, rest: SharedRest, minPauseMs: number): void { this.rests.set(source, { rest, minPauseMs }); }
  http(source: Source, baseUrl: string, rps: number): HttpClient {
    let client = this.clients.get(source);
    if (!client) { const shared = this.rests.get(source); client = new HttpClient({ name: source, baseUrl, limiter: new TokenBucket(1, rps), logger: this.log,
      timeoutMs: this.settings.timeoutMs, retries: this.settings.retries, source, health: this.health, gate: this.gate, fetch: this.fetcher,
      sharedRest: shared?.rest, minRateLimitPauseMs: shared?.minPauseMs }); this.clients.set(source, client); }
    return client;
  }
  async read<T>(source: Source, key: string, category: Category, request: () => Promise<unknown>, normalize: (raw: unknown, receivedAt: number) => T): Promise<T> {
    checkTask();
    if (category === 'execution') throw new DataError('critical-execution-data', source, 'execution requests must bypass analytical caches');
    const useCategory = requestScope.getStore()?.category === 'position' ? 'position' : category;
    const ttl = !this.settings.cacheEnabled ? 0 : useCategory === 'discovery' ? this.settings.discoveryTtlMs : useCategory === 'position' ? this.settings.positionTtlMs : this.settings.analysisTtlMs;
    const hits = this.cache.hits;
    const result = await this.cache.get(`${source}:${key}`, ttl, async () => {
      const raw = await requestScope.run({ ...requestScope.getStore(), category: useCategory }, request); checkTask(); const receivedAt = Date.now();
      try {
        const data = normalize(raw, receivedAt);
        this.history?.append(category === 'discovery' ? 'discovery' : 'observation', source, { key, data }, receivedAt);
        return data;
      } catch (e) {
        this.health.failure(source, 'invalid-response');
        this.log.warn('Provider normalization rejected', { source, category: 'invalid-response' });
        throw e instanceof DataError ? e : new DataError('invalid-response', source, 'normalization failed');
      }
    });
    const status = this.health.status(source);
    if (this.cache.hits > hits) status.cacheHits++; else status.cacheMisses++;
    this.log.debug('Data cache', { source, hit: this.cache.hits > hits, category: useCategory });
    checkTask(); return result;
  }
  record(kind: string, source: string, data: unknown): void { this.history?.append(kind, source, data); }
  async flush(): Promise<void> { await this.history?.flush(); }
}

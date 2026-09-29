import type { DataSourceStatus, FailureKind, Source } from './data-types';

export class DataHealth {
  private readonly sources = new Map<Source, DataSourceStatus>();
  status(source: Source): DataSourceStatus {
    let value = this.sources.get(source);
    if (!value) { value = { source, requests: 0, failures: 0, retries: 0, rateLimits: 0, invalidResponses: 0, cacheHits: 0, cacheMisses: 0, latencyMs: null, lastSuccessAt: null, lastFailure: null, cooldownUntil: 0 }; this.sources.set(source, value); }
    return value;
  }
  failure(source: Source, kind: FailureKind): void { const s = this.status(source); s.failures++; s.lastFailure = kind; if (kind === 'rate-limited') s.rateLimits++; if (kind === 'invalid-response') s.invalidResponses++; }
  snapshot(): DataSourceStatus[] { return structuredClone([...this.sources.values()]); }
}

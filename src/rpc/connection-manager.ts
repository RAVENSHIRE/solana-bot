import type { DataHealth } from '../data/core/data-health';
import { redactText } from '../utils/redact';
import { Connection, type Commitment } from '@solana/web3.js';
import { TokenBucket } from '../utils/rate-limiter';
import { errorMessage } from '../utils/errors';
import { isRateLimitError, isTransientError, sleep, withTimeout } from '../utils/retry';
import { maskUrl } from '../utils/format';
import type { Logger } from '../utils/logger';

interface Endpoint {
  index: number;
  label: string;
  connection: Connection;
  limiter: TokenBucket;
  failures: number;
  cooldownUntil: number;
  latencyMs: number | null;
  lastError: string | null;
}

export interface EndpointHealth {
  label: string;
  ok: boolean;
  latencyMs: number | null;
  slot: number | null;
  error: string | null;
}

export interface ConnectionManagerOptions {
  commitment: Commitment;
  maxRps: number;
  timeoutMs: number;
  logger: Logger;
}

/**
 * Verwaltet mehrere RPC-Endpoints:
 * - Priorität nach Reihenfolge in RPC_ENDPOINTS (bezahlter Node zuerst eintragen)
 * - Token-Bucket pro Endpoint gegen 429
 * - Automatisches Failover + Cooldown bei wiederholten Fehlern
 * - Periodische Health-Checks (getSlot-Latenz)
 */
export class ConnectionManager {
  private readonly endpoints: Endpoint[];
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private dataHealth?: DataHealth;
  attachDataHealth(health: DataHealth): void { this.dataHealth = health; }

  constructor(urls: string[], private readonly o: ConnectionManagerOptions) {
    if (urls.length === 0) throw new Error('ConnectionManager: keine Endpoints');
    this.log = o.logger;
    this.endpoints = urls.map((url, index) => ({
      index,
      label: `rpc#${index}(${maskUrl(url)})`,
      connection: new Connection(url, {
        commitment: o.commitment,
        disableRetryOnRateLimit: true, // Rate-Limits behandeln wir selbst (Backoff + Failover)
        confirmTransactionInitialTimeout: 60_000,
      }),
      limiter: new TokenBucket(Math.max(1, Math.ceil(o.maxRps)), o.maxRps),
      failures: 0,
      cooldownUntil: 0,
      latencyMs: null,
      lastError: null,
    }));
  }

  /** Aktuell bevorzugte Connection (nur für unkritische Direktzugriffe). */
  get primary(): Connection {
    return this.pick(new Set()).connection;
  }

  private pick(exclude: Set<Endpoint>): Endpoint {
    const now = Date.now();
    const candidates = this.endpoints.filter((e) => !exclude.has(e));
    const pool = candidates.length > 0 ? candidates : this.endpoints;
    const healthy = pool.filter((e) => e.cooldownUntil <= now);
    if (healthy.length > 0) return healthy[0]!;
    // Alle im Cooldown: den mit dem frühesten Ablauf wählen
    return [...pool].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0]!;
  }

  /**
   * Führt einen RPC-Call mit Rate-Limiting, Timeout, Retry und Failover aus.
   * Nicht-transiente Fehler (z. B. ungültige Parameter) werden sofort durchgereicht.
   */
  async execute<T>(
    label: string,
    fn: (c: Connection) => Promise<T>,
    opts: { attempts?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const maxAttempts = opts.attempts ?? Math.max(4, this.endpoints.length * 2);
    const tried = new Set<Endpoint>();
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (tried.size >= this.endpoints.length) tried.clear();
      const ep = this.pick(tried);
      await ep.limiter.acquire();
      const started = Date.now();
      const health = this.dataHealth?.status('solana-rpc');
      if (health) { health.requests++; if (attempt > 0) health.retries++; }
      try {
        const result = await withTimeout(fn(ep.connection), opts.timeoutMs ?? this.o.timeoutMs, `${label}@${ep.label}`);
        const latency = Date.now() - started;
        if (health) { health.latencyMs = latency; health.lastSuccessAt = Date.now(); }
        ep.latencyMs = ep.latencyMs === null ? latency : Math.round(ep.latencyMs * 0.8 + latency * 0.2);
        if (ep.failures > 0) this.log.debug(`${ep.label} wieder stabil`);
        ep.failures = 0;
        return result;
      } catch (e) {
        lastErr = e;
        this.dataHealth?.failure('solana-rpc', isRateLimitError(e) ? 'rate-limited' : isTransientError(e) ? 'transient' : 'on-chain-verification');
        if (!isTransientError(e)) throw e;
        ep.failures++;
        ep.lastError = redactText(errorMessage(e));
        if (isRateLimitError(e)) ep.limiter.pause(Math.min(15_000, 1_000 * 2 ** Math.min(ep.failures, 4)));
        if (ep.failures >= 3) {
          const cooldown = Math.min(120_000, 5_000 * ep.failures);
          ep.cooldownUntil = Date.now() + cooldown;
          this.log.warn(`${ep.label} im Cooldown (${cooldown} ms)`, { failures: ep.failures, error: ep.lastError });
        }
        tried.add(ep);
        const backoff = Math.min(4_000, 200 * 2 ** attempt);
        this.log.debug(`RPC ${label} fehlgeschlagen – Versuch ${attempt + 1}/${maxAttempts}`, {
          endpoint: ep.label,
          error: ep.lastError,
          backoffMs: backoff,
        });
        await sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
    }
    throw new Error(`RPC ${label} nach ${maxAttempts} Versuchen fehlgeschlagen: ${errorMessage(lastErr)}`, {
      cause: lastErr,
    });
  }

  /**
   * Sendet eine signierte Transaktion parallel an alle nicht gesperrten Endpoints
   * (erhöht die Landungswahrscheinlichkeit). Wirft nur, wenn kein Endpoint annimmt.
   */
  async broadcast(raw: Uint8Array): Promise<number> {
    const now = Date.now();
    const targets = this.endpoints.filter((e) => e.cooldownUntil <= now);
    const list = targets.length > 0 ? targets : this.endpoints;
    const results = await Promise.allSettled(
      list.map(async (ep) => {
        await ep.limiter.acquire();
        return withTimeout(
          ep.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
          this.o.timeoutMs,
          `sendRawTransaction@${ep.label}`,
        );
      }),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    if (accepted === 0) {
      const reasons = results
        .map((r) => (r.status === 'rejected' ? errorMessage(r.reason) : ''))
        .filter(Boolean)
        .join(' | ');
      // "already processed" bedeutet: Transaktion ist bereits im Ledger → kein Fehler
      if (/already (been )?processed/i.test(reasons)) return 1;
      throw new Error(`Broadcast an keinen Endpoint möglich: ${reasons}`);
    }
    return accepted;
  }

  async healthCheck(): Promise<EndpointHealth[]> {
    return Promise.all(
      this.endpoints.map(async (ep): Promise<EndpointHealth> => {
        const started = Date.now();
        try {
          const slot = await withTimeout(ep.connection.getSlot(this.o.commitment), 8_000, `health@${ep.label}`);
          const latency = Date.now() - started;
          ep.latencyMs = latency;
          ep.failures = 0;
          ep.cooldownUntil = 0;
          return { label: ep.label, ok: true, latencyMs: latency, slot, error: null };
        } catch (e) {
          ep.failures++;
          ep.lastError = redactText(errorMessage(e));
          ep.cooldownUntil = Date.now() + 30_000;
          return { label: ep.label, ok: false, latencyMs: null, slot: null, error: ep.lastError };
        }
      }),
    );
  }

  startHealthLoop(intervalMs: number): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      this.healthCheck()
        .then((res) => {
          const down = res.filter((r) => !r.ok);
          if (down.length === res.length) {
            this.log.error('ALLE RPC-Endpoints nicht erreichbar', { details: down.map((d) => `${d.label}: ${d.error}`) });
          } else if (down.length > 0) {
            this.log.warn('RPC-Endpoints teilweise gestört', { down: down.map((d) => d.label) });
          } else {
            this.log.debug('RPC-Health ok', { latency: res.map((r) => `${r.label}=${r.latencyMs}ms`).join(' ') });
          }
        })
        .catch((e) => this.log.error('Health-Check-Fehler', { error: errorMessage(e) }));
    }, intervalMs);
    this.healthTimer.unref();
  }

  stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  status(): Array<{ label: string; latencyMs: number | null; failures: number; cooling: boolean }> {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      label: e.label,
      latencyMs: e.latencyMs,
      failures: e.failures,
      cooling: e.cooldownUntil > now,
    }));
  }
}

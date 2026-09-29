import { HttpClient } from '../data/http-client';
import { TokenBucket } from '../utils/rate-limiter';
import { NonRetryableError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { AppConfig } from '../config/config';
import { z } from 'zod';
import { address, parse, safeInteger } from '../data/core/data-validator';
import { DataError, observation, type ExecutableQuote } from '../data/core/data-types';
import type { DataRuntime } from '../data/core/data-runtime';
import { requestScope } from '../data/core/request-scope';
import { validateQuote } from './quote-validation';

export interface JupiterRouteStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount?: string;
    feeMint?: string;
  };
  percent: number;
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRouteStep[];
  contextSlot?: number;
  timeTaken?: number;
  [key: string]: unknown;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
}

/**
 * Jupiter Swap API v1 (api.jup.ag/swap/v1, Auth via x-api-key).
 * Hinweis: lite-api.jup.ag wurde von Jupiter abgekündigt → API-Key über portal.jup.ag.
 */
export class JupiterClient {
  private readonly http: HttpClient;
  private readonly issued = new WeakMap<JupiterQuote, { at: number; fingerprint: string }>();

  constructor(private readonly cfg: AppConfig['jupiter'], logger: Logger, private readonly data?: DataRuntime, fetcher?: typeof fetch, private readonly clock: () => number = Date.now) {
    this.http = new HttpClient({
      name: 'Jupiter',
      baseUrl: cfg.baseUrl,
      limiter: new TokenBucket(Math.max(1, Math.ceil(cfg.maxRps)), cfg.maxRps),
      logger,
      timeoutMs: 10_000,
      retries: 2,
      headers: cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {},
      source: 'jupiter', health: data?.health, gate: data?.gate, fetch: fetcher,
    });
  }

  async quote(p: QuoteParams): Promise<JupiterQuote> {
    if (p.amountRaw <= 0n) throw new NonRetryableError('Jupiter: Betrag muss > 0 sein');
    if (p.inputMint === p.outputMint) throw new NonRetryableError('Jupiter: inputMint == outputMint');
    parse(address, p.inputMint, 'jupiter'); parse(address, p.outputMint, 'jupiter');
    parse(z.number().int().min(0).max(10_000), p.slippageBps, 'jupiter');
    const requestedAt = this.clock();
    const raw = await requestScope.run({ ...requestScope.getStore(), category: 'execution' }, () => this.http.get<unknown>('/quote', {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amountRaw.toString(),
      slippageBps: p.slippageBps,
      swapMode: 'ExactIn',
      restrictIntermediateTokens: true,
      maxAccounts: this.cfg.maxAccounts,
    }));
    const q = validateQuote(raw, p);
    // Conservative age starts before queuing/rate limiting; never authorize a cached copy.
    this.issued.set(q, { at: requestedAt, fingerprint: JSON.stringify(q) });
    this.assertFresh(q);
    const snapshot: ExecutableQuote = { meta: observation('jupiter', this.clock(), p.outputMint, null), inputMint: q.inputMint,
      outputMint: q.outputMint, inputRaw: BigInt(q.inAmount), outputRaw: BigInt(q.outAmount), minimumOutputRaw: BigInt(q.otherAmountThreshold),
      priceImpactPct: JupiterClient.priceImpactPct(q), slippageBps: q.slippageBps, route: q.routePlan.map(s => s.swapInfo.ammKey), executionAuthorized: false };
    this.data?.record('quote', 'jupiter', snapshot);
    return q;
  }

  assertFresh(quote: JupiterQuote): void {
    const issued = this.issued.get(quote);
    if (!issued || JSON.stringify(quote) !== issued.fingerprint || this.clock() < issued.at || this.clock() - issued.at > (this.cfg.quoteMaxAgeMs ?? 15_000))
      throw new DataError('critical-execution-data', 'jupiter', 'quote is stale, copied, or modified');
  }

  expiresAt(quote:JupiterQuote):number {
    this.assertFresh(quote);
    return this.issued.get(quote)!.at+(this.cfg.quoteMaxAgeMs??15_000);
  }

  async buildSwap(quote: JupiterQuote, userPublicKey: string, priorityFeeCapLamports = this.cfg.maxPriorityFeeLamports): Promise<JupiterSwapResponse> {
    parse(safeInteger, priorityFeeCapLamports, 'jupiter');
    if (priorityFeeCapLamports > this.cfg.maxPriorityFeeLamports) throw new DataError('critical-execution-data', 'jupiter', 'cannot raise configured priority cap');
    this.assertFresh(quote); parse(address, userPublicKey, 'jupiter');
    const raw = await requestScope.run({ ...requestScope.getStore(), category: 'execution' }, () => this.http.post<unknown>('/swap', {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: priorityFeeCapLamports,
          priorityLevel: this.cfg.priorityLevel,
        },
      },
    }, () => this.assertFresh(quote)));
    const res = parse(z.object({ swapTransaction: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/), lastValidBlockHeight: safeInteger,
      prioritizationFeeLamports: safeInteger, computeUnitLimit: safeInteger.optional(), simulationError: z.unknown().optional() }), raw, 'jupiter');
    this.assertFresh(quote);
    if (res.prioritizationFeeLamports > priorityFeeCapLamports) throw new DataError('critical-execution-data', 'jupiter', 'priority fee exceeds configured cap');
    if (res.simulationError) {
      throw new NonRetryableError('Jupiter /swap simulation failed');
    }
    return res;
  }

  /** priceImpactPct wird von Jupiter als Bruchteil geliefert (0.01 = 1 %). */
  static priceImpactPct(q: JupiterQuote): number {
    const n = Number(q.priceImpactPct);
    if (!q.priceImpactPct.trim() || !Number.isFinite(n)) throw new DataError('critical-execution-data', 'jupiter', 'invalid price impact');
    return Math.abs(n) * 100;
  }

  static routeLabel(q: JupiterQuote): string {
    const labels = q.routePlan.map((s) => s.swapInfo.label ?? s.swapInfo.ammKey.slice(0, 4));
    return labels.length > 0 ? labels.join('→') : 'direct';
  }
}

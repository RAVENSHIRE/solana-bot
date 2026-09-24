import { HttpClient } from '../data/http-client';
import { TokenBucket } from '../utils/rate-limiter';
import { NonRetryableError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { AppConfig } from '../config/config';

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

  constructor(private readonly cfg: AppConfig['jupiter'], logger: Logger) {
    this.http = new HttpClient({
      name: 'Jupiter',
      baseUrl: cfg.baseUrl,
      limiter: new TokenBucket(Math.max(1, Math.ceil(cfg.maxRps)), cfg.maxRps),
      logger,
      timeoutMs: 10_000,
      retries: 2,
      headers: cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {},
    });
  }

  async quote(p: QuoteParams): Promise<JupiterQuote> {
    if (p.amountRaw <= 0n) throw new NonRetryableError('Jupiter: Betrag muss > 0 sein');
    if (p.inputMint === p.outputMint) throw new NonRetryableError('Jupiter: inputMint == outputMint');
    const q = await this.http.get<JupiterQuote & { error?: string }>('/quote', {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amountRaw.toString(),
      slippageBps: p.slippageBps,
      swapMode: 'ExactIn',
      restrictIntermediateTokens: true,
      maxAccounts: this.cfg.maxAccounts,
    });
    if (!q || typeof q.outAmount !== 'string' || typeof q.otherAmountThreshold !== 'string') {
      throw new NonRetryableError(`Jupiter: kein gültiger Quote (${q?.error ?? 'unbekannt'})`);
    }
    return q;
  }

  async buildSwap(quote: JupiterQuote, userPublicKey: string): Promise<JupiterSwapResponse> {
    const res = await this.http.post<JupiterSwapResponse & { error?: string }>('/swap', {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: this.cfg.maxPriorityFeeLamports,
          priorityLevel: this.cfg.priorityLevel,
        },
      },
    });
    if (!res || typeof res.swapTransaction !== 'string' || !Number.isFinite(res.lastValidBlockHeight)) {
      throw new NonRetryableError(`Jupiter /swap: ungültige Antwort (${res?.error ?? 'unbekannt'})`);
    }
    if (res.simulationError) {
      throw new NonRetryableError(`Jupiter /swap Simulationsfehler: ${JSON.stringify(res.simulationError)}`);
    }
    return res;
  }

  /** priceImpactPct wird von Jupiter als Bruchteil geliefert (0.01 = 1 %). */
  static priceImpactPct(q: JupiterQuote): number {
    const n = Number(q.priceImpactPct);
    return Number.isFinite(n) ? Math.abs(n) * 100 : 0;
  }

  static routeLabel(q: JupiterQuote): string {
    const labels = q.routePlan.map((s) => s.swapInfo.label ?? s.swapInfo.ammKey.slice(0, 4));
    return labels.length > 0 ? labels.join('→') : 'direct';
  }
}

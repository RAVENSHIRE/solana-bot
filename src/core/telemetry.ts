import fs from 'node:fs';
import path from 'node:path';
import { SOL_MINT, USDC_MINT, type ExecMode, type TradeRecord } from './types';
import type { Portfolio } from './portfolio';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { TradeExecutor } from '../execution/executor';
import type { JupiterClient } from '../execution/jupiter-client';
import type { Logger } from '../utils/logger';
import { DexScreenerClient } from '../data/dexscreener';
import { errorMessage } from '../utils/errors';
import { atomicWriteFile } from '../utils/fs';

/**
 * Laufzeit-Telemetrie für das Web-Dashboard.
 *
 * Der Portfolio-Zustand (state-{MODE}.json) enthält nur, was für den Handel persistiert werden muss.
 * Alles, was nur der Visualisierung dient – Entscheidungen, Watchlist, Preis-Ticks, Equity-Kurve,
 * RPC-Latenz, SOL/USD-Kurs – schreibt der Bot separat nach dashboard-{MODE}.json.
 * Alle Werte stammen aus echten Laufzeitdaten; nichts wird geschätzt oder aufgefüllt.
 */

export const TELEMETRY_VERSION = 1;

export type DecisionAction = 'BUY' | 'SELL' | 'SKIP' | 'WAIT';

export interface DecisionComponent {
  label: string;
  value: number;
  max: number;
}

export interface TelemetryDecision {
  id: string;
  ts: number;
  strategy: string;
  symbol: string;
  name: string | null;
  mint: string;
  action: DecisionAction;
  label: string;
  /** Regelbasierter Score 0–100 (kein ML-Modell). */
  score: number | null;
  min_score: number | null;
  components: DecisionComponent[];
  latency_ms: number;
  price_usd: number | null;
  safety: {
    checks_passed: boolean | null;
    reasons: string[];
    wash_ratio: number | null;
    organic_score: number | null;
    liquidity_usd: number | null;
  };
}

export interface TelemetryWatch {
  mint: string;
  symbol: string;
  name: string | null;
  strategy: string;
  price_usd: number | null;
  /** Echte Schlusskurse (5-Minuten-Kerzen, aufsteigend). */
  sparkline: number[];
  last_action: DecisionAction;
  score: number | null;
  updated_at: number;
}

export interface TelemetryTick {
  t: number;
  /** Preis pro ganzem Token in SOL (aus Jupiter-Quote bzw. tatsächlichem Fill). */
  price_sol: number;
  price_usd: number | null;
  marker: 'BUY' | 'SELL' | null;
}

export interface TelemetrySeries {
  mint: string;
  symbol: string;
  updated_at: number;
  ticks: TelemetryTick[];
}

export interface TelemetryEquity {
  t: number;
  equity_lamports: number;
  equity_usd?: number | null;
}

export interface TelemetryFile {
  version: number;
  bot_name: string;
  mode: ExecMode;
  network: string;
  started_at: number;
  updated_at: number;
  decision_cadence_seconds: number | null;
  sol_usd: number | null;
  sol_usd_at: number | null;
  rpc: Array<{ label: string; latency_ms: number | null; cooling: boolean }>;
  decisions: TelemetryDecision[];
  watchlist: TelemetryWatch[];
  series: TelemetrySeries[];
  market_ticks?: Array<{ mint: string; symbol: string; t: number; price_usd: number }>;
  trades: TradeRecord[];
  equity: TelemetryEquity[];
}

const LIMITS = { decisions: 300, watchlist: 40, series: 8, ticks: 400, trades: 500, equity: 2_880 } as const;
const WRITE_DEBOUNCE_MS = 750;

export interface TelemetryDeps {
  dir: string;
  mode: ExecMode;
  botName: string;
  logger: Logger;
  rpc: ConnectionManager;
  executor: TradeExecutor;
  portfolio: Portfolio;
  jupiter: JupiterClient;
  dex?: DexScreenerClient;
  decisionCadenceSeconds: number | null;
  sampleIntervalMs?: number;
}

export function telemetryFileName(mode: ExecMode): string {
  return `dashboard-${mode}.json`;
}

export class Telemetry {
  private timer: NodeJS.Timeout | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private seq = 0;
  private samples = 0;
  private readonly log: Logger;

  private constructor(
    private readonly d: TelemetryDeps,
    private readonly file: string,
    private data: TelemetryFile,
  ) {
    this.log = d.logger.child('telemetry');
  }

  static async load(d: TelemetryDeps): Promise<Telemetry> {
    await fs.promises.mkdir(d.dir, { recursive: true });
    const file = path.resolve(d.dir, telemetryFileName(d.mode));
    const now = Date.now();
    const fresh: TelemetryFile = {
      version: TELEMETRY_VERSION,
      bot_name: d.botName,
      mode: d.mode,
      network: 'Solana Mainnet',
      started_at: now,
      updated_at: now,
      decision_cadence_seconds: d.decisionCadenceSeconds,
      sol_usd: null,
      sol_usd_at: null,
      rpc: [],
      decisions: [],
      watchlist: [],
      series: [],
      market_ticks: [],
      trades: [],
      equity: [],
    };
    let data = fresh;
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Partial<TelemetryFile>;
      if (raw.version === TELEMETRY_VERSION && raw.mode === d.mode) {
        // Historie (Entscheidungen, Trades, Equity) über Neustarts hinweg behalten
        data = {
          ...fresh,
          decisions: raw.decisions ?? [],
          watchlist: raw.watchlist ?? [],
          series: raw.series ?? [],
          market_ticks: (raw.market_ticks ?? []).slice(-4000),
          trades: raw.trades ?? [],
          equity: raw.equity ?? [],
          sol_usd: raw.sol_usd ?? null,
          sol_usd_at: raw.sol_usd_at ?? null,
        };
      }
    } catch {
      // Keine oder unlesbare Datei → frisch beginnen (reine Visualisierungsdaten)
    }
    return new Telemetry(d, file, data);
  }

  start(): void {
    const interval = this.d.sampleIntervalMs ?? 30_000;
    const tick = (): void => {
      void this.sample().finally(() => {
        this.timer = setTimeout(tick, interval);
        this.timer.unref();
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.sample().catch(() => undefined);
    await this.flush();
  }

  solUsd(): number | null {
    return this.data.sol_usd;
  }

  // ------------------------------------------------------------------ Aufzeichnung

  recordDecision(dec: Omit<TelemetryDecision, 'id' | 'ts'>): void {
    this.seq++;
    const ts = Date.now();
    this.push(this.data.decisions, { ...dec, id: `${ts.toString(36)}-${this.seq}`, ts }, LIMITS.decisions);
    this.markDirty();
  }

  upsertWatch(w: Omit<TelemetryWatch, 'updated_at'>): void {
    const list = this.data.watchlist.filter((x) => x.mint !== w.mint);
    list.push({ ...w, sparkline: w.sparkline.slice(-48), updated_at: Date.now() });
    list.sort((a, b) => a.updated_at - b.updated_at);
    this.data.watchlist = list.slice(-LIMITS.watchlist);
    this.recordMarketTick(w.mint, w.symbol, w.price_usd);
    this.markDirty();
  }

  recordTick(mint: string, symbol: string, priceSol: number, marker: TelemetryTick['marker'] = null): void {
    if (!Number.isFinite(priceSol) || priceSol <= 0) return;
    const now = Date.now();
    let s = this.data.series.find((x) => x.mint === mint);
    if (!s) {
      s = { mint, symbol, updated_at: now, ticks: [] };
      this.data.series.push(s);
    }
    const usd = this.data.sol_usd;
    this.push(s.ticks, { t: now, price_sol: priceSol, price_usd: usd !== null ? priceSol * usd : null, marker }, LIMITS.ticks);
    s.updated_at = now;
    s.symbol = symbol;
    this.data.series.sort((a, b) => a.updated_at - b.updated_at);
    if (this.data.series.length > LIMITS.series) this.data.series.splice(0, this.data.series.length - LIMITS.series);
    this.markDirty();
  }

  private recordMarketTick(mint: string, symbol: string, price: number | null): void {
    if (price === null || !Number.isFinite(price) || price <= 0) return;
    const ticks = this.data.market_ticks ?? (this.data.market_ticks = []);
    this.push(ticks, { mint, symbol, t: Date.now(), price_usd: price }, 4000);
  }

  recordTrade(r: TradeRecord): void {
    this.push(this.data.trades, r, LIMITS.trades);
    this.markDirty();
  }

  // ------------------------------------------------------------------ Periodische Messungen

  private async sample(): Promise<void> {
    this.samples++;
    this.data.rpc = this.d.rpc.status().map((r) => ({ label: r.label, latency_ms: r.latencyMs, cooling: r.cooling }));

    // SOL/USD jede Minute über eine echte Jupiter-Quote (1 SOL → USDC)
    if (this.samples % 2 === 1 || this.data.sol_usd === null) {
      try {
        const q = await this.d.jupiter.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amountRaw: 1_000_000_000n, slippageBps: 50 });
        const px = Number(q.outAmount) / 1e6;
        if (Number.isFinite(px) && px > 0) {
          this.data.sol_usd = px;
          this.data.sol_usd_at = Date.now();
        }
      } catch (e) {
        this.log.debug('SOL/USD-Kurs nicht abrufbar', { error: errorMessage(e) });
      }
    }

    try {
      const free = await this.d.executor.getSolBalanceLamports();
      const invested = this.d.portfolio.positions().reduce((s, p) => s + p.lastValueLamports, 0n);
      const now = Date.now();
      const solUsd = this.data.sol_usd_at !== null && now - this.data.sol_usd_at <= 90_000 ? this.data.sol_usd : null;
      const lamports = Number(free + invested);
      this.push(this.data.equity, { t: now, equity_lamports: lamports, equity_usd: solUsd !== null ? lamports / 1e9 * solUsd : null }, LIMITS.equity);
    } catch (e) {
      this.log.debug('Equity-Messung fehlgeschlagen', { error: errorMessage(e) });
    }
    // Read-only price observations for evaluated tokens, including tokens not yet traded.
    // One bounded batch per sample; prices come from the existing market client.
    if (this.d.dex) {
      try {
        const mints = [...new Set([
          ...this.d.portfolio.positions().map(p => p.mint),
          ...[...this.data.watchlist].reverse().map(w => w.mint),
        ])].slice(0, 24);
        if (mints.length) {
          const pairs = await this.d.dex.getPairsForTokens(mints);
          for (const [mint, pair] of DexScreenerClient.bestPairPerToken(pairs)) {
            const price = Number(pair.priceUsd);
            if (!Number.isFinite(price) || price <= 0) continue;
            this.recordMarketTick(mint, pair.baseToken.symbol ?? mint.slice(0, 8), price);
            const watch = this.data.watchlist.find(w => w.mint === mint);
            if (watch) { watch.price_usd = price; watch.updated_at = Date.now(); }
          }
        }
      } catch (e) {
        this.log.debug('Dashboard-Preise nicht abrufbar', { error: errorMessage(e) });
      }
    }
    this.markDirty();
  }

  // ------------------------------------------------------------------ Persistenz

  private push<T>(arr: T[], item: T, limit: number): void {
    arr.push(item);
    if (arr.length > limit) arr.splice(0, arr.length - limit);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush().catch((e) => this.log.warn('Telemetrie konnte nicht geschrieben werden', { error: errorMessage(e) }));
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.data.updated_at = Date.now();
    try {
      await atomicWriteFile(this.file, JSON.stringify(this.data));
    } catch (e) {
      this.markDirty();
      throw e;
    }
  }
}

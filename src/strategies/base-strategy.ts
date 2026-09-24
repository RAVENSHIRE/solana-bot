import { randomBytes } from 'node:crypto';
import type { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config/config';
import type { ConnectionManager } from '../rpc/connection-manager';
import { SwapError, type SwapFill, type TradeExecutor } from '../execution/executor';
import type { JupiterClient } from '../execution/jupiter-client';
import type { Portfolio } from '../core/portfolio';
import type { RiskManager } from '../core/risk-manager';
import type { TradeJournal } from '../core/journal';
import type { DexScreenerClient } from '../data/dexscreener';
import type { GeckoTerminalClient } from '../data/geckoterminal';
import type { RaydiumClient } from '../data/raydium';
import type { TokenSafetyChecker } from '../analysis/token-safety';
import {
  BASE_FEE_LAMPORTS,
  SOL_MINT,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  type ClosedTrade,
  type ExitRules,
  type Position,
  type Side,
  type Strategy,
} from '../core/types';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { sleep } from '../utils/retry';
import { formatTokenAmount, lamportsToSol, pctChange, round } from '../utils/format';

export interface StrategyContext {
  cfg: AppConfig;
  logger: Logger;
  rpc: ConnectionManager;
  executor: TradeExecutor;
  jupiter: JupiterClient;
  portfolio: Portfolio;
  risk: RiskManager;
  journal: TradeJournal;
  dex: DexScreenerClient;
  gecko: GeckoTerminalClient;
  raydium: RaydiumClient;
  safety: TokenSafetyChecker;
  wallet: PublicKey;
}

export interface OpenParams {
  mint: string;
  symbol: string;
  decimals: number;
  pairAddress: string | null;
  sizeLamports: bigint;
  slippageBps: number;
  maxPriceImpactPct?: number;
  exitRules: ExitRules;
  signal: string;
  entryPriceUsd: number | null;
  tags?: Record<string, string | number | boolean>;
  /** Risiko-Prüfung überspringen (nur für bereits geprüfte, atomar gedachte Legs). */
  skipRiskCheck?: boolean;
}

export interface ExitDecision {
  reason: string;
  pnlPct: number;
  emergency: boolean;
}

/**
 * Mints, für die gerade ein Swap läuft (strategieübergreifend). Der Rent-Reclaimer
 * schließt deren Token-Konten nicht, um keine laufende Transaktion zu stören.
 */
export const inFlightMints = new Set<string>();

/** Nach so vielen erfolglosen Bewertungen (kein Quote/keine Route) wird eine Position abgeschrieben. */
const MAX_VALUATION_MISSES = 30;

/**
 * Gemeinsame Basis aller Strategien: Ein-/Ausstieg mit Risiko-Check, Fehlerbehandlung,
 * Slippage-Eskalation, Rent-Rückholung, Bewertung und Standard-Exit-Regeln.
 * Konkrete Strategien implementieren nur scan() (Signale) und optional customExit().
 */
export abstract class BaseStrategy implements Strategy {
  abstract readonly name: string;
  abstract readonly enabled: boolean;
  abstract readonly scanIntervalMs: number;
  abstract readonly manageIntervalMs: number;

  protected constructor(protected readonly ctx: StrategyContext) {}

  private _log: Logger | null = null;
  protected get log(): Logger {
    if (!this._log) this._log = this.ctx.logger.child(this.name);
    return this._log;
  }

  async init(): Promise<void> {
    const own = this.ctx.portfolio.positionsFor(this.name);
    if (own.length > 0) {
      this.log.info(`${own.length} offene Position(en) aus Zustandsdatei übernommen`, {
        positions: own.map((p) => `${p.symbol}(${p.id})`),
      });
    }
  }

  abstract scan(): Promise<void>;

  async manage(): Promise<void> {
    await this.manageOpenPositions();
  }

  async shutdown(): Promise<void> {
    const open = this.ctx.portfolio.positionsFor(this.name).length;
    if (open > 0) this.log.info(`${open} Position(en) bleiben offen und werden nach Neustart weiterverwaltet`);
  }

  // ======================================================================= Einstieg

  protected async openPosition(p: OpenParams): Promise<Position | null> {
    const { executor, portfolio, risk } = this.ctx;
    if (!p.skipRiskCheck) {
      const available = await executor.getSolBalanceLamports();
      const decision = risk.canOpen({ strategy: this.name, mint: p.mint, sizeLamports: p.sizeLamports, availableLamports: available });
      if (!decision.ok) {
        this.log.info(`Einstieg ${p.symbol} abgelehnt (Risiko): ${decision.reason}`);
        return null;
      }
    }

    let fill: SwapFill;
    inFlightMints.add(p.mint);
    try {
      fill = await executor.swap({
        side: 'BUY',
        mint: p.mint,
        amountRaw: p.sizeLamports,
        slippageBps: p.slippageBps,
        maxPriceImpactPct: p.maxPriceImpactPct,
      });
    } catch (e) {
      this.handleSwapFailure(e, 'BUY', p.mint, p.symbol, p.signal);
      if (e instanceof SwapError && e.stage === 'unknown' && executor.mode === 'LIVE') {
        return this.reconstructUnknownBuy(p);
      }
      return null;
    } finally {
      inFlightMints.delete(p.mint);
    }
    risk.recordTxResult(true);

    let tokenAmount = fill.outAmountRaw;
    if (tokenAmount <= 0n && executor.mode === 'LIVE') {
      tokenAmount = await executor.getTokenBalanceRaw(p.mint).catch(() => 0n);
    }
    if (tokenAmount <= 0n) {
      this.log.error(`Kauf ${p.symbol} bestätigt, aber kein Token-Bestand ermittelbar – bitte manuell prüfen`, {
        signature: fill.signature,
      });
      portfolio.chargeFee(this.name, -fill.solDeltaLamports);
      return null;
    }

    const cost = -fill.solDeltaLamports;
    const pos: Position = {
      id: `${this.name}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      strategy: this.name,
      mint: p.mint,
      symbol: p.symbol,
      decimals: p.decimals,
      pairAddress: p.pairAddress,
      tokenAmountRaw: tokenAmount,
      costLamports: cost,
      entryInputLamports: fill.inAmountRaw,
      entryPriceUsd: p.entryPriceUsd,
      openedAt: Date.now(),
      peakValueLamports: cost,
      lastValueLamports: cost,
      lastCheckedAt: Date.now(),
      exitRules: p.exitRules,
      entrySignal: p.signal,
      tags: { ...(p.tags ?? {}), slippageBps: p.slippageBps },
      closing: false,
      exitFailures: 0,
      valuationMisses: 0,
    };
    portfolio.openPosition(pos);

    this.ctx.journal.record({
      strategy: this.name,
      action: 'BUY',
      symbol: p.symbol,
      mint: p.mint,
      signal: p.signal,
      inAmount: `${lamportsToSol(fill.inAmountRaw)} SOL`,
      outAmount: `${formatTokenAmount(tokenAmount, p.decimals)} ${p.symbol}`,
      feesSol: lamportsToSol(fill.feeLamports),
      priceImpactPct: round(fill.priceImpactPct, 4),
      slippageBps: fill.realizedSlippageBps,
      signature: fill.signature,
      pnlSol: null,
      pnlPct: null,
      note: `route=${fill.route} rent=${lamportsToSol(fill.rentLamports)} cost=${lamportsToSol(cost)} SOL latency=${fill.latencyMs}ms`,
    });
    return pos;
  }

  /**
   * LIVE: Status eines Kaufs unbekannt (RPC-Ausfall während Bestätigung). Wenn Tokens angekommen sind,
   * wird die Position konservativ rekonstruiert, damit sie nicht unverwaltet in der Wallet liegt.
   */
  private async reconstructUnknownBuy(p: OpenParams): Promise<Position | null> {
    await sleep(8_000);
    const balance = await this.ctx.executor.getTokenBalanceRaw(p.mint).catch(() => 0n);
    if (balance <= 0n) {
      this.log.warn(`Unbekannter Kauf ${p.symbol}: keine Tokens in der Wallet – vermutlich nicht gelandet`);
      return null;
    }
    const estCost = p.sizeLamports + BASE_FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS;
    const pos: Position = {
      id: `${this.name}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      strategy: this.name,
      mint: p.mint,
      symbol: p.symbol,
      decimals: p.decimals,
      pairAddress: p.pairAddress,
      tokenAmountRaw: balance,
      costLamports: estCost,
      entryInputLamports: p.sizeLamports,
      entryPriceUsd: p.entryPriceUsd,
      openedAt: Date.now(),
      peakValueLamports: estCost,
      lastValueLamports: estCost,
      lastCheckedAt: Date.now(),
      exitRules: p.exitRules,
      entrySignal: `${p.signal} [rekonstruiert]`,
      tags: { ...(p.tags ?? {}), slippageBps: p.slippageBps, reconstructed: true },
      closing: false,
      exitFailures: 0,
      valuationMisses: 0,
    };
    this.ctx.portfolio.openPosition(pos);
    this.log.warn(`Position ${p.symbol} aus On-Chain-Bestand rekonstruiert (Kosten geschätzt)`, { id: pos.id });
    return pos;
  }

  // ======================================================================= Ausstieg

  protected async closePosition(pos: Position, reason: string, emergency = false): Promise<ClosedTrade | null> {
    const { executor, portfolio, cfg } = this.ctx;
    const current = portfolio.getPosition(pos.id);
    if (!current || current.closing) return null;
    portfolio.updatePosition(pos.id, { closing: true });
    inFlightMints.add(current.mint);

    try {
      let amount = current.tokenAmountRaw;
      if (executor.mode === 'LIVE') {
        const onChain = await executor.getTokenBalanceRaw(current.mint);
        if (onChain <= 0n) {
          return this.handleMissingTokens(current, reason);
        }
        if (onChain < amount) {
          this.log.warn(`On-Chain-Bestand ${current.symbol} kleiner als erwartet – verkaufe vorhandene Menge`, {
            expected: amount.toString(),
            onChain: onChain.toString(),
          });
          amount = onChain;
        }
      }

      const baseSlip = typeof current.tags.slippageBps === 'number' ? current.tags.slippageBps : cfg.execution.defaultSlippageBps;
      const escalate = 1 + current.exitFailures;
      let slippageBps = Math.min(3_000, baseSlip * escalate);
      let maxImpact = Math.max(cfg.execution.maxPriceImpactPct * 3, 15);
      if (emergency || current.exitFailures >= 3) {
        slippageBps = Math.min(5_000, slippageBps * 2);
        maxImpact = 60;
      }

      let fill: SwapFill;
      try {
        fill = await executor.swap({ side: 'SELL', mint: current.mint, amountRaw: amount, slippageBps, maxPriceImpactPct: maxImpact });
      } catch (e) {
        this.handleSwapFailure(e, 'SELL', current.mint, current.symbol, reason);
        const failures = current.exitFailures + 1;
        const patch: Partial<Position> = { closing: false, exitFailures: failures };
        if (e instanceof SwapError && e.stage === 'unknown' && e.signature) {
          patch.tags = { ...current.tags, pendingSellSig: e.signature };
        }
        portfolio.updatePosition(current.id, patch);
        this.log.warn(`Exit ${current.symbol} fehlgeschlagen (Versuch ${failures}) – nächster Versuch mit höherer Slippage`);
        return null;
      }
      this.ctx.risk.recordTxResult(true);

      const rent = await executor.closeTokenAccountIfEmpty(current.mint);
      const proceeds = fill.solDeltaLamports + rent;
      const trade = portfolio.closePosition(current.id, proceeds, reason, fill.feeLamports);
      if (!trade) return null;
      if (trade.pnlLamports < 0n) {
        portfolio.setCooldown(current.mint, cfg.risk.lossCooldownMin * 60_000);
      }

      this.ctx.journal.record({
        strategy: this.name,
        action: 'SELL',
        symbol: current.symbol,
        mint: current.mint,
        signal: reason,
        inAmount: `${formatTokenAmount(amount, current.decimals)} ${current.symbol}`,
        outAmount: `${lamportsToSol(fill.outAmountRaw)} SOL`,
        feesSol: lamportsToSol(fill.feeLamports),
        priceImpactPct: round(fill.priceImpactPct, 4),
        slippageBps: fill.realizedSlippageBps,
        signature: fill.signature,
        pnlSol: lamportsToSol(trade.pnlLamports),
        pnlPct: round(trade.pnlPct, 2),
        note: `hold=${Math.round((trade.closedAt - trade.openedAt) / 1000)}s rent+=${lamportsToSol(rent)} entry="${current.entrySignal}"`,
      });
      return trade;
    } catch (e) {
      portfolio.updatePosition(current.id, { closing: false, exitFailures: current.exitFailures + 1 });
      this.log.error(`Unerwarteter Fehler beim Schließen von ${current.symbol}`, { error: errorMessage(e) });
      return null;
    } finally {
      inFlightMints.delete(current.mint);
    }
  }

  /** LIVE: Token nicht mehr in der Wallet (extern verkauft oder unbekannter Sell gelandet). */
  private handleMissingTokens(pos: Position, reason: string): ClosedTrade | null {
    const pendingSig = typeof pos.tags.pendingSellSig === 'string' ? pos.tags.pendingSellSig : null;
    const proceeds = pendingSig ? pos.lastValueLamports : 0n;
    const note = pendingSig
      ? `Verkauf ${pendingSig} vermutlich gelandet – Erlös geschätzt, bitte im Explorer prüfen`
      : 'Keine Tokens mehr in der Wallet (extern bewegt?) – abgeschrieben';
    const trade = this.ctx.portfolio.closePosition(pos.id, proceeds, pendingSig ? `${reason}(geschätzt)` : 'WRITE_OFF');
    if (!trade) return null;
    this.ctx.journal.record({
      strategy: this.name,
      action: pendingSig ? 'SELL' : 'WRITE_OFF',
      symbol: pos.symbol,
      mint: pos.mint,
      signal: reason,
      inAmount: `${formatTokenAmount(pos.tokenAmountRaw, pos.decimals)} ${pos.symbol}`,
      outAmount: `${lamportsToSol(proceeds)} SOL`,
      feesSol: '0',
      priceImpactPct: null,
      slippageBps: null,
      signature: pendingSig,
      pnlSol: lamportsToSol(trade.pnlLamports),
      pnlPct: round(trade.pnlPct, 2),
      note,
    });
    this.log.warn(note, { symbol: pos.symbol, id: pos.id });
    return trade;
  }

  protected handleSwapFailure(e: unknown, side: Side, mint: string, symbol: string, signal: string): void {
    if (!(e instanceof SwapError)) {
      this.ctx.risk.recordTxResult(false);
      this.log.error(`${side} ${symbol}: unerwarteter Fehler`, { error: errorMessage(e) });
      return;
    }
    if (!e.isExecutionFailure) {
      // Kein Quote / Impact zu hoch / Build-Fehler: kein Geld bewegt
      this.log.info(`${side} ${symbol} nicht ausgeführt (${e.stage}): ${e.message}`);
      return;
    }
    this.ctx.risk.recordTxResult(false);
    if (e.feeLamports > 0n) this.ctx.portfolio.chargeFee(this.name, e.feeLamports);
    if (e.stage === 'unknown') {
      this.log.error(`${side} ${symbol}: Transaktionsstatus UNBEKANNT – bitte im Explorer prüfen`, { signature: e.signature });
    }
    this.ctx.journal.record({
      strategy: this.name,
      action: side === 'BUY' ? 'BUY_FAILED' : 'SELL_FAILED',
      symbol,
      mint,
      signal,
      inAmount: '-',
      outAmount: '-',
      feesSol: lamportsToSol(e.feeLamports),
      priceImpactPct: null,
      slippageBps: null,
      signature: e.signature,
      pnlSol: e.feeLamports > 0n ? lamportsToSol(-e.feeLamports) : null,
      pnlPct: null,
      note: `${e.stage}: ${e.message.slice(0, 180)}`,
    });
  }

  // ======================================================================= Bewertung & Exits

  /**
   * Liquidationswert einer Position in Lamports: Sell-Quote − geschätzte Fees + zurückholbare ATA-Rent.
   * null, wenn keine Route/kein Quote verfügbar.
   */
  protected async valuePosition(pos: Position): Promise<bigint | null> {
    try {
      const q = await this.ctx.jupiter.quote({
        inputMint: pos.mint,
        outputMint: SOL_MINT,
        amountRaw: pos.tokenAmountRaw,
        slippageBps: this.ctx.cfg.execution.defaultSlippageBps,
      });
      const priority = await this.ctx.executor.estimatePriorityFeeLamports();
      const rent = this.ctx.cfg.execution.closeEmptyAccounts ? TOKEN_ACCOUNT_RENT_LAMPORTS - BASE_FEE_LAMPORTS : 0n;
      return BigInt(q.outAmount) - BASE_FEE_LAMPORTS - priority + rent;
    } catch (e) {
      this.log.debug(`Bewertung ${pos.symbol} fehlgeschlagen`, { error: errorMessage(e) });
      return null;
    }
  }

  protected evaluateExit(pos: Position, value: bigint): ExitDecision | null {
    const r = pos.exitRules;
    const pnlPct = pctChange(pos.costLamports, value);
    const peakPct = pctChange(pos.costLamports, pos.peakValueLamports);
    if (pnlPct <= -r.stopLossPct) return { reason: `STOP_LOSS(${round(pnlPct, 2)}%)`, pnlPct, emergency: true };
    if (pnlPct >= r.takeProfitPct) return { reason: `TAKE_PROFIT(${round(pnlPct, 2)}%)`, pnlPct, emergency: false };
    if (r.trailingStopPct > 0 && peakPct >= r.trailingActivationPct && pos.peakValueLamports > 0n) {
      const fromPeak = pctChange(pos.peakValueLamports, value);
      if (fromPeak <= -r.trailingStopPct) {
        return { reason: `TRAILING_STOP(peak ${round(peakPct, 2)}% → ${round(pnlPct, 2)}%)`, pnlPct, emergency: false };
      }
    }
    if (Date.now() - pos.openedAt >= r.maxHoldMs) return { reason: `MAX_HOLD(${round(pnlPct, 2)}%)`, pnlPct, emergency: false };
    return null;
  }

  /** Strategie-spezifische Zusatz-Exits (z. B. Support gebrochen). */
  protected async customExit(_pos: Position, _value: bigint): Promise<ExitDecision | null> {
    return null;
  }

  protected async manageOpenPositions(): Promise<void> {
    const positions = this.ctx.portfolio.positionsFor(this.name).filter((p) => !p.closing);
    for (const pos of positions) {
      try {
        await this.manageOne(pos);
      } catch (e) {
        this.log.warn(`Verwaltung ${pos.symbol} fehlgeschlagen`, { error: errorMessage(e) });
      }
    }
  }

  private async manageOne(pos: Position): Promise<void> {
    const { portfolio } = this.ctx;
    const value = await this.valuePosition(pos);
    if (value === null) {
      const misses = pos.valuationMisses + 1;
      portfolio.updatePosition(pos.id, { valuationMisses: misses, lastCheckedAt: Date.now() });
      if (misses >= MAX_VALUATION_MISSES) this.writeOff(pos, `keine Route seit ${misses} Bewertungen`);
      else if (misses % 5 === 0) this.log.warn(`${pos.symbol}: ${misses} Bewertungen ohne Quote`);
      return;
    }

    const peak = value > pos.peakValueLamports ? value : pos.peakValueLamports;
    portfolio.updatePosition(pos.id, { lastValueLamports: value, peakValueLamports: peak, lastCheckedAt: Date.now(), valuationMisses: 0 });
    const fresh = portfolio.getPosition(pos.id);
    if (!fresh) return;

    const decision = this.evaluateExit(fresh, value) ?? (await this.customExit(fresh, value));
    if (decision) {
      this.log.info(`Exit-Signal ${fresh.symbol}: ${decision.reason}`, { valueSol: lamportsToSol(value), costSol: lamportsToSol(fresh.costLamports) });
      await this.closePosition(fresh, decision.reason, decision.emergency);
    } else if (this.log.isDebugEnabled()) {
      this.log.debug(`${fresh.symbol} gehalten`, {
        pnlPct: round(pctChange(fresh.costLamports, value), 2),
        ageMin: round((Date.now() - fresh.openedAt) / 60_000, 1),
      });
    }
  }

  private writeOff(pos: Position, why: string): void {
    const trade = this.ctx.portfolio.closePosition(pos.id, 0n, 'WRITE_OFF');
    if (!trade) return;
    this.ctx.portfolio.setCooldown(pos.mint, 7 * 24 * 60 * 60_000);
    this.ctx.journal.record({
      strategy: this.name,
      action: 'WRITE_OFF',
      symbol: pos.symbol,
      mint: pos.mint,
      signal: why,
      inAmount: `${formatTokenAmount(pos.tokenAmountRaw, pos.decimals)} ${pos.symbol}`,
      outAmount: '0 SOL',
      feesSol: '0',
      priceImpactPct: null,
      slippageBps: null,
      signature: null,
      pnlSol: lamportsToSol(trade.pnlLamports),
      pnlPct: round(trade.pnlPct, 2),
      note: this.ctx.executor.mode === 'LIVE' ? 'Tokens verbleiben ggf. in der Wallet (nicht mehr verwaltet)' : undefined,
    });
  }
}

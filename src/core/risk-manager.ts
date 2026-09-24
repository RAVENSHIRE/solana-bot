import type { AppConfig } from '../config/config';
import type { Portfolio } from './portfolio';
import type { Logger } from '../utils/logger';
import { lamportsToSol, solToLamports } from '../utils/format';

export interface RiskCheckInput {
  strategy: string;
  mint: string;
  sizeLamports: bigint;
  /** Aktuell verfügbares SOL (echt oder virtuell). */
  availableLamports: bigint;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

/**
 * Zentrale Risikokontrolle – jede Eröffnung muss hier durch.
 * Prüft: Circuit Breaker, Tagesverlust-Limit, Positionsgröße, Anzahl offener Positionen,
 * Gesamt-Exposure, SOL-Reserve (für Fees), Duplikate und Cooldowns.
 */
export class RiskManager {
  private consecutiveTxFailures = 0;
  private haltedUntil = 0;
  private haltReason = '';
  private readonly maxPosition: bigint;
  private readonly maxExposure: bigint;
  private readonly maxDailyLoss: bigint;
  private readonly reserve: bigint;

  constructor(
    private readonly cfg: AppConfig['risk'],
    private readonly portfolio: Portfolio,
    private readonly log: Logger,
  ) {
    this.maxPosition = solToLamports(cfg.maxPositionSol);
    this.maxExposure = solToLamports(cfg.maxTotalExposureSol);
    this.maxDailyLoss = solToLamports(cfg.maxDailyLossSol);
    this.reserve = solToLamports(cfg.minSolReserve);
  }

  canOpen(i: RiskCheckInput): RiskDecision {
    if (this.isHalted()) return { ok: false, reason: `Circuit Breaker aktiv (${this.haltReason})` };

    const daily = this.portfolio.dailyPnlLamports();
    if (daily <= -this.maxDailyLoss) {
      return { ok: false, reason: `Tagesverlust-Limit erreicht (${lamportsToSol(daily)} SOL)` };
    }
    if (i.sizeLamports <= 0n) return { ok: false, reason: 'Positionsgröße ≤ 0' };
    if (i.sizeLamports > this.maxPosition) {
      return { ok: false, reason: `Größe ${lamportsToSol(i.sizeLamports)} > Max ${this.cfg.maxPositionSol} SOL` };
    }
    const open = this.portfolio.positions().length;
    if (open >= this.cfg.maxOpenPositions) return { ok: false, reason: `Max. offene Positionen (${open}) erreicht` };

    const exposure = this.portfolio.exposureLamports();
    if (exposure + i.sizeLamports > this.maxExposure) {
      return {
        ok: false,
        reason: `Exposure ${lamportsToSol(exposure + i.sizeLamports, 4)} > Max ${this.cfg.maxTotalExposureSol} SOL`,
      };
    }
    if (i.availableLamports - i.sizeLamports < this.reserve) {
      return {
        ok: false,
        reason: `SOL-Reserve würde unterschritten (verfügbar ${lamportsToSol(i.availableLamports, 4)} SOL)`,
      };
    }
    if (this.portfolio.hasOpenPosition(i.mint)) return { ok: false, reason: 'Bereits Position in diesem Token' };
    if (this.portfolio.isCoolingDown(i.mint)) return { ok: false, reason: 'Token im Cooldown' };
    return { ok: true };
  }

  /** Nur Ausführungsfehler (nicht "kein Quote") zählen für den Circuit Breaker. */
  recordTxResult(success: boolean): void {
    if (success) {
      this.consecutiveTxFailures = 0;
      return;
    }
    this.consecutiveTxFailures++;
    if (this.consecutiveTxFailures >= this.cfg.maxConsecutiveTxFailures) {
      this.halt(`${this.consecutiveTxFailures} fehlgeschlagene Transaktionen in Folge`, this.cfg.circuitBreakerPauseMin);
      this.consecutiveTxFailures = 0;
    }
  }

  halt(reason: string, minutes: number): void {
    this.haltedUntil = Date.now() + minutes * 60_000;
    this.haltReason = reason;
    this.log.error(`CIRCUIT BREAKER: neue Einstiege für ${minutes} min pausiert`, { reason });
  }

  isHalted(): boolean {
    if (this.haltedUntil === 0) return false;
    if (Date.now() >= this.haltedUntil) {
      this.log.info('Circuit Breaker aufgehoben – Einstiege wieder erlaubt');
      this.haltedUntil = 0;
      this.haltReason = '';
      return false;
    }
    return true;
  }

  statusText(): string {
    if (this.isHalted()) {
      const min = Math.ceil((this.haltedUntil - Date.now()) / 60_000);
      return `HALTED (${this.haltReason}, noch ~${min} min)`;
    }
    const daily = this.portfolio.dailyPnlLamports();
    return `OK (Tages-PnL ${lamportsToSol(daily, 4)} / Limit -${this.cfg.maxDailyLossSol} SOL, Tx-Fehler in Folge ${this.consecutiveTxFailures})`;
  }
}

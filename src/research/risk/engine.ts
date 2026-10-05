import { fingerprint } from '../core/canonical';

/**
 * Risk boundaries that sit between a signal and an order and can always override the strategy. Used by every research
 * backtest (so a backtest cannot take risk the live system would refuse) and designed to be wired in front of live
 * execution later. Exits are never blocked by risk.
 *
 * The kill switch is latched: once tripped (manually, by the drawdown limit, by repeated execution failures or by an
 * unhealthy system) nothing new is opened until an operator resets it with a reason, and the reset is recorded.
 */

export interface RiskLimits {
  maxPositionUsd: number;
  maxExposureUsd: number;
  maxOpenPositions: number;
  /** A position may not be larger than this share of the pool's liquidity (e.g. 0.02 = 2 %). */
  maxPositionToLiquidity: number;
  minLiquidityUsd: number;
  /** Realised loss per UTC day after which entries stop until the next day. */
  maxDailyLossUsd: number;
  /** Peak-to-trough fall of realised equity that trips the kill switch. */
  maxDrawdownUsd: number;
  /** Inputs older than this at decision time are stale: no entry. */
  maxDataAgeMs: number;
  /** Consecutive failed executions that trip the kill switch. */
  maxConsecutiveExecFailures: number;
  /** Entries require a healthy system snapshot. */
  requireHealthy: boolean;
}

export const RESEARCH_DEFAULT_LIMITS: RiskLimits = {
  maxPositionUsd: 10, maxExposureUsd: 30, maxOpenPositions: 3, maxPositionToLiquidity: 0.02, minLiquidityUsd: 10_000,
  maxDailyLossUsd: 10, maxDrawdownUsd: 20, maxDataAgeMs: 120_000, maxConsecutiveExecFailures: 5, requireHealthy: true,
};

export const riskFingerprint = (l: RiskLimits): string => fingerprint(l);

export interface EntryRequest {
  at: number; token: string; sizeUsd: number;
  liquidityUsd: number | null;
  /** Age of the newest input the decision used (decision time − its observation time). */
  dataAgeMs: number | null;
  healthy: boolean | null;
}
export type RiskVerdict =
  | { decision: 'ALLOW'; sizeUsd: number; reasons: string[] }
  | { decision: 'REDUCE'; sizeUsd: number; reasons: string[] }
  | { decision: 'DENY'; sizeUsd: 0; reasons: string[] };

export interface RiskEvent { at: number; kind: 'KILL' | 'RESET' | 'DAILY_HALT' | 'DENY'; reason: string; actor?: string }

const day = (t: number) => Math.floor(t / 86_400_000);

export class RiskEngine {
  private open = new Map<string, number>();
  private realized = 0;
  private peak = 0;
  private dailyLoss = new Map<number, number>();
  private failures = 0;
  private killed: { at: number; reason: string } | null = null;
  readonly log: RiskEvent[] = [];

  constructor(readonly limits: RiskLimits) {
    for (const [k, v] of Object.entries(limits)) if (typeof v === 'number' && !(v >= 0)) throw new Error(`Risk limit ${k} must be ≥ 0`);
  }

  get state() {
    return { openPositions: this.open.size, exposureUsd: [...this.open.values()].reduce((a, x) => a + x, 0), realizedPnlUsd: this.realized,
      drawdownUsd: this.peak - this.realized, consecutiveExecFailures: this.failures, killed: this.killed };
  }

  /** Every reason that blocks or shrinks an entry is listed, not only the first. */
  evaluateEntry(r: EntryRequest): RiskVerdict {
    const L = this.limits, deny: string[] = [], notes: string[] = [];
    if (this.killed) deny.push(`KILL_SWITCH: ${this.killed.reason}`);
    if (L.requireHealthy && r.healthy !== true) deny.push(r.healthy === null ? 'SYSTEM_HEALTH_UNKNOWN' : 'SYSTEM_UNHEALTHY');
    if (r.dataAgeMs === null) deny.push('DATA_AGE_UNKNOWN'); else if (r.dataAgeMs > L.maxDataAgeMs) deny.push(`STALE_DATA (${Math.round(r.dataAgeMs / 1000)} s)`);
    if (this.open.has(r.token)) deny.push('ALREADY_IN_POSITION');
    if (this.open.size >= L.maxOpenPositions) deny.push('MAX_OPEN_POSITIONS');
    if ((this.dailyLoss.get(day(r.at)) ?? 0) >= L.maxDailyLossUsd) deny.push('DAILY_LOSS_LIMIT');
    if (r.liquidityUsd === null) deny.push('LIQUIDITY_UNKNOWN'); else if (r.liquidityUsd < L.minLiquidityUsd) deny.push('LIQUIDITY_BELOW_MINIMUM');
    if (!(r.sizeUsd > 0)) deny.push('INVALID_SIZE');
    if (deny.length) { this.log.push({ at: r.at, kind: 'DENY', reason: deny.join('; ') }); return { decision: 'DENY', sizeUsd: 0, reasons: deny }; }
    let size = r.sizeUsd;
    const cap = (limit: number, why: string) => { if (size > limit) { size = limit; notes.push(why); } };
    cap(L.maxPositionUsd, 'MAX_POSITION');
    cap(L.maxExposureUsd - this.state.exposureUsd, 'MAX_EXPOSURE');
    cap(r.liquidityUsd! * L.maxPositionToLiquidity, 'LIQUIDITY_SHARE');
    if (size <= 0.01) { this.log.push({ at: r.at, kind: 'DENY', reason: notes.join('; ') }); return { decision: 'DENY', sizeUsd: 0, reasons: notes }; }
    return notes.length ? { decision: 'REDUCE', sizeUsd: size, reasons: notes } : { decision: 'ALLOW', sizeUsd: size, reasons: [] };
  }

  onEntry(token: string, sizeUsd: number): void { this.open.set(token, sizeUsd); this.failures = 0; }

  /** A position closed (or written off). Exits are never refused; they only update the books. */
  onExit(token: string, at: number, pnlUsd: number): void {
    this.open.delete(token);
    this.realized += pnlUsd; this.peak = Math.max(this.peak, this.realized);
    if (pnlUsd < 0) {
      const d = day(at), loss = (this.dailyLoss.get(d) ?? 0) - pnlUsd;
      this.dailyLoss.set(d, loss);
      if (loss >= this.limits.maxDailyLossUsd && loss + pnlUsd < this.limits.maxDailyLossUsd) this.log.push({ at, kind: 'DAILY_HALT', reason: `daily loss ${loss.toFixed(2)} USD` });
    }
    if (this.peak - this.realized >= this.limits.maxDrawdownUsd) this.kill(at, `DRAWDOWN ${(this.peak - this.realized).toFixed(2)} USD`);
  }

  onExecutionFailure(at: number): void {
    this.failures++;
    if (this.failures >= this.limits.maxConsecutiveExecFailures) this.kill(at, `${this.failures} EXECUTION FAILURES IN A ROW`);
  }

  /** Emergency stop (also used by health checks). Idempotent while tripped. */
  kill(at: number, reason: string, actor = 'system'): void {
    if (this.killed) return;
    this.killed = { at, reason };
    this.log.push({ at, kind: 'KILL', reason, actor });
  }

  /** Only an explicit operator reset re-enables entries. */
  reset(at: number, actor: string, reason: string): void {
    if (!actor.trim() || !reason.trim()) throw new Error('RISK_RESET_REQUIRES_ACTOR_AND_REASON');
    if (!this.killed) return;
    this.killed = null; this.failures = 0; this.peak = this.realized;
    this.log.push({ at, kind: 'RESET', reason, actor });
  }
}

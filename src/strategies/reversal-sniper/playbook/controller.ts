import type { AppConfig } from '../../../config/config';
import type { Portfolio } from '../../../core/portfolio';
import type { RiskManager } from '../../../core/risk-manager';
import { BASE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, type TradeRecord } from '../../../core/types';
import { SwapError, type TradeExecutor, type SwapFill } from '../../../execution/executor';
import { lamportsToSol, solToLamports } from '../../../utils/format';
import { CycleSchema, PLAYBOOK, evaluate, type Cycle, type Snapshot, type EntryEvidence, type Intent } from './model';

export interface ControllerOptions {
  maxCap: number; initialStopPct: number; maxHoldMs: number; tradeSizeLamports: bigint;
}
export class PlaybookController {
  readonly cycles = new Map<string, Cycle>();
  private queue: Promise<unknown> = Promise.resolve();
  private fatal: unknown;
  constructor(private readonly portfolio: Portfolio, private readonly executor: TradeExecutor,
    private readonly risk: RiskManager, private readonly cfg: AppConfig, readonly options: ControllerOptions,
    private readonly onTrade: (record: Omit<TradeRecord, 'ts' | 'mode'>) => void) {
    if (cfg.mode !== 'SIMULATION' || executor.mode !== 'SIMULATION') throw new Error('Playbook is simulation-only');
    if (typeof portfolio.virtualSolLamports() !== 'bigint' || portfolio.virtualSolLamports() < 0n) throw new Error('Invalid paper balance');
    const saved = portfolio.getStrategyData(PLAYBOOK);
    if (saved !== undefined) for (const c of CycleSchema.array().max(100).parse(saved)) {
      if (this.cycles.has(c.mint)) throw new Error('Duplicate playbook cycle');
      this.cycles.set(c.mint, c);
    }
    for (const p of portfolio.positions()) {
      const cycle = this.cycles.get(p.mint);
      if (p.strategy !== PLAYBOOK || !cycle || cycle.positionId !== p.id || cycle.phase !== 'holding' ||
        typeof p.tokenAmountRaw !== 'bigint' || p.tokenAmountRaw <= 0n || typeof p.costLamports !== 'bigint' || p.costLamports <= 0n ||
        !p.entryPriceUsd || !/^[1-9]\d*$/.test(String(p.tags.playbookOriginalRaw)) ||
        typeof p.tags.playbookPeakUsd !== 'number' || !Number.isFinite(p.tags.playbookPeakUsd) || p.tags.playbookPeakUsd <= 0)
        throw new Error('Unrecognized position in isolated playbook state');
    }
    for (const c of this.cycles.values()) if (c.phase === 'holding' && (!c.positionId || !portfolio.getPosition(c.positionId))) throw new Error('Orphan playbook cycle');
  }

  /** One global execution queue avoids duplicate fills and oversubscribed paper cash. */
  process(s: Snapshot, evidence?: EntryEvidence, decimals = 0, now = Date.now()): Promise<Intent> {
    const result = this.queue.then(() => {
      if (this.fatal) throw this.fatal;
      return this.step(s, evidence, decimals, now);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async save(): Promise<void> {
    this.portfolio.setStrategyData(PLAYBOOK, [...this.cycles.values()]);
    try { await this.portfolio.flush(); } catch (e) { this.fatal = e; throw e; }
  }
  private async step(s: Snapshot, e: EntryEvidence | undefined, decimals: number, now: number): Promise<Intent> {
    let cycle = this.cycles.get(s.mint);
    let pos = cycle?.positionId ? this.portfolio.getPosition(cycle.positionId) : undefined;
    if (Number.isFinite(s.priceUsd) && s.priceUsd > 0 && now >= s.observedAt && now - s.observedAt <= 90_000) {
      if (cycle) cycle.peakUsd = Math.max(cycle.peakUsd, s.priceUsd);
      if (pos) this.portfolio.updatePosition(pos.id, { tags: { ...pos.tags, playbookPeakUsd: Math.max(Number(pos.tags.playbookPeakUsd), s.priceUsd) } });
    }
    const intent = evaluate(s, cycle, pos, e, { ...this.options, now });
    if (intent.type === 'BUY' || intent.type === 'RE_ENTRY') {
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { type: 'SKIP', reason: 'UNSUPPORTED_DECIMALS' };
      if (!s.solUsd || !Number.isFinite(s.solUsd) || s.solUsd <= 0) return { type: 'SKIP', reason: 'SOL_USD_MISSING' };
      const size = intent.type === 'RE_ENTRY' ? cycle!.initialSizeLamports / 4n : this.options.tradeSizeLamports;
      const check = this.risk.canOpen({ strategy: PLAYBOOK, mint: s.mint, sizeLamports: size, availableLamports: this.portfolio.virtualSolLamports() });
      if (!check.ok) { await this.save(); return { type: 'SKIP', reason: `RISK: ${check.reason}` }; }
      // Reserve includes estimated execution costs, not only the swap input.
      const feeBudget = BASE_FEE_LAMPORTS + BigInt(this.cfg.jupiter.maxPriorityFeeLamports) + TOKEN_ACCOUNT_RENT_LAMPORTS;
      if (this.portfolio.virtualSolLamports() - size - feeBudget < solToLamports(this.cfg.risk.minSolReserve) ||
        this.portfolio.exposureLamports() + size + feeBudget > solToLamports(this.cfg.risk.maxTotalExposureSol))
        return { type: 'SKIP', reason: 'RISK: FEES_RENT_OR_RESERVE' };
      const fill = await this.fill('BUY', s, size, intent.reason);
      if (!fill) { await this.save(); return { type: 'WAIT', reason: 'BUY_FILL_FAILED' }; }
      const cost = -fill.solDeltaLamports;
      const entryUsd = (Number(fill.inAmountRaw) / 1e9) * s.solUsd / (Number(fill.outAmountRaw) / 10 ** decimals);
      if (!Number.isFinite(entryUsd) || entryUsd <= 0) { this.fatal = new Error('Invalid fill price'); throw this.fatal; }
      pos = {
        id: `${PLAYBOOK}:${s.mint}:${now}`, strategy: PLAYBOOK, mint: s.mint, symbol: s.symbol, decimals,
        pairAddress: s.pairAddress, tokenAmountRaw: fill.outAmountRaw, costLamports: cost,
        entryInputLamports: fill.inAmountRaw, entryPriceUsd: entryUsd, openedAt: now,
        peakValueLamports: cost, lastValueLamports: cost, lastCheckedAt: now,
        exitRules: { takeProfitPct: 0, stopLossPct: this.options.initialStopPct, trailingActivationPct: 100, trailingStopPct: 20, maxHoldMs: this.options.maxHoldMs },
        entrySignal: intent.reason, closing: false, exitFailures: 0, valuationMisses: 0,
        tags: { playbookOriginalRaw: fill.outAmountRaw.toString(), playbookRent: fill.rentLamports.toString(),
          playbookPeakUsd: Math.max(entryUsd, s.priceUsd), playbook2x: false, playbook5x: false, playbookReentry: intent.type === 'RE_ENTRY' },
      };
      this.portfolio.openPosition(pos);
      this.portfolio.stats(PLAYBOOK).feesLamports += fill.feeLamports;
      cycle = { mint: s.mint, symbol: s.symbol, pairAddress: s.pairAddress, decimals,
        initialSizeLamports: cycle?.initialSizeLamports ?? size, peakUsd: cycle?.peakUsd ?? s.priceUsd,
        phase: 'holding', reEntryUsed: intent.type === 'RE_ENTRY', positionId: pos.id };
      this.cycles.set(s.mint, cycle);
      await this.save();
      this.record(fill, s, intent.reason, null, null);
    } else if (intent.type === 'SELL' && pos && cycle) {
      const all = intent.amountRaw === pos.tokenAmountRaw;
      const fill = await this.fill('SELL', s, intent.amountRaw, intent.reason);
      if (!fill) { await this.save(); return { type: 'WAIT', reason: 'SELL_FILL_FAILED' }; }
      let rent = 0n;
      let closeFee = 0n;
      if (all) {
        // The simulated executor excludes closing positions when checking virtual ATA emptiness.
        this.portfolio.updatePosition(pos.id, { closing: true });
        rent = await this.executor.closeTokenAccountIfEmpty(pos.mint);
        closeFee = rent > 0n ? BASE_FEE_LAMPORTS : 0n;
      }
      const trade = all
        ? this.portfolio.closePosition(pos.id, fill.solDeltaLamports + rent, intent.reason, fill.feeLamports + closeFee)!
        : this.portfolio.closePartial(pos.id, fill.inAmountRaw, fill.solDeltaLamports, intent.reason, fill.feeLamports);
      if (all) {
        cycle.phase = cycle.reEntryUsed ? 'done' : 'watching'; cycle.positionId = null;
        if (trade.pnlLamports < 0n) this.portfolio.setCooldown(pos.mint, this.cfg.risk.lossCooldownMin * 60_000);
      } else {
        this.portfolio.updatePosition(pos.id, { tags: { ...pos.tags,
          playbook2x: pos.tags.playbook2x === true || intent.stage === '2x',
          playbook5x: pos.tags.playbook5x === true || intent.stage === '5x' } });
      }
      await this.save();
      this.record(fill, s, intent.reason, lamportsToSol(trade.pnlLamports), trade.pnlPct, rent, closeFee);
    } else await this.save();
    return intent;
  }
  private async fill(side: 'BUY' | 'SELL', s: Snapshot, amount: bigint, reason: string): Promise<SwapFill | null> {
    try {
      const fill = await this.executor.swap({ side, mint: s.mint, amountRaw: amount, slippageBps: this.cfg.execution.defaultSlippageBps, maxPriceImpactPct: this.cfg.execution.maxPriceImpactPct });
      if (!fill.simulated || fill.signature !== null || fill.inAmountRaw !== amount || fill.outAmountRaw <= 0n) {
        this.fatal = new Error('Invalid simulation fill'); throw this.fatal;
      }
      this.risk.recordTxResult(true);
      return fill;
    } catch (err) {
      if (!(err instanceof SwapError)) throw err;
      if (err.isExecutionFailure) this.risk.recordTxResult(false);
      this.portfolio.chargeFee(PLAYBOOK, err.feeLamports);
      this.onTrade({ strategy: PLAYBOOK, action: side === 'BUY' ? 'BUY_FAILED' : 'SELL_FAILED', symbol: s.symbol, mint: s.mint,
        signal: reason, inAmount: amount.toString(), outAmount: '0', feesSol: lamportsToSol(err.feeLamports), priceImpactPct: null, slippageBps: null,
        signature: null, pnlSol: err.feeLamports > 0n ? lamportsToSol(-err.feeLamports) : null, pnlPct: null, note: err.message });
      return null;
    }
  }
  private record(f: SwapFill, s: Snapshot, reason: string, pnl: string | null, pct: number | null, rent = 0n, closeFee = 0n): void {
    this.onTrade({ strategy: PLAYBOOK, action: f.side, symbol: s.symbol, mint: s.mint, signal: reason,
      inAmount: f.inAmountRaw.toString(), outAmount: f.outAmountRaw.toString(), feesSol: lamportsToSol(f.feeLamports + closeFee),
      priceImpactPct: f.priceImpactPct, slippageBps: f.realizedSlippageBps, signature: null, pnlSol: pnl, pnlPct: pct,
      note: `paper fill; USD trigger observed=${s.priceUsd}; rentNet=${rent}; latencyMs=${f.latencyMs}` });
  }
}

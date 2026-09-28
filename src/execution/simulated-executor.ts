import { BaseExecutor, SwapError, type ExecutorDeps, type RentReclaimResult, type SwapFill, type SwapRequest } from './executor';
import { JupiterClient, type JupiterQuote } from './jupiter-client';
import { listTokenAccounts } from './token-accounts';
import { BASE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, type ExecMode } from '../core/types';
import type { Portfolio } from '../core/portfolio';
import { errorMessage } from '../utils/errors';
import { sleep } from '../utils/retry';
import { bpsOf, lamportsToSol } from '../utils/format';

/**
 * Paper-Trading-Executor (SIMULATION_MODE=true).
 * Nutzt ECHTE Jupiter-Quotes, simuliert aber die Ausführung realistisch:
 *  - Netzwerklatenz (SIM_LATENCY_MS) und anschließender Re-Quote → Preisbewegung während der Latenz
 *  - Fill = schlechterer der beiden Quotes, zusätzlich SIM_EXTRA_SLIPPAGE_BPS Abschlag (MEV/Konkurrenz)
 *  - Unterschreitet der Fill das Slippage-Minimum, scheitert der Trade wie on-chain (Fee wird trotzdem fällig)
 *  - Basis-Fee + geschätzte Priority-Fee (echte getRecentPrioritizationFees-Daten) + ATA-Rent beim Kauf
 * Es wird niemals eine Transaktion signiert oder gesendet.
 */
export class SimulatedExecutor extends BaseExecutor {
  readonly mode: ExecMode = 'SIMULATION';

  constructor(
    deps: ExecutorDeps,
    private readonly portfolio: Portfolio,
    private readonly strictRequote = false,
  ) {
    super(deps);
  }

  async swap(req: SwapRequest): Promise<SwapFill> {
    const started = Date.now();
    const q1 = await this.checkedQuote(req);
    const priority = await this.estimatePriorityFeeLamports();
    const fee = BASE_FEE_LAMPORTS + priority;
    const inAmount = BigInt(q1.inAmount);

    // Guthabenprüfungen gegen das virtuelle Portfolio
    if (req.side === 'BUY') {
      const needed = inAmount + fee + TOKEN_ACCOUNT_RENT_LAMPORTS;
      const available = this.portfolio.virtualSolLamports();
      if (available < needed) {
        throw new SwapError(
          `Virtuelles Guthaben zu gering (${lamportsToSol(available)} < ${lamportsToSol(needed)} SOL)`,
          'build',
        );
      }
    } else {
      const held = await this.getTokenBalanceRaw(req.mint);
      if (held < req.amountRaw) throw new SwapError(`Virtueller Token-Bestand zu gering (${held} < ${req.amountRaw})`, 'build');
    }

    if (this.deps.cfg.paper.latencyMs > 0) await sleep(this.deps.cfg.paper.latencyMs);

    let q2: JupiterQuote | null = null;
    try {
      q2 = await this.deps.jupiter.quote({
        inputMint: q1.inputMint,
        outputMint: q1.outputMint,
        amountRaw: req.amountRaw,
        slippageBps: req.slippageBps,
      });
    } catch (e) {
      if (this.strictRequote) throw new SwapError('Fresh simulation re-quote unavailable', 'quote');
      this.deps.logger.debug('Re-Quote in Simulation fehlgeschlagen – nutze ersten Quote', { error: errorMessage(e) });
    }

    if (this.strictRequote && q2 && JupiterClient.priceImpactPct(q2) > (req.maxPriceImpactPct ?? this.deps.cfg.execution.maxPriceImpactPct)) {
      throw new SwapError('Re-quote exceeds price-impact limit', 'impact');
    }

    const out1 = BigInt(q1.outAmount);
    const out2 = q2 ? BigInt(q2.outAmount) : out1;
    const worst = out2 < out1 ? out2 : out1;
    const extra = BigInt(this.deps.cfg.paper.extraSlippageBps);
    const filled = (worst * (10_000n - extra)) / 10_000n;
    const minOut = BigInt(q1.otherAmountThreshold);

    if (filled < minOut) {
      // So würde es on-chain aussehen: Tx scheitert am Slippage-Check, Fee ist weg
      throw new SwapError(
        `Simulierter Slippage-Abbruch: Fill ${filled} < Minimum ${minOut} (Quote ${out1})`,
        'slippage',
        fee,
        null,
      );
    }

    const rent = req.side === 'BUY' ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n;
    const solDelta = req.side === 'BUY' ? -(inAmount + fee + rent) : filled - fee;

    return {
      simulated: true,
      signature: null,
      side: req.side,
      mint: req.mint,
      inAmountRaw: inAmount,
      outAmountRaw: filled,
      quotedOutRaw: out1,
      minOutRaw: minOut,
      solDeltaLamports: solDelta,
      feeLamports: fee,
      rentLamports: rent,
      priceImpactPct: JupiterClient.priceImpactPct(q2 ?? q1),
      realizedSlippageBps: out1 > filled ? bpsOf(out1 - filled, out1) : 0,
      route: JupiterClient.routeLabel(q2 ?? q1),
      latencyMs: Date.now() - started,
    };
  }

  async getSolBalanceLamports(): Promise<bigint> {
    return this.portfolio.virtualSolLamports();
  }

  async getTokenBalanceRaw(mint: string): Promise<bigint> {
    return this.portfolio
      .positions()
      .filter((p) => p.mint === mint)
      .reduce((s, p) => s + p.tokenAmountRaw, 0n);
  }

  /** Virtuelles Schließen des ATA: Rent zurück, abzüglich der Basis-Fee der Close-Transaktion. */
  async closeTokenAccountIfEmpty(mint: string): Promise<bigint> {
    if (!this.deps.cfg.execution.closeEmptyAccounts) return 0n;
    const remaining = this.portfolio.positions().filter((p) => p.mint === mint && !p.closing).length;
    if (remaining > 0) return 0n;
    return TOKEN_ACCOUNT_RENT_LAMPORTS - BASE_FEE_LAMPORTS;
  }

  /** In der Simulation werden echte leere Konten der Wallet nur gemeldet, nicht geschlossen. */
  async reclaimEmptyAccounts(excludeMints: ReadonlySet<string>): Promise<RentReclaimResult> {
    const all = await listTokenAccounts(this.deps.rpc, this.owner);
    const candidates = all.filter((a) => a.closable && !excludeMints.has(a.mint));
    return {
      found: candidates.length,
      closed: 0,
      reclaimableLamports: candidates.reduce((s, a) => s + BigInt(a.lamports), 0n),
      reclaimedLamports: 0n,
      signatures: [],
    };
  }
}

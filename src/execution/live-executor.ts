import { parse, safeInteger } from '../data/core/data-validator';
import { VersionedTransaction, type Keypair, type VersionedTransactionResponse } from '@solana/web3.js';
import { BaseExecutor, SwapError, type ExecutorDeps, type RentReclaimResult, type SwapFill, type SwapRequest } from './executor';
import { JupiterClient, type JupiterQuote } from './jupiter-client';
import type { TransactionSender } from './tx-sender';
import { closeTokenAccounts, listTokenAccounts } from './token-accounts';
import { BASE_FEE_LAMPORTS, type ExecMode } from '../core/types';
import { TxExpiredError, TxFailedError, TxUnknownError, errorMessage } from '../utils/errors';
import { sleep } from '../utils/retry';
import { bpsOf } from '../utils/format';

/**
 * Echte On-Chain-Ausführung über Jupiter.
 * Ablauf: Quote → Impact-Check → /swap (Tx bauen) → signieren → optional simulieren →
 * senden & bestätigen → tatsächlichen Fill aus den Balance-Deltas der Transaktion lesen.
 */
export class LiveExecutor extends BaseExecutor {
  readonly mode: ExecMode = 'LIVE';

  constructor(
    deps: ExecutorDeps,
    private readonly wallet: Keypair,
    private readonly sender: TransactionSender,
  ) {
    super(deps);
    if (!wallet.publicKey.equals(deps.owner)) throw new Error('LiveExecutor: Wallet passt nicht zum Owner');
  }

  async swap(req: SwapRequest): Promise<SwapFill> {
    const started = Date.now();
    const quote = await this.checkedQuote(req);
    const owner = this.owner.toBase58();
    const authorization = await this.deps.guard?.beforeBuild(req, quote);

    let tx: VersionedTransaction;
    let lastValidBlockHeight: number;
    try {
      const built = await this.deps.jupiter.buildSwap(quote, owner, authorization?.priorityFeeCapLamports);
      tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
      lastValidBlockHeight = built.lastValidBlockHeight;
      this.ensureFresh(quote);
      await this.deps.guard?.beforeSign(req, quote, tx, built);
    } catch (e) {
      throw new SwapError(`Swap-Transaktion konnte nicht gebaut werden: ${errorMessage(e)}`, 'build', 0n, null, { cause: e });
    }

    if (this.deps.cfg.execution.preSimulate) {
      let simErr: unknown = null;
      let logs: string[] | null = null;
      try {
        const sim = await this.deps.rpc.execute('simulateTransaction', (c) =>
          c.simulateTransaction(tx, { sigVerify: false, commitment: 'processed' }),
        );
        simErr = sim.value.err;
        logs = sim.value.logs;
      } catch (e) {
        // Simulation selbst nicht erreichbar → lieber abbrechen als blind senden
        throw new SwapError(`Pre-Simulation nicht möglich: ${errorMessage(e)}`, 'simulate', 0n, null, { cause: e });
      }
      if (simErr) {
        this.deps.logger.debug('Simulation fehlgeschlagen', { logs: logs?.slice(-6) });
        throw new SwapError(`Pre-Simulation fehlgeschlagen: ${JSON.stringify(simErr)}`, 'simulate');
      }
    }

    let signature: string;
    this.ensureFresh(quote);
    await this.deps.guard?.beforeSend(req, quote, tx);
    this.ensureFresh(quote);
    tx.sign([this.wallet]);
    await this.deps.guard?.onSigned?.(tx);
    this.ensureFresh(quote);
    try {
      ({ signature } = await this.sender.sendAndConfirm(tx, lastValidBlockHeight));
    } catch (e) {
      if (e instanceof TxFailedError) {
        // On-chain gescheitert: Basis- + Priority-Fee wurden trotzdem bezahlt
        const fee = await this.fetchFee(e.signature);
        throw new SwapError(e.message, 'confirm', fee, e.signature, { cause: e });
      }
      if (e instanceof TxExpiredError) throw new SwapError(e.message, 'confirm', 0n, e.signature, { cause: e });
      if (e instanceof TxUnknownError) throw new SwapError(e.message, 'unknown', 0n, e.signature, { cause: e });
      throw new SwapError(`Senden fehlgeschlagen: ${errorMessage(e)}`, 'send', 0n, null, { cause: e });
    }

    try { return await this.parseFill(req, quote, signature, started); }
    catch (error) { throw error instanceof SwapError ? error : new SwapError('Confirmed fill validation failed', 'unknown', 0n, signature); }
  }

  /** Liest die tatsächlichen Beträge aus der bestätigten Transaktion. */
  private async parseFill(req: SwapRequest, quote: JupiterQuote, signature: string, started: number): Promise<SwapFill> {
    const tx = await this.fetchTransaction(signature);
    const quotedOut = BigInt(quote.outAmount);
    const minOut = BigInt(quote.otherAmountThreshold);
    const route = JupiterClient.routeLabel(quote);
    const impact = JupiterClient.priceImpactPct(quote);

    if (!tx?.meta) {
      throw new SwapError('Confirmed transaction details unavailable; reconciliation required', 'unknown', 0n, signature);
    }

    const meta = tx.meta;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
    const ownerIdx = Array.from({ length: keys.length }, (_, i) => i).find((i) => keys.get(i)?.equals(this.owner));
    if (ownerIdx === undefined) throw new SwapError('Transaction owner missing', 'unknown', 0n, signature);
    const solDelta = BigInt(parse(safeInteger, meta.postBalances[ownerIdx], 'solana-rpc')) - BigInt(parse(safeInteger, meta.preBalances[ownerIdx], 'solana-rpc'));
    const fee = BigInt(parse(safeInteger, meta.fee, 'solana-rpc'));
    const owner = this.owner.toBase58();

    const sumToken = (list: typeof meta.preTokenBalances): bigint =>
      (list ?? [])
        .filter((b) => b.owner === owner && b.mint === req.mint)
        .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const tokenDelta = sumToken(meta.postTokenBalances) - sumToken(meta.preTokenBalances);

    let inAmount: bigint;
    let outAmount: bigint;
    let rent = 0n;
    if (req.side === 'BUY') {
      inAmount = BigInt(quote.inAmount);
      outAmount = tokenDelta > 0n ? tokenDelta : 0n;
      // Alles, was über Input + Fee hinaus abgeflossen ist, ist (rückholbare) ATA-Rent
      const extra = -solDelta - inAmount - fee;
      rent = extra > 0n ? extra : 0n;
    } else {
      inAmount = tokenDelta < 0n ? -tokenDelta : BigInt(quote.inAmount);
      const out = solDelta + fee;
      outAmount = out > 0n ? out : 0n;
    }
    const slip = quotedOut > outAmount ? bpsOf(quotedOut - outAmount, quotedOut) : 0;

    return {
      simulated: false,
      signature,
      side: req.side,
      mint: req.mint,
      inAmountRaw: inAmount,
      outAmountRaw: outAmount,
      quotedOutRaw: quotedOut,
      minOutRaw: minOut,
      solDeltaLamports: solDelta,
      feeLamports: fee,
      rentLamports: rent,
      priceImpactPct: impact,
      realizedSlippageBps: slip,
      route,
      latencyMs: Date.now() - started,
    };
  }

  private async fetchTransaction(signature: string): Promise<VersionedTransactionResponse | null> {
    for (let i = 0; i < 6; i++) {
      try {
        const tx = await this.deps.rpc.execute('getTransaction', (c) =>
          c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
        );
        if (tx) return tx;
      } catch (e) {
        this.deps.logger.debug('getTransaction fehlgeschlagen', { signature, error: errorMessage(e) });
      }
      await sleep(1_000 + i * 1_000);
    }
    return null;
  }

  private async fetchFee(signature: string): Promise<bigint> {
    const tx = await this.fetchTransaction(signature).catch(() => null);
    if (tx?.meta) return BigInt(tx.meta.fee);
    return BASE_FEE_LAMPORTS + (await this.estimatePriorityFeeLamports());
  }

  async getSolBalanceLamports(): Promise<bigint> {
    const bal = await this.deps.rpc.execute('getBalance', (c) => c.getBalance(this.owner, 'confirmed'));
    return BigInt(parse(safeInteger, bal, 'solana-rpc'));
  }

  async getTokenBalanceRaw(mint: string): Promise<bigint> {
    const accounts = await listTokenAccounts(this.deps.rpc, this.owner, mint);
    return accounts.reduce((s, a) => s + a.amountRaw, 0n);
  }

  async closeTokenAccountIfEmpty(mint: string): Promise<bigint> {
    if (this.deps.guard) return 0n; // Account maintenance must not bypass the micro execution guard.
    if (!this.deps.cfg.execution.closeEmptyAccounts) return 0n;
    try {
      const accounts = await listTokenAccounts(this.deps.rpc, this.owner, mint);
      const closable = accounts.filter((a) => a.closable);
      if (closable.length === 0) return 0n;
      const res = await closeTokenAccounts(this.deps.rpc, this.sender, this.wallet, closable, this.deps.logger);
      // Close-Tx kostet selbst eine Signatur-Fee
      const net = res.reclaimedLamports - BASE_FEE_LAMPORTS * BigInt(res.signatures.length);
      return net > 0n ? net : 0n;
    } catch (e) {
      this.deps.logger.warn('Token-Konto konnte nicht geschlossen werden', { mint, error: errorMessage(e) });
      return 0n;
    }
  }

  async reclaimEmptyAccounts(excludeMints: ReadonlySet<string>): Promise<RentReclaimResult> {
    if (this.deps.guard) return { found:0,closed:0,reclaimableLamports:0n,reclaimedLamports:0n,signatures:[] };
    const all = await listTokenAccounts(this.deps.rpc, this.owner);
    const candidates = all.filter((a) => a.closable && !excludeMints.has(a.mint));
    const reclaimable = candidates.reduce((s, a) => s + BigInt(a.lamports), 0n);
    if (candidates.length === 0) {
      return { found: 0, closed: 0, reclaimableLamports: 0n, reclaimedLamports: 0n, signatures: [] };
    }
    const res = await closeTokenAccounts(this.deps.rpc, this.sender, this.wallet, candidates, this.deps.logger);
    return {
      found: candidates.length,
      closed: res.closed,
      reclaimableLamports: reclaimable,
      reclaimedLamports: res.reclaimedLamports,
      signatures: res.signatures,
    };
  }
}

import { PublicKey, SystemProgram, type VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { BASE_FEE_LAMPORTS, SOL_MINT, USDC_MINT, USDT_MINT } from '../core/types';
import type { ExecutionGuard } from '../execution/execution-guard';
import type { SwapRequest } from '../execution/executor';
import { JupiterClient, type JupiterQuote, type JupiterSwapResponse } from '../execution/jupiter-client';
import type { TransactionSigner } from '../execution/transaction-signer';
import { listTokenAccounts } from '../execution/token-accounts';
import type { ConnectionManager } from '../rpc/connection-manager';
import { exactNumber, parse, safeInteger } from '../data/core/data-validator';
import { recentPriorityFee } from '../micro/market';
import type { DeskMode, Preflight, SignatureState, Stage } from './types';

/** Stops a TEST order exactly where a LIVE order would ask Phantom for a signature. */
export class PaperExecution extends Error {
  constructor() { super('PAPER_EXECUTION_NO_SIGNATURE_REQUESTED'); this.name = 'PaperExecution'; }
}
export function paperSigner(owner: PublicKey): TransactionSigner {
  return { publicKey: owner, signTransaction: async () => { throw new PaperExecution(); } };
}

export class DeskReject extends Error {
  constructor(readonly code: string, detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'DeskReject'; }
}

export interface WalletSnapshot {
  native: bigint; tokenAccount: PublicKey; tokenRaw: bigint; ataExists: boolean; ataRent: bigint; tempRent: bigint;
  others: PublicKey[]; at: number;
}
export interface SimulationResult { status: 'PASSED' | 'FAILED' | 'NOT_POSSIBLE'; detail: string; solDelta: bigint | null; tokenDelta: bigint | null }

export interface DeskGuardDeps {
  mode: DeskMode; rpc: ConnectionManager; jupiter: JupiterClient; owner: PublicKey; mint: string; symbol: string | null;
  decimals: number; tokenProgram: PublicKey; solUsd: number;
  slippageBps: number; maxDragBps: bigint; reserveLamports: bigint; configuredPriorityCap: bigint; baseEntryUsd: number;
  /** TEST: remaining paper capital. LIVE: null (the wallet itself is the budget). */
  paperCashLamports: bigint | null;
  /** Position size the ledger holds for SELL orders. */
  heldRaw: bigint;
  stopped: () => boolean;
  /** false only for TEST drill entries: the drag is still measured and reported, but does not block. */
  enforceDrag?: boolean;
  onSigned: (signature: string) => Promise<void>;
  event: (stage: Stage, message: string, detail?: Record<string, string | number | boolean | null>) => void;
}

export interface OrderRecord { quote: JupiterQuote; fee: bigint; priority: bigint; rent: bigint; routerFee: bigint; route: string }
interface Authorization {
  snapshot: WalletSnapshot; priority: bigint; fee: bigint; dragLamports: bigint; notional: bigint;
  slip: bigint; impact: bigint; routerFee: bigint; message?: string; preflight?: Preflight;
}

const sol = (lamports: bigint) => `${(exactNumber(lamports < 0n ? -lamports : lamports) / 1e9 * (lamports < 0n ? -1 : 1)).toFixed(6)} SOL`;

/**
 * The same gates run in TEST and LIVE: quote identity, slippage, spendable capital and reserve, max drag,
 * unsigned RPC simulation with balance and authority checks, and a pre-flight record. Only the signer differs.
 */
export class DeskGuard implements ExecutionGuard {
  private readonly authorized = new WeakMap<SwapRequest, Authorization>();
  lastSimulation: SimulationResult = { status: 'NOT_POSSIBLE', detail: 'Not reached', solDelta: null, tokenDelta: null };
  lastPreflight: Preflight | null = null;
  /** Set once a quote was authorized; a TEST fill is booked from exactly this order. */
  lastOrder: OrderRecord | null = null;
  /** A quote was received and checked (even if a later gate blocked the order). */
  quoted = false;
  constructor(private readonly d: DeskGuardDeps) {}

  assertActive(): void { if (this.d.stopped()) throw new DeskReject('STOP_REQUESTED'); }

  async onSigned(tx: VersionedTransaction): Promise<void> {
    if (!tx.signatures[0]) throw new DeskReject('SIGNATURE_MISSING');
    const signature = bs58.encode(tx.signatures[0]);
    await this.d.onSigned(signature); // Durable before broadcast; an unknown outcome is never retried.
    if (this.lastPreflight) { this.lastPreflight.signature = 'SIGNED'; this.lastPreflight.txSignature = signature; }
  }

  async snapshot(): Promise<WalletSnapshot> {
    const d = this.d, mint = new PublicKey(d.mint);
    const tokenAccount = getAssociatedTokenAddressSync(mint, d.owner, false, d.tokenProgram);
    const [native, accounts, rent, tempRent] = await Promise.all([
      d.rpc.execute('desk:balance', c => c.getBalance(d.owner, 'confirmed')),
      listTokenAccounts(d.rpc, d.owner),
      d.rpc.execute('desk:rent', c => c.getMinimumBalanceForRentExemption(d.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165)),
      d.rpc.execute('desk:rent-temp', c => c.getMinimumBalanceForRentExemption(165)),
    ]);
    const own = accounts.find(a => a.pubkey.equals(tokenAccount));
    return { native: BigInt(parse(safeInteger, native, 'solana-rpc')), tokenAccount, tokenRaw: own?.amountRaw ?? 0n, ataExists: !!own,
      ataRent: own ? 0n : BigInt(rent), tempRent: BigInt(tempRent),
      others: accounts.filter(a => a.amountRaw > 0n && !a.pubkey.equals(tokenAccount)).map(a => a.pubkey), at: Date.now() };
  }

  /** Router/DEX fees embedded in the quote, converted to lamports at the quote's own exchange rate. */
  private routerFee(q: JupiterQuote, side: 'BUY' | 'SELL'): bigint {
    const inAmt = BigInt(q.inAmount), out = BigInt(q.outAmount);
    let total = 0n;
    for (const step of q.routePlan) {
      const fee = BigInt(step.swapInfo.feeAmount ?? '0'), mint = step.swapInfo.feeMint;
      if (fee <= 0n || !mint) continue;
      if (mint === SOL_MINT) total += fee;
      else if (mint === this.d.mint) total += side === 'BUY' ? (out > 0n ? fee * inAmt / out : 0n) : (inAmt > 0n ? fee * out / inAmt : 0n);
      else if (mint === USDC_MINT || mint === USDT_MINT) total += BigInt(Math.ceil(exactNumber(fee) / 1e6 / this.d.solUsd * 1e9));
    }
    return total;
  }

  async beforeBuild(req: SwapRequest, q: JupiterQuote): Promise<{ priorityFeeCapLamports: number }> {
    const d = this.d, buy = req.side === 'BUY';
    if (req.mint !== d.mint || q.inputMint !== (buy ? SOL_MINT : d.mint) || q.outputMint !== (buy ? d.mint : SOL_MINT) || BigInt(q.inAmount) !== req.amountRaw)
      throw new DeskReject('PAIR_OR_AMOUNT_MISMATCH');
    if (!Number.isInteger(req.slippageBps) || req.slippageBps > d.slippageBps || q.slippageBps !== req.slippageBps) throw new DeskReject('SLIPPAGE_ESCALATION_BLOCKED');
    d.jupiter.assertFresh(q);
    this.assertActive();
    const route = JupiterClient.routeLabel(q), impactPct = JupiterClient.priceImpactPct(q);
    d.event('QUOTE', `${buy ? 'Buy' : 'Sell'} quote ${buy ? sol(req.amountRaw) : `${q.inAmount} raw`} → expected ${buy ? `${q.outAmount} raw` : sol(BigInt(q.outAmount))}, minimum ${buy ? q.otherAmountThreshold : sol(BigInt(q.otherAmountThreshold))}`,
      { provider: 'Jupiter', impactPct: Number(impactPct.toFixed(4)), slippageBps: q.slippageBps });
    this.quoted = true;
    this.lastOrder = { quote: q, fee: BASE_FEE_LAMPORTS, priority: 0n, rent: 0n, routerFee: this.routerFee(q, req.side), route };
    d.event('ROUTE', `Jupiter aggregator via ${route}`, { hops: q.routePlan.length, ammKeys: q.routePlan.map(s => s.swapInfo.ammKey).join(',') });
    const s = await this.snapshot();
    const inAmt = BigInt(q.inAmount), out = BigInt(q.outAmount), min = BigInt(q.otherAmountThreshold);
    // Everything valued in lamports at the quote's own rate; no external price is needed to measure cost.
    const notional = buy ? inAmt : out;
    const slip = buy ? (out > 0n ? inAmt * (out - min) / out : 0n) : out - min;
    const impact = BigInt(Math.ceil(exactNumber(notional) * impactPct / 100));
    const routerFee = this.routerFee(q, req.side);
    if (buy) {
      const usd = exactNumber(inAmt) / 1e9 * d.solUsd;
      if (usd > d.baseEntryUsd * 1.02) throw new DeskReject('POSITION_SIZE_LIMIT', `$${usd.toFixed(2)} > base entry $${d.baseEntryUsd.toFixed(2)}`);
    } else if (req.amountRaw !== d.heldRaw || (d.mode === 'LIVE' && s.tokenRaw < req.amountRaw)) throw new DeskReject('UNTRACKED_POSITION');
    const budget = notional * d.maxDragBps / 10_000n;
    const remainder = budget - slip - impact - routerFee - BASE_FEE_LAMPORTS;
    // The drag cap limits entries. An exit reduces risk: its cost is reported, never used to trap a position.
    const capped = buy && d.enforceDrag !== false;
    if (buy && remainder < 0n && !capped) d.event('PREFLIGHT', `DRILL: drag above ${Number(d.maxDragBps) / 100}% accepted in TEST (slippage ${sol(slip)} + impact ${sol(impact)} + router ${sol(routerFee)})`);
    if (capped && remainder < 0n) throw new DeskReject('FEE_CAP', `slippage ${sol(slip)} + impact ${sol(impact)} + router ${sol(routerFee)} + base fee exceed ${Number(d.maxDragBps) / 100}% (${sol(budget)})`);
    const maxPriority = !capped || remainder >= d.configuredPriorityCap ? d.configuredPriorityCap : remainder;
    const priority = await recentPriorityFee(d.rpc, maxPriority);
    const fee = BASE_FEE_LAMPORTS + priority;
    this.checkFunds(buy ? inAmt : 0n, fee, s, buy);
    this.authorized.set(req, { snapshot: s, priority, fee, notional, slip, impact, routerFee, dragLamports: slip + impact + routerFee + fee });
    this.lastOrder = { quote: q, fee, priority, rent: buy ? s.ataRent : 0n, routerFee, route };
    return { priorityFeeCapLamports: exactNumber(priority) };
  }

  /**
   * Entries must be fully funded, including the account-rent budget a venue may charge. An exit only needs its
   * network fee from the wallet: it is never refused because TEST cash is low, since selling returns capital.
   */
  private checkFunds(spend: bigint, fee: bigint, s: WalletSnapshot, buy: boolean): void {
    const d = this.d;
    if (!buy) {
      if (d.mode === 'LIVE' && s.native < fee) throw new DeskReject('FEE_UNAFFORDABLE', `wallet ${sol(s.native)} cannot pay ${sol(fee)}`);
      return;
    }
    const rent = s.ataRent + s.tempRent;
    if (d.paperCashLamports !== null && d.paperCashLamports - spend - fee - rent < 0n)
      throw new DeskReject('TEST_CAPITAL_INSUFFICIENT', `${sol(d.paperCashLamports)} available, ${sol(spend + fee + rent)} required incl. account-rent budget`);
    // The wallet itself must also carry the order: TEST simulates against it, LIVE spends from it.
    if (s.native - spend - fee - rent < d.reserveLamports)
      throw new DeskReject('SOL_RESERVE_FLOOR', `wallet ${sol(s.native)}; order ${sol(spend)} + fees ${sol(fee)} + rent ${sol(rent)} + reserve ${sol(d.reserveLamports)}`);
  }

  async beforeSign(req: SwapRequest, q: JupiterQuote, tx: VersionedTransaction, built: JupiterSwapResponse): Promise<void> {
    const d = this.d, a = this.authorized.get(req), buy = req.side === 'BUY';
    if (!a) throw new DeskReject('MISSING_AUTHORIZATION');
    if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0]?.equals(d.owner)) throw new DeskReject('INVALID_PAYER');
    if (built.prioritizationFeeLamports === undefined || BigInt(built.prioritizationFeeLamports) > a.priority) throw new DeskReject('PRIORITY_CAP');
    const feeResult = await d.rpc.execute('desk:message-fee', c => c.getFeeForMessage(tx.message, 'confirmed'));
    if (feeResult.value === null) throw new DeskReject('ACTUAL_FEE_UNAVAILABLE');
    a.fee = BigInt(parse(safeInteger, feeResult.value, 'solana-rpc'));
    a.dragLamports = a.slip + a.impact + a.routerFee + a.fee;
    if (this.lastOrder) this.lastOrder.fee = a.fee;
    if (buy && d.enforceDrag !== false && a.dragLamports * 10_000n > a.notional * d.maxDragBps) throw new DeskReject('FEE_CAP', `actual fee ${sol(a.fee)} raises drag above ${Number(d.maxDragBps) / 100}%`);
    const s = await this.snapshot();
    this.checkFunds(buy ? req.amountRaw : 0n, a.fee, s, buy);
    const sim = await d.rpc.execute('desk:simulate-unsigned', c => c.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [d.owner.toBase58(), s.tokenAccount.toBase58(), ...s.others.map(k => k.toBase58())] } }));
    const fail = (code: string, detail: string): never => {
      this.lastSimulation = { status: 'FAILED', detail, solDelta: null, tokenDelta: null };
      d.event('SIMULATION', `FAILED — ${detail}`, { code });
      throw new DeskReject(code, detail);
    };
    if (sim.value.err) fail('ROUTE_SIMULATION_FAILED', `${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-2).join(' | ')}`.slice(0, 300));
    const [wallet, token, ...after] = sim.value.accounts ?? [];
    if (!wallet || wallet.owner !== SystemProgram.programId.toBase58()) fail('SIMULATED_ACCOUNTS_MISSING', 'wallet account missing or reassigned');
    const before = s.others.length ? await d.rpc.execute('desk:others-before', c => c.getMultipleAccountsInfo(s.others, 'confirmed')) : [];
    s.others.forEach((_, i) => {
      const b = before[i], x = after[i];
      if (!b || !x || x.owner !== b.owner.toBase58() || x.lamports !== b.lamports || x.data[1] !== 'base64' || !Buffer.from(x.data[0] ?? '', 'base64').equals(b.data))
        fail('UNSCOPED_HOLDING_CHANGED', 'the swap would change another token account in this wallet');
    });
    const native = BigInt(parse(safeInteger, wallet!.lamports, 'solana-rpc'));
    let tokenAfter = 0n;
    if (token) {
      if (token.owner !== d.tokenProgram.toBase58() || token.data[1] !== 'base64' || typeof token.data[0] !== 'string') fail('SIMULATED_TOKEN_IDENTITY', 'token account program mismatch');
      const decoded = AccountLayout.decode(Buffer.from(token!.data[0] as string, 'base64'));
      if (!decoded.mint.equals(new PublicKey(d.mint)) || !decoded.owner.equals(d.owner)) fail('SIMULATED_TOKEN_IDENTITY', 'token account mint/owner mismatch');
      if (decoded.delegateOption !== 0 || decoded.closeAuthorityOption !== 0) fail('SIMULATED_TOKEN_AUTHORITY', 'delegate or close authority set on the token account');
      tokenAfter = decoded.amount;
    }
    const solDelta = native - s.native, tokenDelta = tokenAfter - s.tokenRaw;
    // Venues may create extra per-user accounts on a first trade (e.g. PumpSwap's volume accumulator); their rent
    // may use the temporary-account budget already reserved in checkFunds, and is booked from the measured delta.
    if (buy && (-solDelta > req.amountRaw + a.fee + s.ataRent + s.tempRent || tokenDelta < BigInt(q.otherAmountThreshold)))
      fail('SIMULATED_BUY_MISMATCH', `SOL ${sol(solDelta)}, tokens +${tokenDelta} (minimum ${q.otherAmountThreshold})`);
    if (!buy && (-tokenDelta !== req.amountRaw || solDelta < BigInt(q.otherAmountThreshold) - a.fee))
      fail('SIMULATED_SELL_MISMATCH', `tokens ${tokenDelta}, SOL ${sol(solDelta)}`);
    if (buy && native < d.reserveLamports) fail('PROJECTED_RESERVE_FLOOR', `wallet would hold ${sol(native)}`);
    this.lastSimulation = { status: 'PASSED', detail: `SOL ${sol(solDelta)} · tokens ${tokenDelta >= 0n ? '+' : ''}${tokenDelta}`, solDelta, tokenDelta };
    d.event('SIMULATION', `PASSED — ${this.lastSimulation.detail}`, { solDelta: String(solDelta), tokenDelta: String(tokenDelta), fee: String(a.fee) });
    a.message = Buffer.from(tx.message.serialize()).toString('base64');
  }

  async beforeSend(req: SwapRequest, q: JupiterQuote, tx: VersionedTransaction): Promise<void> {
    const d = this.d, a = this.authorized.get(req);
    if (!a?.message || a.message !== Buffer.from(tx.message.serialize()).toString('base64')) throw new DeskReject('TRANSACTION_CHANGED');
    d.jupiter.assertFresh(q);
    this.assertActive();
    if (a.preflight) {
      // Second pass after the wallet: balances must be exactly those that were authorized.
      const s = await this.snapshot();
      if (s.native !== a.snapshot.native || s.tokenRaw !== a.snapshot.tokenRaw) throw new DeskReject('BALANCE_CHANGED_DURING_APPROVAL');
      return;
    }
    const buy = req.side === 'BUY';
    a.preflight = this.lastPreflight = {
      id: `${Date.now()}-${req.side}-${d.mint.slice(0, 6)}`, at: Date.now(), mode: d.mode, side: req.side, mint: d.mint, symbol: d.symbol,
      router: 'Jupiter aggregator', route: JupiterClient.routeLabel(q), ammKeys: q.routePlan.map(s => s.swapInfo.ammKey),
      amountIn: buy ? sol(BigInt(q.inAmount)) : `${q.inAmount} raw`, expectedOut: buy ? `${q.outAmount} raw` : sol(BigInt(q.outAmount)),
      minimumOut: buy ? `${q.otherAmountThreshold} raw` : sol(BigInt(q.otherAmountThreshold)),
      entrySizeUsd: buy ? exactNumber(req.amountRaw) / 1e9 * d.solUsd : null, priceImpactPct: JupiterClient.priceImpactPct(q), slippageBps: q.slippageBps,
      priorityFeeLamports: String(a.priority), networkFeeLamports: String(a.fee), accountRentLamports: String(a.snapshot.ataRent),
      dragPct: exactNumber(a.dragLamports) / exactNumber(a.notional) * 100,
      simulation: { status: this.lastSimulation.status, detail: this.lastSimulation.detail,
        solDeltaLamports: this.lastSimulation.solDelta === null ? null : String(this.lastSimulation.solDelta),
        tokenDeltaRaw: this.lastSimulation.tokenDelta === null ? null : String(this.lastSimulation.tokenDelta) },
      balanceCheck: { ok: true, detail: `wallet ${sol(a.snapshot.native)}; reserve ${sol(d.reserveLamports)} kept${d.paperCashLamports !== null ? `; TEST capital ${sol(d.paperCashLamports)}` : ''}` },
      riskStatus: 'All pre-flight gates passed', signature: d.mode === 'PAPER' ? 'NOT_REQUESTED_TEST' : 'NOT_REACHED', txSignature: null, outcome: 'PENDING',
    };
    d.event('PREFLIGHT', `${req.side} ${d.symbol ?? d.mint.slice(0, 6)} · ${a.preflight.amountIn} → ≥ ${a.preflight.minimumOut} · drag ${a.preflight.dragPct!.toFixed(2)}% · ${a.preflight.route}`,
      { impactPct: Number(a.preflight.priceImpactPct.toFixed(4)), priorityFee: String(a.priority), networkFee: String(a.fee) });
  }

  signatureState(state: SignatureState): void { if (this.lastPreflight) this.lastPreflight.signature = state; }
}

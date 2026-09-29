import { SystemProgram, type PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey as Key } from '@solana/web3.js';
import bs58 from 'bs58';
import { BASE_FEE_LAMPORTS, SOL_MINT, USDC_MINT } from '../core/types';
import type { ExecutionGuard } from '../execution/execution-guard';
import type { SwapRequest } from '../execution/executor';
import type { JupiterClient, JupiterQuote, JupiterSwapResponse } from '../execution/jupiter-client';
import type { ConnectionManager } from '../rpc/connection-manager';
import { exactNumber, parse, safeInteger } from '../data/core/data-validator';
import { MICRO, MicroReject, checkCosts, checkReserve, equityUsd, validPrices, killThreshold, type MicroState, type Snapshot } from './policy';

/** getMultipleAccounts accepts 100 keys; the simulation also returns the wallet and its USDC account. */
const MAX_UNSCOPED_ACCOUNTS=98;
type Authorization = { snapshot:Snapshot; priority:bigint; notional:bigint; slip:bigint; spread:bigint;
  priorDrag:bigint; drag:bigint; fee:bigint; message?:string };
export interface GuardDeps {
  rpc:ConnectionManager; jupiter:JupiterClient; owner:PublicKey; state:MicroState;
  snapshot:()=>Promise<Snapshot>; priority:(maximum:bigint)=>Promise<bigint>; persist:()=>Promise<void>;
  configuredPriorityCap:bigint;
  stopped?:()=>boolean;
}
export class MicroGuard implements ExecutionGuard {
  private readonly authorized=new WeakMap<SwapRequest,Authorization>();
  lastDrag=0n;
  lastFee=0n;
  lastRent=0n;
  lastSolUsd=0;
  constructor(private readonly d:GuardDeps) {}
  assertActive():void {
    if(this.d.stopped?.())throw new MicroReject('STOP_REQUESTED');
    if(this.d.state.halted)throw new MicroReject('LIVE_HALTED');
  }
  async onSigned(tx:VersionedTransaction):Promise<void> {
    if(!this.d.state.pending||!tx.signatures[0])throw new MicroReject('PENDING_INTENT_MISSING');
    this.d.state.pending.signature=bs58.encode(tx.signatures[0]);
    await this.d.persist(); // Durable identity BEFORE broadcasting; never retry an unknown result.
  }
  private async snapshot():Promise<Snapshot> {
    if(this.d.stopped?.())throw new MicroReject('STOP_REQUESTED');
    if(this.d.state.halted) throw new MicroReject('LIVE_HALTED',this.d.state.halted);
    const s=await this.d.snapshot(); validPrices(s);
    if(equityUsd(s)<killThreshold(this.d.state) || s.native<MICRO.reserveLamports) {
      this.d.state.halted='EQUITY_OR_RESERVE_KILL'; await this.d.persist(); throw new MicroReject('LIVE_HALTED');
    }
    if(s.native!==BigInt(this.d.state.expectedNative)||s.usdc!==BigInt(this.d.state.expectedUsdc)) {
      this.d.state.externalCashFlow=true;this.d.state.halted='UNEXPLAINED_BALANCE_CHANGE';
      await this.d.persist();throw new MicroReject('LIVE_HALTED');
    }
    return s;
  }
  private usdcLamports(raw:bigint,s:Snapshot,roundUp=true):bigint {
    const n=(roundUp?Math.ceil:Math.floor)(exactNumber(raw)/1e6*s.usdcUsd/s.solUsd*1e9);
    if(!Number.isSafeInteger(n)||n<0)throw new MicroReject('UNSAFE_COST_CONVERSION');
    return BigInt(n);
  }
  private async edge(q:JupiterQuote,a:Authorization):Promise<void> {
    const sell=await this.d.jupiter.quote({inputMint:USDC_MINT,outputMint:SOL_MINT,
      amountRaw:BigInt(q.otherAmountThreshold),slippageBps:MICRO.slippageBps});
    // Both quotes include DEX fees and their slippage minima. No invented EV forecast.
    const fees=a.fee+BASE_FEE_LAMPORTS+a.priority+a.snapshot.ataRent;
    if(BigInt(sell.otherAmountThreshold)<=BigInt(q.inAmount)+fees)throw new MicroReject('NO_POSITIVE_NET_QUOTED_EDGE');
    const exitSlip=BigInt(sell.outAmount)-BigInt(sell.otherAmountThreshold);
    checkCosts({notional:a.notional,networkFee:fees,slippage:a.slip+exitSlip,spread:a.spread,accountRent:0n});
  }
  async beforeBuild(req:SwapRequest,q:JupiterQuote):Promise<{priorityFeeCapLamports:number}> {
    if(req.mint!==USDC_MINT || q.inputMint!==(req.side==='BUY'?SOL_MINT:USDC_MINT) ||
      q.outputMint!==(req.side==='BUY'?USDC_MINT:SOL_MINT)||BigInt(q.inAmount)!==req.amountRaw) throw new MicroReject('PAIR_OR_AMOUNT_MISMATCH');
    if(!Number.isInteger(req.slippageBps)||req.slippageBps<0||req.slippageBps>MICRO.slippageBps||q.slippageBps!==req.slippageBps)throw new MicroReject('SLIPPAGE_ESCALATION_BLOCKED');
    this.d.jupiter.assertFresh(q);
    const s=await this.snapshot();
    if(req.side==='BUY' && this.d.state.lot)throw new MicroReject('POSITION_ALREADY_OPEN');
    if(req.side==='SELL' && (!this.d.state.lot || req.amountRaw!==BigInt(this.d.state.lot.amount)))throw new MicroReject('UNTRACKED_POSITION');
    // Exit cost budget remains denominated in the entry's USD, even if SOL moves.
    const notional=req.side==='BUY'?req.amountRaw:BigInt(Math.floor(this.d.state.lot!.notionalUsd/s.solUsd*1e9));
    if(req.side==='BUY') {
      const usd=exactNumber(notional)/1e9*s.solUsd,eq=equityUsd(s);
      const allocated=Math.min(eq,this.d.state.profile.initialBudgetUsd);
      // Price movement may change notional after sizing. It must remain in the user's allocation band.
      const rounding=s.solUsd/1e9;
      if(usd+rounding<allocated*MICRO.minAllocation || usd>allocated*MICRO.maxAllocation+rounding)
        throw new MicroReject('POSITION_SIZE_LIMIT');
    }
    const slip=req.side==='BUY'?this.usdcLamports(BigInt(q.outAmount)-BigInt(q.otherAmountThreshold),s):BigInt(q.outAmount)-BigInt(q.otherAmountThreshold);
    const quotedValue=req.side==='BUY'?this.usdcLamports(BigInt(q.outAmount),s,false):BigInt(q.outAmount);
    const fairValue=req.side==='BUY'?req.amountRaw:this.usdcLamports(req.amountRaw,s);
    const spread=fairValue>quotedValue?fairValue-quotedValue:0n;
    const priorDrag=req.side==='SELL'?BigInt(Math.ceil(this.d.state.lot!.spentDragUsd/s.solUsd*1e9)):0n;
    const remainder=notional*MICRO.feeBps/10000n-priorDrag-slip-spread-BASE_FEE_LAMPORTS-s.ataRent;
    if(remainder<0n)throw new MicroReject('FEE_CAP');
    const maxPriority=remainder/2n<this.d.configuredPriorityCap?remainder/2n:this.d.configuredPriorityCap;
    const priority=await this.d.priority(maxPriority);
    if(priority<0n||priority>maxPriority)throw new MicroReject('PRIORITY_CAP');
    const fee=BASE_FEE_LAMPORTS+priority;
    const drag=checkCosts({notional,networkFee:fee+priorDrag,slippage:slip,spread,accountRent:s.ataRent});
    checkReserve(s.native,req.side==='BUY'?req.amountRaw:0n,fee+s.ataRent,s.tempRent);
    const a:Authorization={snapshot:s,priority,notional,slip,spread,priorDrag,drag:drag-priorDrag,fee};
    if(req.side==='BUY')await this.edge(q,a);
    this.authorized.set(req,a);this.lastDrag=a.drag;this.lastFee=a.fee;this.lastRent=s.ataRent;this.lastSolUsd=s.solUsd;
    return {priorityFeeCapLamports:exactNumber(priority)};
  }
  async beforeSign(req:SwapRequest,q:JupiterQuote,tx:VersionedTransaction,built:JupiterSwapResponse):Promise<void> {
    const a=this.authorized.get(req);if(!a)throw new MicroReject('MISSING_AUTHORIZATION');
    if(tx.message.header.numRequiredSignatures!==1||!tx.message.staticAccountKeys[0]?.equals(this.d.owner))throw new MicroReject('INVALID_PAYER');
    if(BigInt(built.prioritizationFeeLamports??-1)>a.priority || (built.prioritizationFeeLamports??-1)<0)throw new MicroReject('PRIORITY_CAP');
    const result=await this.d.rpc.execute('micro:message-fee',c=>c.getFeeForMessage(tx.message,'confirmed'));
    if(result.value===null)throw new MicroReject('ACTUAL_FEE_UNAVAILABLE');
    a.fee=BigInt(parse(safeInteger,result.value,'solana-rpc'));
    a.drag=checkCosts({notional:a.notional,networkFee:a.fee+a.priorDrag,slippage:a.slip,spread:a.spread,accountRent:a.snapshot.ataRent})-a.priorDrag;
    const s=await this.snapshot();
    checkReserve(s.native,req.side==='BUY'?req.amountRaw:0n,a.fee+s.ataRent,s.tempRent);
    const ata=getAssociatedTokenAddressSync(new Key(USDC_MINT),this.d.owner);
    // Balances alone miss approvals and transfers of holdings outside SOL/USDC; a swap must leave those accounts untouched.
    const others=(s.unsupportedHoldings??[]).map(h=>new Key(h.account));
    if(others.length>MAX_UNSCOPED_ACCOUNTS)throw new MicroReject('TOO_MANY_UNSCOPED_HOLDINGS');
    const before=others.length?await this.d.rpc.execute('micro:unscoped-before',c=>c.getMultipleAccountsInfo(others,'confirmed')):[];
    const sim=await this.d.rpc.execute('micro:simulate-unsigned',c=>c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',
      addresses:[this.d.owner.toBase58(),ata.toBase58(),...others.map(k=>k.toBase58())]}}));
    if(sim.value.err)throw new MicroReject('ROUTE_SIMULATION_FAILED');
    const [wallet,token,...after]=sim.value.accounts??[];
    others.forEach((_,i)=>{
      const b=before[i],a=after[i];
      if(!b||!a||a.owner!==b.owner.toBase58()||a.lamports!==b.lamports||a.data[1]!=='base64'||
        !Buffer.from(a.data[0]??'','base64').equals(b.data))throw new MicroReject('UNSCOPED_HOLDING_CHANGED');
    });
    if(!wallet||!token||wallet.owner!==SystemProgram.programId.toBase58()||token.owner!==TOKEN_PROGRAM_ID.toBase58())throw new MicroReject('SIMULATED_ACCOUNTS_MISSING');
    const native=BigInt(parse(safeInteger,wallet.lamports,'solana-rpc'));
    if(token.data[1]!=='base64'||typeof token.data[0]!=='string')throw new MicroReject('TOKEN_DATA_ENCODING');
    const decoded=AccountLayout.decode(Buffer.from(token.data[0],'base64'));
    if(!decoded.mint.equals(new Key(USDC_MINT))||!decoded.owner.equals(this.d.owner))throw new MicroReject('SIMULATED_TOKEN_IDENTITY');
    // A delegate or close authority leaves balances unchanged in simulation but lets a third party drain the account later.
    if(decoded.delegateOption!==0||decoded.closeAuthorityOption!==0)throw new MicroReject('SIMULATED_TOKEN_AUTHORITY');
    const usdc=decoded.amount;
    if(native<MICRO.reserveLamports)throw new MicroReject('PROJECTED_RESERVE_FLOOR');
    if(req.side==='BUY' && (s.native-native>req.amountRaw+a.fee+s.ataRent || usdc-s.usdc<BigInt(q.otherAmountThreshold)))throw new MicroReject('SIMULATED_BUY_MISMATCH');
    if(req.side==='SELL' && (s.usdc-usdc!==req.amountRaw || native-s.native<BigInt(q.otherAmountThreshold)-a.fee))throw new MicroReject('SIMULATED_SELL_MISMATCH');
    if(equityUsd({...s,native,usdc})<killThreshold(this.d.state))throw new MicroReject('PROJECTED_EQUITY_KILL');
    a.message=Buffer.from(tx.message.serialize()).toString('base64');this.lastDrag=a.drag;this.lastFee=a.fee;
  }
  async beforeSend(req:SwapRequest,q:JupiterQuote,tx:VersionedTransaction):Promise<void> {
    const a=this.authorized.get(req);
    if(!a?.message||a.message!==Buffer.from(tx.message.serialize()).toString('base64'))throw new MicroReject('TRANSACTION_CHANGED');
    // Refresh USD cost conversions, size and edge immediately before signing.
    const message=a.message,fee=a.fee,priority=a.priority;
    await this.beforeBuild(req,q);
    const fresh=this.authorized.get(req)!;
    if(priority>fresh.priority)throw new MicroReject('PRIORITY_BUDGET_CHANGED');
    fresh.fee=fee;fresh.priority=priority;fresh.message=message;
    fresh.drag=checkCosts({notional:fresh.notional,networkFee:fee+fresh.priorDrag,slippage:fresh.slip,spread:fresh.spread,accountRent:fresh.snapshot.ataRent})-fresh.priorDrag;
    checkReserve(fresh.snapshot.native,req.side==='BUY'?req.amountRaw:0n,fee+fresh.snapshot.ataRent,fresh.snapshot.tempRent);
    if(req.side==='BUY')await this.edge(q,fresh);
    this.d.jupiter.assertFresh(q);
    if(this.d.stopped?.())throw new MicroReject('STOP_REQUESTED');
    this.lastDrag=fresh.drag;this.lastFee=fee;this.lastSolUsd=fresh.snapshot.solUsd;
  }
}

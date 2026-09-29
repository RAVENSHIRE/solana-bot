import { SwapError,type SwapFill } from '../execution/executor';
import { USDC_MINT } from '../core/types';
import { exactNumber } from '../data/core/data-validator';
import { MICRO,MicroReject,type MicroState,type Snapshot } from './policy';

export function book(state:MicroState,fill:SwapFill,s:Snapshot,drag:bigint):void {
  if(state.mode==='LIVE'&&(fill.simulated||!fill.signature))throw new MicroReject('LIVE_FILL_WITHOUT_SIGNATURE');
  if(state.mode==='SIMULATION'&&!fill.simulated)throw new MicroReject('MODE_MISMATCH');
  if(fill.signature&&state.signatures.includes(fill.signature))throw new MicroReject('DUPLICATE_FILL');
  if(fill.mint!==USDC_MINT||drag<0n)throw new MicroReject('INVALID_FILL_IDENTITY');
  if(fill.feeLamports<0n||fill.inAmountRaw<=0n||fill.outAmountRaw<=0n||fill.outAmountRaw<fill.minOutRaw)throw new MicroReject('INVALID_OR_UNDER_MINIMUM_FILL');
  const native=BigInt(state.expectedNative)+fill.solDeltaLamports;
  const usdc=BigInt(state.expectedUsdc)+(fill.side==='BUY'?fill.outAmountRaw:-fill.inAmountRaw);
  if(native<0n||usdc<0n)throw new MicroReject('NEGATIVE_SETTLED_BALANCE');
  let pnl:number|null=null,pnlPct:number|null=null;
  if(fill.side==='BUY') {
    if(state.lot||fill.solDeltaLamports>=0n)throw new MicroReject('UNEXPECTED_BUY_FILL');
    state.lot={amount:String(fill.outAmountRaw),costLamports:String(-fill.solDeltaLamports),notionalLamports:String(fill.inAmountRaw),
      costUsd:exactNumber(-fill.solDeltaLamports)/1e9*s.solUsd,at:s.at,
      notionalUsd:exactNumber(fill.inAmountRaw)/1e9*s.solUsd,spentDragUsd:exactNumber(drag)/1e9*s.solUsd,
      feeBudgetLamports:String(fill.inAmountRaw*MICRO.feeBps/10000n),spentDragLamports:String(drag),entrySignature:fill.signature};
    if(drag*10000n>fill.inAmountRaw*MICRO.feeBps){state.guardrailBreaches++;state.halted='REALIZED_COST_BREACH';}
    state.paperAtaExists=true;
  } else {
    if(!state.lot||fill.inAmountRaw!==BigInt(state.lot.amount))throw new MicroReject('UNEXPECTED_SELL_FILL');
    if(state.lot.spentDragUsd+exactNumber(drag)/1e9*s.solUsd>state.lot.notionalUsd*.015+1e-12) {
      state.guardrailBreaches++;state.halted='REALIZED_COST_BREACH';
    }
    pnl=exactNumber(fill.solDeltaLamports)/1e9*s.solUsd-state.lot.costUsd;
    pnlPct=pnl/state.lot.costUsd*100;
    state.realizedNetUsd+=pnl;state.closedTrades++;state.lot=null;
  }
  state.expectedNative=String(native);state.expectedUsdc=String(usdc);
  state.paperNative=String(native);state.paperUsdc=String(usdc);
  state.feesUsd+=exactNumber(fill.feeLamports)/1e9*s.solUsd;
  state.fills.push({side:fill.side,at:s.at,signature:fill.signature,pnlUsd:pnl,pnlPct,slippagePct:fill.realizedSlippageBps/100});
  if(state.fills.length>10000){state.halted='LEDGER_CAPACITY';state.fills=state.fills.slice(-10000);}
  if(fill.signature)state.signatures.push(fill.signature);
  state.pending=null;
  if(native<MICRO.reserveLamports){state.guardrailBreaches++;state.halted='REALIZED_RESERVE_BREACH';}
}

export function recordFailure(state:MicroState,error:unknown,fillReturned:boolean):void {
  const root=error instanceof Error&&error.cause instanceof MicroReject?error.cause:error;
  const rejectedBeforeSend=!fillReturned&&(root instanceof MicroReject ||
    (error instanceof SwapError&&['quote','impact','build','simulate'].includes(error.stage)));
  if(state.pending) {
    if(rejectedBeforeSend&&!state.pending.signature)state.pending=null;
    else {state.halted='TRANSACTION_RECONCILIATION_REQUIRED';
      if(error instanceof SwapError&&error.signature)state.pending.signature=error.signature;
    }
  }
}


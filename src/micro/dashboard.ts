import { SOL_MINT,USDC_MINT } from '../core/types';
import type { MicroState, Snapshot } from './policy';
export function dashboard(state:MicroState,s:Snapshot,label:string,latency:number) {
  const lot=state.lot,amount=lot?Number(lot.amount)/1e6:0,entry=lot?lot.costUsd/amount:null;
  const pnl=lot?amount*s.usdcUsd-lot.costUsd:null;
  const closes=state.fills.filter(f=>f.side==='SELL'&&f.pnlUsd!==null);
  const equity=state.equity;
  const prices=state.prices.filter(p=>s.at-p.at<=120000);
  const timestamp=new Date(s.at).toISOString();
  return {
    meta:{bot_name:state.halted?`Micro Capital · HALTED (${state.halted})`:'Micro Capital · SOL/USDC',mode:state.mode,network:'Solana Mainnet',
      decision_cadence_seconds:15,rpc_latency_ms:null,active_tokens_count:lot?1:0,skipped_tokens_count:null,closed_tokens_count:state.closedTrades},
    metrics:{total_equity_usd:state.equityUsd,return_percentage:(state.equityUsd/state.baselineUsd-1)*100,
      gas_priority_fees_paid_usd:state.feesUsd,total_trades:state.fills.length,
      win_rate_percentage:closes.length?closes.filter(f=>f.pnlUsd!>0).length/closes.length*100:null,
      avg_hold_duration_seconds:null,max_drawdown_percentage:state.maxDrawdownPct,avg_decision_time_ms:latency,total_decisions:null},
    active_token:{symbol:'USDC',name:'USD Coin',contract_address:USDC_MINT,current_price_usd:s.usdcUsd,
      price_change_2m_high:prices.length?(Math.max(...prices.map(p=>p.usdcUsd))/prices[0]!.usdcUsd-1)*100:null,
      price_change_2m_low:prices.length?(Math.min(...prices.map(p=>p.usdcUsd))/prices[0]!.usdcUsd-1)*100:null,baseline_entry_price:entry,
      ticks:prices.map(p=>({timestamp:new Date(p.at).toISOString(),price:p.usdcUsd,action_marker:null}))},
    watchlist:[{id:SOL_MINT,symbol:'SOL',name:'Solana',price_usd:s.solUsd,sparkline:prices.map(p=>p.solUsd),ai_status:{action:null,confidence_pct:null}},
      {id:USDC_MINT,symbol:'USDC',name:'USD Coin',price_usd:s.usdcUsd,sparkline:prices.map(p=>p.usdcUsd),ai_status:{action:lot?'HOLD':'SKIP',confidence_pct:null}}],
    decisions:[{id:String(s.at),symbol:'SOL/USDC',timestamp,action:'WAIT',action_label:label,
      probabilities:{long_pct:null,short_pct:null,wait_pct:null},confidence_pct:null,latency_ms:latency,safety:{rug_score_pct:null,liquidity_usd:null}}],
    positions:lot?[{id:lot.entrySignature??String(lot.at),symbol:'USDC',token_address:USDC_MINT,side:'LONG',entry_price_usd:entry,
      current_price_usd:s.usdcUsd,size_tokens:amount,unrealized_pnl_usd:pnl,unrealized_pnl_pct:pnl!/lot.costUsd*100,
      stop_loss_usd:null,take_profit_usd:null,opened_at:new Date(lot.at).toISOString()}]:[],
    trade_history:state.fills.map((f,i)=>({id:f.signature??`${f.at}-${i}`,symbol:'USDC',side:f.side,
      realized_pnl_usd:f.pnlUsd,realized_pnl_pct:f.pnlPct,slippage_pct:f.slippagePct,tx_hash:f.signature,timestamp:new Date(f.at).toISOString()})),
    equity_curve:equity.map(p=>({timestamp:new Date(p.at).toISOString(),equity_usd:p.usd})),
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { loadConfig } from '../config/config';
import { SOL_MINT,USDC_MINT,BASE_FEE_LAMPORTS } from '../core/types';
import { DataRuntime } from '../data/core/data-runtime';
import { MarketDataStore } from '../data/storage/market-data-store';
import { requestScope } from '../data/core/request-scope';
import { DexScreenerClient } from '../data/dexscreener';
import { ConnectionManager } from '../rpc/connection-manager';
import { JupiterClient } from '../execution/jupiter-client';
import { LiveExecutor } from '../execution/live-executor';
import { TransactionSender } from '../execution/tx-sender';
import { type SwapFill,type SwapRequest } from '../execution/executor';
import { loadWalletFromEnv } from '../utils/wallet';
import { acquireProcessLock, atomicWriteFile } from '../utils/fs';
import { configureLogger,rootLogger as log } from '../utils/logger';
import { redactText } from '../utils/redact';
import { book,recordFailure } from './ledger';
export { book,recordFailure } from './ledger';
import { MICRO,MicroReject,MicroStateSchema,freshState,observeState,equityUsd,sizeUsd,usdToLamports,checkReserve,checkCosts,createProfile,killThreshold,type MicroState,type Snapshot } from './policy';
import { MicroMarket } from './market';
import { MicroGuard } from './guard';
import { dashboard } from './dashboard';

export function options(env:NodeJS.ProcessEnv=process.env) {
  return z.object({MICRO_BUDGET_USD:z.coerce.number().min(5).max(10).default(10),
    MICRO_TRADE_USD:z.coerce.number().min(1).max(3).default(Number(env.MICRO_BUDGET_USD??10)*.2),MICRO_STATE_DIR:z.string().default('./data-micro')}).parse(env);
}
export async function run(args=process.argv.slice(2)):Promise<number> {
  const opt=options(),profile=createProfile(opt.MICRO_BUDGET_USD,opt.MICRO_TRADE_USD),checking=args.includes('--check'),live=args.includes('--live');
  if(live&&(checking||args.includes('--simulation')))throw new MicroReject('CONFLICTING_MODES');
  if(live&&process.env.LIVE_TRADING_CONFIRMED!=='I_UNDERSTAND_THE_RISKS')throw new MicroReject('LIVE_CONFIRMATION_REQUIRED');
  const mode=live?'LIVE':'SIMULATION';
  const cfg=loadConfig({...process.env,SIMULATION_MODE:live?'false':'true',PRE_SIMULATE_TX:'true',CLOSE_EMPTY_TOKEN_ACCOUNTS:'false',DEFAULT_SLIPPAGE_BPS:String(MICRO.slippageBps)});
  configureLogger({color:false,level:'info'});
  // Existing local signer; no Phantom browser connection is implied.
  const wallet:Keypair=loadWalletFromEnv();
  const rpc=new ConnectionManager(cfg.rpc.endpoints,{...cfg.rpc,logger:log});
  if(await rpc.execute('genesis',c=>c.getGenesisHash())!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw new MicroReject('MAINNET_REQUIRED');
  const dir=path.resolve(opt.MICRO_STATE_DIR),stateFile=path.join(dir,`micro-${mode}.json`);
  const history=checking||!cfg.data.persistHistory?undefined:new MarketDataStore(path.join(dir,'history'),mode,log,
    cfg.data.retentionDays,cfg.data.historyMaxBytes);
  const data=new DataRuntime(log,cfg.data,history),jupiter=new JupiterClient(cfg.jupiter,log,data);
  const market=new MicroMarket(rpc,new DexScreenerClient(log,data),wallet.publicKey);
  const initial=await market.snapshot();
  if(checking) {
    if(equityUsd(initial)<killThreshold(profile))throw new MicroReject('FUNDING_BELOW_KILL_THRESHOLD');
    let prior:MicroState|undefined;
    try {prior=MicroStateSchema.parse(JSON.parse(await fs.readFile(path.join(dir,'micro-LIVE.json'),'utf8')));}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new MicroReject('STATE_INVALID');}
    if(prior) {
      if(prior.wallet!==wallet.publicKey.toBase58()||prior.mode!=='LIVE')throw new MicroReject('STATE_IDENTITY_MISMATCH');
      observeState(prior,initial);
      if(prior.halted)throw new MicroReject('LIVE_HALTED',prior.halted);
      if(prior.baselineUsd>opt.MICRO_BUDGET_USD)throw new MicroReject('BASELINE_EXCEEDS_BUDGET');
    } else if(equityUsd(initial)>opt.MICRO_BUDGET_USD)throw new MicroReject('WALLET_EXCEEDS_BUDGET');
    const selling=!!prior?.lot,input=selling?BigInt(prior!.lot!.amount):usdToLamports(sizeUsd(equityUsd(initial),opt.MICRO_TRADE_USD,prior?.profile??profile),initial);
    await jupiter.quote({inputMint:selling?USDC_MINT:SOL_MINT,outputMint:selling?SOL_MINT:USDC_MINT,amountRaw:input,slippageBps:MICRO.slippageBps});
    if(!selling)checkCosts({notional:input,networkFee:BASE_FEE_LAMPORTS*2n,slippage:0n,spread:0n,accountRent:initial.ataRent});
    checkReserve(initial.native,selling?0n:input,BASE_FEE_LAMPORTS+BigInt(cfg.jupiter.maxPriorityFeeLamports)+initial.ataRent,initial.tempRent);
    log.info('[CHECK] read-only', {signer:'LOCAL_KEY',wallet:wallet.publicKey.toBase58(),equityUsd:equityUsd(initial),
      budgetUsd:opt.MICRO_BUDGET_USD,tradeUsd:opt.MICRO_TRADE_USD,side:selling?'SELL':'BUY',inputRaw:String(input),nativeSol:Number(initial.native)/1e9,
      reserveSol:Number(MICRO.reserveLamports)/1e9,existingUsdcAta:initial.ataExists});
    return 0;
  }
  await fs.mkdir(dir,{recursive:true});
  const lockFile=path.join(dir,`micro-${mode}.lock`);
  if((await fs.readdir(dir)).some(name=>name!==`micro-${mode}.lock`&&name.startsWith('micro-')&&name.endsWith(`-${mode}.lock`)))
    throw new MicroReject('LEGACY_INSTANCE_LOCK','Stop the older micro instance and review its ledger before removing its lock');
  const lock=await acquireProcessLock(lockFile).catch(()=>{throw new MicroReject('INSTANCE_LOCK','Another running process owns this ledger');});
  let stop=false;let wake:(()=>void)|undefined;const abort=new AbortController();
  const requestStop=()=>{stop=true;abort.abort();wake?.();};
  process.once('SIGINT',requestStop);process.once('SIGTERM',requestStop);
  let state:MicroState;
  const persist=async()=>{await atomicWriteFile(stateFile,JSON.stringify(MicroStateSchema.parse(state),null,2)+'\n');};
  try {
    try {state=MicroStateSchema.parse(JSON.parse(await fs.readFile(stateFile,'utf8')));}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new MicroReject('STATE_INVALID','No automatic reset');
      const s=live?initial:{...initial,native:usdToLamports(opt.MICRO_BUDGET_USD,initial),usdc:0n};
      if(live&&equityUsd(s)>opt.MICRO_BUDGET_USD)throw new MicroReject('WALLET_EXCEEDS_BUDGET','Use the dedicated test wallet');
      state=freshState(wallet.publicKey.toBase58(),mode,s,profile);await persist();
    }
    if(state.wallet!==wallet.publicKey.toBase58()||state.mode!==mode)throw new MicroReject('STATE_IDENTITY_MISMATCH');
    const snapshot=async()=>{
      const observed=await market.snapshot();
      return live?observed:{...observed,native:BigInt(state.paperNative),usdc:BigInt(state.paperUsdc),
        ataExists:state.paperAtaExists,ataRent:state.paperAtaExists?0n:observed.ataRent};
    };
    const guard=new MicroGuard({rpc,jupiter,owner:wallet.publicKey,state,snapshot,priority:max=>market.priorityCap(max),persist,
      configuredPriorityCap:BigInt(cfg.jupiter.maxPriorityFeeLamports),stopped:()=>stop});
    const executor=live?new LiveExecutor({cfg,rpc,jupiter,logger:log,owner:wallet.publicKey,guard},wallet,
      new TransactionSender(rpc,log,{confirmTimeoutMs:cfg.execution.confirmTimeoutMs,pollIntervalMs:1500,rebroadcastIntervalMs:2000})):null;
    log.info('[START]',{mode,signer:live?'LOCAL_KEY':'NONE',budgetUsd:opt.MICRO_BUDGET_USD,tradeUsd:opt.MICRO_TRADE_USD,reserveSol:.003,feeCapPct:1.5});
    while(!stop) {
      const started=Date.now();let label='SCAN';let s:Snapshot|undefined;let fillReturned=false;
      try {
        s=await snapshot();observeState(state,s);
        state.equity.push({at:s.at,usd:state.equityUsd});state.equity=state.equity.slice(-1000);
        state.prices.push({at:s.at,solUsd:s.solUsd,usdcUsd:s.usdcUsd});state.prices=state.prices.slice(-1000);
        if(state.halted){label=`HALT ${state.halted}`;log.error('[HALT]',{reason:state.halted,nextMode:'SIMULATION',openPosition:!!state.lot});}
        else {
          const side=state.lot?'SELL':'BUY';
          const amount=state.lot?BigInt(state.lot.amount):usdToLamports(sizeUsd(state.equityUsd,state.profile.requestedTradeUsd,state.profile),s);
          const req:SwapRequest={side,mint:USDC_MINT,amountRaw:amount,slippageBps:MICRO.slippageBps};
          const q=await jupiter.quote({inputMint:side==='BUY'?SOL_MINT:USDC_MINT,outputMint:side==='BUY'?USDC_MINT:SOL_MINT,amountRaw:amount,slippageBps:MICRO.slippageBps});
          const authorization=await guard.beforeBuild(req,q);
          if(stop)break;
          state.pending={side,at:Date.now(),signature:null};await persist();
          let fill:SwapFill;let drag:bigint;
          if(executor) {
            fill=await requestScope.run({signal:abort.signal,category:'execution'},()=>executor.swap(req));fillReturned=true;
            drag=guard.lastDrag+(fill.feeLamports>guard.lastFee?fill.feeLamports-guard.lastFee:0n)+
              (fill.rentLamports>guard.lastRent?fill.rentLamports-guard.lastRent:0n);
          }
          else {
            jupiter.assertFresh(q);
            const out=BigInt(q.otherAmountThreshold),fee=BASE_FEE_LAMPORTS+BigInt(authorization.priorityFeeCapLamports);
            drag=guard.lastDrag;
            fill={simulated:true,signature:null,side,mint:USDC_MINT,inAmountRaw:amount,outAmountRaw:out,quotedOutRaw:BigInt(q.outAmount),minOutRaw:out,
              solDeltaLamports:side==='BUY'?-amount-fee-guard.lastRent:out-fee,feeLamports:fee,rentLamports:guard.lastRent,priceImpactPct:JupiterClient.priceImpactPct(q),
              realizedSlippageBps:Number((BigInt(q.outAmount)-out)*10000n/BigInt(q.outAmount)),route:JupiterClient.routeLabel(q),latencyMs:Date.now()-started};
          }
          book(state,fill,{...s,solUsd:guard.lastSolUsd,at:Date.now()},drag);
          data.record('micro-fill','execution',fill);
          s={...s,native:BigInt(state.expectedNative),usdc:BigInt(state.expectedUsdc),at:Date.now()};
          observeState(state,s);
          label=`${side} ${mode}`;log.info(`[${side}]`,{mode,signature:fill.signature??'PAPER',feesLamports:String(fill.feeLamports),closed:state.closedTrades});
        }
      } catch(error) {
        label=redactText(error instanceof Error?error.message:String(error));
        recordFailure(state,error,fillReturned);
        log.warn('[SKIP]',{reason:label});
      }
      await persist();
      data.record('micro-decision','micro-profile',{label,mode,equityUsd:state.equityUsd,halted:state.halted,
        pending:state.pending,closedTrades:state.closedTrades,cloudReady:state.cloudReady});
      if(s){
        const view=JSON.stringify(dashboard(state,s,label,Date.now()-started));
        await atomicWriteFile(path.join(dir,`dashboard-${mode}.json`),view);
        await atomicWriteFile(path.join(dir,'active-dashboard.json'),view);
      }
      if(state.cloudReady)log.info('[CLOUD READY]',{netTradingRoiPct:state.realizedNetUsd/state.baselineUsd*100,closedTrades:state.closedTrades,statisticalEdge:'NOT_ESTABLISHED',deployment:'NOT_STARTED'});
      if(state.halted)return live?75:0;
      await new Promise<void>(resolve=>{const t=setTimeout(resolve,Math.max(1000,MICRO.scanMs-(Date.now()-started)));wake=()=>{clearTimeout(t);resolve();};});
      wake=undefined;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT',requestStop);process.removeListener('SIGTERM',requestStop);
    await lock.close();await fs.unlink(lockFile);await data.flush();
  }
}
if(require.main===module)run().then(code=>{process.exitCode=code;}).catch(error=>{log.error('[STOP]',{reason:redactText(error instanceof Error?error.message:String(error))});process.exitCode=1;});

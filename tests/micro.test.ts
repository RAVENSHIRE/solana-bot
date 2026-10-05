import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MICRO, MicroReject, createProfile, readiness, checkCosts, checkReserve, freshState, observeState, sizeUsd, usdToLamports, validPrices, MicroStateSchema, type Snapshot } from '../src/micro/policy';
import { MicroGuard } from '../src/micro/guard';
import { book, recordFailure, options } from '../src/micro/runtime';
import { dashboard } from '../src/micro/dashboard';
import { BotStateSchema } from '../dashboard/shared/state';
import { SOL_MINT, USDC_MINT, USDT_MINT } from '../src/core/types';
import { MicroMarket } from '../src/micro/market';
import { normalizeDexPairs } from '../src/data/dexscreener';
import { SwapError, type SwapFill, type SwapRequest } from '../src/execution/executor';
import { LiveExecutor } from '../src/execution/live-executor';
import { JupiterClient, type JupiterQuote } from '../src/execution/jupiter-client';
import { Logger, configureLogger } from '../src/utils/logger';

// Synthetic deterministic test fixtures. Runtime imports none of these values.
configureLogger({level:'error',color:false});
const wallet=Keypair.fromSeed(new Uint8Array(32).fill(41)),owner=wallet.publicKey;
const log=new Logger('micro-test');
// One clock reading for both times: equityUsd() validates prices as of `at`, so a receivedAt read 1 ms later (two
// Date.now() calls straddling a millisecond) was "from the future" and made these tests flake now and then.
const snap=(patch:Partial<Snapshot>={},now=Date.now()):Snapshot=>({native:50_000_000n,usdc:0n,solUsd:100,usdcUsd:1,
  at:now,receivedAt:now,ataExists:true,ataRent:0n,tempRent:4_000_000n,...patch});
const state=()=>freshState(owner.toBase58(),'LIVE',snap(),createProfile(5));
const req=():SwapRequest=>({side:'BUY',mint:USDC_MINT,amountRaw:10_000_000n,slippageBps:30});
const quote=(side='BUY'):JupiterQuote=>({inputMint:side==='BUY'?SOL_MINT:USDC_MINT,outputMint:side==='BUY'?USDC_MINT:SOL_MINT,
  inAmount:side==='BUY'?'10000000':'1000000',outAmount:side==='BUY'?'1003000':'10100000',
  otherAmountThreshold:side==='BUY'?'1000000':'10070000',swapMode:'ExactIn',slippageBps:30,priceImpactPct:'0',routePlan:[]});
const buyFill=(patch:Partial<SwapFill>={}):SwapFill=>({simulated:false,signature:'fixture-buy',side:'BUY',mint:USDC_MINT,
  inAmountRaw:10_000_000n,outAmountRaw:1_000_000n,quotedOutRaw:1_003_000n,minOutRaw:1_000_000n,
  solDeltaLamports:-10_006_000n,feeLamports:6_000n,rentLamports:0n,priceImpactPct:0,realizedSlippageBps:30,route:'fixture',latencyMs:1,...patch});
function fixture(patch:Partial<Snapshot>={}) {
  let s=snap(patch);const st=freshState(owner.toBase58(),'LIVE',s,createProfile(5));let fee=6_000,simNative=39_994_000,simToken=1_000_000n;
  let err:unknown=null;let priority=1_000n;let reverse=quote('SELL');let persisted=0;let simDelegate=false;
  const unscoped:{key:PublicKey;before:Buffer;after:Buffer}[]=[];
  const accountData=()=>{
    const data=Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({mint:new PublicKey(USDC_MINT),owner,amount:simToken,delegateOption:simDelegate?1:0,
      delegate:simDelegate?Keypair.fromSeed(new Uint8Array(32).fill(66)).publicKey:SystemProgram.programId,state:1,isNativeOption:0,isNative:0n,
      delegatedAmount:simDelegate?simToken:0n,closeAuthorityOption:0,closeAuthority:SystemProgram.programId},data);return data.toString('base64');
  };
  const connection={getFeeForMessage:async()=>({value:fee}),
    getMultipleAccountsInfo:async(keys:PublicKey[])=>keys.map(k=>{const u=unscoped.find(x=>x.key.equals(k));
      return u?{owner:TOKEN_PROGRAM_ID,lamports:2_039_280,data:u.before,executable:false,rentEpoch:0}:null;}),
    simulateTransaction:async(_tx:unknown,config:{accounts:{addresses:string[]}})=>({value:{err,accounts:[
    {owner:SystemProgram.programId.toBase58(),lamports:simNative},
    {owner:TOKEN_PROGRAM_ID.toBase58(),data:[accountData(),'base64']},
    ...config.accounts.addresses.slice(2).map(a=>{const u=unscoped.find(x=>x.key.toBase58()===a)!;
      return {owner:TOKEN_PROGRAM_ID.toBase58(),lamports:2_039_280,data:[u.after.toString('base64'),'base64']};}),
  ]}})};
  const rpc={execute:async(_label:string,fn:(c:typeof connection)=>unknown)=>fn(connection)};
  const jupiter={quote:async()=>reverse,assertFresh:()=>{}};
  const guard=new MicroGuard({rpc:rpc as any,jupiter:jupiter as any,owner,state:st,
    snapshot:async()=>{const now=Date.now();return {...s,at:now,receivedAt:now};},priority:async()=>priority,
    persist:async()=>{persisted++;},configuredPriorityCap:100_000n});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:SystemProgram.programId.toBase58(),instructions:[]}).compileToV0Message());
  const built={swapTransaction:'AA==',lastValidBlockHeight:1,prioritizationFeeLamports:1000};
  return {guard,st,tx,built,unscoped:(before:Buffer,after:Buffer=before)=>{
    const key=Keypair.generate().publicKey;unscoped.push({key,before,after});
    s={...s,unsupportedHoldings:[...(s.unsupportedHoldings??[]),{mint:SOL_MINT,account:key.toBase58(),amountRaw:'1',reason:'OUTSIDE_SOL_USDC_SCOPE'}]};
  },set:(patch:{fee?:number,simNative?:number,simToken?:bigint,err?:unknown,priority?:bigint,s?:Snapshot,reverse?:JupiterQuote,delegate?:boolean})=>{
    if(patch.delegate!==undefined)simDelegate=patch.delegate;
    if(patch.fee!==undefined)fee=patch.fee;if(patch.simNative!==undefined)simNative=patch.simNative;
    if(patch.simToken!==undefined)simToken=patch.simToken;if('err' in patch)err=patch.err;
    if(patch.priority!==undefined)priority=patch.priority;if(patch.s)s=patch.s;if(patch.reverse)reverse=patch.reverse;
  },persisted:()=>persisted};
}

test('reserve floor includes input, fees and temporary capital at the exact boundary',()=>{
  checkReserve(17_006_000n,10_000_000n,6_000n,4_000_000n);
  assert.throws(()=>checkReserve(17_005_999n,10_000_000n,6_000n,4_000_000n),/SOL_RESERVE/);
  assert.throws(()=>checkReserve(1n,-1n,0n,0n),/INVALID/);
});
test('1.5% fee cap uses exact integer comparison and counts rent and spread',()=>{
  const costs={notional:10_000_000n,networkFee:10000n,slippage:40000n,spread:20000n,accountRent:80000n};
  assert.equal(checkCosts(costs),150000n);
  assert.throws(()=>checkCosts({...costs,accountRent:80001n}),/FEE_CAP/);
  assert.throws(()=>checkCosts({...costs,slippage:-1n}),/INVALID_TCA/);
});
test('USD sizing uses prices and enforces equity share and kill threshold',()=>{
  assert.equal(sizeUsd(10),2);assert.equal(sizeUsd(10,3),3);
  assert.equal(sizeUsd(7,3),2.1);assert.throws(()=>sizeUsd(6.9999),/EQUITY_KILL/);
  assert.equal(sizeUsd(100),2);assert.throws(()=>sizeUsd(10,NaN),/TRADE_SIZE/);
  assert.equal(sizeUsd(5,1,createProfile(5)),1);
  assert.equal(usdToLamports(1,snap({solUsd:125})),8_000_000n);
});
test('nonfinite, future and stale prices are rejected without stablecoin peg assumptions',()=>{
  for(const patch of [{solUsd:Infinity},{usdcUsd:0},{receivedAt:Date.now()+1000},{receivedAt:Date.now()-15001}])
    assert.throws(()=>validPrices(snap(patch)),/PRICE_UNAVAILABLE/);
  const st=freshState('fixture','SIMULATION',snap({native:0n,usdc:5_000_000n,usdcUsd:.98}));
  assert.equal(st.baselineUsd,4.9);
});
test('kill switch latches below 3.50 USD and survives validated state reload',()=>{
  const st=state();observeState(st,snap({solUsd:70}));assert.equal(st.halted,null);
  observeState(st,snap({solUsd:69.99}));assert.equal(st.halted,'EQUITY_BELOW_70_PERCENT_BASELINE');
  const restored=MicroStateSchema.parse(JSON.parse(JSON.stringify(st)));
  observeState(restored,snap());assert.equal(restored.halted,'EQUITY_BELOW_70_PERCENT_BASELINE');
});
test('pending intent blocks restart and unrecognized cash flows cannot inflate performance',()=>{
  const st=state();st.pending={side:'BUY',at:Date.now(),signature:'known-signature'};
  observeState(st,snap());assert.equal(st.halted,'UNRESOLVED_TRANSACTION');
  const deposit=state();deposit.realizedNetUsd=2;deposit.closedTrades=50;
  observeState(deposit,snap({native:60_000_000n}));assert.equal(deposit.cloudReady,false);assert.equal(deposit.externalCashFlow,true);
});
test('CLOUD READY requires more than 20% realized net profit and at least 30 closes',()=>{
  const check=(closed:number,pnl:number,mode:'LIVE'|'SIMULATION'='LIVE')=>{
    const st=state();st.mode=mode;st.closedTrades=closed;st.realizedNetUsd=pnl;
    st.expectedNative='61000000';observeState(st,snap({native:61_000_000n}));return st.cloudReady;
  };
  assert.equal(check(30,1),false);assert.equal(check(29,1.01),false);assert.equal(check(30,1.01),true);
  assert.equal(check(30,1.01,'SIMULATION'),false);assert.equal(check(30,0),false);
});
test('passive SOL appreciation and a cost breach never count as cloud qualification',()=>{
  const st=state();st.closedTrades=30;observeState(st,snap({solUsd:130}));assert.equal(st.cloudReady,false);
  st.realizedNetUsd=2;st.guardrailBreaches=1;observeState(st,snap({solUsd:130}));assert.equal(st.cloudReady,false);
});
test('confirmed booking is exact and duplicate signatures cannot create another position',()=>{
  const st=state();book(st,buyFill(),snap(),36000n);
  assert.equal(st.expectedNative,'39994000');assert.equal(st.expectedUsdc,'1000000');assert.equal(st.lot?.notionalUsd,1);
  assert.throws(()=>book(st,buyFill(),snap(),36000n),/DUPLICATE/);
  const sell=buyFill({side:'SELL',signature:'fixture-sell',inAmountRaw:1_000_000n,outAmountRaw:10_100_000n,
    minOutRaw:10_070_000n,solDeltaLamports:10_094_000n});
  book(st,sell,snap(),36000n);assert.equal(st.closedTrades,1);assert.equal(st.lot,null);
  assert.ok(Math.abs(st.realizedNetUsd-.0088)<1e-12);
});
test('exit cost accounting respects the entry USD budget after SOL price changes',()=>{
  const st=state();book(st,buyFill(),snap(),100000n); // $0.01 entry drag
  book(st,buyFill({side:'SELL',signature:'fixture-sell',inAmountRaw:1_000_000n,outAmountRaw:5_000_000n,
    minOutRaw:4_985_000n,solDeltaLamports:4_994_000n}),snap({solUsd:200}),30000n); // $0.006 exit drag
  assert.equal(st.guardrailBreaches,1);assert.equal(st.halted,'REALIZED_COST_BREACH');
});
test('failed booking after a returned fill keeps the pending transaction for reconciliation',()=>{
  const st=state();st.pending={side:'BUY',at:Date.now(),signature:'signed'};
  recordFailure(st,new MicroReject('BAD_CONFIRMED_FILL'),true);
  assert.equal(st.pending?.signature,'signed');assert.equal(st.halted,'TRANSACTION_RECONCILIATION_REQUIRED');
});
test('only definitively unsent errors clear intent; unknown and signed errors latch',()=>{
  for(const error of [new MicroReject('FEE_CAP'),new SwapError('build failed','build')]) {
    const st=state();st.pending={side:'BUY',at:Date.now(),signature:null};recordFailure(st,error,false);assert.equal(st.pending,null);
  }
  const st=state();st.pending={side:'BUY',at:Date.now(),signature:null};
  recordFailure(st,new SwapError('timeout','unknown',0n,'rpc-signature'),false);
  assert.equal(st.pending?.signature,'rpc-signature');assert.ok(st.halted);
});
test('guard rejects rent that breaches cost cap before transaction construction',async()=>{
  const f=fixture({ataExists:false,ataRent:2_000_000n});
  await assert.rejects(f.guard.beforeBuild(req(),quote()),/FEE_CAP/);
});
test('guard rejects negative quoted edge and unsupported pairs',async()=>{
  const f=fixture();f.set({reverse:{...quote('SELL'),otherAmountThreshold:'9990000'}});
  await assert.rejects(f.guard.beforeBuild(req(),quote()),/NO_POSITIVE_NET_QUOTED_EDGE/);
  await assert.rejects(f.guard.beforeBuild({...req(),mint:SOL_MINT},quote()),/PAIR_OR_AMOUNT/);
});
test('guard forbids slippage escalation and priority fees above remaining budget',async()=>{
  const f=fixture();await assert.rejects(f.guard.beforeBuild({...req(),slippageBps:5000},quote()),/SLIPPAGE_ESCALATION/);
  f.set({priority:1_000_000n});await assert.rejects(f.guard.beforeBuild(req(),quote()),/PRIORITY_CAP/);
});
test('guard rejects actual network fees above cap before signing',async()=>{
  const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);f.set({fee:151000});
  await assert.rejects(f.guard.beforeSign(r,q,f.tx,f.built),/FEE_CAP/);
  assert.ok(f.tx.signatures.every(bytes=>bytes.every(byte=>byte===0)));
});
test('unsigned RPC simulation must preserve reserve and quoted token minimum',async()=>{
  for(const patch of [{simNative:2_999_999},{simToken:999999n},{err:{InstructionError:[1,'failed']}}]) {
    const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);f.set(patch);
    await assert.rejects(f.guard.beforeSign(r,q,f.tx,f.built),/PROJECTED_RESERVE|SIMULATED_BUY|ROUTE_SIMULATION/);
  }
});
test('guard accepts a passing unsigned route and rejects message mutation',async()=>{
  const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);await f.guard.beforeSign(r,q,f.tx,f.built);
  await f.guard.beforeSend(r,q,f.tx);
  assert.ok(f.tx.signatures[0]!.every(v=>v===0));
  f.tx.message.recentBlockhash=owner.toBase58();await assert.rejects(f.guard.beforeSend(r,q,f.tx),/TRANSACTION_CHANGED/);
});
test('balance changes while preparing a route latch the kill switch before signature',async()=>{
  const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);await f.guard.beforeSign(r,q,f.tx,f.built);
  f.set({s:snap({native:49_000_000n})});await assert.rejects(f.guard.beforeSend(r,q,f.tx),/LIVE_HALTED/);
  assert.equal(f.st.externalCashFlow,true);assert.equal(f.persisted(),1);
});
test('signed identity is persisted before any broadcaster can run',async()=>{
  const f=fixture();f.st.pending={side:'BUY',at:Date.now(),signature:null};f.tx.sign([wallet]);
  await f.guard.onSigned(f.tx);assert.ok(f.st.pending.signature);assert.equal(f.persisted(),1);
});
test('LiveExecutor gate rejection cannot reach signing or broadcasting',async()=>{
  for(const failing of ['beforeBuild','beforeSign','beforeSend']) {
    const f=fixture();let builds=0,sends=0,signs=0;
    const cfg={execution:{preSimulate:true,maxPriceImpactPct:1}};
    const guard=Object.fromEntries(['beforeBuild','beforeSign','beforeSend'].map(name=>[name,async()=>{
      if(name===failing)throw new MicroReject('TEST_REJECT');return {priorityFeeCapLamports:1000};
    }]));
    const signer={publicKey:owner,get secretKey(){signs++;return wallet.secretKey;}};
    const jupiter={quote:async()=>quote(),assertFresh:()=>{},buildSwap:async()=>{builds++;return {
      swapTransaction:Buffer.from(f.tx.serialize()).toString('base64'),lastValidBlockHeight:1,prioritizationFeeLamports:1000};}};
    const rpc={execute:async(_label:string,fn:(c:unknown)=>unknown)=>fn({simulateTransaction:async()=>({value:{err:null,logs:[]}})})};
    const executor=new LiveExecutor({cfg,rpc,jupiter,logger:log,owner,guard} as any,signer as any,
      {sendAndConfirm:async()=>{sends++;throw new Error('must never send');}} as any);
    await assert.rejects(executor.swap(req()));assert.equal(sends,0);assert.equal(signs,0);
    if(failing==='beforeBuild')assert.equal(builds,0);
  }
});
test('strict dashboard schema accepts observed prices and missing analytics remain null',()=>{
  const st=state();st.prices.push({at:Date.now(),solUsd:100,usdcUsd:.99});
  const view=BotStateSchema.parse(dashboard(st,snap({usdcUsd:.99}),'FEE_CAP',5));
  assert.equal(view.active_token?.ticks[0]?.price,.99);assert.equal(view.decisions[0]?.confidence_pct,null);
  assert.equal(view.metrics.win_rate_percentage,null);assert.equal(view.metrics.total_trades,0);
});
test('micro defaults are limits only and out-of-range configuration fails closed',()=>{
  assert.equal(options({}).MICRO_BUDGET_USD,10);assert.equal(options({}).MICRO_TRADE_USD,2);
  assert.throws(()=>options({MICRO_BUDGET_USD:'500'}));assert.throws(()=>options({MICRO_TRADE_USD:'NaN'}));
  assert.equal(MICRO.reserveLamports,3_000_000n);
});
test('Jupiter per-order priority override cannot raise the configured cap',async()=>{
  const client=new JupiterClient({baseUrl:'https://example.invalid',maxPriorityFeeLamports:1000,maxRps:1,maxAccounts:40,priorityLevel:'high',quoteMaxAgeMs:15000} as any,log);
  await assert.rejects(client.buildSwap(quote(),owner.toBase58(),1001),/cannot raise/);
});

test('new ATA can pass only when observed rent fits the fee budget and the net quote edge',async()=>{
  const f=fixture({ataExists:false,ataRent:1000n}),r=req(),q=quote();
  await f.guard.beforeBuild(r,q);assert.equal(f.guard.lastRent,1000n);
  f.set({simNative:39_993_000});await f.guard.beforeSign(r,q,f.tx,f.built);
});
test('simulated USDC delegate approval is rejected even when balances match',async()=>{
  const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);
  f.set({delegate:true});await assert.rejects(f.guard.beforeSign(r,q,f.tx,f.built),/SIMULATED_TOKEN_AUTHORITY/);
  f.set({delegate:false});await f.guard.beforeSign(r,q,f.tx,f.built);
});
test('holdings outside SOL/USDC must be unchanged by the simulated swap',async()=>{
  const untouched=fixture(),r=req(),q=quote();untouched.unscoped(Buffer.alloc(165,7));
  await untouched.guard.beforeBuild(r,q);await untouched.guard.beforeSign(r,q,untouched.tx,untouched.built);
  const drained=fixture(),r2=req();drained.unscoped(Buffer.alloc(165,7),Buffer.alloc(165,8));
  await drained.guard.beforeBuild(r2,q);await assert.rejects(drained.guard.beforeSign(r2,q,drained.tx,drained.built),/UNSCOPED_HOLDING_CHANGED/);
});
test('micro snapshot prices USDC from the USDC/USDT pool DexScreener actually returns',async()=>{
  const raw=(base:string,quote:string,price:string)=>({chainId:'solana',dexId:'fixture',pairAddress:base,baseToken:{address:base,symbol:'X'},
    quoteToken:{address:quote},priceUsd:price,liquidity:{usd:1_000_000},pairCreatedAt:Date.now()-86_400_000,txns:{h1:{buys:1,sells:1}}});
  const dex={data:{cache:{invalidate:()=>{}}},getPairsForTokens:async()=>normalizeDexPairs([raw(SOL_MINT,USDC_MINT,'118'),raw(USDC_MINT,USDT_MINT,'1.0003')],Date.now())};
  const rpc={execute:async(_label:string,fn:(c:unknown)=>unknown)=>fn({getParsedTokenAccountsByOwner:async()=>({value:[]}),
    getBalance:async()=>50_000_000,getMinimumBalanceForRentExemption:async()=>2_039_280})};
  const s=await new MicroMarket(rpc as any,dex as any,owner).snapshot();
  assert.equal(s.solUsd,118);assert.equal(s.usdcUsd,1.0003);assert.equal(s.native,50_000_000n);
});
test('unexpected fee payer is rejected before simulation or signing',async()=>{
  const f=fixture(),r=req(),q=quote();await f.guard.beforeBuild(r,q);
  const wrong=new VersionedTransaction(new TransactionMessage({payerKey:SystemProgram.programId,
    recentBlockhash:owner.toBase58(),instructions:[]}).compileToV0Message());
  await assert.rejects(f.guard.beforeSign(r,q,wrong,f.built),/INVALID_PAYER/);
});
test('user stop prevents even initial authorization from fetching balances',async()=>{
  let snapshots=0;
  const guard=new MicroGuard({owner,state:state(),stopped:()=>true,snapshot:async()=>{snapshots++;return snap();},
    jupiter:{assertFresh:()=>{}} as any,rpc:{} as any,priority:async()=>0n,persist:async()=>{},configuredPriorityCap:1000n});
  await assert.rejects(guard.beforeBuild(req(),quote()),/STOP_REQUESTED/);assert.equal(snapshots,0);
});

test('old micro ledger migration preserves pending signature, halts and baseline',()=>{
  const original=state();original.pending={side:'BUY',at:1,signature:'do-not-retry'};original.halted='RECONCILE';
  const {profile,...legacy}=original;
  const migrated=MicroStateSchema.parse({...legacy,version:1});
  assert.equal(migrated.version,2);assert.equal(migrated.profile.initialBudgetUsd,5);
  assert.deepEqual(migrated.pending,original.pending);assert.equal(migrated.halted,'RECONCILE');
});
test('readiness shows funding and account rent blockers without inventing a live quote',()=>{
  const missing=readiness(snap({native:100_000_000n,ataExists:false,ataRent:2_000_000n}));
  assert.equal(missing.liveReady,false);assert.ok(missing.blockers.includes('ATA_RENT_EXCEEDS_FEE_CAP'));
  const funded=readiness(snap({native:100_000_000n}));assert.equal(funded.status,'QUOTE_REQUIRED');
  assert.equal(funded.feeCapUsd,.03);assert.equal(funded.killEquityUsd,7);
});

test('a stop during asynchronous Phantom approval is rechecked before durable signing or broadcast',async()=>{
  const f=fixture();let stopped=false,sends=0,persisted=0,signs=0;
  const guard={beforeBuild:async()=>({priorityFeeCapLamports:1000}),beforeSign:async()=>{},
    beforeSend:async()=>{if(stopped)throw new MicroReject('STOP_REQUESTED');},onSigned:async()=>{persisted++;}};
  const signer={publicKey:owner,signTransaction:async(tx:VersionedTransaction)=>{signs++;tx.sign([wallet]);stopped=true;return tx;}};
  const jupiter={quote:async()=>quote(),assertFresh:()=>{},buildSwap:async()=>({
    swapTransaction:Buffer.from(f.tx.serialize()).toString('base64'),lastValidBlockHeight:1,prioritizationFeeLamports:1000})};
  const executor=new LiveExecutor({cfg:{execution:{preSimulate:false,maxPriceImpactPct:1}},rpc:{},jupiter,logger:log,owner,guard} as any,
    signer,{sendAndConfirm:async()=>{sends++;throw new Error('must not send');}} as any);
  await assert.rejects(executor.swap(req()),/STOP_REQUESTED/);
  assert.equal(signs,1);assert.equal(sends,0);assert.equal(persisted,0);
});

test('a stop during durable signature persistence cannot enter the broadcaster',async()=>{
  const f=fixture();let stopped=false,sends=0;
  const guard={beforeBuild:async()=>({priorityFeeCapLamports:1000}),beforeSign:async()=>{},beforeSend:async()=>{},
    onSigned:async()=>{stopped=true;},assertActive:()=>{if(stopped)throw new MicroReject('STOP_REQUESTED');}};
  const jupiter={quote:async()=>quote(),assertFresh:()=>{},buildSwap:async()=>({
    swapTransaction:Buffer.from(f.tx.serialize()).toString('base64'),lastValidBlockHeight:1,prioritizationFeeLamports:1000})};
  const executor=new LiveExecutor({cfg:{execution:{preSimulate:false,maxPriceImpactPct:1}},rpc:{},jupiter,logger:log,owner,guard} as any,
    wallet,{sendAndConfirm:async()=>{sends++;throw new Error('must not send');}} as any);
  await assert.rejects(executor.swap(req()),/STOP_REQUESTED/);assert.equal(sends,0);
});

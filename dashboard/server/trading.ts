import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseEnv } from 'dotenv';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../../src/config/schema';
import { ConnectionManager } from '../../src/rpc/connection-manager';
import { DataRuntime } from '../../src/data/core/data-runtime';
import { DexScreenerClient } from '../../src/data/dexscreener';
import { Logger } from '../../src/utils/logger';
import { acquireProcessLock, atomicWriteFile } from '../../src/utils/fs';
import { JupiterClient } from '../../src/execution/jupiter-client';
import { LiveExecutor } from '../../src/execution/live-executor';
import { TransactionSender } from '../../src/execution/tx-sender';
import { SigningBroker } from '../../src/phantom/signing-broker';
import { SessionEngine } from '../../src/micro/session-engine';
import { MicroMarket } from '../../src/micro/market';
import { MicroGuard } from '../../src/micro/guard';
import { MICRO, MicroReject, MicroStateSchema, createProfile, killThreshold, type MicroState } from '../../src/micro/policy';
import type { TransactionSigner } from '../../src/execution/transaction-signer';
import { SigningError } from '../../src/execution/transaction-signer';

// This allowlist never reads a local private key or switches the main engine's .env mode.
export async function tradingEnvironment(repo:string):Promise<NodeJS.ProcessEnv> {
  const keys=['RPC_ENDPOINTS','RPC_MAX_RPS','RPC_TIMEOUT_MS','JUPITER_API_KEY','JUPITER_API_BASE','JUPITER_MAX_RPS','MAX_PRIORITY_FEE_LAMPORTS'];
  const env:NodeJS.ProcessEnv={};
  try {
    const lines=createInterface({input:createReadStream(path.join(repo,'.env')),crlfDelay:Infinity});
    for await(const line of lines) {
      const key=/^\s*([A-Z_]+)\s*=/.exec(line)?.[1];
      if(key&&keys.includes(key))Object.assign(env,parseEnv(line));
    }
  } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const key of keys)if(process.env[key])env[key]=process.env[key];
  return {...env,SIMULATION_MODE:'true',PRE_SIMULATE_TX:'true',CLOSE_EMPTY_TOKEN_ACCOUNTS:'false',DEFAULT_SLIPPAGE_BPS:String(MICRO.slippageBps)};
}
interface EngineHandle {engine:SessionEngine;close:()=>Promise<void>}
export type EngineFactory=(signer:TransactionSigner,authorized:()=>boolean,cancel:()=>void)=>Promise<EngineHandle>;
export function engineFactory(repo:string):EngineFactory {
  return async(signer,authorized,cancel)=>{
    const env=await tradingEnvironment(repo);
    if(!env.RPC_ENDPOINTS)throw new MicroReject('RPC_NOT_CONFIGURED');
    if(!env.JUPITER_API_KEY)throw new MicroReject('JUPITER_API_KEY_REQUIRED');
    const cfg=loadConfig(env,'PHANTOM');
    const logger=new Logger('PhantomMicro');
    const rpc=new ConnectionManager(cfg.rpc.endpoints,{...cfg.rpc,logger});
    const data=new DataRuntime(logger,cfg.data),jupiter=new JupiterClient(cfg.jupiter,logger,data);
    const owner=new PublicKey(signer.publicKey.toBase58());
    const market=new MicroMarket(rpc,new DexScreenerClient(logger,data),owner);
    const dir=path.join(repo,'data-micro');await fs.mkdir(dir,{recursive:true});
    if((await fs.readdir(dir)).some(name=>name!=='micro-LIVE.lock'&&name.startsWith('micro-')&&name.endsWith('-LIVE.lock')))
      throw new MicroReject('LEGACY_INSTANCE_LOCK');
    // The ledger filename is shared across owners: its lock must have the same scope.
    const lockPath=path.join(dir,'micro-LIVE.lock');
    const lock=await acquireProcessLock(lockPath).catch(()=>{throw new MicroReject('INSTANCE_LOCK');});
    try {
      const statePath=path.join(dir,'micro-LIVE.json');
      let state:MicroState|undefined;
      try {state=MicroStateSchema.parse(JSON.parse(await fs.readFile(statePath,'utf8')));}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new MicroReject('STATE_INVALID');}
      const persist=async(value:MicroState)=>{await atomicWriteFile(statePath,JSON.stringify(MicroStateSchema.parse(value),null,2)+'\n');};
      let mainnet=false;
      const snapshot=async()=>{
        if(!mainnet) {
          if(await rpc.execute('micro:genesis',c=>c.getGenesisHash())!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw new MicroReject('MAINNET_REQUIRED');
          mainnet=true;
        }
        return market.snapshot();
      };
      const engine=new SessionEngine({address:owner.toBase58(),state,snapshot,persist,authorized,cancelSignature:cancel,
        execute:async(request,ledger,stopped)=>{
          const guard=new MicroGuard({rpc,jupiter,owner,state:ledger,snapshot,priority:max=>market.priorityCap(max),
            persist:()=>persist(ledger),configuredPriorityCap:BigInt(cfg.jupiter.maxPriorityFeeLamports),stopped});
          const executor=new LiveExecutor({cfg:{...cfg,mode:'LIVE',simulation:false},rpc,jupiter,logger,owner,guard},signer,
            new TransactionSender(rpc,logger,{confirmTimeoutMs:cfg.execution.confirmTimeoutMs,pollIntervalMs:1500,rebroadcastIntervalMs:2000}));
          const fill=await executor.swap(request);
          return {fill,solUsd:guard.lastSolUsd,drag:guard.lastDrag+
            (fill.feeLamports>guard.lastFee?fill.feeLamports-guard.lastFee:0n)+(fill.rentLamports>guard.lastRent?fill.rentLamports-guard.lastRent:0n)};
        }});
      return {engine,close:async()=>{engine.stop();await engine.settled();await data.flush();await lock.close();await fs.unlink(lockPath);}};
    } catch(error){await lock.close();await fs.unlink(lockPath);throw error;}
  };
}

export class TradingService {
  readonly broker=new SigningBroker({sessionTtlMs:900_000});
  private capability=randomBytes(32).toString('base64url');
  private handle:EngineHandle|null=null;
  private heartbeat=0;
  private changing=false;
  private closed=false;
  private transition:Promise<void>|null=null;
  private draining:Promise<void>|null=null;
  private nextScan=0;
  private timer:ReturnType<typeof setInterval>;
  constructor(private readonly factory:EngineFactory) {
    this.timer=setInterval(()=>{
      if(this.changing||this.closed)return;
      if(!this.authorized())this.handle?.engine.stop();
      if(this.handle&&Date.now()>=this.nextScan){this.nextScan=Date.now()+MICRO.scanMs;void this.handle.engine.pulse();}
    },1000);
    this.timer.unref();
  }
  private authorized=()=>this.broker.connection().connected&&Date.now()-this.heartbeat<12_000;
  close():Promise<void> {
    if(this.draining)return this.draining;
    this.closed=true;this.changing=true;clearInterval(this.timer);this.broker.cancel();
    const previous=this.handle;this.handle=null;
    this.draining=(async()=>{
      try {await previous?.close();}
      finally {await this.transition?.catch(()=>{});}
    })();
    return this.draining;
  }
  private json(res:ServerResponse,status:number,value:unknown){if(!res.destroyed)res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));}
  private validCapability(value:unknown):boolean {
    if(typeof value!=='string')return false;
    const expected=Buffer.from(this.capability),actual=Buffer.from(value);
    return actual.length===expected.length&&timingSafeEqual(expected,actual);
  }
  private view(sessionId?:string) {
    let session=null,pending=null;
    if(sessionId){const s=this.broker.status(sessionId);session={address:s.address,expiresAt:s.expiresAt};
      const p=this.broker.pending(sessionId);if(p)pending={id:p.requestId,transactionBase64:p.transactionBase64,expiresAt:p.expiresAt};}
    const e=this.handle?.engine,report=e?.report,profile=e?.profile??createProfile(),state=e?.state;
    const blockers=[...(report?.blockers??[])];
    if(!session)blockers.unshift('CONNECT_PHANTOM');
    if(session&&!report)blockers.push('WALLET_CHECK_PENDING');
    const status=state?.halted?'HALTED':!session?'WAITING_FOR_WALLET':pending?'SIGNATURE_REQUIRED':
      e?.active?(blockers.length?'WAITING_FOR_GATES':'SCANNING'):'DISARMED';
    return {status,mode:e?.active?'LIVE':'SIMULATION',active:!!e?.active,session,pending,blockers,report:report??null,
      profile:{budgetUsd:profile.initialBudgetUsd,tradeUsd:profile.requestedTradeUsd,reserveSol:Number(MICRO.reserveLamports)/1e9,
        feeCapPct:Number(MICRO.feeBps)/100,killUsd:killThreshold(state??profile)},
      message:e?.message??null,ledger:state?{equityUsd:state.equityUsd,closedTrades:state.closedTrades,realizedNetUsd:state.realizedNetUsd,
        feesUsd:state.feesUsd,openPosition:!!state.lot,pendingSignature:state.pending?.signature??null,cloudReady:state.cloudReady,fills:state.fills.slice(-20)}:null};
  }
  async handleRequest(req:IncomingMessage,res:ServerResponse):Promise<boolean> {
    const url=new URL(req.url??'/','http://localhost');
    if(!url.pathname.startsWith('/api/trading'))return false;
    try {
      if(this.closed)throw new MicroReject('SERVICE_CLOSED');
      const origin=`http://${req.headers.host}`;
      if(req.headers.origin&&req.headers.origin!==origin)throw new MicroReject('LOCAL_ORIGIN_REQUIRED');
      if(req.headers['sec-fetch-site']&& !['same-origin','none'].includes(String(req.headers['sec-fetch-site'])))throw new MicroReject('LOCAL_ORIGIN_REQUIRED');
      if(req.method==='GET'&&url.pathname==='/api/trading/bootstrap') {this.json(res,200,{capability:this.capability});return true;}
      const supplied=req.headers['x-local-capability'];
      if(req.method==='GET'&&url.pathname==='/api/trading') {
        const sid=req.headers['x-wallet-session'];
        if(sid&&(!this.validCapability(supplied)||typeof sid!=='string'))throw new MicroReject('CAPABILITY_REQUIRED');
        if(typeof sid==='string'){
          if(!this.authorized())this.handle?.engine.stop();
          this.broker.heartbeat(sid);this.heartbeat=Date.now();
        }
        this.json(res,200,this.view(typeof sid==='string'?sid:undefined));return true;
      }
      if(req.method!=='POST'){this.json(res,405,{message:'METHOD_NOT_ALLOWED'});return true;}
      if(req.headers.origin!==origin||!this.validCapability(supplied))throw new MicroReject('CAPABILITY_REQUIRED');
      if(!String(req.headers['content-type']).startsWith('application/json'))throw new MicroReject('JSON_REQUIRED');
      let text='',size=0;
      for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>8192)throw new MicroReject('BODY_TOO_LARGE');text+=chunk;}
      const body=JSON.parse(text) as Record<string,unknown>;
      if(!body||typeof body!=='object'||Array.isArray(body))throw new MicroReject('INVALID_BODY');
      const action=url.pathname.slice('/api/trading/'.length);
      if(action==='connect') {
        if(this.changing)throw new MicroReject('SESSION_BUSY');
        if(typeof body.address!=='string')throw new MicroReject('INVALID_ADDRESS');
        this.changing=true;
        const address=body.address;
        const transition=(async()=>{
          const previous=this.handle;this.handle=null;
          previous?.engine.stop();await previous?.close();
          if(this.closed)throw new MicroReject('SERVICE_CLOSED');
          const session=this.broker.connect(address);this.heartbeat=Date.now();
          try {
            const next=await this.factory(this.broker.signer(session.sessionId),this.authorized,()=>this.broker.cancel());
            if(this.closed){await next.close();throw new MicroReject('SERVICE_CLOSED');}
            this.handle=next;
          } catch(error){try{this.broker.disconnect(session.sessionId);}catch{}throw error;}
          this.nextScan=0;this.json(res,200,session);
        })();
        this.transition=transition;
        try {await transition;}
        finally {this.transition=null;if(!this.closed)this.changing=false;}
        return true;
      }
      if(this.changing)throw new MicroReject('SESSION_BUSY');
      if(typeof body.sessionId!=='string')throw new MicroReject('SESSION_REQUIRED');
      this.broker.status(body.sessionId);
      if(!this.authorized())this.handle?.engine.stop();
      this.heartbeat=Date.now();
      if(action==='arm') {this.handle?.engine.arm();this.nextScan=0;}
      else if(action==='stop')this.handle?.engine.stop();
      else if(action==='disconnect'){this.handle?.engine.stop();this.broker.disconnect(body.sessionId);}
      else if(action==='signed'||action==='reject') {
        if(typeof body.requestId!=='string')throw new MicroReject('REQUEST_REQUIRED');
        if(action==='reject'){this.broker.reject(body.sessionId,body.requestId);this.handle?.engine.stop();}
        else {if(typeof body.transactionBase64!=='string')throw new MicroReject('SIGNATURE_REQUIRED');
          this.broker.resolve(body.sessionId,body.requestId,body.transactionBase64);}
      } else {this.json(res,404,{message:'NOT_FOUND'});return true;}
      this.json(res,200,{ok:true});
    } catch(error) {
      const code=error instanceof MicroReject||error instanceof SigningError?error.code:'TRADING_REQUEST_FAILED';
      this.json(res,code.includes('CAPABILITY')||code.includes('ORIGIN')?403:400,{message:code});
    }
    return true;
  }
}

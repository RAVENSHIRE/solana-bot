import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { PublicKey } from '@solana/web3.js';
import { ConnectionManager } from '../../src/rpc/connection-manager';
import { DexScreenerClient } from '../../src/data/dexscreener';
import { DataRuntime } from '../../src/data/core/data-runtime';
import { WalletMonitor, type WalletBalance } from '../../src/data/wallet-monitor';
import { Logger } from '../../src/utils/logger';

export async function createWalletReader(repo:string) {
  // Read only the two settings needed by this public-account monitor. Never parse wallet secrets.
  const env:Record<string,string|undefined>={};
  try {
    const lines=createInterface({input:createReadStream(path.join(repo,'.env')),crlfDelay:Infinity});
    for await(const line of lines) {
      if(/^\s*(?:RPC_ENDPOINTS|WALLET_PUBLIC_KEY)\s*=/.test(line))Object.assign(env,parseEnv(line));
    }
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const key of ['RPC_ENDPOINTS','WALLET_PUBLIC_KEY'])if(process.env[key])env[key]=process.env[key];
  const local=JSON.parse(await readFile(path.join(repo,'data','wallet-monitor.json'),'utf8').catch(error=>{
    if(error.code==='ENOENT')return '{}';throw error;
  })) as {address?:unknown;plannedStartUsd?:unknown};
  const configured=local.address??env.WALLET_PUBLIC_KEY??null;
  const address=typeof configured==='string'&&configured.trim()?new PublicKey(configured.trim()).toBase58():null;
  const planned=local.plannedStartUsd??null;
  if(planned!==null&&(typeof planned!=='number'||!Number.isFinite(planned)||planned<=0))throw new Error('Invalid planned start budget');
  const endpoints=(env.RPC_ENDPOINTS??'').split(',').map(v=>v.trim()).filter(Boolean);
  const logger=new Logger('WalletMonitor');
  const monitor=endpoints.length?new WalletMonitor(new ConnectionManager(endpoints,{commitment:'confirmed',maxRps:4,timeoutMs:10000,logger}),new DexScreenerClient(logger,new DataRuntime(logger))):null;
  const cache=new Map<string,{at:number,value:WalletBalance}>();
  const pending=new Map<string,Promise<WalletBalance>>();
  return {address,plannedStartUsd:planned as number|null,read:async(selected:string|null)=>{
    const requested=selected??address;
    if(!requested)return {balance:null,configuredAddress:address,plannedStartUsd:planned,message:'Connect Phantom to select a Solana address.'};
    try {if(new PublicKey(requested).toBase58()!==requested)throw new Error();}
    catch {throw new Error('INVALID_ADDRESS');}
    if(!monitor)throw new Error('RPC_NOT_CONFIGURED');
    const cached=cache.get(requested);
    let balance:WalletBalance;
    if(cached&&Date.now()-cached.at<10000)balance=cached.value;
    else {
      let work=pending.get(requested);
      if(!work) {
        if(pending.size>=4)throw new Error('WALLET_READER_BUSY');
        work=monitor.read(requested).then(value=>{
          cache.delete(requested);cache.set(requested,{at:Date.now(),value});
          while(cache.size>8)cache.delete(cache.keys().next().value!);
          return value;
        }).finally(()=>pending.delete(requested));
        pending.set(requested,work);
      }
      balance=await work;
    }
    return {balance,configuredAddress:address,plannedStartUsd:planned,message:null};
  }};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';
import { TradingService, tradingEnvironment, engineFactory } from '../server/trading';
import { SessionEngine } from '../../src/micro/session-engine';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('trading API requires same-origin capability and session; status never exposes private signing requests',async(t)=>{
  let executions=0;
  const trading=new TradingService(async(signer,authorized,cancelSignature)=>({engine:new SessionEngine({address:signer.publicKey.toBase58(),
    snapshot:async()=>{throw new Error('synthetic RPC unavailable');},persist:async()=>{},authorized,cancelSignature,
    execute:async()=>{executions++;throw new Error('must not run');}}),close:async()=>{}}));
  const server=http.createServer((req,res)=>{void trading.handleRequest(req,res);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const post=(action:string,body:object,extra:Record<string,string>={})=>fetch(`${base}/api/trading/${action}`,{method:'POST',
    headers:{'Content-Type':'application/json',Origin:base,...extra},body:JSON.stringify(body)});
  try {
    const address=Keypair.fromSeed(new Uint8Array(32).fill(64)).publicKey.toBase58();
    assert.equal((await post('connect',{address})).status,403);
    const {capability}=await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const headers={'X-Local-Capability':capability};
    assert.equal((await post('connect',{address},{...headers,Origin:'https://evil.example'})).status,403);
    const response=await post('connect',{address},headers);assert.equal(response.status,200);const s=await response.json();
    assert.equal((await post('arm',{sessionId:'wrong'},headers)).status,400);
    const publicStatus=await (await fetch(`${base}/api/trading`)).json();assert.equal(publicStatus.session,null);assert.equal(publicStatus.pending,null);
    assert.equal((await fetch(`${base}/api/trading`,{headers:{'X-Wallet-Session':s.sessionId}})).status,403);
    const own=await (await fetch(`${base}/api/trading`,{headers:{...headers,'X-Wallet-Session':s.sessionId}})).json();
    assert.equal(own.active,false);assert.equal(own.session.address,address);assert.equal(own.profile.budgetUsd,10);
    assert.equal((await post('arm',{sessionId:s.sessionId},headers)).status,200);
    const realNow=Date.now;
    const clock=t.mock.method(Date,'now',()=>realNow()+13000);
    const resumed=await (await fetch(`${base}/api/trading`,{headers:{...headers,'X-Wallet-Session':s.sessionId}})).json();
    assert.equal(resumed.active,false,'a late heartbeat must disarm, never resume execution');
    clock.mock.restore();
    assert.equal((await post('stop',{sessionId:s.sessionId},headers)).status,200);
    assert.equal(executions,0);
    assert.equal((await post('disconnect',{sessionId:s.sessionId},headers)).status,200);
    assert.equal((await post('arm',{sessionId:s.sessionId},headers)).status,400);
  }finally{await trading.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('Phantom service selects provider settings without loading the local private key',async()=>{
  const dir=await fs.mkdtemp(path.join(process.cwd(),'.trading-test-'));
  try {
    await fs.writeFile(path.join(dir,'.env'),'RPC_ENDPOINTS=https://fixture.invalid\nJUPITER_API_KEY=fixture-key\nWALLET_PRIVATE_KEY=never-load-this-test-value\nSIMULATION_MODE=false\n');
    const env=await tradingEnvironment(dir);assert.equal(env.WALLET_PRIVATE_KEY,undefined);assert.equal(env.SIMULATION_MODE,'true');
    assert.ok(env.RPC_ENDPOINTS);assert.ok(env.JUPITER_API_KEY);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the shared LIVE ledger has one lock across wallets and refuses legacy instance locks',async()=>{
  const dir=await fs.mkdtemp(path.join(process.cwd(),'.trading-test-'));
  const signer=(seed:number)=>({publicKey:Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey,signTransaction:async()=>{throw new Error('Never sign in this test');}});
  const factory=engineFactory(dir);let first:Awaited<ReturnType<typeof factory>>|undefined;
  try {
    await fs.writeFile(path.join(dir,'.env'),'RPC_ENDPOINTS=https://fixture.invalid\nJUPITER_API_KEY=fixture-key\n');
    first=await factory(signer(62),()=>false,()=>{});
    await assert.rejects(factory(signer(63),()=>false,()=>{}),/INSTANCE_LOCK/);
    await first.close();first=undefined;
    const second=await factory(signer(63),()=>false,()=>{});await second.close();
    await fs.writeFile(path.join(dir,'data-micro',`micro-${signer(62).publicKey.toBase58()}-LIVE.lock`),'fixture-old-instance');
    await assert.rejects(factory(signer(63),()=>false,()=>{}),/LEGACY_INSTANCE_LOCK/);
  }finally{await first?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a lock left by a crashed process is recovered; a live or unreadable owner still blocks',async()=>{
  const dir=await fs.mkdtemp(path.join(process.cwd(),'.trading-test-'));
  const signer={publicKey:Keypair.fromSeed(new Uint8Array(32).fill(65)).publicKey,signTransaction:async()=>{throw new Error('Never sign in this test');}};
  const factory=engineFactory(dir),lockPath=path.join(dir,'data-micro','micro-LIVE.lock');
  try {
    await fs.writeFile(path.join(dir,'.env'),'RPC_ENDPOINTS=https://fixture.invalid\nJUPITER_API_KEY=fixture-key\n');
    await fs.mkdir(path.dirname(lockPath));
    const child=spawn(process.execPath,['-e','']);await new Promise(r=>child.once('exit',r));
    await fs.writeFile(lockPath,String(child.pid));
    const recovered=await factory(signer,()=>false,()=>{});
    assert.equal(await fs.readFile(lockPath,'utf8'),String(process.pid));
    await recovered.close();
    const sleeper=spawn(process.execPath,['-e','setTimeout(()=>{},60000)']);
    try {
      await fs.writeFile(lockPath,String(sleeper.pid));
      await assert.rejects(factory(signer,()=>false,()=>{}),/INSTANCE_LOCK/);
    } finally {sleeper.kill();}
    await fs.writeFile(lockPath,'');
    await assert.rejects(factory(signer,()=>false,()=>{}),/INSTANCE_LOCK/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('wallet replacement cannot restart an old scan and shutdown drains a delayed new factory',async()=>{
  let oldScans=0,calls=0,newCloses=0;
  let oldClosing!:()=>void,releaseOld!:()=>void,newStarting!:()=>void,releaseNew!:()=>void;
  const oldStarted=new Promise<void>(r=>oldClosing=r),newStarted=new Promise<void>(r=>newStarting=r);
  const oldDone=new Promise<void>(r=>releaseOld=r),newDone=new Promise<void>(r=>releaseNew=r);
  const service=new TradingService(async(signer,authorized,cancelSignature)=>{
    const index=++calls;
    if(index===2){newStarting();await newDone;}
    const engine=new SessionEngine({address:signer.publicKey.toBase58(),authorized,cancelSignature,persist:async()=>{},
      snapshot:async()=>{if(index===1)oldScans++;throw new Error('Synthetic no RPC');},execute:async()=>{throw new Error('Never execute');}});
    return {engine,close:async()=>{engine.stop();if(index===1){oldClosing();await oldDone;}else newCloses++;}};
  });
  const server=http.createServer((req,res)=>{void service.handleRequest(req,res);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const {capability}=await (await fetch(`${base}/api/trading/bootstrap`)).json();
    const connect=()=>fetch(`${base}/api/trading/connect`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Local-Capability':capability},
      body:JSON.stringify({address:Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey.toBase58()})});
    assert.equal((await connect()).status,200);
    const replacement=connect();await oldStarted;
    const before=oldScans;await new Promise(r=>setTimeout(r,1150));assert.equal(oldScans,before);assert.equal(calls,1);
    releaseOld();await newStarted;
    const shutdown=service.close();releaseNew();await shutdown;
    assert.equal((await replacement).status,400);assert.equal(newCloses,1);
    assert.equal((await connect()).status,400);
  }finally{releaseOld();releaseNew();await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

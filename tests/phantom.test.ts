import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SigningBroker } from '../src/phantom/signing-broker';
import { signTransactionChecked, validateSignedTransaction } from '../src/execution/transaction-signer';
import { SessionEngine } from '../src/micro/session-engine';
import { type MicroState, type Snapshot } from '../src/micro/policy';
import { SwapError, type SwapFill } from '../src/execution/executor';
import { USDC_MINT } from '../src/core/types';
import { loadConfig } from '../src/config/schema';

// Synthetic keys and transactions, never connected to RPC or broadcast.
const key=Keypair.fromSeed(new Uint8Array(32).fill(92));
const unsigned=()=>new VersionedTransaction(new TransactionMessage({payerKey:key.publicKey,
  recentBlockhash:SystemProgram.programId.toBase58(),instructions:[]}).compileToV0Message());
test('broker accepts a genuine owner signature once and preserves the authorized message',async()=>{
  const broker=new SigningBroker(),session=broker.connect(key.publicKey.toBase58()),tx=unsigned();
  const work=signTransactionChecked(broker.signer(session.sessionId),tx,{expiresAt:Date.now()+10000});
  const pending=broker.pending(session.sessionId)!;assert.ok(pending);
  const signed=VersionedTransaction.deserialize(Buffer.from(pending.transactionBase64,'base64'));signed.sign([key]);
  broker.resolve(session.sessionId,pending.requestId,Buffer.from(signed.serialize()).toString('base64'));
  const result=await work;validateSignedTransaction(result,tx.message.serialize(),key.publicKey);
  assert.throws(()=>broker.resolve(session.sessionId,pending.requestId,Buffer.from(signed.serialize()).toString('base64')),/REQUEST_MISMATCH/);
  assert.ok(tx.signatures[0]!.every(v=>v===0));
});
test('broker rejects tampered messages and invalid signatures',async()=>{
  for(const mutate of [false,true]) {
    const broker=new SigningBroker(),s=broker.connect(key.publicKey.toBase58()),tx=unsigned();
    const work=broker.signer(s.sessionId).signTransaction(tx,{expiresAt:Date.now()+10000});
    const rejection=assert.rejects(work,/SIGNED_MESSAGE_CHANGED|INVALID_WALLET_SIGNATURE/);
    if(mutate){tx.message.recentBlockhash=key.publicKey.toBase58();tx.sign([key]);}
    assert.throws(()=>broker.resolve(s.sessionId,broker.pending(s.sessionId)!.requestId,Buffer.from(tx.serialize()).toString('base64')),/SIGNED_MESSAGE_CHANGED|INVALID_WALLET_SIGNATURE/);
    await rejection;
  }
});
test('disconnect, session replacement and expiry cancel pending signing; second request is blocked',async()=>{
  let now=Date.now();const broker=new SigningBroker({now:()=>now,sessionTtlMs:1000});
  const s=broker.connect(key.publicKey.toBase58());
  const work=broker.signer(s.sessionId).signTransaction(unsigned(),{expiresAt:now+10000});
  const rejected=assert.rejects(work,/SESSION_EXPIRED/);
  await assert.rejects(broker.signer(s.sessionId).signTransaction(unsigned(),{expiresAt:now+10000}),/ALREADY_PENDING/);
  now+=1001;assert.equal(broker.connection().connected,false);await rejected;
  const next=broker.connect(key.publicKey.toBase58());
  const waiting=broker.signer(next.sessionId).signTransaction(unsigned(),{expiresAt:now+10000});
  const cancelled=assert.rejects(waiting,/DISCONNECTED/);broker.disconnect(next.sessionId);await cancelled;
  assert.throws(()=>broker.signer(next.sessionId),/SESSION_MISMATCH/);
});
test('wallet deadline expiry after approval cannot produce a usable signature',async()=>{
  await assert.rejects(signTransactionChecked(key,unsigned(),{expiresAt:Date.now()-1}),/DEADLINE/);
  const tx=await signTransactionChecked(key,unsigned(),{expiresAt:Date.now()+1000});
  assert.ok(tx.signatures[0]!.some(v=>v!==0));
});
test('Phantom configuration needs no local private key and local signer still does',()=>{
  const env={RPC_ENDPOINTS:'https://rpc.example.invalid',JUPITER_API_KEY:'synthetic-test-key'};
  assert.equal(loadConfig(env,'PHANTOM').simulation,true);
  assert.throws(()=>loadConfig(env),/WALLET_PRIVATE_KEY/);
});
const snapshot=(native=100_000_000n,usdc=0n):Snapshot=>({native,usdc,ataExists:true,ataRent:0n,tempRent:4_000_000n,
  solUsd:100,usdcUsd:1,receivedAt:Date.now(),at:Date.now()});
const fill=():SwapFill=>({side:'BUY',mint:USDC_MINT,simulated:false,signature:'synthetic-signature',
  inAmountRaw:20_000_000n,outAmountRaw:2_000_000n,quotedOutRaw:2_001_000n,minOutRaw:2_000_000n,
  solDeltaLamports:-20_006_000n,feeLamports:6000n,rentLamports:0n,priceImpactPct:0,realizedSlippageBps:5,route:'fixture',latencyMs:1});
test('session waits for funding without latching a loss; disarmed session never executes',async()=>{
  let native=5_000_000n,calls=0,saved:MicroState|undefined;
  const engine=new SessionEngine({address:key.publicKey.toBase58(),snapshot:async()=>snapshot(native),
    persist:async s=>{saved=structuredClone(s);},authorized:()=>true,cancelSignature:()=>{},execute:async()=>{calls++;return {fill:fill(),drag:16000n,solUsd:100};}});
  await engine.pulse();assert.equal(calls,0);assert.equal(saved,undefined);
  engine.arm();await engine.pulse();assert.equal(calls,0);assert.equal(engine.state,undefined);
  native=100_000_000n;await engine.pulse();assert.equal(calls,1);assert.equal(engine.state?.baselineUsd,10);
  assert.equal(engine.state?.expectedUsdc,'2000000');assert.equal(engine.state?.pending,null);
  engine.stop();assert.equal(engine.active,false);
});
test('one scan owns unresolved async work and a stop prevents another task from entering',async()=>{
  let release!:(value:{fill:SwapFill;drag:bigint;solUsd:number})=>void,calls=0;
  const engine=new SessionEngine({address:key.publicKey.toBase58(),snapshot:async()=>snapshot(),persist:async()=>{},
    authorized:()=>true,cancelSignature:()=>{},execute:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  engine.arm();const first=engine.pulse();assert.equal(first,engine.pulse());
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  engine.stop();assert.throws(()=>engine.arm(),/SCAN_IN_PROGRESS/);assert.equal(first,engine.pulse());
  release({fill:fill(),drag:16000n,solUsd:100});await first;
  assert.equal(calls,1);assert.equal(engine.state?.fills.length,1);assert.equal(engine.active,false);
});
test('quote outages do not write down holdings and unknown send outcomes cannot retry',async()=>{
  for(const unknown of [false,true]) {
    let calls=0;
    const engine=new SessionEngine({address:key.publicKey.toBase58(),snapshot:async()=>snapshot(),persist:async()=>{},
      authorized:()=>true,cancelSignature:()=>{},execute:async()=>{calls++;throw new SwapError('fixture',unknown?'unknown':'quote',0n,unknown?'unknown-signature':null);}});
    engine.arm();await engine.pulse();assert.equal(engine.state?.expectedNative,'100000000');
    if(unknown){assert.equal(engine.active,false);assert.equal(engine.state?.pending?.signature,'unknown-signature');assert.throws(()=>engine.arm(),/RECONCILIATION/);}
    else {assert.equal(engine.state?.pending,null);assert.equal(engine.state?.halted,null);}
    assert.equal(calls,1);engine.stop();
  }
});
test('lost browser authorization prevents execution after a slow balance read',async()=>{
  let authorized=true,resolve!:(s:Snapshot)=>void,calls=0;
  const engine=new SessionEngine({address:key.publicKey.toBase58(),snapshot:()=>new Promise(r=>resolve=r),persist:async()=>{},
    authorized:()=>authorized,cancelSignature:()=>{},execute:async()=>{calls++;throw new Error('must not run');}});
  engine.arm();const work=engine.pulse();authorized=false;resolve(snapshot());await work;assert.equal(calls,0);assert.equal(engine.active,false);
});

test('authenticated heartbeat sustains a connected session but cannot revive an expired one',()=>{
  let now=Date.now();const broker=new SigningBroker({now:()=>now,sessionTtlMs:1000});
  const s=broker.connect(key.publicKey.toBase58());now+=900;broker.heartbeat(s.sessionId);
  now+=900;assert.equal(broker.status(s.sessionId).address,s.address);
  now+=101;assert.throws(()=>broker.heartbeat(s.sessionId),/SESSION_MISMATCH/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { WalletMonitor, decimalAmount } from '../src/data/wallet-monitor';
import { SOL_MINT, USDC_MINT, USDT_MINT } from '../src/core/types';
import { normalizeDexPairs } from '../src/data/dexscreener';

// Synthetic fixtures: never imported by runtime.
const owner=new PublicKey(new Uint8Array(32).fill(31));
const extra=new PublicKey(new Uint8Array(32).fill(32)).toBase58();
const account=(mint=USDC_MINT,amount='1000000',decimals=6,program=TOKEN_PROGRAM_ID)=>({pubkey:owner,account:{
  owner:program,lamports:2000000,executable:false,data:{program:'spl-token',parsed:{type:'account',info:{
    mint,owner:owner.toBase58(),state:'initialized',tokenAmount:{amount,decimals},
  }}}}});
// Mirrors DexScreener: SOL is quoted in USDC, while USDC itself is listed only as the base of a USDC/USDT pool.
const pair=(mint:string,price:string,symbol:string)=>({chainId:'solana',dexId:'fixture',pairAddress:mint,
  baseToken:{address:mint,symbol},quoteToken:{address:mint===SOL_MINT?USDC_MINT:mint===USDC_MINT?USDT_MINT:SOL_MINT},priceUsd:price,
  liquidity:{usd:1000000},pairCreatedAt:Date.now()-86400000,txns:{h1:{buys:1,sells:1}}});
function fixture(options:{native?:number;tokens?:ReturnType<typeof account>[];missingProgram?:boolean;badPrice?:boolean;genesis?:string}={}) {
  const rpc={execute:async(_label:string,fn:(c:any)=>Promise<unknown>)=>fn({
    getGenesisHash:async()=>options.genesis??'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getBalance:async()=>options.native??100000000,
    getParsedTokenAccountsByOwner:async(_owner:PublicKey,{programId}:{programId:PublicKey})=>{
      if(options.missingProgram&&programId.equals(TOKEN_2022_PROGRAM_ID))throw new Error('Unavailable');
      return {value:(options.tokens??[]).filter(item=>item.account.owner.equals(programId))};
    },
  })};
  const dex={getPairsForTokens:async()=>{
    if(options.badPrice)throw new Error('Price offline');
    return normalizeDexPairs([pair(SOL_MINT,'100','SOL'),pair(USDC_MINT,'.98','USDC')],Date.now());
  }};
  return new WalletMonitor(rpc as any,dex as any);
}
test('wallet monitor reads native SOL, aggregates token accounts and uses observed USDC price',async()=>{
  const r=await fixture({tokens:[account(),account(USDC_MINT,'2000000')]}).read(owner.toBase58());
  assert.equal(r.nativeSol,.1);assert.equal(r.tokens[0]?.amount,'3');
  assert.equal(r.tokens[0]?.valueUsd,2.94);assert.equal(r.totalValueUsd,12.94);assert.equal(r.tokensComplete,true);
});
test('Token-2022 amounts are included without converting missing prices into zero',async()=>{
  const r=await fixture({tokens:[account(extra,'12000',3,TOKEN_2022_PROGRAM_ID)]}).read(owner.toBase58());
  assert.equal(r.tokens[0]?.amount,'12');assert.equal(r.unpricedTokenCount,1);
  assert.equal(r.totalValueUsd,null);assert.equal(r.pricedValueUsd,10);
});
test('token RPC failure preserves native balance but never presents a complete portfolio total',async()=>{
  const r=await fixture({missingProgram:true}).read(owner.toBase58());
  assert.equal(r.nativeSol,.1);assert.equal(r.tokensComplete,false);assert.equal(r.totalValueUsd,null);
});
test('price outage leaves balances available and USD fields explicitly unavailable',async()=>{
  const r=await fixture({badPrice:true,tokens:[account()]}).read(owner.toBase58());
  assert.equal(r.nativeSol,.1);assert.equal(r.nativeUsd,null);assert.equal(r.pricedValueUsd,null);
  assert.equal(r.tokens[0]?.priceUsd,null);assert.equal(r.totalValueUsd,null);
});
test('wrong network and malformed owner are rejected before valuation',async()=>{
  await assert.rejects(fixture({genesis:'wrong-network'}).read(owner.toBase58()),/Mainnet/);
  await assert.rejects(fixture().read('invalid-address'));
});
test('zero native balance is a measured zero; exact token quantities do not lose raw precision',async()=>{
  const r=await fixture({native:0,badPrice:true}).read(owner.toBase58());assert.equal(r.nativeUsd,0);assert.equal(r.totalValueUsd,0);
  assert.equal(decimalAmount(18446744073709551615n,9),'18446744073.709551615');
  assert.equal(decimalAmount(10000000n,6),'10');assert.equal(decimalAmount(0n,6),'0');
  assert.throws(()=>decimalAmount(-1n,9));
});

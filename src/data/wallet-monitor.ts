import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { ConnectionManager } from '../rpc/connection-manager';
import { DexScreenerClient } from './dexscreener';
import { parseOwnedTokenAccount } from '../execution/token-accounts';
import { SOL_MINT } from '../core/types';
import { parse, safeInteger } from './core/data-validator';

export interface WalletToken {
  mint:string; symbol:string|null; name:string|null; amount:string; priceUsd:number|null; valueUsd:number|null;
}
export interface WalletBalance {
  address:string; network:'Solana Mainnet'; observedAt:string; nativeLamports:string; nativeSol:number;
  nativeUsd:number|null; solPriceUsd:number|null; priceObservedAt:string|null; totalValueUsd:number|null;
  pricedValueUsd:number|null; unpricedTokenCount:number; tokensComplete:boolean; tokens:WalletToken[];
}
export function decimalAmount(raw:bigint,decimals:number):string {
  if(raw<0n||!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error('Invalid token amount');
  if(!decimals)return raw.toString();
  const digits=raw.toString().padStart(decimals+1,'0');
  return `${digits.slice(0,-decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/,'')||'0';
}
/** Public-account reads only. This class has no signer or transaction sender. */
export class WalletMonitor {
  constructor(private readonly rpc:ConnectionManager,private readonly dex:DexScreenerClient) {}
  async read(address:string):Promise<WalletBalance> {
    const owner=new PublicKey(address);
    if(owner.toBase58()!==address)throw new Error('Invalid wallet address');
    const native=await this.rpc.execute('wallet-monitor:balance',async c=>{
      if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw new Error('Mainnet RPC required');
      return parse(safeInteger,await c.getBalance(owner,'confirmed'),'solana-rpc');
    });
    const result=await Promise.allSettled([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].map(programId=>
      this.rpc.execute('wallet-monitor:tokens',async c=>{
        if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw new Error('Mainnet RPC required');
        return c.getParsedTokenAccountsByOwner(owner,{programId},'confirmed');
      })));
    let complete=result.every(r=>r.status==='fulfilled');
    const amounts=new Map<string,{raw:bigint,decimals:number}>();
    for(const response of result) {
      if(response.status!=='fulfilled')continue;
      for(const item of response.value.value) {
        try {
          const account=parseOwnedTokenAccount(item,owner);
          const decimals=item.account.data.parsed.info.tokenAmount.decimals as unknown;
          if(typeof decimals!=='number'||!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error('Invalid token decimals');
          if(account.amountRaw===0n)continue;
          const existing=amounts.get(account.mint);
          if(existing&&existing.decimals!==decimals)throw new Error('Conflicting decimals');
          amounts.set(account.mint,{raw:(existing?.raw??0n)+account.amountRaw,decimals});
        } catch {complete=false;}
      }
    }
    const observedAt=new Date().toISOString();
    let prices=new Map<string,Awaited<ReturnType<DexScreenerClient['getPairsForTokens']>>[number]>();
    try {
      prices=DexScreenerClient.selectPairs(await this.dex.getPairsForTokens([...new Set([SOL_MINT,...amounts.keys()])]),Date.now(),30000).selected;
    } catch { /* Token quantities remain valid when price service is unavailable. */ }
    const priceFor=(mint:string):number|null=>{
      const value=prices.get(mint)?.priceUsd;
      return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
    };
    const solPriceUsd=priceFor(SOL_MINT),nativeSol=native/1e9;
    const nativeUsd=native===0?0:solPriceUsd===null?null:nativeSol*solPriceUsd;
    const tokens:WalletToken[]=[...amounts].map(([mint,a])=>{
      const amount=decimalAmount(a.raw,a.decimals),priceUsd=priceFor(mint),p=prices.get(mint);
      const valued=priceUsd===null?null:Number(amount)*priceUsd;
      return {mint,amount,symbol:p?.baseToken.symbol??null,name:p?.baseToken.name??null,priceUsd,
        valueUsd:valued!==null&&Number.isFinite(valued)?valued:null};
    });
    const unpricedTokenCount=tokens.filter(t=>t.valueUsd===null).length;
    const known=[nativeUsd,...tokens.map(t=>t.valueUsd)].filter((n):n is number=>n!==null);
    const pricedValueUsd=known.length?known.reduce((a,b)=>a+b,0):null;
    return {address,network:'Solana Mainnet',observedAt,nativeLamports:String(native),nativeSol,nativeUsd,solPriceUsd,
      priceObservedAt:prices.size?new Date(Math.min(...[...prices.values()].map(p=>p.meta.receivedAt))).toISOString():null,
      totalValueUsd:complete&&nativeUsd!==null&&unpricedTokenCount===0?pricedValueUsd:null,
      pricedValueUsd,unpricedTokenCount,tokensComplete:complete,tokens};
  }
}

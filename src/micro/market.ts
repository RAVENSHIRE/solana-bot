import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { ConnectionManager } from '../rpc/connection-manager';
import { DexScreenerClient } from '../data/dexscreener';
import { listTokenAccounts } from '../execution/token-accounts';
import { exactNumber, parse, safeInteger } from '../data/core/data-validator';
import { ESTIMATED_SWAP_COMPUTE_UNITS, SOL_MINT, USDC_MINT } from '../core/types';
import { MICRO, MicroReject, validPrices, type Snapshot } from './policy';

export class MicroMarket {
  constructor(readonly rpc:ConnectionManager, readonly dex:DexScreenerClient, readonly owner:PublicKey) {}
  async snapshot():Promise<Snapshot> {
    this.dex.data.cache.invalidate('dexscreener:tokens:');
    const pairs=await this.dex.getPairsForTokens([SOL_MINT,USDC_MINT]);
    const selected=DexScreenerClient.selectPairs(pairs,Date.now(),MICRO.priceMaxAgeMs).selected;
    const sol=selected.get(SOL_MINT),usdc=selected.get(USDC_MINT);
    if(!sol?.priceUsd || !usdc?.priceUsd) throw new MicroReject('USD_PRICE_MISSING');
    const prices={solUsd:sol.priceUsd,usdcUsd:usdc.priceUsd,receivedAt:Math.min(sol.meta.receivedAt,usdc.meta.receivedAt)};
    const accounts=await listTokenAccounts(this.rpc,this.owner);
    if(accounts.some(a=>a.amountRaw>0n && a.mint!==USDC_MINT)) throw new MicroReject('DEDICATED_SOL_USDC_WALLET_REQUIRED');
    const ata=getAssociatedTokenAddressSync(new PublicKey(USDC_MINT),this.owner);
    const token=accounts.find(a=>a.pubkey.equals(ata));
    if(accounts.some(a=>a.mint===USDC_MINT && a.amountRaw>0n && !a.pubkey.equals(ata))) throw new MicroReject('USDC_MUST_BE_IN_ASSOCIATED_ACCOUNT');
    if(token && (!token.programId.equals(TOKEN_PROGRAM_ID) || token.mint!==USDC_MINT)) throw new MicroReject('ATA_IDENTITY_MISMATCH');
    const native=BigInt(parse(safeInteger,await this.rpc.execute('micro:balance',c=>c.getBalance(this.owner,'confirmed')),'solana-rpc'));
    const rent=BigInt(parse(safeInteger,await this.rpc.execute('micro:rent',c=>c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)),'solana-rpc'));
    const raw=accounts.filter(a=>a.mint===USDC_MINT).reduce((sum,a)=>sum+a.amountRaw,0n);
    exactNumber(raw); validPrices(prices);
    // Budget temporary wrapping/routing account capital independently of permanent ATA fees.
    return {...prices,native,usdc:raw,ataExists:!!token,ataRent:token?0n:rent,tempRent:rent*2n,at:Date.now()};
  }
  async priorityCap(maximum:bigint):Promise<bigint> {
    if(maximum<0n) throw new MicroReject('NO_PRIORITY_FEE_BUDGET');
    const rows=await this.rpc.execute('micro:priority',c=>c.getRecentPrioritizationFees());
    const values=rows.map(r=>parse(safeInteger,r.prioritizationFee,'solana-rpc')).sort((a,b)=>a-b);
    if(!values.length) throw new MicroReject('PRIORITY_FEE_DATA_MISSING');
    const units=BigInt(ESTIMATED_SWAP_COMPUTE_UNITS);
    const n=(BigInt(values[Math.min(values.length-1,Math.floor(values.length*.75))]!)*units+999999n)/1000000n;
    return n<maximum?n:maximum;
  }
}

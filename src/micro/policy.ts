import { z } from 'zod';
import { exactNumber } from '../data/core/data-validator';
import { BASE_FEE_LAMPORTS } from '../core/types';

/** User-specified limits, not market observations. */
export const MICRO = Object.freeze({ budgetUsd: 10, tradeUsd: 2, maxTradeUsd: 3,
  minAllocation: .20, maxAllocation: .30, lossFloorRatio: .70, targetRatio: 1.20,
  reserveLamports: 3_000_000n, feeBps: 150n, killUsd: 7, targetUsd: 12,
  minimumClosedTrades: 30, priceMaxAgeMs: 15_000, scanMs: 15_000, slippageBps: 30 });
export class MicroReject extends Error {
  constructor(readonly code: string, detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'MicroReject'; }
}
export interface Prices { solUsd: number; usdcUsd: number; receivedAt: number }
export interface UnsupportedHolding { mint:string; account:string; amountRaw:string; reason:'OUTSIDE_SOL_USDC_SCOPE'|'NON_ASSOCIATED_USDC_ACCOUNT' }
export interface Snapshot extends Prices { native: bigint; usdc: bigint; ataExists: boolean; ataRent:bigint; tempRent: bigint; at: number;
  /** Excluded from scoped equity, position adoption, and all execution. No guessed valuations. */
  unsupportedHoldings?:UnsupportedHolding[] }
export const MicroProfileSchema=z.object({initialBudgetUsd:z.number().finite().positive(),
  requestedTradeUsd:z.number().finite().positive()}).strict().refine(p=>
    p.requestedTradeUsd+1e-9>=p.initialBudgetUsd*MICRO.minAllocation &&
    p.requestedTradeUsd<=p.initialBudgetUsd*MICRO.maxAllocation+1e-9,
  'Requested trade must be 20–30% of the initial budget');
export type MicroProfile=z.infer<typeof MicroProfileSchema>;
export function createProfile(budgetUsd:number=MICRO.budgetUsd,tradeUsd:number=budgetUsd*MICRO.minAllocation):MicroProfile {
  return MicroProfileSchema.parse({initialBudgetUsd:budgetUsd,requestedTradeUsd:tradeUsd});
}
export function killThreshold(reference:MicroProfile|MicroState):number {
  return ('baselineUsd' in reference?reference.baselineUsd:reference.initialBudgetUsd)*MICRO.lossFloorRatio;
}
export function profileForState(state:MicroState):MicroProfile {return state.profile;}
export function validPrices(p: Prices, now = Date.now()): void {
  if (![p.solUsd, p.usdcUsd].every(v => Number.isFinite(v) && v > 0) || !Number.isSafeInteger(p.receivedAt) ||
    now < p.receivedAt || now - p.receivedAt > MICRO.priceMaxAgeMs) throw new MicroReject('PRICE_UNAVAILABLE_OR_STALE');
}
export function equityUsd(s: Snapshot): number {
  validPrices(s, s.at);
  if (s.native < 0n || s.usdc < 0n) throw new MicroReject('INVALID_BALANCE');
  return exactNumber(s.native) / 1e9 * s.solUsd + exactNumber(s.usdc) / 1e6 * s.usdcUsd;
}
export function usdToLamports(usd: number, p: Prices): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new MicroReject('INVALID_USD_AMOUNT');
  validPrices(p);
  const n = Math.floor(usd / p.solUsd * 1e9);
  if (!Number.isSafeInteger(n) || n <= 0) throw new MicroReject('INVALID_LAMPORT_AMOUNT');
  return BigInt(n);
}
export const ceilBps = (amount: bigint, bps: bigint): bigint => {
  if (amount < 0n || bps < 0n) throw new MicroReject('NEGATIVE_COST');
  return (amount * bps + 9999n) / 10000n;
};
export function sizeUsd(equity:number,requested:number=MICRO.tradeUsd,profile:MicroProfile=createProfile()):number {
  if (!Number.isFinite(equity) || equity < killThreshold(profile)) throw new MicroReject('EQUITY_KILL');
  if (!Number.isFinite(requested) || requested+1e-9 < profile.initialBudgetUsd*MICRO.minAllocation ||
    requested > profile.initialBudgetUsd*MICRO.maxAllocation+1e-9) throw new MicroReject('TRADE_SIZE_OUT_OF_RANGE');
  // Allocation follows current scoped capital; gains do not hit an obsolete fixed $1.50 cap.
  const allocated=Math.min(equity,profile.initialBudgetUsd);
  return Math.min(allocated*MICRO.maxAllocation,Math.max(requested,allocated*MICRO.minAllocation));
}
export interface CostInput { notional: bigint; networkFee: bigint; slippage: bigint; spread: bigint; accountRent: bigint }
export function checkCosts(c: CostInput): bigint {
  if (c.notional <= 0n || [c.networkFee,c.slippage,c.spread,c.accountRent].some(v => v < 0n)) throw new MicroReject('INVALID_TCA');
  const drag = c.networkFee + c.slippage + c.spread + c.accountRent;
  // Integer cross multiplication preserves the exact 1.5% boundary.
  if (drag * 10000n > c.notional * MICRO.feeBps) throw new MicroReject('FEE_CAP', `${drag} lamports exceeds 1.5%`);
  return drag;
}
export function checkReserve(native: bigint, spend: bigint, fee: bigint, temporaryRent: bigint): void {
  if ([native,spend,fee,temporaryRent].some(v=>v<0n)) throw new MicroReject('INVALID_RESERVE_INPUT');
  if (native - spend - fee - temporaryRent < MICRO.reserveLamports) throw new MicroReject('SOL_RESERVE_FLOOR');
}

const finite = z.number().finite();
const raw = z.string().regex(/^\d+$/);
const lot = z.object({ amount:raw, costLamports:raw, notionalLamports:raw, costUsd:finite.nonnegative(), at:z.number().int(),
  notionalUsd:finite.positive(), spentDragUsd:finite.nonnegative(),
  feeBudgetLamports:raw, spentDragLamports:raw, entrySignature:z.string().nullable() }).strict();
const LegacyMicroStateSchema = z.object({ version:z.literal(1), wallet:z.string(), mode:z.enum(['SIMULATION','LIVE']),
  baselineUsd:finite.positive(), baselineAt:z.number().int(), paperNative:raw, paperUsdc:raw,paperAtaExists:z.boolean(),
  expectedNative:raw, expectedUsdc:raw, lot:lot.nullable(), pending:z.object({side:z.enum(['BUY','SELL']),at:z.number().int(),signature:z.string().nullable()}).strict().nullable(),
  halted:z.string().nullable(), externalCashFlow:z.boolean(), guardrailBreaches:z.number().int().nonnegative(),
  realizedNetUsd:finite, closedTrades:z.number().int().nonnegative(), signatures:z.array(z.string()),
  updatedAt:z.number().int(), cloudReady:z.boolean(), equityUsd:finite.nonnegative(),
  peakEquityUsd:finite.positive(),maxDrawdownPct:finite.nonnegative(),
  feesUsd:finite.nonnegative(), fills:z.array(z.object({side:z.enum(['BUY','SELL']),at:z.number().int(),
    signature:z.string().nullable(),pnlUsd:finite.nullable(),pnlPct:finite.nullable(),slippagePct:finite.nonnegative()}).strict()).max(10000),
  equity:z.array(z.object({at:z.number().int(),usd:finite.nonnegative()}).strict()).max(1000),
  prices:z.array(z.object({at:z.number().int(),solUsd:finite.positive(),usdcUsd:finite.positive()}).strict()).max(1000),
}).strict();
const CurrentMicroStateSchema=LegacyMicroStateSchema.extend({version:z.literal(2),profile:MicroProfileSchema});
// Old balances, history, pending signatures and safety latches survive migration verbatim.
// Its original baseline defines its profile; changing the process default never rebases performance.
export const MicroStateSchema=z.union([CurrentMicroStateSchema,LegacyMicroStateSchema.transform(old=>({
  ...old,version:2 as const,profile:createProfile(old.baselineUsd),
}))]);
export type MicroState = z.infer<typeof MicroStateSchema>;
export function freshState(wallet:string, mode:MicroState['mode'], s:Snapshot,profile:MicroProfile=createProfile()):MicroState {
  const equity=equityUsd(s);
  if (equity <= 0) throw new MicroReject('WALLET_EMPTY');
  return {version:2,profile:MicroProfileSchema.parse(profile),wallet,mode,baselineUsd:equity,baselineAt:s.at,paperNative:String(s.native),paperUsdc:String(s.usdc),paperAtaExists:s.ataExists,
    expectedNative:String(s.native),expectedUsdc:String(s.usdc),lot:null,pending:null,halted:null,externalCashFlow:false,
    guardrailBreaches:0,realizedNetUsd:0,closedTrades:0,signatures:[],updatedAt:s.at,cloudReady:false,equityUsd:equity,
    peakEquityUsd:equity,maxDrawdownPct:0,feesUsd:0,fills:[],equity:[],prices:[]};
}
export function observeState(state:MicroState, s:Snapshot):void {
  const equity=equityUsd(s); state.equityUsd=equity;state.updatedAt=s.at;
  state.peakEquityUsd=Math.max(state.peakEquityUsd,equity);
  state.maxDrawdownPct=Math.max(state.maxDrawdownPct,(state.peakEquityUsd-equity)/state.peakEquityUsd*100);
  if (equity < killThreshold(state)) state.halted ??= 'EQUITY_BELOW_70_PERCENT_BASELINE';
  if (s.native < MICRO.reserveLamports) state.halted ??= 'NATIVE_RESERVE_BELOW_0_003_SOL';
  if (state.pending) state.halted ??= 'UNRESOLVED_TRANSACTION';
  if (s.native !== BigInt(state.expectedNative) || s.usdc !== BigInt(state.expectedUsdc)) {
    state.externalCashFlow=true;state.halted ??= 'UNEXPLAINED_BALANCE_CHANGE';
  }
  state.cloudReady=state.mode==='LIVE' && !state.halted && !state.lot && !state.externalCashFlow &&
    state.guardrailBreaches===0 && state.closedTrades>=MICRO.minimumClosedTrades && equity>=state.baselineUsd*MICRO.targetRatio &&
    state.realizedNetUsd/state.baselineUsd > .20;
}

export interface ReadinessReport {
  status:'BLOCKED'|'QUOTE_REQUIRED'; liveReady:false; blockers:string[];
  scopedEquityUsd:number; budgetUsd:number; fundingShortfallUsd:number; tradeUsd:number|null;
  killEquityUsd:number; nativeSol:number; reserveSol:number; requiredNativeLamports:string|null;
  ataExists:boolean; ataRentLamports:string; ataRentUsd:number; feeCapUsd:number|null;
  unsupportedHoldings:UnsupportedHolding[]; quoteAndSimulationRequired:true;
}
/** Wallet-only preflight cannot honestly certify a route, signature or market edge. */
export function readiness(s:Snapshot,profile:MicroProfile=createProfile(),state?:MicroState):ReadinessReport {
  MicroProfileSchema.parse(profile);validPrices(s);
  const equity=equityUsd(s),active=state?.profile??profile,threshold=killThreshold(state??active);
  const blockers:string[]=[];let trade:number|null=null,required:bigint|null=null;
  if(equity<threshold)blockers.push('FUNDING_BELOW_KILL_THRESHOLD');
  if(s.native<MICRO.reserveLamports)blockers.push('SOL_RESERVE_FLOOR');
  if(state?.halted)blockers.push(`LIVE_HALTED:${state.halted}`);
  if(state?.pending)blockers.push('TRANSACTION_RECONCILIATION_REQUIRED');
  if(state && (s.native!==BigInt(state.expectedNative)||s.usdc!==BigInt(state.expectedUsdc)))blockers.push('UNEXPLAINED_BALANCE_CHANGE');
  try {
    trade=state?.lot?state.lot.notionalUsd:sizeUsd(equity,active.requestedTradeUsd,active);
    const input=state?.lot?0n:usdToLamports(trade,s);
    const notional=usdToLamports(trade,s),rent=state?.lot?0n:s.ataRent;
    required=input+BASE_FEE_LAMPORTS+rent+s.tempRent+MICRO.reserveLamports;
    if(s.native<required)blockers.push('INSUFFICIENT_NATIVE_FOR_TRADE_AND_RESERVE');
    try {checkCosts({notional,networkFee:BASE_FEE_LAMPORTS*(state?.lot?1n:2n),slippage:0n,spread:0n,accountRent:rent});}
    catch(error) {if(error instanceof MicroReject&&error.code==='FEE_CAP')blockers.push(rent>0n?'ATA_RENT_EXCEEDS_FEE_CAP':'MINIMUM_FEES_EXCEED_CAP');else throw error;}
  } catch(error) {
    if(error instanceof MicroReject) {if(error.code!=='EQUITY_KILL')blockers.push(error.code);}
    else throw error;
  }
  return {status:blockers.length?'BLOCKED':'QUOTE_REQUIRED',liveReady:false,blockers:[...new Set(blockers)],scopedEquityUsd:equity,
    budgetUsd:active.initialBudgetUsd,fundingShortfallUsd:Math.max(0,active.initialBudgetUsd-equity),tradeUsd:trade,
    killEquityUsd:threshold,nativeSol:exactNumber(s.native)/1e9,reserveSol:exactNumber(MICRO.reserveLamports)/1e9,
    requiredNativeLamports:required===null?null:String(required),ataExists:s.ataExists,ataRentLamports:String(s.ataRent),
    ataRentUsd:exactNumber(s.ataRent)/1e9*s.solUsd,feeCapUsd:trade===null?null:trade*Number(MICRO.feeBps)/10000,
    unsupportedHoldings:s.unsupportedHoldings??[],quoteAndSimulationRequired:true};
}

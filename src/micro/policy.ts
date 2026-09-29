import { z } from 'zod';
import { exactNumber } from '../data/core/data-validator';

/** User-specified limits, not market observations. */
export const MICRO = Object.freeze({ budgetUsd: 5, tradeUsd: 1, maxTradeUsd: 1.5,
  reserveLamports: 3_000_000n, feeBps: 150n, killUsd: 3.5, targetUsd: 6,
  minimumClosedTrades: 30, priceMaxAgeMs: 15_000, scanMs: 15_000, slippageBps: 30 });
export class MicroReject extends Error {
  constructor(readonly code: string, detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'MicroReject'; }
}
export interface Prices { solUsd: number; usdcUsd: number; receivedAt: number }
export interface Snapshot extends Prices { native: bigint; usdc: bigint; ataExists: boolean; ataRent:bigint; tempRent: bigint; at: number }
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
export function sizeUsd(equity: number, requested: number = MICRO.tradeUsd): number {
  if (!Number.isFinite(equity) || equity < MICRO.killUsd) throw new MicroReject('EQUITY_KILL');
  if (!Number.isFinite(requested) || requested < 1 || requested > MICRO.maxTradeUsd) throw new MicroReject('TRADE_SIZE_OUT_OF_RANGE');
  const size = Math.min(MICRO.maxTradeUsd, equity * .30, Math.max(requested, equity * .20));
  if (size < 1 || size + 1e-9 < equity * .20) throw new MicroReject('SIZING_UNAVAILABLE');
  return size;
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
export const MicroStateSchema = z.object({ version:z.literal(1), wallet:z.string(), mode:z.enum(['SIMULATION','LIVE']),
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
export type MicroState = z.infer<typeof MicroStateSchema>;
export function freshState(wallet:string, mode:MicroState['mode'], s:Snapshot):MicroState {
  const equity=equityUsd(s);
  if (equity <= 0) throw new MicroReject('WALLET_EMPTY');
  return {version:1,wallet,mode,baselineUsd:equity,baselineAt:s.at,paperNative:String(s.native),paperUsdc:String(s.usdc),paperAtaExists:s.ataExists,
    expectedNative:String(s.native),expectedUsdc:String(s.usdc),lot:null,pending:null,halted:null,externalCashFlow:false,
    guardrailBreaches:0,realizedNetUsd:0,closedTrades:0,signatures:[],updatedAt:s.at,cloudReady:false,equityUsd:equity,
    peakEquityUsd:equity,maxDrawdownPct:0,feesUsd:0,fills:[],equity:[],prices:[]};
}
export function observeState(state:MicroState, s:Snapshot):void {
  const equity=equityUsd(s); state.equityUsd=equity;state.updatedAt=s.at;
  state.peakEquityUsd=Math.max(state.peakEquityUsd,equity);
  state.maxDrawdownPct=Math.max(state.maxDrawdownPct,(state.peakEquityUsd-equity)/state.peakEquityUsd*100);
  if (equity < MICRO.killUsd) state.halted ??= 'EQUITY_BELOW_3_50_USD';
  if (s.native < MICRO.reserveLamports) state.halted ??= 'NATIVE_RESERVE_BELOW_0_003_SOL';
  if (state.pending) state.halted ??= 'UNRESOLVED_TRANSACTION';
  if (s.native !== BigInt(state.expectedNative) || s.usdc !== BigInt(state.expectedUsdc)) {
    state.externalCashFlow=true;state.halted ??= 'UNEXPLAINED_BALANCE_CHANGE';
  }
  state.cloudReady=state.mode==='LIVE' && !state.halted && !state.lot && !state.externalCashFlow &&
    state.guardrailBreaches===0 && state.closedTrades>=MICRO.minimumClosedTrades && equity>=MICRO.targetUsd &&
    state.realizedNetUsd/state.baselineUsd > .20;
}

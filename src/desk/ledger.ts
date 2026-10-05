import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile, setAside } from '../utils/fs';
import { exactNumber } from '../data/core/data-validator';
import type { DeskMode, DeskPosition, LedgerEntry } from './types';

const raw = z.string().regex(/^-?\d+$/);
const finite = z.number().finite();
const position = z.object({ id: z.string(), mint: z.string(), symbol: z.string().nullable(), decimals: z.number().int().min(0).max(255),
  openedAt: z.number().int(), qtyRaw: raw, costLamports: raw, costUsd: finite, entryPriceUsd: finite.nullable(), peakValueLamports: raw,
  lastValueLamports: raw.nullable(), lastPriceUsd: finite.nullable(), router: z.string(), route: z.string(), entrySignature: z.string().nullable(),
  rentLamports: raw, pairAddress: z.string(), entryLiquidityUsd: finite.nullable().optional(), creator: z.string().nullable().optional(),
  creatorPctAtEntry: finite.nullable().optional(), noRouteSince: z.number().int().nonnegative().nullable().optional(),
  insiders: z.array(z.string()).max(16).nullable().optional(), insiderPctAtEntry: finite.nullable().optional(), onCurve: z.boolean().nullable().optional(),
  insidersMeasuredAt: z.number().int().nullable().optional(), creatorMeasuredAt: z.number().int().nullable().optional(),
  adds: z.number().int().min(0).max(20).optional(), firstEntryPriceUsd: finite.nullable().optional(), peakMultiple: finite.optional(),
  stopUsd: finite.nullable().optional(), targetUsd: finite.nullable().optional() }).strict();
const entry = z.object({ id: z.string(), at: z.number().int(), mode: z.enum(['PAPER', 'LIVE']), txSignature: z.string().nullable(), mint: z.string(),
  symbol: z.string().nullable(), router: z.string(), route: z.string(), side: z.enum(['BUY', 'SELL']), quantity: z.string(), qtyRaw: raw,
  entryPriceUsd: finite.nullable(), exitPriceUsd: finite.nullable(), grossPnlUsd: finite.nullable(), networkFeeLamports: raw,
  networkFeeUsd: finite.nullable(), routerFeeUsd: finite.nullable(), totalFeesUsd: finite.nullable(), netPnlUsd: finite.nullable(),
  solDeltaLamports: raw, status: z.enum(['CONFIRMED', 'PAPER_FILLED', 'FAILED', 'UNKNOWN']), note: z.string().nullable(),
  rentOutstandingLamports: raw.optional(),
  /** A sell's exit rule ("STOP_LOSS -41.20% ≤ -35%"): the level card measures how far stops fill from their level. */
  exitReason: z.string().max(300).optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), mode: z.enum(['PAPER', 'LIVE']), wallet: z.string().nullable(), createdAt: z.number().int(),
  paperCashLamports: raw.nullable(), paperStartUsd: finite.nullable(), positions: z.array(position).max(50), entries: z.array(entry).max(10_000),
  pending: z.object({ side: z.enum(['BUY', 'SELL']), mint: z.string(), at: z.number().int(), signature: z.string().nullable() }).strict().nullable(),
  halted: z.string().nullable(), realizedPnlUsd: finite, feesUsd: finite, feesLamports: raw, updatedAt: z.number().int() }).strict();
export type LedgerState = z.infer<typeof stateSchema>;

export interface Fill {
  side: 'BUY' | 'SELL'; mint: string; symbol: string | null; decimals: number; pairAddress: string;
  inAmountRaw: bigint; outAmountRaw: bigint; solDeltaLamports: bigint; feeLamports: bigint; rentLamports: bigint;
  router: string; route: string; routerFeeUsd: number | null; txSignature: string | null; solUsd: number; at: number; note: string | null;
  entry?: { liquidityUsd: number | null; creator: string | null; creatorPct: number | null; insiders?: string[] | null; insiderPct?: number | null; onCurve?: boolean | null;
    stopUsd?: number | null; targetUsd?: number | null };
  /** A scale-in: added to the open position (average price), not a new one. */
  add?: boolean;
  /** SELL: the exit rule that fired. */
  exitReason?: string | null;
}

export const uiAmount = (rawAmount: bigint, decimals: number): string => {
  const neg = rawAmount < 0n, v = neg ? -rawAmount : rawAmount, base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / base}${frac ? `.${frac}` : ''}`;
};
const lamportsUsd = (lamports: bigint, solUsd: number) => exactNumber(lamports < 0n ? -lamports : lamports) / 1e9 * solUsd * (lamports < 0n ? -1 : 1);

/** One persistent ledger per mode (and, for LIVE, per wallet). TEST and LIVE records never share a file. */
export class DeskLedger {
  /** Where an unreadable TEST ledger was moved before this one started fresh (null: it was read, or there was none). */
  damaged: string | null = null;
  private constructor(readonly file: string, public state: LedgerState) {}

  /**
   * An unreadable LIVE ledger stops the desk (LEDGER_INVALID): it records real money. An unreadable TEST ledger (paper
   * money only; e.g. all zero bytes after a power cut) is moved aside and TEST starts fresh, so the desk still opens.
   */
  static async open(file: string, mode: DeskMode, wallet: string | null, now: number): Promise<DeskLedger> {
    let damaged: string | null = null;
    try {
      const state = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (state.mode !== mode || (mode === 'LIVE' && state.wallet !== wallet)) throw new Error('LEDGER_IDENTITY_MISMATCH');
      return new DeskLedger(file, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof Error && error.message === 'LEDGER_IDENTITY_MISMATCH') throw error;
        if (mode !== 'PAPER') throw new Error('LEDGER_INVALID');
        damaged = await setAside(file, now);
      }
    }
    const fresh = new DeskLedger(file, { version: 1, mode, wallet, createdAt: now, paperCashLamports: null, paperStartUsd: null, positions: [], entries: [],
      pending: null, halted: null, realizedPnlUsd: 0, feesUsd: 0, feesLamports: '0', updatedAt: now });
    fresh.damaged = damaged;
    return fresh;
  }

  async save(): Promise<void> {
    this.state.updatedAt = Date.now();
    await atomicWriteFile(this.file, JSON.stringify(stateSchema.parse(this.state), null, 2) + '\n');
  }

  /** TEST capital is the planned starting capital converted once at the first observed SOL price. */
  fundPaper(plannedUsd: number, solUsd: number): void {
    if (this.state.mode !== 'PAPER' || this.state.paperCashLamports !== null) return;
    this.state.paperCashLamports = String(BigInt(Math.floor(plannedUsd / solUsd * 1e9)));
    this.state.paperStartUsd = plannedUsd;
  }

  position(mint: string): DeskPosition | undefined { return this.state.positions.find(p => p.mint === mint); }

  book(f: Fill): LedgerEntry {
    const s = this.state, fee = f.feeLamports, feeUsd = lamportsUsd(fee, f.solUsd);
    const status: LedgerEntry['status'] = s.mode === 'PAPER' ? 'PAPER_FILLED' : 'CONFIRMED';
    if (s.mode === 'LIVE' && !f.txSignature) throw new Error('LIVE_FILL_WITHOUT_SIGNATURE');
    if (f.txSignature && s.entries.some(e => e.txSignature === f.txSignature)) throw new Error('DUPLICATE_FILL');
    let entryRow: LedgerEntry;
    if (f.side === 'BUY' && f.add) {
      // Scale-in: the position grows at a new average price; its peak restarts from the value it has now.
      const p = this.position(f.mint);
      if (!p) throw new Error('UNTRACKED_POSITION');
      if (f.outAmountRaw <= 0n || f.inAmountRaw <= 0n) throw new Error('INVALID_BUY_FILL');
      const qty = exactNumber(f.outAmountRaw) / 10 ** f.decimals, oldQty = exactNumber(BigInt(p.qtyRaw)) / 10 ** p.decimals, inputUsd = lamportsUsd(f.inAmountRaw, f.solUsd);
      const oldInputUsd = p.entryPriceUsd !== null ? p.entryPriceUsd * oldQty : p.costUsd, cost = f.inAmountRaw + fee;
      p.firstEntryPriceUsd ??= p.entryPriceUsd;
      p.qtyRaw = String(BigInt(p.qtyRaw) + f.outAmountRaw); p.costLamports = String(BigInt(p.costLamports) + cost); p.costUsd += lamportsUsd(cost, f.solUsd);
      p.entryPriceUsd = oldQty + qty > 0 ? (oldInputUsd + inputUsd) / (oldQty + qty) : p.entryPriceUsd;
      p.lastValueLamports = String(BigInt(p.lastValueLamports ?? p.peakValueLamports) + f.inAmountRaw); p.peakValueLamports = p.lastValueLamports;
      p.adds = (p.adds ?? 0) + 1;
      entryRow = this.row(f, status, { quantity: uiAmount(f.outAmountRaw, f.decimals), qtyRaw: f.outAmountRaw, entryPriceUsd: qty > 0 ? inputUsd / qty : null,
        exitPriceUsd: null, grossPnlUsd: null, netPnlUsd: null, feeUsd });
      entryRow.note = `ADD ${p.adds}${f.note ? ` · ${f.note}` : ''}`;
      // The token account already exists: an add pays no account rent.
      if (s.mode === 'PAPER') s.paperCashLamports = String(BigInt(s.paperCashLamports ?? '0') - f.inAmountRaw - fee);
    } else if (f.side === 'BUY') {
      if (this.position(f.mint)) throw new Error('POSITION_ALREADY_OPEN');
      if (f.outAmountRaw <= 0n || f.inAmountRaw <= 0n) throw new Error('INVALID_BUY_FILL');
      const qty = exactNumber(f.outAmountRaw) / 10 ** f.decimals, inputUsd = lamportsUsd(f.inAmountRaw, f.solUsd);
      const cost = f.inAmountRaw + fee;
      s.positions.push({ id: `${f.at}-${f.mint.slice(0, 6)}`, mint: f.mint, symbol: f.symbol, decimals: f.decimals, openedAt: f.at,
        qtyRaw: String(f.outAmountRaw), costLamports: String(cost), costUsd: lamportsUsd(cost, f.solUsd), entryPriceUsd: qty > 0 ? inputUsd / qty : null,
        peakValueLamports: String(f.inAmountRaw), lastValueLamports: null, lastPriceUsd: null, router: f.router, route: f.route,
        entrySignature: f.txSignature, rentLamports: String(f.rentLamports), pairAddress: f.pairAddress,
        entryLiquidityUsd: f.entry?.liquidityUsd ?? null, creator: f.entry?.creator ?? null, creatorPctAtEntry: f.entry?.creatorPct ?? null,
        ...(f.entry?.insiders?.length ? { insiders: f.entry.insiders, insiderPctAtEntry: f.entry.insiderPct ?? null, onCurve: f.entry.onCurve ?? null } : {}),
        ...(f.entry?.stopUsd != null || f.entry?.targetUsd != null ? { stopUsd: f.entry.stopUsd ?? null, targetUsd: f.entry.targetUsd ?? null } : {}) });
      entryRow = this.row(f, status, { quantity: uiAmount(f.outAmountRaw, f.decimals), qtyRaw: f.outAmountRaw, entryPriceUsd: qty > 0 ? inputUsd / qty : null,
        exitPriceUsd: null, grossPnlUsd: null, netPnlUsd: null, feeUsd });
      if (s.mode === 'PAPER') s.paperCashLamports = String(BigInt(s.paperCashLamports ?? '0') - f.inAmountRaw - fee - f.rentLamports);
    } else {
      const p = this.position(f.mint);
      if (!p || f.inAmountRaw !== BigInt(p.qtyRaw)) throw new Error('UNTRACKED_POSITION');
      const qty = exactNumber(f.inAmountRaw) / 10 ** p.decimals;
      // Gross proceeds before this transaction's network fee; the fee is reported separately.
      const proceeds = f.solDeltaLamports + fee, proceedsUsd = lamportsUsd(proceeds, f.solUsd);
      // Entry input excludes the entry's network fee, which was booked on the BUY row and is subtracted once here.
      const inputUsd = p.entryPriceUsd !== null ? p.entryPriceUsd * qty : p.costUsd, buyFeeUsd = Math.max(0, p.costUsd - inputUsd);
      const grossPnlUsd = proceedsUsd - inputUsd;
      // The token account's rent left the wallet with the entry; it is a cost of this trade until the account is closed.
      const rent = BigInt(p.rentLamports), netPnlUsd = grossPnlUsd - buyFeeUsd - feeUsd - lamportsUsd(rent, f.solUsd);
      entryRow = this.row(f, status, { quantity: uiAmount(f.inAmountRaw, p.decimals), qtyRaw: f.inAmountRaw, entryPriceUsd: p.entryPriceUsd,
        exitPriceUsd: qty > 0 ? proceedsUsd / qty : null, grossPnlUsd, netPnlUsd, feeUsd });
      if (rent > 0n) entryRow.rentOutstandingLamports = String(rent);
      s.realizedPnlUsd += netPnlUsd;
      s.positions = s.positions.filter(x => x !== p);
      if (s.mode === 'PAPER') s.paperCashLamports = String(BigInt(s.paperCashLamports ?? '0') + f.solDeltaLamports);
    }
    s.feesUsd += feeUsd; s.feesLamports = String(BigInt(s.feesLamports) + fee);
    s.entries.push(entryRow);
    if (s.entries.length > 10_000) s.entries.splice(0, s.entries.length - 10_000);
    s.pending = null;
    return entryRow;
  }

  /**
   * TEST only: closes a position that cannot be sold (no route) at zero proceeds. Its token account still holds the
   * tokens, so the account rent stays charged.
   */
  writeOff(mint: string, solUsd: number, at: number, note: string): LedgerEntry {
    const p = this.position(mint);
    if (this.state.mode !== 'PAPER') throw new Error('WRITE_OFF_TEST_ONLY');
    if (!p) throw new Error('UNTRACKED_POSITION');
    return this.book({ side: 'SELL', mint, symbol: p.symbol, decimals: p.decimals, pairAddress: p.pairAddress, inAmountRaw: BigInt(p.qtyRaw), outAmountRaw: 0n,
      solDeltaLamports: 0n, feeLamports: 0n, rentLamports: 0n, router: 'none', route: 'no route', routerFeeUsd: null, txSignature: null, solUsd, at, note });
  }

  failed(f: { side: 'BUY' | 'SELL'; mint: string; symbol: string | null; router: string; route: string; feeLamports: bigint; solUsd: number;
    txSignature: string | null; at: number; note: string; unknown: boolean }): LedgerEntry {
    const feeUsd = lamportsUsd(f.feeLamports, f.solUsd);
    const row: LedgerEntry = { id: `${f.at}-${f.side}-${f.mint.slice(0, 6)}`, at: f.at, mode: this.state.mode, txSignature: f.txSignature, mint: f.mint, symbol: f.symbol,
      router: f.router, route: f.route, side: f.side, quantity: '0', qtyRaw: '0', entryPriceUsd: null, exitPriceUsd: null, grossPnlUsd: null,
      networkFeeLamports: String(f.feeLamports), networkFeeUsd: feeUsd, routerFeeUsd: null, totalFeesUsd: feeUsd, netPnlUsd: f.feeLamports > 0n ? -feeUsd : null,
      solDeltaLamports: String(-f.feeLamports), status: f.unknown ? 'UNKNOWN' : 'FAILED', note: f.note };
    this.state.entries.push(row);
    this.state.feesUsd += feeUsd; this.state.feesLamports = String(BigInt(this.state.feesLamports) + f.feeLamports);
    if (f.feeLamports > 0n) this.state.realizedPnlUsd -= feeUsd;
    return row;
  }

  /**
   * Rent returned by closing a sold token's empty account: credited to the SELL that charged it, net of the close
   * transaction's fee (shared equally when one transaction closes several accounts).
   */
  rentReclaimed(r: { mint: string; lamports: bigint; feeLamports: bigint; signature: string | null; solUsd: number }): void {
    const s = this.state, feeUsd = lamportsUsd(r.feeLamports, r.solUsd);
    const row = [...s.entries].reverse().find(e => e.mint === r.mint && e.side === 'SELL' && (e.status === 'CONFIRMED' || e.status === 'PAPER_FILLED'));
    const charged = BigInt(row?.rentOutstandingLamports ?? '0'), credit = r.lamports < charged ? r.lamports : charged, creditUsd = lamportsUsd(credit, r.solUsd);
    if (row) {
      row.netPnlUsd = (row.netPnlUsd ?? 0) + creditUsd - feeUsd;
      row.networkFeeLamports = String(BigInt(row.networkFeeLamports) + r.feeLamports);
      row.networkFeeUsd = (row.networkFeeUsd ?? 0) + feeUsd; row.totalFeesUsd = (row.totalFeesUsd ?? 0) + feeUsd;
      row.solDeltaLamports = String(BigInt(row.solDeltaLamports) + r.lamports - r.feeLamports);
      if (charged > credit) row.rentOutstandingLamports = String(charged - credit); else delete row.rentOutstandingLamports;
      row.note = [row.note, `account rent ${uiAmount(r.lamports, 9)} SOL reclaimed${r.signature ? ` (${r.signature})` : ''}`].filter(Boolean).join(' · ');
    }
    s.realizedPnlUsd += creditUsd - feeUsd;
    s.feesUsd += feeUsd; s.feesLamports = String(BigInt(s.feesLamports) + r.feeLamports);
    if (s.mode === 'PAPER') s.paperCashLamports = String(BigInt(s.paperCashLamports ?? '0') + r.lamports - r.feeLamports);
  }
  /** Mints of this ledger's closed trades whose account rent is still charged (not yet reclaimed). */
  rentOutstandingMints(): string[] {
    return [...new Set(this.state.entries.filter(e => e.side === 'SELL' && e.rentOutstandingLamports && !this.position(e.mint)).map(e => e.mint))];
  }

  private row(f: Fill, status: LedgerEntry['status'], v: { quantity: string; qtyRaw: bigint; entryPriceUsd: number | null; exitPriceUsd: number | null;
    grossPnlUsd: number | null; netPnlUsd: number | null; feeUsd: number }): LedgerEntry {
    return { id: f.txSignature ?? `${f.at}-${f.side}-${f.mint.slice(0, 6)}`, at: f.at, mode: this.state.mode, txSignature: f.txSignature, mint: f.mint,
      symbol: f.symbol, router: f.router, route: f.route, side: f.side, quantity: v.quantity, qtyRaw: String(v.qtyRaw), entryPriceUsd: v.entryPriceUsd,
      exitPriceUsd: v.exitPriceUsd, grossPnlUsd: v.grossPnlUsd, networkFeeLamports: String(f.feeLamports), networkFeeUsd: v.feeUsd,
      routerFeeUsd: f.routerFeeUsd, totalFeesUsd: v.feeUsd + (f.routerFeeUsd ?? 0), netPnlUsd: v.netPnlUsd,
      solDeltaLamports: String(f.solDeltaLamports), status, note: f.note, ...(f.side === 'SELL' && f.exitReason ? { exitReason: f.exitReason.slice(0, 300) } : {}) };
  }
}

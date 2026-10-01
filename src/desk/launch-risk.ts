import fs from 'node:fs/promises';
import path from 'node:path';
import { PublicKey, type Connection } from '@solana/web3.js';

/**
 * Rug defence for fresh pump.fun launches, from the two LAUNCH trades of 1 Oct that both dumped at graduation:
 *
 *   ETF  (5EvrB7…pump)  dev 26.6 % + 5 wallets in the creation slot = 40 % of supply; +308 % peak, −84 % after graduating
 *   Potato (GicwGn7X…)  dev 5.1 % + 5 wallets in the creation slot = 15 % of supply; +220 % peak, −90 % after graduating,
 *                       X account deleted afterwards
 *
 * A bundled creation alone does not mark a rug (ETF was the best trade). What both share is the insiders — the creator
 * and every wallet that bought in the creation slot — selling into the migration, when Jupiter cannot route the token
 * for a minute or two. So the desk knows who the insiders are, sells when they sell, and sells before graduation while
 * they still hold a large bag. A launch that rugged puts its creator, X account and website on a persistent list.
 */
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RISK = Object.freeze({
  /** The curve's tokens for sale: 793.1M of the 1B supply (6 decimals). */
  curveTokensRaw: 793_100_000_000_000n,
  supplyRaw: 1_000_000_000_000_000n,
  /** Insiders are the creator and wallets that bought in the creation slot or the next one. */
  insiderSlots: 1,
  maxInsiders: 8,
  /** Never bought: the curve is mostly in insider hands. */
  maxInsiderPctAtEntry: 50,
  /** Sell before graduation from this curve progress on, if insiders still hold at least this share. */
  preGraduationProgress: 0.9,
  preGraduationInsiderPct: 8,
  /** Sell when insiders sold this share of what they held at entry (relative), and at least this many points of supply. */
  insiderSellExitPct: 25, insiderSellMinPts: 1,
  /** Creation-slot transactions read per launch. */
  maxEarlyTxs: 25,
  insiderCheckMs: 8_000,
});

export interface Insiders {
  /** Creator first. */
  wallets: string[]; creatorPct: number; insiderPct: number; slot: number; detail: string;
}
export interface CurveState { progress: number; complete: boolean; creator: string | null }

type Rpc = { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> };
type RawTx = { slot: number; transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
  meta: { err: unknown; preTokenBalances?: TokenBal[] | null; postTokenBalances?: TokenBal[] | null } | null };
type TokenBal = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
const rawRequest = (c: Connection) => c as unknown as { _rpcRequest(m: string, a: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> };
const pct = (raw: bigint) => Number(raw * 1_000_000n / RISK.supplyRaw) / 10_000;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function bondingCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

/** BondingCurve: discriminator, virtual token / SOL reserves, real token / SOL reserves, supply, complete, creator. */
export function decodeCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  const realTok = data.readBigUInt64LE(24), complete = data[48] === 1;
  const progress = complete ? 1 : Math.max(0, Math.min(1, 1 - Number(realTok) / Number(RISK.curveTokensRaw)));
  let creator: string | null = null;
  if (data.length >= 81) { try { creator = new PublicKey(data.subarray(49, 81)).toBase58(); } catch { creator = null; } }
  return { progress, complete, creator };
}

export async function curveState(rpc: Rpc, mint: string): Promise<CurveState | null> {
  const info = await rpc.execute('risk:curve', c => c.getAccountInfo(new PublicKey(bondingCurveAddress(mint)), 'confirmed'));
  return info ? decodeCurve(Buffer.from(info.data)) : null;
}

/** Token change per owner in one transaction (raw units of this mint). */
export function tokenDeltas(tx: RawTx, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (rows: TokenBal[] | null | undefined, sign: bigint) => {
    for (const b of rows ?? []) if (b.mint === mint && b.owner) out.set(b.owner, (out.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  add(tx.meta?.postTokenBalances, 1n); add(tx.meta?.preTokenBalances, -1n);
  return out;
}

/**
 * The launch's insiders from the chain: the creator and every wallet that bought in the creation slot (or the next),
 * with the share of supply they took. Reads the mint's signatures back to the creation and those few transactions.
 */
export async function readInsiders(rpc: Rpc, mint: string, creator: string | null, createSignature: string): Promise<Insiders | null> {
  const key = new PublicKey(mint);
  const sigs: Array<{ signature: string; slot: number; err: unknown }> = [];
  let before: string | undefined;
  for (let page = 0; page < 4; page++) {
    const batch = await rpc.execute('risk:signatures', c => c.getSignaturesForAddress(key, { limit: 1000, ...(before ? { before } : {}) }, 'confirmed'));
    sigs.push(...batch); before = batch.at(-1)?.signature;
    if (batch.length < 1000 || batch.some(s => s.signature === createSignature)) break;
  }
  const create = sigs.find(s => s.signature === createSignature);
  if (!create) return null;
  const early = sigs.filter(s => !s.err && s.slot <= create.slot + RISK.insiderSlots).slice(-RISK.maxEarlyTxs);
  const held = new Map<string, bigint>();
  for (const s of early) {
    const res = await rpc.execute('risk:tx', c => rawRequest(c)._rpcRequest('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]));
    const tx = res.result as RawTx | null;
    if (!tx) continue;
    for (const [owner, d] of tokenDeltas(tx, mint)) held.set(owner, (held.get(owner) ?? 0n) + d);
  }
  const ranked = [...held.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const creatorRaw = creator ? held.get(creator) ?? 0n : 0n;
  const wallets = [...(creator ? [creator] : []), ...ranked.map(([w]) => w).filter(w => w !== creator)].slice(0, RISK.maxInsiders);
  const total = wallets.reduce((s, w) => s + (held.get(w) ?? 0n), 0n);
  const others = wallets.length - (creator ? 1 : 0);
  return { wallets, slot: create.slot, creatorPct: pct(creatorRaw), insiderPct: pct(total),
    detail: `insiders hold ${pct(total).toFixed(1)}%: dev ${pct(creatorRaw).toFixed(1)}%${others ? ` + ${others} wallet${others > 1 ? 's' : ''} in the creation slot` : ''}` };
}

/** What the insiders hold now, as a share of supply. */
export async function insiderHolding(rpc: Rpc, mint: string, wallets: string[]): Promise<number> {
  const key = new PublicKey(mint);
  let total = 0n;
  for (const w of wallets) {
    const owned = await rpc.execute('risk:insider-balance', c => c.getParsedTokenAccountsByOwner(new PublicKey(w), { mint: key }, 'confirmed'));
    for (const row of owned.value) {
      const amount = (row.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (amount && /^\d+$/.test(amount)) total += BigInt(amount);
    }
  }
  return pct(total);
}

/** The exit a held curve position needs now, if any. */
export function insiderExit(atEntryPct: number, nowPct: number, curve: CurveState | null): string | null {
  if (atEntryPct > 0 && atEntryPct - nowPct >= Math.max(atEntryPct * RISK.insiderSellExitPct / 100, RISK.insiderSellMinPts))
    return `RUG insiders sold: they hold ${nowPct.toFixed(1)}% (was ${atEntryPct.toFixed(1)}% at entry)`;
  if (curve && !curve.complete && curve.progress >= RISK.preGraduationProgress && nowPct >= RISK.preGraduationInsiderPct)
    return `PRE_GRADUATION curve ${(curve.progress * 100).toFixed(0)}% full while insiders hold ${nowPct.toFixed(1)}% (ETF −84%, Potato −90% after graduating)`;
  return null;
}

// ------------------------------------------------------------------ rug list

export interface RugRecord { mint: string; symbol: string | null; at: number; reason: string; creator: string | null; xHandle: string | null; site: string | null }
const RugFile = (v: unknown): RugRecord[] => Array.isArray((v as { rugs?: unknown }).rugs) ? (v as { rugs: RugRecord[] }).rugs.filter(r => typeof r?.mint === 'string') : [];

/** Launches that rugged; their creator, X account and website never get a LAUNCH entry again. Persisted. */
export class RugList {
  private rugs: RugRecord[] = [];
  private constructor(private readonly file: string | null) {}
  static async open(file: string | null, seed: RugRecord[] = []): Promise<RugList> {
    const list = new RugList(file);
    if (file) { try { list.rugs = RugFile(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { list.rugs = []; } }
    for (const r of seed) if (!list.rugs.some(x => x.mint === r.mint)) list.rugs.push(r);
    return list;
  }
  all(): RugRecord[] { return [...this.rugs]; }
  async add(r: RugRecord): Promise<boolean> {
    if (this.rugs.some(x => x.mint === r.mint)) return false;
    this.rugs.push({ ...r, xHandle: r.xHandle?.toLowerCase() ?? null, site: r.site?.toLowerCase() ?? null });
    if (this.rugs.length > 2_000) this.rugs = this.rugs.slice(-2_000);
    if (this.file) {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ rugs: this.rugs }, null, 2)); await fs.rename(tmp, this.file);
    }
    return true;
  }
  /** Why this launch matches an earlier rug, or null. */
  match(l: { mint: string; creator: string | null; xHandle: string | null; site: string | null }): string | null {
    const handle = l.xHandle?.toLowerCase() ?? null, site = l.site?.toLowerCase() ?? null;
    for (const r of this.rugs) {
      const why = r.mint === l.mint ? 'this token' : l.creator && r.creator === l.creator ? `its creator ${short(l.creator)}` : handle && r.xHandle === handle ? `X account @${handle}`
        : site && r.site === site ? `website ${site}` : null;
      if (why) return `RUG HISTORY: ${why} rugged ${r.symbol ?? short(r.mint)} on ${new Date(r.at).toISOString().slice(0, 10)} (${r.reason.split(':')[0]})`;
    }
    return null;
  }
}

/** Potato (1 Oct): bought by LAUNCH, dumped 90 % at graduation, X account deleted afterwards. */
export const KNOWN_RUGS: RugRecord[] = [
  { mint: 'GicwGn7XvWRKt1297uUKbZtY4hpma1sAWqjPBmMsEgYE', symbol: 'Potato', at: Date.parse('2026-10-01T19:29:00Z'), reason: 'RUG: insiders dumped at graduation, X account deleted',
    creator: '4P62ZD4KA4zmLjauG7VFEEiactvAVkbkyXtvuqL6ZJxC', xHandle: 'potpotato_sol', site: 'potpotato.fun' },
];

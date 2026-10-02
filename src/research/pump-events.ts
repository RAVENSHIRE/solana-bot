import { PublicKey } from '@solana/web3.js';

/**
 * pump.fun bonding-curve events as they appear in transaction logs ("Program data: <base64>"), decoded from the stable
 * front of each layout. Newer program versions append fields; nothing here reads past the fields it needs.
 */
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DISC = Object.freeze({
  trade: 'bddb7fd34ee661ee', complete: '5f72619cd42e9808', create: '1b72a94ddeeb6376',
});
/** The curve's tokens for sale (6 decimals): progress = 1 − real token reserves ÷ this. */
export const CURVE_TOKENS_RAW = 793_100_000_000_000;

export interface PumpTrade {
  mint: string; user: string; isBuy: boolean;
  /** Lamports into (buy) or out of (sell) the curve, and raw token units (6 decimals). */
  lamports: number; tokens: number;
  /** Chain time of the trade, seconds. */
  ts: number;
  /** Curve state after the trade. */
  vSol: number; vTok: number; realSol: number; realTok: number;
  /** The coin's creator, when the event carries it (program versions from 2025 on). */
  creator: string | null;
}
export interface PumpComplete { mint: string; user: string; ts: number }
export interface PumpCreate { mint: string; name: string; symbol: string; uri: string; user: string; creator: string | null; ts: number | null }

const key = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));
const str = (b: Buffer, o: number): [string, number] => {
  const n = b.readUInt32LE(o);
  if (n > 400 || o + 4 + n > b.length) throw new Error('bad string');
  return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n];
};

export function decodeTrade(b: Buffer): PumpTrade | null {
  if (b.length < 129) return null;
  return { mint: key(b, 8), lamports: u64(b, 40), tokens: u64(b, 48), isBuy: b[56] === 1, user: key(b, 57), ts: Number(b.readBigInt64LE(89)),
    vSol: u64(b, 97), vTok: u64(b, 105), realSol: u64(b, 113), realTok: u64(b, 121), creator: b.length >= 209 ? key(b, 177) : null };
}

export function decodeComplete(b: Buffer): PumpComplete | null {
  if (b.length < 112) return null;
  return { user: key(b, 8), mint: key(b, 40), ts: Number(b.readBigInt64LE(104)) };
}

export function decodeCreateEvent(b: Buffer): PumpCreate | null {
  try {
    let o = 8, name: string, symbol: string, uri: string;
    [name, o] = str(b, o); [symbol, o] = str(b, o); [uri, o] = str(b, o);
    if (b.length < o + 96) return null;
    const creator = b.length >= o + 128 ? key(b, o + 96) : null;
    const ts = b.length >= o + 136 ? Number(b.readBigInt64LE(o + 128)) : null;
    return { mint: key(b, o), name: name.trim(), symbol: symbol.trim(), uri, user: key(b, o + 64), creator, ts };
  } catch { return null; }
}

export type PumpEvent = { kind: 'trade'; e: PumpTrade } | { kind: 'complete'; e: PumpComplete } | { kind: 'create'; e: PumpCreate };

/** Every pump.fun event in one transaction's logs, in log order. Unknown or malformed events are skipped. */
export function pumpEvents(logs: readonly string[]): PumpEvent[] {
  const out: PumpEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let b: Buffer;
    try { b = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
    if (b.length < 8) continue;
    const d = b.subarray(0, 8).toString('hex');
    try {
      if (d === DISC.trade) { const e = decodeTrade(b); if (e) out.push({ kind: 'trade', e }); }
      else if (d === DISC.complete) { const e = decodeComplete(b); if (e) out.push({ kind: 'complete', e }); }
      else if (d === DISC.create) { const e = decodeCreateEvent(b); if (e) out.push({ kind: 'create', e }); }
    } catch { /* another program's data, or a layout this version does not know */ }
  }
  return out;
}

/** Market cap in SOL (1B supply, 6 decimals) and curve progress from the reserves after a trade. */
export const curveMcapSol = (vSol: number, vTok: number) => vTok > 0 ? (vSol / 1e9) / (vTok / 1e6) * 1e9 : 0;
export const curveProgress = (realTok: number) => Math.max(0, Math.min(1, 1 - realTok / CURVE_TOKENS_RAW));

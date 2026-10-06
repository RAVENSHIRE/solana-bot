import { PublicKey, type Connection } from '@solana/web3.js';
import { bondingCurveAddress } from './launch-risk';
import { OPENING_RULES } from './config';

/**
 * Opening screen — the owner's basic screen for fresh pump.fun launches, from FIX6900 (6bQ4…SmvC) on 1 Oct:
 *
 *   $20K opening candle → $7K → $14K → $27K → $35K → graduated → $500K+
 *
 *   1. Strong open: the first one-minute candle reaches at least $10K market cap.
 *   2. Floor: after that it never trades below $6.7K. Anything that does is a rug and is dropped.
 *   3. Signal: it breaks back above its opening high (×1.3 → $26K for a $20K open; the owner wanted the alert at $27K).
 *      An alert goes out at once, and the OPEN strategy buys.
 *   4. Hold for at least 6×; the $6.7K floor stays the stop. Add to the position as it proves itself.
 *
 * Market caps come straight from each launch's bonding curve, so the opening candle is measured from the first seconds,
 * long before DexScreener lists the token: from the research observer's live stream when it runs (the curve state each
 * trade leaves, no RPC), otherwise one getMultipleAccounts call per 100 curves every few seconds.
 */
export const OPENING = Object.freeze({
  pollMs: 4_000,
  /** The opening candle: the first minute after creation. */
  openWindowMs: 60_000,
  minOpenUsd: OPENING_RULES.minOpenUsd,
  floorUsd: OPENING_RULES.floorUsd,
  /** Breakout: this multiple of the opening high (20K → 26K). */
  breakoutOverOpen: OPENING_RULES.breakoutOverOpen,
  /** Strong opens are watched this long (or until the curve graduates). */
  watchMs: 45 * 60_000,
  /** Every launch is watched for its opening candle; launches first seen later than this cannot be judged. */
  firstSampleWithinMs: 45_000,
  maxTracked: 600,
  /** A bonding curve's market cap is far below this; a larger value means an unknown curve layout. */
  maxCurveUsd: 500_000,
  // Phone alerts for breakouts (which, how many, text, colours): desk/opening-alerts.ts.
});

export type OpeningStatus = 'OPENING' | 'STRONG' | 'SIGNAL' | 'WEAK' | 'RUG' | 'GRADUATED' | 'EXPIRED' | 'UNKNOWN_OPEN';
export interface OpeningState {
  mint: string; symbol: string; name: string; at: number; status: OpeningStatus;
  openHighUsd: number | null; lowUsd: number | null; lastUsd: number | null; peakUsd: number | null;
  firstSampleAt: number | null; lastSampleAt: number | null;
  signalAt: number | null; signalUsd: number | null; detail: string;
  /** Recent samples [time, market cap], bounded. */
  samples: Array<[number, number]>;
}

/** pump.fun BondingCurve: virtual token reserves @8, virtual SOL reserves @16, supply @40, complete @48. Market cap in SOL. */
export function curveMarketCapSol(data: Buffer): { sol: number; complete: boolean } | null {
  if (data.length < 49) return null;
  const vTok = Number(data.readBigUInt64LE(8)), vSol = Number(data.readBigUInt64LE(16)), supply = Number(data.readBigUInt64LE(40));
  const complete = data[48] === 1;
  if (complete) return { sol: 0, complete };
  if (!vTok || !vSol || !supply) return null;
  return { sol: (vSol / 1e9) / (vTok / 1e6) * (supply / 1e6), complete };
}

const k = (usd: number | null) => usd === null ? '?' : `$${(usd / 1000).toFixed(1)}K`;

/** One market-cap sample through the screen's rules. Returns true when this sample is the breakout signal. */
export function openingStep(s: OpeningState, at: number, usd: number): boolean {
  s.firstSampleAt ??= at; s.lastSampleAt = at; s.lastUsd = usd;
  s.samples.push([at, usd]); if (s.samples.length > 240) s.samples.splice(0, s.samples.length - 240);
  s.peakUsd = Math.max(s.peakUsd ?? 0, usd);
  const inOpen = at - s.at <= OPENING.openWindowMs;
  if (s.status === 'OPENING') {
    if (s.firstSampleAt - s.at > OPENING.firstSampleWithinMs) { s.status = 'UNKNOWN_OPEN'; s.detail = `first seen ${Math.round((s.firstSampleAt - s.at) / 1000)} s after creation: opening candle unknown`; return false; }
    if (inOpen) { s.openHighUsd = Math.max(s.openHighUsd ?? 0, usd); s.detail = `opening candle so far ${k(s.openHighUsd)}`; return false; }
    if ((s.openHighUsd ?? 0) < OPENING.minOpenUsd) { s.status = 'WEAK'; s.detail = `opening candle ${k(s.openHighUsd)} < ${k(OPENING.minOpenUsd)}`; return false; }
    s.status = 'STRONG';
  }
  if (s.status !== 'STRONG') return false;
  s.lowUsd = Math.min(s.lowUsd ?? usd, usd);
  if (usd < OPENING.floorUsd) { s.status = 'RUG'; s.detail = `fell to ${k(usd)} below the ${k(OPENING.floorUsd)} floor after a ${k(s.openHighUsd)} open`; return false; }
  const target = (s.openHighUsd ?? 0) * OPENING.breakoutOverOpen;
  if (usd >= target) {
    s.status = 'SIGNAL'; s.signalAt = at; s.signalUsd = usd;
    s.detail = `${k(s.openHighUsd)} open → low ${k(s.lowUsd)} (held ${k(OPENING.floorUsd)}) → ${k(usd)}: broke above the opening high`;
    return true;
  }
  s.detail = `${k(s.openHighUsd)} open · low ${k(s.lowUsd)} · now ${k(usd)} · signal at ${k(target)}`;
  return false;
}

/**
 * How fast a launch got to its breakout: from its first read (seconds after creation) to the signal. A launch that
 * multiplies within its first two minutes is the fast kind the owner trades (GOOP HEAD, 3 Oct: $3.4K → $28.9K in 68 s,
 * $105K in the same minute, then dead): the call says so, and the research layer tests such sprints with fast exits.
 */
export function openingSpeed(s: Pick<OpeningState, 'at' | 'samples' | 'signalAt' | 'signalUsd'>): { fromUsd: number; toUsd: number; secs: number; multiple: number; text: string } | null {
  const first = s.samples[0];
  if (!first || !s.signalAt || !s.signalUsd || first[1] <= 0) return null;
  const secs = Math.max(1, Math.round((s.signalAt - s.at) / 1000)), multiple = s.signalUsd / first[1];
  const k = (usd: number) => `$${(usd / 1000).toFixed(1)}K`;
  return { fromUsd: first[1], toUsd: s.signalUsd, secs, multiple,
    text: `${k(first[1])} → ${k(s.signalUsd)} in ${secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`} (×${multiple.toFixed(1)})` };
}

type Rpc = { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> };
type CurveStream = { healthy(now: number): boolean; curves(mints: string[]): Promise<Map<string, { sol: number; complete: boolean }> | null> };

/** Watches every new launch's curve; reports each breakout signal once. Never throws. */
export class OpeningTracker {
  private readonly states = new Map<string, OpeningState>();
  /** Where the last read's market caps came from. */
  source: 'stream' | 'rpc' | null = null;
  constructor(private readonly rpc: Rpc, private readonly stream: CurveStream | null = null) {}

  /** One batch of curves: from the live stream while it is healthy, otherwise from the RPC. Null: no answer. */
  private async read(batch: OpeningState[], now: number): Promise<Array<{ sol: number; complete: boolean } | null> | null> {
    if (this.stream?.healthy(now)) {
      const got = await this.stream.curves(batch.map(s => s.mint));
      if (got) { this.source = 'stream'; return batch.map(s => got.get(s.mint) ?? null); }
    }
    try {
      const infos = await this.rpc.execute('opening:curves', c => c.getMultipleAccountsInfo(batch.map(s => new PublicKey(bondingCurveAddress(s.mint))), 'confirmed')) as Array<{ data: Buffer } | null>;
      this.source = 'rpc';
      return infos.map(info => info ? curveMarketCapSol(Buffer.from(info.data)) : null);
    } catch { this.source = null; return null; }
  }

  /** Launches the radar has decoded (mint, name, creation time); new ones start being watched. */
  observe(launches: Array<{ mint: string; symbol: string; name: string; at: number }>, now: number): void {
    for (const l of launches) {
      if (this.states.has(l.mint) || now - l.at > OPENING.firstSampleWithinMs + 30_000) continue;
      this.states.set(l.mint, { mint: l.mint, symbol: l.symbol, name: l.name, at: l.at, status: 'OPENING', openHighUsd: null, lowUsd: null, lastUsd: null, peakUsd: null,
        firstSampleAt: null, lastSampleAt: null, signalAt: null, signalUsd: null, detail: 'waiting for the first sample', samples: [] });
    }
    // Finished launches are dropped after a while; strong opens and signals stay listed longest.
    for (const [mint, s] of this.states) {
      const keep = s.status === 'SIGNAL' || s.status === 'STRONG' ? 2 * 60 * 60_000 : s.status === 'OPENING' ? 10 * 60_000 : 15 * 60_000;
      if (now - s.at > keep) this.states.delete(mint);
    }
    if (this.states.size > OPENING.maxTracked) {
      const drop = [...this.states.values()].filter(s => s.status !== 'STRONG' && s.status !== 'SIGNAL').sort((a, b) => a.at - b.at).slice(0, this.states.size - OPENING.maxTracked);
      for (const s of drop) this.states.delete(s.mint);
    }
  }

  /** Reads every watched curve; returns the launches that signalled on this read. */
  async poll(now: number, solUsd: number | null): Promise<OpeningState[]> {
    if (!solUsd) return [];
    const due = [...this.states.values()].filter(s => s.status === 'OPENING' || (s.status === 'STRONG' && now - s.at <= OPENING.watchMs));
    for (const s of this.states.values()) if (s.status === 'STRONG' && now - s.at > OPENING.watchMs) { s.status = 'EXPIRED'; s.detail = `no breakout within ${OPENING.watchMs / 60_000} min`; }
    const signals: OpeningState[] = [];
    for (let i = 0; i < due.length; i += 100) {
      const batch = due.slice(i, i + 100);
      const caps = await this.read(batch, now);
      if (!caps) continue;
      batch.forEach((s, j) => {
        const cap = caps[j];
        if (!cap) return;
        if (cap.complete) { if (s.status === 'OPENING' || s.status === 'STRONG') { s.status = 'GRADUATED'; s.detail = `graduated before a breakout (last ${k(s.lastUsd)})`; } return; }
        const usd = cap.sol * solUsd;
        if (usd > OPENING.maxCurveUsd) return;
        if (openingStep(s, now, usd)) signals.push(s);
      });
    }
    return signals;
  }

  get(mint: string): OpeningState | null { return this.states.get(mint) ?? null; }
  /** Strong opens, signals and recent rugs, newest first. */
  list(): OpeningState[] {
    return [...this.states.values()].filter(s => ['STRONG', 'SIGNAL', 'RUG', 'GRADUATED', 'EXPIRED'].includes(s.status) && (s.openHighUsd ?? 0) >= OPENING.minOpenUsd)
      .sort((a, b) => (b.signalAt ?? 0) - (a.signalAt ?? 0) || b.at - a.at);
  }
  counts(): Record<OpeningStatus, number> {
    const out = { OPENING: 0, STRONG: 0, SIGNAL: 0, WEAK: 0, RUG: 0, GRADUATED: 0, EXPIRED: 0, UNKNOWN_OPEN: 0 } as Record<OpeningStatus, number>;
    for (const s of this.states.values()) out[s.status]++;
    return out;
  }
}

import { PublicKey, type Connection } from '@solana/web3.js';
import type { Candle } from './replay';
import { addSample, type Bar } from './structure';
import { GRADUATION_MCAP_SOL, type GoldenShadow } from './golden-shadow';

/**
 * GOLDEN POCKET — break and retest, from 66hK2…pump on 1 Oct (PumpSwap pool from 21:41 UTC):
 *
 *   graduated $85K → $163K (first impulse: the resistance) → $107K (the dip) → $224K (breakout) →
 *   back to $146K (the old resistance $140–160K, also the 0.618–0.65 retracement of the $107K → $224K swing:
 *   the golden pocket) → straight up to $642K.
 *
 * The owner's rules: the shape counts, not the level (the opening screen's $9–50K → $6.7–27K → $14–50K → $27–100K,
 * or ten times that); the dip never goes below its minimum; buy the retest of the old resistance, the stop 5–10 %
 * below it. A second variant: the first candles are only up — buy within 12 % above the first / second candle.
 *
 * One state machine for both, fed minute candles (backtest) or market-cap samples (live). Values are market caps
 * in USD, but only their ratios matter, so the same rules hold on a $10K curve and a $200K pool.
 */
export type PocketZone = 'RESISTANCE' | 'FIB' | 'EITHER';
export interface OnlyUpRules {
  /** The first `bars` one-minute candles all close up, each above the previous close. */
  bars: number;
  /** Bought on a return to within `chasePct` above this candle's close (1 = first, 2 = second). */
  ref: number; chasePct: number;
  /** The return must come this soon; the stop is this far below the ref close. */
  windowMin: number; stopBelowPct: number;
}
export interface PocketRules {
  /** Break and retest; off to run only the only-up variant. */
  retest: boolean;
  /** The dip after the first impulse: at least dipMinPct below its high, and never more than dipMaxPct (the floor). */
  dipMinPct: number; dipMaxPct: number;
  /** The breakout: this multiple of the first impulse's high. */
  breakoutOverHigh: number;
  /** Where the retest is bought: the old resistance (its high, down to resistanceBelowPct under it), the Fibonacci pocket of the dip → breakout swing, or whichever comes first. */
  zone: PocketZone;
  resistanceBelowPct: number; resistanceAbovePct: number;
  /** Retracement of the dip → breakout swing: 0.5 → 0.65 (0.618–0.65 is the golden pocket proper). */
  fibTop: number; fibBottom: number;
  /** The stop: this far below the zone's bottom (the owner: 5–10 %). */
  stopBelowPct: number;
  /** The retest must come this soon after the breakout. */
  retestWindowMin: number;
  /** The whole pattern, up to the entry, within this long of the start (creation or graduation). */
  maxPatternMin: number;
  onlyUp: OnlyUpRules | null;
  /** Absolute floor (market cap): trading below it before the entry ends the pattern. */
  floorUsd: number;
}

export type PocketPhase = 'IMPULSE' | 'DIP' | 'BROKEN_OUT' | 'ENTRY' | 'FAILED' | 'EXPIRED';
export interface PocketEntry {
  kind: 'RETEST' | 'ONLY_UP'; at: number; price: number; stop: number;
  /** The level the pattern ran to before the entry (the next resistance): the breakout high, or the only-up high. */
  resistance: number; zone: [number, number]; detail: string;
}
export interface PocketState {
  startAt: number; phase: PocketPhase;
  /** Break and retest: first impulse high, dip low, breakout high. */
  high: number | null; low: number | null; top: number | null; breakoutAt: number | null;
  /** Only-up: the minute being built, completed up-candles, the ref close, the level once armed, the high since. */
  minute: { index: number; o: number; h: number; l: number; c: number } | null;
  upBars: number; upLastClose: number | null; upRefClose: number | null; upBroken: boolean; upRef: number | null; upReadyAt: number | null; upHigh: number | null;
  entry: PocketEntry | null; detail: string;
}

const MINUTE = 60_000;
const k = (v: number | null) => v === null ? '?' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1000).toFixed(1)}K`;

export function pocketState(startAt: number): PocketState {
  return { startAt, phase: 'IMPULSE', high: null, low: null, top: null, breakoutAt: null, minute: null, upBars: 0, upLastClose: null, upRefClose: null,
    upBroken: false, upRef: null, upReadyAt: null, upHigh: null, entry: null, detail: 'waiting for the first impulse' };
}

/** The buy zone and stop of a break and retest, from the impulse high, the dip low and the breakout high. */
export function pocketZone(r: PocketRules, high: number, low: number, top: number): { zone: [number, number]; stop: number } {
  const res: [number, number] = [high * (1 - r.resistanceBelowPct / 100), high * (1 + r.resistanceAbovePct / 100)];
  const fib: [number, number] = [top - r.fibBottom * (top - low), top - r.fibTop * (top - low)];
  const zone: [number, number] = r.zone === 'RESISTANCE' ? res : r.zone === 'FIB' ? fib : [Math.min(res[0], fib[0]), Math.max(res[1], fib[1])];
  // The zone never reaches the breakout high itself.
  zone[1] = Math.min(zone[1], top * 0.97);
  return { zone, stop: zone[0] * (1 - r.stopBelowPct / 100) };
}

const finished = (s: PocketState) => s.phase === 'ENTRY' || s.phase === 'FAILED' || s.phase === 'EXPIRED';

/**
 * One candle (or one sample: o = h = l = c) through the pattern. Returns the entry when this candle fills it.
 * Within a candle the order of high and low is unknown: a fill is taken at the zone's top or the candle's open,
 * whichever is lower, and the structure is updated from the candle's high only after the fill check.
 */
export function pocketStep(s: PocketState, r: PocketRules, bar: Candle): PocketEntry | null {
  if (finished(s)) return null;
  if (bar.t - s.startAt > r.maxPatternMin * MINUTE) { s.phase = 'EXPIRED'; s.detail = `no entry within ${r.maxPatternMin} min`; return null; }
  if (bar.l < r.floorUsd) { s.phase = 'FAILED'; s.detail = `traded at ${k(bar.l)}, below the ${k(r.floorUsd)} floor`; return null; }
  // Both variants run side by side; the first fill wins.
  const up = r.onlyUp ? onlyUpStep(s, r.onlyUp, bar) : null;
  if (up || !r.retest) return up;
  if (s.phase === 'IMPULSE') {
    // A candle that sets a new high: its low may have come before that high, only its close surely after.
    const newHigh = bar.h > (s.high ?? 0), after = newHigh ? bar.c : bar.l;
    s.high = Math.max(s.high ?? 0, bar.h);
    if (after <= s.high * (1 - r.dipMinPct / 100)) { s.phase = 'DIP'; s.low = after; s.detail = `${k(s.high)} → dip ${k(s.low)}`; }
    else s.detail = `impulse ${k(s.high)}`;
    if (s.phase === 'IMPULSE' || after >= s.high * (1 - r.dipMaxPct / 100)) return null;
  }
  if (s.phase === 'DIP') {
    s.low = Math.min(s.low!, bar.l);
    if (s.low < s.high! * (1 - r.dipMaxPct / 100)) { s.phase = 'FAILED'; s.detail = `dipped to ${k(s.low)}, more than ${r.dipMaxPct}% below the ${k(s.high)} high`; return null; }
    if (bar.h >= s.high! * r.breakoutOverHigh) { s.phase = 'BROKEN_OUT'; s.top = bar.h; s.breakoutAt = bar.t; s.detail = `${k(s.high)} → ${k(s.low)} → broke out to ${k(s.top)}`; }
    else s.detail = `${k(s.high)} → dip ${k(s.low)} · breakout at ${k(s.high! * r.breakoutOverHigh)}`;
    return null;
  }
  // Broken out: wait for the retest.
  if (bar.t - s.breakoutAt! > r.retestWindowMin * MINUTE) { s.phase = 'EXPIRED'; s.detail = `no retest within ${r.retestWindowMin} min of the breakout to ${k(s.top)}`; return null; }
  const { zone, stop } = pocketZone(r, s.high!, s.low!, s.top!);
  if (bar.l <= zone[1]) {
    if (bar.o < stop) { s.phase = 'FAILED'; s.detail = `fell through the ${k(zone[0])}–${k(zone[1])} pocket to ${k(bar.o)}`; return null; }
    const price = Math.min(zone[1], bar.o);
    s.phase = 'ENTRY';
    s.detail = `${k(s.high)} → ${k(s.low)} → ${k(s.top)} → retest at ${k(price)} (pocket ${k(zone[0])}–${k(zone[1])}, stop ${k(stop)})`;
    s.entry = { kind: 'RETEST', at: bar.t, price, stop, resistance: s.top!, zone, detail: s.detail };
    return s.entry;
  }
  s.top = Math.max(s.top!, bar.h);
  s.detail = `${k(s.high)} → ${k(s.low)} → ${k(s.top)} · buy at ${k(zone[1])}–${k(zone[0])}, stop ${k(stop)}`;
  return null;
}

/** Only-up variant: one-minute candles from the start; returns the entry when a return to the ref level fills it. */
function onlyUpStep(s: PocketState, u: OnlyUpRules, bar: Candle): PocketEntry | null {
  if (s.upBroken) return null;
  if (s.upRef === null) {
    const index = Math.max(0, Math.floor((bar.t - s.startAt) / MINUTE));
    // The first candles are the first minutes after the start: a pattern first seen later (a restart, a slow feed) is
    // never judged on whichever minutes came first.
    if (!s.minute && index !== s.upBars) { s.upBroken = true; return null; }
    // A minute is judged once the next one starts: it must close above its open and above the previous close.
    if (s.minute && index > s.minute.index) {
      const m = s.minute;
      s.minute = null;
      if (!(m.c > m.o && (s.upLastClose === null || m.c > s.upLastClose)) || index > m.index + 1) { s.upBroken = true; return null; }
      s.upBars++; s.upLastClose = m.c;
      if (s.upBars === u.ref) s.upRefClose = m.c;
      if (s.upBars >= u.bars) { s.upRef = s.upRefClose; s.upReadyAt = bar.t; }
    }
    if (s.upRef === null) {
      s.minute = s.minute ? { ...s.minute, h: Math.max(s.minute.h, bar.h), l: Math.min(s.minute.l, bar.l), c: bar.c } : { index, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
      s.upHigh = Math.max(s.upHigh ?? 0, bar.h);
      return null;
    }
  }
  if (bar.t - s.upReadyAt! > u.windowMin * MINUTE) { s.upBroken = true; return null; }
  const ref = s.upRef!, limit = ref * (1 + u.chasePct / 100), stop = ref * (1 - u.stopBelowPct / 100);
  if (bar.l <= limit) {
    if (bar.o < stop) { s.upBroken = true; return null; }
    const price = Math.min(limit, bar.o);
    s.phase = 'ENTRY';
    s.detail = `first ${u.bars} candles only up to ${k(s.upHigh)} → back to ${k(price)}, within ${u.chasePct}% of candle ${u.ref} (${k(ref)}), stop ${k(stop)}`;
    s.entry = { kind: 'ONLY_UP', at: bar.t, price, stop, resistance: s.upHigh!, zone: [ref, limit], detail: s.detail };
    return s.entry;
  }
  s.upHigh = Math.max(s.upHigh!, bar.h);
  return null;
}

// ------------------------------------------------------------------ live tracker


export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** pump.fun's PUMP token: some launches graduate into a PUMP-quoted pool (FIX6900, 6bQ4…SmvC). */
export const PUMP_QUOTE_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const QUOTE_DECIMALS: Record<string, number> = { [WSOL_MINT]: 9, [PUMP_QUOTE_MINT]: 6, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6 };
/** pump.fun tokens: 1B supply, 6 decimals. */
const PUMP_SUPPLY = 1e9, BASE_DECIMALS = 6;

/**
 * The PumpSwap pool a pump.fun graduation creates: index 0, created by the pump.fun pool-authority of the mint
 * (checked on chain on 1 Oct: 66hK2 → 827V45…, FIX6900 → 4qbokk…).
 */
export function pumpSwapPool(mint: string, quoteMint: string): string {
  const m = new PublicKey(mint);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], new PublicKey(PUMP_PROGRAM_ID));
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), Buffer.alloc(2), authority.toBuffer(), m.toBuffer(), new PublicKey(quoteMint).toBuffer()],
    new PublicKey(PUMP_AMM_PROGRAM))[0].toBase58();
}
/** PumpSwap Pool: base mint @43, quote mint @75, base vault @139, quote vault @171. */
export function decodePumpSwapPool(data: Buffer): { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string } | null {
  if (data.length < 203) return null;
  const key = (o: number) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  return { baseMint: key(43), quoteMint: key(75), baseVault: key(139), quoteVault: key(171) };
}
/** SPL token account (Token and Token-2022 alike): amount @64. */
const tokenAmount = (data: Buffer | null | undefined) => data && data.length >= 72 ? Number(data.readBigUInt64LE(64)) : null;

export const GOLDEN = Object.freeze({
  pollMs: 4_000,
  /** Pools watched at once; the oldest finished ones go first. */
  maxTracked: 400,
  /** A pool whose address cannot be read is given up after this many polls. */
  maxResolveTries: 5,
  /** Finished patterns stay listed this long. */
  keepMs: 30 * 60_000,
  /** A graduation first seen later than this is not watched: its first minutes are unknown (after a restart, say). */
  firstSampleWithinMs: 45_000,
});

export interface GoldenWatch {
  mint: string; symbol: string | null; startAt: number; state: PocketState;
  pool: string | null; vaults: { base: string; quote: string; quoteMint: string } | null; resolveTries: number;
  lastUsd: number | null; lastSampleAt: number | null; peakUsd: number | null;
  /** Minute candles of the pool's market cap since the graduation (structure(), the P2 shadow trades). */
  bars: Bar[];
}
export interface GoldenSignal {
  mint: string; symbol: string | null; entry: PocketEntry; at: number; pool: string | null;
  /** The first pool minute's high ÷ the graduation market cap (≈ 410.9 SOL); null when unknown. */
  poolJumpX?: number | null;
}
type Rpc = { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> };

/**
 * Watches every fresh graduation's PumpSwap pool from its graduation on (both reserves of up to 50 pools in one
 * call every few seconds), runs each through the pattern, and reports each fill once. Held tokens stay sampled for
 * the exits. Never throws.
 */
export class GoldenTracker {
  private readonly watches = new Map<string, GoldenWatch>();
  private readonly held = new Set<string>();
  private readonly followed = new Set<string>();
  /** Pools younger than this stay sampled whatever their pattern did (strategies that need the pool's structure). */
  private followMs = 0;
  constructor(private readonly rpc: Rpc, private readonly rules: PocketRules, private readonly shadow: GoldenShadow | null = null) {}

  /** Fresh graduations start being watched from their graduation time. */
  watchGraduations(list: Array<{ mint: string; at: number; symbol?: string | null }>, now: number): void {
    for (const g of list) {
      const known = this.watches.get(g.mint);
      if (known) { known.symbol ??= g.symbol ?? null; continue; }
      if (now - g.at > GOLDEN.firstSampleWithinMs) continue;
      this.watches.set(g.mint, { mint: g.mint, symbol: g.symbol ?? null, startAt: g.at, state: pocketState(g.at), pool: null, vaults: null,
        resolveTries: 0, lastUsd: null, lastSampleAt: null, peakUsd: null, bars: [] });
    }
    this.prune(now);
  }
  /** Mints the desk holds: sampled until sold, whatever their pattern did. */
  hold(mints: string[]): void { this.held.clear(); for (const m of mints) this.held.add(m); }
  /** Mints with open shadow trades (P2): sampled until those close. */
  follow(mints: string[]): void { this.followed.clear(); for (const m of mints) this.followed.add(m); }
  /** Keep every pool sampled for its first `ms` after the graduation (0: only while its pattern runs). */
  followYoung(ms: number): void { this.followMs = Math.max(0, ms); }

  private kept(mint: string): boolean { return this.held.has(mint) || this.followed.has(mint) || !!this.shadow?.has(mint); }
  private active(w: GoldenWatch, now: number): boolean {
    return this.kept(w.mint) || now - w.startAt <= this.followMs || w.state.phase === 'IMPULSE' || w.state.phase === 'DIP' || w.state.phase === 'BROKEN_OUT';
  }
  private prune(now: number): void {
    for (const [mint, w] of this.watches) {
      if (this.kept(mint)) continue;
      const end = w.startAt + Math.max(this.rules.maxPatternMin * 60_000, this.followMs);
      if (now > end + GOLDEN.keepMs || (!this.active(w, now) && now - (w.lastSampleAt ?? w.startAt) > GOLDEN.keepMs)) this.watches.delete(mint);
    }
    if (this.watches.size > GOLDEN.maxTracked) {
      const drop = [...this.watches.values()].filter(w => !this.kept(w.mint)).sort((a, b) => Number(this.active(a, now)) - Number(this.active(b, now)) || a.startAt - b.startAt)
        .slice(0, this.watches.size - GOLDEN.maxTracked);
      for (const w of drop) this.watches.delete(w.mint);
    }
  }

  /** Reads every watched pool; returns the fills of this read. `quoteUsd` prices the pool's quote token (SOL, PUMP). */
  async poll(now: number, quoteUsd: (quoteMint: string) => number | null): Promise<GoldenSignal[]> {
    const live = [...this.watches.values()].filter(w => this.active(w, now));
    // New pools: the canonical SOL- and PUMP-quoted addresses, whichever exists.
    const unresolved = live.filter(w => !w.vaults).slice(0, 50);
    if (unresolved.length) {
      const keys = unresolved.flatMap(w => [pumpSwapPool(w.mint, WSOL_MINT), pumpSwapPool(w.mint, PUMP_QUOTE_MINT)]);
      try {
        const infos = await this.rpc.execute('golden:pools', c => c.getMultipleAccountsInfo(keys.map(k => new PublicKey(k)), 'confirmed'));
        unresolved.forEach((w, i) => {
          w.resolveTries++;
          for (const j of [0, 1]) {
            const info = infos[2 * i + j];
            const pool = info && info.owner.toBase58() === PUMP_AMM_PROGRAM ? decodePumpSwapPool(Buffer.from(info.data)) : null;
            if (pool && pool.baseMint === w.mint) { w.pool = keys[2 * i + j]!; w.vaults = { base: pool.baseVault, quote: pool.quoteVault, quoteMint: pool.quoteMint }; break; }
          }
          if (!w.vaults && w.resolveTries >= GOLDEN.maxResolveTries) { w.state.phase = 'FAILED'; w.state.detail = 'no PumpSwap pool found'; }
        });
      } catch { /* RPC outage: retried next poll */ }
    }
    const ready = live.filter(w => w.vaults && QUOTE_DECIMALS[w.vaults.quoteMint] !== undefined && quoteUsd(w.vaults.quoteMint));
    const out: GoldenSignal[] = [];
    for (let i = 0; i < ready.length; i += 50) {
      const batch = ready.slice(i, i + 50);
      let infos: Array<{ data: Buffer } | null>;
      try {
        infos = await this.rpc.execute('golden:reserves', c => c.getMultipleAccountsInfo(batch.flatMap(w => [new PublicKey(w.vaults!.base), new PublicKey(w.vaults!.quote)]), 'confirmed')) as Array<{ data: Buffer } | null>;
      } catch { continue; }
      batch.forEach((w, j) => {
        const base = tokenAmount(infos[2 * j]?.data ? Buffer.from(infos[2 * j]!.data) : null), quote = tokenAmount(infos[2 * j + 1]?.data ? Buffer.from(infos[2 * j + 1]!.data) : null);
        const q = w.vaults!.quoteMint, usd = quoteUsd(q);
        if (!base || !quote || !usd) return;
        const cap = (quote / 10 ** QUOTE_DECIMALS[q]!) / (base / 10 ** BASE_DECIMALS) * PUMP_SUPPLY * usd;
        w.lastUsd = cap; w.lastSampleAt = now; w.peakUsd = Math.max(w.peakUsd ?? 0, cap);
        addSample(w.bars, w.startAt, now, cap);
        this.shadow?.sample(w.mint, cap, now);
        const entry = pocketStep(w.state, this.rules, { t: now, o: cap, h: cap, l: cap, c: cap });
        if (!entry) return;
        const sol = quoteUsd(WSOL_MINT), graduationUsd = sol ? GRADUATION_MCAP_SOL * sol : null, first = w.bars[0];
        const poolJumpX = graduationUsd && first && first.t + 60_000 <= now ? first.h / graduationUsd : null;
        if (entry.kind === 'ONLY_UP') this.shadow?.start({ mint: w.mint, symbol: w.symbol, fillAt: now, fillUsd: entry.price, stopUsd: entry.stop, poolJumpX, graduationUsd });
        out.push({ mint: w.mint, symbol: w.symbol, entry, at: now, pool: w.pool, poolJumpX });
      });
    }
    this.shadow?.expire(now, mint => { const w = this.watches.get(mint); return { cap: w?.lastUsd ?? null, at: w?.lastSampleAt ?? null }; });
    this.prune(now);
    return out;
  }

  get(mint: string): GoldenWatch | null { return this.watches.get(mint) ?? null; }
  /** Patterns in progress and fills, most advanced first. */
  list(): GoldenWatch[] {
    const rank: Record<PocketPhase, number> = { ENTRY: 0, BROKEN_OUT: 1, DIP: 2, IMPULSE: 3, EXPIRED: 4, FAILED: 5 };
    return [...this.watches.values()].filter(w => w.lastSampleAt !== null).sort((a, b) => rank[a.state.phase] - rank[b.state.phase] || b.startAt - a.startAt);
  }
  counts(): Record<PocketPhase, number> & { watched: number } {
    const out = { IMPULSE: 0, DIP: 0, BROKEN_OUT: 0, ENTRY: 0, FAILED: 0, EXPIRED: 0, watched: this.watches.size };
    for (const w of this.watches.values()) out[w.state.phase]++;
    return out;
  }
}

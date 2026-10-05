import fs from 'node:fs';
import type { ResearchLedger } from './ledger';

/**
 * Established coins with a blue check that start to move: an INFO message to the phone (not a call), and every
 * check a `VT` record so "verified movers" can be qualified like any other rule later.
 *
 * The check: Jupiter's verified tag (the blue check in Jupiter and most Solana wallets; `isVerified` in its free token
 * API), or a mint on the owner's watchlist (`watch-tokens.json` in the research folder) — FOMO's own check (E/ACC, SI)
 * is not public without a FOMO login, so coins verified only on FOMO go on the watchlist. The universe is Jupiter's
 * hourly top-trending, top-organic and top-traded lists plus the watchlist, every 5 minutes.
 */
export const VERIFIED = Object.freeze({
  everyMs: 5 * 60_000,
  lists: ['toptrending/1h', 'toporganicscore/1h', 'toptraded/1h'],
  /** Established: at least this market cap and pool liquidity (watchlist coins are exempt). */
  minMcapUsd: 1_000_000, minLiquidityUsd: 100_000,
  /** Not memecoins: stablecoins, staked SOL, majors, tokenised stocks. Wrapped and bridged coins keep a mint authority. */
  notMeme: ['stable', 'lst', 'major', 'xstocks', 'stocks', 'rwa'],
  /** Moving: up this much in the hour, still rising over 5 minutes, more buyers than sellers, organic score not low. */
  minRise1hPct: 15,
  perHour: 4,
  /** The same coin again only after 12 h, or once it has risen another 25 % since its last message. */
  againAfterMs: 12 * 3_600_000, againRisePct: 25, minGapMs: 60 * 60_000,
});

interface Stats {
  priceChange?: number; buyVolume?: number; sellVolume?: number; numTraders?: number; numNetBuyers?: number; numOrganicBuyers?: number;
  numBuys?: number; numSells?: number; holderChange?: number; buyOrganicVolume?: number; sellOrganicVolume?: number; liquidityChange?: number;
}
/** The fields of Jupiter's token API (v2) this module and the ladder (ladder.ts) read. */
export interface JupToken {
  id: string; name?: string; symbol?: string; usdPrice?: number; mcap?: number; liquidity?: number; holderCount?: number;
  organicScore?: number; organicScoreLabel?: string; isVerified?: boolean; tags?: string[]; launchpad?: string;
  mintAuthority?: string | null; freezeAuthority?: string | null; firstPool?: { createdAt?: string };
  stats5m?: Stats; stats1h?: Stats; stats6h?: Stats; stats24h?: Stats;
  dev?: string; audit?: { topHoldersPercentage?: number; devBalancePercentage?: number; devMints?: number; devMigrations?: number };
  twitter?: string; website?: string;
}
export interface WatchToken { mint: string; note?: string }
export interface VerifiedDeps {
  ledger: ResearchLedger;
  /** The watchlist file: [{ "mint": "...", "note": "blue check on FOMO" }]; read on every check, so edits apply at once. */
  watchFile?: string | null;
  notify?: ((title: string, body: string) => Promise<void>) | null;
  link?: (mint: string) => string;
  fetcher?: typeof fetch;
  /** Used when Jupiter's keyless host stops answering (api.jup.ag needs a key). */
  jupiterApiKey?: string | null;
  now?: () => number;
  log?: (line: string) => void;
}

const pct = (x: number | undefined) => x === undefined ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(x > -10 && x < 10 ? 1 : 0)}%`;
const usd = (x: number | undefined) => x === undefined ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}K`;

/** Why a coin's move is worth a look, or null. */
export function moving(t: JupToken): string | null {
  const h1 = t.stats1h?.priceChange, m5 = t.stats5m?.priceChange;
  if (h1 === undefined || m5 === undefined || h1 < VERIFIED.minRise1hPct || m5 < 0) return null;
  if ((t.stats1h?.numNetBuyers ?? 0) <= 0 || (t.stats1h?.buyVolume ?? 0) <= (t.stats1h?.sellVolume ?? 0)) return null;
  if (!t.organicScoreLabel || t.organicScoreLabel === 'low') return null;
  return `up ${pct(h1)} in 1h`;
}

/** Jupiter's token API (v2): the free keyless host, and once it refuses, the keyed host (api.jup.ag) from then on. */
export class JupiterTokens {
  private keyless = true;
  constructor(private readonly o: { fetcher?: typeof fetch; apiKey?: string | null } = {}) {}

  async get(path: string): Promise<JupToken[]> {
    const fetcher = this.o.fetcher ?? fetch;
    const hosts: Array<[string, Record<string, string>]> = [];
    if (this.keyless) hosts.push(['https://lite-api.jup.ag', {}]);
    if (this.o.apiKey) hosts.push(['https://api.jup.ag', { 'x-api-key': this.o.apiKey }]);
    let last = 'no Jupiter host';
    for (const [host, headers] of hosts) {
      const res = await fetcher(`${host}/tokens/v2/${path}`, { headers, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => { last = e.name; return null; });
      if (res?.ok) { const j = await res.json() as unknown; return Array.isArray(j) ? j as JupToken[] : []; }
      if (res) last = `HTTP ${res.status}`;
      // The keyless host is being retired: once it refuses, use the key from then on.
      if (res && host.includes('lite-api') && [401, 403, 404, 410].includes(res.status) && this.o.apiKey) this.keyless = false;
    }
    throw new Error(last);
  }
}

export class VerifiedWatch {
  private readonly sent = new Map<string, { at: number; price: number }>();
  private readonly hour: number[] = [];
  private readonly jupiter: JupiterTokens;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { checks: 0, tokens: 0, info: 0, errors: 0, lastError: null as string | null };
  constructor(private readonly d: VerifiedDeps) { this.jupiter = new JupiterTokens({ fetcher: d.fetcher, apiKey: d.jupiterApiKey }); }

  private get now(): number { return (this.d.now ?? Date.now)(); }

  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.check(), 30_000).unref?.();
    this.timer = setInterval(() => void this.check(), VERIFIED.everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  status(): string { return `verified coins: ${this.stats.tokens} watched, ${this.stats.info} INFO${this.stats.lastError ? ` (last error: ${this.stats.lastError})` : ''}`; }

  watchlist(): WatchToken[] {
    if (!this.d.watchFile) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.watchFile, 'utf8')) as unknown;
      return (Array.isArray(raw) ? raw : []).filter((x): x is WatchToken => !!x && typeof x === 'object' && typeof (x as WatchToken).mint === 'string'
        && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test((x as WatchToken).mint));
    } catch { return []; }
  }

  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now, watch = new Map(this.watchlist().map(w => [w.mint, w] as const));
      const all = new Map<string, JupToken>();
      for (const list of VERIFIED.lists) for (const t of await this.jupiter.get(`${list}?limit=100`)) all.set(t.id, t);
      const missing = [...watch.keys()].filter(m => !all.has(m));
      for (let i = 0; i < missing.length; i += 50) for (const t of await this.jupiter.get(`search?query=${missing.slice(i, i + 50).join(',')}`)) if (watch.has(t.id)) all.set(t.id, t);
      let n = 0;
      for (const t of all.values()) {
        const w = watch.get(t.id), checks = [t.isVerified ? 'Jupiter' : null, t.tags?.includes('moonshot-verified') ? 'Moonshot' : null].filter(Boolean) as string[];
        if (!w && !t.isVerified) continue;
        if (!w && (t.tags?.some(x => VERIFIED.notMeme.includes(x)) || t.mintAuthority || t.freezeAuthority
          || (t.mcap ?? 0) < VERIFIED.minMcapUsd || (t.liquidity ?? 0) < VERIFIED.minLiquidityUsd)) continue;
        n++;
        const s = t.stats1h ?? {};
        this.d.ledger.put(['VT', now, { $m: t.id }, t.symbol ?? null, `${t.isVerified ? 'J' : ''}${checks.includes('Moonshot') ? 'M' : ''}${w ? 'W' : ''}`,
          t.mcap ?? null, t.liquidity ?? null, t.holderCount ?? null, t.organicScore ?? null, t.usdPrice ?? null,
          t.stats5m?.priceChange ?? null, s.priceChange ?? null, t.stats6h?.priceChange ?? null, t.stats24h?.priceChange ?? null,
          s.numNetBuyers ?? null, s.buyVolume ?? null, s.sellVolume ?? null, s.numTraders ?? null]);
        const why = moving(t);
        if (why) this.info(t, why, checks, w ?? null, now);
      }
      this.stats.checks++; this.stats.tokens = n; this.stats.lastError = null;
    } catch (error) {
      this.stats.errors++; this.stats.lastError = (error as Error).message;
      this.d.log?.(`verified coins: ${(error as Error).message}`);
    } finally { this.busy = false; }
  }

  private info(t: JupToken, why: string, checks: string[], w: WatchToken | null, now: number): void {
    if (!this.d.notify || !t.usdPrice) return;
    const prev = this.sent.get(t.id);
    if (prev && (now - prev.at < VERIFIED.minGapMs || (now - prev.at < VERIFIED.againAfterMs && t.usdPrice < prev.price * (1 + VERIFIED.againRisePct / 100)))) return;
    while (this.hour.length && now - this.hour[0]! > 3_600_000) this.hour.shift();
    if (this.hour.length >= VERIFIED.perHour) return;
    this.hour.push(now); this.sent.set(t.id, { at: now, price: t.usdPrice }); this.stats.info++;
    const s = t.stats1h ?? {}, sym = t.symbol ?? t.id.slice(0, 6);
    const age = t.firstPool?.createdAt ? (now - Date.parse(t.firstPool.createdAt)) / 86_400_000 : null;
    const check = [...checks.map(c => `${c} verified`), ...(w ? [w.note?.trim() || 'your watchlist'] : [])].join(' · ');
    const body = [
      `Not a qualified call — for your eyes.`,
      `${t.name ?? sym} (${sym}) · blue check: ${check}.`,
      `${usd(t.mcap)} market cap · ${usd(t.liquidity)} liquidity · ${(t.holderCount ?? 0).toLocaleString('en-US')} holders · organic score ${Math.round(t.organicScore ?? 0)} (${t.organicScoreLabel ?? '–'}).`,
      `Price ${pct(t.stats5m?.priceChange)} 5m · ${pct(s.priceChange)} 1h · ${pct(t.stats6h?.priceChange)} 6h · ${pct(t.stats24h?.priceChange)} 24h.`,
      `Last hour: ${(s.numTraders ?? 0).toLocaleString('en-US')} traders, ${s.numNetBuyers ?? 0} more buyers than sellers, bought ${usd(s.buyVolume)} vs sold ${usd(s.sellVolume)}.`,
      age !== null ? `Trading for ${age < 2 ? `${Math.round(age * 24)} h` : `${Math.round(age)} days`}${t.launchpad ? ` · from ${t.launchpad}` : ''}.` : '',
      this.d.link ? this.d.link(t.id) : `https://jup.ag/tokens/${t.id}`,
    ].filter(Boolean).join('\n');
    this.d.ledger.put(['VINFO', now, { $m: t.id }, sym, why, check, t.mcap ?? null, t.usdPrice]);
    void this.d.notify(`INFO ${sym}: verified coin ${why}`, body).catch(() => undefined);
  }
}

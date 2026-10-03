import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Field, ResearchLedger } from './ledger';
import { JupiterTokens, type JupToken, type WatchToken } from './verified';
import { scanHolders, type HolderRpc, type HolderScan } from './holders';

/**
 * The market-cap ladder: coins on every chain that trade at $10K or more, recorded every 10 minutes, so the research
 * layer can study the owner's own way of trading: the decade levels ($10K → $100K → $1M → $10M → $100M), a coin far
 * below its all-time high (WWW: $1.15M after $8.2M), and old runners coming back (hot in May–July, fell, rising again).
 *
 *   - Universe: Jupiter's top trending / organic / traded lists (Solana, with holders and organic volume), GeckoTerminal's
 *     trending pools across every chain (Ethereum, Base, BNB, Robinhood Chain, …), and the owner's watchlist.
 *   - A coin seen once is tracked for 7 days after it was last on a list, so its fall is recorded too, not only its rise.
 *   - History: the all-time high, the 30-day low and the price a week ago, from Birdeye (Solana) or GeckoTerminal candles.
 *   - Holders (Solana, from $1M or on the watchlist): the largest wallets, who funded them, clusters, the team's share.
 *
 * Facts only (records LT, LS, LA, LH in their own ledger folder); scripts/research-ladder.ts measures what followed.
 * Nothing here trades or messages the phone.
 */
export const LADDER = Object.freeze({
  everyMs: 10 * 60_000,
  minMcapUsd: 10_000, maxMcapUsd: 2e9, minLiquidityUsd: 10_000,
  jupiterLists: ['toptrending/1h', 'toporganicscore/1h', 'toptraded/1h', 'toptrending/24h', 'toporganicscore/24h'],
  gtTrendingPages: 2,
  /** Not memecoins (Jupiter tags) and the majors that trend as a pool's base token. */
  notMeme: ['stable', 'lst', 'major', 'xstocks', 'stocks', 'rwa'],
  majors: ['SOL', 'WSOL', 'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'USDC', 'USDT', 'DAI', 'BNB', 'WBNB', 'USD1', 'USDE', 'PYUSD'],
  trackDays: 7, maxTracked: 1_200,
  jupiterBatch: 50, jupiterRefreshCalls: 24, gtMultiBatch: 30, gtMultiCalls: 4,
  /** GeckoTerminal's free API allows about 30 calls a minute per machine, shared with the desk: space them, back off on 429. */
  gtGapMs: 2_500, birdeyeGapMs: 1_200, cooldownMs: 5 * 60_000,
  historyPerCycle: 4, historyRefreshMs: 24 * 3_600_000, hourCandlesBelowDays: 10,
  holderScansPerCycle: 2, holderMinMcapUsd: 1_000_000, holderRefreshMs: 24 * 3_600_000,
});

export const TIERS = [['micro', 1e5], ['low', 1e6], ['mid', 1e7], ['high', 1e8], ['large', Infinity]] as const;
export type Tier = typeof TIERS[number][0];
export const tierOf = (mcap: number): Tier => TIERS.find(([, below]) => mcap < below)![0];
/** The decade levels around a market cap: $1.15M sits between $1M and $10M. */
export function levels(mcap: number): { below: number; above: number } {
  const below = 10 ** Math.floor(Math.log10(Math.max(mcap, 1)));
  return { below, above: below * 10 };
}

/** One coin at one moment, from either source (fields a source lacks are null). */
export interface LadderCoin {
  key: string; net: string; address: string; pool: string | null; symbol: string | null; name: string | null; dev: string | null; src: string;
  mcap: number | null; liq: number | null; price: number | null; holders: number | null; organic: number | null;
  ch1h: number | null; ch6h: number | null; ch24h: number | null;
  buys1h: number | null; sells1h: number | null; buyers1h: number | null; sellers1h: number | null;
  vol1h: number | null; buyVol1h: number | null; sellVol1h: number | null; orgBuyVol1h: number | null; orgSellVol1h: number | null;
  netBuyers1h: number | null; holderCh1h: number | null; holderCh24h: number | null; topPct: number | null; devPct: number | null; createdAt: number | null;
}
/** The LS record's fields after its type, time and coin, in order. */
export const LS_FIELDS = ['src', 'symbol', 'mcap', 'liq', 'price', 'holders', 'organic', 'ch1h', 'ch6h', 'ch24h', 'buys1h', 'sells1h', 'buyers1h', 'sellers1h',
  'vol1h', 'buyVol1h', 'sellVol1h', 'orgBuyVol1h', 'orgSellVol1h', 'netBuyers1h', 'holderCh1h', 'holderCh24h', 'topPct', 'devPct', 'createdAt'] as const;
export type Snapshot = { at: number } & { [K in typeof LS_FIELDS[number]]: LadderCoin[K] };

/** A coin known only by its address (watchlist, or a Solana pool seen on GeckoTerminal) until its first snapshot. */
export function blank(net: string, address: string, src: string): LadderCoin {
  const none = Object.fromEntries(LS_FIELDS.map(f => [f, null]));
  return { ...none, key: `${net}:${address}`, net, address, pool: null, symbol: null, name: null, dev: null, src } as LadderCoin;
}

const num = (x: unknown): number | null => { const n = typeof x === 'string' ? Number(x) : x; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const round = (x: number | null, d = 2) => x === null ? null : Math.abs(x) >= 1_000 ? Math.round(x) : Number(x.toFixed(d));
const sig = (x: number | null) => x === null ? null : Number(x.toPrecision(6));
const time = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

export function fromJupiter(t: JupToken, src: string): LadderCoin {
  const h = t.stats1h ?? {};
  return { key: `solana:${t.id}`, net: 'solana', address: t.id, pool: null, symbol: t.symbol ?? null, name: t.name ?? null, dev: t.dev ?? null, src,
    mcap: num(t.mcap), liq: num(t.liquidity), price: num(t.usdPrice), holders: num(t.holderCount), organic: num(t.organicScore),
    ch1h: num(h.priceChange), ch6h: num(t.stats6h?.priceChange), ch24h: num(t.stats24h?.priceChange),
    buys1h: num(h.numBuys), sells1h: num(h.numSells), buyers1h: null, sellers1h: null,
    vol1h: h.buyVolume !== undefined || h.sellVolume !== undefined ? (h.buyVolume ?? 0) + (h.sellVolume ?? 0) : null,
    buyVol1h: num(h.buyVolume), sellVol1h: num(h.sellVolume), orgBuyVol1h: num(h.buyOrganicVolume), orgSellVol1h: num(h.sellOrganicVolume),
    netBuyers1h: num(h.numNetBuyers), holderCh1h: num(h.holderChange), holderCh24h: num(t.stats24h?.holderChange),
    topPct: num(t.audit?.topHoldersPercentage), devPct: num(t.audit?.devBalancePercentage), createdAt: time(t.firstPool?.createdAt) };
}

interface GtTx { buys?: number; sells?: number; buyers?: number; sellers?: number }
export interface GtPool {
  id: string;
  attributes: { address: string; base_token_price_usd?: string | null; fdv_usd?: string | null; market_cap_usd?: string | null; reserve_in_usd?: string | null;
    pool_created_at?: string | null; price_change_percentage?: Record<string, string | null>; transactions?: Record<string, GtTx>; volume_usd?: Record<string, string | null> };
  relationships?: { base_token?: { data?: { id?: string } }; network?: { data?: { id?: string } } };
}
interface GtToken { id: string; attributes?: { address?: string; name?: string; symbol?: string } }
interface GtList { data?: GtPool[]; included?: GtToken[] }

export function fromGecko(p: GtPool, tokens: ReadonlyMap<string, GtToken>, src: string, known?: { symbol: string | null; name: string | null }): LadderCoin | null {
  const a = p.attributes, baseId = p.relationships?.base_token?.data?.id;
  const net = p.relationships?.network?.data?.id ?? p.id.slice(0, p.id.lastIndexOf('_'));
  if (!baseId || !net || !baseId.startsWith(`${net}_`)) return null;
  const address = baseId.slice(net.length + 1), t = tokens.get(baseId)?.attributes, tx = a.transactions?.h1;
  return { key: `${net}:${address}`, net, address, pool: a.address, symbol: t?.symbol ?? known?.symbol ?? null, name: t?.name ?? known?.name ?? null, dev: null, src,
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd), liq: num(a.reserve_in_usd), price: num(a.base_token_price_usd), holders: null, organic: null,
    ch1h: num(a.price_change_percentage?.h1), ch6h: num(a.price_change_percentage?.h6), ch24h: num(a.price_change_percentage?.h24),
    buys1h: num(tx?.buys), sells1h: num(tx?.sells), buyers1h: num(tx?.buyers), sellers1h: num(tx?.sellers),
    vol1h: num(a.volume_usd?.h1), buyVol1h: null, sellVol1h: null, orgBuyVol1h: null, orgSellVol1h: null,
    netBuyers1h: null, holderCh1h: null, holderCh24h: null, topPct: null, devPct: null, createdAt: time(a.pool_created_at) };
}

export function eligible(c: LadderCoin, t?: JupToken): boolean {
  if (c.mcap === null || c.mcap < LADDER.minMcapUsd || c.mcap > LADDER.maxMcapUsd || (c.liq ?? 0) < LADDER.minLiquidityUsd) return false;
  if (c.symbol && LADDER.majors.includes(c.symbol.toUpperCase())) return false;
  return !t || (!t.tags?.some(x => LADDER.notMeme.includes(x)) && !t.mintAuthority && !t.freezeAuthority);
}

export function snapshotRecord(c: LadderCoin, at: number): Field[] {
  const v = (k: typeof LS_FIELDS[number]) => {
    const x = c[k];
    if (typeof x !== 'number') return x;
    return k === 'price' ? sig(x) : k === 'createdAt' ? x : round(x);
  };
  return ['LS', at, { $m: c.key }, ...LS_FIELDS.map(v)];
}

/** Candles reduced to what the study needs, in market cap (price × the coin's supply). */
export interface History { athMcap: number; athAt: number; low30Mcap: number | null; low30At: number | null; close7Mcap: number | null; candles: number; interval: string }
export function history(candles: Array<{ t: number; h: number; l: number; c: number }>, supply: number, now: number, interval: string): History | null {
  const k = candles.filter(x => [x.t, x.h, x.l, x.c].every(Number.isFinite) && x.h > 0).sort((a, b) => a.t - b.t);
  if (!k.length) return null;
  const top = k.reduce((a, x) => x.h > a.h ? x : a, k[0]!);
  const recent = k.filter(x => x.t >= now - 30 * 86_400_000), low = recent.length ? recent.reduce((a, x) => x.l < a.l ? x : a, recent[0]!) : null;
  const weekAgo = k.filter(x => x.t <= now - 7 * 86_400_000).at(-1) ?? null;
  return { athMcap: top.h * supply, athAt: top.t, low30Mcap: low ? low.l * supply : null, low30At: low?.t ?? null, close7Mcap: weekAgo ? weekAgo.c * supply : null,
    candles: k.length, interval };
}

interface Track {
  key: string; net: string; address: string; pool: string | null; symbol: string | null; dev: string | null; firstAt: number; listedAt: number;
  mcap: number | null; price: number | null; createdAt: number | null; historyAt: number | null; holdersAt: number | null;
}
export interface LadderDeps {
  ledger: ResearchLedger;
  /** Tracked coins and their last history and holder scan, so a restart does not start over. */
  stateFile?: string | null;
  watchFile?: string | null;
  fetcher?: typeof fetch;
  jupiterApiKey?: string | null;
  birdeyeApiKey?: string | null;
  /** Holder scans over this Solana RPC; none without it. */
  holders?: HolderRpc | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** A spaced, self-throttling HTTP getter: a 429 rests the source for `cooldownMs`. */
class Spaced {
  private last = 0;
  private restUntil = 0;
  constructor(private readonly gapMs: number, private readonly d: LadderDeps) {}
  private get now() { return (this.d.now ?? Date.now)(); }
  resting(): boolean { return this.now < this.restUntil; }
  async json<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
    if (this.resting()) return null;
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(wait);
    this.last = Date.now();
    const res = await (this.d.fetcher ?? fetch)(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.status === 429) { this.restUntil = this.now + LADDER.cooldownMs; return null; }
    return res?.ok ? await res.json() as T : null;
  }
}
const GT = 'https://api.geckoterminal.com/api/v2';

export class LadderWatch {
  private readonly tracks = new Map<string, Track>();
  private readonly jupiter: JupiterTokens;
  private readonly gecko: Spaced;
  private readonly birdeye: Spaced;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { checks: 0, snapshots: 0, histories: 0, holderScans: 0, errors: 0, lastError: null as string | null };

  constructor(private readonly d: LadderDeps) {
    this.jupiter = new JupiterTokens({ fetcher: d.fetcher, apiKey: d.jupiterApiKey });
    this.gecko = new Spaced(LADDER.gtGapMs, d);
    this.birdeye = new Spaced(LADDER.birdeyeGapMs, d);
    this.load();
  }
  private get now(): number { return (this.d.now ?? Date.now)(); }

  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.check(), 90_000).unref?.();
    this.timer = setInterval(() => void this.check(), LADDER.everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  status(): string {
    const chains = new Map<string, number>();
    for (const t of this.tracks.values()) chains.set(t.net, (chains.get(t.net) ?? 0) + 1);
    return `ladder: ${this.tracks.size} coins tracked (${[...chains].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ${c}`).join(', ') || 'none yet'}), ` +
      `${this.stats.histories} histories, ${this.stats.holderScans} holder scans${this.stats.lastError ? ` (last error: ${this.stats.lastError})` : ''}`;
  }
  tracked(): string[] { return [...this.tracks.keys()]; }

  private watchlist(): WatchToken[] {
    if (!this.d.watchFile) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.watchFile, 'utf8')) as unknown;
      return (Array.isArray(raw) ? raw : []).filter((x): x is WatchToken => !!x && typeof (x as WatchToken).mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test((x as WatchToken).mint));
    } catch { return []; }
  }

  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now, seen = new Map<string, LadderCoin>(), watch = new Set(this.watchlist().map(w => `solana:${w.mint}`));
      for (const list of LADDER.jupiterLists) {
        for (const t of await this.jupiter.get(`${list}?limit=100`).catch(e => this.fail(e, []))) { const c = fromJupiter(t, 'list'); if (eligible(c, t)) seen.set(c.key, c); }
      }
      // Every chain: Solana pools only start tracking (Jupiter has the richer data for them).
      const solanaFromGt: string[] = [];
      for (let page = 1; page <= LADDER.gtTrendingPages; page++) {
        const r = await this.gecko.json<GtList>(`${GT}/networks/trending_pools?page=${page}&include=base_token`);
        if (!r) break;
        const tokens = new Map((r.included ?? []).map(t => [t.id, t] as const));
        for (const p of r.data ?? []) {
          const c = fromGecko(p, tokens, 'trending');
          if (!c || !eligible(c)) continue;
          if (c.net === 'solana') solanaFromGt.push(c.address); else seen.set(c.key, c);
        }
      }
      for (const c of seen.values()) this.track(c, now);
      for (const key of [...watch, ...solanaFromGt.map(a => `solana:${a}`)]) if (!this.tracks.has(key)) this.track(blank('solana', key.slice(7), watch.has(key) ? 'watch' : 'trending'), now);
      for (const a of solanaFromGt) this.tracks.get(`solana:${a}`)!.listedAt = now;
      this.prune(now, watch);

      // Coins tracked but not on a list this time: refreshed so their fall is recorded too.
      const quiet = [...this.tracks.values()].filter(t => !seen.has(t.key)).sort((a, b) => Number(watch.has(b.key)) - Number(watch.has(a.key)) || b.listedAt - a.listedAt);
      const sol = quiet.filter(t => t.net === 'solana').slice(0, LADDER.jupiterBatch * LADDER.jupiterRefreshCalls).map(t => t.address);
      for (let i = 0; i < sol.length; i += LADDER.jupiterBatch) {
        for (const t of await this.jupiter.get(`search?query=${sol.slice(i, i + LADDER.jupiterBatch).join(',')}`).catch(e => this.fail(e, []))) {
          const c = fromJupiter(t, watch.has(`solana:${t.id}`) ? 'watch' : 'track');
          if (this.tracks.has(c.key)) seen.set(c.key, c);
        }
      }
      const byNet = new Map<string, Track[]>();
      for (const t of quiet) if (t.net !== 'solana' && t.pool) byNet.set(t.net, [...(byNet.get(t.net) ?? []), t]);
      let calls = 0;
      for (const [net, list] of byNet) for (let i = 0; i < list.length && calls < LADDER.gtMultiCalls; i += LADDER.gtMultiBatch, calls++) {
        const part = list.slice(i, i + LADDER.gtMultiBatch), known = new Map(part.map(t => [t.pool!, t] as const));
        const r = await this.gecko.json<GtList>(`${GT}/networks/${net}/pools/multi/${part.map(t => t.pool).join(',')}`);
        for (const p of r?.data ?? []) {
          const t = known.get(p.attributes.address), c = fromGecko(p, new Map(), 'track', t ? { symbol: t.symbol, name: null } : undefined);
          if (c && this.tracks.has(c.key)) seen.set(c.key, c);
        }
      }

      for (const c of seen.values()) {
        this.d.ledger.put(snapshotRecord(c, now));
        const t = this.tracks.get(c.key);
        if (t) Object.assign(t, { mcap: c.mcap ?? t.mcap, price: c.price ?? t.price, symbol: c.symbol ?? t.symbol, dev: c.dev ?? t.dev, createdAt: c.createdAt ?? t.createdAt, pool: c.pool ?? t.pool });
      }
      this.stats.snapshots += seen.size;
      await this.histories(now, watch);
      await this.holderScans(now, watch);
      this.stats.checks++; this.stats.lastError = null;
      this.save();
    } catch (error) {
      this.fail(error, null);
    } finally { this.busy = false; }
  }

  private fail<T>(error: unknown, value: T): T {
    this.stats.errors++; this.stats.lastError = (error as Error).message;
    this.d.log?.(`ladder: ${(error as Error).message}`);
    return value;
  }

  private track(c: LadderCoin, now: number): void {
    const t = this.tracks.get(c.key);
    if (t) { t.listedAt = now; return; }
    this.tracks.set(c.key, { key: c.key, net: c.net, address: c.address, pool: c.pool, symbol: c.symbol, dev: c.dev, firstAt: now, listedAt: now,
      mcap: c.mcap, price: c.price, createdAt: c.createdAt, historyAt: null, holdersAt: null });
    this.d.ledger.put(['LT', now, { $m: c.key }, c.net, c.address, c.pool, c.symbol, c.name, c.dev, c.src]);
  }

  /** Drops coins off every list for 7 days (never the watchlist), then the longest-quiet ones above the cap. */
  private prune(now: number, watch: ReadonlySet<string>): void {
    for (const [k, t] of this.tracks) if (!watch.has(k) && now - t.listedAt > LADDER.trackDays * 86_400_000) this.tracks.delete(k);
    const extra = this.tracks.size - LADDER.maxTracked;
    if (extra > 0) for (const t of [...this.tracks.values()].filter(t => !watch.has(t.key)).sort((a, b) => a.listedAt - b.listedAt).slice(0, extra)) this.tracks.delete(t.key);
  }

  /** All-time high, 30-day low and last week's close, for coins without one (the watchlist first, then the largest). */
  private async histories(now: number, watch: ReadonlySet<string>): Promise<void> {
    const due = [...this.tracks.values()].filter(t => t.mcap && t.price && (t.historyAt === null || now - t.historyAt > LADDER.historyRefreshMs))
      .sort((a, b) => Number(watch.has(b.key)) - Number(watch.has(a.key)) || (b.mcap ?? 0) - (a.mcap ?? 0)).slice(0, LADDER.historyPerCycle);
    for (const t of due) {
      const supply = t.mcap! / t.price!, young = t.createdAt !== null && now - t.createdAt < LADDER.hourCandlesBelowDays * 86_400_000;
      let h: History | null = null, src = '';
      if (t.net === 'solana' && this.d.birdeyeApiKey) {
        const from = young ? Math.max(t.createdAt! - 3_600_000, now - LADDER.hourCandlesBelowDays * 86_400_000) : now - 365 * 86_400_000;
        const r = await this.birdeye.json<{ data?: { items?: Array<{ unixTime: number; h: number; l: number; c: number }> } }>(
          `https://public-api.birdeye.so/defi/ohlcv?address=${t.address}&type=${young ? '1H' : '1D'}&time_from=${Math.floor(from / 1000)}&time_to=${Math.floor(now / 1000)}`,
          { 'X-API-KEY': this.d.birdeyeApiKey, 'x-chain': 'solana' });
        h = history((r?.data?.items ?? []).map(k => ({ t: k.unixTime * 1000, h: k.h, l: k.l, c: k.c })), supply, now, young ? '1H' : '1D'); src = 'birdeye';
      }
      if (!h && !this.gecko.resting()) {
        if (!t.pool && t.net === 'solana') t.pool = (await this.gecko.json<GtList>(`${GT}/networks/solana/tokens/${t.address}/pools?page=1`))?.data?.[0]?.attributes.address ?? null;
        if (t.pool) {
          const r = await this.gecko.json<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(`${GT}/networks/${t.net}/pools/${t.pool}/ohlcv/${young ? 'hour' : 'day'}?limit=${young ? 240 : 365}&currency=usd`);
          h = history((r?.data?.attributes?.ohlcv_list ?? []).map(k => ({ t: k[0]! * 1000, h: k[2]!, l: k[3]!, c: k[4]! })), supply, now, young ? 'hour' : 'day'); src = 'geckoterminal';
        }
      }
      if (!h) continue;
      t.historyAt = now; this.stats.histories++;
      this.d.ledger.put(['LA', now, { $m: t.key }, src, h.interval, h.candles, Math.round(h.athMcap), h.athAt, round(h.low30Mcap), h.low30At, round(h.close7Mcap)]);
    }
  }

  private async holderScans(now: number, watch: ReadonlySet<string>): Promise<void> {
    if (!this.d.holders) return;
    const due = [...this.tracks.values()].filter(t => t.net === 'solana' && (watch.has(t.key) || (t.mcap ?? 0) >= LADDER.holderMinMcapUsd)
      && (t.holdersAt === null || now - t.holdersAt > LADDER.holderRefreshMs))
      .sort((a, b) => Number(watch.has(b.key)) - Number(watch.has(a.key)) || (b.mcap ?? 0) - (a.mcap ?? 0)).slice(0, LADDER.holderScansPerCycle);
    for (const t of due) {
      t.holdersAt = now;
      const s = await scanHolders(this.d.holders, t.address, { dev: t.dev, now }).catch(e => this.fail(e, null));
      if (!s) continue;
      this.stats.holderScans++;
      this.d.ledger.put(['LH', now, { $m: t.key }, holderRecord(s)]);
    }
  }

  private load(): void {
    if (!this.d.stateFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.stateFile, 'utf8')) as { tracks?: Track[] };
      for (const t of raw.tracks ?? []) if (t && typeof t.key === 'string') this.tracks.set(t.key, t);
    } catch { /* first run */ }
  }
  private save(): void {
    if (!this.d.stateFile) return;
    try { fs.writeFileSync(this.d.stateFile, JSON.stringify({ savedAt: this.now, tracks: [...this.tracks.values()] })); } catch (e) { this.fail(e, null); }
  }
}

export function holderRecord(s: HolderScan): Record<string, unknown> {
  const r = (x: number) => Number(x.toFixed(2));
  return { top: r(s.topPct), prog: r(s.programPct), wal: r(s.walletPct), clu: r(s.clusterPct), team: r(s.teamPct), fresh: r(s.freshPct),
    largest: s.largest ? { funder: s.largest.funder, pct: r(s.largest.pct), wallets: s.largest.wallets } : null, dev: s.dev, devFunder: s.devFunder, services: s.services.length,
    holders: s.holders.map(h => [h.owner, r(h.pct), h.kind === 'program' ? 'P' : 'W', h.funder, h.cluster, h.team ? 1 : 0, h.firstAt, h.busy ? 1 : 0]) };
}

/** Everything the ladder recorded about one coin. */
export interface LadderCoinData {
  key: string; net: string; symbol: string | null; snaps: Snapshot[];
  histories: Array<{ at: number; athMcap: number; athAt: number; low30Mcap: number | null; close7Mcap: number | null }>;
  holders: Array<{ at: number; clu: number; team: number; fresh: number; top: number }>;
}
export function readLadder(files: string[]): Map<string, LadderCoinData> {
  const out = new Map<string, LadderCoinData>();
  const coin = (key: string) => {
    let c = out.get(key);
    if (!c) { c = { key, net: key.slice(0, key.indexOf(':')), symbol: null, snaps: [], histories: [], holders: [] }; out.set(key, c); }
    return c;
  };
  for (const file of files) {
    const raw = fs.readFileSync(file), text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'), mints: string[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: unknown[];
      try { r = JSON.parse(line) as unknown[]; } catch { continue; }
      if (r[0] === 'M') { mints[r[1] as number] = r[2] as string; continue; }
      const key = mints[r[2] as number];
      if (!key) continue;
      if (r[0] === 'LS') {
        const s = { at: r[1] as number } as Snapshot;
        LS_FIELDS.forEach((f, i) => { (s as Record<string, unknown>)[f] = r[3 + i] ?? null; });
        const c = coin(key); c.snaps.push(s); c.symbol = s.symbol ?? c.symbol;
      } else if (r[0] === 'LA') coin(key).histories.push({ at: r[1] as number, athMcap: r[6] as number, athAt: r[7] as number, low30Mcap: r[8] as number | null, close7Mcap: r[10] as number | null });
      else if (r[0] === 'LH') { const h = r[3] as Record<string, number>; coin(key).holders.push({ at: r[1] as number, clu: h.clu!, team: h.team!, fresh: h.fresh!, top: h.top! }); }
      else if (r[0] === 'LT' && typeof r[6] === 'string') coin(key).symbol ??= r[6];
    }
  }
  for (const c of out.values()) { c.snaps.sort((a, b) => a.at - b.at); c.histories.sort((a, b) => a.at - b.at); c.holders.sort((a, b) => a.at - b.at); }
  return out;
}

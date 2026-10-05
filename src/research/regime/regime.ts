import { stdev } from '../core/stats';
import type { EventInput, ResearchEvent } from '../events/types';
import type { PointInTimeView } from '../pit/view';

/**
 * Market regime at a decision time, from what was known then. The desk's results so far come from a few days of one
 * market; a rule that works while SOL rallies and launches are hot is a different claim from a rule that works always.
 * Every backtest trade carries the regime label at its decision, and results are reported per regime.
 *
 * Reference prices are MarketSnapshot events on pseudo-tokens `REF:BTC` and `REF:SOL` (see `referencePriceEvents`).
 */

export type Trend = 'UP' | 'DOWN' | 'FLAT';
export type Vol = 'HIGH' | 'NORMAL' | 'LOW';
export interface AssetRegime { price: number; returnPct24h: number | null; volatilityPct24h: number | null; trend: Trend | null; vol: Vol | null }
export interface RegimeSnapshot {
  at: number;
  btc: AssetRegime | null; sol: AssetRegime | null;
  launchesLastHour: number | null; graduationsLastHour: number | null;
  /** Launches in the last hour relative to the median hour of the previous 24 h. */
  activity: 'HOT' | 'NORMAL' | 'COLD' | null;
  label: string;
  missing: string[];
}

const HOUR = 3_600_000;
/** Thresholds are deliberately coarse; they are part of the regime definition's version. */
export const REGIME_V1 = Object.freeze({ trendPct: 3, btcVol: { high: 4, low: 1.5 }, solVol: { high: 7, low: 3 }, hot: 1.5, cold: 0.67 });

function asset(view: PointInTimeView, token: string, vol: { high: number; low: number }): AssetRegime | null {
  const t = view.decisionTime;
  const points = view.events({ types: ['MarketSnapshot'], token, from: t - 25 * HOUR }).flatMap(e => {
    const p = e.payload.price_usd; return typeof p === 'number' && p > 0 ? [{ ts: e.timestamp, p }] : [];
  });
  const last = points.at(-1);
  if (!last || t - last.ts > HOUR) return null;
  const dayAgo = points.filter(x => x.ts <= t - 23 * HOUR).at(-1);
  const returnPct24h = dayAgo ? (last.p / dayAgo.p - 1) * 100 : null;
  // Hourly closes over the last 24 h → daily volatility from hourly log returns.
  const hourly = new Map<number, number>();
  for (const x of points) if (x.ts > t - 24 * HOUR) hourly.set(Math.floor(x.ts / HOUR), x.p);
  const closes = [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const rets = closes.slice(1).map((p, i) => Math.log(p / closes[i]!));
  const s = rets.length >= 12 ? stdev(rets) : null;
  const volatilityPct24h = s === null ? null : s * Math.sqrt(24) * 100;
  return {
    price: last.p, returnPct24h, volatilityPct24h,
    trend: returnPct24h === null ? null : returnPct24h > REGIME_V1.trendPct ? 'UP' : returnPct24h < -REGIME_V1.trendPct ? 'DOWN' : 'FLAT',
    vol: volatilityPct24h === null ? null : volatilityPct24h > vol.high ? 'HIGH' : volatilityPct24h < vol.low ? 'LOW' : 'NORMAL',
  };
}

export function computeRegime(view: PointInTimeView): RegimeSnapshot {
  const t = view.decisionTime, missing: string[] = [];
  const btc = asset(view, 'REF:BTC', REGIME_V1.btcVol), sol = asset(view, 'REF:SOL', REGIME_V1.solVol);
  if (!btc) missing.push('BTC'); if (!sol) missing.push('SOL');
  const launches = view.events({ types: ['TokenCreated'], from: t - 25 * HOUR });
  const graduations = view.events({ types: ['Graduation'], from: t - HOUR });
  let launchesLastHour: number | null = null, activity: RegimeSnapshot['activity'] = null;
  if (launches.length) {
    // Coverage: launch counts only mean something if collection ran for the whole day.
    const covered = launches[0]!.timestamp <= t - 24 * HOUR;
    launchesLastHour = launches.filter(e => e.timestamp > t - HOUR).length;
    if (covered) {
      const perHour = Array.from({ length: 24 }, (_, i) => launches.filter(e => e.timestamp > t - (i + 2) * HOUR && e.timestamp <= t - (i + 1) * HOUR).length).sort((a, b) => a - b);
      const med = (perHour[11]! + perHour[12]!) / 2;
      activity = med === 0 ? null : launchesLastHour > med * REGIME_V1.hot ? 'HOT' : launchesLastHour < med * REGIME_V1.cold ? 'COLD' : 'NORMAL';
    } else missing.push('LAUNCH_HISTORY_24H');
  } else missing.push('LAUNCHES');
  const part = (a: AssetRegime | null) => (a ? `${a.trend ?? '?'}/${a.vol ?? '?'}` : '?');
  return { at: t, btc, sol, launchesLastHour, graduationsLastHour: graduations.length ? graduations.length : launches.length ? 0 : null, activity,
    label: `SOL ${part(sol)} · BTC ${part(btc)} · launches ${activity ?? '?'}`, missing };
}

/** Coarse label for grouping results: SOL trend and launch activity, the two most likely to matter for memecoins. */
export const regimeKey = (r: RegimeSnapshot): string => `SOL_${r.sol?.trend ?? 'UNKNOWN'}·LAUNCHES_${r.activity ?? 'UNKNOWN'}`;

/**
 * Reference price observations for the regime, from CoinGecko's public simple-price endpoint (no key). Collected every
 * few minutes by `research-platform collect-regime`; history accumulates in the event store.
 */
export async function referencePriceEvents(fetcher: typeof fetch, now: number): Promise<EventInput[]> {
  const res = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_last_updated_at=true',
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const body = await res.json() as Record<string, { usd?: unknown; last_updated_at?: unknown }>;
  const out: EventInput[] = [];
  for (const [id, token] of [['bitcoin', 'REF:BTC'], ['solana', 'REF:SOL']] as const) {
    const row = body[id], price = row?.usd, updated = row?.last_updated_at;
    if (typeof price !== 'number' || !(price > 0) || typeof updated !== 'number') continue;
    out.push({ event_type: 'MarketSnapshot', token, timestamp: Math.min(updated * 1000, now), observed_at: now, source: 'coingecko:simple-price',
      payload: { price_usd: price }, natural_key: `${id}:${updated}`, producer: { component: 'regime-collector', version: '1' } });
  }
  return out;
}

/** True when an event is a reference series (never a tradable token). */
export const isReference = (e: Pick<ResearchEvent, 'token'>): boolean => !!e.token && e.token.startsWith('REF:');

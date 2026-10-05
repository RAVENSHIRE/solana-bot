import type { EventType, ResearchEvent } from '../events/types';
import type { PointInTimeView } from '../pit/view';
import { FeatureRegistry, type FeatureDefinition } from './registry';

/**
 * The standard feature set. Payload conventions (what producers and importers write):
 *
 *   Buy / Sell / CreatorBuy / CreatorSell  { wallet, amount_usd?, amount_sol?, token_amount?, tx? }
 *   TokenCreated                           { creator?, name?, symbol?, launchpad? }
 *   CurveProgress                          { progress_pct (0–100), market_cap_usd? }
 *   MarketSnapshot                         { price_usd, market_cap_usd?, liquidity_usd?, volume_5m_usd?, buys_5m?, sells_5m?,
 *                                            price_change_5m_pct?, pool_created_at?, top10_pct?, largest_wallet_pct? }
 *   Candle (timestamp = bar close)         { interval_ms, o, h, l, c, v? (USD), start?, supply? }
 *   LiquidityChange                        { liquidity_usd }
 *   HolderSnapshot                         { holder_count?, top10_pct?, largest_wallet_pct? }
 *   WalletFunded                           { wallet, funder, amount_sol? }
 *   XPost / XContractAddressPost           { author, followers?, own_account?, url? }
 *   RiskFlag                               { flag: 'RUG' | 'IMPERSONATOR' | … }
 *   Graduation                             { pool?, venue? }
 *
 * None of these features is assumed to predict anything. They exist so that hypotheses about them can be measured.
 */

const MIN = 60_000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const BUYS = ['Buy', 'CreatorBuy'] as const;
const SELLS = ['Sell', 'CreatorSell'] as const;
const TRADES = [...BUYS, ...SELLS] as const;

/** True when the token has any trade event known: without a trade feed, "no buyers" and "no data" look the same. */
const hasTradeFeed = (v: PointInTimeView, token: string) => v.events({ types: TRADES, token }).length > 0;

interface Flow { wallet: string; usd: number; buy: boolean; ts: number }
function flows(v: PointInTimeView, token: string, lookbackMs: number): Flow[] {
  const out: Flow[] = [];
  for (const e of v.window(lookbackMs, { types: TRADES, token })) {
    const wallet = str(e.payload.wallet), usd = num(e.payload.amount_usd);
    if (wallet && usd !== null && usd >= 0) out.push({ wallet, usd, buy: e.event_type === 'Buy' || e.event_type === 'CreatorBuy', ts: e.timestamp });
  }
  return out;
}

function shares(volumes: Map<string, number>): number[] | null {
  const total = [...volumes.values()].reduce((a, x) => a + x, 0);
  return total > 0 ? [...volumes.values()].map(x => x / total) : null;
}
const byWallet = (fs: Flow[], buy: boolean) => fs.filter(f => f.buy === buy).reduce((m, f) => m.set(f.wallet, (m.get(f.wallet) ?? 0) + f.usd), new Map<string, number>());

/** wallet → its earliest known funder. */
function funders(v: PointInTimeView): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of v.events({ types: ['WalletFunded'], token: null })) {
    const w = str(e.payload.wallet), f = str(e.payload.funder);
    if (w && f && !m.has(w)) m.set(w, f);
  }
  return m;
}

/** Slope per minute of (ts, value) points over [t − lookback, t]; needs ≥ 2 points spanning `minSpanMs`. */
function slope(points: Array<{ ts: number; value: number }>, minSpanMs: number): number | null {
  if (points.length < 2) return null;
  const a = points[0]!, b = points.at(-1)!;
  return b.ts - a.ts >= minSpanMs ? (b.value - a.value) / ((b.ts - a.ts) / MIN) : null;
}
const points = (events: ResearchEvent[], key: string) => events.flatMap(e => { const value = num(e.payload[key]); return value === null ? [] : [{ ts: e.timestamp, value }]; });

/** Latest value of a payload field among these types, if not older than maxAgeMs at the decision time. */
function freshField(v: PointInTimeView, token: string, types: readonly EventType[], key: string, maxAgeMs: number): number | null {
  const list = v.events({ types, token, from: v.decisionTime - maxAgeMs });
  for (let i = list.length - 1; i >= 0; i--) { const x = num(list[i]!.payload[key]); if (x !== null) return x; }
  return null;
}

interface PricePoint { ts: number; price: number; open: number | null }
function pricePoints(v: PointInTimeView, token: string, from: number): PricePoint[] {
  return v.events({ types: ['MarketSnapshot', 'Candle'], token, from }).flatMap(e => {
    const price = e.event_type === 'Candle' ? num(e.payload.c) : num(e.payload.price_usd);
    return price !== null && price > 0 ? [{ ts: e.timestamp, price, open: e.event_type === 'Candle' ? num(e.payload.o) : null }] : [];
  });
}

const STALE_MARKET = 2 * MIN;
const STALE_HOLDERS = 15 * MIN;

export const STANDARD_FEATURES: FeatureDefinition[] = [
  // ------------------------------------------------------------------ bonding curve
  {
    name: 'curve_progress', version: 1, unit: 'pct', sources: ['CurveProgress'], lookbackMs: null, maxStalenessMs: STALE_MARKET,
    definition: 'Latest bonding-curve fill (0–100 %) observed in the last 2 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Snapshot value; stale values are null.',
    compute: (v, c) => freshField(v, c.token, ['CurveProgress'], 'progress_pct', STALE_MARKET),
  },
  {
    name: 'curve_velocity', version: 1, unit: 'pct/min', sources: ['CurveProgress'], lookbackMs: 5 * MIN,
    definition: 'Change of curve fill per minute between the first and last CurveProgress in the last 5 minutes (≥ 30 s apart).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window ending at t.',
    compute: (v, c) => slope(points(v.window(5 * MIN, { types: ['CurveProgress'], token: c.token }), 'progress_pct'), 30_000),
  },
  {
    name: 'curve_acceleration', version: 1, unit: 'pct/min²', sources: ['CurveProgress'], lookbackMs: 6 * MIN,
    definition: 'Curve velocity over the last 3 minutes minus the velocity over the 3 minutes before, divided by 3 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Two trailing windows ending at t.',
    compute: (v, c) => {
      const t = v.decisionTime, all = points(v.window(6 * MIN, { types: ['CurveProgress'], token: c.token }), 'progress_pct');
      const recent = slope(all.filter(p => p.ts >= t - 3 * MIN), 30_000), prior = slope(all.filter(p => p.ts < t - 3 * MIN), 30_000);
      return recent === null || prior === null ? null : (recent - prior) / 3;
    },
  },
  // ------------------------------------------------------------------ order flow
  {
    name: 'new_buyer_velocity', version: 1, unit: 'wallets/min', sources: [...TRADES], lookbackMs: 5 * MIN,
    definition: 'Wallets whose first known buy of the token falls in the last 5 minutes, per minute.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW',
    leakageNotes: '"First" means first known by t; a wallet that bought before collection started counts as new (bias towards young tokens).',
    compute: (v, c) => {
      if (!hasTradeFeed(v, c.token)) return null;
      const first = new Map<string, number>();
      for (const e of v.events({ types: BUYS, token: c.token })) { const w = str(e.payload.wallet); if (w && !first.has(w)) first.set(w, e.timestamp); }
      return [...first.values()].filter(ts => ts >= v.decisionTime - 5 * MIN).length / 5;
    },
  },
  {
    name: 'buyer_concentration', version: 1, unit: 'share', sources: [...TRADES], lookbackMs: 5 * MIN,
    definition: 'Share of the last 5 minutes\' buy volume (USD) bought by the 5 largest buying wallets.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window; null without buy volume.',
    compute: (v, c) => { const s = shares(byWallet(flows(v, c.token, 5 * MIN), true)); return s ? s.sort((a, b) => b - a).slice(0, 5).reduce((a, x) => a + x, 0) : null; },
  },
  {
    name: 'buyer_hhi', version: 1, unit: 'index 0–1', sources: [...TRADES], lookbackMs: 5 * MIN,
    definition: 'Herfindahl–Hirschman index of buy volume by wallet over the last 5 minutes (1 = one buyer).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window; null without buy volume.',
    compute: (v, c) => { const s = shares(byWallet(flows(v, c.token, 5 * MIN), true)); return s ? s.reduce((a, x) => a + x * x, 0) : null; },
  },
  {
    name: 'effective_independent_buyers', version: 1, unit: 'entities', sources: [...TRADES, 'WalletFunded'], lookbackMs: 5 * MIN,
    definition: '1 / HHI of the last 5 minutes\' buy volume after merging wallets funded by the same wallet (funding known by t).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM',
    leakageNotes: 'Funding links discovered after t must not be used; the view guarantees it. Unknown funding counts as independent (upward bias).',
    compute: (v, c) => {
      const f = funders(v), m = new Map<string, number>();
      for (const x of flows(v, c.token, 5 * MIN)) if (x.buy) { const k = f.get(x.wallet) ?? x.wallet; m.set(k, (m.get(k) ?? 0) + x.usd); }
      const s = shares(m); return s ? 1 / s.reduce((a, x) => a + x * x, 0) : null;
    },
  },
  {
    name: 'buy_sell_imbalance', version: 1, unit: '−1…1', sources: [...TRADES], lookbackMs: 5 * MIN,
    definition: '(buy USD − sell USD) / (buy USD + sell USD) over the last 5 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window.',
    compute: (v, c) => {
      const fs = flows(v, c.token, 5 * MIN), b = fs.filter(f => f.buy).reduce((a, f) => a + f.usd, 0), s = fs.filter(f => !f.buy).reduce((a, f) => a + f.usd, 0);
      return b + s > 0 ? (b - s) / (b + s) : null;
    },
  },
  {
    name: 'organic_flow', version: 1, unit: 'share', sources: [...TRADES], lookbackMs: 5 * MIN,
    definition: 'Share of the last 5 minutes\' gross volume from wallets whose net flow is at least half their gross flow (not round-tripping).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Heuristic; per-wallet, so multi-wallet wash trading is not caught.',
    compute: (v, c) => {
      const per = new Map<string, { b: number; s: number }>();
      for (const f of flows(v, c.token, 5 * MIN)) { const x = per.get(f.wallet) ?? { b: 0, s: 0 }; if (f.buy) x.b += f.usd; else x.s += f.usd; per.set(f.wallet, x); }
      let gross = 0, organic = 0;
      for (const { b, s } of per.values()) { gross += b + s; if (Math.abs(b - s) >= 0.5 * (b + s)) organic += b + s; }
      return gross > 0 ? organic / gross : null;
    },
  },
  {
    name: 'wallet_funding_cluster', version: 1, unit: 'share', sources: [...BUYS, 'WalletFunded'], lookbackMs: 5 * MIN,
    definition: 'Largest share of the last 5 minutes\' distinct buyers that share one funder (≥ 3 buyers and ≥ 1 known funder).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM', leakageNotes: 'Funding known by t only; unknown funders are not a cluster.',
    compute: (v, c) => {
      const buyers = [...new Set(flows(v, c.token, 5 * MIN).filter(f => f.buy).map(f => f.wallet))];
      if (buyers.length < 3) return null;
      const f = funders(v), groups = new Map<string, number>();
      for (const w of buyers) { const k = f.get(w); if (k) groups.set(k, (groups.get(k) ?? 0) + 1); }
      return groups.size ? Math.max(...groups.values()) / buyers.length : null;
    },
  },
  // ------------------------------------------------------------------ creator
  {
    name: 'creator_sold', version: 1, unit: '0/1', sources: ['TokenCreated', 'CreatorSell'], lookbackMs: null,
    definition: '1 if a creator sell is known by t, 0 if the creation is known and no creator sell is, else null.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'A sell observed after t is not known at t.',
    compute: (v, c) => v.first(['CreatorSell'], c.token) ? 1 : v.first(['TokenCreated'], c.token) ? 0 : null,
  },
  {
    name: 'creator_sell_latency_ms', version: 1, unit: 'ms', sources: ['TokenCreated', 'CreatorSell'], lookbackMs: null,
    definition: 'Time from creation to the first creator sell, when both are known by t.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM',
    leakageNotes: 'Censored: null until the creator sells. Never compute it from a later sell (classic survivorship leak).',
    compute: (v, c) => { const a = v.first(['TokenCreated'], c.token), b = v.first(['CreatorSell'], c.token); return a && b ? b.timestamp - a.timestamp : null; },
  },
  {
    name: 'creator_prior_tokens', version: 1, unit: 'count', sources: ['TokenCreated'], lookbackMs: null,
    definition: 'Tokens created by the same creator before this one, as known by t.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Only launches collected by t; collection gaps understate it.',
    compute: (v, c) => {
      const me = v.first(['TokenCreated'], c.token), creator = me ? str(me.payload.creator) : null;
      if (!me || !creator) return null;
      return new Set(v.events({ types: ['TokenCreated'], to: me.timestamp }).filter(e => e.token !== c.token && e.timestamp < me.timestamp && e.payload.creator === creator).map(e => e.token)).size;
    },
  },
  {
    name: 'creator_prior_rugs', version: 1, unit: 'count', sources: ['TokenCreated', 'RiskFlag'], lookbackMs: null,
    definition: 'Earlier tokens of the same creator flagged RUG by t.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM',
    leakageNotes: 'A rug flag raised after t must not count; flags are events with their own known-at, so the view enforces it.',
    compute: (v, c) => {
      const me = v.first(['TokenCreated'], c.token), creator = me ? str(me.payload.creator) : null;
      if (!me || !creator) return null;
      const prior = new Set(v.events({ types: ['TokenCreated'], to: me.timestamp }).filter(e => e.token !== c.token && e.timestamp < me.timestamp && e.payload.creator === creator).map(e => e.token));
      return new Set(v.events({ types: ['RiskFlag'] }).filter(e => e.payload.flag === 'RUG' && prior.has(e.token)).map(e => e.token)).size;
    },
  },
  // ------------------------------------------------------------------ social
  {
    name: 'social_attention_velocity', version: 1, unit: 'posts/min', sources: ['XPost', 'XContractAddressPost'], lookbackMs: 15 * MIN,
    definition: 'Posts on X about the token in the last 15 minutes, per minute; null when no X observation of the token exists.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM',
    leakageNotes: 'X search backfills posts with their creation time; use AVAILABLE semantics with the time the post was actually fetched.',
    compute: (v, c) => {
      if (!v.events({ types: ['XPost', 'XContractAddressPost', 'SocialLinkDiscovered'], token: c.token }).length) return null;
      return v.window(15 * MIN, { types: ['XPost', 'XContractAddressPost'], token: c.token }).length / 15;
    },
  },
  {
    name: 'ca_post_latency_ms', version: 1, unit: 'ms', sources: ['TokenCreated', 'XContractAddressPost'], lookbackMs: null,
    definition: 'Time from creation to the first post of the contract address by the project\'s own X account, when both are known by t.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM', leakageNotes: 'Censored until the post exists; same backfill caveat as social_attention_velocity.',
    compute: (v, c) => {
      const created = v.first(['TokenCreated'], c.token);
      const post = v.events({ types: ['XContractAddressPost'], token: c.token }).find(e => e.payload.own_account === true);
      return created && post ? post.timestamp - created.timestamp : null;
    },
  },
  // ------------------------------------------------------------------ liquidity and holders
  {
    name: 'liquidity_usd', version: 1, unit: 'USD', sources: ['LiquidityChange', 'MarketSnapshot'], lookbackMs: null, maxStalenessMs: STALE_MARKET,
    definition: 'Latest pool liquidity (USD, both sides) observed in the last 2 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW',
    leakageNotes: 'Must come from an observation at or before t. The desk backtest\'s single later liquidity reference is look-ahead (AUDIT #4).',
    compute: (v, c) => freshField(v, c.token, ['LiquidityChange', 'MarketSnapshot'], 'liquidity_usd', STALE_MARKET),
  },
  {
    name: 'liquidity_velocity', version: 1, unit: 'USD/min', sources: ['LiquidityChange', 'MarketSnapshot'], lookbackMs: 5 * MIN,
    definition: 'Change of liquidity per minute between the first and last observation in the last 5 minutes (≥ 60 s apart).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window.',
    compute: (v, c) => slope(points(v.window(5 * MIN, { types: ['LiquidityChange', 'MarketSnapshot'], token: c.token }), 'liquidity_usd'), MIN),
  },
  {
    name: 'holder_count', version: 1, unit: 'holders', sources: ['HolderSnapshot'], lookbackMs: null, maxStalenessMs: STALE_HOLDERS,
    definition: 'Latest holder count observed in the last 15 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Snapshot; DAS counts may be capped (2,000+).',
    compute: (v, c) => freshField(v, c.token, ['HolderSnapshot'], 'holder_count', STALE_HOLDERS),
  },
  {
    name: 'holder_growth_velocity', version: 1, unit: 'holders/min', sources: ['HolderSnapshot'], lookbackMs: 10 * MIN,
    definition: 'Change of holder count per minute over the last 10 minutes (≥ 2 minutes between first and last snapshot).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window.',
    compute: (v, c) => slope(points(v.window(10 * MIN, { types: ['HolderSnapshot'], token: c.token }), 'holder_count'), 2 * MIN),
  },
  {
    name: 'top10_pct', version: 1, unit: 'pct', sources: ['HolderSnapshot', 'MarketSnapshot'], lookbackMs: null, maxStalenessMs: STALE_HOLDERS,
    definition: 'Share of supply held by the 10 largest wallets (pools and curves excluded), latest in the last 15 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Snapshot.',
    compute: (v, c) => freshField(v, c.token, ['HolderSnapshot', 'MarketSnapshot'], 'top10_pct', STALE_HOLDERS),
  },
  {
    name: 'largest_wallet_pct', version: 1, unit: 'pct', sources: ['HolderSnapshot', 'MarketSnapshot'], lookbackMs: null, maxStalenessMs: STALE_HOLDERS,
    definition: 'Share of supply held by the largest wallet, latest in the last 15 minutes.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Snapshot.',
    compute: (v, c) => freshField(v, c.token, ['HolderSnapshot', 'MarketSnapshot'], 'largest_wallet_pct', STALE_HOLDERS),
  },
  // ------------------------------------------------------------------ market (CRASH-style)
  {
    name: 'price_usd', version: 1, unit: 'USD', sources: ['MarketSnapshot', 'Candle'], lookbackMs: null, maxStalenessMs: STALE_MARKET,
    definition: 'Latest price: snapshot price or the close of the latest completed bar, at most 2 minutes old.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Bars count from their close, never their open.',
    compute: (v, c) => pricePoints(v, c.token, v.decisionTime - STALE_MARKET).at(-1)?.price ?? null,
  },
  {
    name: 'market_cap_usd', version: 1, unit: 'USD', sources: ['MarketSnapshot', 'Candle'], lookbackMs: null, maxStalenessMs: STALE_MARKET,
    definition: 'Latest market cap: snapshot value, else the latest bar close × the supply recorded on the bar, at most 2 minutes old.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'MEDIUM',
    leakageNotes: 'Bar supply may come from a later observation; acceptable for fixed-supply pump.fun tokens only.',
    compute: (v, c) => {
      const list = v.events({ types: ['MarketSnapshot', 'Candle'], token: c.token, from: v.decisionTime - STALE_MARKET });
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!, cap = e.event_type === 'Candle' ? (num(e.payload.c) ?? NaN) * (num(e.payload.supply) ?? NaN) : num(e.payload.market_cap_usd) ?? NaN;
        if (Number.isFinite(cap) && cap > 0) return cap;
      }
      return null;
    },
  },
  {
    name: 'pool_age_min', version: 1, unit: 'min', sources: ['Graduation', 'MarketSnapshot'], lookbackMs: null,
    definition: 'Minutes since the token\'s first AMM pool: its graduation if known, else the pool creation time on the latest snapshot.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'First pool, never the deepest pool now.',
    compute: (v, c) => {
      const grad = v.first(['Graduation'], c.token);
      if (grad) return (v.decisionTime - grad.timestamp) / MIN;
      const created = num(v.latest(['MarketSnapshot'], c.token)?.payload.pool_created_at);
      return created !== null && created <= v.decisionTime ? (v.decisionTime - created) / MIN : null;
    },
  },
  {
    name: 'price_change_5m_pct', version: 1, unit: 'pct', sources: ['MarketSnapshot', 'Candle'], lookbackMs: 10 * MIN,
    definition: 'Provider 5-minute change on a fresh snapshot; else latest price vs the latest price at or before t − 5 min (within 5 more min); '
      + 'for a series younger than 5 min, vs its first bar\'s open.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Reference strictly before t − 5 min.',
    compute: (v, c) => {
      const provided = freshField(v, c.token, ['MarketSnapshot'], 'price_change_5m_pct', STALE_MARKET);
      if (provided !== null) return provided;
      const t = v.decisionTime, now = pricePoints(v, c.token, t - STALE_MARKET).at(-1);
      if (!now) return null;
      const before = pricePoints(v, c.token, t - 10 * MIN).filter(p => p.ts <= t - 5 * MIN).at(-1);
      const firstEver = pricePoints(v, c.token, -Infinity)[0];
      const ref = before?.price ?? (firstEver && firstEver.ts > t - 5 * MIN ? firstEver.open ?? firstEver.price : null);
      return ref ? (now.price / ref - 1) * 100 : null;
    },
  },
  {
    name: 'volume_5m_usd', version: 1, unit: 'USD', sources: ['MarketSnapshot', 'Candle'], lookbackMs: 5 * MIN,
    definition: 'Provider 5-minute volume on a fresh snapshot; else the sum of bar volumes closing in (t − 5 min, t] (bars must carry volume).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW',
    leakageNotes: 'Missing bars count as zero volume (providers omit empty minutes); null when no bar in the window has a volume.',
    compute: (v, c) => {
      const provided = freshField(v, c.token, ['MarketSnapshot'], 'volume_5m_usd', STALE_MARKET);
      if (provided !== null) return provided;
      const bars = v.events({ types: ['Candle'], token: c.token, from: v.decisionTime - 5 * MIN + 1 }).map(e => num(e.payload.v)).filter((x): x is number => x !== null);
      return bars.length ? bars.reduce((a, x) => a + x, 0) : null;
    },
  },
  {
    name: 'buys_5m', version: 1, unit: 'count', sources: ['MarketSnapshot', 'Buy', 'CreatorBuy'], lookbackMs: 5 * MIN,
    definition: 'Provider 5-minute buy count on a fresh snapshot; else Buy events in the last 5 minutes (needs a trade feed).',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Trailing window.',
    compute: (v, c) => freshField(v, c.token, ['MarketSnapshot'], 'buys_5m', STALE_MARKET)
      ?? (hasTradeFeed(v, c.token) ? v.window(5 * MIN, { types: BUYS, token: c.token }).length : null),
  },
  {
    name: 'buy_sell_ratio_5m', version: 1, unit: 'ratio', sources: ['MarketSnapshot', ...TRADES], lookbackMs: 5 * MIN,
    definition: 'Buys ÷ max(1, sells) over 5 minutes: provider counts on a fresh snapshot, else trade events.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: [], leakageRisk: 'LOW', leakageNotes: 'Counts, not volume (as the desk gate).',
    compute: (v, c) => {
      const snap = v.events({ types: ['MarketSnapshot'], token: c.token, from: v.decisionTime - STALE_MARKET }).filter(e => num(e.payload.buys_5m) !== null && num(e.payload.sells_5m) !== null).at(-1);
      if (snap) return num(snap.payload.buys_5m)! / Math.max(1, num(snap.payload.sells_5m)!);
      if (!hasTradeFeed(v, c.token)) return null;
      const w = v.window(5 * MIN, { types: TRADES, token: c.token });
      const buys = w.filter(e => e.event_type === 'Buy' || e.event_type === 'CreatorBuy').length;
      return w.length ? buys / Math.max(1, w.length - buys) : null;
    },
  },
  {
    name: 'liquidity_to_mcap', version: 1, unit: 'ratio', sources: ['LiquidityChange', 'MarketSnapshot', 'Candle'], lookbackMs: null,
    definition: 'liquidity_usd@v1 ÷ market_cap_usd@v1.',
    timestamp: 'DECISION_TIME', missing: 'NULL', dependencies: ['liquidity_usd@v1', 'market_cap_usd@v1'], leakageRisk: 'LOW', leakageNotes: 'Inherits its inputs\' risks.',
    compute: (_v, c) => { const l = c.deps['liquidity_usd@v1'], m = c.deps['market_cap_usd@v1']; return l != null && m != null && m > 0 ? l / m : null; },
  },
];

export function standardRegistry(): FeatureRegistry {
  const r = new FeatureRegistry();
  for (const f of STANDARD_FEATURES) r.register(f);
  return r;
}

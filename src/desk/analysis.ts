import type { DexPair } from '../data/dexscreener';
import { DESK } from './config';
import type { Discovered } from './discovery';
import type { OnchainEvidence } from './onchain';
import type { LaunchCheck } from './launch';
import type { AuthenticityResult, WebsiteCheck, XAccount, XLink } from './social';
import type { Candidate, CandidateMetrics, CandidateStatus, Classification, ComponentScore, Evidence, EvidenceKind,
  GateResult, ScoreFactor, Tier } from './types';

export interface WatchState {
  firstSeenAt: number; observations: number; lastLiquidityUsd: number | null; lastPriceUsd: number | null;
  momentumStreak: number;
}
export interface SocialEvidence { website: WebsiteCheck; link: XLink; account: XAccount | null; auth: AuthenticityResult; at: number }
export interface AnalysisInput {
  found: Discovered; pair: DexPair; metrics: CandidateMetrics; tier: Tier; onchain: OnchainEvidence | null; onchainAt: number | null;
  social: SocialEvidence | null; watch: WatchState; now: number; maxWashRatio: number;
  launch?: LaunchCheck | null;
}

const usd = (n: number | null) => n === null ? 'UNKNOWN' : `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const pct = (n: number | null, d = 1) => n === null ? 'UNKNOWN' : `${n.toFixed(d)}%`;
const num = (n: number | null, d = 2) => n === null ? 'UNKNOWN' : n.toFixed(d);
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

function evidenceList(i: AnalysisInput): Evidence[] {
  const m = i.metrics, p = i.pair, o = i.onchain, s = i.social, at = p.meta.receivedAt;
  const e: Evidence[] = [];
  const add = (kind: EvidenceKind, key: string, label: string, value: Evidence['value'], display: string, source: string, when: number | null, note?: string) =>
    e.push({ kind, key, label, value, display: value === null ? (kind === 'INFERRED' ? 'UNVERIFIED' : 'UNKNOWN') : display, source, at: when, ...(note ? { note } : {}) });
  // Observed
  add('OBSERVED', 'marketCap', m.marketCapBasis === 'FDV' ? 'Market cap (FDV basis)' : 'Market cap', m.marketCapUsd, usd(m.marketCapUsd), `DexScreener ${p.dexId}`, at,
    m.marketCapBasis === 'FDV' ? 'Provider reported FDV only; supply fully minted is not assumed elsewhere' : undefined);
  add('OBSERVED', 'liquidity', 'Liquidity', m.liquidityUsd, usd(m.liquidityUsd), `DexScreener ${p.dexId}`, at, m.migration === 'BONDING_CURVE' ? 'Bonding curves report no pool liquidity' : undefined);
  add('OBSERVED', 'poolAge', 'Pool age', m.poolAgeMin, m.poolAgeMin === null ? '' : m.poolAgeMin < 120 ? `${Math.round(m.poolAgeMin)} min` : `${(m.poolAgeMin / 60).toFixed(1)} h`, 'DexScreener', at);
  add('OBSERVED', 'volume5m', '5m volume', m.volume5mUsd, usd(m.volume5mUsd), 'DexScreener', at);
  add('OBSERVED', 'volume1h', '1h volume', m.volume1hUsd, usd(m.volume1hUsd), 'DexScreener', at);
  add('OBSERVED', 'txns5m', '5m buys / sells', m.buys5m === null || m.sells5m === null ? null : `${m.buys5m}/${m.sells5m}`, `${m.buys5m}/${m.sells5m}`, 'DexScreener', at);
  add('OBSERVED', 'migration', 'Venue / migration', m.migration, `${m.migration} · ${p.dexId}`, 'DexScreener', at);
  add('OBSERVED', 'website', 'Website', s ? s.website.status : null, s ? `${s.website.status}${s.website.httpStatus ? ` (HTTP ${s.website.httpStatus})` : ''}${s.website.title ? ` · ${s.website.title}` : ''}` : '',
    'HTTPS check', s?.at ?? null, s?.website.detail);
  add('OBSERVED', 'description', 'Project description', i.found.description, (i.found.description ?? '').slice(0, 160), 'DexScreener profile', at);
  add('OBSERVED', 'xLink', 'X link', s ? s.link.kind : null, s ? (s.link.handle ? `${s.link.kind} @${s.link.handle}` : s.link.kind) : '', 'DexScreener profile', at);
  add('OBSERVED', 'xCreated', 'X account created', s?.account ? new Date(s.account.createdAt).toISOString().slice(0, 10) : null, s?.account ? new Date(s.account.createdAt).toISOString().slice(0, 10) : '', 'X API', s?.at ?? null);
  add('OBSERVED', 'xFollowers', 'X followers', s?.account?.followers ?? null, (s?.account?.followers ?? 0).toLocaleString('en-US'), 'X API', s?.at ?? null);
  add('OBSERVED', 'xPosts7d', 'X posts (7 days, of last 10)', s?.auth.posts7d ?? null, String(s?.auth.posts7d), 'X API', s?.at ?? null);
  add('OBSERVED', 'mintAuthority', 'Mint authority', o?.safety ? (o.safety.hasMintAuthority ? 'ACTIVE' : 'REVOKED') : null, o?.safety?.hasMintAuthority ? 'ACTIVE' : 'REVOKED', 'Solana RPC', i.onchainAt);
  add('OBSERVED', 'freezeAuthority', 'Freeze authority', o?.safety ? (o.safety.hasFreezeAuthority ? 'ACTIVE' : 'REVOKED') : null, o?.safety?.hasFreezeAuthority ? 'ACTIVE' : 'REVOKED', 'Solana RPC', i.onchainAt);
  const L = i.launch ?? null;
  add('OBSERVED', 'launch', 'Launch', L ? new Date(L.launchedAt).toISOString() : null,
    L ? `${new Date(L.launchedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${L.poolsChecked} pool(s)` : '', 'GeckoTerminal pool history', null);
  add('DERIVED', 'graduation', 'Curve → migration time', L?.migratedAfterSec ?? null,
    L?.migratedAfterSec == null ? '' : L.migratedAfterSec < 120 ? `${Math.round(L.migratedAfterSec)} s` : `${(L.migratedAfterSec / 60).toFixed(1)} min`,
    'pool creation times', null, L && L.migratedAfterSec === null ? (L.curvePool ? 'still on the bonding curve' : 'no pump.fun curve (other launch venue)') : undefined);
  add('DERIVED', 'launchMc', `Market cap high, first ${L?.windowMin ?? 5} min`, L?.earlyHighMcUsd ?? null, usd(L?.earlyHighMcUsd ?? null), 'first candles × supply', null,
    L?.firstCandleMultiple ? `first candle ${L.firstCandleMultiple.toFixed(1)}× open→high` : undefined);
  add('OBSERVED', 'boosts', 'DexScreener boost amount', i.found.boostAmount, String(i.found.boostAmount), 'DexScreener boosts', at);
  // Derived
  add('DERIVED', 'buySell', 'Buy/sell ratio (5m)', m.buySellRatio5m, num(m.buySellRatio5m), 'buys ÷ sells', at);
  add('DERIVED', 'acceleration', 'Volume acceleration', m.volumeAcceleration, `${num(m.volumeAcceleration)}×`, '5m volume ÷ (1h volume ÷ 12)', at);
  add('DERIVED', 'momentum', 'Price change 5m / 1h', m.priceChange5mPct === null ? null : `${m.priceChange5mPct}/${m.priceChange1hPct}`, `${pct(m.priceChange5mPct)} / ${pct(m.priceChange1hPct)}`, 'DexScreener', at);
  add('DERIVED', 'top10', 'Top-10 wallet concentration', m.top10WalletPct, pct(m.top10WalletPct), 'largest accounts ÷ supply', i.onchainAt,
    o?.holders ? `${pct(o.holders.programOwnedPct)} held by program-owned accounts (pool/curve/locker) excluded` : undefined);
  add('DERIVED', 'largestWallet', 'Largest wallet', m.largestWalletPct, pct(m.largestWalletPct), 'largest accounts ÷ supply', i.onchainAt);
  add('DERIVED', 'wash', 'Wallet clustering / wash volume', m.washRatio, pct(m.washRatio === null ? null : m.washRatio * 100),
    o?.flow ? `${o.flow.trades} trades · ${o.flow.uniqueWallets} wallets (GeckoTerminal)` : 'GeckoTerminal trades', i.onchainAt,
    o?.flow?.flags.join(', ') || (o && !o.flow && !o.errors.trades ? 'Fetched only once volume, liquidity and buy pressure pass (provider rate limit)' : undefined));
  add('DERIVED', 'engagement', 'X engagement rate', s?.auth.engagementRatePct ?? null, pct(s?.auth.engagementRatePct ?? null, 3), 'avg engagement ÷ followers', s?.at ?? null);
  add('DERIVED', 'narrative', 'Narrative velocity', narrative(i), narrative(i) ?? '', 'X posts/day + DexScreener boosts', s?.at ?? at);
  // Inferred
  add('INFERRED', 'developer', 'Developer allocation', m.developerPct, pct(m.developerPct, 2), o?.developer?.source ?? 'creator not identifiable', i.onchainAt,
    o?.developer ? `Creator ${o.developer.creator} is assumed to be the developer` : undefined);
  add('INFERRED', 'identity', 'Identity continuity', s?.auth.identityLinked === true ? 'LINKED' : null, 'Website and X profile link each other', 'website ↔ X profile', s?.at ?? null);
  add('INFERRED', 'authenticity', 'X account authenticity', s?.auth.authenticity === 'UNVERIFIED' ? null : s?.auth.authenticity ?? null, s?.auth.authenticity ?? '', 'account age vs project age, engagement', s?.at ?? null,
    s?.auth.flags.join(' · ') || undefined);
  add('INFERRED', 'utility', 'Usable product / utility', null, '', 'not machine-verifiable', null, 'Requires a manual review; never inferred from marketing text');
  return e;
}

function narrative(i: AnalysisInput): string | null {
  const posts = i.social?.auth.posts7d, boost = i.found.boostAmount;
  if (posts == null && boost == null) return null;
  return [posts != null ? `${(posts / 7).toFixed(1)} X posts/day` : null, boost != null ? `boost ${boost}` : null].filter(Boolean).join(' · ');
}

export function gates(i: AnalysisInput): GateResult[] {
  const m = i.metrics, g = DESK.gates, o = i.onchain, w = i.watch;
  const gate = (key: string, label: string, value: number | boolean | null, pass: (v: never) => boolean, actual: string, required: string, blocking = true): GateResult =>
    ({ key, label, status: value === null ? 'UNKNOWN' : pass(value as never) ? 'PASS' : 'FAIL', actual, required, blocking });
  const liqRatio = m.liquidityUsd !== null && m.marketCapUsd ? m.liquidityUsd / m.marketCapUsd : null;
  const liqDrop = w.lastLiquidityUsd && m.liquidityUsd !== null ? (1 - m.liquidityUsd / w.lastLiquidityUsd) * 100 : null;
  const extensions = o?.safety ? o.safety.reasons.filter(r => !/Freeze-Authority|Mint-Authority/.test(r)) : null;
  return [
    gate('volume5m', '5m volume', m.volume5mUsd, (v: number) => v > g.minVolume5mUsd, usd(m.volume5mUsd), `> ${usd(g.minVolume5mUsd)}`),
    // A bonding curve has no AMM pool: entries require migrated liquidity, so the gate fails with that reason, not UNKNOWN.
    m.migration === 'BONDING_CURVE' && m.liquidityUsd === null
      ? { key: 'liquidity', label: 'Liquidity', status: 'FAIL', actual: 'bonding curve — no AMM pool yet', required: `> ${usd(g.minLiquidityUsd)} in an AMM pool`, blocking: true }
      : gate('liquidity', 'Liquidity', m.liquidityUsd, (v: number) => v > g.minLiquidityUsd, usd(m.liquidityUsd), `> ${usd(g.minLiquidityUsd)}`),
    gate('buySell', 'Buy/sell ratio (5m)', m.buySellRatio5m, (v: number) => v > g.minBuySellRatio, num(m.buySellRatio5m), `> ${g.minBuySellRatio}`),
    gate('mintAuthority', 'Mint authority revoked', o?.safety ? !o.safety.hasMintAuthority : null, (v: boolean) => v, o?.safety ? (o.safety.hasMintAuthority ? 'ACTIVE' : 'REVOKED') : 'UNKNOWN', 'REVOKED'),
    gate('freezeAuthority', 'Freeze authority revoked', o?.safety ? !o.safety.hasFreezeAuthority : null, (v: boolean) => v, o?.safety ? (o.safety.hasFreezeAuthority ? 'ACTIVE' : 'REVOKED') : 'UNKNOWN', 'REVOKED'),
    gate('contract', 'No dangerous token extensions', extensions ? extensions.length === 0 : null, (v: boolean) => v, extensions ? (extensions.join('; ') || 'none') : 'UNKNOWN', 'none'),
    gate('top10', 'Top-10 wallet concentration', m.top10WalletPct, (v: number) => v <= g.maxTop10WalletPct, pct(m.top10WalletPct), `≤ ${g.maxTop10WalletPct}%`),
    gate('largestWallet', 'Largest single wallet', m.largestWalletPct, (v: number) => v <= g.maxLargestWalletPct, pct(m.largestWalletPct), `≤ ${g.maxLargestWalletPct}%`),
    gate('liquidityRatio', 'Liquidity vs market cap', liqRatio, (v: number) => v >= g.minLiquidityToMarketCap, pct(liqRatio === null ? null : liqRatio * 100),
      `≥ ${g.minLiquidityToMarketCap * 100}%`, m.migration !== 'BONDING_CURVE'),
    // Needs a previous observation; the first scan cannot fail it, and momentum confirmation already requires a second.
    gate('liquidityDrop', 'Liquidity change since last scan', liqDrop, (v: number) => v < g.maxLiquidityDropPct,
      liqDrop === null ? 'first observation' : `${liqDrop > 0 ? '-' : '+'}${Math.abs(liqDrop).toFixed(1)}%`, `drop < ${g.maxLiquidityDropPct}%`, liqDrop !== null),
    fairLaunch(i.launch ?? null),
    // Not every venue exposes a creator; these two flag risk when known and never block on absence.
    gate('developer', 'Developer allocation', m.developerPct, (v: number) => v <= g.maxDeveloperPct, pct(m.developerPct, 2), `≤ ${g.maxDeveloperPct}%`, m.developerPct !== null),
    gate('clustering', 'Wallet clustering / wash volume', m.washRatio, (v: number) => v <= i.maxWashRatio, pct(m.washRatio === null ? null : m.washRatio * 100), `≤ ${Math.round(i.maxWashRatio * 100)}%`, m.washRatio !== null),
  ];
}

function fairLaunch(L: LaunchCheck | null): GateResult {
  const g = DESK.gates, required = `graduation ≥ ${g.minGraduationSec / 60} min after launch; < ${usd(g.maxLaunchMarketCapUsd)} in first 5 min`;
  if (!L) return { key: 'fairLaunch', label: 'Fair launch', status: 'UNKNOWN', actual: 'launch history not checked yet', required, blocking: true };
  const problems: string[] = [];
  if (L.migratedAfterSec !== null && L.migratedAfterSec < g.minGraduationSec)
    problems.push(`graduated ${Math.round(L.migratedAfterSec)} s after launch (curve bought out at creation)`);
  if (L.earlyHighMcUsd !== null && L.earlyHighMcUsd >= g.maxLaunchMarketCapUsd) problems.push(`${usd(L.earlyHighMcUsd)} within first ${L.windowMin} min`);
  if (problems.length) return { key: 'fairLaunch', label: 'Fair launch', status: 'FAIL', actual: problems.join('; '), required, blocking: true };
  if (L.earlyHighMcUsd === null) return { key: 'fairLaunch', label: 'Fair launch', status: 'UNKNOWN', actual: 'early market cap unknown (supply or candles missing)', required, blocking: true };
  return { key: 'fairLaunch', label: 'Fair launch', status: 'PASS', actual: `${usd(L.earlyHighMcUsd)} in first ${L.windowMin} min${L.migratedAfterSec !== null ? `; graduated after ${(L.migratedAfterSec / 60).toFixed(1)} min` : ''}`, required, blocking: true };
}

export function scores(i: AnalysisInput, gateList: GateResult[]): ComponentScore[] {
  const m = i.metrics, s = i.social, o = i.onchain;
  const f = (label: string, points: number, max: number, basis: string): ScoreFactor => ({ label, points: Math.round(points * 10) / 10, max, basis });
  const total = (key: ComponentScore['key'], factors: ScoreFactor[]): ComponentScore =>
    ({ key, factors, score: Math.round(factors.reduce((a, x) => a + x.points, 0) / factors.reduce((a, x) => a + x.max, 0) * 100) });
  const site = s?.website.status;
  const fundamental = total('FUNDAMENTAL', [
    f('Working website', site === 'AVAILABLE' ? 30 : 0, 30, site ?? 'UNKNOWN'),
    f('Website states what it is', site === 'AVAILABLE' && (s!.website.title || s!.website.description) ? 10 : 0, 10, s?.website.title ?? 'none'),
    f('Project description', i.found.description ? 15 : 0, 15, i.found.description ? 'listed' : 'none'),
    f('X presence', s?.link.kind === 'ACCOUNT' ? 15 : s?.link.kind === 'POST' ? 7 : 0, 15, s?.link.kind ?? 'UNKNOWN'),
    f('Website ↔ X identity link', s?.auth.identityLinked ? 20 : 0, 20, s?.auth.identityLinked === null || !s ? 'UNVERIFIED' : String(s.auth.identityLinked)),
    f('Graduated from bonding curve', m.migration === 'MIGRATED' ? 10 : 0, 10, m.migration),
    f('Usable product / utility', 0, 0, 'UNVERIFIED — manual review'),
  ]);
  const auth = s?.auth.authenticity ?? 'UNVERIFIED';
  const social = total('SOCIAL', [
    f('Followers', s?.account ? clamp(Math.log10(Math.max(1, s.account.followers)) / 5) * 25 : 0, 25, s?.account ? String(s.account.followers) : 'UNKNOWN'),
    f('Recent posting (7d)', s?.auth.posts7d != null ? clamp(s.auth.posts7d / 7) * 20 : 0, 20, s?.auth.posts7d != null ? `${s.auth.posts7d} posts` : 'UNKNOWN'),
    f('Engagement rate', s?.auth.engagementRatePct != null ? clamp(s.auth.engagementRatePct / 1) * 25 : 0, 25, s?.auth.engagementRatePct != null ? `${s.auth.engagementRatePct.toFixed(3)}%` : 'UNKNOWN'),
    f('Account authenticity', auth === 'VERIFIED' ? 20 : auth === 'LIKELY' ? 14 : auth === 'UNCERTAIN' ? 5 : 0, 20, auth),
    f('Narrative velocity (boosts)', i.found.boostAmount ? clamp(Math.log10(i.found.boostAmount) / 3) * 10 : 0, 10, i.found.boostAmount ? `boost ${i.found.boostAmount}` : 'none'),
  ]);
  const cap = m.marketCapUsd ?? Infinity;
  const market = total('MARKET', [
    f('Liquidity', m.liquidityUsd !== null ? clamp(m.liquidityUsd / (DESK.gates.minLiquidityUsd * 5)) * 25 : 0, 25, usd(m.liquidityUsd)),
    f('5m volume', m.volume5mUsd !== null ? clamp(m.volume5mUsd / (DESK.gates.minVolume5mUsd * 2)) * 25 : 0, 25, usd(m.volume5mUsd)),
    f('Market-cap band', cap < DESK.tiers.trending.priorityMarketCapUsd ? 20 : cap < DESK.tiers.trending.maxMarketCapUsd ? 10 : 0, 20, usd(m.marketCapUsd)),
    f('Pool maturity', m.poolAgeMin !== null ? clamp(m.poolAgeMin / 60) * 10 : 0, 10, m.poolAgeMin === null ? 'UNKNOWN' : `${Math.round(m.poolAgeMin)} min`),
    f('Liquidity depth vs cap', m.liquidityUsd !== null && m.marketCapUsd ? clamp(m.liquidityUsd / m.marketCapUsd / 0.15) * 20 : 0, 20,
      m.liquidityUsd !== null && m.marketCapUsd ? pct(m.liquidityUsd / m.marketCapUsd * 100) : 'UNKNOWN'),
  ]);
  const onchain = total('ONCHAIN', [
    f('Mint authority revoked', o?.safety && !o.safety.hasMintAuthority ? 25 : 0, 25, o?.safety ? (o.safety.hasMintAuthority ? 'ACTIVE' : 'REVOKED') : 'UNKNOWN'),
    f('Freeze authority revoked', o?.safety && !o.safety.hasFreezeAuthority ? 25 : 0, 25, o?.safety ? (o.safety.hasFreezeAuthority ? 'ACTIVE' : 'REVOKED') : 'UNKNOWN'),
    f('Top-10 wallet concentration', m.top10WalletPct !== null ? clamp(1 - m.top10WalletPct / 60) * 20 : 0, 20, pct(m.top10WalletPct)),
    f('Largest wallet', m.largestWalletPct !== null ? clamp(1 - m.largestWalletPct / 20) * 10 : 0, 10, pct(m.largestWalletPct)),
    f('Developer allocation', m.developerPct !== null ? clamp(1 - m.developerPct / 15) * 10 : 0, 10, pct(m.developerPct, 2)),
    f('Organic trade flow', m.washRatio !== null ? clamp(1 - m.washRatio / i.maxWashRatio) * 10 : 0, 10, pct(m.washRatio === null ? null : m.washRatio * 100)),
  ]);
  const failed = gateList.filter(g => g.status === 'FAIL'), unknown = gateList.filter(g => g.status === 'UNKNOWN');
  const risk = total('RISK', [
    f('Hard gates passed', (gateList.length - failed.length - unknown.length) / gateList.length * 50, 50, `${failed.length} failed · ${unknown.length} unknown`),
    f('No social red flags', auth === 'SUSPICIOUS' ? 0 : auth === 'UNCERTAIN' ? 10 : 20, 20, auth),
    f('Pool not brand new', m.poolAgeMin !== null ? clamp(m.poolAgeMin / 30) * 15 : 0, 15, m.poolAgeMin === null ? 'UNKNOWN' : `${Math.round(m.poolAgeMin)} min`),
    f('Evidence completeness', clamp(1 - unknown.length / gateList.length) * 15, 15, `${unknown.length} of ${gateList.length} gates UNKNOWN`),
  ]);
  const momentum = total('MOMENTUM', [
    f('Buy pressure (5m)', m.buySellRatio5m !== null ? clamp((m.buySellRatio5m - 1) / 1) * 35 : 0, 35, num(m.buySellRatio5m)),
    f('Volume acceleration', m.volumeAcceleration !== null ? clamp(m.volumeAcceleration / 2) * 35 : 0, 35, `${num(m.volumeAcceleration)}×`),
    f('Price trend (5m)', m.priceChange5mPct !== null ? clamp(m.priceChange5mPct / 10) * 15 : 0, 15, pct(m.priceChange5mPct)),
    f('Persistence across scans', clamp(i.watch.momentumStreak / DESK.momentum.minObservations) * 15, 15, `${i.watch.momentumStreak} consecutive`),
  ]);
  return [fundamental, social, market, onchain, risk, momentum];
}

function momentumShortfall(m: CandidateMetrics): string {
  const k = DESK.momentum, parts: string[] = [];
  if (m.volumeAcceleration === null || m.volumeAcceleration < k.minAcceleration) parts.push(`acceleration ${num(m.volumeAcceleration)}× < ${k.minAcceleration}×`);
  if (m.priceChange5mPct === null || m.priceChange5mPct < k.minPriceChange5mPct) parts.push(`5m price ${pct(m.priceChange5mPct)} < ${k.minPriceChange5mPct}%`);
  return parts.join(', ') || 'buy pressure not sustained';
}

/** Momentum holds when this scan's flow still shows buy pressure, acceleration and a non-falling price. */
export function momentumHolds(m: CandidateMetrics): boolean {
  return m.buySellRatio5m !== null && m.buySellRatio5m > DESK.gates.minBuySellRatio &&
    m.volumeAcceleration !== null && m.volumeAcceleration >= DESK.momentum.minAcceleration &&
    m.priceChange5mPct !== null && m.priceChange5mPct >= DESK.momentum.minPriceChange5mPct;
}

export function analyze(i: AnalysisInput): Candidate {
  const m: CandidateMetrics = { ...i.metrics };
  const o = i.onchain;
  if (o?.holders) { m.top10WalletPct = o.holders.walletTop10Pct; m.largestWalletPct = o.holders.largestWalletPct; }
  if (o?.developer) m.developerPct = o.developer.heldPct;
  if (o?.flow) m.washRatio = o.flow.washRatio;
  const gateList = gates({ ...i, metrics: m });
  const confirmed = gateList.every(g => !g.blocking || g.status === 'PASS') && momentumHolds(m);
  const streak = confirmed ? i.watch.momentumStreak + 1 : 0;
  const input = { ...i, metrics: m, watch: { ...i.watch, momentumStreak: streak } };
  const scoreList = scores(input, gateList);
  const score = (k: ComponentScore['key']) => scoreList.find(s => s.key === k)!.score;
  const failed = gateList.filter(g => g.status === 'FAIL' && g.blocking), unknown = gateList.filter(g => g.status === 'UNKNOWN' && g.blocking);
  const riskFlags = [...gateList.filter(g => g.status === 'FAIL' && !g.blocking).map(g => `${g.label}: ${g.actual} (${g.required})`),
    ...gateList.filter(g => g.status === 'UNKNOWN' && !g.blocking).map(g => `${g.label} UNKNOWN`),
    ...(i.social?.auth.flags.filter(f => /MISMATCH|Engagement|No posts/.test(f)) ?? []), ...(o?.safety?.warnings ?? [])];
  const reasons: string[] = [];
  const safetyFail = failed.some(g => ['mintAuthority', 'freezeAuthority', 'contract'].includes(g.key));
  let status: CandidateStatus, classification: Classification;
  if (failed.length) {
    reasons.push(...failed.map(g => `${g.label}: ${g.actual} (${g.required})`));
  }
  if (i.tier === 'ULTRA_EARLY') {
    // Discovery first: an early token is classified, and only enters the entry path once every hard gate passes.
    const highRisk = safetyFail || gateList.some(g => g.key === 'fairLaunch' && g.status === 'FAIL') || (m.top10WalletPct ?? 0) > DESK.gates.maxTop10WalletPct || (m.developerPct ?? 0) > DESK.gates.maxDeveloperPct ||
      i.social?.auth.authenticity === 'SUSPICIOUS' || (m.washRatio ?? 0) > i.maxWashRatio;
    classification = safetyFail ? 'REJECT' : highRisk ? 'HIGH_RISK' : score('MOMENTUM') >= 60 && score('ONCHAIN') >= 60 ? 'PROMISING'
      : (m.poolAgeMin ?? Infinity) <= 30 ? 'EARLY' : 'WATCH';
    status = classification === 'REJECT' ? 'FILTERED' : 'WATCHLIST';
    if (!reasons.length) reasons.push(unknown.length ? `Waiting for evidence: ${unknown.map(g => g.label).join(', ')}` : 'Ultra-early discovery: monitored, not auto-executed');
  } else if (failed.length) {
    status = 'FILTERED'; classification = 'REJECT';
  } else if (unknown.length) {
    status = 'WATCHLIST'; classification = 'WATCH';
    reasons.push(`Evidence missing: ${unknown.map(g => g.label).join(', ')}`);
  } else if (streak < DESK.momentum.minObservations) {
    status = 'WAITING'; classification = 'WAITING';
    reasons.push(streak === 0 ? `Momentum below threshold: ${momentumShortfall(m)}`
      : `Momentum confirmed in ${streak}/${DESK.momentum.minObservations} consecutive scans`);
  } else {
    status = 'QUALIFIED'; classification = 'QUALIFIED';
    reasons.push('All hard gates passed and momentum confirmed');
  }
  return {
    mint: i.found.mint, symbol: i.pair.baseToken.symbol ?? null, name: i.pair.baseToken.name ?? null, tier: i.tier, sources: i.found.sources,
    pair: { address: i.pair.pairAddress, dex: i.pair.dexId, quote: i.pair.quoteToken.symbol ?? null, url: `https://dexscreener.com/solana/${i.pair.pairAddress}` },
    status, classification, reasons, metrics: m,
    social: {
      website: i.social?.website.url ?? null, websiteStatus: i.social ? i.social.website.status : 'UNKNOWN', description: i.found.description,
      x: i.social?.link ?? { kind: 'NONE', handle: null, url: null },
      xAccountCreatedAt: i.social?.account ? new Date(i.social.account.createdAt).toISOString() : null,
      xFollowers: i.social?.account?.followers ?? null, xPosts7d: i.social?.auth.posts7d ?? null,
      xEngagementRatePct: i.social?.auth.engagementRatePct ?? null, narrativeVelocity: narrative(input) ?? 'UNKNOWN',
      authenticity: i.social?.auth.authenticity ?? 'UNVERIFIED', authenticityFlags: i.social?.auth.flags ?? ['Not analysed yet'],
    },
    onchain: { mintAuthority: o?.safety ? o.safety.hasMintAuthority : null, freezeAuthority: o?.safety ? o.safety.hasFreezeAuthority : null,
      token2022: o?.safety ? o.safety.isToken2022 : null, risks: o?.safety?.reasons ?? [], decimals: o?.holders?.decimals ?? (o?.safety ? o.safety.decimals : null) },
    evidence: evidenceList(input), gates: gateList, scores: scoreList, riskFlags,
    firstSeenAt: i.watch.firstSeenAt, updatedAt: i.now, deepAnalyzedAt: i.onchainAt, observations: i.watch.observations + 1, momentumStreak: streak, crash: null,
  };
}

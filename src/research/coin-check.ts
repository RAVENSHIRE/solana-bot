import fs from 'node:fs/promises';
import { JupiterTokens, type JupToken, type WatchToken } from './verified';
import { scanHolders, type HolderRpc } from './holders';
import { GECKO_REST_MS, type SharedRest } from '../data/shared-rest';
import { milestoneContext, tierOf } from './fundamentals/levels';
import { athSummary, type Bar } from './fundamentals/history';
import { impliedSupply, readHistory, readMarket, type TokenMarket } from './fundamentals/market';
import { scanToken, type Finding, type Verdict as ScanVerdict } from './fundamentals/scanner';

/**
 * One coin, checked from three sources, as the owner asked for WWW and SI on 3 Oct, now from the dashboard:
 *   1. Jupiter (holders and their change, real "organic" buying and selling, the developer's history, liquidity),
 *   2. DexScreener and GeckoTerminal (market cap, the all-time high and how far below it, the decade levels),
 *      with GoPlus and RugCheck (the contract),
 *   3. the chain (the 20 largest holders, who funded them, clusters, the team's share).
 * The verdict is a reading of those numbers, not a qualified call: only the research gate makes calls.
 */
export const COIN_CHECK = Object.freeze({
  /** A developer wallet that created this many coins is a launcher, not a project team. */
  massLauncherMints: 100,
  /** "Just under a level": within this multiple of the next decade level. */
  nearLevelX: 1.5,
});

export interface CoinCheck {
  mint: string; at: number;
  token: { symbol: string | null; name: string | null; dev: string | null; launchpad: string | null; createdAt: number | null; links: string[] };
  market: { mcapUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; change1hPct: number | null; change24hPct: number | null; url: string | null } | null;
  level: { tier: string | null; belowUsd: number | null; nextUsd: number | null; toNextX: number | null };
  history: { athUsd: number; athAt: number; drawdownPct: number; toAthX: number; lowSinceAthUsd: number; bars: number; interval: string } | null;
  security: { verdict: ScanVerdict; findings: Finding[]; goplus: string; rugcheck: string } | null;
  holders: {
    count: number | null; change1hPct: number | null; change24hPct: number | null; topHoldersPct: number | null;
    devMints: number | null; devMigrations: number | null;
    scan: { top20Pct: number; programPct: number; walletPct: number; clusterPct: number; teamPct: number; freshPct: number; largestWalletPct: number | null;
      largestCluster: { pct: number; wallets: number } | null } | null;
  };
  demand: { organicScore: number | null; realBuy1hUsd: number | null; realSell1hUsd: number | null; realBuy24hUsd: number | null; realSell24hUsd: number | null;
    realShare24hPct: number | null; liquidityChange24hPct: number | null; buyers1h: number | null };
  verdict: { tone: 'good' | 'warn' | 'bad'; headline: string; lines: string[] };
  watched: boolean;
  /** Sources that did not answer (the check still shows what the others said). */
  errors: string[];
}

export interface CoinCheckDeps {
  fetcher?: typeof fetch;
  jupiterApiKey?: string | null;
  holders?: HolderRpc | null;
  watchFile?: string | null;
  now?: () => number;
  /** Wait before the one retry of a holder scan the RPC refused as too many requests (429). */
  retryMs?: number;
  /** GeckoTerminal's rest shared with the desk and the ladder: while it rests, the price history is skipped (and listed). */
  geckoRest?: SharedRest | null;
}

const usd = (x: number | null | undefined) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(0)}`;
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 10 ? 1 : 0)}%`;
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : null;
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** The holder scan shares the RPC with the desk and the observer: a 429 (too many requests) is tried once more after a pause. */
async function scanOnce(rpc: HolderRpc, mint: string, dev: string | null, now: number, retryMs: number): ReturnType<typeof scanHolders> {
  try { return await scanHolders(rpc, mint, { dev, now }); } catch (error) {
    if (!/429|too many requests/i.test((error as Error).message ?? '')) throw error;
    await new Promise(r => setTimeout(r, retryMs));
    return scanHolders(rpc, mint, { dev, now });
  }
}
export const isSolanaMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** The reading of the numbers: what the owner would otherwise piece together by hand. */
export function verdict(c: Omit<CoinCheck, 'verdict'>): CoinCheck['verdict'] {
  const lines: string[] = [], d = c.demand, h = c.holders, mcap = c.market?.mcapUsd ?? null;
  if (mcap !== null) {
    const hi = c.history;
    lines.push(`Price: ${usd(mcap)}${hi ? `, ${Math.abs(hi.drawdownPct).toFixed(0)}% below its ${usd(hi.athUsd)} high (${when(hi.athAt)}); ${hi.toAthX.toFixed(1)}× back to it` : ''}` +
      `${c.level.nextUsd ? ` · next level ${usd(c.level.nextUsd)} (${c.level.toNextX!.toFixed(1)}× away)` : ''}.`);
  }
  if (c.security) lines.push(`Contract: ${c.security.verdict === 'PASS' ? 'passes both security scans' : c.security.verdict === 'UNKNOWN' ? 'no scan answered' : `${c.security.verdict}: ${c.security.findings.filter(f => f.level !== 'INFO').map(f => f.detail).slice(0, 3).join('; ')}`}.`);
  const parts: string[] = [];
  if (h.scan) parts.push(`the largest 20 hold ${h.scan.top20Pct.toFixed(0)}%${h.scan.largestWalletPct !== null ? ` (biggest wallet ${h.scan.largestWalletPct.toFixed(1)}%)` : ''}`,
    h.scan.clusterPct >= 1 ? `${h.scan.clusterPct.toFixed(0)}% sits in wallets funded by one source (likely one actor)` : 'no group of wallets controlled by one person found',
    `the team holds ${h.scan.teamPct.toFixed(1)}%`);
  else if (h.topHoldersPct !== null) parts.push(`the largest holders own ${h.topHoldersPct.toFixed(0)}%`);
  if (h.devMints !== null && h.devMints >= COIN_CHECK.massLauncherMints) parts.push(`the developer wallet created ${h.devMints.toLocaleString('en-US')} coins (${h.devMigrations ?? 0} reached the exchange): a mass launcher, not a project team`);
  if (parts.length) lines.push(`Holders: ${parts.join('; ')}.`);
  const demand: string[] = [];
  if (h.change24hPct !== null) demand.push(`holders ${pct(h.change24hPct)} in 24 h${h.count !== null ? ` (${h.count.toLocaleString('en-US')})` : ''}`);
  if (d.realBuy1hUsd !== null && d.realSell1hUsd !== null) demand.push(`real buys/sells last hour ${usd(d.realBuy1hUsd)} / ${usd(d.realSell1hUsd)}`);
  if (d.realBuy24hUsd !== null && d.realSell24hUsd !== null) demand.push(`24 h ${usd(d.realBuy24hUsd)} / ${usd(d.realSell24hUsd)}`);
  if (d.realShare24hPct !== null) demand.push(`about ${d.realShare24hPct.toFixed(0)}% of trading is real, the rest bots`);
  if (d.liquidityChange24hPct !== null) demand.push(`liquidity ${pct(d.liquidityChange24hPct)} in 24 h`);
  if (demand.length) lines.push(`Demand: ${demand.join('; ')}.`);

  const buyersLead = (b: number | null, s: number | null) => b !== null && s !== null && b > s;
  const sellersLead = (b: number | null, s: number | null) => b !== null && s !== null && s > b * 1.2;
  const holdersUp = (h.change24hPct ?? 0) > 0, holdersDown = (h.change24hPct ?? 0) < 0;
  const noTeam = h.devMints !== null && h.devMints >= COIN_CHECK.massLauncherMints;
  const next = c.level.nextUsd !== null && c.level.toNextX !== null && c.level.toNextX <= COIN_CHECK.nearLevelX ? c.level.nextUsd : null;
  let tone: CoinCheck['verdict']['tone'], headline: string;
  if (c.security?.verdict === 'BLOCK') { tone = 'bad'; headline = 'Do not touch: the contract scan blocks it.'; }
  else if (holdersUp && buyersLead(d.realBuy1hUsd, d.realSell1hUsd) && buyersLead(d.realBuy24hUsd, d.realSell24hUsd)) {
    tone = 'good'; headline = `Demand is building: holders rising and real buyers leading${noTeam ? ', but no team behind it' : ''}. Worth a closer look — not a qualified call.`;
  } else if (holdersDown || sellersLead(d.realBuy1hUsd, d.realSell1hUsd)) {
    tone = 'bad'; headline = `${c.security?.verdict === 'PASS' ? 'Clean coin, ' : ''}demand is fading${noTeam ? ', no team behind it' : ''}: not a buy signal.`;
  } else { tone = 'warn'; headline = `Mixed: no clear demand either way${noTeam ? ', and no team behind it' : ''}. Not a buy signal yet.`; }
  if (tone !== 'good' && c.security?.verdict !== 'BLOCK')
    lines.push(`It would become interesting if holders rise again and real buyers lead for several hours${next ? `, with the price back above ${usd(next)}` : ''}.`);
  return { tone, headline, lines };
}

export async function readWatchlist(file: string | null | undefined): Promise<WatchToken[]> {
  if (!file) return [];
  try { const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; return Array.isArray(raw) ? raw.filter((x): x is WatchToken => !!x && typeof (x as WatchToken).mint === 'string') : []; }
  catch { return []; }
}

/** Puts a coin on the research watchlist (read by the observer at every check: INFO when it moves, ladder records). */
export async function addToWatchlist(file: string, mint: string, note: string): Promise<boolean> {
  if (!isSolanaMint(mint)) throw new Error('INVALID_MINT');
  const list = await readWatchlist(file);
  if (list.some(w => w.mint === mint)) return false;
  list.push({ mint, note: note.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `[\n${list.map(w => `  ${JSON.stringify(w)}`).join(',\n')}\n]\n`);
  await fs.rename(tmp, file);
  return true;
}

export async function checkCoin(mint: string, d: CoinCheckDeps = {}): Promise<CoinCheck> {
  if (!isSolanaMint(mint)) throw new Error('INVALID_MINT');
  const now = (d.now ?? Date.now)(), errors: string[] = [];
  const fail = (source: string) => (e: unknown) => { errors.push(`${source}: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`); return null; };
  const [jup, dex, scan, watch] = await Promise.all([
    new JupiterTokens({ fetcher: d.fetcher, apiKey: d.jupiterApiKey }).get(`search?query=${mint}`).then(list => list.find(t => t.id === mint) ?? null).catch(fail('Jupiter')),
    readMarket('solana', mint, { fetcher: d.fetcher }).then(r => r.market).catch(fail('DexScreener')),
    scanToken('solana', mint, { fetcher: d.fetcher }).catch(fail('security scan')),
    readWatchlist(d.watchFile),
  ]);
  const t: JupToken | null = jup, m: TokenMarket | null = dex;
  const created = t?.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : m?.firstPairAt ?? null;
  // History and holders need the pair and the developer from the first round.
  const supply = m ? impliedSupply(m) : null, young = created !== null && now - created < 40 * 86_400_000;
  const [bars, holderScan] = await Promise.all([
    m?.pairAddress && supply ? (d.geckoRest?.resting() ? Promise.reject(new Error(`GeckoTerminal resting after a rate limit until ${new Date(d.geckoRest.until()).toISOString().slice(11, 16)} UTC`))
      : readHistory('solana', m.pairAddress, mint, young ? 'hour' : 'day', supply, { fetcher: d.fetcher }).catch((e: Error) => {
        if (/HTTP 429/.test(e.message)) d.geckoRest?.rest(GECKO_REST_MS);
        throw e;
      })).catch(fail('price history')) : Promise.resolve(null),
    d.holders ? scanOnce(d.holders, mint, t?.dev ?? null, now, d.retryMs ?? 5_000).catch(fail('holder scan')) : Promise.resolve(null),
  ]);
  const a = bars ? athSummary(bars as Bar[]) : null;
  const mcap = num(m?.marketCapUsd) ?? num(t?.mcap), lv = milestoneContext(mcap);
  const s1 = t?.stats1h ?? {}, s24 = t?.stats24h ?? {};
  const vol24 = s24.buyVolume !== undefined || s24.sellVolume !== undefined ? (s24.buyVolume ?? 0) + (s24.sellVolume ?? 0) : null;
  const real24 = s24.buyOrganicVolume !== undefined || s24.sellOrganicVolume !== undefined ? (s24.buyOrganicVolume ?? 0) + (s24.sellOrganicVolume ?? 0) : null;
  const wallets = holderScan?.holders.filter(x => x.kind === 'wallet') ?? [];
  const base: Omit<CoinCheck, 'verdict'> = {
    mint, at: now,
    token: { symbol: t?.symbol ?? m?.symbol ?? null, name: t?.name ?? m?.name ?? null, dev: t?.dev ?? null, launchpad: t?.launchpad ?? null, createdAt: created,
      links: [...new Set([...(m?.links ?? []), ...[t?.website, t?.twitter].filter((x): x is string => !!x)])] },
    market: m || t ? { mcapUsd: mcap, liquidityUsd: num(m?.liquidityUsd) ?? num(t?.liquidity), volume24hUsd: num(m?.volume24hUsd) ?? vol24,
      change1hPct: num(s1.priceChange), change24hPct: num(m?.priceChange24hPct) ?? num(s24.priceChange), url: m?.url ?? null } : null,
    level: { tier: tierOf(mcap)?.id ?? null, belowUsd: lv.belowUsd, nextUsd: lv.nextUsd, toNextX: lv.toNextX },
    history: a ? { athUsd: a.athUsd, athAt: a.athAt, drawdownPct: a.drawdownPct, toAthX: a.toAthX, lowSinceAthUsd: a.lowSinceAthUsd, bars: a.bars, interval: young ? 'hour' : 'day' } : null,
    security: scan ? { verdict: scan.verdict, findings: scan.findings, goplus: scan.sources.goplus, rugcheck: scan.sources.rugcheck } : null,
    holders: { count: num(t?.holderCount), change1hPct: num(s1.holderChange), change24hPct: num(s24.holderChange), topHoldersPct: num(t?.audit?.topHoldersPercentage),
      devMints: num(t?.audit?.devMints), devMigrations: num(t?.audit?.devMigrations),
      scan: holderScan ? { top20Pct: holderScan.topPct, programPct: holderScan.programPct, walletPct: holderScan.walletPct, clusterPct: holderScan.clusterPct,
        teamPct: holderScan.teamPct, freshPct: holderScan.freshPct, largestWalletPct: wallets.length ? Math.max(...wallets.map(w => w.pct)) : null,
        largestCluster: holderScan.largest ? { pct: holderScan.largest.pct, wallets: holderScan.largest.wallets } : null } : null },
    demand: { organicScore: num(t?.organicScore), realBuy1hUsd: num(s1.buyOrganicVolume), realSell1hUsd: num(s1.sellOrganicVolume),
      realBuy24hUsd: num(s24.buyOrganicVolume), realSell24hUsd: num(s24.sellOrganicVolume), realShare24hPct: vol24 && real24 !== null ? real24 / vol24 * 100 : null,
      liquidityChange24hPct: num(s24.liquidityChange), buyers1h: num(s1.numOrganicBuyers) },
    watched: watch.some(w => w.mint === mint), errors,
  };
  return { ...base, verdict: verdict(base) };
}

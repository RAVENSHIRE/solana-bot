/**
 * Fundamentals: market-cap tier, round milestones, distance to the old high and a security scan for one token on any
 * supported chain, and the milestone and old-high studies over a list of tokens. Read-only: nothing here trades.
 *
 *   npm run research:fundamentals -- --token <address> [--chain solana] [--raw]
 *   npm run research:fundamentals -- --study --tokens tokens.txt [--chain solana] [--horizon-days 30] [--drawdown 80]
 *                                    [--timeframe day|hour] [--out study.json]
 *
 * tokens.txt: one address per line, or `chain:address` (e.g. `base:0x…`); `#` starts a comment.
 * The studies are only as fair as the list: build it before looking at outcomes (see docs/FUNDAMENTALS.md).
 */
import fs from 'node:fs';
import { MILESTONES, capacityUsd, milestoneContext, tierOf } from '../research/fundamentals/levels';
import { athSummary, crossings, reclaims, summarizeCrossings, summarizeReclaims, type Bar, type CrossingGroup, type Rate, type ReclaimGroup } from '../research/fundamentals/history';
import { impliedSupply, readHistory, readMarket, type Timeframe } from '../research/fundamentals/market';
import { CHAINS, scanToken, type Chain } from '../research/fundamentals/scanner';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(`--${name}`);
const DAY = 86_400_000;

const usd = (x: number | null | undefined) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(2)}`;
const pct = (x: number | null | undefined, digits = 0) => x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)} %`;
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const days = (ms: number) => ms < DAY ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} days`;
const rateCell = (r: Rate) => r.rate === null ? '–'.padEnd(16) : `${(r.rate * 100).toFixed(0)} % (${(r.low! * 100).toFixed(0)}–${(r.high! * 100).toFixed(0)})`.padEnd(16);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function chainOf(value: string | undefined): Chain {
  const c = (value ?? 'solana').toLowerCase();
  if (!(CHAINS as readonly string[]).includes(c)) throw new Error(`Unknown chain "${value}". Supported: ${CHAINS.join(', ')}`);
  return c as Chain;
}

async function card(chain: Chain, token: string): Promise<void> {
  const now = Date.now();
  const [marketRead, scan] = await Promise.all([readMarket(chain, token).catch((e: unknown) => ({ market: null, raw: null, error: String(e) })), scanToken(chain, token)]);
  const m = marketRead.market;
  if (!m) console.log(`${token} · ${chain}: no ${chain} pair on DexScreener${'error' in marketRead ? ` (${marketRead.error})` : ''}`);
  let bars: Bar[] = [], timeframe: Timeframe = 'hour';
  if (m) {
    const age = m.firstPairAt !== null ? now - m.firstPairAt : null;
    console.log(`${m.symbol ?? '?'} · ${m.name ?? '?'} · ${chain} · ${m.dexId}${m.url ? ` · ${m.url}` : ''}`);
    console.log(`  Market cap ${usd(m.marketCapUsd)} · FDV ${usd(m.fdvUsd)} · liquidity ${usd(m.liquidityUsd)} · 24h volume ${usd(m.volume24hUsd)} (${pct(m.priceChange24hPct)})` +
      ` · 24h ${m.buys24h ?? '–'} buys / ${m.sells24h ?? '–'} sells`);
    console.log(`  Age ${age !== null ? `${days(age)} (first pair ${when(m.firstPairAt!)})` : '–'} · ${m.pairs} pair(s)${m.links.length ? ` · ${m.links.join(' ')}` : ''}`);
    const tier = tierOf(m.marketCapUsd ?? m.fdvUsd), ms = milestoneContext(m.marketCapUsd ?? m.fdvUsd);
    console.log(`  Tier ${tier ? `${tier.id} (${tier.label})` : '–'} · next milestone ${usd(ms.nextUsd)}: ${ms.toNextX?.toFixed(1) ?? '–'}× away` +
      ` · ${ms.decadePosition !== null ? `${(ms.decadePosition * 100).toFixed(0)} % of the way from ${usd(ms.belowUsd ?? (ms.nextUsd! / 10))}` : ''}`);
    console.log(`  One entry at about 2 % price impact: up to ${usd(capacityUsd(m.liquidityUsd))}`);
    const supply = impliedSupply(m);
    if (supply !== null && m.pairAddress) {
      timeframe = age !== null && age > 40 * DAY ? 'day' : 'hour';
      bars = await readHistory(chain, m.pairAddress, token, timeframe, supply).catch((e: unknown) => { console.log(`  History: ${String(e)}`); return []; });
    }
    const a = athSummary(bars);
    if (a) {
      console.log(`  History (${timeframe === 'day' ? 'daily' : 'hourly'}, ${a.bars} bars from ${when(a.firstAt)}): high ${usd(a.athUsd)} on ${when(a.athAt)}` +
        ` · now ${pct(a.drawdownPct)} from it · ${a.toAthX.toFixed(1)}× back to the high · lowest since ${usd(a.lowSinceAthUsd)}`);
      const crossed = crossings(bars, { horizonMs: 0, asOf: now, levels: MILESTONES.map(u => ({ usd: u, round: true })) });
      if (crossed.length) console.log(`  Milestones first closed above: ${crossed.map(c => `${usd(c.levelUsd)} ${when(c.at)}`).join(' · ')}`);
      console.log('  The old high is a reference, not a target: the old-high study (--study) measures how often coins get back to it.');
    }
  }
  console.log(`  Security ${scan.verdict} · GoPlus ${scan.sources.goplus} · RugCheck ${scan.sources.rugcheck}`);
  for (const f of scan.findings) console.log(`    ${f.level.padEnd(5)} ${f.source.padEnd(8)} ${f.detail}`);
  if (has('raw')) console.log(JSON.stringify({ dexscreener: marketRead.raw, goplus: scan.raw.goplus, rugcheck: scan.raw.rugcheck }, null, 2));
}

function crossingTable(title: string, g: { round: CrossingGroup; control: CrossingGroup }): void {
  console.log(`  ${title}`);
  console.log(`    ${''.padEnd(9)}${'crossings'.padEnd(11)}${'censored'.padEnd(10)}${'reached 2×'.padEnd(16)}${'reached 10×'.padEnd(16)}${'held above'.padEnd(16)}median max gain / drawdown`);
  for (const [label, x] of [['Round', g.round], ['Control', g.control]] as const) {
    console.log(`    ${label.padEnd(9)}${String(x.crossings).padEnd(11)}${String(x.censored).padEnd(10)}${rateCell(x.reached2x)}${rateCell(x.reached10x)}${rateCell(x.heldAbove)}` +
      `${pct(x.medianMaxGainPct)} / ${pct(x.medianMaxDrawdownPct)}`);
  }
}
const reclaimLine = (label: string, g: ReclaimGroup) =>
  console.log(`    ${label.padEnd(16)}${String(g.events).padEnd(8)}${String(g.censored).padEnd(10)}${rateCell(g.reclaimed).padEnd(18)}${pct(g.medianMaxGainPct)}`);

async function study(defaultChain: Chain): Promise<void> {
  const file = arg('tokens');
  if (!file) throw new Error('--study needs --tokens <file>');
  const list = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => {
    const i = l.indexOf(':');
    return i > 0 ? { chain: chainOf(l.slice(0, i)), token: l.slice(i + 1) } : { chain: defaultChain, token: l };
  });
  const horizonMs = Number(arg('horizon-days') ?? 30) * DAY, drawdownPct = Number(arg('drawdown') ?? 80);
  const timeframe: Timeframe = arg('timeframe') === 'hour' ? 'hour' : 'day', now = Date.now();
  const all = [] as ReturnType<typeof crossings>, falls = [] as NonNullable<ReturnType<typeof reclaims>>[], perToken: unknown[] = [];
  let noPair = 0, noHistory = 0, failed = 0;
  for (const [i, t] of list.entries()) {
    process.stdout.write(`\r  ${i + 1}/${list.length} ${t.token.slice(0, 12)}…   `);
    // A failed request is not a dead coin: it is counted apart so a blocked API cannot look like a market result.
    const read = await readMarket(t.chain, t.token).then(r => ({ market: r.market, error: null }), (e: unknown) => ({ market: null, error: String(e) }));
    await sleep(1_000);
    if (read.error) { failed++; perToken.push({ ...t, status: 'error', error: read.error }); continue; }
    const market = read.market, supply = market ? impliedSupply(market) : null;
    if (!market || supply === null) { noPair++; perToken.push({ ...t, status: 'no pair' }); continue; }
    const hist = await readHistory(t.chain, market.pairAddress, t.token, timeframe, supply)
      .then(bars => ({ bars, error: null as string | null }), (e: unknown) => ({ bars: [] as Bar[], error: String(e) }));
    await sleep(2_200); // GeckoTerminal's public API allows about 30 requests a minute
    if (hist.error) { failed++; perToken.push({ ...t, status: 'error', error: hist.error }); continue; }
    const bars = hist.bars;
    if (!bars.length) { noHistory++; perToken.push({ ...t, status: 'no history' }); continue; }
    const cs = crossings(bars, { horizonMs, asOf: now }), fall = reclaims(bars, { drawdownPct, horizonMs, asOf: now });
    all.push(...cs); if (fall) falls.push(fall);
    perToken.push({ ...t, status: 'ok', symbol: market.symbol, bars: bars.length, ath: athSummary(bars), crossings: cs, fall });
  }
  process.stdout.write('\n');
  const withHistory = list.length - noPair - noHistory - failed;
  console.log(`FUNDAMENTALS STUDY · ${list.length} tokens · ${withHistory} with history · ${noPair} without a pair · ${noHistory} without candles · ${failed} failed requests`);
  if (failed) console.log(`  ${failed} token(s) could not be read (network or API errors; see --out): the results below leave them out.`);
  console.log(`  ${timeframe === 'day' ? 'Daily' : 'Hourly'} bars, market cap = price × today's supply, horizon ${horizonMs / DAY} days, 95 % intervals in brackets`);
  const s = summarizeCrossings(all);
  crossingTable('MILESTONES: first close above a round market cap vs a non-round control level in the same decade', s);
  for (const d of s.byDecade) crossingTable(`  decade from ${usd(d.milestoneUsd)}`, d);
  const r = summarizeReclaims(falls);
  console.log(`  OLD HIGH: first close ≥ ${drawdownPct} % below the running high, and whether the high came back within ${horizonMs / DAY} days`);
  console.log(`    ${''.padEnd(16)}${'events'.padEnd(8)}${'censored'.padEnd(10)}${'back to the high'.padEnd(18)}median max gain after the fall`);
  reclaimLine('All', r.all); reclaimLine('Fell within 7 d', r.young); reclaimLine('Fell later', r.older);
  console.log('  Universe: this list. If it was built from coins that are still alive today, every rate above is too high.');
  if (arg('out')) { fs.writeFileSync(arg('out')!, JSON.stringify({ at: now, horizonMs, drawdownPct, timeframe, summary: { milestones: s, oldHigh: r }, tokens: perToken }, null, 2)); console.log(`  Written: ${arg('out')}`); }
}

async function main(): Promise<void> {
  const chain = chainOf(arg('chain'));
  if (has('study')) return study(chain);
  const token = arg('token');
  if (!token) throw new Error('Usage: --token <address> [--chain solana] [--raw]  or  --study --tokens <file>');
  return card(chain, token);
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });

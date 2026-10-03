/**
 * Ladder report: what followed each recorded snapshot of the market-cap ladder (research/ladder.ts), by tier, distance
 * below the all-time high, holders, buying vs selling, old-runner revival, team share and chain, plus where the
 * watchlist coins stand now. Read-only; reads data-desk/research/ladder.
 *
 *   npm run research:ladder -- [--dir data-desk/research/ladder] [--watch data-desk/research/watch-tokens.json] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ledgerFiles } from '../research/dataset';
import { levels, readLadder, tierOf } from '../research/ladder';
import { HORIZONS, cohorts, ladderGroups, ladderSamples, type CohortRow, type Horizon } from '../research/ladder-study';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const usd = (x: number | null | undefined) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : `$${(x / 1e3).toFixed(0)}K`;
const p = (x: number | null) => x === null ? '  –  ' : `${x.toFixed(0).padStart(3)} %`;

function line(r: CohortRow): string {
  const split = r.earlyUp2xPct === null || r.lateUp2xPct === null ? '' : ` · 2× early ${r.earlyUp2xPct.toFixed(0)} % / late ${r.lateUp2xPct.toFixed(0)} %`;
  return `    ${r.label.padEnd(36)} n ${String(r.n).padStart(5)} | 2× ${p(r.up2xPct)} | next level ${p(r.nextLevelPct)} | back to high ${p(r.athPct)} | ` +
    `halved first ${p(r.halvedFirstPct)} | median best ${r.medianRisePct >= 0 ? '+' : ''}${r.medianRisePct.toFixed(0)} %${split}${r.vanished ? ` · ${r.vanished} vanished` : ''}`;
}

function main(): void {
  const dir = path.resolve(arg('dir') ?? 'data-desk/research/ladder');
  const files = fs.existsSync(dir) ? ledgerFiles(dir) : [];
  const data = readLadder(files);
  const snaps = [...data.values()].flatMap(c => c.snaps.map(s => s.at));
  const end = snaps.length ? Math.max(...snaps) : Date.now(), start = snaps.length ? Math.min(...snaps) : end;
  const samples = ladderSamples(data, end);
  const nets = new Map<string, number>();
  for (const c of data.values()) nets.set(c.net, (nets.get(c.net) ?? 0) + 1);
  console.log(`LADDER REPORT · ${dir}`);
  console.log(`  ${data.size} coins over ${((end - start) / 3_600_000).toFixed(1)} h (${[...nets].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ') || 'no data yet'}), ` +
    `${samples.length} daily samples, ${[...data.values()].filter(c => c.histories.length).length} with price history, ${[...data.values()].filter(c => c.holders.length).length} with a holder scan`);
  const json: Record<string, unknown> = { generatedAt: Date.now(), coins: data.size, samples: samples.length, horizons: {} };
  for (const h of Object.keys(HORIZONS) as Horizon[]) {
    const done = samples.filter(s => s.outcome[h]).length;
    console.log(`\n  WHAT FOLLOWED WITHIN ${h} (${done} samples old enough)`);
    if (!done) { console.log(`    none yet: a sample needs ${h} of data after it`); continue; }
    const out: Record<string, CohortRow[]> = {};
    for (const [title, groups] of ladderGroups(samples)) {
      const rows = cohorts(samples, h, groups).filter(r => r.n > 0);
      if (!rows.length) continue;
      console.log(`  ${title}`);
      for (const r of rows) console.log(line(r));
      out[title] = rows;
    }
    (json.horizons as Record<string, unknown>)[h] = out;
  }
  const watchFile = path.resolve(arg('watch') ?? path.join(dir, '..', 'watch-tokens.json'));
  const watch = (() => { try { return (JSON.parse(fs.readFileSync(watchFile, 'utf8')) as Array<{ mint: string; note?: string }>).map(w => w.mint); } catch { return []; } })();
  if (watch.length) console.log('\n  WATCHLIST NOW');
  for (const mint of watch) {
    const c = data.get(`solana:${mint}`), s = c?.snaps.at(-1);
    if (!c || !s?.mcap) { console.log(`    ${mint.slice(0, 6)}…  not recorded yet`); continue; }
    const hist = c.histories.at(-1), ath = Math.max(hist?.athMcap ?? 0, ...c.snaps.map(x => x.mcap ?? 0)), lv = levels(s.mcap), held = c.holders.at(-1);
    console.log(`    ${(c.symbol ?? mint.slice(0, 6)).padEnd(10)} ${usd(s.mcap)} (${tierOf(s.mcap)}, between ${usd(lv.below)} and ${usd(lv.above)}) · high ${usd(ath)} → ${((1 - s.mcap / ath) * 100).toFixed(0)} % below · ` +
      `holders ${s.holders ?? '–'} (${s.holderCh24h === null ? '–' : `${s.holderCh24h >= 0 ? '+' : ''}${s.holderCh24h.toFixed(1)} % 24h`}) · real buys/sells 1h ${usd(s.orgBuyVol1h)} / ${usd(s.orgSellVol1h)}` +
      `${held ? ` · team ${held.team.toFixed(1)} %, clusters ${held.clu.toFixed(1)} %, fresh wallets ${held.fresh.toFixed(1)} %` : ''}`);
  }
  if (arg('json')) fs.writeFileSync(path.resolve(arg('json')!), JSON.stringify(json, null, 2));
}

main();

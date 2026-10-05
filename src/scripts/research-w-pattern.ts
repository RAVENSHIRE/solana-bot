/**
 * The W on the curve's 15-minute bars, with and without volume behind the breakout (research/w-pattern.ts): first the
 * owner's case coin bar by bar since its launch, then every launch in the observer ledger, judged after costs.
 *
 *   npm run research:w-pattern -- [--dir data-desk/research] [--mint GpR5iDDPZzfHbU1NnqQBqS2XP1SiD5F3WKPMGxf5pump]
 *     [--sol-usd 220] [--size 2] [--fee-pct 1.25] [--fixed 0.03] [--tz Europe/Zurich]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ledgerFiles } from '../research/dataset';
import { bars, findBreakout, findW, netPct, readCurves, trade, W_RULE, type Bar, type CurveCoin, type WSignal } from '../research/w-pattern';
import { brandName } from '../desk/brands';
import { luckP } from '../desk/levels';

async function main(): Promise<void> {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
  const dir = arg('dir', 'data-desk/research'), mint = arg('mint', 'GpR5iDDPZzfHbU1NnqQBqS2XP1SiD5F3WKPMGxf5pump'), tz = arg('tz', 'Europe/Zurich');
  const size = Number(arg('size', '2')), feePct = Number(arg('fee-pct', '1.25')), fixed = Number(arg('fixed', '0.03'));
  let solUsd = Number(arg('sol-usd', '0'));
  if (!solUsd) {
    try {
      const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112')).json() as { pairs?: Array<{ quoteToken: { symbol: string }; priceUsd?: string; liquidity?: { usd?: number } }> };
      const p = (j.pairs ?? []).filter(x => /^USD/.test(x.quoteToken.symbol) && x.priceUsd).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      solUsd = p ? Number(p.priceUsd) : 220;
    } catch { solUsd = 220; }
  }
  const usd = (sol: number) => { const v = sol * solUsd; return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`; };
  const local = (ms: number) => new Date(ms).toLocaleString('de-CH', { timeZone: tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const net = (g: number) => netPct(g, feePct, fixed, size);

  const t0 = Date.now(), coins = readCurves(ledgerFiles(dir));
  console.log(`observer ledger: ${coins.size} launches with curve candles read in ${((Date.now() - t0) / 1000).toFixed(0)} s · SOL $${solUsd.toFixed(2)} · costs ${feePct} % per side + $${fixed} on $${size}`);

  // ------------------------------------------------------------------ the case coin
  const c = coins.get(mint);
  if (c) {
    const b = bars(c.minutes), w = findW(b), k = findBreakout(b);
    console.log(`\n== ${c.symbol ?? mint} (${c.name ?? ''}) ${mint}`);
    console.log(`launched ${local(c.created)} (${tz}) · graduated ${c.complete ? local(c.complete) : 'no'} · ${c.minutes.length} curve minutes with trades · ${b.length} 15-min bars${c.mayhem ? ' · MAYHEM' : ''}`);
    console.log('bar (local)      open      high      low       close     volume SOL  buyers  marks');
    for (const [i, x] of b.entries()) {
      const marks = [w && i === b.findIndex(y => y.h === w.peak) ? 'PEAK' : '', w && x.l === w.low1 ? 'LOW 1' : '', w && x.h === w.neckline && i < w.j ? 'NECKLINE' : '',
        w && x.l === w.low2 ? 'LOW 2' : '', w && i === w.j ? `W BREAKOUT${w.v1 ? ' with volume' : ' WITHOUT volume'}` : '', k && i === k.j ? `2-h high${k.v1 ? ' with volume' : ' without volume'}` : ''].filter(Boolean).join(', ');
      console.log(`${local(x.t)}   ${usd(x.o).padStart(8)}  ${usd(x.h).padStart(8)}  ${usd(x.l).padStart(8)}  ${usd(x.c).padStart(8)}  ${x.vol.toFixed(1).padStart(10)}  ${String(x.buyers).padStart(6)}  ${marks}`);
    }
    for (const s of [w, k].filter((x): x is WSignal => !!x)) {
      const t100 = trade(s, c, 100), t200 = trade(s, c, 200);
      console.log(`${s.kind === 'W' ? 'W' : '2-h high'} at ${local(s.at)}: entry ${usd(s.entry)}, stop ${usd(s.stop)} (${((s.stop / s.entry - 1) * 100).toFixed(0)} %)` +
        `${s.kind === 'W' ? `, peak ${usd(s.peak!)}, lows ${usd(s.low1!)} / ${usd(s.low2!)}, neckline ${usd(s.neckline)}, volume on the breakout: ${s.v1 ? 'yes' : 'NO'}, lighter second low: ${s.v2 ? 'yes' : 'no'}` : `, volume: ${s.v1 ? 'yes' : 'NO'}`}`);
      console.log(`  TP +100 %: ${t100.reason} ${local(t100.exitAt)} at ${usd(t100.exit)}, net ${net(t100.grossPct).toFixed(0)} % (peak +${t100.peakPct.toFixed(0)} %) · TP +200 %: ${t200.reason}, net ${net(t200.grossPct).toFixed(0)} %`);
    }
    if (!w) console.log('No W by the fixed rule on the curve.');
    // After the graduation: the pool, from GeckoTerminal (15-min candles), for what happened next.
    try {
      const pools = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`, { headers: { accept: 'application/json' } })).json() as { data?: Array<{ attributes: { address: string } }> };
      const pool = pools.data?.[0]?.attributes.address;
      if (pool) {
        await new Promise(r => setTimeout(r, 2_500));
        const o = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=15&limit=60&currency=usd&token=${mint}`, { headers: { accept: 'application/json' } })).json() as { data?: { attributes: { ohlcv_list: number[][] } } };
        const list = (o.data?.attributes.ohlcv_list ?? []).map(([t, op, h, l, cl, v]) => ({ t: t! * 1000, o: op!, h: h!, l: l!, c: cl!, v: v! })).sort((a, b) => a.t - b.t);
        console.log(`\nAfter the graduation (pool ${pool.slice(0, 6)}…, 15-min, USD price × 1B supply = market cap):`);
        console.log('bar (local)      high       low        close      volume USD');
        for (const x of list) console.log(`${local(x.t)}   ${('$' + (x.h * 1e9 / 1e3).toFixed(1) + 'K').padStart(9)}  ${('$' + (x.l * 1e9 / 1e3).toFixed(1) + 'K').padStart(9)}  ${('$' + (x.c * 1e9 / 1e3).toFixed(1) + 'K').padStart(9)}  ${('$' + Math.round(x.v).toLocaleString('en-US')).padStart(11)}`);
      }
    } catch (e) { console.log(`pool candles unavailable: ${(e as Error).message}`); }
  } else console.log(`\n${mint}: not in the observer ledger`);

  // ------------------------------------------------------------------ every launch
  type Row = { mint: string; symbol: string | null; created: number; s: WSignal; tp100: number; tp200: number; reason100: string; reason200: string; stopPct: number };
  const rows: Row[] = [];
  let considered = 0, skippedBrand = 0, skippedMayhem = 0;
  for (const coin of coins.values()) {
    if (coin.minutes.length < 4 * 15) continue;
    if (coin.mayhem) { skippedMayhem++; continue; }
    if (brandName(coin.symbol, coin.name)) { skippedBrand++; continue; }
    considered++;
    const b: Bar[] = bars(coin.minutes);
    for (const s of [findW(b), findBreakout(b)]) {
      if (!s) continue;
      const a = trade(s, coin as CurveCoin, 100), z = trade(s, coin as CurveCoin, 200);
      rows.push({ mint: coin.mint, symbol: coin.symbol, created: coin.created, s, tp100: net(a.grossPct), tp200: net(z.grossPct), reason100: a.reason, reason200: z.reason, stopPct: (s.stop / s.entry - 1) * 100 });
    }
  }
  rows.sort((a, b) => a.s.at - b.s.at);
  fs.writeFileSync(path.join(dir, 'w-pattern.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rule: W_RULE, costs: { feePct, fixed, size }, rows }, null, 1));
  console.log(`\n== Backtest: ${considered} launches with ≥ 1 h of curve candles (left out: ${skippedMayhem} mayhem, ${skippedBrand} brand names) · rule fixed in advance, no tuning`);
  const groups: Array<[string, (r: Row) => boolean]> = [
    ['W, all', r => r.s.kind === 'W'], ['W WITH volume on the breakout (V1)', r => r.s.kind === 'W' && r.s.v1 === true], ['W WITHOUT volume (the RESERVE case)', r => r.s.kind === 'W' && r.s.v1 === false],
    ['W with a lighter second low (V2)', r => r.s.kind === 'W' && r.s.v2 === true], ['W with V1 and V2', r => r.s.kind === 'W' && r.s.v1 === true && r.s.v2 === true],
    ['control: new 2-h high, all', r => r.s.kind === 'BREAKOUT'], ['control WITH volume', r => r.s.kind === 'BREAKOUT' && r.s.v1 === true], ['control WITHOUT volume', r => r.s.kind === 'BREAKOUT' && r.s.v1 === false],
  ];
  const fmt = (v: number | null, d = 1) => v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  for (const tp of [100, 200] as const) {
    console.log(`\nTake profit +${tp} % (stop 3 % under the low, out at graduation or 6 h) · net % per trade after costs`);
    console.log('group                                   n    won   average  median  luck p   first 60 % / last 40 %   exits');
    for (const [label, test] of groups) {
      const g = rows.filter(test), v = g.map(r => tp === 100 ? r.tp100 : r.tp200);
      if (!v.length) { console.log(`${label.padEnd(38)}  0`); continue; }
      const mean = (x: number[]) => x.length ? x.reduce((a, y) => a + y, 0) / x.length : null, sorted = [...v].sort((a, b) => a - b);
      const cut = Math.floor(v.length * 0.6), p = luckP(v);
      const reasons = Object.entries(g.reduce<Record<string, number>>((a, r) => { const k = tp === 100 ? r.reason100 : r.reason200; a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([k, n]) => `${k} ${n}`).join(', ');
      console.log(`${label.padEnd(38)} ${String(v.length).padStart(3)}  ${(v.filter(x => x > 0).length / v.length * 100).toFixed(0).padStart(4)} %  ${fmt(mean(v)).padStart(7)}  ${fmt(sorted[Math.floor(v.length / 2)]!).padStart(6)}  ${p === null ? '  --' : p.toFixed(3)}    ${fmt(mean(v.slice(0, cut))).padStart(7)} / ${fmt(mean(v.slice(cut))).padEnd(7)}         ${reasons}`);
    }
  }
  console.log('\nluck p: how often an average this high appears by chance (resampled, 4,000×); < 0.05 is the Level 1 bar. The two halves are by signal time.');
}

main().catch(error => { console.error(error); process.exit(1); });

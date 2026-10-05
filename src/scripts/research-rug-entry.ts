/**
 * RUG-AT-ENTRY, step 1 (descriptive, judges nothing): every CRASH signal since `--since`, its seven features at the
 * graduation from the observer's curve trades, what the desk did with it, and whether it was a rug within 10 min of
 * the signal (pool minute candles from GeckoTerminal). Also freezes the bot list R the first time it runs.
 *
 *   npm run research:rug-entry -- [--dir data-desk/research] [--desk data-desk] [--since 2026-10-05T21:00:00Z]
 *     [--gecko-ms 6000] [--no-candles] [--refreeze]
 *
 * Writes data-desk/research/rug-entry.json (the rows) and, once, data-desk/research/bots-R.json (R, frozen).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ledgerFiles } from '../research/dataset';
import { BOT_LIST, botList, creatorHistory, gradFeatures, pastThresholds, RUG_LABEL, RUG_THRESHOLDS, rugLabel, scanLedger, type GradFeatures } from '../research/rug-entry';

async function main(): Promise<void> {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
  const flag = (name: string) => process.argv.includes(`--${name}`);
  const dir = arg('dir', 'data-desk/research'), desk = arg('desk', 'data-desk'), since = Date.parse(arg('since', '2026-10-05T21:00:00Z'));
  const geckoMs = Number(arg('gecko-ms', '6000')), now = Date.now();

  // CRASH signals on the replay tape: the first signal of each coin since `since`.
  const signals = new Map<string, { at: number; symbol: string | null; pool: string | null; priceUsd: number; marketCapUsd: number | null; poolAgeMin: number | null }>();
  for (const line of fs.readFileSync(path.join(desk, 'tape-PAPER.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let r: { at: number; mint: string; symbol?: string; pool?: string; priceUsd?: number; marketCapUsd?: number; poolAgeMin?: number; signal?: boolean };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.signal !== true || r.at < since || !r.priceUsd || signals.has(r.mint)) continue;
    signals.set(r.mint, { at: r.at, symbol: r.symbol ?? null, pool: r.pool ?? null, priceUsd: r.priceUsd, marketCapUsd: r.marketCapUsd ?? null, poolAgeMin: r.poolAgeMin ?? null });
  }
  console.log(`${signals.size} CRASH signals since ${new Date(since).toISOString()}`);

  const t0 = Date.now(), scan = scanLedger(ledgerFiles(dir), new Set(signals.keys()));
  console.log(`observer ledger: ${scan.files} files, ${new Date(scan.first).toISOString()} → ${new Date(scan.last).toISOString()}, ${scan.launches.size} launches (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // R, frozen: computed once from launches created before the freeze, then read back unchanged.
  const botsFile = path.join(dir, 'bots-R.json');
  let bots: { frozenAt: string; rule: string; launches: number; wallets: Array<{ wallet: string; launches: number }> };
  if (fs.existsSync(botsFile) && !flag('refreeze')) bots = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
  else {
    bots = { frozenAt: new Date(BOT_LIST.frozenAt).toISOString(), rule: `top buyer (most SOL bought in the first ${BOT_LIST.windowS} s) of ≥ ${BOT_LIST.minLaunches} launches created before the freeze`,
      launches: scan.topBuyerLaunches, wallets: botList(scan) };
    fs.writeFileSync(botsFile, JSON.stringify(bots, null, 1));
    console.log(`bot list R frozen: ${bots.wallets.length} wallets from ${bots.launches} launches → ${botsFile}`);
  }
  const R = new Set(bots.wallets.map(w => w.wallet));
  console.log(`R: ${R.size} wallets (top: ${bots.wallets.slice(0, 3).map(w => `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)} ${w.launches}`).join(', ')})`);

  // What the desk did: every CRASH-family BUY within 2 min of the signal and its SELL.
  const taken = new Map<string, string[]>();
  for (const f of fs.readdirSync(desk).filter(n => /^ledger-PAPER-CRASH[A-Z0-9_]*\.(json|cycle-.*\.json)$/.test(n))) {
    const id = f.replace(/^ledger-PAPER-/, '').replace(/\..*$/, ''), entries = (JSON.parse(fs.readFileSync(path.join(desk, f), 'utf8')).entries ?? []) as Array<{ at: number; mint: string; side: string; status: string; netPnlUsd: number | null; entryPriceUsd: number | null; quantity: string; exitReason?: string }>;
    for (const b of entries) {
      const s = signals.get(b.mint);
      if (!s || b.side !== 'BUY' || b.status === 'FAILED' || b.at < s.at - 5_000 || b.at > s.at + 120_000) continue;
      const sell = entries.find(e => e.mint === b.mint && e.side === 'SELL' && e.at > b.at && e.status !== 'FAILED');
      const cost = b.entryPriceUsd !== null ? b.entryPriceUsd * Number(b.quantity) : null;
      const pct = sell?.netPnlUsd != null && cost ? `${sell.netPnlUsd >= 0 ? '+' : ''}${(sell.netPnlUsd / cost * 100).toFixed(0)} %` : sell ? '?' : 'open';
      taken.set(b.mint, [...(taken.get(b.mint) ?? []), `${id} ${pct}${sell?.exitReason ? ` (${sell.exitReason.split(' ')[0]})` : ''}`]);
    }
  }

  // The label: pool minute candles from the signal to +10 min.
  const cacheDir = path.join(dir, 'cache-ohlcv');
  fs.mkdirSync(cacheDir, { recursive: true });
  let lastGecko = 0;
  const candles = async (pool: string, mint: string, at: number) => {
    const before = Math.floor((at + (RUG_LABEL.withinMin + 1) * 60_000) / 1000), file = path.join(cacheDir, `${pool}-${before}.json`);
    if (before * 1000 > now) return null;
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as number[][];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, Math.max(0, lastGecko + geckoMs - Date.now()))); lastGecko = Date.now();
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=20&currency=usd&token=${mint}&before_timestamp=${before}&include_empty_intervals=false`,
        { headers: { accept: 'application/json' } }).catch(() => null);
      if (res?.status === 404) return [];
      if (res?.ok) { const list = (await res.json() as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list; fs.writeFileSync(file, JSON.stringify(list)); return list; }
      await new Promise(r => setTimeout(r, res?.status === 429 ? 20_000 * (attempt + 1) : 5_000));
    }
    return null;
  };

  type Out = { mint: string; symbol: string | null; at: number; marketCapUsd: number | null; poolAgeMin: number | null; taken: string[]; label: string; minPct: number | null; maxPct: number | null; f: GradFeatures | null };
  const out: Out[] = [];
  for (const [mint, s] of [...signals].sort((a, b) => a[1].at - b[1].at)) {
    const l = scan.launches.get(mint);
    const f = l ? gradFeatures(l, scan.trades.get(mint) ?? [], R, creatorHistory(scan.launches, l, l.complete ?? s.at)) : null;
    let label: Out['label'] = 'NO_DATA', minPct: number | null = null, maxPct: number | null = null;
    if (!flag('no-candles') && s.pool) {
      const list = await candles(s.pool, mint, s.at);
      if (list === null) label = s.at + RUG_LABEL.withinMin * 60_000 > now ? 'PENDING' : 'NO_DATA';
      else ({ label, minPct, maxPct } = rugLabel(s.priceUsd, s.at, list.map(([t, o, h, lo, c]) => ({ t: t! * 1000, o: o!, h: h!, l: lo!, c: c! })), now));
    }
    out.push({ mint, symbol: s.symbol, at: s.at, marketCapUsd: s.marketCapUsd, poolAgeMin: s.poolAgeMin, taken: taken.get(mint) ?? [], label, minPct, maxPct, f });
  }
  fs.writeFileSync(path.join(dir, 'rug-entry.json'), JSON.stringify({ generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), thresholds: RUG_THRESHOLDS, label: RUG_LABEL, rows: out }, null, 1));

  const pct = (v: number | null | undefined, d = 0) => v == null ? '--' : `${(v * 100).toFixed(d)}`;
  console.log('\ntime  symbol        label    min/max %   insider top10 sniper bot  sellSh serial holders breaks  desk');
  for (const r of out) {
    const f = r.f;
    console.log(`${new Date(r.at).toISOString().slice(11, 16)} ${(r.symbol ?? r.mint.slice(0, 6)).slice(0, 12).padEnd(13)} ${r.label.padEnd(8)} ${r.minPct === null ? '--' : r.minPct.toFixed(0)}/${r.maxPct === null ? '--' : `+${r.maxPct.toFixed(0)}`}`.padEnd(46) +
      (f?.gradAt ? `${pct(f.insiderAtGrad).padStart(5)} ${pct(f.top10AtGrad).padStart(5)} ${pct(f.sniperAtGrad).padStart(6)} ${pct(f.botAtGrad).padStart(4)} ${pct(f.preGradSellShare).padStart(6)} ${String(f.serialCreator ?? '--').padStart(6)} ${String(f.holdersAtGrad ?? '--').padStart(7)} ${String(f.chainBreaks).padStart(6)}`
        : '  (no graduation in the observer ledger)'.padEnd(58)) + `  ${r.taken.join(', ') || 'not taken'}`);
  }
  const judged = out.filter(r => (r.label === 'RUG' || r.label === 'NO') && r.f?.gradAt);
  console.log(`\nPast the pre-registered threshold vs not (descriptive, ${judged.length} labelled signals, ${judged.filter(r => r.label === 'RUG').length} rugs; RG1 needs ≥ 20 rugs):`);
  const keys = ['insiderAtGrad', 'top10AtGrad', 'sniperAtGrad', 'botAtGrad', 'preGradSellShare', 'serialCreator', 'holdersAtGrad'] as const;
  for (const k of keys) {
    const past = judged.filter(r => pastThresholds(r.f!)[k] === true), short = judged.filter(r => pastThresholds(r.f!)[k] === false);
    const rate = (xs: Out[]) => xs.length ? `${xs.filter(r => r.label === 'RUG').length}/${xs.length} rugs` : 'none';
    console.log(`  ${k.padEnd(17)} past: ${rate(past).padEnd(12)} short: ${rate(short)}`);
  }
}

main().catch(error => { console.error(error); process.exit(1); });

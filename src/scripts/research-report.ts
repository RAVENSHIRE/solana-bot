/**
 * Research report: point-in-time features of every recorded launch against what happened next, on a discovery
 * half and an untouched validation half (by creation time). Read-only; reads data-desk/research.
 *
 *   npm run research:report -- [--dir data-desk/research] [--t 60,120,300,600] [--split 0.6] [--from ISO] [--to ISO] [--strict] [--mayhem] [--csv out.csv]
 *
 * pump.fun "mayhem mode" launches are left out unless --mayhem (only them) is given: their curve gains SOL without
 * matching trades (2 Oct: k = vSol × vTok grew 4× in 15 trades), so their multiples are not comparable.
 * --strict also leaves out launches whose window had a blind spot or a detected missing trade.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DECISION_S, ledgerFiles, readDataset, rows, type Row } from '../research/dataset';
import { BOOLEAN, NUMERIC, booleanBins, cell, cohort, consistent, coverage, numericBins, outcome, type Bin, type CohortLine, type FeatureKey } from '../research/report';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

function table(title: string, lines: CohortLine[]): void {
  console.log(`  ${title}`);
  for (const l of lines) {
    const mark = consistent(l) ? ' ◀ holds in both halves' : '';
    console.log(`    ${l.label.padEnd(16)} D ${cell(l.d)} | V ${cell(l.v)} | lift ${l.liftD?.toFixed(2) ?? '–'} / ${l.liftV?.toFixed(2) ?? '–'}${mark}`);
  }
}

function main(): void {
  const dir = path.resolve(arg('dir') ?? 'data-desk/research');
  const ds = readDataset(ledgerFiles(dir), { from: arg('from') ? Date.parse(arg('from')!) : undefined, to: arg('to') ? Date.parse(arg('to')!) : undefined });
  const times = (arg('t') ?? DECISION_S.join(',')).split(',').map(Number).filter(n => n > 0);
  const split = Number(arg('split') ?? 0.6), strict = process.argv.includes('--strict');
  console.log(`RESEARCH REPORT · ${dir}`);
  const csv: string[] = [];
  for (const t of times) {
    let all = rows(ds, t);
    if (t === times[0]) for (const line of coverage(ds, all)) console.log(`  ${line}`);
    const mayhemRows = all.filter(r => r.f.mayhem).length;
    all = all.filter(r => r.f.mayhem === process.argv.includes('--mayhem'));
    if (strict) all = all.filter(r => !r.f.gapInWindow && (r.f.mayhem || r.f.chainBreaks === 0));
    const cut = all[Math.floor(all.length * split)]?.createdObs ?? Infinity;
    const discovery = all.filter(r => r.createdObs < cut), validation = all.filter(r => r.createdObs >= cut);
    const baseD = outcome(discovery), baseV = outcome(validation);
    console.log(`\n== DECISION ${t} s after creation · ${all.length} ${process.argv.includes('--mayhem') ? 'mayhem-mode' : `normal (${mayhemRows} mayhem-mode left out)`} launches still on the curve${strict ? ' (strict)' : ''} · validation from ${Number.isFinite(cut) ? new Date(cut).toISOString().slice(0, 16) : '–'} UTC`);
    console.log(`  outcomes from the price at ${t} s, within 1 h (counted only once the hour is in the data): win = 2× before halving · 2×/5× = reached · grad = curve completed · mfe1h/mae15m = median best/worst multiple`);
    console.log(`  base rate         D ${cell(baseD)} | V ${cell(baseV)}`);
    const found: Array<{ k: FeatureKey; b: Bin; l: CohortLine }> = [];
    for (const k of [...NUMERIC, ...BOOLEAN]) {
      const bins = NUMERIC.includes(k) ? numericBins(k, discovery) : booleanBins(k);
      const lines = cohort(bins, discovery, validation, baseD, baseV);
      if (lines.length <= 1 && lines[0]?.label === 'unknown') continue;
      table(k, lines);
      lines.forEach((l, i) => { if (l.label !== 'unknown' && l.d.n >= 30 && (l.liftD ?? 0) >= 1.3) found.push({ k, b: bins.find(b => b.label === l.label) ?? bins[i]!, l }); });
    }
    // Interactions: the strongest discovery bins of different features, pairwise; judged on validation only.
    const top = found.sort((a, b) => (b.l.liftD ?? 0) - (a.l.liftD ?? 0)).filter((x, i, arr) => arr.findIndex(y => y.k === x.k) === i).slice(0, 6);
    const pairs: CohortLine[] = [];
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!, b = top[j]!;
      pairs.push(...cohort([{ label: `${a.k} ${a.b.label} & ${b.k} ${b.b.label}`, test: f => a.b.test(f) && b.b.test(f) }], discovery, validation, baseD, baseV));
    }
    if (pairs.length) { console.log('  INTERACTIONS (strongest discovery bins, pairwise)'); for (const p of pairs) console.log(`    ${p.label}\n      D ${cell(p.d)} | V ${cell(p.v)} | lift ${p.liftD?.toFixed(2) ?? '–'} / ${p.liftV?.toFixed(2) ?? '–'}${consistent(p, 1.5, 15) ? ' ◀' : ''}`); }
    // Pre-registered hypotheses from the owner's two runners (AGENCY, 7cYaQc).
    const median = (k: FeatureKey) => { const v = discovery.map(r => r.f[k]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b); return v[v.length >> 1] ?? 0; };
    const vel = median('velocity60'), eff = median('effectiveBuyers'), top1 = median('top1');
    const organic = (r: Row) => (r.f.velocity60 ?? 0) > vel && (r.f.effectiveBuyers ?? 0) > eff && (r.f.top1 ?? 1) < top1 && r.f.devSold !== true;
    const hyp: Array<[string, (r: Row) => boolean]> = [
      ['H1 own X account posted this CA', r => r.f.xCaPost === true],
      ['H2 organic demand (velocity, breadth above median; top buyer below median; dev not sold)', organic],
      ['H1 and H2', r => r.f.xCaPost === true && organic(r)],
    ];
    console.log('  HYPOTHESES (fixed in advance; medians from discovery)');
    for (const [label, test] of hyp) {
      const d = outcome(discovery.filter(test)), v = outcome(validation.filter(test));
      console.log(`    ${label}\n      D ${cell(d)} | V ${cell(v)}`);
    }
    // The best runners of the window, with what was known at the decision time (the observatory view).
    const runners = [...all].filter(r => r.y.mfe[360] != null || r.y.mfe[60] != null).sort((a, b) => (b.y.mfe[360] ?? b.y.mfe[60] ?? 0) - (a.y.mfe[360] ?? a.y.mfe[60] ?? 0)).slice(0, 8);
    console.log('  TOP RUNNERS and what was known at the decision time');
    for (const r of runners) {
      const f = r.f;
      console.log(`    ${(r.symbol ?? r.mint.slice(0, 6)).slice(0, 12).padEnd(12)} ${new Date(r.createdObs).toISOString().slice(5, 16)} peak ${(1 + (r.y.mfe[360] ?? r.y.mfe[60] ?? 0)).toFixed(1)}× ${r.y.graduatedMin !== null ? `grad ${r.y.graduatedMin.toFixed(0)}m` : '       '} | ` +
        `mcap ${f.mcapSol?.toFixed(0) ?? '?'} SOL${f.mayhem ? ' MAYHEM' : ''} · curve ${((f.progress ?? 0) * 100).toFixed(0)}% · vel ${((f.velocity60 ?? 0) * 100).toFixed(1)}%/min · buyers ${f.buyers} (eff ${f.effectiveBuyers?.toFixed(0) ?? '–'}, top1 ${((f.top1 ?? 0) * 100).toFixed(0)}%) · ` +
        `dev ${f.devBuySol?.toFixed(2) ?? '?'} SOL${f.devSold ? ' SOLD' : ''} · X ${f.hasX ? (f.xCaPost ? `CA posted +${f.xCaPostDelayS}s` : 'yes') : 'no'} · site ${f.hasSite ? 'yes' : 'no'} · creator ${f.creatorLaunches}/${f.creatorGraduations}`);
    }
    if (arg('csv')) for (const r of all) {
      if (!csv.length) csv.push(['t', 'mint', 'symbol', 'createdUtc', 'set', ...Object.keys(r.f).filter(k => k !== 't'), 'win1h', 'reach2_1h', 'reach5_1h', 'reach10_1h', 'reach5_6h', 'reach10_6h', 'grad1h', 'grad6h', 'mfe5', 'mfe15', 'mfe60', 'mfe360', 'mae5', 'mae15', 'mae60', 'peakMin'].join(','));
      const y = r.y;
      csv.push([t, r.mint, JSON.stringify(r.symbol ?? ''), new Date(r.createdObs).toISOString(), r.createdObs < cut ? 'D' : 'V', ...Object.entries(r.f).filter(([k]) => k !== 't').map(([, v]) => v ?? ''),
        y.twoBeforeHalf ?? '', y.reached[2] ?? '', y.reached[5] ?? '', y.reached[10] ?? '', y.reached6h[5] ?? '', y.reached6h[10] ?? '', y.graduated ?? '', y.graduated6h ?? '',
        y.mfe[5] ?? '', y.mfe[15] ?? '', y.mfe[60] ?? '', y.mfe[360] ?? '',
        y.mae[5] ?? '', y.mae[15] ?? '', y.mae[60] ?? '', y.peakMin ?? ''].join(','));
    }
  }
  if (arg('csv')) { fs.writeFileSync(path.resolve(arg('csv')!), csv.join('\n') + '\n'); console.log(`\nrows written to ${arg('csv')}`); }
}

main();

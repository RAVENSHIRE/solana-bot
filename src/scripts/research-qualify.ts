/**
 * Qualification: which pre-registered call rules may reach the phone. Reads the last `--hours` of the research ledger,
 * tunes each group's exit on the earlier 60 % of launches, judges it unchanged on the later 40 %, adds the rule's live
 * results, and writes data-desk/research/qualified.json (every candidate with its evidence). Read-only otherwise.
 *
 *   npm run research:qualify -- [--dir data-desk/research] [--hours 48] [--size 2] [--fixed-usd 0.10] [--fee-pct 1.25] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ledgerFiles, readDataset } from '../research/dataset';
import { GATE_COSTS } from '../research/direct';
import { qualify } from '../research/qualify';
import { describeExit } from '../research/rules';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

function main(): void {
  const dir = path.resolve(arg('dir') ?? 'data-desk/research'), hours = Number(arg('hours') ?? 48);
  const since = Date.now() - hours * 3_600_000;
  // Files are hourly (UTC): keep the ones that can hold data from the window.
  const files = ledgerFiles(dir).filter(f => { const m = /ev-(\d{4})(\d{2})(\d{2})-(\d{2})/.exec(path.basename(f)); return !m || Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! + 1) >= since; });
  const ds = readDataset(files, { from: since });
  const costs = { ...GATE_COSTS, sizeUsd: Number(arg('size') ?? GATE_COSTS.sizeUsd), fixedUsd: Number(arg('fixed-usd') ?? GATE_COSTS.fixedUsd), feePct: Number(arg('fee-pct') ?? GATE_COSTS.feePct) };
  const q = qualify(ds, costs);
  const out = path.resolve(arg('out') ?? path.join(dir, 'qualified.json'));
  fs.writeFileSync(`${out}.tmp`, JSON.stringify(q, null, 1));
  fs.renameSync(`${out}.tmp`, out);
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
  console.log(`QUALIFICATION · ${new Date(q.data.from).toISOString().slice(0, 16)} → ${new Date(q.data.to).toISOString().slice(0, 16)} UTC · ${q.data.launches} normal launches · ` +
    `later period from ${Number.isFinite(q.cut) ? new Date(q.cut).toISOString().slice(0, 16) : '–'} · $${costs.sizeUsd} trades, ${costs.feePct}% fee per side + $${costs.fixedUsd}`);
  console.log(`criteria: ≥ ${q.criteria.minTrades} later trades, average after costs > ${q.criteria.minMeanPct}%, target hit rate covering the losers, profitable when tuned, live calls not losing (after ${q.criteria.minForwardTrades})`);
  for (const r of q.rules) {
    console.log(`${r.qualified ? 'QUALIFIED' : '         -'} ${r.groupLabel} · ${r.delayS} s · ${describeExit(r.exit)}`);
    console.log(`            tuned n ${r.tuning.n} ${pct(r.tuning.meanPct)} · later n ${r.validation.n} ${pct(r.validation.meanPct)}, target hit ${r.validation.tpPct.toFixed(0)}% (needs ${r.requiredHitPct?.toFixed(0) ?? '–'}%), PF ${Number.isFinite(r.validation.pf) ? r.validation.pf.toFixed(2) : '∞'}` +
      `${r.forward.n ? ` · live ${r.forward.n} results ${pct(r.forward.meanPct ?? 0)}` : ''}${r.reasons.length ? ` · ${r.reasons.join('; ')}` : ''}`);
  }
  console.log(`${q.rules.filter(r => r.qualified).length} qualified of ${q.rules.length} → ${out}`);
}

main();

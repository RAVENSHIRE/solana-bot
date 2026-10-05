/**
 * GOLDEN shadow trades (research P2): data-desk/golden-shadow.jsonl, judged by group, fill speed and exit.
 * Costs are options because they depend on the provider and the size (owner, 5 Oct): the per-side fee percentage and
 * the fixed cost per round trip in dollars, at the trade size being studied (K1: run it at 2, 5 and 10).
 *
 *   npm run research:golden-shadow -- [--file data-desk/golden-shadow.jsonl] [--size 2] [--fee-pct 1.25] [--fixed 0.03] [--since <ISO time>]
 */
import fs from 'node:fs';
import type { ShadowRecord } from '../desk/golden-shadow';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const file = arg('file', 'data-desk/golden-shadow.jsonl'), size = Number(arg('size', '2')), feePct = Number(arg('fee-pct', '1.25')), fixed = Number(arg('fixed', '0.03'));
const since = Date.parse(arg('since', '1970-01-01T00:00:00Z'));
let rows: ShadowRecord[] = [];
try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ShadowRecord).filter(r => r.fillAt >= since); }
catch { console.log(`no shadow records in ${file} yet`); process.exit(0); }

/** Net return of a gross move: the fee on both sides and the fixed cost as a share of the size. */
const net = (gross: number) => ((1 + gross / 100) * (1 - feePct / 100) * (1 - feePct / 100) - 1) * 100 - fixed / size * 100;
const group = (x: number | null) => x === null ? 'unknown' : x <= 3 ? '≤ 3× (P2)' : x <= 10 ? '3–10×' : '> 10× (P1)';
const stats = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return v.length ? { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, median: s[Math.floor(s.length / 2)]!, won: v.filter(x => x > 0).length / v.length * 100 } : null; };

console.log(`GOLDEN shadow trades: ${rows.length} fills · costs: ${feePct} % per side + $${fixed} per round trip on $${size} (${(fixed / size * 100).toFixed(1)} %)`);
for (const g of ['≤ 3× (P2)', '3–10×', '> 10× (P1)', 'unknown']) {
  const inG = rows.filter(r => group(r.poolJumpX) === g);
  if (!inG.length) continue;
  console.log(`\npool opened at ${g} its graduation value: ${inG.length} fills`);
  for (const speed of ['bot', 'phone'] as const) for (const exit of ['a', 'b', 'c'] as const) {
    const v = inG.flatMap(r => r.legs.filter(l => l.speed === speed && l.entryUsd !== null).map(l => l[exit]).filter((x): x is NonNullable<typeof x> => !!x && x.reason !== 'NO_SAMPLE').map(x => net(x.pct)));
    const s = stats(v);
    console.log(`  ${speed.padEnd(5)} exit ${exit}: ${s ? `n ${s.n} · won ${s.won.toFixed(0)} % · average ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} % · median ${s.median.toFixed(1)} %` : 'no trades'}`);
  }
}
console.log('\nExits: a GOLDEN as it trades (pattern stop, −40 %, 25 % trail after +50 %, 60 min); b (a) + 100 % take profit; c half at +100 %, rest as (a). P2 passes after ≥ 30 fills in its group with a positive average after costs.');

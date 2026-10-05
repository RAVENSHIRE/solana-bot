/**
 * Hold-to-graduation study (owner, 5 Oct, the CRWLR case: an OPEN alert at $13.5K, an INFO at $12K, then 4× to
 * graduation in 73 minutes). Every OPEN alert the desk raised and every INFO the observer sent (the project's own
 * account posted the CA: a checkmark or ≥ 1,000 followers) is bought 45 s later (phone) and 2 s later (bot), and held
 * with exits fixed before this run:
 *
 *   H1  to graduation: no target, no stop, 6 h at most
 *   H2  to graduation with a −50 % stop (CRWLR fell −47 % after its INFO)
 *   H3  4× (+300 %) or graduation, −50 % stop, 6 h at most
 *   F1a +100 % / −35 % / 30 min (the research department's early-INFO rule, for comparison)
 *
 * A graduation sells at the curve's last price. Costs as the gate: $2 trades, 1.25 % fee per side, $0.10 a round trip.
 * Known cases (CRWLR, Web) are shown, and the summary is repeated without them. Read-only.
 *
 * INFO-HOLD (pre-registered 5 Oct 2026, 14:30 UTC, after the first run of this study): an INFO coin whose curve is at
 * 100–250 SOL market cap when the INFO is sent, bought at phone speed, held to graduation with no stop and no target,
 * 6 h at most (H1). Found in-sample (2–5 Oct: 23 trades, 13 won, +44 % average, +18 % median, +11 % without the best
 * three), so it counts only on coins after the study: `--since 2026-10-05T14:30Z`.
 *
 *   npm run research:hold -- [--dir data-desk/research] [--desk data-desk] [--days 7] [--since <ISO time>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ledgerFiles, readDataset } from '../research/dataset';
import { DIRECT_DEFAULTS, GATE_COSTS, simulate, summarize, type DirectTrade, type ExitRule } from '../research/direct';
import { curveMcapSol } from '../research/pump-events';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
export const HOLD_EXITS: Record<string, ExitRule> = {
  H1: { tpPct: 1e6, slPct: null, maxHoldMin: 360 },
  H2: { tpPct: 1e6, slPct: 50, maxHoldMin: 360 },
  H3: { tpPct: 300, slPct: 50, maxHoldMin: 360 },
  F1a: { tpPct: 100, slPct: 35, maxHoldMin: 30 },
};
const KNOWN = new Set(['CRWLR', 'WEB']);
export const INFO_HOLD = Object.freeze({ minSol: 100, maxSol: 250, exit: 'H1', registeredAt: Date.parse('2026-10-05T14:30:00Z') });
interface Event { kind: 'INFO' | 'OPEN'; mint: string; at: number; note: string }

const text = (f: string) => { const raw = fs.readFileSync(f); return f.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'); };

/** INFO records of the observer's ledger: the first one per coin. */
function infoEvents(files: string[]): Event[] {
  const out = new Map<string, Event>();
  for (const f of files) {
    const t = text(f);
    if (!t.includes('"INFO"')) continue;
    const mints: string[] = [];
    for (const line of t.split('\n')) {
      if (line.startsWith('["M",')) { try { const r = JSON.parse(line) as [string, number, string]; mints[r[1]] = r[2]; } catch { /* skip */ } continue; }
      if (!line.startsWith('["INFO",')) continue;
      try {
        const r = JSON.parse(line) as unknown[], m = typeof r[2] === 'number' ? mints[r[2]] : (r[2] as { $m?: string } | null)?.$m;
        const x = (r[4] ?? {}) as { badge?: string | null; f?: number | null };
        if (m && !out.has(m)) out.set(m, { kind: 'INFO', mint: m, at: r[1] as number, note: `@${r[3]} ${x.badge ?? ''} ${x.f ?? '?'} followers`.replace(/\s+/g, ' ') });
      } catch { /* skip */ }
    }
  }
  return [...out.values()];
}

/** OPEN alerts the desk recorded (research store, AlertGenerated, kind open): the first one per coin. */
function openEvents(dir: string, since: number): Event[] {
  const out = new Map<string, Event>();
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'research') walk(f); continue; }
    if (!/\.(jsonl|json|gz)$/.test(f) || fs.statSync(f).mtimeMs < since || fs.statSync(f).size > 150e6) continue;
    let t: string; try { t = text(f); } catch { continue; }
    for (const line of t.split('\n')) {
      if (!line.includes('AlertGenerated') || !line.includes('"kind":"open"')) continue;
      const key = /"key":"open:([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(line)?.[1];
      const ts = /"timestamp":(\d{13})/.exec(line)?.[1] ?? Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '');
      const at = Number(ts);
      if (key && Number.isFinite(at) && at >= since && !out.has(key)) out.set(key, { kind: 'OPEN', mint: key, at, note: /"title":"([^"]{0,60})/.exec(line)?.[1] ?? '' });
    }
  } };
  try { walk(dir); } catch { /* no desk store */ }
  return [...out.values()];
}

function main(): void {
  const dir = path.resolve(arg('dir') ?? path.join('data-desk', 'research')), desk = path.resolve(arg('desk') ?? 'data-desk');
  const days = Number(arg('days') ?? 7), since = Date.now() - days * 86_400_000, after = arg('since') ? Date.parse(arg('since')!) : null;
  const files = ledgerFiles(dir).filter(f => { const m = /ev-(\d{4})(\d{2})(\d{2})-(\d{2})/.exec(f); return !m || Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!) >= since - 3_600_000; });
  const events = [...infoEvents(files), ...openEvents(desk, since)].filter(e => after === null || e.at >= after);
  const ds = readDataset(files, { mints: new Set(events.map(e => e.mint)) });
  console.log(`HOLD STUDY · ${new Date(ds.first).toISOString().slice(0, 16)} → ${new Date(ds.last).toISOString().slice(0, 16)} UTC · ${files.length} files · ` +
    `${events.filter(e => e.kind === 'INFO').length} INFO coins, ${events.filter(e => e.kind === 'OPEN').length} OPEN alerts`);
  const fills = { phone: { ...GATE_COSTS }, bot: { ...GATE_COSTS, latencyMs: DIRECT_DEFAULTS.latencyMs, fill: 'bot' as const } };
  const rows: Array<{ e: Event; sym: string; known: boolean; mcSol: number | null; graduatedMin: number | null; peakX: number | null; r: Record<string, DirectTrade | null> }> = [];
  for (const e of events.sort((a, b) => a.at - b.at)) {
    const l = ds.launches.get(e.mint);
    if (!l || l.mayhem) continue;
    const delayS = (e.at - l.createdObs) / 1000, sym = (l.symbol ?? e.mint.slice(0, 6)).toUpperCase();
    const before = l.trades.filter(t => t.obs <= e.at).at(-1), mcSol = before ? curveMcapSol(before.vSol, before.vTok) : null;
    const r: Record<string, DirectTrade | null> = {};
    for (const [id, x] of Object.entries(HOLD_EXITS)) for (const [fill, o] of Object.entries(fills)) r[`${id}/${fill}`] = delayS >= 0 ? simulate(l, x, { ...o, delayS }, ds.last) : null;
    const h1 = r['H1/phone'];
    rows.push({ e, sym, known: KNOWN.has(sym), mcSol, graduatedMin: l.completeObs ? (l.completeObs - e.at) / 60_000 : null, peakX: h1 ? 1 + h1.peakPct / 100 : null, r });
  }
  const line = (label: string, trades: DirectTrade[]) => {
    const s = summarize(trades, GATE_COSTS.sizeUsd), grad = trades.filter(t => t.reason === 'GRADUATED').length;
    return `${label.padEnd(30)} n ${String(s.n).padStart(3)} · won ${s.winPct.toFixed(0).padStart(3)} % · average ${s.meanPct >= 0 ? '+' : ''}${s.meanPct.toFixed(1)} % · median ${s.medianPct.toFixed(1)} % · ` +
      `graduated ${grad} · best ${s.bestPct.toFixed(0)} % · worst ${s.worstPct.toFixed(0)} % · $${s.totalUsd.toFixed(2)} on $2 each`;
  };
  for (const kind of ['INFO', 'OPEN', 'OPEN then INFO'] as const) {
    const pick = rows.filter(x => kind === 'OPEN then INFO' ? x.e.kind === 'INFO' && rows.some(o => o.e.kind === 'OPEN' && o.e.mint === x.e.mint && o.e.at <= x.e.at) : x.e.kind === kind);
    console.log(`\n${kind} (${pick.length} coins)`);
    for (const id of Object.keys(HOLD_EXITS)) for (const fill of ['phone', 'bot']) {
      const all = pick.map(x => x.r[`${id}/${fill}`]).filter((t): t is DirectTrade => !!t);
      const clean = pick.filter(x => !x.known).map(x => x.r[`${id}/${fill}`]).filter((t): t is DirectTrade => !!t);
      console.log(`  ${line(`${id} ${fill}`, all)}`);
      if (clean.length !== all.length) console.log(`  ${line(`${id} ${fill}, without known cases`, clean)}`);
    }
  }
  // The pre-registered rule, on its own: INFO at 100–250 SOL, held to graduation (H1), phone and bot.
  const band = rows.filter(x => x.e.kind === 'INFO' && x.mcSol !== null && x.mcSol >= INFO_HOLD.minSol && x.mcSol < INFO_HOLD.maxSol);
  console.log(`\nINFO-HOLD (pre-registered 5 Oct 14:30 UTC: INFO at ${INFO_HOLD.minSol}–${INFO_HOLD.maxSol} SOL, to graduation, no stop, 6 h)${after === null ? ' · in-sample before 5 Oct 14:30 UTC, use --since for the test' : ''}`);
  for (const fill of ['phone', 'bot']) {
    const trades = band.filter(x => !x.known).map(x => x.r[`${INFO_HOLD.exit}/${fill}`]).filter((t): t is DirectTrade => !!t);
    const r = trades.map(t => t.netPct).sort((a, b) => a - b);
    console.log(`  ${line(`INFO-HOLD ${fill}`, trades)} · without the best 3: ${r.length > 3 ? `${(r.slice(0, -3).reduce((a, x) => a + x, 0) / (r.length - 3)).toFixed(1)} %` : '–'}`);
  }
  console.log('\nEvery coin (phone fill): event · symbol · market cap at the event · graduated · peak until exit · H1 · H2 · H3 · F1a');
  for (const x of rows) {
    const p = (id: string) => { const t = x.r[`${id}/phone`]; return t ? `${t.netPct >= 0 ? '+' : ''}${t.netPct.toFixed(0)}% ${t.reason[0]}` : 'open'; };
    console.log(`  ${new Date(x.e.at).toISOString().slice(5, 16)} ${x.e.kind.padEnd(4)} ${x.sym.slice(0, 10).padEnd(10)}${x.known ? '*' : ' '} ${x.mcSol ? `${x.mcSol.toFixed(0)} SOL` : '?'}`.padEnd(46) +
      ` ${x.graduatedMin !== null ? `grad +${x.graduatedMin.toFixed(0)} min` : 'not grad.'}`.padEnd(18) + ` peak ${x.peakX ? `${x.peakX.toFixed(1)}×` : '?'}`.padEnd(12) +
      ` ${p('H1')} · ${p('H2')} · ${p('H3')} · ${p('F1a')}`);
  }
  console.log('\nExit letters: G graduated, S stop, T time, T(AKE_PROFIT) shown as T too; * a known case (CRWLR, Web).');
}

main();

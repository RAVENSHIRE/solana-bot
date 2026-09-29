/**
 * Headless TEST / PAPER run of the desk pipeline on live market data. It never signs, never submits and never
 * reads a private key; the wallet address is only used to build and simulate transactions.
 *
 *   npm run desk:paper -- --address <PUBLIC_KEY> [--scans 6] [--env <dir containing .env>] [--data <dir>] [--probe] [--probe-mint <MINT>] [--status-out <file>]
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { configureLogger } from '../utils/logger';
import { createDesk } from '../desk/runtime';
import { DESK } from '../desk/config';
import type { Candidate, DeskEvent } from '../desk/types';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const clock = (at: number) => new Date(at).toISOString().slice(11, 19);
const usd = (n: number | null) => n === null ? 'UNKNOWN' : `$${Math.round(n).toLocaleString('en-US')}`;
const line = (e: DeskEvent) => `${clock(e.at)} [${e.stage.replace('_', ' ')}] ${e.symbol ?? ''} ${e.message}`;

async function main(): Promise<void> {
  const address = arg('address');
  if (!address) throw new Error('--address <PUBLIC_KEY> is required (used for transaction building and simulation only)');
  const owner = new PublicKey(address), scans = Number(arg('scans') ?? 6), envDir = path.resolve(arg('env') ?? '.');
  configureLogger({ level: 'warn', color: false });
  const desk = await createDesk({ envDir, dataDir: path.resolve(arg('data') ?? path.join(envDir, 'data-desk')) },
    { wallet: mode => (mode === 'PAPER' ? { owner, signer: null } : null), authorized: () => false });
  const engine = desk.engines.PAPER;
  let printed = engine.events.list().at(-1)?.id ?? 0;
  const flushEvents = () => { for (const e of engine.events.list().filter(e => e.id > printed)) console.log(line(e)); printed = engine.events.list().at(-1)?.id ?? printed; };
  try {
    console.log(`TEST / PAPER — NO REAL TRANSACTIONS · wallet ${owner.toBase58()} · planned $${desk.capital.plannedStartingCapitalUsd} · base entry $${desk.capital.baseEntryUsd}`);
    engine.start();
    for (let i = 0; i < scans; i++) {
      await engine.pulse(); flushEvents();
      if (i < scans - 1) await new Promise(r => setTimeout(r, DESK.scanMs));
    }
    engine.stop('headless run finished');
    const view = () => engine.status({ connected: true, address: owner.toBase58() });
    const probeMint = arg('probe-mint');
    if (probeMint) { await engine.probe(probeMint).catch(error => console.log(`PROBE rejected: ${(error as Error).message}`)); flushEvents(); }
    if (process.argv.includes('--probe') && !view().preflights.length) {
      const rank: Record<Candidate['status'], number> = { QUALIFIED: 0, WAITING: 1, WATCHLIST: 2, FILTERED: 3 };
      const pick = view().candidates.filter(c => c.tier === 'TRENDING' && c.onchain.decimals !== null).sort((a, b) => rank[a.status] - rank[b.status])[0];
      if (pick) { await engine.probe(pick.mint).catch(error => console.log(`PROBE rejected: ${(error as Error).message}`)); flushEvents(); }
      else console.log('PROBE skipped: no analysed trending candidate with known decimals');
    }
    const s = view();
    const out = arg('status-out');
    if (out) await writeFile(path.resolve(out), JSON.stringify({ session: null, pending: null, mode: 'PAPER', desk: s, deskError: null }));
    console.log('\nCANDIDATES');
    for (const c of s.candidates.slice(0, 15)) console.log(`  ${(c.symbol ?? '?').padEnd(10)} ${c.tier.padEnd(11)} ${c.status.padEnd(9)} ${c.classification.padEnd(9)} cap ${usd(c.metrics.marketCapUsd).padEnd(10)} liq ${usd(c.metrics.liquidityUsd).padEnd(9)} 5m ${usd(c.metrics.volume5mUsd).padEnd(8)} b/s ${c.metrics.buySellRatio5m?.toFixed(2) ?? 'UNKNOWN'} · ${c.reasons[0] ?? ''}`);
    console.log('\nPRE-FLIGHT');
    for (const p of s.preflights) console.log(`  ${p.side} ${p.symbol ?? p.mint} via ${p.router} ${p.route} · in ${p.amountIn} · expected ${p.expectedOut} · min ${p.minimumOut} · impact ${p.priceImpactPct.toFixed(4)}% · ` +
      `slippage ${p.slippageBps} bps · priority ${p.priorityFeeLamports} · network ${p.networkFeeLamports} · rent ${p.accountRentLamports} · drag ${p.dragPct?.toFixed(2)}% · ` +
      `simulation ${p.simulation.status} (${p.simulation.detail}) · signature ${p.signature} · outcome ${p.outcome}`);
    if (!s.preflights.length) console.log('  none');
    console.log('\nLEDGER (TEST)');
    for (const e of s.ledger) console.log(`  ${clock(e.at)} ${e.side} ${e.symbol} ${e.quantity} entry ${e.entryPriceUsd ?? '-'} exit ${e.exitPriceUsd ?? '-'} net ${e.netPnlUsd ?? '-'} ${e.status}`);
    if (!s.ledger.length) console.log('  none');
    const c = s.capital;
    console.log(`\nCAPITAL  wallet ${c.walletSol ?? '--'} SOL (${c.walletUsd?.toFixed(2) ?? '--'} USD) · TEST cash ${c.paperCashUsd?.toFixed(2) ?? '--'} USD · positions ${c.openPositions} · realized ${c.realizedPnlUsd.toFixed(4)} · fees ${c.totalFeesUsd.toFixed(4)}`);
    console.log(`SOURCES  ${Object.entries(s.sources).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  } finally { await desk.close(); }
}

main().catch(error => { console.error(`desk:paper failed: ${(error as Error).message}`); process.exitCode = 1; });

/**
 * Research observer: records every pump.fun launch, its trades, metadata, X posts and website as observed facts, and
 * makes the research layer's calls: a launch matching a QUALIFIED rule (data-desk/research/qualified.json) goes to the
 * phone (DESK_NTFY_TOPIC / Telegram); every other candidate rule is recorded as a shadow call. Qualification is rerun
 * every 6 h in a child process. Read-only on chain: it never signs, trades or reads a private key.
 *
 *   npm run research:observe -- [--dir data-desk/research] [--sources public,publicnode[,helius]] [--min-free-mb 700] [--no-calls] [--no-phone] [--no-verified] [--no-ladder]
 *
 * Also watches established coins with a blue check (Jupiter verified, or on the watchlist watch-tokens.json in the
 * research folder) and sends an INFO message when one starts to move (research/verified.ts), and records the
 * market-cap ladder on every chain into research/ladder (research/ladder.ts; facts only, no messages).
 *
 * Trade sources are merged, each transaction once. "helius" adds the first Helius endpoint of RPC_ENDPOINTS;
 * Helius may bill websocket traffic against the plan's credits, so it is off unless asked for.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Connection } from '@solana/web3.js';
import { deskEnvironment } from '../desk/runtime';
import { notifier, fomoUrl } from '../desk/watch';
import { ResearchLedger } from '../research/ledger';
import { ResearchObserver, PUBLIC_RPC_WS, PUBLICNODE_WS } from '../research/observer';
import { CallEngine } from '../research/calls';
import { LocalFeed, LOCAL_FEED } from '../research/local-feed';
import { VerifiedWatch } from '../research/verified';
import { AliveReporter, aliveFile } from '../research/alive';
import { LadderWatch } from '../research/ladder';
import { rpcHolders } from '../research/holders';
import { SharedRest, geckoRestFile } from '../data/shared-rest';
import { QUALIFY_MEMORY, qualifyHeapMb, type Qualification } from '../research/qualify';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const REQUALIFY_MS = 6 * 3_600_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function main(): Promise<void> {
  const repo = path.resolve(arg('env') ?? '.'), env = await deskEnvironment(repo);
  const dir = path.resolve(arg('dir') ?? path.join(repo, 'data-desk', 'research'));
  const wanted = (arg('sources') ?? process.env.RESEARCH_SOURCES ?? 'public,publicnode').split(',').map(s => s.trim().toLowerCase());
  const sources: string[] = [];
  if (wanted.includes('public')) sources.push(PUBLIC_RPC_WS);
  if (wanted.includes('publicnode')) sources.push(PUBLICNODE_WS);
  if (wanted.includes('helius')) {
    const helius = (env.RPC_ENDPOINTS ?? '').split(',').map(s => s.trim()).find(s => /helius/i.test(s));
    if (helius) sources.push(helius.replace(/^http/, 'ws')); else console.log('no Helius endpoint in RPC_ENDPOINTS; public RPC only');
  }
  if (!sources.length) sources.push(PUBLIC_RPC_WS);
  const ledger = new ResearchLedger({ dir, minFreeMb: Number(arg('min-free-mb') ?? process.env.RESEARCH_MIN_FREE_MB ?? 700) });
  await ledger.start();

  // The SOL price for dollar market caps in call messages (Jupiter's free price API), refreshed every 5 minutes.
  let solUsd: number | null = null;
  const refreshSol = async () => {
    try {
      const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(8_000) })).json() as Record<string, { usdPrice?: number }>;
      const p = j[SOL_MINT]?.usdPrice;
      if (typeof p === 'number' && p > 0) solUsd = p;
    } catch { /* keep the last price */ }
  };
  await refreshSol();
  setInterval(() => void refreshSol(), 5 * 60_000).unref();

  const stamp = () => new Date().toISOString().slice(0, 19);
  // Every failed phone delivery is logged at once and counted in the status line: a silent phone is visible in observer.log.
  const phone = process.argv.includes('--no-phone') ? null : notifier(env, fetch, { onFailure: r => console.log(`${stamp()} phone delivery failed: ${r.channel} ${r.status !== null ? `HTTP ${r.status}` : r.error}`) });
  const phoneStatus = () => {
    if (!phone?.channels.length) return '';
    const h = phone.health();
    return ` · phone ${h.delivered}/${h.sent} delivered${h.failed ? `, ${h.failed} failed (last ${h.lastError} at ${new Date(h.lastFailureAt!).toISOString().slice(11, 19)})` : ''}`;
  };
  const calls = process.argv.includes('--no-calls') ? null : new CallEngine({ ledger, notify: phone?.channels.length ? phone.notify : null, solUsd: () => solUsd, link: fomoUrl,
    log: line => console.log(`${new Date().toISOString().slice(0, 19)} ${line}`) });
  const file = path.join(dir, 'qualified.json');
  const load = () => { try { calls?.setQualification(JSON.parse(fs.readFileSync(file, 'utf8')) as Qualification); } catch { calls?.setQualification(null); } };
  let qualifying = false;
  const requalify = () => {
    if (!calls || qualifying) return;
    const heapMb = qualifyHeapMb(os.freemem());
    if (heapMb === null) {
      console.log(`${stamp()} qualification postponed ${QUALIFY_MEMORY.retryMs / 60_000} min: only ${Math.round(os.freemem() / 1048576)} MB of memory free`);
      setTimeout(requalify, QUALIFY_MEMORY.retryMs).unref();
      return;
    }
    qualifying = true;
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, '--import', 'tsx', path.join(repo, 'src', 'scripts', 'research-qualify.ts'), '--dir', dir],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // Below normal priority: the desk's exits and the observer's streams come first.
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: normal priority */ }
    let out = `heap cap ${heapMb} MB (${Math.round(os.freemem() / 1048576)} MB free at start)\n`;
    child.stdout.on('data', b => { out += String(b); });
    child.stderr.on('data', b => { out += String(b); });
    child.on('exit', code => {
      qualifying = false;
      fs.writeFile(path.join(dir, 'qualify.log'), out, () => undefined);
      if (code === 0) load(); else console.log(`qualification failed (exit ${code}); see ${path.join(dir, 'qualify.log')}`);
    });
  };
  if (calls) {
    load();
    // The first run a minute after start when the file is missing or older than 6 h, then every 6 h.
    const age = fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : Infinity;
    const next = (ms: number) => { setTimeout(() => { requalify(); next(REQUALIFY_MS); }, ms).unref(); };
    next(age > REQUALIFY_MS ? 60_000 : REQUALIFY_MS - age);
  }

  // Established coins with a blue check that start to move: INFO to the phone, VT records for later study.
  const verified = process.argv.includes('--no-verified') ? null : new VerifiedWatch({ ledger, watchFile: path.join(dir, 'watch-tokens.json'),
    notify: phone?.channels.length ? phone.notify : null, link: fomoUrl, jupiterApiKey: env.JUPITER_API_KEY?.trim() || null,
    log: line => console.log(`${new Date().toISOString().slice(0, 19)} ${line}`) });
  verified?.start();

  // The market-cap ladder on every chain, in its own ledger folder; holder scans over the Helius endpoint when there is one.
  let ladderLedger: ResearchLedger | null = null, ladder: LadderWatch | null = null;
  if (!process.argv.includes('--no-ladder')) {
    const ladderDir = path.join(dir, 'ladder');
    ladderLedger = new ResearchLedger({ dir: ladderDir, minFreeMb: Number(arg('min-free-mb') ?? process.env.RESEARCH_MIN_FREE_MB ?? 700) });
    await ladderLedger.start();
    const endpoints = (env.RPC_ENDPOINTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const rpcUrl = endpoints.find(e => /helius/i.test(e)) ?? endpoints[0] ?? null;
    ladder = new LadderWatch({ ledger: ladderLedger, stateFile: path.join(ladderDir, 'ladder-state.json'), watchFile: path.join(dir, 'watch-tokens.json'),
      jupiterApiKey: env.JUPITER_API_KEY?.trim() || null, birdeyeApiKey: env.BIRDEYE_API_KEY?.trim() || null,
      holders: rpcUrl ? rpcHolders(new Connection(rpcUrl, 'confirmed')) : null, geckoRest: new SharedRest(geckoRestFile(path.dirname(dir))),
      log: line => console.log(`${new Date().toISOString().slice(0, 19)} ${line}`) });
    ladder.start();
  }

  // New launches and migrations for the desk on this machine (it stops polling the RPC for them while this runs).
  let observer: ResearchObserver | null = null;
  const startedAt = Date.now();
  // The desk's dashboard reads this (GET /health): observer heartbeat, research-ledger writes, phone deliveries.
  const feed = new LocalFeed(() => observer?.streamHealthy() ?? false, () => ({ startedAt,
    ledger: { bytes: ledger.bytes, records: ledger.records, writeErrors: ledger.writeErrors, lastWriteError: ledger.lastWriteError, lowDisk: ledger.lowDisk },
    phone: phone?.channels.length ? phone.health() : null }));
  await feed.listen(Number(env.RESEARCH_FEED_PORT) || LOCAL_FEED.port).catch((error: Error) => console.log(`local feed for the desk not started: ${error.message}`));
  observer = new ResearchObserver({ ledger, tradeSources: sources, calls, feed, log: line => console.log(line) });
  observer.start();
  console.log(`research observer: ${dir} · trade sources: ${wanted.filter(w => ['public', 'publicnode', 'helius'].includes(w)).join(' + ') || 'public'} · ` +
    `calls: ${calls ? `on, phone ${phone?.channels.length ? phone.channels.join(' + ') : 'not configured'}` : 'off'} · status every minute`);
  const stop = async () => { observer?.stop(); verified?.stop(); ladder?.stop(); feed.close(); await ledger.close(); await ladderLedger?.close(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // Dead-man: one ALIVE message a day (07:00 UTC or later); when it does not arrive, something is down.
  const ago = (at: number | null, now: number) => at === null ? 'never' : now - at < 120_000 ? `${Math.round((now - at) / 1000)} s ago` : now - at < 7_200_000 ? `${Math.round((now - at) / 60_000)} min ago` : `${((now - at) / 3_600_000).toFixed(1)} h ago`;
  const alive = phone?.channels.length ? new AliveReporter({ file: aliveFile(dir), notify: phone.notify, lines: now => {
    const h = phone.health();
    return [`Observer up ${((now - startedAt) / 3_600_000).toFixed(1)} h · launch stream ${observer?.streamHealthy() ? 'live' : 'DOWN'}.`,
      `Desk last read the feed ${ago(feed.lastPollAt, now)}.`,
      `Phone: ${h.delivered}/${h.sent} delivered since start${h.failed ? `, ${h.failed} failed (last: ${h.lastError})` : ''}.`,
      `Research ledger: ${(ledger.bytes / 1048576).toFixed(0)} MB written${ledger.writeErrors ? `, ${ledger.writeErrors} write errors` : ''}${ledger.lowDisk ? ', LOW DISK' : ''}.`,
      calls ? `Calls: ${calls.stats.calls} sent, ${calls.stats.judged} judged.` : 'Calls: off.'];
  } }) : null;
  if (alive) { void alive.tick(); setInterval(() => void alive.tick(), 60_000).unref(); }
  setInterval(() => console.log(`${observer!.status()}${verified ? ` · ${verified.status()}` : ''}${ladder ? ` · ${ladder.status()}` : ''}${phoneStatus()}`), 60_000).unref();
}

main().catch(error => { console.error(`research:observe failed: ${(error as Error).message}`); process.exit(1); });

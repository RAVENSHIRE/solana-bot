import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { loadConfig } from '../../../config/config';
import { Portfolio } from '../../../core/portfolio';
import { RiskManager } from '../../../core/risk-manager';
import { TradeJournal } from '../../../core/journal';
import { ConnectionManager } from '../../../rpc/connection-manager';
import { SimulatedExecutor } from '../../../execution/simulated-executor';
import { SOL_MINT, BASE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS } from '../../../core/types';
import { configureLogger, rootLogger as log } from '../../../utils/logger';
import { solToLamports } from '../../../utils/format';
import { PlaybookController } from './controller';
import { PlaybookMarket } from './market';
import { PlaybookTelemetry } from './telemetry';
import { PlaybookQuotes } from './quotes';
import type { Snapshot, Intent, EntryEvidence } from './model';

export function config(env: NodeJS.ProcessEnv = process.env) {
  const settings = z.object({
    PLAYBOOK_STATE_DIR: z.string().default('./data-playbook'),
    PLAYBOOK_MAX_MCAP_USD: z.coerce.number().finite().positive().max(1_000_000).default(1_000_000),
  }).parse(env);
  const stateDir = path.resolve(settings.PLAYBOOK_STATE_DIR);
  if (stateDir === path.resolve(env.STATE_DIR || './data')) throw new Error('Playbook must have a separate STATE_DIR');
  const cfg = loadConfig({ ...env, SIMULATION_MODE: 'true', SIM_STARTING_BALANCE_SOL: '10', SIM_USE_WALLET_BALANCE: 'false',
    // The existing validator expects this key; this runner never loads or uses a wallet secret.
    WALLET_PRIVATE_KEY: 'simulation-only-no-wallet-secret-required', WALLET_PUBLIC_KEY: '',
    STATE_DIR: stateDir, LOG_DIR: path.join(stateDir, 'logs'), RS_TRADE_SIZE_SOL: '0.2', RISK_MAX_POSITION_SOL: '0.2',
    SUTR_ENABLED: 'false', RS_ENABLED: 'false', SUTR_ARB_SIZE_SOL: '0.01' });
  return { cfg, maxCap: settings.PLAYBOOK_MAX_MCAP_USD, stateDir };
}

export async function run(): Promise<void> {
  const { cfg, maxCap, stateDir } = config();
  configureLogger({ level: cfg.logging.level, format: cfg.logging.format, color: cfg.logging.color });
  await fs.mkdir(stateDir, { recursive: true });
  // Never recover a corrupt simulation by silently resetting capital/history.
  try { JSON.parse(await fs.readFile(path.join(stateDir, 'state-SIMULATION.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Playbook state unreadable; restore a backup before restarting'); }
  const lockPath = path.join(stateDir, 'playbook.lock');
  const lock = await fs.open(lockPath, 'wx').catch(() => { throw new Error('Playbook lock exists. Check that the previous process stopped before removing playbook.lock.'); });
  await lock.writeFile(String(process.pid));
  let stop = false;
  let pf: Portfolio | undefined;
  let journal: TradeJournal | undefined;
  let manageTask: Promise<void> = Promise.resolve(), scanTask: Promise<void> = Promise.resolve();
  let managing = false, scanning = false;
  let manageTimer: NodeJS.Timeout | undefined, scanTimer: NodeJS.Timeout | undefined;
  const stopRun = () => { stop = true; };
  process.once('SIGINT', stopRun); process.once('SIGTERM', stopRun);
  try {
    const rpc = new ConnectionManager(cfg.rpc.endpoints, { commitment: 'confirmed', maxRps: cfg.rpc.maxRps, timeoutMs: cfg.rpc.timeoutMs, logger: log.child('rpc') });
    const genesis = await rpc.execute('genesis', c => c.getGenesisHash());
    if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Playbook requires Solana mainnet RPC');
    pf = await Portfolio.load(stateDir, 'SIMULATION', solToLamports(10), log, true);
    const portfolio = pf;
    journal = new TradeJournal(path.join(stateDir, 'logs'), 'SIMULATION', log, cfg.logging.color);
    const tel = new PlaybookTelemetry(stateDir);
    const quotes = new PlaybookQuotes(cfg.jupiter, log.child('quotes'));
    const executor = new SimulatedExecutor({ cfg, rpc, jupiter: quotes, logger: log.child('paper'), owner: Keypair.generate().publicKey }, portfolio, true);
    const risk = new RiskManager(cfg.risk, portfolio, log.child('risk'));
    const control = new PlaybookController(portfolio, executor, risk, cfg,
      { maxCap, initialStopPct: cfg.rs.stopLossPct, maxHoldMs: cfg.rs.maxHoldMin * 60_000, tradeSizeLamports: solToLamports(0.2) },
      record => { journal!.record(record); tel.trade(record); });
    const market = new PlaybookMarket(rpc, log.child('market'));
    const audit = async (snapshot: Snapshot, intent: Intent, evidence?: EntryEvidence) => {
      const ts = new Date().toISOString();
      const line = JSON.stringify({ ts, snapshot, intent, evidence: evidence ?? null }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      await fs.appendFile(path.join(stateDir, 'logs', `decisions-${ts.slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
    };
    let candidates = [...cfg.rs.watchlist];
    const observed = new Map<string, Snapshot>();
    let discoveredAt = 0, cursor = 0;
    log.info('Playbook SIMULATION: original 50% at 2x, 25% at 5x; one 25% re-entry', { stateDir, maxCap, initialStopPct: cfg.rs.stopLossPct, maxHoldMin: cfg.rs.maxHoldMin, initialPaperSol: 10, entrySol: 0.2 });
    const manage = async () => {
      const cycles = [...control.cycles.values()].filter(c => c.phase !== 'done');
      const rows = await market.snapshots(cycles.map(c => c.mint), new Map(cycles.map(c => [c.mint, c.pairAddress])));
      for (const s of rows.values()) {
        observed.set(s.mint, s);
        for (let stage = 0; stage < 2; stage++) {
          const start = Date.now();
          const result = await control.process(s);
          tel.observe(s, result, Date.now() - start);
          await audit(s, result);
          if (result.type !== 'SELL' || result.stage !== '2x') break;
        }
      }
      // Liquidation quotes, fees and recoverable rent; omit equity sample if any valuation fails.
      let equity = portfolio.virtualSolLamports();
      for (const p of portfolio.positions()) {
        const q = await quotes.quote({ inputMint: p.mint, outputMint: SOL_MINT, amountRaw: p.tokenAmountRaw, slippageBps: cfg.execution.defaultSlippageBps });
        const fee = BASE_FEE_LAMPORTS + await executor.estimatePriorityFeeLamports();
        const rent = cfg.execution.closeEmptyAccounts ? TOKEN_ACCOUNT_RENT_LAMPORTS - BASE_FEE_LAMPORTS : 0n;
        const value = BigInt(q.otherAmountThreshold) - fee + rent;
        portfolio.updatePosition(p.id, { lastValueLamports: value > 0n ? value : 0n, lastCheckedAt: Date.now() });
        equity += value > 0n ? value : 0n;
      }
      tel.markEquity(equity);
      await portfolio.flush(); await tel.flush();
    };
    const scan = async () => {
      if (Date.now() - discoveredAt >= 60_000) {
        try { candidates = [...new Set([...cfg.rs.watchlist, ...await market.discover()])]; }
        catch { log.warn('Discovery unavailable; continue existing watchlist and Phoenix candidates'); }
        discoveredAt = Date.now();
      }
      const watched = [...control.cycles.values()].filter(c => {
        const last = observed.get(c.mint);
        return c.phase === 'watching' && last && Date.now() - last.observedAt <= 90_000 && last.priceUsd <= c.peakUsd * 0.20;
      }).map(c => c.mint);
      const available = [...new Set([...watched, ...candidates])].filter(m => !portfolio.hasOpenPosition(m) && control.cycles.get(m)?.phase !== 'done');
      if (!available.length) return;
      const mint = available[cursor++ % available.length]!;
      const cycle = control.cycles.get(mint);
      if (!cycle && control.cycles.size >= 100) return; // bounded persistent universe; no silently forgotten cycle
      const start = Date.now();
      const s = (await market.snapshots([mint], cycle ? new Map([[mint, cycle.pairAddress]]) : undefined)).get(mint);
      if (!s) { log.info('Playbook SKIP', { mint, reason: 'MARKET_DATA_MISSING' }); return; }
      let skip: string | null = null;
      if (s.marketCapUsd === null || s.marketCapUsd >= maxCap) skip = 'MARKET_CAP_MISSING_OR_LIMIT';
      else if (!s.hasWebsite || !s.hasTwitter) skip = 'SOCIAL_LINKS_MISSING';
      else if (s.liquidityUsd === null || s.liquidityUsd < cfg.rs.minLiquidityUsd) skip = 'LIQUIDITY_MISSING_OR_LIMIT';
      else if (cycle && s.priceUsd > cycle.peakUsd * 0.20) skip = 'WAIT_FOR_80_PERCENT_DROP';
      if (skip) { const intent = { type: 'SKIP', reason: skip } as const; tel.observe(s, intent, Date.now() - start); await audit(s, intent); log.info('Playbook SKIP', { mint, reason: skip }); await tel.flush(); return; }
      let result: Awaited<ReturnType<PlaybookMarket['evidence']>>;
      try { result = await market.evidence(s, !!cycle); }
      catch {
        const intent = { type: 'SKIP', reason: 'ENTRY_DATA_UNAVAILABLE' } as const;
        tel.observe(s, intent, Date.now() - start); await audit(s, intent);
        log.warn('Playbook SKIP', { mint, reason: intent.reason }); await tel.flush(); return;
      }
      if (stop) return;
      const intent = await control.process(s, result.evidence, result.decimals);
      tel.observe(s, intent, Date.now() - start);
      await audit(s, intent, result.evidence);
      log.info(`Playbook ${intent.type}`, { mint, reason: intent.reason, top10OwnerFraction: result.evidence.top10OwnerFraction });
      await tel.flush();
    };
    const kickManage = () => { if (!stop && !managing) { managing = true; manageTask = manage().catch(e => { log.error('Playbook manage failed', { error: e instanceof Error ? e.message : 'unknown' }); }).finally(() => { managing = false; }); } };
    const kickScan = () => { if (!stop && !scanning) { scanning = true; scanTask = scan().catch(e => { log.warn('Playbook scan unavailable', { error: e instanceof Error ? e.message : 'unknown' }); }).finally(() => { scanning = false; }); } };
    manageTimer = setInterval(kickManage, 15_000); scanTimer = setInterval(kickScan, 15_000);
    kickManage(); kickScan();
    while (!stop) await new Promise(resolve => setTimeout(resolve, 250));
  } finally {
    if (manageTimer) clearInterval(manageTimer); if (scanTimer) clearInterval(scanTimer);
    await Promise.allSettled([manageTask, scanTask]);
    await pf?.flush(); await journal?.flush();
    await lock.close(); await fs.unlink(lockPath);
    process.removeListener('SIGINT', stopRun); process.removeListener('SIGTERM', stopRun);
  }
}
if (require.main === module) void run().catch(e => { log.error('Playbook stopped', { error: e instanceof Error ? e.message : 'unknown' }); process.exitCode = 1; });

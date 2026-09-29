import path from 'node:path';
import { DataRuntime } from './data/core/data-runtime';
import { MarketDataStore } from './data/storage/market-data-store';
import { safeInteger, parse } from './data/core/data-validator';
import { loadConfig, type AppConfig } from './config/config';
import { configureLogger, rootLogger } from './utils/logger';
import { checkEnvFilePermissions, loadWalletFromEnv } from './utils/wallet';
import { ConnectionManager } from './rpc/connection-manager';
import { JupiterClient } from './execution/jupiter-client';
import { TransactionSender } from './execution/tx-sender';
import { LiveExecutor } from './execution/live-executor';
import { SimulatedExecutor } from './execution/simulated-executor';
import type { ExecutorDeps, TradeExecutor } from './execution/executor';
import { Portfolio } from './core/portfolio';
import { RiskManager } from './core/risk-manager';
import { TradeJournal } from './core/journal';
import { Engine } from './core/engine';
import { Telemetry } from './core/telemetry';
import { DexScreenerClient } from './data/dexscreener';
import { GeckoTerminalClient } from './data/geckoterminal';
import { RaydiumClient } from './data/raydium';
import { TokenSafetyChecker } from './analysis/token-safety';
import type { StrategyContext } from './strategies/base-strategy';
import { ReversalSniperStrategy } from './strategies/reversal-sniper';
import { SuckUpTheRentStrategy } from './strategies/suck-up-the-rent';
import { ConfigError, errorMessage } from './utils/errors';
import { lamportsToSol, maskUrl, solToLamports } from './utils/format';

const log = rootLogger;
let engine: Engine | null = null;
let portfolioRef: Portfolio | null = null;
let telemetryRef: Telemetry | null = null;
let shuttingDown = false;

function banner(cfg: AppConfig, wallet: string): void {
  const line = '═'.repeat(64);
  process.stdout.write(`\n${line}\n  Solana Autonomous Trading Bot\n  Modus : ${cfg.mode}\n  Wallet: ${wallet}\n${line}\n`);
  if (cfg.mode === 'LIVE') {
    log.warn('⚠ LIVE-MODUS AKTIV – es werden echte Transaktionen mit echtem Kapital signiert und gesendet!');
    log.warn('⚠ Nutze eine separate Hot-Wallet mit begrenztem Guthaben. Keine Gewinngarantie, Totalverlust möglich.');
  } else {
    log.info('SIMULATION_MODE=true → echte Marktdaten & Quotes, virtuelle Ausführung, keine Transaktionen');
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  configureLogger({ level: cfg.logging.level, format: cfg.logging.format, color: cfg.logging.color });
  checkEnvFilePermissions(log);

  const wallet = loadWalletFromEnv();
  const owner = wallet.publicKey;
  banner(cfg, owner.toBase58());

  // ------------------------------------------------------------------ RPC
  const rpc = new ConnectionManager(cfg.rpc.endpoints, {
    commitment: cfg.rpc.commitment,
    maxRps: cfg.rpc.maxRps,
    timeoutMs: cfg.rpc.timeoutMs,
    logger: log.child('rpc'),
  });
  const health = await rpc.healthCheck();
  for (const h of health) {
    if (h.ok) log.info(`RPC ok: ${h.label}`, { latencyMs: h.latencyMs, slot: h.slot });
    else log.warn(`RPC nicht erreichbar: ${h.label}`, { error: h.error });
  }
  if (!health.some((h) => h.ok)) {
    throw new Error(`Kein RPC-Endpoint erreichbar (${cfg.rpc.endpoints.map(maskUrl).join(', ')})`);
  }

  const genesis = await rpc.execute('getGenesisHash', c => c.getGenesisHash());
  if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Data providers require Solana mainnet RPC');
  const walletLamports = BigInt(parse(safeInteger, await rpc.execute('getBalance', (c) => c.getBalance(owner, 'confirmed')), 'solana-rpc'));
  log.info(`Wallet-Guthaben: ${lamportsToSol(walletLamports)} SOL`);
  if (cfg.mode === 'LIVE' && walletLamports < solToLamports(cfg.risk.minSolReserve)) {
    log.warn('Guthaben liegt unter RISK_MIN_SOL_RESERVE – es werden keine Einstiege möglich sein');
  }

  // ------------------------------------------------------------------ Zustand
  const initialVirtual = cfg.paper.useWalletBalance ? walletLamports : solToLamports(cfg.paper.startingBalanceSol);
  const portfolio = await Portfolio.load(cfg.stateDir, cfg.mode, initialVirtual, log);
  portfolioRef = portfolio;
  const history = cfg.data.persistHistory ? new MarketDataStore(path.join(cfg.stateDir, 'market-history'), cfg.mode, log, cfg.data.retentionDays, cfg.data.historyMaxBytes) : undefined;
  const data = new DataRuntime(log.child('data'), cfg.data, history);
  rpc.attachDataHealth(data.health);
  const journal = new TradeJournal(cfg.logging.dir, cfg.mode, log, cfg.logging.color, record => data.record('trade-result', record.strategy, record));

  // ------------------------------------------------------------------ Ausführung
  const jupiter = new JupiterClient(cfg.jupiter, log.child('jupiter'), data);
  const deps: ExecutorDeps = { cfg, rpc, jupiter, logger: log.child('executor'), owner };
  let executor: TradeExecutor;
  if (cfg.mode === 'LIVE') {
    const sender = new TransactionSender(rpc, log.child('tx'), {
      confirmTimeoutMs: cfg.execution.confirmTimeoutMs,
      pollIntervalMs: 1_500,
      rebroadcastIntervalMs: 2_000,
    });
    executor = new LiveExecutor(deps, wallet, sender);
  } else {
    executor = new SimulatedExecutor(deps, portfolio);
    log.info(`Virtuelles Guthaben: ${lamportsToSol(portfolio.virtualSolLamports(), 4)} SOL`);
  }

  const risk = new RiskManager(cfg.risk, portfolio, log.child('risk'));

  // Dashboard-Telemetrie (dashboard-{MODE}.json im STATE_DIR) – wird von `npm run dashboard` gelesen
  const scanIntervals = [
    cfg.rs.enabled ? cfg.rs.scanIntervalMs : null,
    cfg.sutr.enabled ? cfg.sutr.scanIntervalMs : null,
  ].filter((v): v is number => v !== null);
  const dex = new DexScreenerClient(log.child('dexscreener'), data);
  const telemetry = await Telemetry.load({
    dir: cfg.stateDir,
    mode: cfg.mode,
    botName: 'Solana Autonomous Bot',
    logger: log,
    rpc,
    executor,
    portfolio,
    jupiter,
    dex,
    decisionCadenceSeconds: scanIntervals.length > 0 ? Math.min(...scanIntervals) / 1000 : null,
  });
  journal.onRecord((r) => telemetry.recordTrade(r));
  telemetryRef = telemetry;
  const ctx: StrategyContext = {
    data,
    cfg,
    logger: log,
    rpc,
    executor,
    jupiter,
    portfolio,
    risk,
    journal,
    dex,
    gecko: new GeckoTerminalClient(log.child('gecko'), data),
    raydium: new RaydiumClient(log.child('raydium'), data),
    safety: new TokenSafetyChecker(rpc, log.child('safety')),
    telemetry,
    wallet: owner,
  };

  engine = new Engine({
    data,
    portfolio,
    risk,
    journal,
    rpc,
    executor,
    logger: log,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    tickTimeoutMs: cfg.tickTimeoutMs,
    shutdownGraceMs: cfg.shutdownGraceMs,
    rpcHealthIntervalMs: cfg.rpc.healthIntervalMs,
  });
  engine.register(new SuckUpTheRentStrategy(ctx));
  engine.register(new ReversalSniperStrategy(ctx));
  await engine.start();
  telemetry.start();

  // PM2 wait_ready: Prozess gilt erst als "online", wenn alles initialisiert ist
  if (typeof process.send === 'function') process.send('ready');
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    log.warn(`${signal} erneut empfangen – erzwinge sofortiges Beenden`);
    process.exit(exitCode || 1);
  }
  shuttingDown = true;
  log.info(`${signal} empfangen – fahre geordnet herunter …`);
  const force = setTimeout(() => {
    log.error('Shutdown-Timeout überschritten – erzwinge Beenden');
    process.exit(exitCode || 1);
  }, 45_000);
  force.unref();
  try {
    if (engine) await engine.stop();
    else if (portfolioRef) await portfolioRef.flush();
    if (telemetryRef) await telemetryRef.stop();
  } catch (e) {
    log.error('Fehler beim Herunterfahren', { error: errorMessage(e) });
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// PM2 unter Windows / manche Setups senden 'shutdown' als Nachricht
process.on('message', (msg) => {
  if (msg === 'shutdown') void shutdown('PM2 shutdown');
});

process.on('unhandledRejection', (reason) => {
  // Einzelne verwaiste Promises sollen den 24/7-Betrieb nicht beenden – aber sichtbar sein
  log.error('Unbehandelte Promise-Ablehnung', { error: errorMessage(reason) });
});

process.on('uncaughtException', (err) => {
  log.error('Unbehandelte Ausnahme – Prozess wird beendet (PM2 startet neu)', { error: err.message, stack: err.stack });
  const flush = portfolioRef ? portfolioRef.flush() : Promise.resolve();
  void flush.finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});

main().catch((e) => {
  if (e instanceof ConfigError) {
    log.error(e.message);
    // Konfigurationsfehler: nicht in eine PM2-Restart-Schleife laufen → Exit-Code 78 (EX_CONFIG)
    process.exit(78);
  }
  log.error('Start fehlgeschlagen', { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
});

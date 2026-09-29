import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { loadConfig } from '../config/schema';
import { ConnectionManager } from '../rpc/connection-manager';
import { DataRuntime } from '../data/core/data-runtime';
import { DexScreenerClient } from '../data/dexscreener';
import { GeckoTerminalClient } from '../data/geckoterminal';
import { TokenSafetyChecker } from '../analysis/token-safety';
import { Logger } from '../utils/logger';
import { acquireProcessLock } from '../utils/fs';
import { JupiterClient } from '../execution/jupiter-client';
import { TransactionSender } from '../execution/tx-sender';
import { DeskEngine, type DeskWallet } from './engine';
import { DeskReject } from './guard';
import { XClient } from './social';
import { deskCapital, type DeskCapital } from './config';
import type { DeskMode } from './types';

/**
 * Provider and risk settings only. This allowlist never reads a local private key, so the desk
 * can only sign through Phantom; the main engine's simulation/live switch is never touched.
 */
const ENV_KEYS = ['RPC_ENDPOINTS', 'RPC_MAX_RPS', 'RPC_TIMEOUT_MS', 'JUPITER_API_KEY', 'JUPITER_API_BASE', 'JUPITER_MAX_RPS', 'JUPITER_QUOTE_MAX_AGE_MS',
  'MAX_PRIORITY_FEE_LAMPORTS', 'PRIORITY_LEVEL', 'MAX_PRICE_IMPACT_PCT', 'TX_CONFIRM_TIMEOUT_MS', 'RS_TAKE_PROFIT_PCT', 'RS_STOP_LOSS_PCT',
  'RS_TRAILING_ACTIVATION_PCT', 'RS_TRAILING_STOP_PCT', 'RS_MAX_HOLD_MIN', 'RS_MAX_WASH_RATIO',
  'DESK_PLANNED_CAPITAL_USD', 'DESK_BASE_ENTRY_USD', 'DESK_SLIPPAGE_BPS', 'X_BEARER_TOKEN'];
export async function deskEnvironment(repo: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  try {
    const lines = createInterface({ input: createReadStream(path.join(repo, '.env')), crlfDelay: Infinity });
    for await (const line of lines) {
      const key = /^\s*([A-Z_]+)\s*=/.exec(line)?.[1];
      if (key && ENV_KEYS.includes(key)) Object.assign(env, parseEnv(line));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  return { ...env, SIMULATION_MODE: 'true', PRE_SIMULATE_TX: 'true', CLOSE_EMPTY_TOKEN_ACCOUNTS: 'false' };
}

export interface DeskHandle { engines: Record<DeskMode, DeskEngine>; capital: DeskCapital; close: () => Promise<void> }
export interface DeskContext { wallet: (mode: DeskMode) => DeskWallet | null; authorized: () => boolean }

/** UI-independent desk: the dashboard and the headless runner build the same engines. */
export async function createDesk(o: { envDir: string; dataDir: string }, context: DeskContext): Promise<DeskHandle> {
  const env = await deskEnvironment(o.envDir);
  if (!env.RPC_ENDPOINTS) throw new DeskReject('RPC_NOT_CONFIGURED');
  if (!env.JUPITER_API_KEY) throw new DeskReject('JUPITER_API_KEY_REQUIRED');
  const cfg = loadConfig(env, 'PHANTOM'), capital = deskCapital(env), logger = new Logger('Desk');
  const rpc = new ConnectionManager(cfg.rpc.endpoints, { ...cfg.rpc, logger });
  if (await rpc.execute('desk:genesis', c => c.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new DeskReject('MAINNET_REQUIRED');
  const data = new DataRuntime(logger, cfg.data);
  await fs.mkdir(o.dataDir, { recursive: true });
  const lockPath = path.join(o.dataDir, 'desk.lock');
  const lock = await acquireProcessLock(lockPath).catch(() => { throw new DeskReject('INSTANCE_LOCK'); });
  try {
    const shared = { cfg, capital, logger, rpc, jupiter: new JupiterClient(cfg.jupiter, logger, data), dex: new DexScreenerClient(logger, data),
      gecko: new GeckoTerminalClient(logger, data), safety: new TokenSafetyChecker(rpc, logger), x: new XClient(env.X_BEARER_TOKEN ?? null),
      dir: o.dataDir, authorized: context.authorized };
    const sender = new TransactionSender(rpc, logger, { confirmTimeoutMs: cfg.execution.confirmTimeoutMs, pollIntervalMs: 1500, rebroadcastIntervalMs: 2000 });
    const engines = {
      PAPER: await DeskEngine.create({ ...shared, mode: 'PAPER', sender: null, wallet: () => context.wallet('PAPER') }),
      LIVE: await DeskEngine.create({ ...shared, mode: 'LIVE', sender, wallet: () => context.wallet('LIVE') }),
    };
    return { engines, capital, close: async () => {
      for (const e of Object.values(engines)) { e.stop('shutdown'); await e.settled(); await e.persist(); }
      await data.flush(); await lock.close(); await fs.unlink(lockPath);
    } };
  } catch (error) { await lock.close(); await fs.unlink(lockPath); throw error; }
}

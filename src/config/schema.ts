import type { DataSettings } from '../data/core/data-runtime';
import { z } from 'zod';
import type { Commitment } from '@solana/web3.js';
import { BASE58_ADDRESS_REGEX, type ExecMode } from '../core/types';
import { ConfigError } from '../utils/errors';
import type { LogFormat, LogLevel } from '../utils/logger';

// ---------------------------------------------------------------------------
// Zod-Helfer: leere Strings aus .env werden wie "nicht gesetzt" behandelt.
// ---------------------------------------------------------------------------
const blank = (v: unknown): unknown =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v;

const num = (def: number, min = -Infinity, max = Infinity) =>
  z.preprocess((v) => blank(v) ?? def, z.coerce.number().finite().min(min).max(max));

const int = (def: number, min = -Infinity, max = Infinity) =>
  z.preprocess((v) => blank(v) ?? def, z.coerce.number().int().min(min).max(max));

const bool = (def: boolean) =>
  z.preprocess((v) => {
    const s = blank(v);
    if (s === undefined) return def;
    if (typeof s === 'boolean') return s;
    return ['true', '1', 'yes', 'on', 'ja'].includes(String(s).trim().toLowerCase());
  }, z.boolean());

const text = (def: string) => z.preprocess((v) => blank(v) ?? def, z.string());
const optText = z.preprocess((v) => blank(v), z.string().optional());

const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
  z.array(z.string()),
);

const addressList = list.refine(
  (arr) => arr.every((a) => BASE58_ADDRESS_REGEX.test(a)),
  'Enthält ungültige Solana-Adressen',
);

const oneOf = <const T extends readonly [string, ...string[]]>(values: T, def: T[number]): z.ZodType<T[number], z.ZodTypeDef, unknown> =>
  z.preprocess((v) => blank(v) ?? def, z.enum(values)) as z.ZodType<T[number], z.ZodTypeDef, unknown>;

const EnvSchema = z.object({
  // Modus & Wallet
  SIMULATION_MODE: bool(true),
  LIVE_TRADING_CONFIRMED: optText,
  WALLET_PRIVATE_KEY: optText,
  WALLET_PUBLIC_KEY: optText,

  // RPC
  RPC_ENDPOINTS: list
    .refine((a) => a.length > 0, 'Mindestens ein RPC-Endpoint erforderlich')
    .refine((a) => a.every((u) => /^https?:\/\//.test(u)), 'RPC-URLs müssen mit http(s):// beginnen'),
  RPC_COMMITMENT: oneOf(['processed', 'confirmed', 'finalized'], 'confirmed'),
  RPC_MAX_RPS: num(10, 0.5, 1000),
  RPC_TIMEOUT_MS: int(15_000, 1_000, 120_000),
  RPC_HEALTH_INTERVAL_MS: int(30_000, 5_000, 600_000),

  // Shared read-only market-data layer
  DATA_CACHE_ENABLED: bool(true),
  DATA_DISCOVERY_TTL_MS: int(60_000, 0, 300_000),
  DATA_ANALYSIS_TTL_MS: int(15_000, 0, 60_000),
  DATA_POSITION_TTL_MS: int(3000, 0, 15_000),
  DATA_MAX_CONCURRENT: int(4, 2, 16),
  DATA_RETRIES: int(2, 0, 5),
  DATA_TIMEOUT_MS: int(10_000, 1000, 60_000),
  DATA_MAX_PRICE_AGE_MS: int(90_000, 5000, 300_000),
  DATA_MAX_CANDLE_AGE_MS: int(600_000, 300_000, 1_800_000),
  DATA_DEX_RPS: num(1, 0.05, 1),
  DATA_GECKO_RPS: num(8 / 60, 0.01, 0.5),
  DATA_RAYDIUM_RPS: num(1, 0.05, 5),
  DATA_HISTORY_ENABLED: bool(true),
  DATA_RETENTION_DAYS: int(7, 1, 365),
  DATA_HISTORY_MAX_MB: int(128, 8, 4096),
  DATA_MAX_PRICE_DIFFERENCE_PCT: num(20, 0, 100),
  DATA_MAX_LIQUIDITY_DIFFERENCE_PCT: num(50, 0, 100),

  // Jupiter
  JUPITER_API_BASE: text('https://api.jup.ag/swap/v1'),
  JUPITER_API_KEY: optText,
  JUPITER_MAX_RPS: num(1, 0.1, 100),
  JUPITER_MAX_ACCOUNTS: int(40, 16, 64),
  JUPITER_QUOTE_MAX_AGE_MS: int(15_000, 1000, 60_000),
  PRIORITY_LEVEL: oneOf(['medium', 'high', 'veryHigh'], 'high'),
  MAX_PRIORITY_FEE_LAMPORTS: int(300_000, 0, 50_000_000),

  // Ausführung
  DEFAULT_SLIPPAGE_BPS: int(150, 1, 5_000),
  MAX_PRICE_IMPACT_PCT: num(3, 0.01, 50),
  PRE_SIMULATE_TX: bool(true),
  TX_CONFIRM_TIMEOUT_MS: int(120_000, 20_000, 300_000),
  CLOSE_EMPTY_TOKEN_ACCOUNTS: bool(true),

  // Simulation / Paper-Trading
  SIM_STARTING_BALANCE_SOL: num(5, 0),
  SIM_USE_WALLET_BALANCE: bool(false),
  SIM_LATENCY_MS: int(600, 0, 10_000),
  SIM_EXTRA_SLIPPAGE_BPS: int(20, 0, 2_000),

  // Risiko
  RISK_MAX_POSITION_SOL: num(0.1, 0.001),
  RISK_MAX_TOTAL_EXPOSURE_SOL: num(0.5, 0.001),
  RISK_MAX_DAILY_LOSS_SOL: num(0.2, 0.001),
  RISK_MAX_OPEN_POSITIONS: int(5, 1, 100),
  RISK_MIN_SOL_RESERVE: num(0.05, 0),
  RISK_LOSS_COOLDOWN_MIN: int(120, 0, 10_080),
  RISK_MAX_CONSECUTIVE_TX_FAILURES: int(5, 1, 100),
  RISK_CIRCUIT_BREAKER_PAUSE_MIN: int(15, 1, 1_440),

  // Strategie: SuckUpTheRent
  SUTR_ENABLED: bool(true),
  SUTR_SCAN_INTERVAL_MS: int(30_000, 5_000),
  SUTR_MANAGE_INTERVAL_MS: int(10_000, 2_000),
  SUTR_ARB_ENABLED: bool(true),
  SUTR_ARB_SIZE_SOL: num(0.05, 0.001),
  SUTR_ARB_MIN_EDGE_BPS: int(40, 1),
  SUTR_ARB_MAX_PROBES: int(4, 1, 50),
  SUTR_MIN_LIQUIDITY_USD: num(75_000, 0),
  SUTR_MIN_VELOCITY: num(0.3, 0),
  SUTR_MIN_POOL_AGE_MIN: int(30, 0),
  SUTR_LP_SIM_ENABLED: bool(true),
  SUTR_LP_SCAN_INTERVAL_MS: int(300_000, 30_000),
  SUTR_LP_SIZE_SOL: num(1, 0.001),
  SUTR_LP_MAX_POSITIONS: int(5, 1, 50),
  SUTR_LP_MIN_TVL_USD: num(100_000, 0),
  SUTR_LP_MIN_FEE_APR: num(50, 0),
  SUTR_LP_MAX_HOLD_MIN: int(720, 5),
  SUTR_LP_MAX_LOSS_PCT: num(5, 0.1, 100),
  SUTR_RENT_RECLAIM_ENABLED: bool(true),
  SUTR_RENT_RECLAIM_INTERVAL_MS: int(1_800_000, 60_000),

  // Strategie: ReversalSniper
  RS_ENABLED: bool(true),
  RS_SCAN_INTERVAL_MS: int(60_000, 10_000),
  RS_MANAGE_INTERVAL_MS: int(15_000, 2_000),
  RS_TRADE_SIZE_SOL: num(0.05, 0.001),
  RS_MIN_LIQUIDITY_USD: num(40_000, 0),
  RS_MIN_MCAP_USD: num(250_000, 0),
  RS_MAX_MCAP_USD: num(100_000_000, 0),
  RS_MIN_PAIR_AGE_HOURS: num(12, 0),
  RS_MIN_H24_DROP_PCT: num(15, 0, 99),
  RS_MIN_DRAWDOWN_PCT: num(35, 1, 99),
  RS_MIN_SCORE: num(65, 0, 100),
  RS_MAX_ANALYSES_PER_SCAN: int(5, 1, 50),
  RS_REEVALUATE_AFTER_MIN: int(20, 1),
  RS_MAX_WASH_RATIO: num(0.45, 0, 1),
  RS_SUPPORT_TOLERANCE_PCT: num(2.5, 0.1, 20),
  RS_TAKE_PROFIT_PCT: num(30, 1),
  RS_STOP_LOSS_PCT: num(12, 1, 90),
  RS_TRAILING_ACTIVATION_PCT: num(12, 0),
  RS_TRAILING_STOP_PCT: num(8, 0, 90),
  RS_MAX_HOLD_MIN: int(360, 1),
  RS_SMART_MONEY_WALLETS: addressList,
  RS_WATCHLIST: addressList,
  RS_MIN_ACCUMULATION_USD: num(500, 0),

  // Betrieb
  LOG_LEVEL: oneOf(['debug', 'info', 'warn', 'error'], 'info'),
  LOG_FORMAT: oneOf(['pretty', 'json'], 'pretty'),
  LOG_COLOR: bool(true),
  LOG_DIR: text('./logs'),
  STATE_DIR: text('./data'),
  HEARTBEAT_INTERVAL_MS: int(300_000, 10_000),
  TICK_TIMEOUT_MS: int(240_000, 10_000),
  SHUTDOWN_GRACE_MS: int(20_000, 1_000, 120_000),
});

export interface AppConfig {
  data: DataSettings;
  mode: ExecMode;
  simulation: boolean;
  rpc: {
    endpoints: string[];
    commitment: Commitment;
    maxRps: number;
    timeoutMs: number;
    healthIntervalMs: number;
  };
  jupiter: {
    baseUrl: string;
    apiKey: string | undefined;
    maxRps: number;
    maxAccounts: number;
    priorityLevel: 'medium' | 'high' | 'veryHigh';
    maxPriorityFeeLamports: number;
    quoteMaxAgeMs?: number;
  };
  execution: {
    defaultSlippageBps: number;
    maxPriceImpactPct: number;
    preSimulate: boolean;
    confirmTimeoutMs: number;
    closeEmptyAccounts: boolean;
  };
  paper: {
    startingBalanceSol: number;
    useWalletBalance: boolean;
    latencyMs: number;
    extraSlippageBps: number;
  };
  risk: {
    maxPositionSol: number;
    maxTotalExposureSol: number;
    maxDailyLossSol: number;
    maxOpenPositions: number;
    minSolReserve: number;
    lossCooldownMin: number;
    maxConsecutiveTxFailures: number;
    circuitBreakerPauseMin: number;
  };
  sutr: {
    enabled: boolean;
    scanIntervalMs: number;
    manageIntervalMs: number;
    arbEnabled: boolean;
    arbSizeSol: number;
    arbMinEdgeBps: number;
    arbMaxProbes: number;
    minLiquidityUsd: number;
    minVelocity: number;
    minPoolAgeMin: number;
    lpSimEnabled: boolean;
    lpScanIntervalMs: number;
    lpSizeSol: number;
    lpMaxPositions: number;
    lpMinTvlUsd: number;
    lpMinFeeApr: number;
    lpMaxHoldMin: number;
    lpMaxLossPct: number;
    rentReclaimEnabled: boolean;
    rentReclaimIntervalMs: number;
  };
  rs: {
    enabled: boolean;
    scanIntervalMs: number;
    manageIntervalMs: number;
    tradeSizeSol: number;
    minLiquidityUsd: number;
    minMcapUsd: number;
    maxMcapUsd: number;
    minPairAgeHours: number;
    minH24DropPct: number;
    minDrawdownPct: number;
    minScore: number;
    maxAnalysesPerScan: number;
    reevaluateAfterMin: number;
    maxWashRatio: number;
    supportTolerancePct: number;
    takeProfitPct: number;
    stopLossPct: number;
    trailingActivationPct: number;
    trailingStopPct: number;
    maxHoldMin: number;
    smartMoneyWallets: string[];
    watchlist: string[];
    minAccumulationUsd: number;
  };
  logging: { level: LogLevel; format: LogFormat; color: boolean; dir: string };
  stateDir: string;
  heartbeatIntervalMs: number;
  tickTimeoutMs: number;
  shutdownGraceMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, signer: 'LOCAL_KEY' | 'PHANTOM' = 'LOCAL_KEY'): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Ungültige Konfiguration (.env):\n${issues}`);
  }
  const e = parsed.data;
  if (signer === 'LOCAL_KEY' && (!e.WALLET_PRIVATE_KEY || e.WALLET_PRIVATE_KEY.length < 32))
    throw new ConfigError('WALLET_PRIVATE_KEY fehlt oder ist zu kurz');
  // CLI-Flag --simulation erzwingt den Dry-Run unabhängig von der .env (plattformunabhängig, auch Windows)
  const simulation = e.SIMULATION_MODE || process.argv.includes('--simulation');

  if (!simulation && e.LIVE_TRADING_CONFIRMED !== 'I_UNDERSTAND_THE_RISKS') {
    throw new ConfigError(
      'SIMULATION_MODE=false erfordert zusätzlich LIVE_TRADING_CONFIRMED=I_UNDERSTAND_THE_RISKS (Sicherheitsverriegelung).',
    );
  }
  if (/(^|\.)api\.jup\.ag/.test(e.JUPITER_API_BASE) && !e.JUPITER_API_KEY) {
    throw new ConfigError('JUPITER_API_KEY fehlt – api.jup.ag erfordert einen Key (kostenlos unter portal.jup.ag).');
  }
  if (e.WALLET_PUBLIC_KEY && !BASE58_ADDRESS_REGEX.test(e.WALLET_PUBLIC_KEY)) {
    throw new ConfigError('WALLET_PUBLIC_KEY ist keine gültige Solana-Adresse.');
  }
  const sizes: Array<[string, number]> = [
    ['RS_TRADE_SIZE_SOL', e.RS_TRADE_SIZE_SOL],
    ['SUTR_ARB_SIZE_SOL', e.SUTR_ARB_SIZE_SOL],
  ];
  for (const [name, size] of sizes) {
    if (size > e.RISK_MAX_POSITION_SOL) {
      throw new ConfigError(`${name} (${size}) ist größer als RISK_MAX_POSITION_SOL (${e.RISK_MAX_POSITION_SOL}).`);
    }
  }
  if (e.RISK_MAX_POSITION_SOL > e.RISK_MAX_TOTAL_EXPOSURE_SOL) {
    throw new ConfigError('RISK_MAX_POSITION_SOL darf RISK_MAX_TOTAL_EXPOSURE_SOL nicht übersteigen.');
  }
  if (e.RS_MIN_MCAP_USD >= e.RS_MAX_MCAP_USD) {
    throw new ConfigError('RS_MIN_MCAP_USD muss kleiner als RS_MAX_MCAP_USD sein.');
  }

  return {
    data: { cacheEnabled: e.DATA_CACHE_ENABLED, discoveryTtlMs: e.DATA_DISCOVERY_TTL_MS, analysisTtlMs: e.DATA_ANALYSIS_TTL_MS,
      positionTtlMs: e.DATA_POSITION_TTL_MS, maxConcurrent: e.DATA_MAX_CONCURRENT, retries: e.DATA_RETRIES, timeoutMs: e.DATA_TIMEOUT_MS,
      maxPriceAgeMs: e.DATA_MAX_PRICE_AGE_MS, maxCandleAgeMs: e.DATA_MAX_CANDLE_AGE_MS, dexRps: e.DATA_DEX_RPS,
      geckoRps: e.DATA_GECKO_RPS, raydiumRps: e.DATA_RAYDIUM_RPS, persistHistory: e.DATA_HISTORY_ENABLED,
      retentionDays: e.DATA_RETENTION_DAYS, historyMaxBytes: e.DATA_HISTORY_MAX_MB * 1024 * 1024,
      maxPriceDifferencePct: e.DATA_MAX_PRICE_DIFFERENCE_PCT, maxLiquidityDifferencePct: e.DATA_MAX_LIQUIDITY_DIFFERENCE_PCT },
    mode: simulation ? 'SIMULATION' : 'LIVE',
    simulation,
    rpc: {
      endpoints: e.RPC_ENDPOINTS,
      commitment: e.RPC_COMMITMENT,
      maxRps: e.RPC_MAX_RPS,
      timeoutMs: e.RPC_TIMEOUT_MS,
      healthIntervalMs: e.RPC_HEALTH_INTERVAL_MS,
    },
    jupiter: {
      baseUrl: e.JUPITER_API_BASE.replace(/\/+$/, ''),
      apiKey: e.JUPITER_API_KEY,
      maxRps: e.JUPITER_MAX_RPS,
      maxAccounts: e.JUPITER_MAX_ACCOUNTS,
      quoteMaxAgeMs: e.JUPITER_QUOTE_MAX_AGE_MS,
      priorityLevel: e.PRIORITY_LEVEL,
      maxPriorityFeeLamports: e.MAX_PRIORITY_FEE_LAMPORTS,
    },
    execution: {
      defaultSlippageBps: e.DEFAULT_SLIPPAGE_BPS,
      maxPriceImpactPct: e.MAX_PRICE_IMPACT_PCT,
      preSimulate: e.PRE_SIMULATE_TX,
      confirmTimeoutMs: e.TX_CONFIRM_TIMEOUT_MS,
      closeEmptyAccounts: e.CLOSE_EMPTY_TOKEN_ACCOUNTS,
    },
    paper: {
      startingBalanceSol: e.SIM_STARTING_BALANCE_SOL,
      useWalletBalance: e.SIM_USE_WALLET_BALANCE,
      latencyMs: e.SIM_LATENCY_MS,
      extraSlippageBps: e.SIM_EXTRA_SLIPPAGE_BPS,
    },
    risk: {
      maxPositionSol: e.RISK_MAX_POSITION_SOL,
      maxTotalExposureSol: e.RISK_MAX_TOTAL_EXPOSURE_SOL,
      maxDailyLossSol: e.RISK_MAX_DAILY_LOSS_SOL,
      maxOpenPositions: e.RISK_MAX_OPEN_POSITIONS,
      minSolReserve: e.RISK_MIN_SOL_RESERVE,
      lossCooldownMin: e.RISK_LOSS_COOLDOWN_MIN,
      maxConsecutiveTxFailures: e.RISK_MAX_CONSECUTIVE_TX_FAILURES,
      circuitBreakerPauseMin: e.RISK_CIRCUIT_BREAKER_PAUSE_MIN,
    },
    sutr: {
      enabled: e.SUTR_ENABLED,
      scanIntervalMs: e.SUTR_SCAN_INTERVAL_MS,
      manageIntervalMs: e.SUTR_MANAGE_INTERVAL_MS,
      arbEnabled: e.SUTR_ARB_ENABLED,
      arbSizeSol: e.SUTR_ARB_SIZE_SOL,
      arbMinEdgeBps: e.SUTR_ARB_MIN_EDGE_BPS,
      arbMaxProbes: e.SUTR_ARB_MAX_PROBES,
      minLiquidityUsd: e.SUTR_MIN_LIQUIDITY_USD,
      minVelocity: e.SUTR_MIN_VELOCITY,
      minPoolAgeMin: e.SUTR_MIN_POOL_AGE_MIN,
      lpSimEnabled: e.SUTR_LP_SIM_ENABLED,
      lpScanIntervalMs: e.SUTR_LP_SCAN_INTERVAL_MS,
      lpSizeSol: e.SUTR_LP_SIZE_SOL,
      lpMaxPositions: e.SUTR_LP_MAX_POSITIONS,
      lpMinTvlUsd: e.SUTR_LP_MIN_TVL_USD,
      lpMinFeeApr: e.SUTR_LP_MIN_FEE_APR,
      lpMaxHoldMin: e.SUTR_LP_MAX_HOLD_MIN,
      lpMaxLossPct: e.SUTR_LP_MAX_LOSS_PCT,
      rentReclaimEnabled: e.SUTR_RENT_RECLAIM_ENABLED,
      rentReclaimIntervalMs: e.SUTR_RENT_RECLAIM_INTERVAL_MS,
    },
    rs: {
      enabled: e.RS_ENABLED,
      scanIntervalMs: e.RS_SCAN_INTERVAL_MS,
      manageIntervalMs: e.RS_MANAGE_INTERVAL_MS,
      tradeSizeSol: e.RS_TRADE_SIZE_SOL,
      minLiquidityUsd: e.RS_MIN_LIQUIDITY_USD,
      minMcapUsd: e.RS_MIN_MCAP_USD,
      maxMcapUsd: e.RS_MAX_MCAP_USD,
      minPairAgeHours: e.RS_MIN_PAIR_AGE_HOURS,
      minH24DropPct: e.RS_MIN_H24_DROP_PCT,
      minDrawdownPct: e.RS_MIN_DRAWDOWN_PCT,
      minScore: e.RS_MIN_SCORE,
      maxAnalysesPerScan: e.RS_MAX_ANALYSES_PER_SCAN,
      reevaluateAfterMin: e.RS_REEVALUATE_AFTER_MIN,
      maxWashRatio: e.RS_MAX_WASH_RATIO,
      supportTolerancePct: e.RS_SUPPORT_TOLERANCE_PCT,
      takeProfitPct: e.RS_TAKE_PROFIT_PCT,
      stopLossPct: e.RS_STOP_LOSS_PCT,
      trailingActivationPct: e.RS_TRAILING_ACTIVATION_PCT,
      trailingStopPct: e.RS_TRAILING_STOP_PCT,
      maxHoldMin: e.RS_MAX_HOLD_MIN,
      smartMoneyWallets: e.RS_SMART_MONEY_WALLETS,
      watchlist: e.RS_WATCHLIST,
      minAccumulationUsd: e.RS_MIN_ACCUMULATION_USD,
    },
    logging: { level: e.LOG_LEVEL, format: e.LOG_FORMAT, color: e.LOG_COLOR, dir: e.LOG_DIR },
    stateDir: e.STATE_DIR,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    tickTimeoutMs: e.TICK_TIMEOUT_MS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}

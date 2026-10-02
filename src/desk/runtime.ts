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
import { LaunchFeed } from './launches';
import { LocalPumpStream } from './pump-stream';
import { HoldingsWatch, notifier, walletHoldings, type Holding } from './watch';
import { StrategyAssistant } from './assistant';
import { walletHistory, type WalletHistory } from './wallet-history';
import { selectPair } from './discovery';
import { SOL_MINT } from '../core/types';
import { ALERT_KINDS, DEFAULT_ALERTS, DeskEngine, type AlertKind, type DeskWallet } from './engine';
import { DeskReject } from './guard';
import { XClient } from './social';
import { KNOWN_RUGS, RugList } from './launch-risk';
import { GeminiReviewer, LaunchReviewer, REVIEW, RotatingReviewer, type Reviewer } from './review';
import { XFeed, XFEED } from './xfeed';
import { OpeningTracker } from './opening';
import { GoldenTracker } from './golden-pocket';
import { GOLDEN_RULES, deskCapital, deskOperational, liveSignerSettings, strategyProfiles, type DeskCapital, type DeskOperational, type LiveSignerKind } from './config';
import { localKeySigner } from './local-signer';
import { DeskResearchRecorder } from '../research/integration/desk-recorder';
import { PublicKey } from '@solana/web3.js';
import type { DeskMode } from './types';

/**
 * Provider and risk settings only. This allowlist never reads the private key: LIVE signs through Phantom unless the
 * owner opts in with DESK_LIVE_SIGNER=local-key, in which case localKeySigner reads it separately and only for LIVE.
 * The main engine's simulation/live switch is never touched.
 */
const ENV_KEYS = ['RPC_ENDPOINTS', 'RPC_MAX_RPS', 'RPC_TIMEOUT_MS', 'JUPITER_API_KEY', 'JUPITER_API_BASE', 'JUPITER_MAX_RPS', 'JUPITER_QUOTE_MAX_AGE_MS',
  'MAX_PRIORITY_FEE_LAMPORTS', 'PRIORITY_LEVEL', 'MAX_PRICE_IMPACT_PCT', 'TX_CONFIRM_TIMEOUT_MS', 'RS_TAKE_PROFIT_PCT', 'RS_STOP_LOSS_PCT',
  'RS_TRAILING_ACTIVATION_PCT', 'RS_TRAILING_STOP_PCT', 'RS_MAX_HOLD_MIN', 'RS_MAX_WASH_RATIO',
  'DESK_PLANNED_CAPITAL_USD', 'DESK_BASE_ENTRY_USD', 'DESK_SLIPPAGE_BPS', 'X_BEARER_TOKEN', 'WALLET_PUBLIC_KEY',
  'CRASH_ENABLED', 'CRASH_CAPITAL_USD', 'CRASH_ENTRY_USD', 'CRASH_SLIPPAGE_BPS', 'CRASH_EXIT_SLIPPAGE_BPS', 'CRASH_MAX_DRAG_BPS', 'CRASH_MAX_POSITIONS',
  'CRASH_TAKE_PROFIT_PCT', 'CRASH_LOCK_PEAK_PCT', 'CRASH_GIVEBACK_PTS', 'CRASH_STOP_LOSS_PCT', 'CRASH_MAX_HOLD_MIN',
  'CRASH_EXIT_MODE', 'CRASH_TRAIL_ACTIVATION_PCT', 'CRASH_TRAIL_STOP_PCT', 'CRASH_RIDE_MAX_HOLD_MIN', 'CRASH_REENTRY_MIN',
  'DESK_LIVE_SIGNER', 'DESK_LIVE_MAX_ENTRIES', 'DESK_DEPLOYMENT_MODE', 'DESK_PAPER_FAIR_ENABLED', 'DESK_PAPER_CRASH_ENABLED',
  'DESK_LIVE_FAIR_ENABLED', 'DESK_LIVE_CRASH_ENABLED', 'DESK_FAIR_LOSS_REENTRY_MIN', 'DESK_CRASH_LOSS_REENTRY_MIN',
  'DESK_FAIR_FRESH_SIGNAL', 'DESK_CRASH_FRESH_SIGNAL', 'DESK_NTFY_TOPIC', 'DESK_NTFY_SERVER', 'DESK_TELEGRAM_BOT_TOKEN', 'DESK_TELEGRAM_CHAT_ID', 'ANTHROPIC_API_KEY',
  'DESK_X_QUERY', 'DESK_AI_REVIEW', 'DESK_AI_REVIEWS_PER_HOUR', 'OPEN_CAPITAL_USD', 'OPEN_ADD_AT', 'GOLDEN_CAPITAL_USD', 'GOLDEN_RETEST_ENTRIES', 'BIRDEYE_API_KEY', 'DESK_ALERTS',
  'DESK_RESEARCH', 'DESK_ALERT_EVIDENCE', 'DESK_PUMP_STREAM', 'RESEARCH_FEED_PORT', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
/** DESK_ALERTS: a comma list of golden, rug, open, launch, radar (or "all", or "none"); unknown names are ignored, empty means the default (none). */
export function alertKinds(raw: string | undefined): ReadonlySet<AlertKind> {
  const names = (raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (names.includes('all')) return new Set(ALERT_KINDS);
  const kinds = names.filter((n): n is AlertKind => (ALERT_KINDS as readonly string[]).includes(n));
  return kinds.length ? new Set(kinds) : DEFAULT_ALERTS;
}
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

export interface DeskHandle {
  engines: Record<DeskMode, DeskEngine>; capital: DeskCapital; close: () => Promise<void>;
  operational?: DeskOperational;
  /** PHANTOM: every LIVE order is approved in the browser. LOCAL_KEY: signed by WALLET_PRIVATE_KEY, no browser needed. */
  liveSigner?: LiveSignerKind;
  /** Exit rules and alerts for tokens held outside the desk's strategies. */
  watch?: HoldingsWatch;
  /** Strategy assistant (Claude); null without ANTHROPIC_API_KEY in .env. */
  assistant?: StrategyAssistant | null;
  /** A wallet's recent swaps, for the assistant. */
  walletHistory?: (wallet: string) => Promise<WalletHistory>;
  /** What a wallet holds now (e.g. the FOMO wallet), to put tokens under Watch. */
  holdings?: (wallet: string) => Promise<Holding[]>;
}
export interface DeskContext { wallet: (mode: DeskMode) => DeskWallet | null; authorized: () => boolean }

/** UI-independent desk: the dashboard and the headless runner build the same engines. */
export async function createDesk(o: { envDir: string; dataDir: string }, context: DeskContext): Promise<DeskHandle> {
  const env = await deskEnvironment(o.envDir);
  if (!env.RPC_ENDPOINTS) throw new DeskReject('RPC_NOT_CONFIGURED');
  if (!env.JUPITER_API_KEY) throw new DeskReject('JUPITER_API_KEY_REQUIRED');
  const cfg = loadConfig(env, 'PHANTOM'), capital = deskCapital(env), strategies = strategyProfiles(env, capital, cfg.rs), operational = deskOperational(env), logger = new Logger('Desk');
  const live = liveSignerSettings(env);
  // Opt-in only: the key is read here, for the LIVE engine, and never enters the environment or the TEST engine.
  const localSigner = live.signer === 'LOCAL_KEY' ? await localKeySigner(o.envDir) : null;
  const rpc = new ConnectionManager(cfg.rpc.endpoints, { ...cfg.rpc, logger });
  if (await rpc.execute('desk:genesis', c => c.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new DeskReject('MAINNET_REQUIRED');
  const data = new DataRuntime(logger, cfg.data);
  await fs.mkdir(o.dataDir, { recursive: true });
  const lockPath = path.join(o.dataDir, 'desk.lock');
  const lock = await acquireProcessLock(lockPath).catch(() => { throw new DeskReject('INSTANCE_LOCK'); });
  let research: DeskResearchRecorder | null = null;
  try {
    const shared = { cfg, capital, logger, rpc, jupiter: new JupiterClient(cfg.jupiter, logger, data), dex: new DexScreenerClient(logger, data),
      gecko: new GeckoTerminalClient(logger, data), safety: new TokenSafetyChecker(rpc, logger), x: new XClient(env.X_BEARER_TOKEN ?? null),
      dir: o.dataDir, authorized: context.authorized, strategies, operational };
    let configured: PublicKey | null = null;
    try { configured = env.WALLET_PUBLIC_KEY ? new PublicKey(env.WALLET_PUBLIC_KEY.trim()) : null; } catch { configured = null; }
    // TEST only ever gets an address (never a signer).
    const paperAddress = configured ?? localSigner?.publicKey ?? null;
    // One radar for both modes (only the running one polls), and one set of phone alerts for the desk and the watch.
    // Launch radar: rug list (persisted; seeded with known rugs), Claude review of shortlisted launches (opt-out with
    // DESK_AI_REVIEW=off), and the X feed when an X API token is set.
    const rugs = await RugList.open(path.join(o.dataDir, 'rugs.json'), KNOWN_RUGS);
    const reviewsPerHour = Math.max(0, Math.min(120, Number(env.DESK_AI_REVIEWS_PER_HOUR ?? '') || REVIEW.maxPerHour));
    // Claude first; Gemini (GEMINI_API_KEY) takes over while Claude has no credits or rejects the key.
    const reviewers: Reviewer[] = env.DESK_AI_REVIEW?.trim().toLowerCase() === 'off' || reviewsPerHour <= 0 ? [] : [
      ...(env.ANTHROPIC_API_KEY?.trim() ? [new LaunchReviewer(env.ANTHROPIC_API_KEY.trim(), undefined, reviewsPerHour)] : []),
      ...(env.GEMINI_API_KEY?.trim() ? [new GeminiReviewer(env.GEMINI_API_KEY.trim(), env.GEMINI_MODEL?.trim() || undefined, fetch, reviewsPerHour)] : []),
    ];
    const reviewer: Reviewer | null = reviewers.length > 1 ? new RotatingReviewer(reviewers) : reviewers[0] ?? null;
    const xfeed = new XFeed(env.X_BEARER_TOKEN?.trim() || null, fetch, env.DESK_X_QUERY?.trim() || XFEED.query);
    // Opening screen: every launch's curve market cap from its first seconds (the owner's basic screen, OPEN strategy).
    const opening = new OpeningTracker(rpc);
    // GOLDEN POCKET: every fresh graduation's PumpSwap pool, its reserves read on chain every few seconds.
    const golden = new GoldenTracker(rpc, GOLDEN_RULES);
    // Launches and graduations from the research observer's live stream on this machine, when it runs (no RPC);
    // otherwise the radar and the graduation feed poll the RPC as before.
    const pumpStream = env.DESK_PUMP_STREAM?.trim().toLowerCase() === 'off' ? null : new LocalPumpStream(`http://127.0.0.1:${Number(env.RESEARCH_FEED_PORT) || 3101}/pump/events`);
    pumpStream?.start();
    const alerts = notifier(env), launches = new LaunchFeed(rpc, fetch, undefined, undefined,
      { rugs, review: reviewer ? (i, now) => reviewer.review(i, now) : null, reviewAvailable: reviewer ? now => reviewer.available(now) : undefined,
        onDecoded: (events, now) => opening.observe(events, now), stream: pumpStream });
    // Research record (src/research): every alert as an immutable evidence snapshot, and the signal tape, as events in
    // data-desk/research-store. DESK_RESEARCH=off turns it off, =full also records the tape live (large; the tape file
    // already holds it for import). DESK_ALERT_EVIDENCE=off keeps the phone text as before.
    // If the store cannot be opened, the desk runs without it.
    research = env.DESK_RESEARCH?.trim().toLowerCase() === 'off' ? null
      : await DeskResearchRecorder.open(path.join(o.dataDir, 'research-store'), { enrichMessages: env.DESK_ALERT_EVIDENCE?.trim().toLowerCase() !== 'off',
        recordTape: env.DESK_RESEARCH?.trim().toLowerCase() === 'full' })
        .catch((error: unknown) => { logger.warn('Research recorder unavailable; the desk runs without it', { error: error instanceof Error ? error.message : String(error) }); return null; });
    const recorder = research, researchDeps = { research: recorder, deliver: alerts.deliver, alertChannels: alerts.channels };
    // Which alerts reach the phone: none by default; DESK_ALERTS=rug, golden, open, launch, radar — or "all".
    const phoneAlerts = alertKinds(env.DESK_ALERTS);
    const sender = new TransactionSender(rpc, logger, { confirmTimeoutMs: cfg.execution.confirmTimeoutMs, pollIntervalMs: 1500, rebroadcastIntervalMs: 2000 });
    const engines = {
      // TEST needs only an address to build and simulate; without Phantom it uses the public key from .env, never a secret.
      PAPER: await DeskEngine.create({ ...shared, ...researchDeps, launches, xfeed, opening, golden, pumpStream, aiReview: reviewer ? () => reviewer.status() : null, notify: alerts.notify, alerts: phoneAlerts, mode: 'PAPER', sender: null,
        wallet: () => context.wallet('PAPER') ?? (paperAddress ? { owner: paperAddress, signer: null } : null) }),
      // LOCAL_KEY: signed in this process and independent of the browser session; PHANTOM: the browser session signs.
      LIVE: await DeskEngine.create({ ...shared, ...researchDeps, launches, xfeed, opening, golden, pumpStream, aiReview: reviewer ? () => reviewer.status() : null, notify: alerts.notify, alerts: phoneAlerts, mode: 'LIVE', sender, signerKind: live.signer, liveMaxEntries: live.maxEntries,
        ...(localSigner ? { authorized: () => true, wallet: () => ({ owner: localSigner.publicKey, signer: localSigner }) }
          : { wallet: () => context.wallet('LIVE') }) }),
    };
    // A desk health record every minute: "was it scanning at 03:12?" is answered from the research store.
    const heartbeat = recorder ? setInterval(() => recorder.heartbeat({ modes: Object.fromEntries((['PAPER', 'LIVE'] as const).map(m => [m,
      { scanner: engines[m].scanner, execution: engines[m].execution, lastScanAt: engines[m].lastScanAt, message: engines[m].message }])) }), 60_000) : null;
    heartbeat?.unref?.();
    const watch = await HoldingsWatch.open({ file: path.join(o.dataDir, 'watch.json'), dex: shared.dex, notify: alerts.notify, channels: alerts.channels,
      balance: async (owner, mint) => {
        const accounts = await rpc.execute('watch:balance', c => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed'));
        let raw = 0n, decimals: number | null = null;
        for (const a of accounts.value) { const t = (a.account.data.parsed.info as { tokenAmount: { amount: string; decimals: number } }).tokenAmount; raw += BigInt(t.amount); decimals = t.decimals; }
        return { raw, decimals };
      },
      // Selling needs the local key: a Phantom session cannot be relied on to be open when a floor breaks.
      sell: localSigner ? s => engines.LIVE.sellHolding(s) : null, sellWallet: localSigner?.publicKey.toBase58() ?? null });
    const assistant = env.ANTHROPIC_API_KEY?.trim() ? new StrategyAssistant(env.ANTHROPIC_API_KEY.trim()) : null;
    const history = async (wallet: string) => {
      const sol = selectPair(await shared.dex.getPairsForTokens([SOL_MINT]), SOL_MINT, Date.now())?.priceUsd;
      if (!sol) throw new DeskReject('SOL_PRICE_UNAVAILABLE');
      return walletHistory({ wallet, solUsd: sol, rpc, dex: shared.dex });
    };
    return { engines, capital, operational, liveSigner: live.signer, watch, assistant, walletHistory: history,
      holdings: wallet => walletHoldings({ wallet, rpc, dex: shared.dex }), close: async () => {
      await watch.settled();
      for (const e of Object.values(engines)) { e.stop('shutdown'); await e.settled(); await e.persist(); }
      if (heartbeat) clearInterval(heartbeat);
      await recorder?.close().catch(() => undefined);
      await data.flush(); await lock.close(); await fs.unlink(lockPath);
    } };
  } catch (error) { await research?.close().catch(() => undefined); await lock.close(); await fs.unlink(lockPath); throw error; }
}

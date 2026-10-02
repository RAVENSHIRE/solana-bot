import fs from 'node:fs/promises';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { AppConfig } from '../config/config';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { DexPair, DexScreenerClient } from '../data/dexscreener';
import type { GeckoTerminalClient } from '../data/geckoterminal';
import type { TokenSafetyChecker } from '../analysis/token-safety';
import type { JupiterClient } from '../execution/jupiter-client';
import { LiveExecutor } from '../execution/live-executor';
import type { TransactionSender } from '../execution/tx-sender';
import { SwapError } from '../execution/executor';
import { SigningError, type TransactionSigner } from '../execution/transaction-signer';
import { requestScope } from '../data/core/request-scope';
import { exactNumber } from '../data/core/data-validator';
import { BASE_FEE_LAMPORTS, SOL_MINT, TOKEN_ACCOUNT_RENT_LAMPORTS } from '../core/types';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { atomicWriteFile } from '../utils/fs';
import { DESK, GOLDEN_EXIT, LAUNCH_ENTRY, STRATEGY_IDS, strategyProfiles, type BuiltinStrategyId, type DeskCapital, type DeskOperational, type LiveSignerKind, type StrategyProfile } from './config';
import { EventLog } from './events';
import { DeskLedger, uiAmount, type LedgerState } from './ledger';
import { discover, pairMetrics, selectPair, tierFor, tokenTimes, type Discovered } from './discovery';
import { creatorHolding, gatherOnchain, holderCount, holders as readHolders, type Holders, type OnchainEvidence } from './onchain';
import { launchCheck, type LaunchCheck } from './launch';
import { GraduationFeed, type Graduation } from './migrations';
import { reclaimRent } from './rent';
import { assessAuthenticity, checkWebsite, parseXLink, type WebsiteCheck, type XClient } from './social';
import { analyze, type SocialEvidence, type WatchState } from './analysis';
import { DeskGuard, DeskReject, PaperExecution, paperSigner } from './guard';
import { crashCheck, crashMarketHint, goldenEntryCheck, launchEntryCheck, openEntryCheck, exitReason, exitRuleText, scaleAdvice, strategyStats } from './strategies';
import type { Candidate, DeskEvent, DeskMode, DeskPosition, DeskStatus, Preflight, Stage, StrategyId, StrategyView, Tier } from './types';
import type { Launch, LaunchSource } from './launches';
import type { XFeed } from './xfeed';
import { OPENING, type OpeningState, type OpeningTracker } from './opening';
import { GOLDEN, PUMP_QUOTE_MINT, WSOL_MINT, type GoldenSignal, type GoldenTracker } from './golden-pocket';

import { curveState, insiderExit, insiderHolding, RISK } from './launch-risk';
import { fomoUrl } from './watch';
import { PRESETS, loadRuleSpecs, removeRuleSpec, ruleCheck, ruleMarketHint, ruleProfile, saveRuleSpec, type RuleSpec } from './custom';

/** An older same-name token counts as the original only within this gap, unless it is still the busier market. */
const COPYCAT_MAX_GAP_MS = 3 * 24 * 60 * 60_000;

export interface DeskWallet { owner: PublicKey; signer: TransactionSigner | null }
export interface DeskDeps {
  mode: DeskMode; dir: string; cfg: AppConfig; capital: DeskCapital; logger: Logger;
  rpc: ConnectionManager; jupiter: JupiterClient; dex: DexScreenerClient; gecko: GeckoTerminalClient; safety: TokenSafetyChecker; x: XClient;
  /** LIVE requires a Phantom signer; TEST only needs the connected address to build and simulate. */
  wallet: () => DeskWallet | null;
  /** LIVE: the browser session is connected and alive. */
  authorized: () => boolean;
  sender: TransactionSender | null;
  website?: (url: string | null) => Promise<WebsiteCheck>;
  /** Strategy settings; defaults to strategyProfiles() of the desk capital and RS_* rules. */
  strategies?: Record<BuiltinStrategyId, StrategyProfile>;
  operational?: DeskOperational;
  /** Launch radar (new pump.fun launches from the chain); absent: no LAUNCH entries. */
  launches?: LaunchSource | null;
  /** X feed (X API search for posts naming a token); off without X_BEARER_TOKEN. */
  xfeed?: XFeed | null;
  /** Opening screen: every launch's curve market cap from its first seconds; absent: no OPEN entries or alerts. */
  opening?: OpeningTracker | null;
  /** GOLDEN POCKET: every fresh graduation's PumpSwap pool (reserves read on chain), run through the pattern. */
  golden?: GoldenTracker | null;
  /** Claude review of shortlisted launches: its status line; absent when off. */
  aiReview?: (() => string) | null;
  /** Phone/desktop alerts (ntfy, Telegram) for launch-radar finds and entry-ready signals. */
  notify?: (title: string, body: string) => Promise<void>;
  /**
   * Radar news on the phone too (a launch shortlisted, a radar rug, an impersonator). Off by default: on 1–2 Oct, 63 of
   * 68 shortlist alerts were dead launches the desk never bought. Buy signals and held-position rugs are always sent.
   */
  alertRadar?: boolean;
  /** LIVE: who signs (default PHANTOM) and how many new entries one LIVE session may open. */
  signerKind?: LiveSignerKind;
  liveMaxEntries?: number;
}

interface Deep { at: number; onchain: OnchainEvidence; social: SocialEvidence }
interface Staged { found: Discovered; pair: DexPair; tier: Tier; metrics: ReturnType<typeof pairMetrics>; crashHint: boolean; ruleHints: StrategyId[]; launch: Launch | null;
  open?: OpeningSignal | null; golden?: GoldenEntrySignal | null }
/** A GOLDEN POCKET fill, with the radar's view of the launch when it has one. */
interface GoldenEntrySignal { s: GoldenSignal; launch: Launch | null; at: number }
/** An opening-screen breakout, with the radar's view of the launch (rug signs, insiders) when it has one. */
interface OpeningSignal { state: OpeningState; launch: Launch | null; at: number }
interface ExecTarget {
  strategy: StrategyId; mint: string; symbol: string | null; decimals: number; pairAddress: string; heldRaw: bigint; token2022?: boolean; drill?: boolean;
  /** A scale-in to the open position, of this size. */
  add?: boolean; addUsd?: number;
  entry?: { liquidityUsd: number | null; creator: string | null; creatorPct: number | null; insiders?: string[] | null; insiderPct?: number | null; onCurve?: boolean | null;
    stopUsd?: number | null; targetUsd?: number | null };
}
const LABEL: Record<DeskMode, string> = { PAPER: 'TEST / PAPER — NO REAL TRANSACTIONS', LIVE: 'LIVE — REAL FUNDS' };
const sol = (l: bigint) => exactNumber(l < 0n ? -l : l) / 1e9 * (l < 0n ? -1 : 1);

export class DeskEngine {
  scanner = false;
  execution = false;
  /** TEST only: allow FAIR drill entries when nothing qualifies. */
  drill = false;
  /** Optional cap on new entries for this session (e.g. a first real-funds test); null = unlimited. Exits are never capped. */
  entryAllowance: number | null = null;
  /** Both strategies run in parallel, each with its own ledger (and TEST sleeve). */
  /** FAIR and CRASH always; custom rule strategies are added from strategies.json and the dashboard. */
  readonly strategies: Record<BuiltinStrategyId, StrategyProfile> & Partial<Record<StrategyId, StrategyProfile>>;
  private drillSkips = new Map<string, number>();
  /** `${strategy}:${mint}` → when and why the guard last blocked an entry; skipped for DESK.entrySkipMs. */
  private entrySkips = new Map<string, { at: number; code: string }>();
  /** Shortlisted launches (radar score ≥ LAUNCH_ENTRY.minScore) by mint, and which alerts were already sent. */
  private launchList = new Map<string, Launch>();
  /** The CA status last reported for each shortlisted launch (X / WEBSITE confirmed, IMPERSONATOR). */
  private launchCa = new Map<string, Launch['ca']['status']>();
  /** Radar launches named like a bigger, older token, and the cached name searches behind that. */
  private launchCopycats = new Map<string, string>();
  /** Opening-screen breakouts (alerted, entered by OPEN when it is on). */
  private openSignals = new Map<string, OpeningSignal>();
  private openingWork: Promise<void> | null = null;
  private lastOpeningAt = 0;
  /** GOLDEN POCKET fills (alerted, entered by GOLDEN when it is on), the fast loop, and the PUMP price for PUMP-quoted pools. */
  private goldenSignals = new Map<string, GoldenEntrySignal>();
  private goldenWork: Promise<void> | null = null;
  private lastGoldenAt = 0;
  private lastGraduationsAt = 0;
  private graduationPoll: Promise<Graduation[]> | null = null;
  private pumpUsd: { value: number; at: number } | null = null;
  private copycatSearches = new Map<string, { at: number; pairs: DexPair[] }>();
  private launchAlerts = new Set<string>();
  private launchPoll: Promise<void> | null = null;
  /** Every priced token seen, by lower-case ticker and name: the original a copycat imitates is usually among them. */
  private names = new Map<string, Map<string, { mint: string; symbol: string | null; marketCapUsd: number; createdAt: number | null; volume1hUsd?: number | null; at: number }>>();
  /** `${strategy}:${mint}` → why this scan did not enter a token (shown on the candidate). */
  private entryNotes = new Map<string, string>();
  /** TEST: sleeves that ran dry and were re-funded; their trades still count in the strategy stats. */
  private cycles = new Map<StrategyId, LedgerState[]>();
  private currentScanAt = 0;
  private readonly graduations: GraduationFeed;
  private lastCompletedScanAt = 0;
  private notes = new Map<string, string>();
  private creatorChecks = new Map<string, number>();
  private insiderChecks = new Map<string, number>();
  private holdLog = new Map<string, { pct: number; at: number }>();
  /** Per mint: when an unroutable position was last quoted, and when a valuation failure was last logged. */
  private noRouteChecks = new Map<string, number>();
  private valuationLog = new Map<string, number>();
  private lastPositionCheckAt: Record<StrategyId, number> = {};
  /** Mints the owner asked to sell now (EXIT NOW); kept until the position is gone, so a failed sell is retried. */
  private manualExits = new Set<string>();
  /** Holder snapshots from the light holder pass (and deep analyses), newest wins in assess(). */
  private holderInfo = new Map<string, Holders>();
  /** Set when the RPC has no DAS getTokenAccounts: holder counts are then not requested again. */
  private holderCountUnsupported: string | null = null;
  /** LIVE with the local key: empty token accounts left by earlier desk trades are closed once per session. */
  private rentSwept = false;
  /** Position checks run beside the discovery scan, so a slow scan never delays an exit. */
  private positionWork: Promise<void> | null = null;
  /** One order at a time across both strategies (paper cash, wallet balance and Phantom requests stay consistent). */
  private orders: Promise<unknown> = Promise.resolve();
  /** The latest fast position check including its save, so settled() covers it. */
  private background: Promise<unknown> = Promise.resolve();
  private settingsWrite: Promise<void> = Promise.resolve();
  private idleSync: Promise<void> | null = null;
  private lastIdleSyncAt = 0;
  message: string | null = null;
  lastScanAt: number | null = null;
  nextScanAt: number | null = null;
  readonly events: EventLog;
  private ledgers = new Map<string, DeskLedger>();
  private candidates = new Map<string, Candidate>();
  private watch = new Map<string, WatchState>();
  private deep = new Map<string, Deep>();
  /** Launch history never changes: cached per token; failures are retried after ten minutes. */
  private launches = new Map<string, { at: number; value: LaunchCheck | null }>();
  private lastState = new Map<string, string>();
  private preflights: Preflight[] = [];
  /** CRASH signal tape: every scan's market snapshot of pumping young pools, appended to tape-<MODE>.jsonl for replay. */
  private tape: Array<Record<string, unknown>> = [];
  private sources: Record<string, string> = {};
  private work: Promise<void> | null = null;
  private generation = 0;
  private solUsd: number | null = null;
  private walletView: { owner: string; native: bigint; at: number } | null = null;
  private preparedOwner: string | null = null;

  private constructor(private readonly d: DeskDeps) {
    this.events = new EventLog(d.mode, path.join(d.dir, `events-${d.mode}.json`));
    this.graduations = new GraduationFeed(d.rpc);
    const base = d.strategies ?? strategyProfiles({}, d.capital, d.cfg.rs);
    const copy = (p: StrategyProfile): StrategyProfile => ({ ...p, exits: { ...p.exits } });
    this.strategies = { FAIR: copy(base.FAIR), CRASH: copy(base.CRASH), LAUNCH: copy(base.LAUNCH), OPEN: copy(base.OPEN), GOLDEN: copy(base.GOLDEN) };
    // LIVE starts the fast strategies OFF: the owner switches them on after TEST has shown how they trade.
    for (const id of STRATEGY_IDS) this.strategies[id].enabled = d.operational?.strategyEnabled[d.mode][id] ?? (d.mode === 'LIVE' && id !== 'FAIR' ? false : this.strategies[id].enabled);
  }

  static async create(d: DeskDeps): Promise<DeskEngine> {
    const engine = new DeskEngine(d);
    await engine.events.load();
    const custom = await loadRuleSpecs(d.dir);
    for (const spec of custom.specs) engine.strategies[spec.id] = ruleProfile(spec, d.mode === 'PAPER');
    for (const error of custom.errors) engine.event('FAILED', `Custom strategy not loaded: ${error}`);
    if (d.operational?.deploymentMode !== 'LOCKED') await engine.loadSettings();
    if (d.mode === 'PAPER') for (const id of engine.ids()) { await engine.ledgerFor(id, null); await engine.loadCycles(id); }
    return engine;
  }

  get mode(): DeskMode { return this.d.mode; }
  /** Built-in strategies first, then custom ones in the order they were added. */
  ids(): StrategyId[] { return Object.keys(this.strategies); }
  private profile(id: StrategyId): StrategyProfile {
    const p = this.strategies[id];
    if (!p) throw new DeskReject('INVALID_STRATEGY');
    return p;
  }
  private customIds(): StrategyId[] { return this.ids().filter(id => this.strategies[id]?.rule); }
  get busy(): boolean { return this.work !== null; }

  /** FAIR keeps the original ledger names; CRASH writes ledger-PAPER-CRASH.json / ledger-LIVE-CRASH-<wallet>.json. */
  private ledgerKey(id: StrategyId, owner: string | null): string {
    const tag = id === 'FAIR' ? '' : `-${id}`;
    return this.d.mode === 'PAPER' ? `PAPER${tag}` : `LIVE${tag}-${owner}`;
  }
  private async ledgerFor(id: StrategyId, owner: string | null): Promise<DeskLedger> {
    const key = this.ledgerKey(id, owner);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      if (this.d.mode === 'LIVE' && !owner) throw new DeskReject('WALLET_REQUIRED');
      ledger = await DeskLedger.open(path.join(this.d.dir, `ledger-${key}.json`), this.d.mode, owner, Date.now());
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }
  private ledgerOf(id: StrategyId): DeskLedger | null {
    if (this.d.mode === 'PAPER') return this.ledgers.get(this.ledgerKey(id, null)) ?? null;
    return this.walletView ? this.ledgers.get(this.ledgerKey(id, this.walletView.owner)) ?? null : null;
  }
  private books(): Array<{ id: StrategyId; p: StrategyProfile; ledger: DeskLedger }> {
    return this.ids().flatMap(id => { const ledger = this.ledgerOf(id); return ledger ? [{ id, p: this.profile(id), ledger }] : []; });
  }
  /** A token is held by at most one strategy at a time. */
  private heldBy(mint: string): StrategyId | null { return this.books().find(b => b.ledger.position(mint))?.id ?? null; }

  private event(stage: Stage, message: string, c: { mint?: string | null; symbol?: string | null; detail?: DeskEvent['detail'] } = {}): void {
    this.events.add(stage, message, c);
  }
  /** Repeated identical status lines (e.g. "slots full") are logged once until they change. */
  private note(key: string, stage: Stage, message: string): void {
    if (this.notes.get(key) === message) return;
    this.notes.set(key, message);
    this.event(stage, message);
  }
  private stopper(): () => boolean {
    const generation = this.generation;
    return () => !this.scanner || generation !== this.generation || (this.d.mode === 'LIVE' && !this.d.authorized());
  }

  // ------------------------------------------------------------------ controls

  start(): void {
    if (this.d.mode === 'LIVE' && !this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    if (this.d.mode === 'LIVE' && (!this.preparedOwner || this.d.wallet()?.owner.toBase58() !== this.preparedOwner)) throw new DeskReject('LIVE_RECONCILIATION_REQUIRED');
    if (this.books().some(b => b.ledger.state.halted || b.ledger.state.pending)) throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED');
    this.scanner = true; this.execution = true; this.generation++; this.nextScanAt = Date.now(); this.notes.clear();
    // Each LIVE session may open a limited number of new positions; exits are never capped.
    if (this.d.mode === 'LIVE') { this.entryAllowance = this.d.liveMaxEntries ?? null; this.rentSwept = false; }
    const on = this.ids().filter(id => this.profile(id).enabled).join(' + ') || 'none';
    this.event('SYSTEM', this.d.mode === 'PAPER' ? `TEST started: scanner ON, paper execution ENABLED (strategies: ${on}) — no signature will ever be requested`
      : `LIVE session started: scanner ON, execution ENABLED (strategies: ${on}) — ` + (this.localKey
        ? `orders are signed automatically by the local key; at most ${this.entryAllowance ?? 'unlimited'} new entries this session`
        : 'every order needs a Phantom signature'));
  }
  /** Fail closed on unresolved orders or a mismatch between tracked LIVE positions and actual token holdings. */
  async prepareStart(): Promise<void> {
    if (this.d.mode !== 'LIVE') return;
    this.preparedOwner = null;
    if (!this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    const wallet = this.d.wallet();
    if (!wallet) throw new DeskReject('WALLET_REQUIRED');
    const owner = wallet.owner.toBase58();
    for (const id of this.ids()) await this.ledgerFor(id, owner);
    const native = await this.d.rpc.execute('desk:wallet-sync', c => c.getBalance(wallet.owner, 'confirmed'));
    this.walletView = { owner, native: BigInt(native), at: Date.now() };
    if (this.books().some(b => b.ledger.state.halted || b.ledger.state.pending)) throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED');
    const held = new Map<string, bigint>();
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const accounts = await this.d.rpc.execute('desk:holdings', c => c.getParsedTokenAccountsByOwner(wallet.owner, { programId }, 'confirmed'));
      for (const a of accounts.value) {
        const info = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        held.set(info.mint, (held.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
    }
    for (const b of this.books()) for (const p of b.ledger.state.positions)
      if ((held.get(p.mint) ?? 0n) !== BigInt(p.qtyRaw)) throw new DeskReject('LIVE_HOLDINGS_MISMATCH');
    this.preparedOwner = owner;
  }
  private get localKey(): boolean { return this.d.mode === 'LIVE' && this.d.signerKind === 'LOCAL_KEY'; }
  stop(reason = 'stopped by user'): void {
    if (!this.scanner && !this.execution) return;
    this.scanner = false; this.execution = false; this.generation++; this.nextScanAt = null;
    this.event('SYSTEM', `${this.d.mode === 'PAPER' ? 'TEST' : 'LIVE session'} stopped (${reason}); telemetry and ledgers kept`);
  }
  /** Pausing stops new entries only: exits reduce risk, so open positions keep their stop loss, take profit and time stop. */
  pause(): void { if (this.execution) { this.execution = false; this.event('SYSTEM', 'Entries PAUSED: no new positions; exits of open positions keep running'); } }
  resume(): void {
    if (!this.scanner) throw new DeskReject('SCANNER_OFF');
    if (this.d.mode === 'LIVE' && !this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    if (this.books().some(b => b.ledger.state.halted || b.ledger.state.pending)) throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED');
    if (!this.execution) { this.execution = true; this.event('SYSTEM', 'Entries RESUMED'); }
  }
  /** Disabling a strategy stops its new entries; its open positions keep their exits. The choice survives restarts. */
  setStrategy(id: StrategyId, enabled: boolean): void {
    const p = this.profile(id);
    if (p.enabled === enabled) return;
    p.enabled = enabled;
    this.event('SYSTEM', `${p.label} strategy ${enabled ? 'ENABLED' : 'DISABLED — no new entries; open positions keep their exits'}`, { detail: { strategy: id } });
    this.settingsWrite = this.settingsWrite.then(() => this.saveSettings());
  }
  /**
   * Adds or replaces a custom rule strategy (saved in strategies.json for both modes). A new strategy starts ON in TEST
   * and OFF in LIVE; an edit keeps its switch, and new exit rules apply to its open positions at once.
   */
  async defineStrategy(spec: RuleSpec): Promise<void> {
    if ((STRATEGY_IDS as readonly string[]).includes(spec.id)) throw new DeskReject('BUILTIN_STRATEGY');
    const old = this.strategies[spec.id];
    if (old && !old.rule) throw new DeskReject('BUILTIN_STRATEGY');
    this.strategies[spec.id] = ruleProfile(spec, old?.enabled ?? this.d.mode === 'PAPER');
    await saveRuleSpec(this.d.dir, spec);
    if (this.d.mode === 'PAPER') { await this.ledgerFor(spec.id, null); if (!old) await this.loadCycles(spec.id); }
    else if (this.walletView) await this.ledgerFor(spec.id, this.walletView.owner);
    this.event('SYSTEM', old ? `${spec.label} strategy updated; open positions use the new exit rules`
      : `${spec.label} strategy added: ${this.profile(spec.id).enabled ? 'ON' : 'OFF'} in ${this.d.mode === 'PAPER' ? 'TEST' : 'LIVE'}`, { detail: { strategy: spec.id } });
    this.settingsWrite = this.settingsWrite.then(() => this.saveSettings());
  }
  /** Open positions of a strategy in this mode's ledger. */
  strategyPositions(id: StrategyId): number { return this.ledgerOf(id)?.state.positions.length ?? 0; }
  /** Removes a custom strategy without open positions; its ledger stays on disk. */
  async removeStrategy(id: StrategyId): Promise<void> {
    const p = this.strategies[id];
    if (!p) return;
    if (!p.rule) throw new DeskReject('BUILTIN_STRATEGY');
    if (this.strategyPositions(id)) throw new DeskReject('STRATEGY_HAS_POSITIONS');
    delete this.strategies[id];
    await removeRuleSpec(this.d.dir, id);
    this.event('SYSTEM', `${p.label} strategy removed; its ledger stays on disk`, { detail: { strategy: id } });
    this.settingsWrite = this.settingsWrite.then(() => this.saveSettings());
  }
  /**
   * EXIT NOW: sells the whole position through the normal SELL path (same guard, exit slippage and signer). While the
   * desk runs, the position loop sells on its next tick and retries until the position is gone; with the desk stopped,
   * one attempt runs now and the button can be pressed again.
   */
  requestExit(mint: string): void {
    const id = this.heldBy(mint), ledger = id ? this.ledgerOf(id) : null, p = ledger?.position(mint);
    if (!id || !ledger || !p) throw new DeskReject('POSITION_NOT_FOUND');
    if (this.d.mode === 'LIVE' && !this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    if (ledger.state.halted || ledger.state.pending) throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED');
    if (this.manualExits.has(mint)) return;
    this.manualExits.add(mint);
    this.event('EXIT', `${id} · EXIT NOW requested from the dashboard: selling the whole position`, { mint, symbol: p.symbol, detail: { strategy: id } });
    if (this.scanner) { this.lastPositionCheckAt[id] = 0; return; }
    const stopped = () => this.d.mode === 'LIVE' && !this.d.authorized();
    this.background = this.background
      .then(() => this.checkPositions([id], stopped, true))
      .catch(error => this.event('FAILED', `EXIT NOW failed: ${errorMessage(error)}`))
      .finally(() => this.manualExits.delete(mint))
      .then(() => this.persist()).catch(error => this.event('FAILED', `Saving desk state failed: ${errorMessage(error)}`));
  }
  /** TEST only; survives restarts. */
  setDrill(on: boolean): void {
    if (this.d.mode !== 'PAPER') throw new DeskReject('DRILL_TEST_ONLY');
    if (this.drill === on) return;
    this.drill = on;
    this.event('SYSTEM', `TEST drill ${on ? 'ON: paper entries may bypass strategy gates (safety gates and guard still apply)' : 'OFF'}`);
    this.settingsWrite = this.settingsWrite.then(() => this.saveSettings());
  }

  /** Toggles made in the dashboard are stored per mode, so a restart never silently changes what the desk trades. */
  private settingsFile(): string { return path.join(this.d.dir, `settings-${this.d.mode}.json`); }
  private async loadSettings(): Promise<void> {
    let saved: { strategies?: Partial<Record<StrategyId, unknown>>; drill?: unknown };
    try { saved = JSON.parse(await fs.readFile(this.settingsFile(), 'utf8')); } catch { return; }
    for (const id of this.ids()) if (typeof saved.strategies?.[id] === 'boolean') this.profile(id).enabled = saved.strategies[id] as boolean;
    if (this.d.mode === 'PAPER' && typeof saved.drill === 'boolean') this.drill = saved.drill;
  }
  private async saveSettings(): Promise<void> {
    const body = { strategies: Object.fromEntries(this.ids().map(id => [id, this.profile(id).enabled])), drill: this.drill, updatedAt: new Date().toISOString() };
    await atomicWriteFile(this.settingsFile(), JSON.stringify(body, null, 2) + '\n').catch(error => this.event('FAILED', `Saving settings failed: ${errorMessage(error)}`));
  }

  /**
   * TEST only, with TEST stopped: archives both paper ledgers (kept on disk, never deleted) and restarts each
   * sleeve at its planned capital. Open paper positions end with the archived ledger.
   */
  async resetTest(): Promise<string[]> {
    if (this.d.mode !== 'PAPER') throw new DeskReject('RESET_TEST_ONLY');
    if (this.scanner) throw new DeskReject('STOP_TEST_FIRST');
    // A scan or position check that is still winding down after STOP must finish (and save) before files move.
    await this.settled();
    if (this.scanner) throw new DeskReject('STOP_TEST_FIRST');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'), archived: string[] = [];
    for (const id of this.ids()) {
      const key = this.ledgerKey(id, null), file = path.join(this.d.dir, `ledger-${key}.json`), old = this.ledgers.get(key);
      this.ledgers.delete(key);
      if (old && (old.state.entries.length || old.state.positions.length)) {
        await old.save();
        const target = path.join(this.d.dir, `ledger-${key}.archived-${stamp}.json`);
        await fs.rename(file, target);
        archived.push(path.basename(target));
      } else await fs.rm(file, { force: true });
      const fresh = await this.ledgerFor(id, null);
      if (this.solUsd) fresh.fundPaper(this.profile(id).capitalUsd, this.solUsd);
      await fresh.save();
    }
    for (const id of this.ids()) {
      for (const name of await this.cycleFiles(id)) {
        const target = name.replace('.cycle-', `.archived-${stamp}.cycle-`);
        await fs.rename(path.join(this.d.dir, name), path.join(this.d.dir, target));
        archived.push(target);
      }
      this.cycles.delete(id);
    }
    this.preflights = []; this.entrySkips.clear(); this.drillSkips.clear(); this.holdLog.clear(); this.noRouteChecks.clear(); this.valuationLog.clear(); this.notes.clear(); this.entryNotes.clear(); this.message = null;
    this.event('SYSTEM', `TEST reset: ${archived.length ? `archived ${archived.join(', ')}` : 'nothing to archive'}; every sleeve restarts at its planned capital`);
    await this.persist();
    return archived;
  }

  /**
   * TEST only: runs one candidate through the real quote → route → build → simulation → pre-flight path and books
   * nothing. It can never request a signature: the paper signer ends the path exactly where LIVE would ask Phantom.
   */
  probe(mint: string): Promise<void> {
    if (this.d.mode !== 'PAPER') return Promise.reject(new DeskReject('PROBE_TEST_ONLY'));
    if (this.work) return Promise.reject(new DeskReject('SCAN_IN_PROGRESS'));
    const c = this.candidates.get(mint);
    if (c && c.onchain.decimals === null) return Promise.reject(new DeskReject('EVIDENCE_PENDING'));
    const work = (async () => {
      await this.syncWallet();
      const ledger = await this.ledgerFor('FAIR', null);
      if (this.solUsd) ledger.fundPaper(this.strategies.FAIR.capitalUsd, this.solUsd);
      // Any mint can be probed (e.g. to verify the path on a liquid token); its decimals come from the chain, never a guess.
      const mintInfo = c ? null : await this.d.safety.check(mint, { rejectMintAuthority: false, fresh: true });
      const decimals = c?.onchain.decimals ?? mintInfo!.decimals, token2022 = c ? c.onchain.token2022 === true : mintInfo!.isToken2022;
      this.event('SYSTEM', `PROBE started for ${c?.symbol ?? mint} (${c ? `candidate status ${c.status}` : 'not a strategy candidate'}); nothing will be booked`, { mint, symbol: c?.symbol ?? null });
      await this.execute('BUY', { strategy: 'FAIR', mint, symbol: c?.symbol ?? null, decimals, pairAddress: c?.pair.address ?? '', heldRaw: 0n, token2022 }, ledger, () => false, true);
    })().finally(async () => { await this.persist().catch(() => undefined); this.work = null; });
    this.work = work;
    return work;
  }

  pulse(): Promise<void> {
    if (this.work) return this.work;
    const work = this.scan().catch(error => {
      this.message = 'SCAN_FAILED';
      this.event('FAILED', `Scan failed: ${errorMessage(error)}`);
    }).finally(async () => {
      this.lastScanAt = Date.now();
      this.nextScanAt = this.scanner ? this.lastScanAt + DESK.scanMs : null;
      // Cleared only after the save, so settled() and a TEST reset never race a write.
      await this.persist().catch(error => this.event('FAILED', `Saving desk state failed: ${errorMessage(error)}`));
      this.work = null;
    });
    this.work = work;
    return work;
  }
  /** Called every second by the host: a full scan when due, and position checks at each strategy's own cadence. */
  tick(): void {
    if (!this.scanner) { this.idleWalletSync(); return; }
    if (!this.work && (this.nextScanAt ?? 0) <= Date.now()) void this.pulse();
    if (this.d.opening && !this.openingWork && Date.now() - this.lastOpeningAt >= OPENING.pollMs) {
      this.lastOpeningAt = Date.now();
      this.openingWork = this.openingPass().then(() => undefined).catch(error => this.note('opening', 'FAILED', `Opening screen: ${errorMessage(error)}`)).finally(() => { this.openingWork = null; });
    }
    if (this.d.golden && !this.goldenWork && Date.now() - this.lastGoldenAt >= GOLDEN.pollMs) {
      this.lastGoldenAt = Date.now();
      this.goldenWork = this.goldenPass().then(() => undefined).catch(error => this.note('golden', 'FAILED', `Golden pocket: ${errorMessage(error)}`)).finally(() => { this.goldenWork = null; });
    }
    if (this.positionWork) return;
    const now = Date.now();
    const due = this.ids().filter(id => (this.ledgerOf(id)?.state.positions.length ?? 0) > 0 && now - (this.lastPositionCheckAt[id] ?? 0) >= this.profile(id).positionCheckMs);
    if (!due.length) return;
    this.background = this.checkPositions(due, this.stopper())
      .catch(error => this.event('FAILED', `Position check failed: ${errorMessage(error)}`))
      .then(() => this.persist()).catch(error => this.event('FAILED', `Saving desk state failed: ${errorMessage(error)}`));
  }

  /**
   * While the scanner is off, the wallet balance and SOL price are still refreshed every 15 s, so the dashboard shows
   * the actual wallet before a session starts. Read-only: one balance call and one price request.
   */
  private idleWalletSync(): void {
    if (this.work || this.idleSync || Date.now() - this.lastIdleSyncAt < 15_000 || !this.d.wallet()) return;
    this.lastIdleSyncAt = Date.now();
    this.idleSync = this.syncWallet(true).finally(() => { this.idleSync = null; });
  }

  async settled(): Promise<void> {
    while (this.work || this.positionWork) { await this.work?.catch(() => undefined); await this.positionWork?.catch(() => undefined); }
    await this.orders; await this.background; await this.settingsWrite; await this.idleSync;
  }
  async persist(): Promise<void> {
    await this.events.flush();
    if (this.tape.length) {
      const rows = this.tape.splice(0), file = path.join(this.d.dir, `tape-${this.d.mode}.jsonl`);
      const size = await fs.stat(file).then(st => st.size, () => 0);
      if (size > 20 * 1024 * 1024) await fs.rename(file, `${file}.1`).catch(() => undefined);
      await fs.appendFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    for (const b of this.books()) await b.ledger.save();
  }

  // ------------------------------------------------------------------ scan

  private async scan(): Promise<void> {
    const d = this.d, stopped = this.stopper(), started = Date.now();
    this.event('SCANNING', 'Scan started', { detail: { mode: d.mode } });
    this.currentScanAt = started; this.message = null; this.entryNotes.clear();
    await this.syncWallet();
    if (this.localKey && !this.rentSwept && !stopped()) {
      this.rentSwept = true;
      const mints = [...new Set(this.books().flatMap(b => b.ledger.state.entries.filter(e => e.side === 'BUY' && e.status === 'CONFIRMED').map(e => e.mint)))].filter(m => !this.heldBy(m));
      this.orders = this.orders.then(() => this.reclaimRent(mints)).catch(() => undefined);
    }
    const books = this.books();
    if (d.mode === 'LIVE' && !books.length) { this.message = 'Connect Phantom to scan in LIVE mode'; this.event('WAITING', this.message); return; }
    if (this.solUsd) for (const b of books) b.ledger.fundPaper(b.p.capitalUsd, this.solUsd);
    await this.checkPositions(this.ids(), stopped);
    if (stopped()) return;
    for (const [k, at] of this.drillSkips) if (Date.now() - at > 15 * 60_000) this.drillSkips.delete(k);
    for (const [k, v] of this.entrySkips) if (Date.now() - v.at > DESK.entrySkipMs) this.entrySkips.delete(k);
    await this.pollLaunches(started);
    const found = await requestScope.run({ category: 'discovery', signal: AbortSignal.timeout(DESK.discoveryBudgetMs) },
      () => discover(d.dex, d.gecko, this.watchlist(), () => this.pollGraduations()));
    this.sources = found.sources;
    for (const l of this.launchList.values()) {
      if (started - l.at > LAUNCH_ENTRY.migrated.maxAgeMin * 60_000 + 10 * 60_000) continue;
      const row = found.tokens.get(l.mint) ?? { mint: l.mint, sources: [], boostAmount: null, description: l.meta?.description ?? null, links: [], geckoPool: null };
      row.sources.push('launch-radar'); found.tokens.set(l.mint, row);
    }
    for (const [mint] of this.openSignals) {
      const row = found.tokens.get(mint) ?? { mint, sources: [], boostAmount: null, description: null, links: [], geckoPool: null };
      if (!row.sources.includes('open-screen')) row.sources.push('open-screen');
      found.tokens.set(mint, row);
    }
    for (const [mint] of this.goldenSignals) {
      const row = found.tokens.get(mint) ?? { mint, sources: [], boostAmount: null, description: null, links: [], geckoPool: null };
      if (!row.sources.includes('golden-pocket')) row.sources.push('golden-pocket');
      found.tokens.set(mint, row);
    }
    // Tokens posted on X (X feed) that the radar did not see launch: scanned like any candidate.
    for (const x of d.launches?.xOnly?.(started) ?? []) {
      const row = found.tokens.get(x.mint) ?? { mint: x.mint, sources: [], boostAmount: null, description: null, links: [], geckoPool: null };
      if (!row.sources.includes('x-feed')) row.sources.push('x-feed');
      found.tokens.set(x.mint, row);
    }
    if (d.launches) this.sources['Launch radar (pump.fun, on-chain)'] = `${this.launchList.size} shortlisted · X pages read without a key · ${d.aiReview ? d.aiReview() : 'Claude review off'}`;
    if (d.opening) { const o = d.opening.counts(); this.sources['Opening screen (curves, every 4 s)'] = `${o.OPENING} in their first minute · ${o.STRONG} strong opens watched · ${o.SIGNAL} breakouts · ${o.RUG} fell below the floor`; }
    if (d.golden) { const g = d.golden.counts(); this.sources['Golden pocket (graduated pools, every 4 s)'] = `${g.watched} pools watched · ${g.DIP} dipped · ${g.BROKEN_OUT} broke out, waiting for the retest · ${g.ENTRY} filled`; }
    if (d.xfeed) { const x = d.xfeed.status(); this.sources['X feed (X API search)'] = x.configured ? (x.lastError ?? `${x.signals} token posts from ${x.posts} posts`) : 'off — set X_BEARER_TOKEN in .env'; }
    const staged = await this.stage(found.tokens);
    // CRASH is time-critical: safety evidence for pumping young pools first, entries right after, and only then
    // the remaining evidence and the rate-limited launch-history checks that FAIR needs.
    const due = this.deepDue(staged.list, started);
    await this.deepAnalyses(due.filter(s => s.crashHint || s.launch || s.open || s.golden));
    if (this.strategies.OPEN.enabled && !stopped()) {
      const signals = staged.list.filter(s => s.open).map(s => this.assess(s, started)).filter(c => c.open?.signal.signal);
      const ledger = this.ledgerOf('OPEN');
      if (ledger && signals.length) await this.maybeEnter('OPEN', ledger, signals, stopped);
    }
    if (this.strategies.GOLDEN.enabled && !stopped()) {
      const signals = staged.list.filter(s => s.golden).map(s => this.assess(s, started)).filter(c => c.golden?.signal.signal);
      const ledger = this.ledgerOf('GOLDEN');
      if (ledger && signals.length) await this.maybeEnter('GOLDEN', ledger, signals, stopped);
    }
    if (this.strategies.LAUNCH.enabled && !stopped()) {
      const signals = staged.list.filter(s => s.launch).map(s => this.assess(s, started)).filter(c => c.launch?.signal.signal);
      for (const c of signals) this.alertOnce(`entry:${c.mint}`, `LAUNCH entry-ready: ${c.symbol ?? c.mint.slice(0, 6)}`, `${c.launch!.signal.summary}\n${fomoUrl(c.mint)}`);
      const ledger = this.ledgerOf('LAUNCH');
      if (ledger && signals.length) await this.maybeEnter('LAUNCH', ledger, signals, stopped);
    }
    if (this.strategies.CRASH.enabled && !stopped()) {
      const signals = staged.list.filter(s => s.crashHint).map(s => this.assess(s, started)).filter(c => c.crash?.signal);
      const ledger = this.ledgerOf('CRASH');
      if (ledger && signals.length) await this.maybeEnter('CRASH', ledger, signals, stopped);
    }
    if (stopped()) return;
    await this.refreshHolders(staged.list, started);
    await this.slowPath(staged.list, due.filter(s => !s.crashHint && !s.launch), started);
    const counts = this.finalize(staged.list, staged.filtered, started);
    this.lastCompletedScanAt = started;
    if (stopped()) return;
    this.event('SCANNING', `Scan finished: ${found.tokens.size} tokens discovered, ${counts.qualified} qualified (FAIR), ${counts.crash} CRASH signal(s), ` +
      `${this.customIds().length ? `${counts.custom} custom signal(s), ` : ''}` +
      `${counts.waiting} waiting, ${counts.watch} on watchlist, ${counts.filtered} filtered`, { detail: { ms: Date.now() - started } });
    const fair = this.ledgerOf('FAIR');
    // Only candidates assessed in this scan: a token that dropped out of discovery keeps its last snapshot, which is never traded on.
    if (fair) await this.maybeEnter('FAIR', fair, [...this.candidates.values()].filter(c => c.status === 'QUALIFIED' && c.updatedAt >= started), stopped);
    for (const id of this.customIds()) {
      const ledger = this.ledgerOf(id);
      if (!this.strategies[id]?.enabled || !ledger || stopped()) continue;
      const signals = [...this.candidates.values()].filter(c => c.updatedAt >= started && c.rules?.[id]?.signal);
      if (signals.length) await this.maybeEnter(id, ledger, signals, stopped);
    }
  }

  private watchlist(): string[] {
    const keep = [...this.candidates.values()].filter(c => c.status !== 'FILTERED').sort((a, b) => b.updatedAt - a.updatedAt).map(c => c.mint).slice(0, 40);
    return [...new Set([...this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint)), ...keep])];
  }

  /** `quiet` (idle refresh): a repeated identical failure is logged once, not every 15 s. */
  private async syncWallet(quiet = false): Promise<void> {
    const d = this.d, fail = (key: string, message: string) => quiet ? this.note(key, 'FAILED', message) : this.event('FAILED', message);
    try {
      const pairs = await d.dex.getPairsForTokens([SOL_MINT]);
      const p = selectPair(pairs, SOL_MINT, Date.now());
      if (p?.priceUsd) this.solUsd = p.priceUsd;
    } catch (error) { fail('sol-price', `SOL price unavailable: ${errorMessage(error)}`); }
    const wallet = d.wallet();
    if (!wallet) { this.walletView = null; return; }
    try {
      const native = await d.rpc.execute('desk:wallet-sync', c => c.getBalance(wallet.owner, 'confirmed'));
      this.walletView = { owner: wallet.owner.toBase58(), native: BigInt(native), at: Date.now() };
      if (d.mode === 'LIVE') for (const id of this.ids()) await this.ledgerFor(id, this.walletView.owner);
    } catch (error) { fail('wallet-sync', `Wallet sync failed: ${errorMessage(error)}`); }
  }

  // ------------------------------------------------------------------ discovery → evidence → gates

  private async stage(tokens: Map<string, Discovered>): Promise<{ list: Staged[]; filtered: number }> {
    // Held tokens and the watchlist first: they are appended last by discovery and must never be cut by the cap.
    const d = this.d, held = new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint))), watched = new Set(this.watchlist());
    const order = (m: string) => held.has(m) ? 0 : this.openSignals.has(m) || this.goldenSignals.has(m) || this.launchList.has(m) || tokens.get(m)!.sources.includes('graduated') ? 1 : watched.has(m) ? 2 : 3;
    const mints = [...tokens.keys()].sort((a, b) => order(a) - order(b)).slice(0, DESK.maxStagedPerScan);
    const pairs = mints.length ? await d.dex.getPairsForTokens(mints) : [];
    const list: Staged[] = [];
    let filtered = 0;
    for (const mint of mints) {
      const found = tokens.get(mint)!, pair = selectPair(pairs, mint, Date.now());
      if (!pair) { filtered++; this.transition(mint, null, 'FILTERED', 'No fresh pool with a price (SOL/USDC/USDT, or another quote with ≥ $20K liquidity)'); continue; }
      const times = tokenTimes(pairs, mint), radar = this.launchList.get(mint);
      const metrics = pairMetrics(pair, Date.now(), { createdAt: radar?.at ?? times.createdAt, firstPoolAt: times.firstPoolAt }), tier = tierFor(metrics);
      this.rememberName(mint, pair);
      // Custom strategies see every priced token: a $5M runner is outside FAIR's bands but may be exactly what one wants.
      const ruleHints = this.customIds().filter(id => this.profile(id).enabled && ruleMarketHint(this.profile(id).rule!, metrics));
      if ('filtered' in tier && !ruleHints.length && !held.has(mint) && !this.openSignals.has(mint) && !this.goldenSignals.has(mint)) { filtered++; this.candidates.delete(mint); this.transition(mint, pair.baseToken.symbol ?? null, 'FILTERED', tier.filtered); continue; }
      list.push({ found, pair, tier: 'filtered' in tier ? 'CUSTOM' : tier.tier, metrics, crashHint: crashMarketHint(metrics), ruleHints, launch: this.launchList.get(mint) ?? null,
        open: this.openSignals.get(mint) ?? null, golden: this.goldenSignals.get(mint) ?? null });
    }
    return { list, filtered };
  }

  private tradeable(s: Staged): boolean {
    return s.tier === 'TRENDING' && (s.metrics.volume5mUsd ?? 0) > DESK.gates.minVolume5mUsd &&
      (s.metrics.liquidityUsd ?? 0) > DESK.gates.minLiquidityUsd && (s.metrics.buySellRatio5m ?? 0) > DESK.gates.minBuySellRatio;
  }
  /** Deep evidence (RPC, website, X, trade flow) for the most tradeable-looking tokens first; CRASH signals lead. */
  private deepDue(list: Staged[], now: number): Staged[] {
    const crash = this.strategies.CRASH.enabled;
    const priority = (s: Staged) => (s.launch || s.open || s.golden ? 3e9 : 0) + (crash && s.crashHint ? 2e9 : 0) + (s.ruleHints.length ? 1.5e9 : 0) + (s.tier === 'TRENDING' ? 1e9 : 0) +
      ((s.metrics.volume5mUsd ?? 0) > DESK.gates.minVolume5mUsd ? 1e8 : 0) + ((s.metrics.liquidityUsd ?? 0) > DESK.gates.minLiquidityUsd ? 1e7 : 0) + (s.metrics.volume5mUsd ?? 0);
    return list.filter(s => !this.deep.has(s.found.mint) || now - this.deep.get(s.found.mint)!.at > DESK.deepAnalysisTtlMs)
      .sort((a, b) => priority(b) - priority(a)).slice(0, DESK.maxDeepAnalysesPerScan);
  }
  private async deepAnalyses(list: Staged[]): Promise<void> {
    // Trade flow is rate-limited upstream; a CRASH entry never waits for it.
    await Promise.all(list.map(s => this.deepAnalysis(s.found, s.pair, this.tradeable(s) && !s.crashHint).catch(error =>
      this.event('FAILED', `Evidence gathering failed: ${errorMessage(error)}`, { mint: s.found.mint, symbol: s.pair.baseToken.symbol ?? null }))));
  }
  /**
   * GeckoTerminal-bound evidence (FAIR's trade flow and launch history) within a time budget: when it runs out, queued
   * requests are cancelled instead of piling up and delaying the next scan's discovery.
   */
  private async slowPath(list: Staged[], rest: Staged[], now: number): Promise<void> {
    const budget = new AbortController(), timer = setTimeout(() => budget.abort(), DESK.slowPathBudgetMs);
    try {
      await requestScope.run({ category: 'analysis', signal: budget.signal }, async () => {
        await this.deepAnalyses(rest);
        if (!budget.signal.aborted) await this.launchChecks(list, now, budget.signal);
      });
    } finally { clearTimeout(timer); }
  }

  /** Launch fairness for trending tokens (at most two per scan: GeckoTerminal is rate-limited); needs supply from the deep evidence. */
  private async launchChecks(list: Staged[], now: number, budget?: AbortSignal): Promise<void> {
    const d = this.d;
    const launchDue = list.filter(s => s.tier === 'TRENDING' && this.deep.get(s.found.mint)?.onchain.holders &&
      (!this.launches.has(s.found.mint) || (this.launches.get(s.found.mint)!.value === null && now - this.launches.get(s.found.mint)!.at > 600_000)))
      // A token a strategy already holds cannot be bought by FAIR: its history is checked after the others (rate-limited).
      .sort((a, b) => Number(!!this.heldBy(a.found.mint)) - Number(!!this.heldBy(b.found.mint)) || (b.metrics.volume5mUsd ?? 0) - (a.metrics.volume5mUsd ?? 0)).slice(0, 2);
    for (const s of launchDue) {
      if (budget?.aborted) return;
      const h = this.deep.get(s.found.mint)!.onchain.holders!;
      try { this.launches.set(s.found.mint, { at: now, value: await launchCheck(d.gecko, s.found.mint, exactNumber(h.supplyRaw) / 10 ** h.decimals) }); }
      catch (error) {
        // Out of time budget: not a failure of the token's history; it is simply checked in a later scan.
        if (budget?.aborted) return;
        this.launches.set(s.found.mint, { at: now, value: null });
        this.event('WATCHLIST', `Launch history unavailable: ${errorMessage(error).slice(0, 100)}`, { mint: s.found.mint, symbol: s.pair.baseToken.symbol ?? null });
      }
    }
    if (this.launches.size > 1_000) this.launches.delete(this.launches.keys().next().value!);
  }
  /** The newest holder snapshot for a token, from the holder pass or a deep analysis. */
  private latestHolders(mint: string): Holders | null {
    const a = this.holderInfo.get(mint) ?? null, b = this.deep.get(mint)?.onchain.holders ?? null;
    const newest = !a ? b : !b ? a : a.at >= b.at ? a : b;
    // A count from an earlier snapshot is kept until a newer count replaces it.
    const counted = [a, b].filter((h): h is Holders => !!h && h.countAt !== null).sort((x, y) => y.countAt! - x.countAt!)[0];
    return newest && counted && newest.countAt === null ? { ...newest, count: counted.count, countCapped: counted.countCapped, countNote: counted.countNote, countAt: counted.countAt } : newest;
  }

  /**
   * Largest holders for the most active candidates the deep analyses did not refresh recently, and the holder count
   * for a few of them. Failures leave the previous snapshot; they never block the scan.
   */
  private async refreshHolders(list: Staged[], now: number): Promise<void> {
    const h = DESK.holders, rank = (s: Staged) => (s.launch ? 4e9 : 0) + (s.ruleHints.length ? 3e9 : 0) + (s.crashHint ? 2e9 : 0) + (s.tier === 'TRENDING' ? 1e9 : 0) + (s.metrics.volume5mUsd ?? 0);
    const due = list.filter(s => {
      const last = this.latestHolders(s.found.mint);
      return !last || now - last.at > h.ttlMs || (!this.holderCountUnsupported && (last.countAt === null || now - last.countAt > h.countTtlMs));
    }).sort((a, b) => rank(b) - rank(a)).slice(0, h.perScan);
    let counts = 0;
    await Promise.all(due.map(async s => {
      const mint = s.found.mint, last = this.latestHolders(mint);
      try {
        const next: Holders = last && now - last.at <= h.ttlMs ? { ...last } : await readHolders(this.d.rpc, mint);
        const countDue = !this.holderCountUnsupported && (!last || last.countAt === null || now - last.countAt > h.countTtlMs);
        if (countDue && counts < h.countPerScan) {
          counts++;
          try {
            const r = await holderCount(this.d.rpc, mint, h.countPages);
            Object.assign(next, { count: r.count, countCapped: r.capped, countNote: null, countAt: Date.now() });
          } catch (error) {
            const message = errorMessage(error);
            if (/method not found|not supported|unknown method|-32601/i.test(message)) this.holderCountUnsupported = 'RPC has no DAS getTokenAccounts (holder count needs e.g. Helius)';
            Object.assign(next, { countNote: this.holderCountUnsupported ?? `count failed: ${message.slice(0, 80)}` });
          }
        } else if (last && last.countAt !== null) Object.assign(next, { count: last.count, countCapped: last.countCapped, countNote: last.countNote, countAt: last.countAt });
        else if (this.holderCountUnsupported) next.countNote = this.holderCountUnsupported;
        this.holderInfo.set(mint, next);
      } catch { /* RPC outage: the previous snapshot stays */ }
    }));
  }

  /** Analysis of one staged token with the evidence known right now; commits nothing. */
  private assess(s: Staged, now: number): Candidate {
    const mint = s.found.mint, deep = this.deep.get(mint) ?? null, held = this.latestHolders(mint);
    const watch: WatchState = this.watch.get(mint) ?? { firstSeenAt: now, observations: 0, lastLiquidityUsd: null, lastPriceUsd: null, momentumStreak: 0 };
    const onchain: OnchainEvidence | null = deep ? { ...deep.onchain, holders: held } : held ? { safety: null, holders: held, developer: null, flow: null, errors: {} } : null;
    const c = analyze({ found: s.found, pair: s.pair, metrics: s.metrics, tier: s.tier, onchain, onchainAt: deep?.at ?? held?.at ?? null,
      social: deep?.social ?? null, watch, now, maxWashRatio: this.d.cfg.rs.maxWashRatio, launch: this.launches.get(mint)?.value ?? null });
    c.crash = crashCheck(c);
    if (s.launch) c.launch = { score: s.launch.score, reasons: s.launch.reasons, x: s.launch.x.url, website: s.launch.site?.url ?? s.launch.meta?.website ?? null,
      launchedAt: s.launch.at, ca: s.launch.ca, signal: launchEntryCheck(c, s.launch, now) };
    if (s.open) c.open = { openHighUsd: s.open.state.openHighUsd, lowUsd: s.open.state.lowUsd, signalUsd: s.open.state.signalUsd, signalAt: s.open.at,
      detail: s.open.state.detail, signal: openEntryCheck(c, s.open.state, s.open.launch, this.d.opening?.get(mint) ?? null, now) };
    if (s.golden) {
      const e = s.golden.s.entry;
      const view = { kind: e.kind, fillUsd: e.price, stopUsd: e.stop, resistanceUsd: e.resistance, zone: e.zone, signalAt: s.golden.at, detail: e.detail };
      c.golden = { ...view, signal: goldenEntryCheck(c, view, this.strategies.GOLDEN.entryKinds ?? ['ONLY_UP'], s.golden.launch ?? this.launchList.get(mint) ?? null,
        this.d.golden?.get(mint) ?? null, now) };
    }
    const rules = this.customIds().filter(id => this.profile(id).enabled).map(id => [id, ruleCheck(this.profile(id).rule!, c)] as const);
    if (rules.length) c.rules = Object.fromEntries(rules);
    return c;
  }
  private finalize(list: Staged[], filtered: number, now: number): { qualified: number; crash: number; custom: number; waiting: number; watch: number; filtered: number } {
    const counts = { qualified: 0, crash: 0, custom: 0, waiting: 0, watch: 0, filtered };
    for (const s of list) {
      const mint = s.found.mint, candidate = this.assess(s, now);
      this.watch.set(mint, { firstSeenAt: candidate.firstSeenAt, observations: candidate.observations, lastLiquidityUsd: s.metrics.liquidityUsd,
        lastPriceUsd: s.metrics.priceUsd, momentumStreak: candidate.momentumStreak });
      this.candidates.set(mint, candidate);
      if (candidate.crash?.signal) counts.crash++;
      for (const r of Object.values(candidate.rules ?? {})) if (r.signal) counts.custom++;
      if (s.crashHint) {
        const m = candidate.metrics;
        this.tape.push({ at: now, mint, symbol: candidate.symbol, pool: candidate.pair.address, dex: candidate.pair.dex, priceUsd: m.priceUsd,
          marketCapUsd: m.marketCapUsd, liquidityUsd: m.liquidityUsd, poolAgeMin: m.poolAgeMin, volume5mUsd: m.volume5mUsd, volume1hUsd: m.volume1hUsd,
          buys5m: m.buys5m, sells5m: m.sells5m, priceChange5mPct: m.priceChange5mPct, priceChange1hPct: m.priceChange1hPct, top10WalletPct: m.top10WalletPct,
          largestWalletPct: m.largestWalletPct, signal: candidate.crash?.signal ?? false, summary: candidate.crash?.summary ?? null, held: this.heldBy(mint) });
      }
      if (candidate.status === 'QUALIFIED') counts.qualified++; else if (candidate.status === 'WAITING') counts.waiting++;
      else if (candidate.status === 'WATCHLIST') counts.watch++; else counts.filtered++;
      // The scan's verdict is what the ENABLED strategies say: FAIR's own gates (buy/sell ≥ 1.4, fair launch…) are no
      // longer reported as the token's status while FAIR is off.
      if (this.strategies.FAIR.enabled) this.transition(mint, candidate.symbol, candidate.status, `${candidate.tier === 'ULTRA_EARLY' ? `[${candidate.classification}] ` : ''}${candidate.reasons.join('; ')}`);
      else {
        const v = this.verdicts(candidate).filter(x => x.id !== 'FAIR');
        this.transition(mint, candidate.symbol, v.some(x => x.signal) ? 'QUALIFIED' : 'WATCHLIST',
          v.map(x => `${x.id}: ${x.signal ? 'entry-ready' : x.summary}`).join('; ') || 'no enabled strategy covers this token');
      }
    }
    if (this.candidates.size > DESK.maxCandidates) {
      const held = new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint)));
      const drop = [...this.candidates.values()].filter(c => !held.has(c.mint)).sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt)
        .slice(0, this.candidates.size - DESK.maxCandidates);
      for (const c of drop) { this.candidates.delete(c.mint); this.watch.delete(c.mint); this.deep.delete(c.mint); this.holderInfo.delete(c.mint); }
    }
    return counts;
  }

  /** Every enabled strategy's verdict on a candidate: entry-ready, or the first rule it misses. */
  private verdicts(c: Candidate): Array<{ id: StrategyId; signal: boolean; summary: string }> {
    return this.ids().filter(id => this.profile(id).enabled).flatMap(id => {
      if (id === 'FAIR') return [{ id, signal: c.status === 'QUALIFIED', summary: c.reasons[0] ?? c.status }];
      if (id === 'CRASH') return c.crash ? [{ id, signal: c.crash.signal, summary: c.crash.summary }] : [];
      if (id === 'LAUNCH') return c.launch ? [{ id, signal: c.launch.signal.signal, summary: c.launch.signal.summary }] : [];
      if (id === 'OPEN') return c.open ? [{ id, signal: c.open.signal.signal, summary: c.open.signal.summary }] : [];
      if (id === 'GOLDEN') return c.golden ? [{ id, signal: c.golden.signal.signal, summary: c.golden.signal.summary }] : [];
      const r = c.rules?.[id];
      return r ? [{ id, signal: r.signal, summary: r.summary }] : [];
    });
  }

  /** One telemetry event per token and state change; repeated identical outcomes stay quiet. */
  private transition(mint: string, symbol: string | null, status: 'FILTERED' | 'WATCHLIST' | 'WAITING' | 'QUALIFIED', reason: string): void {
    const key = `${status}|${reason}`;
    if (this.lastState.get(mint) === key) return;
    this.lastState.set(mint, key);
    if (this.lastState.size > 2_000) this.lastState.delete(this.lastState.keys().next().value!);
    this.event(status, reason, { mint, symbol });
  }

  private async deepAnalysis(found: Discovered, pair: NonNullable<ReturnType<typeof selectPair>>, includeTrades: boolean): Promise<void> {
    const d = this.d, mint = found.mint;
    const links = [...(pair.info?.websites ?? []).map(w => ({ url: w.url, type: 'website' })), ...(pair.info?.socials ?? []).map(s => ({ url: s.url, type: s.type ?? null })),
      ...found.links.map(l => ({ url: l.url, type: l.type ?? (l.label?.toLowerCase().includes('website') ? 'website' : null) }))];
    const websiteUrl = links.find(l => l.type === 'website' || (!l.type && !/(?:x|twitter|t)\.(?:com|me)\//i.test(l.url)))?.url ?? null;
    const xUrl = links.find(l => l.type === 'twitter' || /(?:x|twitter)\.com\//i.test(l.url))?.url ?? null;
    const link = parseXLink(xUrl);
    const [onchain, website, account] = await Promise.all([
      gatherOnchain(d.rpc, d.safety, d.gecko, mint, pair.pairAddress, mint.endsWith('pump') || pair.dexId === 'pumpfun', includeTrades),
      (d.website ?? (u => checkWebsite(u)))(websiteUrl),
      link.handle ? d.x.account(link.handle) : Promise.resolve(null),
    ]);
    const now = Date.now();
    const auth = assessAuthenticity({ link, account, xApiConfigured: d.x.configured, projectStartedAt: pair.pairCreatedAt ?? null, website, now });
    this.deep.set(mint, { at: now, onchain, social: { website, link, account, auth, at: now } });
    const errors = Object.entries(onchain.errors);
    if (errors.length) this.event('WATCHLIST', `Evidence partially UNKNOWN: ${errors.map(([k, v]) => `${k} (${v.slice(0, 80)})`).join('; ')}`, { mint, symbol: pair.baseToken.symbol ?? null });
  }

  // ------------------------------------------------------------------ positions & exits

  /** Exclusive: the fast loop and a scan never value or exit the same positions at the same time. */
  private async checkPositions(ids: readonly StrategyId[], stopped: () => boolean, manualOnly = false): Promise<void> {
    while (this.positionWork) await this.positionWork.catch(() => undefined);
    const work = (async () => {
      for (const mint of this.manualExits) if (!this.heldBy(mint)) this.manualExits.delete(mint);
      for (const id of ids) {
        if (stopped()) return;
        const ledger = this.ledgerOf(id);
        this.lastPositionCheckAt[id] = Date.now();
        if (ledger?.state.positions.length) await this.managePositions(id, ledger, stopped, manualOnly);
      }
    })();
    const tracked: Promise<void> = work.finally(() => { if (this.positionWork === tracked) this.positionWork = null; });
    this.positionWork = tracked;
    await tracked;
  }

  /** Current pool liquidity for all held tokens in one request. */
  private async poolLiquidity(mints: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (!mints.length) return out;
    try {
      const pairs = await requestScope.run({ category: 'position' }, () => this.d.dex.getPairsForTokens(mints));
      for (const mint of mints) out.set(mint, selectPair(pairs, mint, Date.now())?.liquidity?.usd ?? null);
    } catch { /* market data outage: the executable-quote rules still apply */ }
    return out;
  }

  /**
   * Early-warning exits: pool liquidity collapsing since entry, the known creator selling, and for fresh launches the
   * insiders (creator + creation-slot buyers) selling or about to dump into the graduation, or the X account deleted.
   */
  private async earlyWarning(p: DeskPosition, liquidity: Map<string, number | null>, preGraduation = true): Promise<string | null> {
    const x = DESK.exits, liq = liquidity.get(p.mint) ?? null;
    const rug = this.launchList.get(p.mint)?.rug ?? null;
    if (rug) return rug.startsWith('RUG') ? rug : `RUG ${rug}`;
    if (p.insiders?.length && p.insiderPctAtEntry != null && Date.now() - (this.insiderChecks.get(p.mint) ?? 0) >= RISK.insiderCheckMs) {
      this.insiderChecks.set(p.mint, Date.now());
      try {
        // OPEN holds through graduation ("stay in for at least 6×"): insiders dumping still sells it, the curve level does not.
        const [now, curve] = await Promise.all([insiderHolding(this.d.rpc, p.mint, p.insiders), p.onCurve && preGraduation ? curveState(this.d.rpc, p.mint) : Promise.resolve(null)]);
        const exit = insiderExit(p.insiderPctAtEntry, now, curve);
        if (exit) return exit;
      } catch { /* RPC outage: retried on the next check */ }
    }
    if (p.entryLiquidityUsd && liq !== null && liq <= p.entryLiquidityUsd * (1 - x.liquidityDropExitPct / 100))
      return `LIQUIDITY_DROP $${Math.round(liq).toLocaleString('en-US')} vs $${Math.round(p.entryLiquidityUsd).toLocaleString('en-US')} at entry (−${((1 - liq / p.entryLiquidityUsd) * 100).toFixed(0)}%)`;
    const last = this.creatorChecks.get(p.mint) ?? 0;
    if (p.creator && p.creatorPctAtEntry != null && Date.now() - last >= x.creatorCheckMs) {
      this.creatorChecks.set(p.mint, Date.now());
      try {
        const pct = await creatorHolding(this.d.rpc, p.creator, p.mint);
        if (pct < p.creatorPctAtEntry - x.creatorSellExitPts) return `DEV_SELLING creator holds ${pct.toFixed(2)}% (was ${p.creatorPctAtEntry.toFixed(2)}% at entry)`;
      } catch { /* RPC outage: retried on the next check */ }
    }
    return null;
  }

  private async managePositions(id: StrategyId, ledger: DeskLedger, stopped: () => boolean, manualOnly = false): Promise<void> {
    const profile = this.profile(id), positions = ledger.state.positions.filter(p => !manualOnly || this.manualExits.has(p.mint));
    const liquidity = await this.poolLiquidity(positions.filter(p => p.entryLiquidityUsd).map(p => p.mint));
    for (const p of positions) {
      if (stopped()) return;
      const ctx = { mint: p.mint, symbol: p.symbol, detail: { strategy: id } };
      const manual = this.manualExits.has(p.mint), noRoute = DESK.exits.noRoute;
      if (p.noRouteSince && !manual && Date.now() - (this.noRouteChecks.get(p.mint) ?? 0) < noRoute.retryMs) continue;
      const warning = manual ? 'EXIT NOW (manual)' : await this.earlyWarning(p, liquidity, profile.preGraduationExit !== false);
      let value: bigint;
      try {
        const q = await requestScope.run({ category: 'position' }, () => this.d.jupiter.quote({ inputMint: p.mint, outputMint: SOL_MINT, amountRaw: BigInt(p.qtyRaw), slippageBps: profile.slippageBps }));
        value = BigInt(q.outAmount);
      } catch (error) {
        if (refused(error)) { await this.unroutable(id, ledger, p, error); continue; }
        if (Date.now() - (this.valuationLog.get(p.mint) ?? 0) >= DESK.exits.valuationLogMs) {
          this.valuationLog.set(p.mint, Date.now());
          this.event('WAITING', `${id} · position valuation unavailable: ${errorMessage(error)}; holding, no write-down`, ctx);
        }
        continue;
      }
      if (p.noRouteSince) {
        this.event('SYSTEM', `${id} · Jupiter routes this token again (no route since ${hhmm(p.noRouteSince)}); exit rules resume`, ctx);
        p.noRouteSince = null; this.noRouteChecks.delete(p.mint);
      }
      p.lastValueLamports = String(value);
      if (value > BigInt(p.peakValueLamports)) p.peakValueLamports = String(value);
      if (this.solUsd && p.decimals >= 0) p.lastPriceUsd = sol(value) * this.solUsd / (exactNumber(BigInt(p.qtyRaw)) / 10 ** p.decimals);
      const cost = exactNumber(BigInt(p.costLamports)), pnlPct = (exactNumber(value) - cost) / cost * 100;
      const peakPct = (exactNumber(BigInt(p.peakValueLamports)) - cost) / cost * 100;
      const fromPeakPct = (exactNumber(value) / exactNumber(BigInt(p.peakValueLamports)) - 1) * 100;
      // Price multiple of the FIRST entry (scale-ins and "hold until 6×" are measured from it).
      const first = p.firstEntryPriceUsd ?? p.entryPriceUsd, multiple = first && p.lastPriceUsd ? p.lastPriceUsd / first : null;
      if (multiple !== null) p.peakMultiple = Math.max(p.peakMultiple ?? 0, multiple);
      const reason = warning ?? exitReason(profile.exits, { pnlPct, peakPct, fromPeakPct, heldMs: Date.now() - p.openedAt, marketCapUsd: this.marketCapNow(p), peakMultiple: p.peakMultiple ?? null,
        levels: p.stopUsd != null || p.targetUsd != null ? { stopUsd: p.stopUsd ?? null, targetUsd: p.targetUsd ?? null } : null });
      if (!reason) {
        // Checked every few seconds; logged only when the result moves or once a minute, so telemetry stays readable.
        const prev = this.holdLog.get(p.mint);
        if (!prev || Math.abs(prev.pct - pnlPct) >= 2 || Date.now() - prev.at >= 60_000) {
          this.holdLog.set(p.mint, { pct: pnlPct, at: Date.now() });
          const unrealized = this.solUsd ? ` · ${usd(sol(value) * this.solUsd - p.costUsd)}` : '';
          this.event('POSITION', `${id} · holding: value ${sol(value).toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%${unrealized}, peak ${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(2)}%${multiple !== null && profile.scaleIn?.length ? ` · ${multiple.toFixed(2)}× the first entry` : ''})`, ctx);
        }
        await this.scaleIn(id, profile, ledger, p, multiple, stopped);
        continue;
      }
      // Exits run even while entries are paused: a paused desk must never leave a position without its stops.
      this.event('EXIT', `${id} · exit signal: ${reason}`, ctx);
      if (reason.startsWith('RUG')) {
        void this.d.launches?.markRug?.(p.mint, reason).catch(() => undefined);
        this.alertOnce(`rug:${p.mint}`, `${p.symbol ?? p.mint.slice(0, 6)}: RUG — selling`, `${reason}\n${fomoUrl(p.mint)}`);
      }
      await this.execute('SELL', { strategy: id, mint: p.mint, symbol: p.symbol, decimals: p.decimals, pairAddress: p.pairAddress, heldRaw: BigInt(p.qtyRaw) }, ledger, stopped);
    }
  }

  /** Scale-in: the next step of the profile's ladder, once, when the price reached its multiple of the first entry. Entries paused: no adds. */
  private async scaleIn(id: StrategyId, profile: StrategyProfile, ledger: DeskLedger, p: DeskPosition, multiple: number | null, stopped: () => boolean): Promise<void> {
    const step = profile.scaleIn?.[p.adds ?? 0];
    if (!step || multiple === null || multiple < step.atMultiple || !this.execution || stopped() || this.entryAllowance === 0 || p.noRouteSince) return;
    const ctx = { mint: p.mint, symbol: p.symbol, detail: { strategy: id } };
    if (this.d.mode === 'PAPER' && this.solUsd && BigInt(ledger.state.paperCashLamports ?? '0') < BigInt(Math.floor(step.addUsd / this.solUsd * 1e9 * 1.05))) {
      this.note(`${id}:add:${p.mint}`, 'WAITING', `${id} · scale-in ${(p.adds ?? 0) + 1} at ${step.atMultiple}× skipped: the TEST sleeve cannot fund ${usd(step.addUsd)}`);
      return;
    }
    this.event('QUALIFIED', `${id} · scale-in ${(p.adds ?? 0) + 1}: ${multiple.toFixed(2)}× the first entry (step ${step.atMultiple}×) → adding ${usd(step.addUsd)}`, ctx);
    await this.execute('BUY', { strategy: id, mint: p.mint, symbol: p.symbol, decimals: p.decimals, pairAddress: p.pairAddress, heldRaw: 0n, add: true, addUsd: step.addUsd }, ledger, stopped);
  }

  /**
   * Jupiter refused to route the held token (pool drained, delisted, no liquidity left). Re-quoted every few minutes
   * so an exit still happens if a route returns. After the write-off delay the position stops occupying a slot; in
   * TEST it is closed at zero, because a token that cannot be sold is worth nothing to the sleeve.
   */
  private async unroutable(id: StrategyId, ledger: DeskLedger, p: DeskPosition, error: unknown): Promise<void> {
    const now = Date.now(), x = DESK.exits.noRoute, ctx = { mint: p.mint, symbol: p.symbol, detail: { strategy: id } };
    p.noRouteSince ??= now; this.noRouteChecks.set(p.mint, now);
    const minutes = (now - p.noRouteSince) / 60_000;
    if (this.d.mode === 'PAPER' && minutes >= x.writeOffMin && this.solUsd) {
      this.event('EXIT', `${id} · exit signal: NO_ROUTE for ${Math.round(minutes)} min (${errorMessage(error)}); TEST writes the position off at zero`, ctx);
      const row = ledger.writeOff(p.mint, this.solUsd, now, `WRITE-OFF — no Jupiter route since ${hhmm(p.noRouteSince)} (${errorMessage(error)}); booked at zero`);
      this.bookedEvents('SELL', id, row, ctx);
      this.noRouteChecks.delete(p.mint); this.manualExits.delete(p.mint);
      await ledger.save();
      return;
    }
    const after = this.d.mode === 'PAPER' ? `written off at zero after ${x.writeOffMin} min` : `stops occupying a slot after ${x.writeOffMin} min; the tokens stay in the wallet`;
    this.event('WAITING', `${id} · no Jupiter route to sell (${errorMessage(error)}) since ${hhmm(p.noRouteSince)}: pool drained or delisted; retrying every ${x.retryMs / 60_000} min, ${after}`, ctx);
  }

  /**
   * Opening screen, every few seconds: new launches are read from the chain (the radar), every launch's curve market
   * cap is sampled, and a breakout above a strong opening candle is alerted at once and queued for the OPEN strategy
   * (a scan is started right away). Copycats, impersonators and rugs are never alerted.
   */
  async openingPass(now = Date.now()): Promise<OpeningSignal[]> {
    const d = this.d, feed = d.launches, tracker = d.opening;
    if (!tracker) return [];
    if (feed) this.launchPoll ??= feed.poll(now).then(() => undefined).catch(() => undefined).finally(() => { this.launchPoll = null; });
    if (feed) tracker.observe(feed.recent(now), now);
    const fresh: OpeningSignal[] = [];
    for (const state of await tracker.poll(now, this.solUsd)) {
      const launch = feed?.recent(now).find(l => l.mint === state.mint) ?? null, ctx = { mint: state.mint, symbol: state.symbol };
      const block = launch?.rug ?? (launch?.ca.status === 'IMPERSONATOR' ? launch.ca.detail : null) ?? this.launchCopycats.get(state.mint)
        ?? await this.launchCopycat({ mint: state.mint, name: state.name, symbol: state.symbol, at: state.at });
      if (block) { this.event('FILTERED', `OPEN screen: ${state.symbol} broke out (${state.detail}) but ${block} — no alert, never bought`, ctx); continue; }
      const signal = { state, launch, at: now };
      this.openSignals.set(state.mint, signal); fresh.push(signal);
      const age = Math.max(1, Math.round((now - state.at) / 60_000));
      this.event('QUALIFIED', `OPEN screen: ${state.symbol} "${state.name}" ${age} min old · ${state.detail}`, ctx);
      this.alertOnce(`open:${state.mint}`, `OPEN: ${state.symbol} broke out at $${((state.signalUsd ?? 0) / 1000).toFixed(1)}K`,
        `${state.name} · ${state.detail}${launch?.insiders ? ` · ${launch.insiders.detail}` : ''}\n${fomoUrl(state.mint)}`);
    }
    // A breakout is traded fresh: start a scan now instead of waiting for the next one.
    if (fresh.length && this.strategies.OPEN.enabled && !this.work) this.nextScanAt = Date.now();
    for (const [mint, s] of this.openSignals) if (now - s.at > 30 * 60_000 && !this.heldBy(mint)) this.openSignals.delete(mint);
    return fresh;
  }

  /** Graduations from the chain, one poll at a time (the scan's discovery and the GOLDEN POCKET loop share it). */
  private pollGraduations(): Promise<Graduation[]> {
    this.graduationPoll ??= this.graduations.poll().finally(() => { this.graduationPoll = null; });
    return this.graduationPoll;
  }

  /**
   * GOLDEN POCKET, every few seconds: fresh graduations start being watched (their PumpSwap reserves read on chain),
   * and a fill of a pattern GOLDEN buys is alerted at once and queued for the GOLDEN strategy (a scan is started right
   * away). Rugs, impersonators and copycats are never alerted.
   */
  async goldenPass(now = Date.now()): Promise<GoldenSignal[]> {
    const d = this.d, tracker = d.golden;
    if (!tracker) return [];
    if (now - this.lastGraduationsAt >= 8_000) {
      this.lastGraduationsAt = now;
      try { tracker.watchGraduations((await this.pollGraduations()).map(g => ({ mint: g.mint, at: g.at, symbol: this.candidates.get(g.mint)?.symbol ?? null })), now); }
      catch { /* RPC outage: the next pass retries */ }
    }
    tracker.hold([...new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint)))]);
    // PUMP-quoted pools (pump.fun's own token as the quote) need the PUMP price; refreshed every two minutes.
    if (!this.pumpUsd || now - this.pumpUsd.at > 120_000) {
      try {
        const pair = (await d.dex.getPairsForTokens([PUMP_QUOTE_MINT])).filter(p => p.baseToken.address === PUMP_QUOTE_MINT && p.priceUsd)
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        this.pumpUsd = pair?.priceUsd ? { value: pair.priceUsd, at: now } : this.pumpUsd;
      } catch { /* the SOL-quoted pools still work */ }
    }
    const quoteUsd = (q: string) => q === WSOL_MINT ? this.solUsd : q === PUMP_QUOTE_MINT ? this.pumpUsd?.value ?? null : null;
    const fresh: GoldenSignal[] = [];
    for (const s of await tracker.poll(now, quoteUsd)) {
      const launch = this.launchList.get(s.mint) ?? d.launches?.recent(now).find(l => l.mint === s.mint) ?? null, ctx = { mint: s.mint, symbol: s.symbol };
      const label = s.symbol ?? `${s.mint.slice(0, 4)}…${s.mint.slice(-4)}`;
      const block = launch?.rug ?? (launch?.ca.status === 'IMPERSONATOR' ? launch.ca.detail : null) ?? this.launchCopycats.get(s.mint) ?? null;
      if (block) { this.event('FILTERED', `GOLDEN POCKET: ${label} filled (${s.entry.detail}) but ${block} — no alert, never bought`, ctx); continue; }
      // Fills of a pattern GOLDEN does not buy (the retest, unless switched on) are shown, never alerted.
      if (!(this.strategies.GOLDEN.entryKinds ?? ['ONLY_UP']).includes(s.entry.kind)) { this.event('WATCHLIST', `GOLDEN POCKET (shown only): ${label} · ${s.entry.detail}`, ctx); continue; }
      this.goldenSignals.set(s.mint, { s, launch, at: now }); fresh.push(s);
      this.event('QUALIFIED', `GOLDEN POCKET: ${label} · ${s.entry.detail}`, ctx);
      this.alertOnce(`golden:${s.mint}`, `GOLDEN POCKET: ${label} at $${(s.entry.price / 1000).toFixed(1)}K`,
        `${s.entry.kind === 'RETEST' ? 'Break and retest' : 'Only up'} · ${s.entry.detail}\n${fomoUrl(s.mint)}`);
    }
    if (fresh.length && this.strategies.GOLDEN.enabled && !this.work) this.nextScanAt = Date.now();
    for (const [mint, g] of this.goldenSignals) if (now - g.at > 30 * 60_000 && !this.heldBy(mint)) this.goldenSignals.delete(mint);
    return fresh;
  }

  /**
   * Launch radar: new pump.fun launches since the last scan, within a time budget (a slow poll finishes in the
   * background and is used next scan). A launch that reaches the shortlist is alerted once.
   */
  private async pollLaunches(now: number): Promise<void> {
    const feed = this.d.launches;
    if (!feed) return;
    feed.hold?.([...new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint)))]);
    if (this.d.xfeed?.configured) {
      const posts = await this.d.xfeed.poll(now);
      if (posts.length) feed.addXSignals?.(posts, now);
    }
    this.launchPoll ??= feed.poll(now).then(() => undefined).catch(() => undefined).finally(() => { this.launchPoll = null; });
    await Promise.race([this.launchPoll, new Promise(r => setTimeout(r, 10_000).unref?.())]);
    for (const l of feed.recent(Date.now())) {
      const age = Math.max(0, Math.round((Date.now() - l.at) / 60_000)), ctx = { mint: l.mint, symbol: l.symbol };
      if (this.launchList.has(l.mint)) {
        if (l.rug && !this.launchAlerts.has(`rugseen:${l.mint}`)) {
          this.launchAlerts.add(`rugseen:${l.mint}`);
          this.event('FILTERED', `LAUNCH radar: ${l.symbol} ${l.rug}${this.heldBy(l.mint) ? ' — selling' : ' — never bought'}`, ctx);
          this.alertOnce(`rugradar:${l.mint}`, `LAUNCH radar: ${l.symbol} RUG`, `${l.rug}\n${fomoUrl(l.mint)}`, true);
          continue;
        }
        // Re-reads of the X page and website after the shortlist: a confirmed CA or an exposed impersonator is news.
        const seen = this.launchCa.get(l.mint);
        if (seen === l.ca.status || l.ca.status === 'UNCONFIRMED') continue;
        this.launchCa.set(l.mint, l.ca.status);
        if (l.ca.status === 'IMPERSONATOR') {
          this.event('FILTERED', `LAUNCH radar: ${l.symbol} ${l.ca.detail} — never bought`, ctx);
          this.alertOnce(`fake:${l.mint}`, `LAUNCH radar: ${l.symbol} is an IMPERSONATOR`, `${l.ca.detail}\n${fomoUrl(l.mint)}`, true);
        } else this.event('WATCHLIST', `LAUNCH radar: ${l.symbol} ${l.ca.detail} (${age} min old) · score ${l.score}`, ctx);
        continue;
      }
      if (l.score < LAUNCH_ENTRY.minScore || this.launchCopycats.has(l.mint)) continue;
      // A new launch named like a bigger, older token is a copycat: never shortlisted, never alerted (the FIX6900 clone
      // of 1 Oct came 8 minutes after the real one graduated; a restart had cleared the radar's memory of it).
      const copy = await this.launchCopycat(l);
      if (copy) {
        this.launchCopycats.set(l.mint, copy);
        this.event('FILTERED', `LAUNCH radar: ${l.symbol} ${copy} — not shortlisted`, ctx);
        continue;
      }
      l.shortlistedAt = Date.now(); this.launchList.set(l.mint, l); this.launchCa.set(l.mint, l.ca.status);
      this.event('WATCHLIST', `LAUNCH radar: ${l.symbol} "${l.name}" ${age} min old · score ${l.score} · ${l.reasons.join(' · ')}`, ctx);
      this.alertOnce(`radar:${l.mint}`, `LAUNCH radar: ${l.symbol} (${age} min old)`, `${l.name} · ${l.reasons.join(' · ')}\n${fomoUrl(l.mint)}`, true);
    }
    for (const [mint, l] of this.launchList) if (Date.now() - l.at > 2 * 60 * 60_000) { this.launchList.delete(mint); this.launchCa.delete(mint); }
    if (this.launchCopycats.size > 2_000) this.launchCopycats.delete(this.launchCopycats.keys().next().value!);
  }
  /**
   * A copycat launch: a Solana token with the same name or ticker that is older and already at $50K or more (within
   * 3 days, or still the busier market). One DexScreener search per name, cached for 10 minutes; a failed search
   * never blocks.
   */
  private async launchCopycat(l: { mint: string; name: string; symbol: string; at: number }): Promise<string | null> {
    const keys = [l.symbol, l.name].map(k => k.trim().toLowerCase()).filter(k => k.length > 1);
    if (!keys.length) return null;
    const cacheKey = keys.join('|'), hit = this.copycatSearches.get(cacheKey);
    let pairs: DexPair[];
    if (hit && Date.now() - hit.at < 10 * 60_000) pairs = hit.pairs;
    else {
      try { pairs = await this.d.dex.searchPairs(l.symbol || l.name); } catch { return null; }
      this.copycatSearches.set(cacheKey, { at: Date.now(), pairs });
      if (this.copycatSearches.size > 500) this.copycatSearches.delete(this.copycatSearches.keys().next().value!);
    }
    const original = pairs.filter(p => p.baseToken.address !== l.mint && (keys.includes((p.baseToken.symbol ?? '').trim().toLowerCase()) || keys.includes((p.baseToken.name ?? '').trim().toLowerCase())) &&
      (p.marketCap ?? p.fdv ?? 0) >= 50_000 && p.pairCreatedAt != null && p.pairCreatedAt < l.at && (l.at - p.pairCreatedAt <= COPYCAT_MAX_GAP_MS || (p.volume?.h1 ?? 0) >= 50_000))
      .sort((a, b) => (b.marketCap ?? b.fdv ?? 0) - (a.marketCap ?? a.fdv ?? 0))[0];
    if (!original) return null;
    const mint = original.baseToken.address;
    return `COPYCAT of ${original.baseToken.symbol ?? '?'} ${mint.slice(0, 4)}…${mint.slice(-4)} ($${Math.round(original.marketCap ?? original.fdv ?? 0).toLocaleString('en-US')}, ${Math.round((l.at - original.pairCreatedAt!) / 60_000)} min older)`;
  }

  /** One phone alert per key. Radar news (not a buy signal, nothing held) goes out only with DESK_ALERT_RADAR=true. */
  private alertOnce(key: string, title: string, body: string, radar = false): void {
    if (this.launchAlerts.has(key) || !this.d.notify) return;
    this.launchAlerts.add(key);
    if (this.launchAlerts.size > 5_000) this.launchAlerts.delete(this.launchAlerts.values().next().value!);
    if (radar && !this.d.alertRadar) return;
    void this.d.notify(title, body).catch(() => undefined);
  }

  private rememberName(mint: string, pair: DexPair): void {
    const cap = pair.marketCap ?? pair.fdv ?? null;
    if (cap === null) return;
    for (const key of new Set([pair.baseToken.symbol, pair.baseToken.name].filter((k): k is string => !!k).map(k => k.trim().toLowerCase()))) {
      const byMint = this.names.get(key) ?? new Map();
      byMint.set(mint, { mint, symbol: pair.baseToken.symbol ?? null, marketCapUsd: cap, createdAt: pair.pairCreatedAt ?? null, volume1hUsd: pair.volume?.h1 ?? null, at: Date.now() });
      this.names.set(key, byMint);
    }
    if (this.names.size > 20_000) this.names.delete(this.names.keys().next().value!);
  }

  /**
   * A copycat: an older Solana token with the same ticker or name is at least 3× bigger (and ≥ $100K), and it is
   * either recent (≤ 3 days older) or still the busier market. Fresh clones of a trending coin pump on the original's
   * attention and are dumped within minutes (the second "Jane" on 1 Oct). A revival of a name days later is a new
   * story, not a clone (WIRED on 1 Oct: blocked by a 5-day-old WIRED, then ran $75K → $2.7M), and a launch whose own
   * X account posted its CA is never a copycat. Checked against every token the scanner has seen, then a DexScreener
   * search; a failed search never blocks an entry.
   */
  private async copycatOf(c: Candidate): Promise<string | null> {
    if (this.launchList.get(c.mint)?.ca.status === 'X') return null;
    const keys = [c.symbol, c.name].filter((k): k is string => !!k && k.trim().length > 1).map(k => k.trim().toLowerCase());
    if (!keys.length) return null;
    const ours = c.metrics.marketCapUsd ?? 0, oursVol = c.metrics.volume1hUsd ?? 0;
    const age = c.metrics.tokenAgeMin ?? c.metrics.poolAgeMin, oursCreated = age == null ? Date.now() : Date.now() - age * 60_000;
    type Other = { mint: string; symbol: string | null; marketCapUsd: number; createdAt: number | null; volume1hUsd?: number | null };
    const others: Other[] = keys.flatMap(k => [...(this.names.get(k)?.values() ?? [])]);
    const original = (list: Other[]) => list.filter(o => o.mint !== c.mint && o.marketCapUsd >= Math.max(3 * ours, 100_000) && (o.createdAt === null || o.createdAt < oursCreated) &&
      (o.createdAt === null || oursCreated - o.createdAt <= COPYCAT_MAX_GAP_MS || (o.volume1hUsd ?? 0) >= oursVol))
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd)[0] ?? null;
    let found = original(others);
    if (!found) {
      try {
        const pairs = await this.d.dex.searchPairs(c.symbol ?? c.name ?? '');
        const match = pairs.filter(p => keys.includes((p.baseToken.symbol ?? '').trim().toLowerCase()) || keys.includes((p.baseToken.name ?? '').trim().toLowerCase()));
        for (const p of match) this.rememberName(p.baseToken.address, p);
        found = original(match.map(p => ({ mint: p.baseToken.address, symbol: p.baseToken.symbol ?? null, marketCapUsd: p.marketCap ?? p.fdv ?? 0, createdAt: p.pairCreatedAt ?? null, volume1hUsd: p.volume?.h1 ?? null })));
      } catch { return null; }
    }
    if (!found) return null;
    const older = found.createdAt ? ` · ${Math.round((oursCreated - found.createdAt) / 60_000)} min older` : '';
    return `COPYCAT of ${found.symbol ?? 'a bigger token'} ${found.mint.slice(0, 4)}…${found.mint.slice(-4)} ($${Math.round(found.marketCapUsd).toLocaleString('en-US')}${older})`;
  }

  /**
   * The held token's market cap now: the last scan's market cap moved by the price change since then, measured by the
   * executable quote. Null when the token was not seen in a recent scan.
   */
  private marketCapNow(p: DeskPosition): number | null {
    // A curve token watched by the opening screen: its market cap read from the curve seconds ago.
    const o = this.d.opening?.get(p.mint);
    if (o?.lastUsd != null && o.lastSampleAt != null && Date.now() - o.lastSampleAt <= 15_000 && (o.status === 'SIGNAL' || o.status === 'STRONG')) return o.lastUsd;
    // A graduated pool watched by GOLDEN POCKET: its market cap from the pool's reserves seconds ago.
    const g = this.d.golden?.get(p.mint);
    if (g?.lastUsd != null && g.lastSampleAt != null && Date.now() - g.lastSampleAt <= 15_000) return g.lastUsd;
    const m = this.candidates.get(p.mint)?.metrics;
    if (!m?.marketCapUsd) return null;
    return m.priceUsd && p.lastPriceUsd ? m.marketCapUsd * p.lastPriceUsd / m.priceUsd : m.marketCapUsd;
  }

  /** Positions that count against a strategy's slots: a position without a sell route for longer than the write-off delay does not. */
  private occupied(ledger: DeskLedger): number {
    const limit = DESK.exits.noRoute.writeOffMin * 60_000, now = Date.now();
    return ledger.state.positions.filter(p => !p.noRouteSince || now - p.noRouteSince < limit).length;
  }

  // ------------------------------------------------------------------ entries

  /** TEST: whether a sleeve can still fund one entry plus the account-rent budget the guard requires. */
  private sleeveShort(ledger: DeskLedger, p: StrategyProfile): string | null {
    if (this.d.mode !== 'PAPER' || !this.solUsd || ledger.state.paperCashLamports === null) return null;
    const cash = BigInt(ledger.state.paperCashLamports), entry = BigInt(Math.floor(p.entryUsd / this.solUsd * 1e9));
    if (cash >= entry + 2n * TOKEN_ACCOUNT_RENT_LAMPORTS + 100_000n) return null;
    return `${p.id} · TEST sleeve ${usd(sol(cash) * this.solUsd)} cannot fund a ${usd(p.entryUsd)} entry plus the account-rent budget; waiting for exits (or Reset TEST)`;
  }

  /**
   * Opens up to the strategy's free slots in one scan, best candidate first. A candidate the guard blocks (for
   * example max drag) is skipped for a few minutes and the next one is tried.
   */
  private async maybeEnter(id: StrategyId, ledger: DeskLedger, list: Candidate[], stopped: () => boolean): Promise<void> {
    const p = this.profile(id);
    if (!p.enabled || !this.execution || stopped() || this.entryAllowance === 0) return;
    if (ledger.state.halted || ledger.state.pending) { this.message = ledger.state.halted ?? 'TRANSACTION_RECONCILIATION_REQUIRED'; return; }
    // TEST: a sleeve that ran dry with nothing open becomes a completed cycle and is re-funded, so testing never stalls.
    if (this.d.mode === 'PAPER' && !ledger.state.positions.length && this.sleeveShort(ledger, p)) ledger = await this.cycleSleeve(id, ledger);
    const s = ledger.state, now = Date.now(), note = (mint: string, text: string) => this.entryNotes.set(`${id}:${mint}`, text);
    // Exits in completed TEST cycles count too: a re-funded sleeve never forgets a cooldown.
    const history = [...(this.d.mode === 'PAPER' ? this.cycles.get(id) ?? [] : []).flatMap(c => c.entries), ...s.entries];
    const lastExit = (mint: string) => history.filter(e => e.mint === mint && e.side === 'SELL' && (e.status === 'CONFIRMED' || e.status === 'PAPER_FILLED')).at(-1) ?? null;
    const blockedExit = (mint: string, observedAt: number) => {
      const e = lastExit(mint);
      if (!e) return null;
      const cooldown = e.netPnlUsd !== null && e.netPnlUsd < 0 ? Math.max(p.reentryCooldownMs, this.d.operational?.lossCooldownMs[id] ?? p.reentryCooldownMs) : p.reentryCooldownMs;
      if (now - e.at < cooldown) return `re-entry cooldown until ${hhmm(e.at + cooldown)}`;
      if ((this.d.operational?.freshSignal[id] ?? true) && observedAt <= e.at + DESK.scanMs) return 'fresh post-exit signal required';
      return null;
    };
    const recentExit = (mint: string) => blockedExit(mint, this.candidates.get(mint)?.updatedAt ?? 0) !== null;
    const pool: Candidate[] = [];
    for (const c of list) {
      const holder = this.heldBy(c.mint), exitBlock = blockedExit(c.mint, c.updatedAt), skip = this.entrySkips.get(`${id}:${c.mint}`);
      if (holder) { if (holder !== id) note(c.mint, `held by ${holder}`); continue; }
      if (exitBlock) { note(c.mint, exitBlock); continue; }
      if (skip) { note(c.mint, `${skip.code} at ${hhmm(skip.at)}; retry after ${hhmm(skip.at + DESK.entrySkipMs)}`); continue; }
      pool.push(c);
    }
    pool.sort((a, b) => id === 'CRASH' ? crashRank(b) - crashRank(a) : id === 'FAIR' ? composite(b) - composite(a)
      : id === 'LAUNCH' ? (b.launch?.score ?? 0) - (a.launch?.score ?? 0) || (b.launch?.launchedAt ?? 0) - (a.launch?.launchedAt ?? 0)
      : id === 'OPEN' ? (b.open?.signalAt ?? 0) - (a.open?.signalAt ?? 0)
      : id === 'GOLDEN' ? (b.golden?.signalAt ?? 0) - (a.golden?.signalAt ?? 0)
      : (b.metrics.volume1hUsd ?? 0) - (a.metrics.volume1hUsd ?? 0));
    if (!pool.length) {
      if (id === 'FAIR' && this.drill && this.d.mode === 'PAPER') return this.drillEnter(ledger, stopped, recentExit);
      if (id === 'FAIR') this.message = 'No qualified entry candidate';
      return;
    }
    const open = this.occupied(ledger);
    let slots = p.maxOpenPositions - open, attempts = 0, halt: string | null = null;
    if (slots <= 0) this.note(id, 'WAITING', `${id} · ${pool.length} candidate(s), but ${open}/${p.maxOpenPositions} positions are open`);
    for (const c of pool) {
      if (!halt) {
        if (slots <= 0) halt = `all ${p.maxOpenPositions} ${id} slots in use`;
        else if (attempts >= DESK.maxEntryAttemptsPerScan) halt = `${DESK.maxEntryAttemptsPerScan} entry attempts this scan; next scan`;
        else if (stopped() || !this.execution || s.halted || this.entryAllowance === 0) halt = 'execution stopped or paused';
        else { const short = this.sleeveShort(ledger, p); if (short) { this.note(id, 'WAITING', short); halt = 'TEST sleeve cannot fund an entry'; } }
      }
      if (halt) { note(c.mint, halt); continue; }
      if (c.onchain.decimals === null) { note(c.mint, 'token decimals unknown; deferred'); continue; }
      if (this.heldBy(c.mint)) continue;
      const copy = await this.copycatOf(c);
      if (copy) {
        note(c.mint, copy); this.entrySkips.set(`${id}:${c.mint}`, { at: Date.now(), code: 'COPYCAT' });
        this.event('FILTERED', `${id} · entry refused: ${copy}`, { mint: c.mint, symbol: c.symbol, detail: { strategy: id } });
        continue;
      }
      attempts++; this.notes.delete(id);
      this.event('QUALIFIED', id === 'CRASH' ? `CRASH entry selected: ${c.crash?.summary ?? ''}` : id === 'LAUNCH' ? `LAUNCH entry selected: ${c.launch?.signal.summary ?? ''}`
        : id === 'OPEN' ? `OPEN entry selected: ${c.open?.signal.summary ?? ''}`
        : id === 'GOLDEN' ? `GOLDEN POCKET entry selected: ${c.golden?.signal.summary ?? ''}`
        : id === 'FAIR' ? `FAIR entry candidate selected (composite ${composite(c).toFixed(0)})`
        : `${id} entry selected: ${c.rules?.[id]?.summary ?? ''}`,
        { mint: c.mint, symbol: c.symbol, detail: { strategy: id } });
      const code = await this.execute('BUY', { strategy: id, mint: c.mint, symbol: c.symbol, decimals: c.onchain.decimals, pairAddress: c.pair.address, heldRaw: 0n,
        token2022: c.onchain.token2022 === true, entry: this.entryContext(c, id) }, ledger, stopped);
      if (ledger.position(c.mint)) {
        slots--;
        if (this.entryAllowance !== null) { this.entryAllowance--; if (this.entryAllowance === 0) this.event('SYSTEM', 'Entry allowance used up: no new entries this session; exits continue'); }
        continue;
      }
      const reason = code ?? 'ORDER_FAILED';
      note(c.mint, `blocked: ${reason} at ${hhmm(Date.now())}`);
      if (FUNDS_CODES.has(reason)) { halt = reason; continue; }
      this.entrySkips.set(`${id}:${c.mint}`, { at: Date.now(), code: reason });
    }
  }

  /** TEST: archives a sleeve that ran dry with nothing open as a completed cycle and re-funds it at its planned capital. */
  private async cycleSleeve(id: StrategyId, ledger: DeskLedger): Promise<DeskLedger> {
    await this.orders;
    const key = this.ledgerKey(id, null), stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.d.dir, `ledger-${key}.cycle-${stamp}.json`);
    await ledger.save();
    await fs.rename(ledger.file, target);
    this.cycles.set(id, [...(this.cycles.get(id) ?? []), ledger.state]);
    this.ledgers.delete(key);
    const fresh = await this.ledgerFor(id, null);
    if (this.solUsd) fresh.fundPaper(this.profile(id).capitalUsd, this.solUsd);
    await fresh.save();
    this.notes.delete(id);
    this.event('SYSTEM', `${id} · TEST sleeve ran dry with no open position: cycle ${this.cycles.get(id)!.length} archived (${path.basename(target)}), ` +
      `sleeve re-funded to $${this.profile(id).capitalUsd}; stats and realized PnL continue across cycles`, { detail: { strategy: id } });
    return fresh;
  }
  private async cycleFiles(id: StrategyId): Promise<string[]> {
    const prefix = `ledger-${this.ledgerKey(id, null)}.cycle-`;
    return (await fs.readdir(this.d.dir).catch(() => [] as string[])).filter(n => n.startsWith(prefix) && n.endsWith('.json')).sort();
  }
  private async loadCycles(id: StrategyId): Promise<void> {
    const states: LedgerState[] = [];
    for (const name of await this.cycleFiles(id)) states.push((await DeskLedger.open(path.join(this.d.dir, name), 'PAPER', null, Date.now())).state);
    this.cycles.set(id, states);
  }

  /**
   * TEST drill (FAIR only): when nothing qualifies, open a paper position in the best trending candidate whose safety gates
   * pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity, fair launch), bypassing volume, buy-pressure,
   * concentration and momentum gates. The execution guard still applies. Every drill fill is marked in the ledger.
   */
  private async drillEnter(ledger: DeskLedger, stopped: () => boolean, recentExit: (mint: string) => boolean): Promise<void> {
    if (this.occupied(ledger) >= this.strategies.FAIR.maxOpenPositions) return;
    const short = this.sleeveShort(ledger, this.strategies.FAIR);
    if (short) { this.note('FAIR', 'WAITING', `DRILL paused: ${short}`); return; }
    const safe = (c: Candidate) => ['mintAuthority', 'freezeAuthority', 'contract', 'liquidity', 'fairLaunch'].every(k => c.gates.find(g => g.key === k)?.status === 'PASS');
    const pool = [...this.candidates.values()].filter(c => c.updatedAt >= this.currentScanAt && c.tier === 'TRENDING' && c.onchain.decimals !== null && safe(c) &&
      !this.heldBy(c.mint) && !recentExit(c.mint) && !this.drillSkips.has(c.mint)).sort((a, b) => composite(b) - composite(a));
    if (!pool.length) { this.message = 'DRILL: no trending candidate with passing safety gates yet'; return; }
    for (const c of pool.slice(0, 3)) {
      if (stopped()) return;
      this.event('QUALIFIED', `DRILL entry (strategy gates bypassed; status ${c.status}: ${c.reasons[0] ?? ''})`, { mint: c.mint, symbol: c.symbol });
      await this.execute('BUY', { strategy: 'FAIR', mint: c.mint, symbol: c.symbol, decimals: c.onchain.decimals!, pairAddress: c.pair.address, heldRaw: 0n,
        token2022: c.onchain.token2022 === true, drill: true, entry: this.entryContext(c, 'FAIR') }, ledger, stopped);
      if (ledger.position(c.mint)) return;
      // Blocked by the guard (e.g. max drag): skip it for a while and try the next one.
      this.drillSkips.set(c.mint, Date.now());
    }
  }

  private entryContext(c: Candidate, id: StrategyId): NonNullable<ExecTarget['entry']> {
    const dev = this.deep.get(c.mint)?.onchain.developer ?? null, launch = this.launchList.get(c.mint) ?? this.openSignals.get(c.mint)?.launch ?? null;
    // GOLDEN POCKET: the pattern's stop and (for a retest) the take-profit just under the breakout high, as market caps.
    const g = id === 'GOLDEN' ? c.golden : null;
    return { liquidityUsd: c.metrics.liquidityUsd, creator: dev?.creator ?? launch?.creator ?? null, creatorPct: dev?.heldPct ?? launch?.insiders?.creatorPct ?? null,
      ...(launch?.insiders?.wallets.length ? { insiders: launch.insiders.wallets, insiderPct: launch.insiders.insiderPct, onCurve: c.metrics.migration === 'BONDING_CURVE' } : {}),
      ...(g ? { stopUsd: g.stopUsd, targetUsd: g.kind === 'RETEST' ? g.resistanceUsd * (1 - GOLDEN_EXIT.belowResistancePct / 100) : null } : {}) };
  }

  // ------------------------------------------------------------------ one order through the production path

  /** Orders are serialized across strategies; resolves to the reject code, or null when the order was filled. */
  private execute(side: 'BUY' | 'SELL', t: ExecTarget, ledger: DeskLedger, stopped: () => boolean, probe = false): Promise<string | null> {
    const run = this.orders.then(() => this.executeNow(side, t, ledger, stopped, probe));
    // After a full exit the token account is empty: with the local key its rent goes back to the wallet right away.
    const next = run.then(code => side === 'SELL' && code === null && this.localKey ? this.reclaimRent([t.mint]) : undefined);
    this.orders = next.catch(() => undefined);
    return run;
  }

  /**
   * LIVE with the local key: closes the wallet's empty token accounts for these desk-traded mints and credits the rent
   * to the SELL that charged it. Never throws; a failure leaves the rent for the next session's sweep.
   */
  private async reclaimRent(mints: string[]): Promise<void> {
    const wallet = this.d.wallet(), solUsd = this.solUsd, sender = this.d.sender;
    if (!mints.length || !wallet?.signer || !sender || !solUsd || this.d.mode !== 'LIVE') return;
    try {
      const r = await requestScope.run({ category: 'execution' }, () => reclaimRent({ rpc: this.d.rpc, sender, owner: wallet.owner, signer: wallet.signer!, mints }));
      if (!r) return;
      const share = r.feeLamports / BigInt(r.accounts.length);
      for (const a of r.accounts) {
        const ledger = this.books().map(b => b.ledger).find(l => l.state.entries.some(e => e.mint === a.mint && e.side === 'SELL')) ?? null;
        ledger?.rentReclaimed({ mint: a.mint, lamports: BigInt(a.lamports), feeLamports: share, signature: r.signature, solUsd });
      }
      for (const b of this.books()) await b.ledger.save();
      this.event('SYSTEM', `Account rent reclaimed: ${sol(r.reclaimedLamports).toFixed(6)} SOL from ${r.accounts.length} empty token account(s), fee ${r.feeLamports} lamports (${r.signature})`);
    } catch (error) {
      this.event('WAITING', `Account rent not reclaimed now (retried at the next session start): ${errorMessage(error)}`);
    }
  }

  /**
   * Watch: sells a holding that is not a desk position (bought on FOMO, by hand, …) through the same guarded path as a
   * desk exit — quote, route, pre-flight simulation, local-key signature persisted before broadcast, confirmation. LIVE
   * with the local key only. Tokens a desk strategy holds in this wallet are never part of the sale.
   */
  sellHolding(s: { mint: string; symbol: string | null; amountRaw: bigint; decimals: number; reason: string; onSigned: (signature: string) => Promise<void> }):
    Promise<{ signature: string; detail: string }> {
    const run = this.orders.then(() => this.sellHoldingNow(s));
    this.orders = run.then(() => this.reclaimRent([s.mint])).catch(() => undefined);
    return run;
  }
  private async sellHoldingNow(s: { mint: string; symbol: string | null; amountRaw: bigint; decimals: number; reason: string; onSigned: (signature: string) => Promise<void> }):
    Promise<{ signature: string; detail: string }> {
    const d = this.d, wallet = d.wallet(), ctx = { mint: s.mint, symbol: s.symbol, detail: { strategy: 'WATCH' } };
    if (d.mode !== 'LIVE' || !this.localKey || !wallet?.signer || !d.sender) throw new DeskReject('LOCAL_KEY_REQUIRED');
    const desk = this.books().reduce((a, b) => a + BigInt(b.ledger.position(s.mint)?.qtyRaw ?? '0'), 0n), amountRaw = s.amountRaw - desk;
    if (amountRaw <= 0n) throw new DeskReject('HELD_BY_DESK', 'the desk manages this position; its own exit rules apply');
    if (!this.solUsd) await this.syncWallet(true);
    const solUsd = this.solUsd;
    if (!solUsd) throw new DeskReject('SOL_PRICE_UNAVAILABLE');
    const info = await d.rpc.execute('desk:mint-owner', c => c.getAccountInfo(new PublicKey(s.mint), 'confirmed'));
    const tokenProgram = info?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, exit = this.strategies.CRASH;
    this.event('EXIT', `WATCH · exit signal: ${s.reason}; selling ${uiAmount(amountRaw, s.decimals)} from the wallet`, ctx);
    const guard = new DeskGuard({ mode: 'LIVE', rpc: d.rpc, jupiter: d.jupiter, owner: wallet.owner, mint: s.mint, symbol: s.symbol, decimals: s.decimals, tokenProgram, solUsd,
      slippageBps: exit.slippageBps, exitSlippageBps: exit.exitSlippageBps, maxDragBps: exit.maxDragBps, reserveLamports: DESK.reserveLamports,
      configuredPriorityCap: BigInt(d.cfg.jupiter.maxPriorityFeeLamports), baseEntryUsd: exit.entryUsd, paperCashLamports: null, heldRaw: amountRaw,
      stopped: () => false, enforceDrag: false,
      onSigned: async signature => { await s.onSigned(signature); this.event('SUBMITTED', `Signed by the local key; signature persisted before broadcast: ${signature}`, ctx); },
      event: (stage, message, detail) => this.event(stage, message, { ...ctx, detail: { ...detail, strategy: 'WATCH' } }) });
    const signer: TransactionSigner = { publicKey: wallet.owner, signTransaction: async (tx, context) => {
      guard.signatureState('AWAITING_PHANTOM'); this.event('AWAITING_SIGNATURE', 'Signing with the local key (pre-flight passed)', ctx);
      try { const signed = await wallet.signer!.signTransaction(tx, context); guard.signatureState('SIGNED'); return signed; }
      catch (error) { guard.signatureState('REJECTED'); throw error; }
    } };
    const executor = new LiveExecutor({ cfg: { ...d.cfg, mode: 'LIVE', simulation: false }, rpc: d.rpc, jupiter: d.jupiter, logger: d.logger, owner: wallet.owner, guard },
      signer, d.sender);
    try {
      const fill = await requestScope.run({ category: 'execution' }, () => executor.swap({ side: 'SELL', mint: s.mint, amountRaw, slippageBps: exit.exitSlippageBps }));
      if (guard.lastPreflight) { guard.lastPreflight.outcome = 'CONFIRMED'; guard.lastPreflight.txSignature = fill.signature; this.preflights.push(guard.lastPreflight); }
      const detail = `Sold ${uiAmount(amountRaw, s.decimals)} for ${sol(fill.solDeltaLamports).toFixed(6)} SOL (${usd(sol(fill.solDeltaLamports) * solUsd)})`;
      this.event('CONFIRMED', `WATCH · ${detail}: ${fill.signature}`, ctx);
      if (!fill.signature) throw new DeskReject('LIVE_FILL_WITHOUT_SIGNATURE');
      return { signature: fill.signature, detail };
    } catch (error) {
      if (guard.lastPreflight) this.preflights.push(guard.lastPreflight);
      this.event('FAILED', `WATCH · sale failed: ${errorMessage(error)}`, ctx);
      throw error;
    } finally { this.preflights = this.preflights.slice(-20); }
  }

  private async executeNow(side: 'BUY' | 'SELL', t: ExecTarget,
    ledger: DeskLedger, stopped: () => boolean, probe: boolean): Promise<string | null> {
    const d = this.d, profile = this.profile(t.strategy), ctx = { mint: t.mint, symbol: t.symbol };
    const wallet = d.wallet(), solUsd = this.solUsd;
    if (!probe && stopped()) return 'STOP_REQUESTED';
    if (side === 'SELL' && !ledger.position(t.mint)) return 'UNTRACKED_POSITION';
    if (!wallet) { this.event('WAITING', d.mode === 'PAPER' ? 'No wallet address: connect Phantom or set WALLET_PUBLIC_KEY in .env' : 'Connect Phantom to trade LIVE', ctx); return 'WALLET_REQUIRED'; }
    if (!solUsd) { this.event('WAITING', 'SOL price unavailable; order deferred', ctx); return 'SOL_PRICE_UNAVAILABLE'; }
    if (d.mode === 'LIVE' && (!wallet.signer || !d.sender)) { this.event('WAITING', 'LIVE needs an active Phantom signing session', ctx); return 'WALLET_SESSION_REQUIRED'; }
    let tokenProgram = t.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    if (t.token2022 === undefined) {
      const info = await d.rpc.execute('desk:mint-owner', c => c.getAccountInfo(new PublicKey(t.mint), 'confirmed'));
      if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
    }
    const amountRaw = side === 'BUY' ? BigInt(Math.floor((t.addUsd ?? profile.entryUsd) / solUsd * 1e9)) : t.heldRaw;
    const guard = new DeskGuard({ mode: d.mode, rpc: d.rpc, jupiter: d.jupiter, owner: wallet.owner, mint: t.mint, symbol: t.symbol, decimals: t.decimals,
      tokenProgram, solUsd, slippageBps: profile.slippageBps, exitSlippageBps: profile.exitSlippageBps, maxDragBps: profile.maxDragBps, reserveLamports: DESK.reserveLamports,
      configuredPriorityCap: BigInt(d.cfg.jupiter.maxPriorityFeeLamports), baseEntryUsd: profile.entryUsd,
      paperCashLamports: d.mode === 'PAPER' ? BigInt(ledger.state.paperCashLamports ?? '0') : null, heldRaw: t.heldRaw, stopped,
      enforceDrag: !(t.drill && d.mode === 'PAPER'),
      onSigned: async signature => {
        ledger.state.pending = { side, mint: t.mint, at: Date.now(), signature };
        await ledger.save();
        this.event('SUBMITTED', `Signed by ${this.localKey ? 'the local key' : 'Phantom'}; signature persisted before broadcast: ${signature}`, ctx);
      },
      event: (stage, message, detail) => this.event(stage, message, { ...ctx, detail: { ...detail, strategy: t.strategy } }) });
    const signer: TransactionSigner = d.mode === 'PAPER' ? paperSigner(wallet.owner) : {
      publicKey: wallet.owner,
      signTransaction: async (tx, context) => {
        guard.signatureState('AWAITING_PHANTOM');
        this.event('AWAITING_SIGNATURE', this.localKey ? 'Signing with the local key (pre-flight passed)' : 'AWAITING PHANTOM SIGNATURE — review the transaction in Phantom', ctx);
        try { const signed = await wallet.signer!.signTransaction(tx, context); guard.signatureState('SIGNED'); return signed; }
        catch (error) {
          const code = error instanceof SigningError ? error.code : 'SIGNATURE_FAILED';
          guard.signatureState(code === 'SIGNING_DEADLINE_EXPIRED' ? 'EXPIRED' : 'REJECTED');
          throw error;
        }
      },
    };
    const executor = new LiveExecutor({ cfg: { ...d.cfg, mode: 'LIVE', simulation: false }, rpc: d.rpc, jupiter: d.jupiter, logger: d.logger, owner: wallet.owner, guard },
      signer, d.sender ?? unreachableSender);
    if (d.mode === 'LIVE') { ledger.state.pending = { side, mint: t.mint, at: Date.now(), signature: null }; await ledger.save(); }
    const record = (p: Preflight | null) => { if (p) { this.preflights.push(p); this.preflights = this.preflights.slice(-20); } };
    try {
      const fill = await requestScope.run({ category: 'execution' }, () => executor.swap({ side, mint: t.mint, amountRaw, slippageBps: side === 'BUY' ? profile.slippageBps : profile.exitSlippageBps }));
      const order = guard.lastOrder!;
      const row = ledger.book({ side, mint: t.mint, symbol: t.symbol, decimals: t.decimals, pairAddress: t.pairAddress, inAmountRaw: fill.inAmountRaw,
        outAmountRaw: fill.outAmountRaw, solDeltaLamports: fill.solDeltaLamports, feeLamports: fill.feeLamports, rentLamports: fill.rentLamports,
        router: 'Jupiter', route: order.route, routerFeeUsd: sol(order.routerFee) * solUsd, txSignature: fill.signature, solUsd, at: Date.now(), note: null, entry: t.entry, add: t.add });
      if (guard.lastPreflight) { guard.lastPreflight.outcome = 'CONFIRMED'; guard.lastPreflight.txSignature = fill.signature; }
      record(guard.lastPreflight);
      this.event('CONFIRMED', `${side} confirmed on-chain: ${fill.signature}`, ctx);
      this.bookedEvents(side, t.strategy, row, ctx);
      return null;
    } catch (error) {
      record(guard.lastPreflight);
      const cause = error instanceof SwapError ? error.cause : error;
      const code = cause instanceof DeskReject || cause instanceof SigningError ? cause.code : 'ORDER_FAILED';
      if (probe && cause instanceof PaperExecution) {
        if (guard.lastPreflight) guard.lastPreflight.outcome = 'PROBE_NOT_BOOKED';
        this.event('PREFLIGHT', 'PROBE complete — pre-flight passed; stopped where LIVE would request a Phantom signature. Nothing booked.', ctx);
        return null;
      } else if (probe) {
        this.event('FAILED', `PROBE stopped: ${cause instanceof DeskReject ? cause.message : errorMessage(error)}`, ctx);
      } else if (d.mode === 'PAPER' && cause instanceof PaperExecution && guard.lastOrder && guard.lastSimulation.status === 'PASSED') {
        this.paperFill(side, t, guard, ledger, solUsd, 'Filled from the passed unsigned RPC simulation');
        return null;
      } else if (d.mode === 'PAPER' && side === 'SELL' && guard.lastOrder && !(cause instanceof DeskReject && ['STOP_REQUESTED', 'UNTRACKED_POSITION'].includes(cause.code))) {
        // A TEST position is not held on-chain, so its exit cannot be simulated against the wallet.
        guard.lastSimulation = { status: 'NOT_POSSIBLE', detail: 'TEST position is not held by the wallet; exit valued at the executable Jupiter quote', solDelta: null, tokenDelta: null };
        this.event('SIMULATION', `NOT POSSIBLE — ${guard.lastSimulation.detail}`, ctx);
        this.paperFill(side, t, guard, ledger, solUsd, guard.lastSimulation.detail);
        return null;
      } else {
        this.failed(side, t, guard, ledger, error, solUsd);
      }
      return cause instanceof PaperExecution ? 'SIMULATION_NOT_PASSED' : code;
    } finally {
      await ledger.save();
    }
  }

  private paperFill(side: 'BUY' | 'SELL', t: ExecTarget,
    guard: DeskGuard, ledger: DeskLedger, solUsd: number, detail: string): void {
    const drill = t.drill || (side === 'SELL' && !!ledger.state.entries.filter(e => e.mint === t.mint && e.side === 'BUY').at(-1)?.note?.startsWith('DRILL'));
    const drag = guard.lastPreflight?.dragPct;
    const note = drill ? `DRILL — strategy gates bypassed${drag != null ? ` · drag ${drag.toFixed(2)}%` : ''} · ${detail}` : detail;
    const o = guard.lastOrder!, q = o.quote, ctx = { mint: t.mint, symbol: t.symbol };
    const fee = o.fee > 0n ? o.fee : BASE_FEE_LAMPORTS + o.priority;
    const buy = side === 'BUY';
    const tokens = buy ? guard.lastSimulation.tokenDelta ?? BigInt(q.outAmount) : BigInt(q.inAmount);
    // BUY: the SOL change measured by the unsigned simulation (swap, fees and every account rent it creates).
    const simulated = buy ? guard.lastSimulation.solDelta : null;
    const solDelta = buy ? (simulated !== null && -simulated >= BigInt(q.inAmount) ? simulated : -(BigInt(q.inAmount) + fee + o.rent)) : BigInt(q.outAmount) - fee;
    const rent = buy ? (-solDelta - BigInt(q.inAmount) - fee > o.rent ? -solDelta - BigInt(q.inAmount) - fee : o.rent) : 0n;
    const pre = guard.lastPreflight, held = buy ? null : ledger.position(t.mint);
    if (pre) { pre.outcome = 'PAPER_FILLED'; pre.signature = 'NOT_REQUESTED_TEST'; if (!buy) pre.simulation = { ...pre.simulation, status: guard.lastSimulation.status, detail: guard.lastSimulation.detail }; }
    this.event('SUBMITTED', `TEST — no signature requested, nothing submitted; paper execution recorded (${t.strategy})`, ctx);
    const row = ledger.book({ side, mint: t.mint, symbol: t.symbol, decimals: t.decimals, pairAddress: t.pairAddress, inAmountRaw: BigInt(q.inAmount),
      outAmountRaw: buy ? tokens : BigInt(q.outAmount), solDeltaLamports: solDelta, feeLamports: fee, rentLamports: rent, router: 'Jupiter', route: o.route,
      routerFeeUsd: sol(o.routerFee) * solUsd, txSignature: null, solUsd, at: Date.now(), note, entry: t.entry, add: t.add });
    this.bookedEvents(side, t.strategy, row, ctx);
    // As LIVE with the local key does: the emptied token account is closed and its rent returns (minus the base fee).
    const heldRent = held ? BigInt(held.rentLamports) : 0n, ata = heldRent < TOKEN_ACCOUNT_RENT_LAMPORTS ? heldRent : TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (ata > BASE_FEE_LAMPORTS) {
      ledger.rentReclaimed({ mint: t.mint, lamports: ata, feeLamports: BASE_FEE_LAMPORTS, signature: null, solUsd });
      this.event('SYSTEM', `TEST — token account closed on paper: ${sol(ata).toFixed(6)} SOL rent returned (fee ${BASE_FEE_LAMPORTS} lamports)`, ctx);
    }
  }

  private bookedEvents(side: 'BUY' | 'SELL', id: StrategyId, row: ReturnType<DeskLedger['book']>, ctx: { mint: string; symbol: string | null }): void {
    const c = { ...ctx, detail: { strategy: id } };
    if (side === 'BUY') this.event('POSITION', `${id} · ${row.note?.startsWith('ADD') ? `position increased (${(row.note.split(' · ')[0] ?? 'add').toLowerCase()})` : 'position opened'}: ${row.quantity} @ $${row.entryPriceUsd?.toPrecision(6) ?? 'UNKNOWN'} · fee $${row.networkFeeUsd?.toFixed(4)}`, c);
    else {
      this.event('EXIT', `${id} · position closed: ${row.quantity} @ $${row.exitPriceUsd?.toPrecision(6) ?? 'UNKNOWN'}`, c);
      this.event('PNL', `${id} · realized: gross ${usd(row.grossPnlUsd)} · fees ${usd(row.totalFeesUsd)} · net ${usd(row.netPnlUsd)}`, c);
    }
  }

  private failed(side: 'BUY' | 'SELL', t: ExecTarget, guard: DeskGuard, ledger: DeskLedger, error: unknown, solUsd: number): void {
    const ctx = { mint: t.mint, symbol: t.symbol }, s = ledger.state;
    const swap = error instanceof SwapError ? error : null, cause = swap?.cause ?? error;
    const reason = cause instanceof DeskReject ? cause.message : cause instanceof SigningError ? `${this.localKey ? 'Local key' : 'Phantom'}: ${cause.code}` : errorMessage(error);
    const signature = s.pending?.signature ?? swap?.signature ?? null;
    if (guard.lastPreflight) guard.lastPreflight.outcome = guard.lastPreflight.signature === 'SIGNED' ? 'FAILED' : 'BLOCKED';
    if (this.d.mode === 'LIVE' && signature) {
      if (swap?.stage === 'confirm') {
        // Known outcome: failed on-chain (fee paid) or expired without landing.
        ledger.failed({ side, mint: t.mint, symbol: t.symbol, router: 'Jupiter', route: guard.lastOrder?.route ?? '', feeLamports: swap.feeLamports, solUsd,
          txSignature: signature, at: Date.now(), note: reason, unknown: false });
        s.pending = null;
        this.event('FAILED', `${side} failed after submission: ${reason} (${signature})`, ctx);
      } else {
        s.halted = 'TRANSACTION_RECONCILIATION_REQUIRED';
        ledger.failed({ side, mint: t.mint, symbol: t.symbol, router: 'Jupiter', route: guard.lastOrder?.route ?? '', feeLamports: 0n, solUsd,
          txSignature: signature, at: Date.now(), note: `Outcome unknown: ${reason}`, unknown: true });
        this.stop('transaction outcome unknown');
        this.event('FAILED', `Outcome UNKNOWN for ${signature}; execution halted until reconciled — no automatic retry`, ctx);
      }
      return;
    }
    s.pending = null;
    const where = guard.lastPreflight ? (guard.lastPreflight.signature === 'REJECTED' || guard.lastPreflight.signature === 'EXPIRED' ? (this.localKey ? 'at signing' : 'at Phantom signature') : 'at pre-flight')
      : guard.quoted ? 'after quote' : 'before quote';
    this.event(cause instanceof DeskReject && cause.code === 'FEE_CAP' ? 'FILTERED' : 'FAILED', `${t.strategy} · ${side} blocked ${where}: ${reason}`, { ...ctx, detail: { strategy: t.strategy } });
    if (cause instanceof SigningError) this.pause();
  }

  // ------------------------------------------------------------------ view

  status(wallet: DeskStatus['wallet']): DeskStatus {
    const d = this.d, books = this.books(), solUsd = this.solUsd;
    const positions: DeskPosition[] = books.flatMap(b => b.ledger.state.positions.map(p => ({ ...p, strategy: b.id, exitRequested: this.manualExits.has(p.mint) })));
    // A position without an executable valuation yet makes totals unknown, never silently $0.
    const valued = positions.every(p => p.lastValueLamports !== null);
    const value = valued ? positions.reduce((a, p) => a + BigInt(p.lastValueLamports!), 0n) : null;
    const rent = positions.reduce((a, p) => a + BigInt(p.rentLamports), 0n);
    const unrealized = solUsd && valued ? positions.reduce((a, p) => a + sol(BigInt(p.lastValueLamports!)) * solUsd - p.costUsd, 0) : null;
    const configured = !wallet.connected && d.mode === 'PAPER' && this.walletView ? this.walletView.owner : null;
    if (configured) wallet = { connected: false, address: configured, source: 'CONFIGURED' };
    // LIVE with the local key: the wallet is the key's address, whatever the browser has connected.
    if (this.localKey) wallet = { connected: true, address: this.walletView?.owner ?? this.d.wallet()?.owner.toBase58() ?? null, source: 'LOCAL_KEY' };
    const native = this.walletView && this.walletView.owner === wallet.address ? this.walletView.native : null;
    // TEST cash is the sum of the strategy sleeves; LIVE strategies share the wallet.
    const sleeves = books.map(b => b.ledger.state.paperCashLamports).filter((x): x is string => x !== null);
    const paper = d.mode === 'PAPER' && sleeves.length ? sleeves.reduce((a, x) => a + BigInt(x), 0n) : null;
    const budget = d.mode === 'PAPER' ? paper : native;
    const spendable = budget === null ? null : budget - DESK.reserveLamports > 0n ? budget - DESK.reserveLamports : 0n;
    const cash = d.mode === 'PAPER' ? paper : native;
    // TEST: completed sleeve cycles stay in the ledger view; they are part of the same test history.
    const rows = books.flatMap(b => [...(d.mode === 'PAPER' ? this.cycles.get(b.id) ?? [] : []).flatMap(c => c.entries), ...b.ledger.state.entries].slice(-100).reverse()
      .map(e => ({ ...e, strategy: b.id }))).sort((a, b) => b.at - a.at).slice(0, 100);
    return {
      mode: d.mode, label: this.localKey ? `${LABEL.LIVE} · SIGNED BY THE LOCAL KEY` : LABEL[d.mode], scanner: this.scanner, execution: this.execution, drill: this.drill, wallet,
      signer: d.mode === 'LIVE' ? (this.localKey ? 'LOCAL_KEY' : 'PHANTOM') : null, entriesLeft: d.mode === 'LIVE' ? this.entryAllowance : null,
      operational: d.operational,
      strategies: this.ids().map(id => this.strategyView(id)),
      presets: PRESETS,
      // Newest first within the last 15 minutes, then by score and X followers: the more followers, the higher.
      launches: [...this.launchList.values()].sort((a, b) => Number(Date.now() - b.at < 15 * 60_000) - Number(Date.now() - a.at < 15 * 60_000) ||
        b.score - a.score || (b.reach?.followers ?? 0) - (a.reach?.followers ?? 0) || b.at - a.at).slice(0, 25).map(l => {
        const c = this.candidates.get(l.mint);
        return { mint: l.mint, symbol: l.symbol, name: l.name, at: l.at, score: l.score, reasons: l.reasons, x: l.x.url, website: l.site?.url ?? l.meta?.website ?? null, ca: l.ca,
          followers: l.reach?.followers ?? null, bestViews: l.reach?.bestViews ?? null, accountAgeDays: l.reach?.accountAgeDays ?? null, ownX: l.reach?.own ?? null,
          insiders: l.insiders?.detail ?? null, insiderPct: l.insiders?.insiderPct ?? null, rug: l.rug ?? null, xPosts: l.xSignals?.length ?? 0,
          review: l.review ? { verdict: l.review.verdict, idea: l.review.idea, professionalism: l.review.professionalism, aiGenerated: l.review.aiGenerated,
            summary: l.review.summary, scamSignals: l.review.scamSignals } : null,
          marketCapUsd: c?.metrics.marketCapUsd ?? null, signal: c?.launch?.signal.signal ?? false,
          status: this.heldBy(l.mint) ? `held by ${this.heldBy(l.mint)}` : c?.entryNotes?.LAUNCH ?? c?.launch?.signal.summary ?? 'waiting for market data' };
      }),
      capital: {
        plannedStartingCapitalUsd: d.capital.plannedStartingCapitalUsd, baseEntryUsd: d.capital.baseEntryUsd, reserveSol: sol(DESK.reserveLamports),
        maxDragPct: Number(DESK.maxDragBps) / 100, slippageBps: d.capital.slippageBps,
        walletSol: native === null ? null : sol(native), walletUsd: native !== null && solUsd ? sol(native) * solUsd : null, solUsd,
        availableSol: native === null ? null : sol(native), reservedSol: sol(DESK.reserveLamports + rent),
        spendableUsd: spendable !== null && solUsd ? sol(spendable) * solUsd : null,
        paperCashUsd: paper !== null && solUsd ? sol(paper) * solUsd : null, openPositions: positions.length,
        positionsValueUsd: solUsd && value !== null ? sol(value) * solUsd : null, unrealizedPnlUsd: unrealized,
        realizedPnlUsd: books.reduce((a, b) => a + b.ledger.state.realizedPnlUsd, 0), totalFeesUsd: books.reduce((a, b) => a + b.ledger.state.feesUsd, 0),
        equityUsd: cash !== null && solUsd && value !== null ? sol(cash + value + rent) * solUsd : null, lastWalletSync: this.walletView?.at ?? null,
      },
      message: this.message, halted: books.find(b => b.ledger.state.halted)?.ledger.state.halted ?? null,
      lastScanAt: this.lastScanAt, nextScanAt: this.nextScanAt, scanning: this.busy,
      events: this.events.list(250).reverse(),
      candidates: [...this.candidates.values()].map(c => {
        const notes = Object.fromEntries(this.ids().flatMap(id => { const n = this.entryNotes.get(`${id}:${c.mint}`); return n ? [[id, n]] : []; }));
        return { ...c, entryNotes: notes, stale: c.updatedAt < this.lastCompletedScanAt, verdicts: this.verdicts(c) };
      }).sort((a, b) => Number(a.stale) - Number(b.stale) || rank(b) - rank(a) || Number(!!b.crash?.signal) - Number(!!a.crash?.signal) || composite(b) - composite(a)).slice(0, 40),
      ...(d.opening ? { opening: { counts: d.opening.counts(), list: d.opening.list().slice(0, 20).map(o => ({ mint: o.mint, symbol: o.symbol, name: o.name, at: o.at, status: o.status,
        openHighUsd: o.openHighUsd, lowUsd: o.lowUsd, lastUsd: o.lastUsd, peakUsd: o.peakUsd, signalAt: o.signalAt, signalUsd: o.signalUsd, detail: o.detail,
        held: this.heldBy(o.mint) ?? null, entry: this.candidates.get(o.mint)?.open?.signal.summary ?? null })) } } : {}),
      ...(d.golden ? { golden: { counts: d.golden.counts(), entryKinds: this.strategies.GOLDEN.entryKinds ?? ['ONLY_UP'], list: d.golden.list().slice(0, 25).map(w => ({ mint: w.mint,
        symbol: w.symbol ?? this.candidates.get(w.mint)?.symbol ?? null, pool: w.pool, startAt: w.startAt, phase: w.state.phase, highUsd: w.state.high, lowUsd: w.state.low, topUsd: w.state.top, lastUsd: w.lastUsd, peakUsd: w.peakUsd, detail: w.state.detail,
        entry: w.state.entry ? { kind: w.state.entry.kind, at: w.state.entry.at, fillUsd: w.state.entry.price, stopUsd: w.state.entry.stop, resistanceUsd: w.state.entry.resistance, zone: w.state.entry.zone } : null,
        held: this.heldBy(w.mint) ?? null, verdict: this.candidates.get(w.mint)?.golden?.signal.summary ?? null })) } } : {}),
      ...(d.xfeed ? { xFeed: (({ configured, lastPollAt, lastError, posts, signals }) => ({ configured, lastPollAt, lastError, posts, signals }))(d.xfeed.status()) } : {}),
      preflights: [...this.preflights].reverse(), positions, ledger: rows,
      sources: this.sources, path: this.pathView(),
    };
  }

  private strategyView(id: StrategyId): StrategyView {
    const p = this.profile(id), s = this.ledgerOf(id)?.state ?? null, solUsd = this.solUsd, past = this.d.mode === 'PAPER' ? this.cycles.get(id) ?? [] : [];
    const positions = s?.positions ?? [];
    const valued = positions.every(x => x.lastValueLamports !== null);
    const stats = strategyStats([...past.flatMap(c => c.entries), ...(s?.entries ?? [])]);
    return {
      id, label: p.label, summary: p.summary, enabled: p.enabled, capitalUsd: p.capitalUsd, entryUsd: p.entryUsd, slippageBps: p.slippageBps,
      maxDragPct: Number(p.maxDragBps) / 100, maxOpenPositions: p.maxOpenPositions, positionCheckSec: p.positionCheckMs / 1000, exitRules: exitRuleText(p),
      reentryCooldownMin: p.reentryCooldownMs / 60_000,
      cashUsd: this.d.mode === 'PAPER' && s?.paperCashLamports != null && solUsd ? sol(BigInt(s.paperCashLamports)) * solUsd : null,
      openPositions: positions.length, realizedPnlUsd: past.reduce((a, c) => a + c.realizedPnlUsd, s?.realizedPnlUsd ?? 0),
      feesUsd: past.reduce((a, c) => a + c.feesUsd, s?.feesUsd ?? 0), halted: s?.halted ?? null, cycles: past.length,
      unrealizedPnlUsd: solUsd && valued ? positions.reduce((a, x) => a + sol(BigInt(x.lastValueLamports!)) * solUsd - x.costUsd, 0) : null,
      stats, scale: scaleAdvice(p, stats, this.d.mode),
      ...(p.rule ? { spec: p.rule } : {}),
    };
  }

  private pathView(): DeskStatus['path'] {
    const d = this.d, rpc = d.cfg.rpc.endpoints.map(e => { try { return new URL(e).hostname; } catch { return 'configured RPC'; } }).join(', ');
    const test = d.mode === 'PAPER', f = this.strategies.FAIR, c = this.strategies.CRASH;
    return [
      { layer: 'Market data', provider: 'DexScreener (pairs, boosts, profiles) · GeckoTerminal (trending/new pools, trades)' },
      { layer: 'Scanner', provider: 'Trending / migrated < $1M (priority < $100K) · ultra-early $2K–$10K, monitored to $100K' },
      { layer: 'Strategies (parallel)', provider: `FAIR: fair launch + momentum in 2 scans${f.enabled ? '' : ' (OFF)'} · CRASH: young pumping pools, entered in 1 scan, exits within ${c.exits.maxHoldMin} min${c.enabled ? '' : ' (OFF)'}` },
      { layer: 'Risk engine', provider: `Hard gates + execution guard (reserve ${sol(DESK.reserveLamports)} SOL, max drag FAIR ${Number(f.maxDragBps) / 100}% / CRASH ${Number(c.maxDragBps) / 100}%)` },
      { layer: 'Quote provider', provider: 'Jupiter Swap API /quote' },
      { layer: 'DEX / router', provider: 'Jupiter aggregator — the DEX route is shown per order' },
      { layer: 'Transaction builder', provider: 'Jupiter /swap for the connected wallet address' },
      { layer: 'RPC', provider: rpc || 'not configured' },
      { layer: 'Wallet provider', provider: 'Phantom browser extension' },
      { layer: 'Signer', provider: test ? 'None — TEST never requests a signature' : 'Phantom, one approval per transaction' },
      { layer: 'Submission', provider: test ? 'None — paper fill from the unsigned simulation' : 'RPC sendTransaction with rebroadcast' },
      { layer: 'Confirmation', provider: test ? 'Not applicable' : 'RPC signature status (confirmed) + on-chain balance deltas' },
    ];
  }
}

const usd = (n: number | null) => n === null ? 'UNKNOWN' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(4)}`;
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
/** The provider refused this request (HTTP 4xx such as no route), as opposed to an outage. Matched by name across module copies. */
const refused = (error: unknown) => error instanceof Error && error.name === 'DataError' && (error as Error & { kind?: unknown }).kind === 'rejected';
const rank = (c: Candidate) => ({ QUALIFIED: 4, WAITING: 3, WATCHLIST: 2, FILTERED: 1 })[c.status];
function composite(c: Candidate): number {
  const v = (k: string) => c.scores.find(s => s.key === k)?.score ?? 0;
  return v('MOMENTUM') * 0.3 + v('MARKET') * 0.2 + v('ONCHAIN') * 0.2 + v('RISK') * 0.15 + v('FUNDAMENTAL') * 0.1 + v('SOCIAL') * 0.05;
}
/** CRASH ranks by live flow: 5-minute volume weighted by buy pressure. */
const crashRank = (c: Candidate) => (c.metrics.volume5mUsd ?? 0) * Math.min(c.metrics.buySellRatio5m ?? 0, 3);
/** Entry rejections that no other candidate can pass either in this scan. */
const FUNDS_CODES = new Set(['TEST_CAPITAL_INSUFFICIENT', 'SOL_RESERVE_FLOOR', 'FEE_UNAFFORDABLE', 'WALLET_REQUIRED', 'SOL_PRICE_UNAVAILABLE', 'WALLET_SESSION_REQUIRED', 'STOP_REQUESTED']);
const unreachableSender = { sendAndConfirm: async () => { throw new Error('TEST never submits a transaction'); } } as unknown as TransactionSender;

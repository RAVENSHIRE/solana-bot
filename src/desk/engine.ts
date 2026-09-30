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
import { DESK, STRATEGY_IDS, strategyProfiles, type DeskCapital, type DeskOperational, type LiveSignerKind, type StrategyProfile } from './config';
import { EventLog } from './events';
import { DeskLedger, type LedgerState } from './ledger';
import { discover, pairMetrics, selectPair, tierFor, type Discovered } from './discovery';
import { creatorHolding, gatherOnchain, type OnchainEvidence } from './onchain';
import { launchCheck, type LaunchCheck } from './launch';
import { GraduationFeed } from './migrations';
import { reclaimRent } from './rent';
import { assessAuthenticity, checkWebsite, parseXLink, type WebsiteCheck, type XClient } from './social';
import { analyze, type SocialEvidence, type WatchState } from './analysis';
import { DeskGuard, DeskReject, PaperExecution, paperSigner } from './guard';
import { crashCheck, crashMarketHint, exitReason, exitRuleText, scaleAdvice, strategyStats } from './strategies';
import type { Candidate, DeskEvent, DeskMode, DeskPosition, DeskStatus, Preflight, Stage, StrategyId, StrategyView } from './types';

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
  strategies?: Record<StrategyId, StrategyProfile>;
  operational?: DeskOperational;
  /** LIVE: who signs (default PHANTOM) and how many new entries one LIVE session may open. */
  signerKind?: LiveSignerKind;
  liveMaxEntries?: number;
}

interface Deep { at: number; onchain: OnchainEvidence; social: SocialEvidence }
interface Staged { found: Discovered; pair: DexPair; tier: 'TRENDING' | 'ULTRA_EARLY'; metrics: ReturnType<typeof pairMetrics>; crashHint: boolean }
interface ExecTarget {
  strategy: StrategyId; mint: string; symbol: string | null; decimals: number; pairAddress: string; heldRaw: bigint; token2022?: boolean; drill?: boolean;
  entry?: { liquidityUsd: number | null; creator: string | null; creatorPct: number | null };
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
  readonly strategies: Record<StrategyId, StrategyProfile>;
  private drillSkips = new Map<string, number>();
  /** `${strategy}:${mint}` → when and why the guard last blocked an entry; skipped for DESK.entrySkipMs. */
  private entrySkips = new Map<string, { at: number; code: string }>();
  /** `${strategy}:${mint}` → why this scan did not enter a token (shown on the candidate). */
  private entryNotes = new Map<string, string>();
  /** TEST: sleeves that ran dry and were re-funded; their trades still count in the strategy stats. */
  private cycles = new Map<StrategyId, LedgerState[]>();
  private currentScanAt = 0;
  private readonly graduations: GraduationFeed;
  private lastCompletedScanAt = 0;
  private notes = new Map<string, string>();
  private creatorChecks = new Map<string, number>();
  private holdLog = new Map<string, { pct: number; at: number }>();
  private lastPositionCheckAt: Record<StrategyId, number> = { FAIR: 0, CRASH: 0 };
  /** Mints the owner asked to sell now (EXIT NOW); kept until the position is gone, so a failed sell is retried. */
  private manualExits = new Set<string>();
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
    this.strategies = { FAIR: { ...base.FAIR, exits: { ...base.FAIR.exits } }, CRASH: { ...base.CRASH, exits: { ...base.CRASH.exits } } };
    for (const id of STRATEGY_IDS) this.strategies[id].enabled = d.operational?.strategyEnabled[d.mode][id] ?? (d.mode === 'LIVE' && id === 'CRASH' ? false : this.strategies[id].enabled);
  }

  static async create(d: DeskDeps): Promise<DeskEngine> {
    const engine = new DeskEngine(d);
    await engine.events.load();
    if (d.operational?.deploymentMode !== 'LOCKED') await engine.loadSettings();
    if (d.mode === 'PAPER') for (const id of STRATEGY_IDS) { await engine.ledgerFor(id, null); await engine.loadCycles(id); }
    return engine;
  }

  get mode(): DeskMode { return this.d.mode; }
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
    return STRATEGY_IDS.flatMap(id => { const ledger = this.ledgerOf(id); return ledger ? [{ id, p: this.strategies[id], ledger }] : []; });
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
    const on = STRATEGY_IDS.filter(id => this.strategies[id].enabled).join(' + ') || 'none';
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
    for (const id of STRATEGY_IDS) await this.ledgerFor(id, owner);
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
    const p = this.strategies[id];
    if (p.enabled === enabled) return;
    p.enabled = enabled;
    this.event('SYSTEM', `${p.label} strategy ${enabled ? 'ENABLED' : 'DISABLED — no new entries; open positions keep their exits'}`, { detail: { strategy: id } });
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
    for (const id of STRATEGY_IDS) if (typeof saved.strategies?.[id] === 'boolean') this.strategies[id].enabled = saved.strategies[id] as boolean;
    if (this.d.mode === 'PAPER' && typeof saved.drill === 'boolean') this.drill = saved.drill;
  }
  private async saveSettings(): Promise<void> {
    const body = { strategies: Object.fromEntries(STRATEGY_IDS.map(id => [id, this.strategies[id].enabled])), drill: this.drill, updatedAt: new Date().toISOString() };
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
    for (const id of STRATEGY_IDS) {
      const key = this.ledgerKey(id, null), file = path.join(this.d.dir, `ledger-${key}.json`), old = this.ledgers.get(key);
      this.ledgers.delete(key);
      if (old && (old.state.entries.length || old.state.positions.length)) {
        await old.save();
        const target = path.join(this.d.dir, `ledger-${key}.archived-${stamp}.json`);
        await fs.rename(file, target);
        archived.push(path.basename(target));
      } else await fs.rm(file, { force: true });
      const fresh = await this.ledgerFor(id, null);
      if (this.solUsd) fresh.fundPaper(this.strategies[id].capitalUsd, this.solUsd);
      await fresh.save();
    }
    for (const id of STRATEGY_IDS) {
      for (const name of await this.cycleFiles(id)) {
        const target = name.replace('.cycle-', `.archived-${stamp}.cycle-`);
        await fs.rename(path.join(this.d.dir, name), path.join(this.d.dir, target));
        archived.push(target);
      }
      this.cycles.delete(id);
    }
    this.preflights = []; this.entrySkips.clear(); this.drillSkips.clear(); this.holdLog.clear(); this.notes.clear(); this.entryNotes.clear(); this.message = null;
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
    if (this.positionWork) return;
    const now = Date.now();
    const due = STRATEGY_IDS.filter(id => (this.ledgerOf(id)?.state.positions.length ?? 0) > 0 && now - this.lastPositionCheckAt[id] >= this.strategies[id].positionCheckMs);
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
    await this.checkPositions(STRATEGY_IDS, stopped);
    if (stopped()) return;
    for (const [k, at] of this.drillSkips) if (Date.now() - at > 15 * 60_000) this.drillSkips.delete(k);
    for (const [k, v] of this.entrySkips) if (Date.now() - v.at > DESK.entrySkipMs) this.entrySkips.delete(k);
    const found = await requestScope.run({ category: 'discovery', signal: AbortSignal.timeout(DESK.discoveryBudgetMs) },
      () => discover(d.dex, d.gecko, this.watchlist(), () => this.graduations.poll()));
    this.sources = found.sources;
    const staged = await this.stage(found.tokens);
    // CRASH is time-critical: safety evidence for pumping young pools first, entries right after, and only then
    // the remaining evidence and the rate-limited launch-history checks that FAIR needs.
    const due = this.deepDue(staged.list, started);
    await this.deepAnalyses(due.filter(s => s.crashHint));
    if (this.strategies.CRASH.enabled && !stopped()) {
      const signals = staged.list.filter(s => s.crashHint).map(s => this.assess(s, started)).filter(c => c.crash?.signal);
      const ledger = this.ledgerOf('CRASH');
      if (ledger && signals.length) await this.maybeEnter('CRASH', ledger, signals, stopped);
    }
    if (stopped()) return;
    await this.slowPath(staged.list, due.filter(s => !s.crashHint), started);
    const counts = this.finalize(staged.list, staged.filtered, started);
    this.lastCompletedScanAt = started;
    if (stopped()) return;
    this.event('SCANNING', `Scan finished: ${found.tokens.size} tokens discovered, ${counts.qualified} qualified (FAIR), ${counts.crash} CRASH signal(s), ` +
      `${counts.waiting} waiting, ${counts.watch} on watchlist, ${counts.filtered} filtered`, { detail: { ms: Date.now() - started } });
    const fair = this.ledgerOf('FAIR');
    // Only candidates assessed in this scan: a token that dropped out of discovery keeps its last snapshot, which is never traded on.
    if (fair) await this.maybeEnter('FAIR', fair, [...this.candidates.values()].filter(c => c.status === 'QUALIFIED' && c.updatedAt >= started), stopped);
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
      if (d.mode === 'LIVE') for (const id of STRATEGY_IDS) await this.ledgerFor(id, this.walletView.owner);
    } catch (error) { fail('wallet-sync', `Wallet sync failed: ${errorMessage(error)}`); }
  }

  // ------------------------------------------------------------------ discovery → evidence → gates

  private async stage(tokens: Map<string, Discovered>): Promise<{ list: Staged[]; filtered: number }> {
    // Held tokens and the watchlist first: they are appended last by discovery and must never be cut by the cap.
    const d = this.d, held = new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint))), watched = new Set(this.watchlist());
    const order = (m: string) => held.has(m) ? 0 : tokens.get(m)!.sources.includes('graduated') ? 1 : watched.has(m) ? 2 : 3;
    const mints = [...tokens.keys()].sort((a, b) => order(a) - order(b)).slice(0, DESK.maxStagedPerScan);
    const pairs = mints.length ? await d.dex.getPairsForTokens(mints) : [];
    const list: Staged[] = [];
    let filtered = 0;
    for (const mint of mints) {
      const found = tokens.get(mint)!, pair = selectPair(pairs, mint, Date.now());
      if (!pair) { filtered++; this.transition(mint, null, 'FILTERED', 'No fresh SOL/USDC/USDT pool with a price'); continue; }
      const metrics = pairMetrics(pair, Date.now()), tier = tierFor(metrics);
      if ('filtered' in tier) { filtered++; this.candidates.delete(mint); this.transition(mint, pair.baseToken.symbol ?? null, 'FILTERED', tier.filtered); continue; }
      list.push({ found, pair, tier: tier.tier, metrics, crashHint: crashMarketHint(metrics) });
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
    const priority = (s: Staged) => (crash && s.crashHint ? 2e9 : 0) + (s.tier === 'TRENDING' ? 1e9 : 0) +
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
      .sort((a, b) => (b.metrics.volume5mUsd ?? 0) - (a.metrics.volume5mUsd ?? 0)).slice(0, 2);
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
  /** Analysis of one staged token with the evidence known right now; commits nothing. */
  private assess(s: Staged, now: number): Candidate {
    const mint = s.found.mint, deep = this.deep.get(mint) ?? null;
    const watch: WatchState = this.watch.get(mint) ?? { firstSeenAt: now, observations: 0, lastLiquidityUsd: null, lastPriceUsd: null, momentumStreak: 0 };
    const c = analyze({ found: s.found, pair: s.pair, metrics: s.metrics, tier: s.tier, onchain: deep?.onchain ?? null, onchainAt: deep?.at ?? null,
      social: deep?.social ?? null, watch, now, maxWashRatio: this.d.cfg.rs.maxWashRatio, launch: this.launches.get(mint)?.value ?? null });
    c.crash = crashCheck(c);
    return c;
  }
  private finalize(list: Staged[], filtered: number, now: number): { qualified: number; crash: number; waiting: number; watch: number; filtered: number } {
    const counts = { qualified: 0, crash: 0, waiting: 0, watch: 0, filtered };
    for (const s of list) {
      const mint = s.found.mint, candidate = this.assess(s, now);
      this.watch.set(mint, { firstSeenAt: candidate.firstSeenAt, observations: candidate.observations, lastLiquidityUsd: s.metrics.liquidityUsd,
        lastPriceUsd: s.metrics.priceUsd, momentumStreak: candidate.momentumStreak });
      this.candidates.set(mint, candidate);
      if (candidate.crash?.signal) counts.crash++;
      if (s.crashHint) {
        const m = candidate.metrics;
        this.tape.push({ at: now, mint, symbol: candidate.symbol, pool: candidate.pair.address, dex: candidate.pair.dex, priceUsd: m.priceUsd,
          marketCapUsd: m.marketCapUsd, liquidityUsd: m.liquidityUsd, poolAgeMin: m.poolAgeMin, volume5mUsd: m.volume5mUsd, volume1hUsd: m.volume1hUsd,
          buys5m: m.buys5m, sells5m: m.sells5m, priceChange5mPct: m.priceChange5mPct, priceChange1hPct: m.priceChange1hPct, top10WalletPct: m.top10WalletPct,
          largestWalletPct: m.largestWalletPct, signal: candidate.crash?.signal ?? false, summary: candidate.crash?.summary ?? null, held: this.heldBy(mint) });
      }
      if (candidate.status === 'QUALIFIED') counts.qualified++; else if (candidate.status === 'WAITING') counts.waiting++;
      else if (candidate.status === 'WATCHLIST') counts.watch++; else counts.filtered++;
      this.transition(mint, candidate.symbol, candidate.status, `${candidate.tier === 'ULTRA_EARLY' ? `[${candidate.classification}] ` : ''}${candidate.reasons.join('; ')}`);
    }
    if (this.candidates.size > DESK.maxCandidates) {
      const held = new Set(this.books().flatMap(b => b.ledger.state.positions.map(p => p.mint)));
      const drop = [...this.candidates.values()].filter(c => !held.has(c.mint)).sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt)
        .slice(0, this.candidates.size - DESK.maxCandidates);
      for (const c of drop) { this.candidates.delete(c.mint); this.watch.delete(c.mint); this.deep.delete(c.mint); }
    }
    return counts;
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

  /** Early-warning exits: pool liquidity collapsing since entry, or the known creator selling. */
  private async earlyWarning(p: DeskPosition, liquidity: Map<string, number | null>): Promise<string | null> {
    const x = DESK.exits, liq = liquidity.get(p.mint) ?? null;
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
    const profile = this.strategies[id], positions = ledger.state.positions.filter(p => !manualOnly || this.manualExits.has(p.mint));
    const liquidity = await this.poolLiquidity(positions.filter(p => p.entryLiquidityUsd).map(p => p.mint));
    for (const p of positions) {
      if (stopped()) return;
      const ctx = { mint: p.mint, symbol: p.symbol, detail: { strategy: id } };
      const manual = this.manualExits.has(p.mint);
      const warning = manual ? 'EXIT NOW (manual)' : await this.earlyWarning(p, liquidity);
      let value: bigint;
      try {
        const q = await requestScope.run({ category: 'position' }, () => this.d.jupiter.quote({ inputMint: p.mint, outputMint: SOL_MINT, amountRaw: BigInt(p.qtyRaw), slippageBps: profile.slippageBps }));
        value = BigInt(q.outAmount);
      } catch (error) {
        this.event('WAITING', `${id} · position valuation unavailable: ${errorMessage(error)}; holding, no write-down`, ctx);
        continue;
      }
      p.lastValueLamports = String(value);
      if (value > BigInt(p.peakValueLamports)) p.peakValueLamports = String(value);
      if (this.solUsd && p.decimals >= 0) p.lastPriceUsd = sol(value) * this.solUsd / (exactNumber(BigInt(p.qtyRaw)) / 10 ** p.decimals);
      const cost = exactNumber(BigInt(p.costLamports)), pnlPct = (exactNumber(value) - cost) / cost * 100;
      const peakPct = (exactNumber(BigInt(p.peakValueLamports)) - cost) / cost * 100;
      const fromPeakPct = (exactNumber(value) / exactNumber(BigInt(p.peakValueLamports)) - 1) * 100;
      const reason = warning ?? exitReason(profile.exits, { pnlPct, peakPct, fromPeakPct, heldMs: Date.now() - p.openedAt });
      if (!reason) {
        // Checked every few seconds; logged only when the result moves or once a minute, so telemetry stays readable.
        const prev = this.holdLog.get(p.mint);
        if (!prev || Math.abs(prev.pct - pnlPct) >= 2 || Date.now() - prev.at >= 60_000) {
          this.holdLog.set(p.mint, { pct: pnlPct, at: Date.now() });
          const unrealized = this.solUsd ? ` · ${usd(sol(value) * this.solUsd - p.costUsd)}` : '';
          this.event('POSITION', `${id} · holding: value ${sol(value).toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%${unrealized}, peak ${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(2)}%)`, ctx);
        }
        continue;
      }
      // Exits run even while entries are paused: a paused desk must never leave a position without its stops.
      this.event('EXIT', `${id} · exit signal: ${reason}`, ctx);
      await this.execute('SELL', { strategy: id, mint: p.mint, symbol: p.symbol, decimals: p.decimals, pairAddress: p.pairAddress, heldRaw: BigInt(p.qtyRaw) }, ledger, stopped);
    }
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
    const p = this.strategies[id];
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
    pool.sort((a, b) => id === 'CRASH' ? crashRank(b) - crashRank(a) : composite(b) - composite(a));
    if (!pool.length) {
      if (id === 'FAIR' && this.drill && this.d.mode === 'PAPER') return this.drillEnter(ledger, stopped, recentExit);
      if (id === 'FAIR') this.message = 'No qualified entry candidate';
      return;
    }
    let slots = p.maxOpenPositions - s.positions.length, attempts = 0, halt: string | null = null;
    if (slots <= 0) this.note(id, 'WAITING', `${id} · ${pool.length} candidate(s), but ${s.positions.length}/${p.maxOpenPositions} positions are open`);
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
      attempts++; this.notes.delete(id);
      this.event('QUALIFIED', id === 'CRASH' ? `CRASH entry selected: ${c.crash?.summary ?? ''}` : `FAIR entry candidate selected (composite ${composite(c).toFixed(0)})`,
        { mint: c.mint, symbol: c.symbol, detail: { strategy: id } });
      const code = await this.execute('BUY', { strategy: id, mint: c.mint, symbol: c.symbol, decimals: c.onchain.decimals, pairAddress: c.pair.address, heldRaw: 0n,
        token2022: c.onchain.token2022 === true, entry: this.entryContext(c) }, ledger, stopped);
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
    if (this.solUsd) fresh.fundPaper(this.strategies[id].capitalUsd, this.solUsd);
    await fresh.save();
    this.notes.delete(id);
    this.event('SYSTEM', `${id} · TEST sleeve ran dry with no open position: cycle ${this.cycles.get(id)!.length} archived (${path.basename(target)}), ` +
      `sleeve re-funded to $${this.strategies[id].capitalUsd}; stats and realized PnL continue across cycles`, { detail: { strategy: id } });
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
    if (ledger.state.positions.length >= this.strategies.FAIR.maxOpenPositions) return;
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
        token2022: c.onchain.token2022 === true, drill: true, entry: this.entryContext(c) }, ledger, stopped);
      if (ledger.position(c.mint)) return;
      // Blocked by the guard (e.g. max drag): skip it for a while and try the next one.
      this.drillSkips.set(c.mint, Date.now());
    }
  }

  private entryContext(c: Candidate): NonNullable<ExecTarget['entry']> {
    const dev = this.deep.get(c.mint)?.onchain.developer ?? null;
    return { liquidityUsd: c.metrics.liquidityUsd, creator: dev?.creator ?? null, creatorPct: dev?.heldPct ?? null };
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

  private async executeNow(side: 'BUY' | 'SELL', t: ExecTarget,
    ledger: DeskLedger, stopped: () => boolean, probe: boolean): Promise<string | null> {
    const d = this.d, profile = this.strategies[t.strategy], ctx = { mint: t.mint, symbol: t.symbol };
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
    const amountRaw = side === 'BUY' ? BigInt(Math.floor(profile.entryUsd / solUsd * 1e9)) : t.heldRaw;
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
        router: 'Jupiter', route: order.route, routerFeeUsd: sol(order.routerFee) * solUsd, txSignature: fill.signature, solUsd, at: Date.now(), note: null, entry: t.entry });
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
      routerFeeUsd: sol(o.routerFee) * solUsd, txSignature: null, solUsd, at: Date.now(), note, entry: t.entry });
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
    if (side === 'BUY') this.event('POSITION', `${id} · position opened: ${row.quantity} @ $${row.entryPriceUsd?.toPrecision(6) ?? 'UNKNOWN'} · fee $${row.networkFeeUsd?.toFixed(4)}`, c);
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
      strategies: STRATEGY_IDS.map(id => this.strategyView(id)),
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
        const notes = Object.fromEntries(STRATEGY_IDS.flatMap(id => { const n = this.entryNotes.get(`${id}:${c.mint}`); return n ? [[id, n]] : []; }));
        return { ...c, entryNotes: notes, stale: c.updatedAt < this.lastCompletedScanAt };
      }).sort((a, b) => Number(a.stale) - Number(b.stale) || rank(b) - rank(a) || Number(!!b.crash?.signal) - Number(!!a.crash?.signal) || composite(b) - composite(a)).slice(0, 40),
      preflights: [...this.preflights].reverse(), positions, ledger: rows,
      sources: this.sources, path: this.pathView(),
    };
  }

  private strategyView(id: StrategyId): StrategyView {
    const p = this.strategies[id], s = this.ledgerOf(id)?.state ?? null, solUsd = this.solUsd, past = this.d.mode === 'PAPER' ? this.cycles.get(id) ?? [] : [];
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

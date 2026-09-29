import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { AppConfig } from '../config/config';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { DexScreenerClient } from '../data/dexscreener';
import type { GeckoTerminalClient } from '../data/geckoterminal';
import type { TokenSafetyChecker } from '../analysis/token-safety';
import type { JupiterClient } from '../execution/jupiter-client';
import { LiveExecutor } from '../execution/live-executor';
import type { TransactionSender } from '../execution/tx-sender';
import { SwapError } from '../execution/executor';
import { SigningError, type TransactionSigner } from '../execution/transaction-signer';
import { requestScope } from '../data/core/request-scope';
import { exactNumber } from '../data/core/data-validator';
import { BASE_FEE_LAMPORTS, SOL_MINT } from '../core/types';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { DESK, type DeskCapital } from './config';
import { EventLog } from './events';
import { DeskLedger } from './ledger';
import { discover, pairMetrics, selectPair, tierFor, type Discovered } from './discovery';
import { gatherOnchain, type OnchainEvidence } from './onchain';
import { assessAuthenticity, checkWebsite, parseXLink, type WebsiteCheck, type XClient } from './social';
import { analyze, type SocialEvidence, type WatchState } from './analysis';
import { DeskGuard, DeskReject, PaperExecution, paperSigner } from './guard';
import type { Candidate, DeskEvent, DeskMode, DeskStatus, Preflight, Stage } from './types';

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
}

interface Deep { at: number; onchain: OnchainEvidence; social: SocialEvidence }
const LABEL: Record<DeskMode, string> = { PAPER: 'TEST / PAPER — NO REAL TRANSACTIONS', LIVE: 'LIVE — REAL FUNDS' };
const sol = (l: bigint) => exactNumber(l < 0n ? -l : l) / 1e9 * (l < 0n ? -1 : 1);

export class DeskEngine {
  scanner = false;
  execution = false;
  /** TEST only: allow drill entries when nothing qualifies. */
  drill = false;
  private drillSkips = new Map<string, number>();
  message: string | null = null;
  lastScanAt: number | null = null;
  nextScanAt: number | null = null;
  readonly events: EventLog;
  private ledgers = new Map<string, DeskLedger>();
  private candidates = new Map<string, Candidate>();
  private watch = new Map<string, WatchState>();
  private deep = new Map<string, Deep>();
  private lastState = new Map<string, string>();
  private preflights: Preflight[] = [];
  private sources: Record<string, string> = {};
  private work: Promise<void> | null = null;
  private generation = 0;
  private solUsd: number | null = null;
  private walletView: { owner: string; native: bigint; at: number } | null = null;

  private constructor(private readonly d: DeskDeps) {
    this.events = new EventLog(d.mode, path.join(d.dir, `events-${d.mode}.json`));
  }

  static async create(d: DeskDeps): Promise<DeskEngine> {
    const engine = new DeskEngine(d);
    await engine.events.load();
    if (d.mode === 'PAPER') await engine.ledgerFor(null);
    return engine;
  }

  get mode(): DeskMode { return this.d.mode; }
  get busy(): boolean { return this.work !== null; }

  private async ledgerFor(owner: string | null): Promise<DeskLedger> {
    const key = this.d.mode === 'PAPER' ? 'PAPER' : `LIVE-${owner}`;
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      if (this.d.mode === 'LIVE' && !owner) throw new DeskReject('WALLET_REQUIRED');
      ledger = await DeskLedger.open(path.join(this.d.dir, `ledger-${key}.json`), this.d.mode, owner, Date.now());
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }
  private currentLedger(): DeskLedger | null {
    return this.d.mode === 'PAPER' ? this.ledgers.get('PAPER') ?? null : this.walletView ? this.ledgers.get(`LIVE-${this.walletView.owner}`) ?? null : null;
  }

  private event(stage: Stage, message: string, c: { mint?: string | null; symbol?: string | null; detail?: DeskEvent['detail'] } = {}): void {
    this.events.add(stage, message, c);
  }

  // ------------------------------------------------------------------ controls

  start(): void {
    if (this.d.mode === 'LIVE' && !this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    const ledger = this.currentLedger();
    if (ledger?.state.halted || ledger?.state.pending) throw new DeskReject('TRANSACTION_RECONCILIATION_REQUIRED');
    this.scanner = true; this.execution = true; this.generation++; this.nextScanAt = Date.now();
    this.event('SYSTEM', this.d.mode === 'PAPER' ? 'TEST started: scanner ON, paper execution ENABLED — no signature will ever be requested'
      : 'LIVE session started: scanner ON, execution ENABLED — every order needs a Phantom signature');
  }
  stop(reason = 'stopped by user'): void {
    if (!this.scanner && !this.execution) return;
    this.scanner = false; this.execution = false; this.generation++; this.nextScanAt = null;
    this.event('SYSTEM', `${this.d.mode === 'PAPER' ? 'TEST' : 'LIVE session'} stopped (${reason}); telemetry and ledger kept`);
  }
  pause(): void { if (this.execution) { this.execution = false; this.event('SYSTEM', 'Execution PAUSED: scanner keeps running, no new orders'); } }
  resume(): void {
    if (!this.scanner) throw new DeskReject('SCANNER_OFF');
    if (this.d.mode === 'LIVE' && !this.d.authorized()) throw new DeskReject('WALLET_SESSION_REQUIRED');
    if (!this.execution) { this.execution = true; this.event('SYSTEM', 'Execution RESUMED'); }
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
      const ledger = await this.ledgerFor(null);
      if (this.solUsd) ledger.fundPaper(this.d.capital.plannedStartingCapitalUsd, this.solUsd);
      // Any mint can be probed (e.g. to verify the path on a liquid token); its decimals come from the chain, never a guess.
      const mintInfo = c ? null : await this.d.safety.check(mint, { rejectMintAuthority: false, fresh: true });
      const decimals = c?.onchain.decimals ?? mintInfo!.decimals, token2022 = c ? c.onchain.token2022 === true : mintInfo!.isToken2022;
      this.event('SYSTEM', `PROBE started for ${c?.symbol ?? mint} (${c ? `candidate status ${c.status}` : 'not a strategy candidate'}); nothing will be booked`, { mint, symbol: c?.symbol ?? null });
      await this.execute('BUY', { mint, symbol: c?.symbol ?? null, decimals, pairAddress: c?.pair.address ?? '', heldRaw: 0n, token2022 }, ledger, () => false, true);
    })().finally(async () => { this.work = null; await this.persist(); });
    this.work = work;
    return work;
  }

  pulse(): Promise<void> {
    if (this.work) return this.work;
    const work = this.scan().catch(error => {
      this.message = 'SCAN_FAILED';
      this.event('FAILED', `Scan failed: ${errorMessage(error)}`);
    }).finally(async () => {
      this.work = null; this.lastScanAt = Date.now();
      this.nextScanAt = this.scanner ? this.lastScanAt + DESK.scanMs : null;
      await this.persist();
    });
    this.work = work;
    return work;
  }
  async settled(): Promise<void> { await this.work; }
  async persist(): Promise<void> {
    await this.events.flush();
    await this.currentLedger()?.save();
  }

  // ------------------------------------------------------------------ scan

  private async scan(): Promise<void> {
    const generation = this.generation, d = this.d;
    const stopped = () => !this.scanner || generation !== this.generation || (d.mode === 'LIVE' && !d.authorized());
    const started = Date.now();
    this.event('SCANNING', 'Scan started', { detail: { mode: d.mode } });
    await this.syncWallet();
    const ledger = this.currentLedger();
    if (d.mode === 'LIVE' && !ledger) { this.message = 'Connect Phantom to scan in LIVE mode'; this.event('WAITING', this.message); return; }
    if (ledger && this.solUsd) ledger.fundPaper(d.capital.plannedStartingCapitalUsd, this.solUsd);
    if (ledger) await this.managePositions(ledger, stopped);
    if (stopped()) return;
    for (const [mint, at] of this.drillSkips) if (Date.now() - at > 15 * 60_000) this.drillSkips.delete(mint);
    const found = await discover(d.dex, d.gecko, this.watchlist(ledger));
    this.sources = found.sources;
    const shortlist = await this.evaluate(found.tokens, started);
    if (stopped()) return;
    this.event('SCANNING', `Scan finished: ${found.tokens.size} tokens discovered, ${shortlist.qualified} qualified, ${shortlist.waiting} waiting, ${shortlist.watch} on watchlist, ${shortlist.filtered} filtered`,
      { detail: { ms: Date.now() - started } });
    if (ledger) await this.maybeEnter(ledger, stopped);
  }

  private watchlist(ledger: DeskLedger | null): string[] {
    const keep = [...this.candidates.values()].filter(c => c.status !== 'FILTERED').sort((a, b) => b.updatedAt - a.updatedAt).map(c => c.mint).slice(0, 40);
    return [...new Set([...(ledger?.state.positions.map(p => p.mint) ?? []), ...keep])];
  }

  private async syncWallet(): Promise<void> {
    const d = this.d;
    try {
      const pairs = await d.dex.getPairsForTokens([SOL_MINT]);
      const p = selectPair(pairs, SOL_MINT, Date.now());
      if (p?.priceUsd) this.solUsd = p.priceUsd;
    } catch (error) { this.event('FAILED', `SOL price unavailable: ${errorMessage(error)}`); }
    const wallet = d.wallet();
    if (!wallet) { this.walletView = null; return; }
    try {
      const native = await d.rpc.execute('desk:wallet-sync', c => c.getBalance(wallet.owner, 'confirmed'));
      this.walletView = { owner: wallet.owner.toBase58(), native: BigInt(native), at: Date.now() };
      if (d.mode === 'LIVE') await this.ledgerFor(this.walletView.owner);
    } catch (error) { this.event('FAILED', `Wallet sync failed: ${errorMessage(error)}`); }
  }

  // ------------------------------------------------------------------ discovery → evidence → gates

  private async evaluate(tokens: Map<string, Discovered>, now: number): Promise<{ qualified: number; waiting: number; watch: number; filtered: number }> {
    const d = this.d, mints = [...tokens.keys()].slice(0, 90);
    const pairs = mints.length ? await d.dex.getPairsForTokens(mints) : [];
    const staged: Array<{ found: Discovered; pair: NonNullable<ReturnType<typeof selectPair>>; tier: 'TRENDING' | 'ULTRA_EARLY'; metrics: ReturnType<typeof pairMetrics> }> = [];
    let filtered = 0;
    for (const mint of mints) {
      const found = tokens.get(mint)!, pair = selectPair(pairs, mint, Date.now());
      if (!pair) { filtered++; this.transition(mint, null, 'FILTERED', 'No fresh SOL/USDC/USDT pool with a price'); continue; }
      const metrics = pairMetrics(pair, Date.now()), tier = tierFor(metrics);
      if ('filtered' in tier) { filtered++; this.candidates.delete(mint); this.transition(mint, pair.baseToken.symbol ?? null, 'FILTERED', tier.filtered); continue; }
      staged.push({ found, pair, tier: tier.tier, metrics });
    }
    // Deep evidence (RPC, website, X, trade flow) for the most tradeable-looking tokens first.
    const priority = (s: typeof staged[number]) => (s.tier === 'TRENDING' ? 1e9 : 0) +
      ((s.metrics.volume5mUsd ?? 0) > DESK.gates.minVolume5mUsd ? 1e8 : 0) + ((s.metrics.liquidityUsd ?? 0) > DESK.gates.minLiquidityUsd ? 1e7 : 0) + (s.metrics.volume5mUsd ?? 0);
    const due = staged.filter(s => !this.deep.has(s.found.mint) || now - this.deep.get(s.found.mint)!.at > DESK.deepAnalysisTtlMs)
      .sort((a, b) => priority(b) - priority(a)).slice(0, DESK.maxDeepAnalysesPerScan);
    const tradeable = (s: typeof staged[number]) => s.tier === 'TRENDING' && (s.metrics.volume5mUsd ?? 0) > DESK.gates.minVolume5mUsd &&
      (s.metrics.liquidityUsd ?? 0) > DESK.gates.minLiquidityUsd && (s.metrics.buySellRatio5m ?? 0) > DESK.gates.minBuySellRatio;
    await Promise.all(due.map(s => this.deepAnalysis(s.found, s.pair, tradeable(s)).catch(error =>
      this.event('FAILED', `Evidence gathering failed: ${errorMessage(error)}`, { mint: s.found.mint, symbol: s.pair.baseToken.symbol ?? null }))));
    const counts = { qualified: 0, waiting: 0, watch: 0, filtered };
    for (const s of staged) {
      const mint = s.found.mint, prev = this.watch.get(mint), deep = this.deep.get(mint) ?? null;
      const watch: WatchState = prev ?? { firstSeenAt: now, observations: 0, lastLiquidityUsd: null, lastPriceUsd: null, momentumStreak: 0 };
      const candidate = analyze({ found: s.found, pair: s.pair, metrics: s.metrics, tier: s.tier, onchain: deep?.onchain ?? null, onchainAt: deep?.at ?? null,
        social: deep?.social ?? null, watch, now, maxWashRatio: d.cfg.rs.maxWashRatio });
      this.watch.set(mint, { ...watch, observations: candidate.observations, lastLiquidityUsd: s.metrics.liquidityUsd, lastPriceUsd: s.metrics.priceUsd,
        momentumStreak: candidate.momentumStreak });
      this.candidates.set(mint, candidate);
      if (candidate.status === 'QUALIFIED') counts.qualified++; else if (candidate.status === 'WAITING') counts.waiting++;
      else if (candidate.status === 'WATCHLIST') counts.watch++; else counts.filtered++;
      this.transition(mint, candidate.symbol, candidate.status, `${candidate.tier === 'ULTRA_EARLY' ? `[${candidate.classification}] ` : ''}${candidate.reasons.join('; ')}`);
    }
    if (this.candidates.size > DESK.maxCandidates) {
      const drop = [...this.candidates.values()].sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt).slice(0, this.candidates.size - DESK.maxCandidates);
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

  private async managePositions(ledger: DeskLedger, stopped: () => boolean): Promise<void> {
    const rs = this.d.cfg.rs;
    for (const p of [...ledger.state.positions]) {
      if (stopped()) return;
      let value: bigint;
      try {
        const q = await requestScope.run({ category: 'position' }, () => this.d.jupiter.quote({ inputMint: p.mint, outputMint: SOL_MINT, amountRaw: BigInt(p.qtyRaw), slippageBps: this.d.capital.slippageBps }));
        value = BigInt(q.outAmount);
      } catch (error) {
        this.event('WAITING', `Position valuation unavailable: ${errorMessage(error)}; holding, no write-down`, { mint: p.mint, symbol: p.symbol });
        continue;
      }
      p.lastValueLamports = String(value);
      if (value > BigInt(p.peakValueLamports)) p.peakValueLamports = String(value);
      if (this.solUsd && p.decimals >= 0) p.lastPriceUsd = sol(value) * this.solUsd / (exactNumber(BigInt(p.qtyRaw)) / 10 ** p.decimals);
      const cost = BigInt(p.costLamports), pnlPct = (exactNumber(value) - exactNumber(cost)) / exactNumber(cost) * 100;
      const peakPct = (exactNumber(BigInt(p.peakValueLamports)) - exactNumber(cost)) / exactNumber(cost) * 100;
      const fromPeak = (exactNumber(value) / exactNumber(BigInt(p.peakValueLamports)) - 1) * 100;
      const reason = pnlPct <= -rs.stopLossPct ? `STOP_LOSS ${pnlPct.toFixed(2)}% ≤ -${rs.stopLossPct}%`
        : pnlPct >= rs.takeProfitPct ? `TAKE_PROFIT ${pnlPct.toFixed(2)}% ≥ ${rs.takeProfitPct}%`
        : rs.trailingStopPct > 0 && peakPct >= rs.trailingActivationPct && fromPeak <= -rs.trailingStopPct ? `TRAILING_STOP ${fromPeak.toFixed(2)}% from peak`
        : Date.now() - p.openedAt >= rs.maxHoldMin * 60_000 ? `MAX_HOLD ${rs.maxHoldMin} min` : null;
      if (!reason) { this.event('POSITION', `Holding: value ${sol(value).toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`, { mint: p.mint, symbol: p.symbol }); continue; }
      if (!this.execution) { this.event('WAITING', `Exit signal ${reason}, but execution is paused`, { mint: p.mint, symbol: p.symbol }); continue; }
      this.event('EXIT', `Exit signal: ${reason}`, { mint: p.mint, symbol: p.symbol });
      await this.execute('SELL', { mint: p.mint, symbol: p.symbol, decimals: p.decimals, pairAddress: p.pairAddress, heldRaw: BigInt(p.qtyRaw) }, ledger, stopped);
    }
  }

  // ------------------------------------------------------------------ entries

  private async maybeEnter(ledger: DeskLedger, stopped: () => boolean): Promise<void> {
    const s = ledger.state;
    if (!this.execution || stopped()) return;
    if (s.halted || s.pending) { this.message = s.halted ?? 'TRANSACTION_RECONCILIATION_REQUIRED'; return; }
    const recentExit = (mint: string) => s.entries.some(e => e.mint === mint && e.side === 'SELL' && Date.now() - e.at < DESK.reentryCooldownMs);
    const qualified = [...this.candidates.values()].filter(c => c.status === 'QUALIFIED' && !ledger.position(c.mint) && !recentExit(c.mint))
      .sort((a, b) => composite(b) - composite(a));
    if (!qualified.length) {
      if (this.drill && this.d.mode === 'PAPER') return this.drillEnter(ledger, stopped, recentExit);
      this.message = 'No qualified entry candidate'; return;
    }
    if (s.positions.length >= DESK.maxOpenPositions) {
      this.event('WAITING', `${qualified.length} qualified, but ${s.positions.length}/${DESK.maxOpenPositions} positions are open`); return;
    }
    const c = qualified[0]!;
    if (c.onchain.decimals === null) { this.event('WAITING', 'Token decimals unknown; entry deferred', { mint: c.mint, symbol: c.symbol }); return; }
    this.event('QUALIFIED', `Entry candidate selected (composite ${composite(c).toFixed(0)})`, { mint: c.mint, symbol: c.symbol });
    await this.execute('BUY', { mint: c.mint, symbol: c.symbol, decimals: c.onchain.decimals, pairAddress: c.pair.address, heldRaw: 0n,
      token2022: c.onchain.token2022 === true }, ledger, stopped);
  }

  /**
   * TEST drill: when nothing qualifies, open a paper position in the best trending candidate whose safety gates
   * pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity), bypassing volume, buy-pressure,
   * concentration and momentum gates. The execution guard still applies. Every drill fill is marked in the ledger.
   */
  private async drillEnter(ledger: DeskLedger, stopped: () => boolean, recentExit: (mint: string) => boolean): Promise<void> {
    if (ledger.state.positions.length >= DESK.maxOpenPositions) return;
    const safe = (c: Candidate) => ['mintAuthority', 'freezeAuthority', 'contract', 'liquidity'].every(k => c.gates.find(g => g.key === k)?.status === 'PASS');
    const pool = [...this.candidates.values()].filter(c => c.tier === 'TRENDING' && c.onchain.decimals !== null && safe(c) &&
      !ledger.position(c.mint) && !recentExit(c.mint) && !this.drillSkips.has(c.mint)).sort((a, b) => composite(b) - composite(a));
    if (!pool.length) { this.message = 'DRILL: no trending candidate with passing safety gates yet'; return; }
    for (const c of pool.slice(0, 3)) {
      if (stopped()) return;
      this.event('QUALIFIED', `DRILL entry (strategy gates bypassed; status ${c.status}: ${c.reasons[0] ?? ''})`, { mint: c.mint, symbol: c.symbol });
      await this.execute('BUY', { mint: c.mint, symbol: c.symbol, decimals: c.onchain.decimals!, pairAddress: c.pair.address, heldRaw: 0n,
        token2022: c.onchain.token2022 === true, drill: true }, ledger, stopped);
      if (ledger.position(c.mint)) return;
      // Blocked by the guard (e.g. max drag): skip it for a while and try the next one.
      this.drillSkips.set(c.mint, Date.now());
    }
  }

  // ------------------------------------------------------------------ one order through the production path

  private async execute(side: 'BUY' | 'SELL', t: { mint: string; symbol: string | null; decimals: number; pairAddress: string; heldRaw: bigint; token2022?: boolean; drill?: boolean },
    ledger: DeskLedger, stopped: () => boolean, probe = false): Promise<void> {
    const d = this.d, ctx = { mint: t.mint, symbol: t.symbol };
    const wallet = d.wallet(), solUsd = this.solUsd;
    if (!wallet) { this.event('WAITING', d.mode === 'PAPER' ? 'No wallet address: connect Phantom or set WALLET_PUBLIC_KEY in .env' : 'Connect Phantom to trade LIVE', ctx); return; }
    if (!solUsd) { this.event('WAITING', 'SOL price unavailable; order deferred', ctx); return; }
    if (d.mode === 'LIVE' && (!wallet.signer || !d.sender)) { this.event('WAITING', 'LIVE needs an active Phantom signing session', ctx); return; }
    let tokenProgram = t.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    if (t.token2022 === undefined) {
      const info = await d.rpc.execute('desk:mint-owner', c => c.getAccountInfo(new PublicKey(t.mint), 'confirmed'));
      if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
    }
    const amountRaw = side === 'BUY' ? BigInt(Math.floor(d.capital.baseEntryUsd / solUsd * 1e9)) : t.heldRaw;
    const guard = new DeskGuard({ mode: d.mode, rpc: d.rpc, jupiter: d.jupiter, owner: wallet.owner, mint: t.mint, symbol: t.symbol, decimals: t.decimals,
      tokenProgram, solUsd, slippageBps: d.capital.slippageBps, maxDragBps: DESK.maxDragBps, reserveLamports: DESK.reserveLamports,
      configuredPriorityCap: BigInt(d.cfg.jupiter.maxPriorityFeeLamports), baseEntryUsd: d.capital.baseEntryUsd,
      paperCashLamports: d.mode === 'PAPER' ? BigInt(ledger.state.paperCashLamports ?? '0') : null, heldRaw: t.heldRaw, stopped,
      enforceDrag: !(t.drill && d.mode === 'PAPER'),
      onSigned: async signature => {
        ledger.state.pending = { side, mint: t.mint, at: Date.now(), signature };
        await ledger.save();
        this.event('SUBMITTED', `Signed by Phantom; signature persisted before broadcast: ${signature}`, ctx);
      },
      event: (stage, message, detail) => this.event(stage, message, { ...ctx, detail }) });
    const signer: TransactionSigner = d.mode === 'PAPER' ? paperSigner(wallet.owner) : {
      publicKey: wallet.owner,
      signTransaction: async (tx, context) => {
        guard.signatureState('AWAITING_PHANTOM');
        this.event('AWAITING_SIGNATURE', 'AWAITING PHANTOM SIGNATURE — review the transaction in Phantom', ctx);
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
      const fill = await requestScope.run({ category: 'execution' }, () => executor.swap({ side, mint: t.mint, amountRaw, slippageBps: d.capital.slippageBps }));
      const order = guard.lastOrder!;
      const row = ledger.book({ side, mint: t.mint, symbol: t.symbol, decimals: t.decimals, pairAddress: t.pairAddress, inAmountRaw: fill.inAmountRaw,
        outAmountRaw: fill.outAmountRaw, solDeltaLamports: fill.solDeltaLamports, feeLamports: fill.feeLamports, rentLamports: fill.rentLamports,
        router: 'Jupiter', route: order.route, routerFeeUsd: sol(order.routerFee) * solUsd, txSignature: fill.signature, solUsd, at: Date.now(), note: null });
      if (guard.lastPreflight) { guard.lastPreflight.outcome = 'CONFIRMED'; guard.lastPreflight.txSignature = fill.signature; }
      record(guard.lastPreflight);
      this.event('CONFIRMED', `${side} confirmed on-chain: ${fill.signature}`, ctx);
      this.bookedEvents(side, row, ctx);
    } catch (error) {
      record(guard.lastPreflight);
      const cause = error instanceof SwapError ? error.cause : error;
      if (probe && cause instanceof PaperExecution) {
        if (guard.lastPreflight) guard.lastPreflight.outcome = 'PROBE_NOT_BOOKED';
        this.event('PREFLIGHT', 'PROBE complete — pre-flight passed; stopped where LIVE would request a Phantom signature. Nothing booked.', ctx);
      } else if (probe) {
        this.event('FAILED', `PROBE stopped: ${cause instanceof DeskReject ? cause.message : errorMessage(error)}`, ctx);
      } else if (d.mode === 'PAPER' && cause instanceof PaperExecution && guard.lastOrder && guard.lastSimulation.status === 'PASSED') {
        this.paperFill(side, t, guard, ledger, solUsd, 'Filled from the passed unsigned RPC simulation');
      } else if (d.mode === 'PAPER' && side === 'SELL' && guard.lastOrder && !(cause instanceof DeskReject && ['STOP_REQUESTED', 'UNTRACKED_POSITION'].includes(cause.code))) {
        // A TEST position is not held on-chain, so its exit cannot be simulated against the wallet.
        guard.lastSimulation = { status: 'NOT_POSSIBLE', detail: 'TEST position is not held by the wallet; exit valued at the executable Jupiter quote', solDelta: null, tokenDelta: null };
        this.event('SIMULATION', `NOT POSSIBLE — ${guard.lastSimulation.detail}`, ctx);
        this.paperFill(side, t, guard, ledger, solUsd, guard.lastSimulation.detail);
      } else {
        this.failed(side, t, guard, ledger, error, solUsd);
      }
    } finally {
      await ledger.save();
    }
  }

  private paperFill(side: 'BUY' | 'SELL', t: { mint: string; symbol: string | null; decimals: number; pairAddress: string; heldRaw: bigint; drill?: boolean },
    guard: DeskGuard, ledger: DeskLedger, solUsd: number, detail: string): void {
    const drill = t.drill || (side === 'SELL' && !!ledger.state.entries.filter(e => e.mint === t.mint && e.side === 'BUY').at(-1)?.note?.startsWith('DRILL'));
    const drag = guard.lastPreflight?.dragPct;
    const note = drill ? `DRILL — strategy gates bypassed${drag != null ? ` · drag ${drag.toFixed(2)}%` : ''} · ${detail}` : detail;
    const o = guard.lastOrder!, q = o.quote, ctx = { mint: t.mint, symbol: t.symbol };
    const fee = o.fee > 0n ? o.fee : BASE_FEE_LAMPORTS + o.priority;
    const buy = side === 'BUY';
    const tokens = buy ? guard.lastSimulation.tokenDelta ?? BigInt(q.outAmount) : BigInt(q.inAmount);
    const solDelta = buy ? -(BigInt(q.inAmount) + fee + o.rent) : BigInt(q.outAmount) - fee;
    const pre = guard.lastPreflight;
    if (pre) { pre.outcome = 'PAPER_FILLED'; pre.signature = 'NOT_REQUESTED_TEST'; if (!buy) pre.simulation = { ...pre.simulation, status: guard.lastSimulation.status, detail: guard.lastSimulation.detail }; }
    this.event('SUBMITTED', 'TEST — no signature requested, nothing submitted; paper execution recorded', ctx);
    const row = ledger.book({ side, mint: t.mint, symbol: t.symbol, decimals: t.decimals, pairAddress: t.pairAddress, inAmountRaw: BigInt(q.inAmount),
      outAmountRaw: buy ? tokens : BigInt(q.outAmount), solDeltaLamports: solDelta, feeLamports: fee, rentLamports: o.rent, router: 'Jupiter', route: o.route,
      routerFeeUsd: sol(o.routerFee) * solUsd, txSignature: null, solUsd, at: Date.now(), note });
    this.bookedEvents(side, row, ctx);
  }

  private bookedEvents(side: 'BUY' | 'SELL', row: ReturnType<DeskLedger['book']>, ctx: { mint: string; symbol: string | null }): void {
    if (side === 'BUY') this.event('POSITION', `Position opened: ${row.quantity} @ $${row.entryPriceUsd?.toPrecision(6) ?? 'UNKNOWN'} · fee $${row.networkFeeUsd?.toFixed(4)}`, ctx);
    else {
      this.event('EXIT', `Position closed: ${row.quantity} @ $${row.exitPriceUsd?.toPrecision(6) ?? 'UNKNOWN'}`, ctx);
      this.event('PNL', `Realized: gross ${usd(row.grossPnlUsd)} · fees ${usd(row.totalFeesUsd)} · net ${usd(row.netPnlUsd)}`, ctx);
    }
  }

  private failed(side: 'BUY' | 'SELL', t: { mint: string; symbol: string | null }, guard: DeskGuard, ledger: DeskLedger, error: unknown, solUsd: number): void {
    const ctx = { mint: t.mint, symbol: t.symbol }, s = ledger.state;
    const swap = error instanceof SwapError ? error : null, cause = swap?.cause ?? error;
    const reason = cause instanceof DeskReject ? cause.message : cause instanceof SigningError ? `Phantom: ${cause.code}` : errorMessage(error);
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
    const where = guard.lastPreflight ? (guard.lastPreflight.signature === 'REJECTED' || guard.lastPreflight.signature === 'EXPIRED' ? 'at Phantom signature' : 'at pre-flight')
      : guard.quoted ? 'after quote' : 'before quote';
    this.event(cause instanceof DeskReject && cause.code === 'FEE_CAP' ? 'FILTERED' : 'FAILED', `${side} blocked ${where}: ${reason}`, ctx);
    if (cause instanceof SigningError) this.pause();
  }

  // ------------------------------------------------------------------ view

  status(wallet: DeskStatus['wallet']): DeskStatus {
    const d = this.d, ledger = this.currentLedger(), s = ledger?.state, solUsd = this.solUsd;
    const positions = s?.positions ?? [];
    // A position without an executable valuation yet makes totals unknown, never silently $0.
    const valued = positions.every(p => p.lastValueLamports !== null);
    const value = valued ? positions.reduce((a, p) => a + BigInt(p.lastValueLamports!), 0n) : null;
    const rent = positions.reduce((a, p) => a + BigInt(p.rentLamports), 0n);
    const unrealized = solUsd && valued ? positions.reduce((a, p) => a + sol(BigInt(p.lastValueLamports!)) * solUsd - p.costUsd, 0) : null;
    const configured = !wallet.connected && d.mode === 'PAPER' && this.walletView ? this.walletView.owner : null;
    if (configured) wallet = { connected: false, address: configured, source: 'CONFIGURED' };
    const native = this.walletView && this.walletView.owner === wallet.address ? this.walletView.native : null;
    const paper = s?.paperCashLamports != null ? BigInt(s.paperCashLamports) : null;
    const budget = d.mode === 'PAPER' ? paper : native;
    const spendable = budget === null ? null : budget - DESK.reserveLamports > 0n ? budget - DESK.reserveLamports : 0n;
    const cash = d.mode === 'PAPER' ? paper : native;
    return {
      mode: d.mode, label: LABEL[d.mode], scanner: this.scanner, execution: this.execution, drill: this.drill, wallet,
      capital: {
        plannedStartingCapitalUsd: d.capital.plannedStartingCapitalUsd, baseEntryUsd: d.capital.baseEntryUsd, reserveSol: sol(DESK.reserveLamports),
        maxDragPct: Number(DESK.maxDragBps) / 100, slippageBps: d.capital.slippageBps,
        walletSol: native === null ? null : sol(native), walletUsd: native !== null && solUsd ? sol(native) * solUsd : null, solUsd,
        availableSol: native === null ? null : sol(native), reservedSol: sol(DESK.reserveLamports + rent),
        spendableUsd: spendable !== null && solUsd ? sol(spendable) * solUsd : null,
        paperCashUsd: paper !== null && solUsd ? sol(paper) * solUsd : null, openPositions: positions.length,
        positionsValueUsd: solUsd && value !== null ? sol(value) * solUsd : null, unrealizedPnlUsd: unrealized,
        realizedPnlUsd: s?.realizedPnlUsd ?? 0, totalFeesUsd: s?.feesUsd ?? 0,
        equityUsd: cash !== null && solUsd && value !== null ? sol(cash + value + rent) * solUsd : null, lastWalletSync: this.walletView?.at ?? null,
      },
      message: this.message, halted: s?.halted ?? null, lastScanAt: this.lastScanAt, nextScanAt: this.nextScanAt, scanning: this.busy,
      events: this.events.list(250).reverse(),
      candidates: [...this.candidates.values()].sort((a, b) => rank(b) - rank(a) || composite(b) - composite(a)).slice(0, 40),
      preflights: [...this.preflights].reverse(), positions: positions.map(p => ({ ...p })), ledger: (s?.entries ?? []).slice(-100).reverse(),
      sources: this.sources, path: this.pathView(),
    };
  }

  private pathView(): DeskStatus['path'] {
    const d = this.d, rpc = d.cfg.rpc.endpoints.map(e => { try { return new URL(e).hostname; } catch { return 'configured RPC'; } }).join(', ');
    const test = d.mode === 'PAPER';
    return [
      { layer: 'Market data', provider: 'DexScreener (pairs, boosts, profiles) · GeckoTerminal (trending/new pools, trades)' },
      { layer: 'Scanner', provider: 'Trending / migrated < $1M (priority < $100K) · ultra-early $2K–$10K, monitored to $100K' },
      { layer: 'Strategy', provider: 'Two-tier early discovery → watchlist → momentum confirmation' },
      { layer: 'Risk engine', provider: `Hard gates + execution guard (reserve ${sol(DESK.reserveLamports)} SOL, max drag ${Number(DESK.maxDragBps) / 100}%)` },
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
const rank = (c: Candidate) => ({ QUALIFIED: 4, WAITING: 3, WATCHLIST: 2, FILTERED: 1 })[c.status];
function composite(c: Candidate): number {
  const v = (k: string) => c.scores.find(s => s.key === k)?.score ?? 0;
  return v('MOMENTUM') * 0.3 + v('MARKET') * 0.2 + v('ONCHAIN') * 0.2 + v('RISK') * 0.15 + v('FUNDAMENTAL') * 0.1 + v('SOCIAL') * 0.05;
}
const unreachableSender = { sendAndConfirm: async () => { throw new Error('TEST never submits a transaction'); } } as unknown as TransactionSender;

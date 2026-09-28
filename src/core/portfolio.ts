import fs from 'node:fs';
import path from 'node:path';
import type { ClosedTrade, ExecMode, LpPaperPosition, Position, StrategyStats } from './types';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { lamportsToSol, pctChange } from '../utils/format';
import { atomicWriteFile } from '../utils/fs';

const STATE_VERSION = 1;
const MAX_CLOSED_HISTORY = 1_000;
const SAVE_DEBOUNCE_MS = 1_000;

export interface PersistedState {
  version: number;
  mode: ExecMode;
  createdAt: string;
  updatedAt: string;
  initialVirtualLamports: bigint;
  virtualSolLamports: bigint;
  positions: Position[];
  closed: ClosedTrade[];
  lp: LpPaperPosition[];
  stats: Record<string, StrategyStats>;
  cooldowns: Record<string, number>;
  daily: { date: string; pnlLamports: bigint };
  strategyData?: Record<string, unknown>;
}

// bigint ↔ JSON: { "$bigint": "123" }
function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $bigint: v.toString() } : v;
}
export function stateReviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$bigint' && typeof o.$bigint === 'string') return BigInt(o.$bigint);
  }
  return v;
}

const utcDate = (ts = Date.now()): string => new Date(ts).toISOString().slice(0, 10);

const emptyStats = (): StrategyStats => ({ trades: 0, wins: 0, losses: 0, realizedPnlLamports: 0n, feesLamports: 0n });

/**
 * Persistenter Portfolio-Zustand (offene Positionen, Historie, Statistiken, Cooldowns).
 * - Getrennte Dateien je Modus (state-SIMULATION.json / state-LIVE.json)
 * - Atomisches Schreiben (tmp + rename) → kein korrupter Zustand bei Crash/Stromausfall
 * - Im SIMULATION-Modus führt das Portfolio zusätzlich das virtuelle SOL-Konto
 */
export class Portfolio {
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly mode: ExecMode,
    private state: PersistedState,
    private readonly log: Logger,
  ) {}

  static async load(dir: string, mode: ExecMode, initialVirtualLamports: bigint, logger: Logger, strict = false): Promise<Portfolio> {
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.resolve(dir, `state-${mode}.json`);
    const log = logger.child('portfolio');
    const fresh = (): PersistedState => ({
      version: STATE_VERSION,
      mode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      initialVirtualLamports,
      virtualSolLamports: initialVirtualLamports,
      positions: [],
      closed: [],
      lp: [],
      stats: {},
      cooldowns: {},
      daily: { date: utcDate(), pnlLamports: 0n },
    });

    let state: PersistedState;
    if (!fs.existsSync(file)) {
      state = fresh();
      log.info('Neuer Portfolio-Zustand angelegt', { file });
    } else {
      try {
        const raw = await fs.promises.readFile(file, 'utf8');
        const parsed = JSON.parse(raw, stateReviver) as Partial<PersistedState>;
        if (parsed.mode !== mode) throw new Error(`Zustandsdatei gehört zu Modus ${String(parsed.mode)}`);
        state = { ...fresh(), ...parsed, version: STATE_VERSION } as PersistedState;
        // Positionen, die beim Crash gerade geschlossen wurden, wieder freigeben
        for (const p of state.positions) p.closing = false;
        log.info('Portfolio-Zustand geladen', {
          file,
          openPositions: state.positions.length,
          lpPaper: state.lp.length,
          closedHistory: state.closed.length,
        });
      } catch (e) {
        if (mode === 'LIVE' || strict) {
          // Im Live-Modus niemals mit leerem Zustand weitermachen: offene Positionen gingen "verloren"
          throw new Error(`Zustandsdatei ${file} unlesbar – manuell prüfen! (${errorMessage(e)})`);
        }
        const backup = `${file}.corrupt-${Date.now()}`;
        await fs.promises.rename(file, backup).catch(() => undefined);
        log.warn('Korrupte Simulations-Zustandsdatei gesichert, starte neu', { backup, error: errorMessage(e) });
        state = fresh();
      }
    }
    const pf = new Portfolio(file, mode, state, log);
    pf.rollDay();
    await pf.flush();
    return pf;
  }

  // ---------------------------------------------------------------- Positionen

  positions(): Position[] {
    return [...this.state.positions];
  }

  positionsFor(strategy: string): Position[] {
    return this.state.positions.filter((p) => p.strategy === strategy);
  }

  getPosition(id: string): Position | undefined {
    return this.state.positions.find((p) => p.id === id);
  }

  hasOpenPosition(mint: string): boolean {
    return this.state.positions.some((p) => p.mint === mint);
  }

  /** Summe der Einstandskosten aller offenen Positionen. */
  exposureLamports(): bigint {
    return this.state.positions.reduce((s, p) => s + p.costLamports, 0n);
  }

  openPosition(pos: Position): void {
    if (this.getPosition(pos.id)) throw new Error(`Position ${pos.id} existiert bereits`);
    this.state.positions.push(pos);
    if (this.mode === 'SIMULATION') this.state.virtualSolLamports -= pos.costLamports;
    this.stats(pos.strategy); // Eintrag anlegen
    this.markDirty();
  }

  updatePosition(id: string, patch: Partial<Omit<Position, 'id'>>): Position | undefined {
    const p = this.getPosition(id);
    if (!p) return undefined;
    Object.assign(p, patch);
    this.markDirty();
    return p;
  }

  /**
   * Schließt eine Position. `proceedsLamports` = gesamter SOL-Zufluss (nach Fees, inkl. zurückgeholter Rent).
   * `feesLamports` dient nur der Statistik (bereits in Kosten/Erlös enthalten).
   */
  closePosition(id: string, proceedsLamports: bigint, reason: string, feesLamports = 0n): ClosedTrade | undefined {
    const idx = this.state.positions.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    const p = this.state.positions[idx]!;
    this.state.positions.splice(idx, 1);

    const pnl = proceedsLamports - p.costLamports;
    const trade: ClosedTrade = {
      id: p.id,
      strategy: p.strategy,
      mint: p.mint,
      symbol: p.symbol,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      costLamports: p.costLamports,
      proceedsLamports,
      pnlLamports: pnl,
      pnlPct: pctChange(p.costLamports, proceedsLamports),
      reason,
      entrySignal: p.entrySignal,
    };
    this.state.closed.push(trade);
    if (this.state.closed.length > MAX_CLOSED_HISTORY) {
      this.state.closed.splice(0, this.state.closed.length - MAX_CLOSED_HISTORY);
    }

    if (this.mode === 'SIMULATION') this.state.virtualSolLamports += proceedsLamports;
    const st = this.stats(p.strategy);
    st.trades++;
    if (pnl >= 0n) st.wins++;
    else st.losses++;
    st.realizedPnlLamports += pnl;
    st.feesLamports += feesLamports;
    this.addDailyPnl(pnl);
    this.markDirty();
    return trade;
  }

  /** Bucht Gebühren gescheiterter Transaktionen (on-chain bezahlt bzw. virtuell). */
  chargeFee(strategy: string, lamports: bigint): void {
    if (lamports <= 0n) return;
    if (this.mode === 'SIMULATION') this.state.virtualSolLamports -= lamports;
    const st = this.stats(strategy);
    st.feesLamports += lamports;
    st.realizedPnlLamports -= lamports;
    this.addDailyPnl(-lamports);
    this.markDirty();
  }

  /** Bucht einen SOL-Zufluss ohne Position (z. B. zurückgeholte Rent). */
  creditLamports(strategy: string, lamports: bigint): void {
    if (lamports <= 0n) return;
    if (this.mode === 'SIMULATION') this.state.virtualSolLamports += lamports;
    this.stats(strategy).realizedPnlLamports += lamports;
    this.addDailyPnl(lamports);
    this.markDirty();
  }

  recentClosed(limit = 20): ClosedTrade[] {
    return this.state.closed.slice(-limit);
  }

  /** Strategy checkpoints share the same atomic file as balances and fills. */
  getStrategyData(key: string): unknown {
    return this.state.strategyData?.[key];
  }

  setStrategyData(key: string, value: unknown): void {
    this.state.strategyData ??= {};
    this.state.strategyData[key] = value;
    this.markDirty();
  }

  /** Realize a tranche. Rent basis stays with the final remainder; no rent refund here.
   * Each executed exit tranche is one realized trade in the existing statistics.
   */
  closePartial(id: string, soldRaw: bigint, proceedsLamports: bigint, reason: string, feesLamports = 0n): ClosedTrade {
    const p = this.getPosition(id);
    if (!p || soldRaw <= 0n || soldRaw >= p.tokenAmountRaw) throw new Error('Invalid partial exit amount');
    const held = p.tokenAmountRaw;
    const rent = BigInt(typeof p.tags.playbookRent === 'string' ? p.tags.playbookRent : '0');
    if (rent < 0n || rent > p.costLamports) throw new Error('Invalid rent basis');
    const basis = ((p.costLamports - rent) * soldRaw) / held;
    const input = (p.entryInputLamports * soldRaw) / held;
    // Use the ordinary realization path, but only for the sold lot.
    const lot = { ...p, id: `${p.id}:part:${held}`, tokenAmountRaw: soldRaw, costLamports: basis, entryInputLamports: input };
    this.state.positions.push(lot);
    const trade = this.closePosition(lot.id, proceedsLamports, reason, feesLamports)!;
    this.updatePosition(id, {
      tokenAmountRaw: held - soldRaw,
      costLamports: p.costLamports - basis,
      entryInputLamports: p.entryInputLamports - input,
      lastValueLamports: (p.lastValueLamports * (held - soldRaw)) / held,
      peakValueLamports: (p.peakValueLamports * (held - soldRaw)) / held,
    });
    return trade;
  }

  // ---------------------------------------------------------------- Cooldowns

  setCooldown(mint: string, ms: number): void {
    if (ms <= 0) return;
    this.state.cooldowns[mint] = Date.now() + ms;
    this.markDirty();
  }

  isCoolingDown(mint: string): boolean {
    const until = this.state.cooldowns[mint];
    if (until === undefined) return false;
    if (until <= Date.now()) {
      delete this.state.cooldowns[mint];
      this.markDirty();
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- Tages-PnL

  dailyPnlLamports(): bigint {
    this.rollDay();
    return this.state.daily.pnlLamports;
  }

  private addDailyPnl(delta: bigint): void {
    this.rollDay();
    this.state.daily.pnlLamports += delta;
  }

  private rollDay(): void {
    const today = utcDate();
    if (this.state.daily.date !== today) {
      if (this.state.daily.pnlLamports !== 0n) {
        this.log.info('Tageswechsel (UTC) – Tages-PnL zurückgesetzt', {
          date: this.state.daily.date,
          pnlSol: lamportsToSol(this.state.daily.pnlLamports),
        });
      }
      this.state.daily = { date: today, pnlLamports: 0n };
      this.markDirty();
    }
  }

  // ---------------------------------------------------------------- Virtuelles Konto

  virtualSolLamports(): bigint {
    return this.state.virtualSolLamports;
  }

  // ---------------------------------------------------------------- LP-Paper-Positionen

  lpPositions(strategy?: string): LpPaperPosition[] {
    return strategy ? this.state.lp.filter((l) => l.strategy === strategy) : [...this.state.lp];
  }

  addLp(lp: LpPaperPosition): void {
    this.state.lp.push(lp);
    this.markDirty();
  }

  updateLp(id: string, patch: Partial<Omit<LpPaperPosition, 'id'>>): void {
    const lp = this.state.lp.find((l) => l.id === id);
    if (!lp) return;
    Object.assign(lp, patch);
    this.markDirty();
  }

  /**
   * Schließt eine Paper-LP-Position. Wird unter `${strategy}:LP-PAPER` verbucht und beeinflusst
   * weder das virtuelle Guthaben noch den Tages-PnL (reine Strategie-Evaluierung).
   */
  closeLp(id: string): LpPaperPosition | undefined {
    const idx = this.state.lp.findIndex((l) => l.id === id);
    if (idx < 0) return undefined;
    const lp = this.state.lp[idx]!;
    this.state.lp.splice(idx, 1);
    const st = this.stats(`${lp.strategy}:LP-PAPER`);
    const pnl = BigInt(Math.round(lp.deltaNeutralPnlLamports));
    st.trades++;
    if (pnl >= 0n) st.wins++;
    else st.losses++;
    st.realizedPnlLamports += pnl;
    this.markDirty();
    return lp;
  }

  // ---------------------------------------------------------------- Statistik

  stats(key: string): StrategyStats {
    let st = this.state.stats[key];
    if (!st) {
      st = emptyStats();
      this.state.stats[key] = st;
    }
    return st;
  }

  allStats(): Record<string, StrategyStats> {
    return this.state.stats;
  }

  summary(): {
    mode: ExecMode;
    openPositions: number;
    lpPaperPositions: number;
    exposureSol: string;
    dailyPnlSol: string;
    realizedPnlSol: string;
    virtualBalanceSol: string | null;
    virtualReturnPct: number | null;
  } {
    const realized = Object.entries(this.state.stats)
      .filter(([k]) => !k.endsWith(':LP-PAPER'))
      .reduce((s, [, v]) => s + v.realizedPnlLamports, 0n);
    const sim = this.mode === 'SIMULATION';
    const equity = this.state.virtualSolLamports + this.exposureLamports();
    return {
      mode: this.mode,
      openPositions: this.state.positions.length,
      lpPaperPositions: this.state.lp.length,
      exposureSol: lamportsToSol(this.exposureLamports(), 4),
      dailyPnlSol: lamportsToSol(this.dailyPnlLamports()),
      realizedPnlSol: lamportsToSol(realized),
      virtualBalanceSol: sim ? lamportsToSol(this.state.virtualSolLamports, 4) : null,
      virtualReturnPct: sim ? pctChange(this.state.initialVirtualLamports, equity) : null,
    };
  }

  // ---------------------------------------------------------------- Persistenz

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch((e) => this.log.error('Speichern des Zustands fehlgeschlagen', { error: errorMessage(e) }));
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  /** Schreibt den Zustand sofort (atomisch). */
  flush(): Promise<void> {
    const pending = this.saveQueue.then(() => this.flushNow());
    this.saveQueue = pending.catch(() => undefined);
    return pending;
  }

  private async flushNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty && fs.existsSync(this.file)) return;
    this.dirty = false;
    this.state.updatedAt = new Date().toISOString();
    const data = JSON.stringify(this.state, replacer, 2);
    try {
      await atomicWriteFile(this.file, data);
    } catch (e) {
      // Beim nächsten Debounce-Zyklus erneut versuchen
      this.markDirty();
      throw e;
    }
  }
}

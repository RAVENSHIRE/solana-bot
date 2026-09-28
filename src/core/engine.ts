import { requestScope } from '../data/core/request-scope';
import type { DataRuntime } from '../data/core/data-runtime';
import type { Strategy } from './types';
import type { Portfolio } from './portfolio';
import type { RiskManager } from './risk-manager';
import type { TradeJournal } from './journal';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { TradeExecutor } from '../execution/executor';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { sleep } from '../utils/retry';
import { lamportsToSol } from '../utils/format';

export interface EngineDeps {
  data?: DataRuntime;
  portfolio: Portfolio;
  risk: RiskManager;
  journal: TradeJournal;
  rpc: ConnectionManager;
  executor: TradeExecutor;
  logger: Logger;
  heartbeatIntervalMs: number;
  tickTimeoutMs: number;
  shutdownGraceMs: number;
  rpcHealthIntervalMs: number;
}

type TaskKind = 'scan' | 'manage';

interface TaskState {
  controller: AbortController | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  consecutiveErrors: number;
  runs: number;
  lastDurationMs: number;
}

const MAX_ERROR_BACKOFF_MS = 15 * 60_000;

/**
 * Core-Engine: orchestriert Strategie-Plugins, ohne deren Logik zu kennen.
 * - Jede Strategie hat zwei unabhängige Schleifen (scan = Einstiege, manage = Exits)
 * - Selbst-planende setTimeout-Ketten → keine Überlappung desselben Tasks
 * - Harte Tick-Timeouts; Fehler führen zu exponentiellem Backoff statt Crash
 * - Heartbeat mit Speicher-, Positions- und PnL-Status
 * - Geordneter Shutdown: laufende Ticks abwarten, Zustand persistieren
 */
export class Engine {
  private readonly strategies: Strategy[] = [];
  private readonly tasks = new Map<string, TaskState>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly startedAt = Date.now();
  private readonly log: Logger;

  constructor(private readonly d: EngineDeps) {
    this.log = d.logger.child('engine');
  }

  register(strategy: Strategy): void {
    if (this.running) throw new Error('Strategien müssen vor start() registriert werden');
    if (this.strategies.some((s) => s.name === strategy.name)) throw new Error(`Strategie ${strategy.name} doppelt`);
    this.strategies.push(strategy);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const active = this.strategies.filter((s) => s.enabled);
    if (active.length === 0) throw new Error('Keine Strategie aktiviert (SUTR_ENABLED / RS_ENABLED)');

    for (const s of active) {
      await s.init();
      this.log.info(`Strategie initialisiert: ${s.name}`, { scanMs: s.scanIntervalMs, manageMs: s.manageIntervalMs });
    }
    this.running = true;
    this.d.rpc.startHealthLoop(this.d.rpcHealthIntervalMs);

    // Gestaffelter Start, damit nicht alle Strategien gleichzeitig die APIs belasten
    active.forEach((s, i) => {
      this.schedule(s, 'manage', 1_000 + i * 2_000);
      this.schedule(s, 'scan', 3_000 + i * 7_000);
    });

    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.d.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.log.info('Engine gestartet', { strategies: active.map((s) => s.name), mode: this.d.executor.mode });
  }

  private taskKey(s: Strategy, kind: TaskKind): string {
    return `${s.name}:${kind}`;
  }

  private schedule(s: Strategy, kind: TaskKind, delayMs: number): void {
    if (!this.running) return;
    const key = this.taskKey(s, kind);
    let st = this.tasks.get(key);
    if (!st) {
      st = { controller: null, timer: null, running: null, consecutiveErrors: 0, runs: 0, lastDurationMs: 0 };
      this.tasks.set(key, st);
    }
    const state = st;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.running = this.runTask(s, kind, state).finally(() => {
        state.running = null;
      });
    }, delayMs);
  }

  private async runTask(s: Strategy, kind: TaskKind, st: TaskState): Promise<void> {
    const base = kind === 'scan' ? s.scanIntervalMs : s.manageIntervalMs;
    const started = Date.now();
    let next = base;
    const controller = new AbortController(); st.controller = controller;
    const deadline = setTimeout(() => {
      controller.abort(new Error(`${s.name}.${kind} deadline exceeded`));
      this.log.warn('Task deadline reached; waiting for cancellation before rescheduling', { strategy: s.name, kind });
    }, this.d.tickTimeoutMs);
    try {
      await requestScope.run({ category: kind === 'manage' ? 'position' : 'discovery', strategy: s.name, signal: controller.signal },
        () => kind === 'scan' ? s.scan() : s.manage());
      controller.signal.throwIfAborted();
      st.consecutiveErrors = 0;
    } catch (e) {
      st.consecutiveErrors++;
      next = Math.min(MAX_ERROR_BACKOFF_MS, base * 2 ** Math.min(st.consecutiveErrors, 6));
      const logFn = st.consecutiveErrors >= 3 ? this.log.error.bind(this.log) : this.log.warn.bind(this.log);
      logFn(`${s.name}.${kind} fehlgeschlagen`, {
        error: errorMessage(e),
        consecutive: st.consecutiveErrors,
        nextInMs: next,
      });
    } finally {
      clearTimeout(deadline); st.controller = null;
      st.runs++;
      st.lastDurationMs = Date.now() - started;
      this.schedule(s, kind, Math.max(250, next - (kind === 'manage' ? 0 : Math.min(st.lastDurationMs, base / 2))));
    }
  }

  private heartbeat(): void {
    const mem = process.memoryUsage();
    const summary = this.d.portfolio.summary();
    const rpc = this.d.rpc.status();
    const tasks = Object.fromEntries(
      [...this.tasks.entries()].map(([k, v]) => [k, { runs: v.runs, errs: v.consecutiveErrors, lastMs: v.lastDurationMs }]),
    );
    const providers = this.d.data?.health.snapshot();
    this.d.data?.record('provider-health', 'engine', { providers, droppedHistoryRecords: this.d.data.history?.dropped ?? 0 });
    this.log.info('♥ Heartbeat', {
      providers,
      uptimeMin: Math.round((Date.now() - this.startedAt) / 60_000),
      rssMb: Math.round(mem.rss / 1_048_576),
      heapMb: Math.round(mem.heapUsed / 1_048_576),
      ...summary,
      risk: this.d.risk.statusText(),
      rpc: rpc.map((r) => `${r.label}:${r.latencyMs ?? '-'}ms${r.cooling ? '(cooldown)' : ''}`).join(' '),
      tasks,
    });
    for (const [name, st] of Object.entries(this.d.portfolio.allStats())) {
      if (st.trades === 0 && st.feesLamports === 0n) continue;
      this.log.info(`Statistik ${name}`, {
        trades: st.trades,
        winRate: st.trades > 0 ? `${Math.round((st.wins / st.trades) * 100)}%` : '-',
        pnlSol: lamportsToSol(st.realizedPnlLamports),
        feesSol: lamportsToSol(st.feesLamports),
      });
    }
  }

  /**
   * Stoppt alle Schleifen und wartet auf laufende Ticks (max. shutdownGraceMs).
   * Offene Positionen bleiben bewusst bestehen (kein Panik-Verkauf bei Restart/Deploy)
   * und werden nach dem Neustart aus der Zustandsdatei weiterverwaltet.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log.info('Engine wird gestoppt …');
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.d.rpc.stopHealthLoop();
    for (const st of this.tasks.values()) {
      st.controller?.abort(new Error('Engine shutdown'));
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    }
    const inflight = [...this.tasks.values()].map((t) => t.running).filter((p): p is Promise<void> => p !== null);
    if (inflight.length > 0) {
      this.log.info(`Warte auf ${inflight.length} laufende Tasks (max. ${this.d.shutdownGraceMs} ms)`);
      await Promise.race([Promise.allSettled(inflight), sleep(this.d.shutdownGraceMs)]);
    }
    for (const s of this.strategies.filter((x) => x.enabled)) {
      await s.shutdown().catch((e) => this.log.warn(`Shutdown ${s.name} fehlerhaft`, { error: errorMessage(e) }));
    }
    await this.d.journal.flush();
    await this.d.portfolio.flush();
    this.heartbeat();
    await this.d.data?.flush();
    this.log.info('Engine gestoppt, Zustand gespeichert');
  }
}

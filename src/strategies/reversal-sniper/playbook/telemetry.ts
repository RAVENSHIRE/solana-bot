import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TradeRecord } from '../../../core/types';
import type { Snapshot, Intent } from './model';

/** Existing dashboard telemetry contract; unknown scores/likelihoods remain null. */
export class PlaybookTelemetry {
  private readonly started = Date.now();
  private readonly decisions: Array<{ id: string; ts: number; symbol: string; mint: string; action: string; label: string; score: null; latency_ms: number; price_usd: number; safety: { liquidity_usd: number | null } }> = [];
  private readonly prices = new Map<string, Array<{ t: number; price_usd: number; marker: 'BUY' | 'SELL' | null }>>();
  private readonly watches = new Map<string, { mint: string; symbol: string; name: null; price_usd: number; sparkline: number[]; last_action: string; score: null; updated_at: number }>();
  private readonly trades: TradeRecord[] = [];
  private readonly equity: Array<{ t: number; equity_lamports: number; equity_usd: number | null }> = [];
  private queue: Promise<void> = Promise.resolve();
  private solUsd: number | null = null;
  private solAt: number | null = null;
  constructor(private readonly dir: string) {}
  observe(s: Snapshot, intent: Intent, latency: number): void {
    const action = intent.type === 'RE_ENTRY' ? 'BUY' : intent.type;
    const ticks = this.prices.get(s.mint) ?? [];
    const tick = { t: s.observedAt, price_usd: s.priceUsd, marker: action === 'BUY' || action === 'SELL' ? action : null } as const;
    if (ticks.at(-1)?.t === tick.t) ticks[ticks.length - 1] = tick; else ticks.push(tick);
    this.prices.set(s.mint, ticks.slice(-400));
    this.watches.delete(s.mint);
    this.watches.set(s.mint, { mint: s.mint, symbol: s.symbol, name: null, price_usd: s.priceUsd, sparkline: ticks.slice(-60).map(t => t.price_usd), last_action: action, score: null, updated_at: s.observedAt });
    if (s.solUsd && s.solUsd > 0) { this.solUsd = s.solUsd; this.solAt = s.observedAt; }
    this.decisions.push({ id: randomUUID(), ts: Date.now(), symbol: s.symbol, mint: s.mint, action, label: intent.reason, score: null, latency_ms: Math.max(0, latency), price_usd: s.priceUsd, safety: { liquidity_usd: s.liquidityUsd } });
    this.decisions.splice(0, Math.max(0, this.decisions.length - 300));
    while (this.watches.size > 40) { const mint = this.watches.keys().next().value!; this.watches.delete(mint); this.prices.delete(mint); }
  }
  trade(record: Omit<TradeRecord, 'ts' | 'mode'>): void {
    this.trades.push({ ...record, ts: new Date().toISOString(), mode: 'SIMULATION' });
    this.trades.splice(0, Math.max(0, this.trades.length - 500));
  }
  markEquity(lamports: bigint, now = Date.now()): void {
    if (lamports < 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const fresh = this.solAt !== null && now - this.solAt <= 90_000;
    this.equity.push({ t: now, equity_lamports: Number(lamports), equity_usd: fresh && this.solUsd !== null ? Number(lamports) / 1e9 * this.solUsd : null });
    this.equity.splice(0, Math.max(0, this.equity.length - 2880));
  }
  flush(): Promise<void> {
    const write = this.queue.then(async () => {
      const file = path.join(this.dir, 'dashboard-SIMULATION.json');
      const data = { version: 1, bot_name: 'Reversal Sniper · Playbook', mode: 'SIMULATION', network: 'Solana Mainnet', started_at: this.started,
        updated_at: Date.now(), decision_cadence_seconds: 15, sol_usd: this.solUsd, sol_usd_at: this.solAt, rpc: [],
        decisions: this.decisions, watchlist: [...this.watches.values()],
        series: [...this.prices].map(([mint, ticks]) => ({ mint, symbol: this.watches.get(mint)!.symbol, updated_at: ticks.at(-1)!.t, ticks })),
        trades: this.trades, equity: this.equity };
      await fs.writeFile(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}

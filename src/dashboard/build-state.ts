import type { PersistedState } from '../core/portfolio';
import type { TelemetryFile, TelemetrySeries } from '../core/telemetry';
import type { Position, TradeRecord } from '../core/types';
import type { ActiveToken, BotState, Decision, LpView, Mode, PositionView, TradeView, WatchAction, WatchItem } from './contract';

export interface BuildInput {
  mode: Mode;
  state: PersistedState | null;
  telemetry: TelemetryFile | null;
  stateFile: string;
  telemetryFile: string;
  stateMtimeMs: number | null;
  telemetryMtimeMs: number | null;
  errors: string[];
  now: number;
}

const ONLINE_WINDOW_MS = 90_000;
const SKIP_WINDOW_MS = 24 * 3_600_000;
const RECENT_CLOSE_MS = 60 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();
const sol = (lamports: bigint | number): number => Number(lamports) / 1e9;
const finite = (n: number | null | undefined): number | null => (n !== null && n !== undefined && Number.isFinite(n) ? n : null);
const num = (s: string | null | undefined): number | null => (s === null || s === undefined ? null : finite(Number(s)));
const pct = (from: number, to: number): number | null => (from > 0 ? ((to - from) / from) * 100 : null);

/** Übersetzt die Rohdateien des Bots in den Dashboard-Vertrag. Reine Funktion, keine I/O. */
export function buildBotState(i: BuildInput): BotState {
  const st = i.state;
  const tel = i.telemetry;
  const solUsd = finite(tel?.sol_usd ?? null);
  const usd = (v: number | null): number | null => (v !== null && solUsd !== null ? v * solUsd : null);

  const positions = st?.positions ?? [];
  const closed = st?.closed ?? [];
  const statsEntries = Object.entries(st?.stats ?? {}).filter(([k]) => !k.endsWith(':LP-PAPER'));

  // ------------------------------------------------------------------ Equity
  const openValue = positions.reduce((s, p) => s + p.lastValueLamports, 0n);
  let equitySol: number | null = null;
  let returnPct: number | null = null;
  const lastSample = tel?.equity[tel.equity.length - 1];
  if (st && i.mode === 'SIMULATION') {
    equitySol = sol(st.virtualSolLamports + openValue);
    returnPct = pct(sol(st.initialVirtualLamports), equitySol);
  } else if (lastSample) {
    equitySol = sol(lastSample.equity_lamports);
    const first = tel?.equity[0];
    returnPct = first ? pct(sol(first.equity_lamports), equitySol) : null;
  }

  const equityCurve = (tel?.equity ?? []).map((e) => ({
    timestamp: iso(e.t),
    equity_sol: sol(e.equity_lamports),
    equity_usd: usd(sol(e.equity_lamports)),
  }));
  let maxDd: number | null = null;
  if (equityCurve.length > 1) {
    let peak = -Infinity;
    let dd = 0;
    for (const p of equityCurve) {
      peak = Math.max(peak, p.equity_sol);
      if (peak > 0) dd = Math.max(dd, ((peak - p.equity_sol) / peak) * 100);
    }
    maxDd = dd;
  }

  // ------------------------------------------------------------------ Statistik
  const totalTrades = st ? statsEntries.reduce((s, [, v]) => s + v.trades, 0) : null;
  const wins = statsEntries.reduce((s, [, v]) => s + v.wins, 0);
  const feesSol = st ? sol(statsEntries.reduce((s, [, v]) => s + v.feesLamports, 0n)) : null;
  const realized = st ? sol(statsEntries.reduce((s, [, v]) => s + v.realizedPnlLamports, 0n)) : null;
  const holds = closed.map((c) => (c.closedAt - c.openedAt) / 1000).filter((v) => v >= 0);

  const decisionsRaw = tel?.decisions ?? [];
  const latencies = decisionsRaw.filter((d) => d.latency_ms > 0).map((d) => d.latency_ms);
  const skipped = new Set(
    decisionsRaw.filter((d) => (d.action === 'SKIP' || d.action === 'WAIT') && i.now - d.ts <= SKIP_WINDOW_MS).map((d) => d.mint),
  );
  const rpcLat = (tel?.rpc ?? []).map((r) => r.latency_ms).filter((v): v is number => v !== null);

  // ------------------------------------------------------------------ Listen
  const seriesByMint = new Map((tel?.series ?? []).map((s) => [s.mint, s]));
  const openMints = new Set(positions.map((p) => p.mint));
  const recentlyClosed = new Set(closed.filter((c) => i.now - c.closedAt <= RECENT_CLOSE_MS).map((c) => c.mint));

  const decisions: Decision[] = [...decisionsRaw].reverse().slice(0, 150).map((d) => ({
    id: d.id,
    strategy: d.strategy,
    symbol: d.symbol,
    contract_address: d.mint,
    timestamp: iso(d.ts),
    action: d.action,
    action_label: d.label,
    confidence_pct: d.score,
    min_score: d.min_score,
    score_components: d.components,
    latency_ms: d.latency_ms > 0 ? d.latency_ms : null,
    price_usd: d.price_usd,
    safety: {
      checks_passed: d.safety.checks_passed,
      reasons: d.safety.reasons,
      wash_ratio_pct: d.safety.wash_ratio !== null ? d.safety.wash_ratio * 100 : null,
      organic_score: d.safety.organic_score,
      liquidity_usd: d.safety.liquidity_usd,
    },
  }));

  const watchlist: WatchItem[] = [...(tel?.watchlist ?? [])].reverse().slice(0, 25).map((w) => {
    let action: WatchAction = w.last_action;
    if (openMints.has(w.mint)) action = 'HOLD';
    else if (recentlyClosed.has(w.mint)) action = 'CLOSE';
    return {
      id: w.mint,
      symbol: w.symbol,
      name: w.name,
      strategy: w.strategy,
      price_usd: w.price_usd,
      sparkline: w.sparkline,
      ai_status: { action, confidence_pct: w.score },
      updated_at: iso(w.updated_at),
    };
  });

  const positionViews: PositionView[] = positions.map((p) => positionView(p, seriesByMint.get(p.mint), solUsd));

  const tradeHistory: TradeView[] =
    tel && tel.trades.length > 0
      ? [...tel.trades].reverse().slice(0, 200).map((r, idx) => tradeView(r, idx, solUsd))
      : [...closed].reverse().slice(0, 200).map((c) => ({
          id: c.id,
          strategy: c.strategy,
          symbol: c.symbol,
          token_address: c.mint,
          action: 'SELL',
          side: 'SELL' as const,
          in_amount: '--',
          out_amount: `${sol(c.proceedsLamports).toFixed(6)} SOL`,
          fees_sol: null,
          realized_pnl_sol: sol(c.pnlLamports),
          realized_pnl_usd: usd(sol(c.pnlLamports)),
          realized_pnl_pct: c.pnlPct,
          slippage_pct: null,
          price_impact_pct: null,
          tx_hash: null,
          signal: c.reason,
          timestamp: iso(c.closedAt),
        }));

  const lp: LpView[] = (st?.lp ?? []).map((l) => ({
    id: l.id,
    pair: l.pairName,
    pool_id: l.poolId,
    deposit_sol: l.depositLamports / 1e9,
    fee_apr_pct: l.feeAprPct,
    fees_sol: l.accruedFeesLamports / 1e9,
    unhedged_pnl_sol: l.unhedgedPnlLamports / 1e9,
    delta_neutral_pnl_sol: l.deltaNeutralPnlLamports / 1e9,
    price_move_pct: l.entryTokenPriceSol > 0 ? (l.lastTokenPriceSol / l.entryTokenPriceSol - 1) * 100 : 0,
    opened_at: iso(l.openedAt),
  }));

  const telUpdated = tel?.updated_at ?? null;
  return {
    generated_at: iso(i.now),
    source: {
      state_file: i.stateFile,
      telemetry_file: i.telemetryFile,
      state_updated_at: i.stateMtimeMs !== null ? iso(i.stateMtimeMs) : null,
      telemetry_updated_at: telUpdated !== null ? iso(telUpdated) : null,
      bot_online: telUpdated !== null && i.now - telUpdated <= ONLINE_WINDOW_MS,
      errors: i.errors,
    },
    meta: {
      bot_name: tel?.bot_name ?? 'Solana Autonomous Bot',
      mode: i.mode,
      network: tel?.network ?? 'Solana Mainnet',
      decision_cadence_seconds: tel?.decision_cadence_seconds ?? null,
      rpc_latency_ms: rpcLat.length > 0 ? Math.min(...rpcLat) : null,
      active_tokens_count: positions.length,
      skipped_tokens_count: skipped.size,
      closed_tokens_count: closed.length,
      sol_usd: solUsd,
    },
    metrics: {
      total_equity_usd: usd(equitySol),
      total_equity_sol: equitySol,
      return_percentage: returnPct,
      realized_pnl_sol: realized,
      daily_pnl_sol: st ? sol(st.daily.pnlLamports) : null,
      gas_priority_fees_paid_usd: usd(feesSol),
      gas_priority_fees_paid_sol: feesSol,
      total_trades: totalTrades,
      win_rate_percentage: totalTrades ? (wins / totalTrades) * 100 : null,
      avg_hold_duration_seconds: holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      max_drawdown_percentage: maxDd,
      avg_decision_time_ms: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      total_decisions: tel ? decisionsRaw.length : null,
    },
    active_token: activeToken(positions, tel, closed, solUsd),
    watchlist,
    decisions,
    positions: positionViews,
    trade_history: tradeHistory,
    equity_curve: equityCurve,
    lp_paper: lp,
  };
}

function positionView(p: Position, series: TelemetrySeries | undefined, solUsd: number | null): PositionView {
  const tokens = Number(p.tokenAmountRaw) / 10 ** p.decimals;
  const entrySol = tokens > 0 ? sol(p.entryInputLamports) / tokens : null;
  const lastTick = series?.ticks[series.ticks.length - 1];
  // Einstiegskurs aus dem tatsächlichen Fill (BUY-Tick mit SOL/USD zum Kaufzeitpunkt)
  const buyTick = series ? [...series.ticks].reverse().find((t) => t.marker === 'BUY' && t.t >= p.openedAt - 60_000) : undefined;
  const currentSol = lastTick ? lastTick.price_sol : tokens > 0 ? sol(p.lastValueLamports) / tokens : null;
  const currentUsd = lastTick?.price_usd ?? (currentSol !== null && solUsd !== null ? currentSol * solUsd : null);
  const entryUsd =
    buyTick?.price_usd ?? (entrySol !== null && solUsd !== null ? entrySol * solUsd : null) ?? p.entryPriceUsd ?? null;
  const pnlSol = sol(p.lastValueLamports - p.costLamports);
  const cost = sol(p.costLamports);
  return {
    id: p.id,
    strategy: p.strategy,
    symbol: p.symbol,
    token_address: p.mint,
    side: 'LONG',
    entry_price_usd: entryUsd,
    current_price_usd: currentUsd,
    entry_price_sol: entrySol,
    current_price_sol: currentSol,
    size_tokens: tokens,
    cost_sol: cost,
    value_sol: sol(p.lastValueLamports),
    unrealized_pnl_usd: solUsd !== null ? pnlSol * solUsd : null,
    unrealized_pnl_sol: pnlSol,
    unrealized_pnl_pct: cost > 0 ? (pnlSol / cost) * 100 : 0,
    stop_loss_pct: p.exitRules.stopLossPct,
    take_profit_pct: p.exitRules.takeProfitPct,
    stop_loss_usd: entryUsd !== null ? entryUsd * (1 - p.exitRules.stopLossPct / 100) : null,
    take_profit_usd: entryUsd !== null ? entryUsd * (1 + p.exitRules.takeProfitPct / 100) : null,
    opened_at: iso(p.openedAt),
    entry_signal: p.entrySignal,
    closing: p.closing,
  };
}

function tradeView(r: TradeRecord, idx: number, solUsd: number | null): TradeView {
  const pnlSol = num(r.pnlSol);
  const side = r.action === 'BUY' || r.action === 'BUY_FAILED' ? 'BUY' : r.action === 'SELL' || r.action === 'SELL_FAILED' ? 'SELL' : null;
  return {
    id: `${r.ts}-${idx}`,
    strategy: r.strategy,
    symbol: r.symbol,
    token_address: r.mint,
    action: r.action,
    side,
    in_amount: r.inAmount,
    out_amount: r.outAmount,
    fees_sol: num(r.feesSol),
    realized_pnl_sol: pnlSol,
    realized_pnl_usd: pnlSol !== null && solUsd !== null ? pnlSol * solUsd : null,
    realized_pnl_pct: r.pnlPct,
    slippage_pct: r.slippageBps !== null ? r.slippageBps / 100 : null,
    price_impact_pct: r.priceImpactPct,
    tx_hash: r.signature,
    signal: r.signal,
    timestamp: r.ts,
  };
}

/** Offene Position mit den jüngsten Ticks; sonst die zuletzt gehandelte Serie. */
function activeToken(
  positions: Position[],
  tel: TelemetryFile | null,
  closed: PersistedState['closed'],
  solUsd: number | null,
): ActiveToken | null {
  if (!tel || tel.series.length === 0) return null;
  const openMints = new Set(positions.map((p) => p.mint));
  const byRecency = [...tel.series].sort((a, b) => b.updated_at - a.updated_at);
  const series = byRecency.find((s) => openMints.has(s.mint)) ?? byRecency[0];
  if (!series || series.ticks.length === 0) return null;

  const useUsd = series.ticks.every((t) => t.price_usd !== null);
  const priceOf = (t: { price_sol: number; price_usd: number | null }): number => (useUsd ? t.price_usd! : t.price_sol);
  const last = series.ticks[series.ticks.length - 1]!;
  const lastT = last.t;

  // 2-Minuten-Fenster relativ zum Kurs zu Fensterbeginn
  const window = series.ticks.filter((t) => lastT - t.t <= 120_000);
  let hi: number | null = null;
  let lo: number | null = null;
  if (window.length >= 2) {
    const base = priceOf(window[0]!);
    const vals = window.map(priceOf);
    hi = pct(base, Math.max(...vals));
    lo = pct(base, Math.min(...vals));
  }

  const buys = series.ticks.filter((t) => t.marker === 'BUY');
  const lastBuy = buys[buys.length - 1];
  const isOpen = openMints.has(series.mint);
  const watch = tel.watchlist.find((w) => w.mint === series.mint);
  const pos = positions.find((p) => p.mint === series.mint);
  const closedTrade = [...closed].reverse().find((c) => c.mint === series.mint);

  return {
    symbol: series.symbol,
    name: watch?.name ?? null,
    contract_address: series.mint,
    price_unit: useUsd ? 'USD' : 'SOL',
    current_price_usd: last.price_usd ?? (solUsd !== null ? last.price_sol * solUsd : null),
    current_price_sol: last.price_sol,
    price_change_2m_high: hi,
    price_change_2m_low: lo,
    baseline_entry_price: lastBuy && (pos || closedTrade) ? priceOf(lastBuy) : null,
    is_open_position: isOpen,
    ticks: series.ticks.map((t) => ({ timestamp: iso(t.t), price: priceOf(t), action_marker: t.marker })),
  };
}

/**
 * Zustandsvertrag zwischen Dashboard-Server und Browser (GET /api/state, SSE-Event "state").
 *
 * Grundregel: Jeder Wert stammt aus state-{MODE}.json oder dashboard-{MODE}.json. Was der Bot
 * nicht misst, ist null und wird im UI als "--" dargestellt – es wird nichts geschätzt oder erfunden.
 *
 * Abweichungen vom ursprünglichen Entwurf (bewusst, weil der Bot diese Daten nicht erzeugt):
 *  - decisions[].probabilities (long/short/wait) → ersetzt durch score + score_components.
 *    Der Bot entscheidet regelbasiert über einen Score, er berechnet keine Wahrscheinlichkeiten.
 *  - safety.rug_score_pct → ersetzt durch die tatsächlichen Prüfergebnisse (checks_passed, reasons,
 *    wash_ratio_pct, organic_score). Es gibt keinen kalibrierten Rug-Prozentwert.
 *  - positions[].side ist immer "LONG" (Spot-Käufe; Shorts sind nicht möglich).
 *  - watchlist[].ai_status.confidence_pct ist der regelbasierte Score (0–100), kein KI-Modell.
 *  - Zusätzlich: SOL-Werte neben USD, lp_paper (LP-Simulation von SuckUpTheRent), source (Datenfrische).
 */

export type Mode = 'SIMULATION' | 'LIVE';
export type DecisionAction = 'BUY' | 'SELL' | 'SKIP' | 'WAIT';
export type WatchAction = 'HOLD' | 'SKIP' | 'CLOSE' | 'BUY' | 'SELL' | 'WAIT';

export interface BotState {
  generated_at: string;
  source: {
    state_file: string;
    telemetry_file: string;
    state_updated_at: string | null;
    telemetry_updated_at: string | null;
    /** Telemetrie in den letzten 90 s aktualisiert → Bot-Prozess läuft. */
    bot_online: boolean;
    errors: string[];
  };
  meta: {
    bot_name: string;
    mode: Mode;
    network: string;
    decision_cadence_seconds: number | null;
    rpc_latency_ms: number | null;
    active_tokens_count: number;
    skipped_tokens_count: number;
    closed_tokens_count: number;
    sol_usd: number | null;
  };
  metrics: {
    total_equity_usd: number | null;
    total_equity_sol: number | null;
    return_percentage: number | null;
    realized_pnl_sol: number | null;
    daily_pnl_sol: number | null;
    gas_priority_fees_paid_usd: number | null;
    gas_priority_fees_paid_sol: number | null;
    total_trades: number | null;
    win_rate_percentage: number | null;
    avg_hold_duration_seconds: number | null;
    max_drawdown_percentage: number | null;
    avg_decision_time_ms: number | null;
    total_decisions: number | null;
  };
  active_token: ActiveToken | null;
  watchlist: WatchItem[];
  decisions: Decision[];
  positions: PositionView[];
  trade_history: TradeView[];
  equity_curve: Array<{ timestamp: string; equity_usd: number | null; equity_sol: number }>;
  lp_paper: LpView[];
}

export interface ActiveToken {
  symbol: string;
  name: string | null;
  contract_address: string;
  /** Einheit der Tick-Preise: USD, wenn für alle Ticks ein SOL/USD-Kurs vorlag, sonst SOL. */
  price_unit: 'USD' | 'SOL';
  current_price_usd: number | null;
  current_price_sol: number | null;
  /** Höchste/niedrigste Veränderung in % innerhalb der letzten 2 Minuten (relativ zum Kurs vor 2 min). */
  price_change_2m_high: number | null;
  price_change_2m_low: number | null;
  /** Einstiegskurs (gleiche Einheit wie ticks), null wenn keine offene/letzte Position. */
  baseline_entry_price: number | null;
  is_open_position: boolean;
  ticks: Array<{ timestamp: string; price: number; action_marker: 'BUY' | 'SELL' | null }>;
}

export interface WatchItem {
  id: string;
  symbol: string;
  name: string | null;
  strategy: string;
  price_usd: number | null;
  sparkline: number[];
  ai_status: { action: WatchAction; confidence_pct: number | null };
  updated_at: string;
}

export interface Decision {
  id: string;
  strategy: string;
  symbol: string;
  contract_address: string;
  timestamp: string;
  action: DecisionAction;
  action_label: string;
  confidence_pct: number | null;
  min_score: number | null;
  score_components: Array<{ label: string; value: number; max: number }>;
  latency_ms: number | null;
  price_usd: number | null;
  safety: {
    checks_passed: boolean | null;
    reasons: string[];
    wash_ratio_pct: number | null;
    organic_score: number | null;
    liquidity_usd: number | null;
  };
}

export interface PositionView {
  id: string;
  strategy: string;
  symbol: string;
  token_address: string;
  side: 'LONG';
  entry_price_usd: number | null;
  current_price_usd: number | null;
  entry_price_sol: number | null;
  current_price_sol: number | null;
  size_tokens: number;
  cost_sol: number;
  value_sol: number;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_sol: number;
  unrealized_pnl_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  /** Ungefähre Preisniveaus (Einstieg × (1 ∓ %)); Exits werden auf Positionswert inkl. Fees geprüft. */
  stop_loss_usd: number | null;
  take_profit_usd: number | null;
  opened_at: string;
  entry_signal: string;
  closing: boolean;
}

export interface TradeView {
  id: string;
  strategy: string;
  symbol: string;
  token_address: string;
  action: string;
  side: 'BUY' | 'SELL' | null;
  in_amount: string;
  out_amount: string;
  fees_sol: number | null;
  realized_pnl_sol: number | null;
  realized_pnl_usd: number | null;
  realized_pnl_pct: number | null;
  slippage_pct: number | null;
  price_impact_pct: number | null;
  tx_hash: string | null;
  signal: string;
  timestamp: string;
}

export interface LpView {
  id: string;
  pair: string;
  pool_id: string;
  deposit_sol: number;
  fee_apr_pct: number;
  fees_sol: number;
  unhedged_pnl_sol: number;
  delta_neutral_pnl_sol: number;
  price_move_pct: number;
  opened_at: string;
}

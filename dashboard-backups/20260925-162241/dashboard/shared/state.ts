import { z } from "zod";

// Null means unmeasured, never zero. All keys are required; unknown keys are rejected.
const number = z.number().finite();
const nonnegative = number.nonnegative();
const pct = number.min(0).max(100);
const count = nonnegative.int();
const text = z.string().min(1).nullable();
const timestamp = z.union([
  z.string().datetime({ offset: true }),
  z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
]);
const object = z.object;
export const BotStateSchema = object({
  meta: object({
    bot_name: text,
    mode: z.enum(["SIMULATION", "LIVE"]),
    network: text,
    decision_cadence_seconds: nonnegative.nullable(),
    rpc_latency_ms: nonnegative.nullable(),
    active_tokens_count: count.nullable(),
    skipped_tokens_count: count.nullable(),
    closed_tokens_count: count.nullable(),
  }).strict(),
  metrics: object({
    total_equity_usd: nonnegative.nullable(),
    return_percentage: number.nullable(),
    gas_priority_fees_paid_usd: nonnegative.nullable(),
    total_trades: count.nullable(),
    win_rate_percentage: pct.nullable(),
    avg_hold_duration_seconds: nonnegative.nullable(),
    max_drawdown_percentage: pct.nullable(),
    avg_decision_time_ms: nonnegative.nullable(),
    total_decisions: count.nullable(),
  }).strict(),
  active_token: object({
    symbol: text,
    name: text,
    contract_address: text,
    current_price_usd: nonnegative.nullable(),
    price_change_2m_high: number.nullable(),
    price_change_2m_low: number.nullable(),
    baseline_entry_price: nonnegative.nullable(),
    ticks: z
      .array(
        object({
          timestamp,
          price: nonnegative,
          action_marker: z.enum(["BUY", "SELL"]).nullable().optional(),
        }).strict(),
      )
      .max(10000),
  })
    .strict()
    .nullable(),
  watchlist: z
    .array(
      object({
        id: z.string(),
        symbol: text,
        name: text,
        price_usd: nonnegative.nullable(),
        sparkline: z.array(nonnegative).max(1000),
        ai_status: object({
          action: z.enum(["HOLD", "SKIP", "CLOSE", "BUY", "SELL"]).nullable(),
          confidence_pct: pct.nullable(),
        }).strict(),
      }).strict(),
    )
    .max(1000),
  decisions: z
    .array(
      object({
        id: z.string(),
        symbol: text,
        timestamp,
        action: z.enum(["BUY", "SELL", "SKIP", "WAIT"]),
        action_label: text,
        probabilities: object({
          long_pct: pct.nullable(),
          short_pct: pct.nullable(),
          wait_pct: pct.nullable(),
        }).strict(),
        confidence_pct: pct.nullable(),
        latency_ms: nonnegative.nullable(),
        safety: object({
          rug_score_pct: pct.nullable(),
          liquidity_usd: nonnegative.nullable(),
        }).strict(),
      }).strict(),
    )
    .max(10000),
  positions: z
    .array(
      object({
        id: z.string(),
        symbol: text,
        token_address: text,
        side: z.enum(["LONG", "SHORT"]),
        entry_price_usd: nonnegative.nullable(),
        current_price_usd: nonnegative.nullable(),
        size_tokens: nonnegative.nullable(),
        unrealized_pnl_usd: number.nullable(),
        unrealized_pnl_pct: number.nullable(),
        stop_loss_usd: nonnegative.nullable(),
        take_profit_usd: nonnegative.nullable(),
        opened_at: timestamp,
      }).strict(),
    )
    .max(10000),
  trade_history: z
    .array(
      object({
        id: z.string(),
        symbol: text,
        side: z.enum(["BUY", "SELL"]),
        realized_pnl_usd: number.nullable(),
        realized_pnl_pct: number.nullable(),
        slippage_pct: nonnegative.nullable(),
        tx_hash: text,
        timestamp,
      }).strict(),
    )
    .max(10000),
  equity_curve: z
    .array(object({ timestamp, equity_usd: nonnegative }).strict())
    .max(10000),
}).strict();

export interface BotState extends z.infer<typeof BotStateSchema> {}
export type StreamSnapshot = {
  state: BotState | null;
  status: "ready" | "missing" | "invalid";
  source: "contract" | "checkpoint" | null;
  updated_at: string | null;
  message: string | null;
};
export function emptyState(mode: BotState["meta"]["mode"]): BotState {
  return {
    meta: {
      bot_name: null,
      mode,
      network: null,
      decision_cadence_seconds: null,
      rpc_latency_ms: null,
      active_tokens_count: null,
      skipped_tokens_count: null,
      closed_tokens_count: null,
    },
    metrics: {
      total_equity_usd: null,
      return_percentage: null,
      gas_priority_fees_paid_usd: null,
      total_trades: null,
      win_rate_percentage: null,
      avg_hold_duration_seconds: null,
      max_drawdown_percentage: null,
      avg_decision_time_ms: null,
      total_decisions: null,
    },
    active_token: null,
    watchlist: [],
    decisions: [],
    positions: [],
    trade_history: [],
    equity_curve: [],
  };
}

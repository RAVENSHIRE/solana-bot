import { z } from "zod";
import {
  BotStateSchema,
  emptyState,
  type BotState,
  type StreamSnapshot,
} from "../shared/state";
import { CheckpointSchema, parseState } from "./adapter";

const n = z.number().finite();
const positive = n.nonnegative();
const ms = positive.max(8.64e15);
const action = z.enum(["BUY", "SELL", "SKIP", "WAIT"]);
const price = positive.nullable();
// Native src/core/telemetry.ts format. Validate consumed fields; allow producer extensions.
export const TelemetrySchema = z.object({
  version: z.literal(1),
  bot_name: z.string(),
  mode: z.enum(["SIMULATION", "LIVE"]),
  network: z.string(),
  started_at: ms,
  updated_at: ms,
  decision_cadence_seconds: positive.nullable(),
  sol_usd: price,
  sol_usd_at: ms.nullable(),
  rpc: z
    .array(z.object({ latency_ms: positive.nullable(), cooling: z.boolean() }))
    .max(100),
  decisions: z
    .array(
      z.object({
        id: z.string(),
        ts: ms,
        symbol: z.string(),
        mint: z.string(),
        action,
        label: z.string(),
        score: n.min(0).max(100).nullable(),
        latency_ms: positive,
        price_usd: price,
        safety: z.object({ liquidity_usd: price }),
      }),
    )
    .max(10000),
  watchlist: z
    .array(
      z.object({
        mint: z.string(),
        symbol: z.string(),
        name: z.string().nullable(),
        price_usd: price,
        sparkline: z.array(positive).max(1000),
        last_action: action,
        score: n.min(0).max(100).nullable(),
        updated_at: ms,
      }),
    )
    .max(1000),
  series: z
    .array(
      z.object({
        mint: z.string(),
        symbol: z.string(),
        updated_at: ms,
        ticks: z
          .array(
            z.object({
              t: ms,
              price_usd: price,
              marker: z.enum(["BUY", "SELL"]).nullable(),
            }),
          )
          .max(10000),
      }),
    )
    .max(1000),
  market_ticks: z
    .array(
      z.object({
        mint: z.string(),
        symbol: z.string(),
        t: ms,
        price_usd: positive,
      }),
    )
    .max(10000)
    .optional(),
  trades: z
    .array(
      z.object({
        ts: z.string().datetime({ offset: true }),
        symbol: z.string(),
        action: z.string(),
        pnlPct: n.nullable(),
        slippageBps: n.nullable(),
        signature: z.string().nullable(),
      }),
    )
    .max(10000),
  equity: z
    .array(
      z.object({
        t: ms,
        equity_lamports: positive,
        equity_usd: price.optional(),
      }),
    )
    .max(10000),
});
const iso = (ms: number) => new Date(ms).toISOString();
const text = (s: string | null) => s?.trim() || null;
const FRESH_MS = 90_000;

/** Join the native telemetry with the unchanged portfolio checkpoint. Never reprice historical USD. */
export function adaptTelemetry(
  input: unknown,
  checkpoint?: unknown,
): Pick<StreamSnapshot, "state" | "source" | "runtime" | "token_charts"> {
  const tel = TelemetrySchema.parse(input);
  const raw = checkpoint == null ? null : CheckpointSchema.parse(checkpoint);
  if (raw && raw.mode !== tel.mode)
    throw new Error("Checkpoint and telemetry modes differ.");
  const state = raw ? parseState(checkpoint).state : emptyState(tel.mode);
  const sol =
    tel.sol_usd_at !== null &&
    tel.updated_at - tel.sol_usd_at >= 0 &&
    tel.updated_at - tel.sol_usd_at <= FRESH_MS
      ? tel.sol_usd
      : null;
  const fresh = (at: number) =>
    tel.updated_at >= at && tel.updated_at - at <= FRESH_MS;
  state.meta.bot_name = text(tel.bot_name);
  state.meta.network = text(tel.network);
  state.meta.decision_cadence_seconds = tel.decision_cadence_seconds;
  state.meta.rpc_latency_ms =
    tel.rpc.find((r) => !r.cooling && r.latency_ms !== null)?.latency_ms ??
    null;
  state.meta.skipped_tokens_count = new Set(
    tel.decisions.filter((d) => d.action === "SKIP").map((d) => d.mint),
  ).size;
  state.metrics.total_decisions = tel.decisions.length;
  state.metrics.avg_decision_time_ms = tel.decisions.length
    ? tel.decisions.reduce((sum, d) => sum + d.latency_ms, 0) /
      tel.decisions.length
    : null;
  const equity = tel.equity.at(-1);
  state.metrics.total_equity_usd =
    equity && fresh(equity.t)
      ? (equity.equity_usd ??
        (sol === null ? null : (equity.equity_lamports / 1e9) * sol))
      : null;
  // USD fees and P&L need conversion at execution time, which the native writer doesn't record.
  // Current SOL/USD must never be substituted for that historical conversion.
  state.equity_curve = tel.equity.flatMap((e) =>
    e.equity_usd == null
      ? []
      : [{ timestamp: iso(e.t), equity_usd: e.equity_usd }],
  );
  if (tel.equity.length > 1) {
    let peak = 0,
      drawdown = 0;
    for (const e of tel.equity) {
      peak = Math.max(peak, e.equity_lamports);
      if (peak > 0)
        drawdown = Math.max(
          drawdown,
          ((peak - e.equity_lamports) / peak) * 100,
        );
    }
    state.metrics.max_drawdown_percentage = drawdown;
  }
  const stats = raw
    ? Object.entries(raw.stats)
        .filter(([name]) => !name.endsWith(":LP-PAPER"))
        .map(([, s]) => s)
    : [];
  if (raw && stats.every((s) => s.feesLamports === 0n))
    state.metrics.gas_priority_fees_paid_usd = 0;
  state.decisions = tel.decisions.map((d) => ({
    id: d.id,
    symbol: text(d.symbol),
    timestamp: iso(d.ts),
    action: d.action,
    action_label: text(d.label),
    probabilities: { long_pct: null, short_pct: null, wait_pct: null },
    confidence_pct: null,
    strategy_score: d.score,
    latency_ms: d.latency_ms,
    safety: { rug_score_pct: null, liquidity_usd: d.safety.liquidity_usd },
  }));
  const series = new Map<
    string,
    NonNullable<BotState["active_token"]>["ticks"]
  >();
  const add = (
    mint: string,
    t: number,
    value: number | null,
    marker?: "BUY" | "SELL" | null,
  ) => {
    if (value === null) return;
    const ticks = series.get(mint) ?? [];
    ticks.push({ timestamp: iso(t), price: value, action_marker: marker });
    series.set(mint, ticks);
  };
  // Decision/watch timestamps identify actual observations; untimestamped sparklines are never expanded into ticks.
  for (const d of tel.decisions) add(d.mint, d.ts, d.price_usd);
  for (const w of tel.watchlist) add(w.mint, w.updated_at, w.price_usd);
  for (const t of tel.market_ticks ?? []) add(t.mint, t.t, t.price_usd);
  for (const s of tel.series)
    for (const t of s.ticks) add(s.mint, t.t, t.price_usd, t.marker);
  const charts: NonNullable<StreamSnapshot["token_charts"]> = {};
  const identities = new Map(
    tel.watchlist.map((w) => [w.mint, { symbol: w.symbol, name: w.name }]),
  );
  for (const s of tel.series)
    if (!identities.has(s.mint))
      identities.set(s.mint, { symbol: s.symbol, name: null });
  for (const [mint, identity] of identities) {
    const ticks = [
      ...new Map(
        (series.get(mint) ?? [])
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          .map((t) => [t.timestamp, t]),
      ).values(),
    ].slice(-400);
    const last = ticks.at(-1),
      window = ticks.filter(
        (t) => tel.updated_at - Date.parse(t.timestamp) <= 120000,
      );
    const start = window[0]?.price;
    charts[mint] = {
      symbol: text(identity.symbol),
      name: text(identity.name),
      contract_address: mint,
      current_price_usd:
        last && fresh(Date.parse(last.timestamp)) ? last.price : null,
      baseline_entry_price:
        state.positions.find((p) => p.token_address === mint)
          ?.entry_price_usd ?? null,
      price_change_2m_high:
        window.length > 1 && start > 0
          ? (Math.max(...window.map((t) => t.price)) / start - 1) * 100
          : null,
      price_change_2m_low:
        window.length > 1 && start > 0
          ? (Math.min(...window.map((t) => t.price)) / start - 1) * 100
          : null,
      ticks,
    };
  }
  state.watchlist = [...tel.watchlist]
    .sort((a, b) => b.updated_at - a.updated_at)
    .map((w) => ({
      id: w.mint,
      symbol: text(w.symbol),
      name: text(w.name),
      price_usd: charts[w.mint]?.current_price_usd ?? null,
      sparkline: w.sparkline,
      ai_status: {
        action: state.positions.some((p) => p.token_address === w.mint)
          ? "HOLD"
          : w.last_action === "WAIT"
            ? "HOLD"
            : w.last_action,
        confidence_pct: null,
      },
      strategy_score: w.score,
    }));
  for (const p of state.positions)
    p.current_price_usd = p.token_address
      ? (charts[p.token_address]?.current_price_usd ?? null)
      : null;
  state.active_token =
    Object.values(charts).find((c) =>
      state.positions.some((p) => p.token_address === c.contract_address),
    ) ??
    charts[state.watchlist[0]?.id] ??
    Object.values(charts)[0] ??
    null;
  // Completed spot journal events only. LP and failed orders are not BUY/SELL executions.
  const trades = tel.trades.filter(
    (t) => t.action === "BUY" || t.action === "SELL",
  );
  if (trades.length)
    state.trade_history = trades.map((t, i) => ({
      id: `${t.ts}-${i}`,
      symbol: text(t.symbol),
      side: t.action as "BUY" | "SELL",
      realized_pnl_usd: null,
      realized_pnl_pct: t.pnlPct,
      slippage_pct: t.slippageBps === null ? null : t.slippageBps / 100,
      tx_hash: text(t.signature),
      timestamp: t.ts,
    }));
  return {
    state: BotStateSchema.parse(state),
    source: "runtime",
    token_charts: charts,
    runtime: {
      started_at: iso(tel.started_at),
      sol_usd: sol,
      sol_usd_at: tel.sol_usd_at === null ? null : iso(tel.sol_usd_at),
    },
  };
}

import { z } from "zod";
import { BotStateSchema, emptyState, type BotState } from "../shared/state";

const amount = z
  .object({ $bigint: z.string().regex(/^-?\d+$/) })
  .strict()
  .transform((v) => BigInt(v.$bigint));
const finite = z.number().finite();
const millis = finite.nonnegative().max(8.64e15);
export const CheckpointSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["SIMULATION", "LIVE"]),
  initialVirtualLamports: amount,
  virtualSolLamports: amount,
  positions: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      mint: z.string(),
      decimals: z.number().int().min(0).max(30),
      tokenAmountRaw: amount,
      costLamports: amount,
      entryPriceUsd: finite.nonnegative().nullable(),
      openedAt: millis,
      lastValueLamports: amount,
      exitRules: z.object({
        stopLossPct: finite.nonnegative(),
        takeProfitPct: finite.nonnegative(),
      }),
    }),
  ),
  closed: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      mint: z.string(),
      openedAt: millis,
      closedAt: millis,
      pnlPct: finite,
    }),
  ),
  stats: z.record(
    z.object({
      trades: finite.int().nonnegative(),
      wins: finite.int().nonnegative(),
      feesLamports: amount.optional(),
    }),
  ),
});

function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  const result = Number((numerator * 1_000_000n) / denominator) / 10_000;
  return Number.isFinite(result) ? result : null;
}

export function parseState(input: unknown): {
  state: BotState;
  source: "contract" | "checkpoint";
} {
  if (typeof input === "object" && input !== null && "meta" in input) {
    return { state: BotStateSchema.parse(input), source: "contract" };
  }
  const raw = CheckpointSchema.parse(input);
  const state = emptyState(raw.mode);
  const stats = Object.entries(raw.stats)
    .filter(([name]) => !name.endsWith(":LP-PAPER"))
    .map(([, value]) => value);
  const trades = stats.reduce((sum, value) => sum + value.trades, 0);
  const wins = stats.reduce((sum, value) => sum + value.wins, 0);
  state.meta.active_tokens_count = new Set(
    raw.positions.map((p) => p.mint),
  ).size;
  state.meta.closed_tokens_count = new Set(raw.closed.map((p) => p.mint)).size;
  // Portfolio.summary() uses cash + entry costs (book equity), not mark-to-market USD equity.
  if (raw.mode === "SIMULATION") {
    const book =
      raw.virtualSolLamports +
      raw.positions.reduce((sum, p) => sum + p.costLamports, 0n);
    state.metrics.return_percentage = ratio(
      book - raw.initialVirtualLamports,
      raw.initialVirtualLamports,
    );
  }
  state.metrics.total_trades = trades;
  state.metrics.win_rate_percentage = trades > 0 ? (wins / trades) * 100 : null;
  const durations = raw.closed
    .filter((p) => p.closedAt >= p.openedAt)
    .map((p) => (p.closedAt - p.openedAt) / 1000);
  state.metrics.avg_hold_duration_seconds = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;
  state.positions = raw.positions.map((p) => ({
    id: p.id,
    symbol: p.symbol || null,
    token_address: p.mint || null,
    side: "LONG",
    entry_price_usd: p.entryPriceUsd,
    current_price_usd: null,
    size_tokens: Number(p.tokenAmountRaw) / 10 ** p.decimals,
    unrealized_pnl_usd: null,
    unrealized_pnl_pct: ratio(
      p.lastValueLamports - p.costLamports,
      p.costLamports,
    ),
    stop_loss_usd:
      p.entryPriceUsd === null
        ? null
        : Math.max(0, p.entryPriceUsd * (1 - p.exitRules.stopLossPct / 100)),
    take_profit_usd:
      p.entryPriceUsd === null
        ? null
        : p.entryPriceUsd * (1 + p.exitRules.takeProfitPct / 100),
    opened_at: new Date(p.openedAt).toISOString(),
  }));
  state.trade_history = raw.closed.map((p) => ({
    id: p.id,
    symbol: p.symbol || null,
    side: "SELL",
    realized_pnl_usd: null,
    realized_pnl_pct: p.pnlPct,
    slippage_pct: null,
    tx_hash: null,
    timestamp: new Date(p.closedAt).toISOString(),
  }));
  // A position is not an AI watchlist, and an entry price is not a current price.
  return { state: BotStateSchema.parse(state), source: "checkpoint" };
}

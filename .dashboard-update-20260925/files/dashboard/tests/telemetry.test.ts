import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { adaptTelemetry } from "../server/telemetry-adapter";
import { StateStore } from "../server/state-store";
import { DashboardStore } from "../server/dashboard-store";

// Synthetic inputs are tests only. Runtime has no fixtures or seeded values.
const at = Date.parse("2026-09-25T12:00:00Z");
function telemetry() {
  return {
    version: 1,
    bot_name: "test",
    mode: "SIMULATION",
    network: "test network",
    started_at: at - 60000,
    updated_at: at,
    decision_cadence_seconds: 30,
    sol_usd: 100,
    sol_usd_at: at,
    rpc: [{ latency_ms: 42, cooling: false }],
    decisions: [
      {
        id: "d",
        ts: at - 30000,
        symbol: "TOKEN",
        mint: "mint",
        action: "WAIT",
        label: "Score below threshold",
        score: 51,
        latency_ms: 20,
        price_usd: 2,
        safety: { liquidity_usd: 123 },
      },
    ],
    watchlist: [
      {
        mint: "mint",
        symbol: "TOKEN",
        name: "Token",
        price_usd: 3,
        sparkline: [1, 2, 3],
        last_action: "WAIT",
        score: 51,
        updated_at: at,
      },
    ],
    series: [
      {
        mint: "mint",
        symbol: "TOKEN",
        updated_at: at,
        ticks: [{ t: at - 50000, price_usd: null, marker: "BUY" }],
      },
    ],
    market_ticks: [
      { mint: "mint", symbol: "TOKEN", t: at - 10000, price_usd: 2.5 },
    ],
    trades: [
      {
        ts: new Date(at).toISOString(),
        symbol: "TOKEN",
        action: "BUY_FAILED",
        pnlPct: null,
        slippageBps: null as number | null,
        signature: null,
      },
    ],
    equity: [
      { t: at - 30000, equity_lamports: 5e9 },
      { t: at, equity_lamports: 4e9, equity_usd: 400 },
    ],
  };
}
const checkpoint = () => ({
  version: 1,
  mode: "SIMULATION",
  initialVirtualLamports: { $bigint: "5000000000" },
  virtualSolLamports: { $bigint: "5000000000" },
  positions: [],
  closed: [],
  stats: {},
});
test("native telemetry maps measured data, distinct strategy scores and signed slippage without fabricated history", () => {
  const raw = telemetry();
  const mapped = adaptTelemetry(raw, checkpoint());
  const s = mapped.state!;
  assert.equal(s.metrics.total_equity_usd, 400);
  assert.equal(s.metrics.return_percentage, 0);
  assert.equal(s.metrics.max_drawdown_percentage, 20);
  assert.equal(s.metrics.avg_decision_time_ms, 20);
  assert.equal(s.meta.rpc_latency_ms, 42);
  assert.equal(s.watchlist[0].strategy_score, 51);
  assert.equal(s.watchlist[0].ai_status.confidence_pct, null);
  assert.equal(s.decisions[0].probabilities.long_pct, null);
  assert.equal(s.decisions[0].safety.rug_score_pct, null);
  assert.deepEqual(
    s.active_token?.ticks.map((t) => t.price),
    [2, 2.5, 3],
  );
  assert.equal(
    s.active_token?.ticks.some((t) => t.action_marker === "BUY"),
    false,
  );
  assert.equal(s.trade_history.length, 0);
  assert.equal(s.equity_curve.length, 1); // old SOL-only history is not retroactively valued in USD
  raw.trades = [
    {
      ts: new Date(at).toISOString(),
      symbol: "TOKEN",
      action: "BUY",
      pnlPct: null,
      slippageBps: -20,
      signature: null,
    },
  ];
  assert.equal(adaptTelemetry(raw).state!.trade_history[0].slippage_pct, -0.2);
  raw.updated_at += 120000;
  const stale = adaptTelemetry(raw).state!;
  assert.equal(stale.active_token?.current_price_usd, null);
  assert.equal(stale.metrics.total_equity_usd, null);
  assert.equal(stale.active_token?.price_change_2m_high, null);
  assert.throws(() => adaptTelemetry({ ...raw, mode: "LIVE" }, checkpoint()));
});
test("dual file store joins checkpoint and telemetry, preserves state on bad writes and recovers", async () => {
  const dir = await mkdtemp(path.resolve(".telemetry-test-"));
  const c = new StateStore(path.join(dir, "state.json"), 60000);
  const t = new StateStore(
    path.join(dir, "dashboard.json"),
    60000,
    adaptTelemetry,
  );
  const store = new DashboardStore(c, t);
  try {
    await writeFile(c.file, JSON.stringify(checkpoint()));
    await store.start();
    assert.equal(store.snapshot.source, "checkpoint");
    await writeFile(t.file, JSON.stringify(telemetry()));
    await t.refresh();
    assert.equal(store.snapshot.source, "runtime");
    assert.equal(store.snapshot.state?.metrics.total_trades, 0);
    assert.equal(store.snapshot.state?.watchlist.length, 1);
    await writeFile(t.file, "{");
    await t.refresh();
    assert.equal(store.snapshot.status, "invalid");
    assert.equal(store.snapshot.state?.watchlist.length, 1);
    const next = checkpoint();
    next.virtualSolLamports.$bigint = "4000000000";
    await writeFile(c.file, JSON.stringify(next));
    await c.refresh();
    assert.equal(store.snapshot.state?.metrics.return_percentage, -20);
    await writeFile(t.file, JSON.stringify(telemetry()));
    await t.refresh();
    assert.equal(store.snapshot.status, "ready");
    await rm(t.file);
    await t.refresh();
    assert.equal(store.snapshot.status, "missing");
    assert.equal(store.snapshot.source, "runtime");
    assert.equal(store.snapshot.state?.watchlist.length, 1);
  } finally {
    store.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

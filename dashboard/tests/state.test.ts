import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { BotStateSchema, emptyState } from "../shared/state";
import { parseState } from "../server/adapter";
import { StateStore } from "../server/state-store";

// Synthetic accounting values are confined to tests; no fixture is served by the app.
const bigint = (value: string) => ({ $bigint: value });
function checkpoint() {
  return {
    version: 1,
    mode: "SIMULATION",
    initialVirtualLamports: bigint("10000000000"),
    virtualSolLamports: bigint("9500000000"),
    positions: [
      {
        id: "position",
        symbol: "TEST",
        mint: "test-mint",
        decimals: 6,
        tokenAmountRaw: bigint("100000000"),
        costLamports: bigint("1000000000"),
        entryPriceUsd: 0.001,
        openedAt: 1700000000000,
        lastValueLamports: bigint("1100000000"),
        exitRules: { stopLossPct: 10, takeProfitPct: 20 },
      },
    ],
    closed: [
      {
        id: "closed",
        symbol: "TEST",
        mint: "test-mint",
        openedAt: 1700000000000,
        closedAt: 1700000060000,
        pnlPct: 20,
      },
    ],
    stats: {
      strategy: { trades: 4, wins: 3 },
      "strategy:LP-PAPER": { trades: 100, wins: 100 },
    },
  };
}
test("contract accepts explicit nulls and zero, rejects unknown keys, missing keys and invalid ranges", () => {
  const state = emptyState("SIMULATION");
  state.metrics.total_equity_usd = 0;
  assert.equal(BotStateSchema.parse(state).metrics.total_equity_usd, 0);
  assert.equal(
    BotStateSchema.safeParse({ ...state, extra: true }).success,
    false,
  );
  assert.equal(
    BotStateSchema.safeParse({ ...state, metrics: {} }).success,
    false,
  );
  assert.equal(
    BotStateSchema.safeParse({
      ...state,
      metrics: { ...state.metrics, win_rate_percentage: 101 },
    }).success,
    false,
  );
  assert.equal(
    BotStateSchema.safeParse({
      ...state,
      equity_curve: [{ timestamp: "25:00:00", equity_usd: 1 }],
    }).success,
    false,
  );
  assert.equal(
    BotStateSchema.safeParse({
      ...state,
      equity_curve: [{ timestamp: "2026-09-25T10:00:00+02:00", equity_usd: 1 }],
    }).success,
    true,
  );
  assert.equal(
    BotStateSchema.safeParse({
      ...state,
      equity_curve: [{ timestamp: "10:00:00", equity_usd: NaN }],
    }).success,
    false,
  );
});
test("checkpoint mapping preserves units, excludes LP stats, and never fabricates USD or telemetry", () => {
  const { state, source } = parseState(checkpoint());
  assert.equal(source, "checkpoint");
  assert.equal(state.metrics.total_trades, 4);
  assert.equal(state.metrics.win_rate_percentage, 75);
  assert.equal(state.metrics.return_percentage, 5);
  assert.equal(state.metrics.avg_hold_duration_seconds, 60);
  assert.equal(state.positions[0].size_tokens, 100);
  assert.equal(state.positions[0].unrealized_pnl_pct, 10);
  assert.equal(state.positions[0].current_price_usd, null);
  assert.equal(state.positions[0].unrealized_pnl_usd, null);
  assert.equal(state.metrics.total_equity_usd, null);
  assert.equal(state.metrics.gas_priority_fees_paid_usd, null);
  assert.equal(state.meta.rpc_latency_ms, null);
  assert.equal(state.trade_history[0].tx_hash, null);
  assert.equal(state.active_token, null);
  assert.deepEqual(state.decisions, []);
  assert.deepEqual(state.watchlist, []);
  const live = parseState({ ...checkpoint(), mode: "LIVE" }).state;
  assert.equal(live.metrics.return_percentage, null);
  assert.throws(() =>
    parseState({ ...checkpoint(), virtualSolLamports: { $bigint: "bad" } }),
  );
});
async function until(condition: () => boolean, limit = 3000) {
  const end = Date.now() + limit;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for file update");
    await pause(25);
  }
}
test("watcher handles a missing directory, partial writes, atomic replacement, deletion and replay", async () => {
  const dir = await mkdtemp(path.resolve(".watcher-test-"));
  const file = path.join(dir, "nested", "state.json");
  const store = new StateStore(file, 30);
  try {
    await store.start();
    assert.equal(store.snapshot.status, "missing");
    await mkdir(path.dirname(file));
    const state = emptyState("SIMULATION");
    state.metrics.total_trades = 1;
    await writeFile(file, JSON.stringify(state));
    await until(() => store.snapshot.status === "ready");
    assert.equal(store.snapshot.state?.metrics.total_trades, 1);
    await writeFile(file, "{");
    await until(() => store.snapshot.status === "invalid");
    assert.equal(store.snapshot.state?.metrics.total_trades, 1);
    state.metrics.total_trades = 2;
    await writeFile(file + ".tmp", JSON.stringify(state));
    await rename(file + ".tmp", file);
    await until(() => store.snapshot.state?.metrics.total_trades === 2);
    let replayed = false;
    const unsubscribe = store.subscribe((snapshot) => {
      replayed = snapshot.state?.metrics.total_trades === 2;
    });
    assert.equal(replayed, true);
    unsubscribe();
    await rm(file);
    await until(() => store.snapshot.status === "missing");
    assert.equal(store.snapshot.state?.metrics.total_trades, 2);
    await writeFile(file, JSON.stringify(state));
    await until(() => store.snapshot.status === "ready");
  } finally {
    store.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

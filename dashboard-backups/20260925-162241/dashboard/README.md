# Local bot dashboard

A standalone React + TypeScript + Tailwind frontend, served by a small Node server. The server monitors a local state file and broadcasts validated snapshots over Server-Sent Events. It never starts the trading engine, submits trades, changes modes or writes to the state file.

## Run

Use Node 20.19+ (or 22.12+). From the repository root:

```bash
cd dashboard
npm ci
npm run build
npm start
```

Open **http://localhost:3000**. Run the bot separately as usual (`npm run sim` from the repository root). No wallet credentials are required by the dashboard. With no bot state, the page opens normally with `--` and empty charts.

### Windows launcher

Double-click `dashboard\start-dashboard.cmd` in File Explorer after extracting the complete dashboard directory. It switches into its own directory, verifies that `package.json` belongs to `solana-bot-dashboard`, installs dependencies, builds, and starts the server. Each step must succeed before the next starts. Leave its window open while using the dashboard.

If a failed patch left an empty `dashboard` directory, extract the complete ZIP into the repository root. Confirm that `dashboard\package.json` and `dashboard\start-dashboard.cmd` both exist before launching. A literal `/path/to/...` in an example is a placeholder, not a Windows file location. The ZIP workflow requires no patch command.

The default path is `data/state-SIMULATION.json` in the repository root, regardless of the shell working directory. If the bot uses a custom `STATE_DIR`, point the dashboard to that file explicitly. Dashboard configuration uses process environment variables; it deliberately does not load the bot's `.env` file.

```bash
BOT_STATE_FILE=/absolute/path/state-SIMULATION.json DASHBOARD_PORT=3000 npm start
```

PowerShell:

```powershell
$env:BOT_STATE_FILE = 'C:\bot\data\state-SIMULATION.json'
npm start
```

`npm run dev` serves the same local API with Vite development middleware. Refresh the page after frontend edits (HMR is disabled to keep one loopback port). `npm test` runs schema, accounting adapter and file lifecycle tests. `npm run schema` regenerates the checked-in JSON Schema from its TypeScript source.

## State contract

`shared/state.ts` exports `BotState`, `BotStateSchema` and `StreamSnapshot`. `shared/bot-state.schema.json` is the generated Draft 7 JSON Schema. The Zod contract is the single source of truth; TypeScript and JSON Schema are derived from it.

All contract keys are required, unknown keys are rejected, and all numeric values must be finite. **Unmeasured scalar values are `null`**, not zero. `active_token` may be null; unrecorded collections are empty arrays. Real zero values remain visible. This deliberately extends the requested non-null interfaces to represent the requested uninitialized state without manufacturing financial values. There is no demo state, seed data, random price generator or external market-price request in the runtime.

The dashboard accepts either:

1. The existing version-1 portfolio checkpoint, including `{$bigint: "..."}` values. The server adapts only measurements present in that checkpoint.
2. A complete `BotState` JSON document from an instrumented producer, supplied via `BOT_STATE_FILE`. **Do not replace the trading engine's checkpoint with a dashboard document**: the engine needs its existing checkpoint to restore positions. Write a separate telemetry file when using the full contract.

The current engine does not produce the full telemetry contract. In particular, it does not persist timestamped USD ticks, AI decision probabilities, RPC latency, mark-to-market USD equity or transaction signatures in its checkpoint. Those elements intentionally stay empty until a producer records them. The dashboard is ready to display these fields when supplied; this change does not add an AI model or alter strategy execution.

### Field semantics

| Fields                                    | Meaning                                                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.*`                                  | Producer-supplied bot name, execution mode, network, cadence, measured latency and token counts. The mode label never controls execution.                                                             |
| `metrics.*_usd`                           | USD measurements only; SOL is never relabeled as dollars.                                                                                                                                             |
| `return_percentage`                       | Producer return for the full contract. In checkpoint mode, cash plus entry costs relative to initial virtual SOL, explicitly labeled **Return · SOL book**, matching `Portfolio.summary()`.           |
| `active_token.price_change_2m_high/low`   | Percentage changes at the two-minute high/low, shown as H/L under **2m change**, not absolute dollar prices.                                                                                          |
| `active_token.ticks`                      | Oldest-first timestamped observations for the producer's selected window. Each optional BUY/SELL marker is attached to that actual tick. No price history is synthesized.                             |
| `baseline_entry_price`                    | USD entry reference drawn only when supplied.                                                                                                                                                         |
| `watchlist[].id`                          | Stable token mint/address. Match `active_token.contract_address` to select its detailed chart. Other tokens show their own summary and sparkline; no timestamped ticks are inferred from a sparkline. |
| `decisions` / `trade_history`             | Oldest-first arrays, displayed newest-first. IDs must be unique within a collection.                                                                                                                  |
| `probabilities`                           | Percentages in [0,100]. Complete distributions should sum to 100 (rounding tolerance 0.5). Otherwise the bar is unavailable; raw supplied values remain visible.                                      |
| `safety.rug_score_pct`                    | Producer's rug-risk percentage, not an independently verified safety claim.                                                                                                                           |
| `positions.stop_loss_usd/take_profit_usd` | Token price thresholds, not portfolio dollar exposure. Checkpoint thresholds are computed from entry USD price and recorded exit rules; execution remains based on the bot's own rules.               |
| `equity_curve`                            | Oldest-first measured USD equity observations. Nothing is backfilled.                                                                                                                                 |
| Timestamps                                | ISO 8601 with timezone (recommended), or HH:MM:SS. Use one format per series. Time-only ticks may cross midnight; ISO timestamps display in the browser's timezone.                                   |

Checkpoint adaptation uses distinct open mints for active tokens and distinct mints in retained closed history for closed tokens. Trade/win counts use non-LP strategy statistics. Average hold is based on retained closed trades (the engine caps this history), not an all-time statistic. Open/closed P&L percentages retain the checkpoint's SOL basis and are labeled accordingly. Current prices, USD P&L, USD fees, skipped counts, AI actions and confidence remain null when unavailable. Open positions are spot LONG; retained closed records represent SELL exits. LP-paper positions are excluded from these spot metrics.

## Streaming and failure handling

- `GET /api/state`: current envelope, including `state`, `status`, `source`, `updated_at`, and `message`.
- `GET /api/events`: SSE `state` events; a new/reconnected client immediately receives the latest envelope. Browser EventSource retries automatically.
- One file monitor per server polls metadata every 250 ms and reads only on changes. Atomic rename and files/directories created after startup are supported.
- Partial/malformed/oversized files never replace the last valid state. The visible status changes to **Invalid state** or **Waiting for state**. Recovery publishes the next valid snapshot.
- A heartbeat every 15 seconds keeps the transport alive. The file's own modification time drives freshness; **Connected** does not imply the bot is trading. Unchanged files become **Stale state** after the greater of 60 seconds or three decision cadences. A quiet portfolio can be stale even when the engine is running.
- File reads are capped at 16 MiB; slow SSE clients disconnect and replay on reconnect. Chart/array bounds are specified by the schema.
- The server binds to `127.0.0.1` and validates Host/Origin. It exposes only read endpoints, no source-file download or credentials. It is intended for a local browser, not public deployment.

The reference geometry is implemented as a narrow navigation rail, seven metric cards, a 60/40 market/activity split, scrollable watchlist, and four functional activity tabs. It adapts to a single column on tablet/mobile. Navigation, tabs, copy controls and data-source details work without trading permissions.

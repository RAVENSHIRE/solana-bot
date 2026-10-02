# Forensic audit · 2 Oct 2026

Scope: branch `claude/session-title-unavailable-wennx2` at `63f4e0e` (68 commits beyond `main`, which holds PR #1). Everything below was read in the repository. Nothing was run against mainnet, and no wallet, key or `.env` was read.

## 1. Map

| Area | Where | Notes |
| --- | --- | --- |
| Entry points | `src/index.ts` (legacy engine: ReversalSniper + SuckUpTheRent), `src/strategies/reversal-sniper/playbook/runtime.ts` (paper playbook), `src/micro/runtime.ts` (micro profile), `dashboard/server/index.ts` → `src/desk/runtime.ts` (**the trading desk, the live system**), `src/scripts/desk-*.ts` (headless TEST, backtests, replay) | The desk is started from the dashboard (`dashboard/start-background.cmd` on Windows) |
| Strategies | `src/desk/config.ts`, `strategies.ts`, `custom.ts`, `golden-pocket.ts`, `opening.ts`, `launches.ts` | FAIR, CRASH, LAUNCH, OPEN, GOLDEN + custom rule strategies (MIGRATION, CONSOL, SCALP, RUNNER presets) |
| Scoring | `src/desk/analysis.ts` (FUNDAMENTAL/SOCIAL/MARKET/ONCHAIN/RISK/MOMENTUM), `launches.ts` (radar score), `review.ts` (Claude review) | Scores rank; gates decide |
| Data sources | DexScreener, GeckoTerminal, Birdeye (backtests), Jupiter quotes, Solana RPC (pump.fun migration authority, mint authority, curve and PumpSwap reserves, DAS holders), X profile pages and X API, Anthropic API | `src/data/*` validated clients with zod, health and rate limits |
| Storage | `data-desk/` (git-ignored): `events-<MODE>.json` + `.log.jsonl`, `tape-<MODE>.jsonl`, `ledger-*.json`, `settings-*.json`, `strategies.json`, `rugs.json`, `watch.json`, `backtest-cache/`, `replay-cache/` | JSON / JSONL files; no database |
| Notifications | `src/desk/watch.ts` `notifier()` (ntfy + Telegram), `engine.ts` `alertOnce()` (one choke point), `DESK_ALERTS` selection | The "notification system" the owner relies on is **ntfy** (there is no Netlify code in this repository or in MemeOS / MEOSv1) |
| Frontend | `dashboard/src/*` (React + Vite), `src/dashboard/*` (legacy dashboard) | Views over engine state |
| Backend | `dashboard/server/*` (node:http, loopback, capability token, Phantom broker) | |
| Schedulers | `DeskEngine` loops: scan, positions every 2–5 s, opening tracker 4 s, golden tracker 4 s, radar, X feed 30 s | In-process timers |
| Secrets | `.env` (allowlisted keys in `desk/runtime.ts`), `WALLET_PRIVATE_KEY` read only by `local-signer.ts` | Redaction helpers in `utils/redact.ts` |
| AI | `desk/assistant.ts` (strategy assistant), `desk/review.ts` (launch review), both Claude via `ANTHROPIC_API_KEY` | |
| Backtesting | `src/desk/backtest.ts`, `replay.ts`, `scripts/desk-backtest.ts`, `desk-golden.ts`, `backtest-data.ts` | Candle replays over every graduation, cached downloads |
| Execution | `src/desk/guard.ts`, `engine.ts` (quote → route → unsigned simulation → pre-flight → signature persisted → broadcast), `local-signer.ts`, Phantom broker | TEST and LIVE share the path; TEST stops before signing |
| Tests | `tests/*.test.ts` (desk, golden, launches, watch, …), `dashboard/tests/*` | Synthetic fixtures only |
| Windows | `.cmd` / `.ps1` launchers, `.vscode/tasks.json`, QuickEdit workaround, `atomicWriteFile` retries on `EPERM` | Paths are `path.join`-based; no POSIX-only calls in the engine |
| Deployment | PM2 config (legacy bot), Windows PC "Raven" runs the desk; `docs/VPS-V2.md` is a plan only | |

## 2. Verdict per area

**A. What works (preserve):**
- Validated provider clients (`src/data/*`): every response is schema-checked, freshness-checked (`assertFresh`) and source-attributed (`Observation`: `sourceAt` vs `receivedAt`). This is a good base for events.
- The execution guard: quote identity, unsigned RPC simulation, pre-flight record, signature persisted before broadcast, halt (never retry) on unknown outcome, exits never blocked.
- Honest research culture in `docs/DESK.md`: gapped stops filled at the minute close (`gapFill`), ranking by the weaker time half, explicit "one night of data / ~12,000 combinations, so the best one is optimistic", TEST ledgers at real Jupiter quotes.
- Evidence model (`Evidence`: OBSERVED / DERIVED / INFERRED, `null` = UNKNOWN, never defaulted).
- On-chain discovery of every pump.fun graduation and launch (no API-page survivorship).

**B. Fragile:**
- `src/desk/engine.ts` is 1,735 lines and owns discovery, strategies, alerts, positions, tape and persistence. Changes there are high-risk.
- All state is in local JSON files written by one Windows process. A disk, a crash during a write, or the PC going to sleep stops collection.
- GeckoTerminal rate limits (shared IP) stretch scans; Birdeye credits are scarce.

**C. Duplicated:**
- Three dashboards (`src/dashboard`, `dashboard/`, micro dashboard) and three engines (legacy `src/core/engine.ts`, playbook runtime, desk). Two playbook/dashboard backup trees committed (`.dashboard-update-20260925/`, `dashboard-backups/`), plus `solana-bot-v4.b64.txt` and `solana-playbook-update.zip` (old snapshots of the same code).
- Two risk systems: `src/core/risk-manager.ts` (legacy) and the desk guard.

**D. Missing (what this pass adds the foundation for):**
- An immutable, versioned event record with event time vs observation time vs ingestion latency vs data quality.
- Point-in-time reconstruction of what the system knew at a decision, and tests that fail on leakage.
- A feature registry, strategy versions with fingerprints, dataset versions, experiment records, a sealed holdout.
- Market-regime context on every observation.
- An immutable evidence snapshot behind each alert, and an answer to "why did I not get an alert?".
- A capability-separated API for agents.

**E. Preserve:** everything in A, the ntfy/Telegram notifier, `DESK_ALERTS`, the desk's evidence vocabulary, the backtest scripts (they are now joined, not replaced).

**F. Refactor (later, incrementally):** split `DeskEngine` into discovery / assessment / strategy / execution / alerting services that publish events; replace ad-hoc JSONL writers with the event store.

**G. Replace eventually:** local JSON ledgers as the system of record (→ event store + database), the legacy engine and dashboards once the desk covers them, committed archives (`*.b64.txt`, `*.zip`, backup trees).

## 3. Concrete defects found

| # | Defect | Effect | Status |
| --- | --- | --- | --- |
| 1 | `EventLog.flush` and `DeskEngine.persist` rotate `events-*.log.jsonl` / `tape-*.jsonl` by renaming to `.1`, which **overwrites the previous `.1`** | Pipeline history and the CRASH signal tape older than ~40 MB are silently destroyed: historical truth is overwritten | Fixed: rotation now uses a unique timestamped suffix |
| 2 | The desk's `DataRuntime` is created **without** a `MarketDataStore` (`runtime.ts`) | Raw provider observations behind every desk decision are not persisted at all | Mitigated: alert evidence snapshots + tape events now go to the research event store; persisting all observations is a next step |
| 3 | `alertOnce` drops alerts not selected by `DESK_ALERTS` without a record, and `notifier()` swallows delivery failures | "Why did I not get an alert?" cannot be answered from data | Fixed: every first alert per key is recorded with its delivery decision; delivery outcome per channel is recorded |
| 4 | Backtest pool depth and supply come from **one DexScreener observation at download time** (`liquidityRefUsd`, `priceRef`, `supply = marketCap / price`), and the CRASH entry filter `liquidity ≥ $10K and ≥ 3 % of mcap` is evaluated with it | The entry filter uses information from after the signal (look-ahead). For burned PumpSwap LPs the constant-product extrapolation is close; for pools where liquidity was added or removed it is not | Documented; the new differential leakage test detects exactly this class (see `tests/research-leakage.test.ts`) |
| 5 | Universe filter `volume24hUsd ≥ $50K` (desk-backtest) uses a 24 h volume observed at download | Valid as a necessary condition only while the window is < 24 h (as the comment argues); a longer `--hours` silently becomes survivorship-biased | Documented |
| 6 | Rule search ranks up to 36,648 entry × exit combinations per run by the weaker half, without a held-out test set unless `--oos-from` is passed, and without any multiple-testing correction | The reported best rule is the maximum of many noisy estimates; the "weaker half" is still in-sample for the selection | The experiment engine records trials, applies a deflated Sharpe test and enforces a sealed holdout |
| 7 | Signal tape rows carry the scan time only, not the provider's observation time or a schema version | Replays cannot separate data latency from decision latency | Tape rows are now also written as versioned `MarketSnapshot` + `SignalEvaluated` events with `observed_at` |

## 4. Evidence status of the known cases

GM, SIF, SI, WIRED, Ansemmas, FIX6900, 66hK2 (BULLISHCAT), 7cYaQc and the owner's other cases (WW, AGENCY, `GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H`) are **anecdotes selected after the fact**. Several rules on the branch were written from one of them (OPEN from FIX6900, GOLDEN from 66hK2, LAUNCH from Meme Industries). The desk's own audit already shows what happens next: OPEN lost on all 7 TEST trades, GOLDEN −57 % on its first 5. They are registered as hypothesis generators (`src/research/curiosity/cases.ts`) and are excluded from any evaluation that decides whether a rule works.

# Research platform

The machine that finds out whether an edge exists. It does not assume one. The desk's winners (GM, SIF, AGENCY, WW, `GAwhcph…9S9H`, 7cYaQc…) are hypothesis generators, registered as known cases and excluded from every evaluation by default (`src/research/curiosity/cases.ts`).

Code: `src/research/` (node built-ins only, no npm dependency), CLI `src/scripts/research-platform.ts`, tests `tests/research-*.test.ts`. The audit that motivated it: [AUDIT.md](AUDIT.md). The launch observer and its study (another session's work on this branch, `src/research/{observer,ledger,dataset,report}.ts`) are the edge collector that feeds it: [../RESEARCH.md](../RESEARCH.md).

## 1. Layers

```
EDGE / COLLECTION        desk (data-desk/: event log, tape, ledgers)      observer (data-desk/research/ev-*.jsonl.gz)
                         desk recorder (alerts + health, live)            regime collector (BTC/SOL)
        │ ingest/*  (offline, idempotent: same input → same event ids)
        ▼
EVENT STORE              events/   immutable, versioned, hash-chained JSONL segments; one writer per directory
        ▼
POINT IN TIME            pit/      views that hold nothing after the decision time; leakage tests
        ▼
FEATURE ENGINE           features/ versioned name@vN definitions with leakage notes; null, never a default
        ▼
SIGNAL ENGINE            strategy/ immutable family_vNNN versions with fingerprints and lineage
        ▼
RISK ENGINE              risk/     limits that override the strategy; latched kill switch
        ▼
EXECUTION SIMULATOR      execution/ theoretical vs executable trade (latency, impact, fees, reverts, write-offs)
        ▼
RESEARCH / BACKTEST      backtest/ point-in-time backtests, baselines, walk-forward, ablation, sensitivity, stress
        ▼
EXPERIMENTS              experiments/ pre-registered, sealed holdout, verdict by a fixed decision rule
        ▼
ALERTING / API           alerts/ (evidence snapshots), observability/ (why-no-alert, health), api/ (agents)
```

The dashboard and the desk remain views and operators over this; nothing in `src/research` places, signs or sizes an order.

## 2. Data model

**Event** (`events/types.ts`, schema `solana-research/event` v1):

| Field | Meaning |
| --- | --- |
| `event_id` | `ev_` + 128-bit hash of the identity (type, token, timestamp, source, natural key, payload). Re-importing the same observation is a no-op |
| `event_type` | TokenCreated, CreatorBuy, CreatorSell, Buy, Sell, NewWallet, WalletFunded, LiquidityChange, CurveProgress, CurveAcceleration (derived), Graduation, HolderSnapshot, MarketSnapshot, Candle, ProviderObservation, RegimeSnapshot, SocialLinkDiscovered, XPost, XContractAddressPost, TelegramActivity, WebsiteActivity, RiskFlag, ScanDecision, SignalEvaluated, AlertGenerated, AlertDelivered, ExecutionAttempt, ExecutionResult, PipelineStage, HealthSnapshot, DataQualityIssue, AgentAction |
| `token` | mint, `REF:SOL` / `REF:BTC` for reference series, or null |
| `timestamp` | when it happened (chain time, provider time, **bar close**) |
| `observed_at` | when this system observed it |
| `available_at` | earliest time a real-time system could have known it (= observed for live capture; explicit, conservative estimate for backfill; unknown backfill = the download time) |
| `recorded_at` | when it was written |
| `ingestion_latency_ms` | observed_at − timestamp (null when the timestamp is an estimate) |
| `quality` | OK / UNVERIFIED / DEGRADED / CONFLICT / INVALID with issues; INVALID events never enter point-in-time views |
| `capture` | LIVE, BACKFILL, IMPORT, DERIVED |
| `natural_key` | provider identity; the same key with different content is kept and marked CONFLICT |
| `schema_version`, `payload_version`, `producer`, `correlation_id`, `causation_ids` | versioning and lineage |

Secrets are redacted before an event exists (key-like fields, keyed URLs, ntfy topics, Telegram bot tokens); evidence links stay readable.

**Store** (`events/store.ts`): `events-<seq>.jsonl` segments; each line `{seq, prev_hash, hash, data}`. `verify` recomputes the chain and every content id: an edited price, a removed line or a reordering is reported. A line torn by a crash is reported, never repaired; writing continues in a new segment. Each collector owns a directory; research reads several (`MultiStoreReader`).

**Dataset** (`events/dataset.ts`): `ds_<hash>` of exactly which events (and filter) it contains. A new dataset version is the only way to get a fresh holdout.

**Experiment** (`experiments/registry.ts`): experiment_id (hash of the design), hypothesis, dataset_version, feature_versions, strategy_version, training/validation/test periods, execution_model, transaction_cost_model, decision rule, trials, result, metrics, sample_size, failure_reason, holdout use, timestamp. Append-only.

## 3. Point-in-time research

```
DECISION_TIME → AVAILABLE_INFORMATION (PointInTimeView) → FEATURES (name@vN) → SIGNAL (family_vNNN)
             → RISK (may refuse or shrink) → EXECUTION ASSUMPTION (model id + fingerprint) → OUTCOME (real path after t)
```

- Two knowledge modes: `OBSERVED` (what the desk actually knew: alert evidence, why-no-alert, tape replays) and `AVAILABLE` (what a real-time system could have known: backtests on backfilled data).
- Decisions happen only when new market information became known (a bar close, a snapshot).
- Leakage detection (`pit/leakage.ts`):
  1. structure: a view contains nothing after t; a window ending after t throws;
  2. sandbox: `Date.now()`, `new Date()` and `Math.random()` throw during feature and signal computation;
  3. truncation and adversarial future: each value must not change when everything not yet known is removed, or replaced in place by other values (catches closures that bypass the view);
  4. differential test for legacy functions of wider inputs (series, pool objects): it reproduces the desk backtest's look-ahead (AUDIT #4);
  5. data audit: known before it happened, derived before its inputs, bars stamped at their open.
- An experiment runs the leakage tests at real decision points before its holdout is opened; any violation makes it INVALID.

## 4. What an experiment decides

Pre-registered rule (`DEFAULT_DECISION_RULE`): at least 30 complete test trades; bootstrap 95 % interval of the mean net return above zero; better than random entries on the same tokens and period (difference interval above zero); deflated Sharpe ≥ 0.95 given the number of configurations compared (`trials`). Anything less is INCONCLUSIVE or REJECTED, with the reason. The test period opens once per experiment; reuse by other experiments is flagged CONTAMINATED and refused beyond a budget (default 3).

The synthetic-market tests prove the machine's two duties: it reports SUPPORTED on a market with a planted edge, and not on one without; the same edge found after 10,000 trials gets a much lower deflated Sharpe.

## 5. Alerts

Every first alert per key (golden, rug, open, launch, radar) is recorded as an `AlertGenerated` event whose payload is an evidence snapshot: what happened, why it triggered (the rule checks), what the system knew (metrics, gates, inputs with their observation times), when it knew it, key features, SOL price, data quality, links, and the delivery decision (`SENT`, `SUPPRESSED_BY_CONFIG` by `DESK_ALERTS`, `NO_CHANNEL`). The phone message gets one evidence line and the evidence id (`al_…`), so the message on the phone can be matched to the immutable record. Delivery outcomes per channel are `AlertDelivered` events.

| Setting | Effect |
| --- | --- |
| `DESK_RESEARCH` empty | alerts + a health record per minute in `data-desk/research-store` (a few MB a day) |
| `DESK_RESEARCH=full` | also the CRASH tape live (~140 MB a day; the tape file holds it anyway) |
| `DESK_RESEARCH=off` | nothing recorded |
| `DESK_ALERT_EVIDENCE=off` | phone text exactly as before (evidence still recorded) |

"Why did I not get an alert?" — `npm run research:platform -- why --store data-research/store,data-desk/research-store --token <MINT> --from <ISO> --to <ISO>` walks the pipeline: not running → never observed → filtered (top reasons) → no signal → signal of a strategy without phone alerts → suppressed by DESK_ALERTS → no channel → delivery failed → delivered.

## 6. APIs for agents

`api/tools.ts` (in-process) and `api/server.ts` (HTTP, loopback, bearer token per principal). Every call is audited as an `AgentAction` event, allowed or denied. Capabilities:

| Capability | Tools |
| --- | --- |
| READ | get_system_health, get_data_quality, get_token, get_token_events, get_alert, get_alert_evidence, explain_missing_alert, list_features, get_feature, get_strategy_version, list_strategies, get_experiment, list_experiments, inspect_failure, list_hypotheses, list_known_cases |
| RESEARCH | run_backtest (with random-entry baseline), compare_strategies, run_walk_forward, create_experiment (stops before the holdout) |
| HYPOTHESIS | submit_observation, submit_hypothesis |
| HOLDOUT | conclude_experiment (opens the sealed test once) |
| TRADING | **does not exist**: any order-like tool name answers `TRADING_NOT_AVAILABLE` |

| Role | Capabilities |
| --- | --- |
| DATA, REGIME, RISK, REPORTING agents | READ |
| FEATURE, BACKTEST, LEAKAGE, ADVERSARIAL, EXECUTION agents | READ, RESEARCH |
| HYPOTHESIS agent, CURIOSITY_SCOUT | READ, HYPOTHESIS |
| SUPERVISOR agent, HUMAN_OPERATOR | READ, RESEARCH, HYPOTHESIS, HOLDOUT |

`toolManifest(role)` returns name, description and JSON schema per tool for an LLM tool-use loop.

**Curiosity scout** (`curiosity/hypothesis.ts`): OBSERVE → CONNECT → NOTICE (`submit_observation`) → HYPOTHESIZE (`submit_hypothesis`: a condition on registered features, expected effect against random entries over a horizon, a falsification written before testing, a minimum sample) → HAND OFF (`create_experiment` with `hypothesis_id`; a supervisor concludes). An untestable hypothesis is refused with its reasons. The scout cannot run experiments, open holdouts or trade.

## 7. Infrastructure

| Role | Runs | Where it can live |
| --- | --- | --- |
| Edge / collection | desk + recorder, observer, regime collector | the Windows PC today; any VPS later (all paths are `path.join`, no shell, no POSIX-only calls) |
| Event store | directories of JSONL segments | local disk; append-only files replicate safely with rsync / object storage (only new segments and the open tail change) |
| Research workers | `research:platform import/backtest/experiment` | any machine with Node ≥ 20: the research core needs no `npm install` (`npm run test:research:node` builds and tests it with TypeScript only) |
| Orchestration / API | `research:platform serve` | loopback; behind TLS and a private network before any remote use |
| Execution | the desk's guarded path (unchanged) | stays where the signer is; never reachable from the research API |

No GPU: the workloads are I/O and small CPU loops. The compact observer ledger stays the edge format on the PC (its disk is nearly full); import windows of it into a canonical store on a research machine.

## 8. Operations

```
npm run test:research                      # research tests (tsx)
npm run test:research:node                 # same, compiled with tsc only (no tsx)
npm run research:platform -- import --store data-research/store --desk data-desk --cache data-desk/backtest-cache
npm run research:platform -- import --store data-research/store --observer data-desk/research --from 2026-10-02T00:00Z --to 2026-10-02T06:00Z --sol-store data-research/regime
npm run research:platform -- verify --store data-research/store
npm run research:platform -- backtest --store data-research/store --strategy crashcandle_v001
npm run research:platform -- experiment --store data-research/store --registry data-research/experiments --strategy crashcandle_v001 --hypothesis "…" --trials 36648
npm run research:platform -- collect-regime --store data-research/regime
RESEARCH_API_TOKENS=SUPERVISOR_AGENT:sup:<24+ chars> npm run research:platform -- serve --store data-research/store,data-desk/research-store
```

`--trials` must be honest: the desk's grid search compares up to 36,648 entry × exit combinations per run (AUDIT #6).

## 9. Verified / not verified (2 Oct)

Verified here: the research core and its 51 tests (compiled with TypeScript 6 and run with `node --test`, no npm packages), and a CLI end-to-end run on fabricated desk, cache and observer files. The desk edits were type-checked against stubbed third-party types: they introduce no new errors.

Not verified here (no npm install was possible in this environment): the full `npm run typecheck && npm test` (desk, dashboard), the parity test `tests/desk-research-parity.test.ts`, and the recorder inside a running desk. Run those before pulling onto the PC.

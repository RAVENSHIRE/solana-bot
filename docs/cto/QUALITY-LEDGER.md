# Quality ledger

> Owner: CTO (quality office). First pass: 3 Oct 2026, branch `claude/cto-quality-audit` from
> `claude/session-title-unavailable-wennx2`. Everything below was read in the repository or run in a clean checkout.
> Nothing was run against mainnet, and no `.env`, key or wallet file was read. Line numbers are from the base branch
> unless the finding is marked FIXED (then they are from this branch).

Severity: **P0** money or safety at risk · **P1** wrong data or silent failure · **P2** missing test or observability ·
**P3** cleanliness. Effort: **S** under an hour · **M** a day · **L** more.

## Baseline (3 Oct)

| Check | Result |
| --- | --- |
| `npm ci` (root) | ok; `npm audit`: 9 vulnerabilities (6 moderate, 3 high) |
| `npm run typecheck` | ok, 0 errors |
| `npm test` ×3 | 275/275 pass in all three runs (46 s, 42 s, 43 s); after this branch 280/280 |
| `dashboard`: `npm ci && npm run build` | ok; `npm audit`: 16 vulnerabilities (10 moderate, 6 high); one 527 kB JS chunk (Vite warning) |
| `dashboard`: `npm test` | 14/14 pass. Not part of the root `npm test`; there is no CI (no `.github/`) |
| Known flake `tests/micro.test.ts` | Root cause found and fixed (Q-29): the fixture read the clock twice per snapshot |

## Findings

| Id | Sev | Area | Where | Evidence | Proposed fix | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q-01 | P0 | Failure handling | `src/desk/engine.ts:527-537` | `persist()` flushed the event log and appended the CRASH tape **before** `ledger.save()`. An `EPERM` (Windows lock) or `ENOSPC` on either threw first, so positions and orders were not saved for that cycle; a LIVE restart then works from a stale ledger. | Ledgers first, each step isolated, first error re-raised. | S | **FIXED** `b216ebc`, test CTO-01 |
| Q-02 | P1 | Phone filter | `src/desk/runtime.ts:92-95, 191` | `phone-alerts.json` was written with plain `fs.writeFile`; any read/parse error returned `null` = "no choice, use `DESK_ALERTS`". A file truncated by a crash silently put every `DESK_ALERTS` kind back on the phone — the rug flood the owner switched off. | Atomic write; a missing file still means `DESK_ALERTS`, an unreadable one means nothing to the phone. | S | **FIXED** `0d220f2`, test CTO-02 |
| Q-03 | P1 | Observability / alerts | `src/desk/watch.ts:229-234`, `src/research/calls.ts:73,104,140`, `src/research/verified.ts:157` | `notify()` threw the per-channel result away and every caller added `.catch(() => undefined)`. ntfy answering 429/4xx or the network being down left no trace: the phone could stop receiving CALL/INFO messages for days unnoticed. | `health()` (sent, delivered, failed, last ok, last error) and an `onFailure` hook; observer logs each failure and shows phone health in its minute status line; desk logs a warning. `notify` still never throws. | S | **FIXED** `d0b5a05`, test CTO-03 |
| Q-04 | P1 | Data integrity | `src/research/ledger.ts:78, 101` | `appendFile` errors swallowed. Lines lost silently, and when the lost batch held an `M`/`W` dictionary line every later record of that mint in the hour pointed at an index never written, so `readDataset` dropped those too (`mintOf` → null). | Count (`writeErrors`, `lastWriteError`), write a `GAP` record `source=ledger`, restart the hour's dictionaries, show it in the observer status. | S | **FIXED** `025a02c`, test CTO-04 |
| Q-05 | P1 | Look-ahead | `src/research/dataset.ts:225` | `xFollowers` / `xAccountAgeH` used the first OK X read whatever its time; the observer reads at +20 s and +6 min, so features at 60/120/300 s used facts from after the decision. The header claimed such features were "flagged"; nothing flagged them. Live features (empty `xReads` at T) disagreed with the look-back. | Only reads with `obs <= T`. | S | **FIXED** `a9da6c4`, test CTO-05 |
| Q-06 | P0 | Operations | `dashboard/start-background.cmd:6`, `dashboard/start-research.cmd:5`, `ecosystem.config.js` | Desk (dashboard process, which also runs a LIVE local-key session and its exits) and observer are started with `start /min cmd /c`. Nothing restarts them after a crash, a Windows update reboot or sleep. With LIVE + local key, a crash leaves open positions with **no stop, take profit or rug exit** until someone notices. `ecosystem.config.js` (PM2) covers only the legacy bot (`dist/index.js`) and describes an Ubuntu VPS. | A supervisor on Raven: Windows Task Scheduler "at startup + restart on failure", or PM2 + `pm2-windows-startup` for `dashboard` and `research:observe`; plus a dead-man alert (Q-17). | M | Owner |
| Q-07 | P1 | Alert quality | `src/research/direct.ts:18`, `src/research/calls.ts:145-156` | Calls are qualified and judged with `latencyMs: 2_000` (a bot's fill). The CALL goes to a **human** who reads the phone and buys in FOMO, typically 20–90 s later, on launches that move ×8 in 68 s (GOOP HEAD, RESEARCH.md). The gate's precision does not describe what the owner can get. | Judge every call twice: bot fill (2 s) and phone fill (`latencyMs` = ntfy delivery + a measured tap-to-fill, 45 s default); qualify on the phone fill for rules that go to the phone. | S | Owner / research |
| Q-08 | P1 | Qualification | `src/research/qualify.ts:15, 47-66`, `src/research/rules.ts:42-47` | ~45 (group × delay) candidates, each with the best of 6 or 12 exits chosen on the tuning split, are each tested at "later mean > 0 with n ≥ 100". No correction for the number of candidates: with 45 tries, one passing by chance is likely. `forward` uses mean ≥ 0 after 30 live calls — the same, no interval. | Require the later-period mean's lower 95 % bound (bootstrap) > 0, Bonferroni/Holm across candidates, or a deflated Sharpe as the experiment engine already does (`src/research/experiments/`). Criteria change: the owner decides. | S | Owner |
| Q-09 | P1 | Alert quality | `src/research/calls.ts:139, 164` | A live signal that cannot be filled is dropped without a `RES` record (`notFilled++` only), and when 50,000 signals are open new ones are never judged. The forward record — the input to the precision metric and to the gate's live check — only sees calls that filled. | Write `RES` with `reason: NOT_FILLED` (netPct null) and a `GAP` when the cap is hit; readers already skip non-numeric netPct. Format change: coordinate with research. | S | Research |
| Q-10 | P1 | Operations | `src/desk/engine.ts:536`, `src/desk/events.ts:65`, `src/research/ledger.ts` (no pruning), `dashboard/start-background.cmd:6` | Rotated `events-*.log.jsonl.*` and `tape-*.jsonl.*` are never deleted (the AUDIT #1 fix made every rotation permanent); hourly research files are never pruned; `dashboard.log` and `observer.log` are appended with `>>` forever. Raven has ~1.5 GB free. Bulk research records pause at 700 MB free, but the desk's ledgers and the dashboard keep writing until the disk is full — then Q-01-type failures hit everything. | Retention policy: keep N rotations / D days locally, move older files off the box (owner decides where); rotate the two `.log` files at start; dashboard disk gauge. | M | Owner |
| Q-11 | P1 | Operations | `src/scripts/research-observe.ts:74`, `package.json:45` | Requalification runs every 6 h as a child with `--max-old-space-size=1536` next to the dashboard and the observer, on a box with ~1.7 GB RAM free. It can push Raven into swap or the OOM path while LIVE exits are running. | Cap the child at what the dataset needs (measure: `qualify.log` peak RSS), stream files instead of `readDataset` of 48 h at once, or run it at a quiet hour with lower priority. | M | CTO next |
| Q-12 | P1 | Look-ahead / parity | `src/research/dataset.ts:12, 111-116`, `src/research/rules.ts:31-32` | Metadata (X link, website) is treated as "known from creation"; the `META` record's own `obs` is ignored. Live, the observer has it only after the pump.fun gateway answers. For the 5 s and 15 s decision times of `ownX` / `ownXSite`, the look-back can put a launch in the group that the live engine could not. | Keep the META `obs` in `LaunchFacts` and gate `hasX`/`hasSite` on `obs <= T` in `features()`; measure how often META arrives after 5 s first. | S | Research |
| Q-13 | P2 | Data integrity | `src/research/qualify.ts:42-50`, `src/research/dataset.ts:189-198` | The gate simulates every launch including those with `gapInWindow` or `chainBreaks > 0` (missing trades); only the report has `--strict`. `blindSpots()` ignores the new `GAP source=ledger` (Q-04). | Exclude, or report separately, launches with a blind spot in [creation, exit]; count `ledger` gaps as blind spots. | S | Research |
| Q-14 | P2 | Alert quality | `src/research/calls.ts:130-141` | A launch matching several qualified rules at one decision time sends one CALL per rule. | One phone message per launch and decision time, listing the rules. | S | Research |
| Q-15 | P2 | Tests | `src/desk/guard.ts:64` | `DeskGuard` (reserve, max drag, simulation checks, signature state) has no unit tests of its own; it is exercised only through whole-engine scenarios in `tests/desk.test.ts`. A boundary (exactly at max drag, reserve − 1 lamport, simulation with a foreign account change) is not pinned. | Table-driven tests per guard check at its boundary, like `tests/micro.test.ts` does for `MicroGuard`. | M | CTO next |
| Q-16 | P2 | Tests | `src/desk/engine.ts:1180-1193`, `dashboard/server/trading.ts:215-219` | The phone filter's default (`DEFAULT_ALERTS` = none) is never asserted; no test runs `alertOnce` with the default set, and the dashboard's `phone-alerts` action has no server test. | Engine test: default set → nothing sent, alert recorded as suppressed; server test for the action and `INVALID_ALERT_KINDS`. | S | CTO next |
| Q-17 | P2 | Observability | `dashboard/src/Desk.tsx:59, 142`, `src/research/observability/` | The dashboard shows HALTED, last scan time and the pump-stream source line. It does not show: whether the observer is writing (ledger bytes/min, write errors), phone delivery health (Q-03 now has the data), provider error rates, disk free. The health registry exists but is not on the page. "Is the phone still receiving?" cannot be answered within a minute. No dead-man alert if the desk or observer stops. | A health strip: observer heartbeat age, phone last-ok, providers, disk; plus an external dead-man (e.g. a daily "alive" ntfy, or healthchecks.io ping). | M | CTO next |
| Q-18 | P2 | Tests / process | repo root | No CI. Dashboard tests are a separate `npm test`. Nothing runs typecheck + both suites on a push. | GitHub Actions: `npm ci && npm run typecheck && npm test`, `dashboard: npm ci && npm run build && npm test`. | S | Owner (Actions minutes) |
| Q-19 | P2 | Failure handling | `src/desk/events.ts:58-60` | `flush()` clears `dirty` before the atomic write; a failed write is not retried until another event arrives. | Clear `dirty` after the write. | S | Open |
| Q-20 | P2 | Alert quality | `src/desk/engine.ts:153, 1181` | Alert de-duplication (`launchAlerts`) is in memory: a restart re-alerts everything still live (the FIX6900 copycat alert after a restart, DESK.md). | Seed from the research store's `AlertGenerated` events of the last hours. | S | Open |
| Q-21 | P2 | Failure handling | `src/desk/engine.ts:472` | A failed save after a TEST probe is swallowed (`persist().catch(() => undefined)`), unlike `pulse()` which records it. | Record a FAILED event like `pulse()`. | S | Open |
| Q-22 | P3 | Parity | `src/research/calls.ts:132` | Live features pass `creatorLaunches: 0`, the look-back passes the creator's history. No group uses it today; the first one that does will drift. | Keep a creator index in the observer. | S | Open |
| Q-23 | P3 | Structure | `src/desk/engine.ts` (1,799 lines) | Discovery, five strategies, alerts, positions, tape and persistence in one class (AUDIT §2B). | Split along the AUDIT §2F plan when the swarm work touches it. | L | Open |
| Q-24 | P3 | Type safety | `src/desk/*.ts` | 54 non-null assertions in `src/desk`, several on parsed external data (e.g. `launches.ts:399 l.x.handle!`, `engine.ts:1176 original.pairCreatedAt!`). `any` is almost absent (2). | Replace the external-data ones with guards when touched. | M | Open |
| Q-25 | P3 | Docs drift | `src/desk/engine.ts:86` | Says the default is "rug sales of held positions only"; `DEFAULT_ALERTS` is empty (owner, 2 Oct). | Fix the comment. | S | Open |
| Q-26 | P3 | Docs drift | `docs/DESK.md:502` vs `:434` | "Known limits" says empty token accounts are never closed; *Costs per trade* says the local key closes them after each exit. | Limit the sentence to Phantom. | S | Open |
| Q-27 | P3 | Hygiene | `solana-bot-v4.b64.txt`, `solana-playbook-update.zip`, `dashboard-backups/`, `.dashboard-update-20260925/` | Old snapshots of the code committed (AUDIT §2C). | Delete in one commit (they are in history). | S | Owner OK needed |
| Q-28 | P3 | Dependencies | root, `dashboard/` | `npm audit`: 3 high (root), 6 high (dashboard). Not triaged. | Triage; `npm audit fix` where non-breaking. | S | Open |
| Q-29 | P3 | Tests | `tests/micro.test.ts:22-23, 54` | **The flake:** snapshots were built with `at: Date.now(), receivedAt: Date.now()`. `equityUsd()` validates prices as of `s.at`; when the two calls straddled a millisecond, `receivedAt` was 1 ms in the future → `PRICE_UNAVAILABLE_OR_STALE`. Reproduced deterministically with `receivedAt = at + 1`. Production (`src/micro/market.ts:30`) sets `at` after `receivedAt` and is not affected. | One clock reading per snapshot. | S | **FIXED** `78ea593` |
| Q-30 | P3 | Docs drift | `ecosystem.config.js:1-15` | Describes 24/7 PM2 on Ubuntu for `solana-bot`; the live system is the desk on Windows (Raven), which has no process config at all (Q-06). | Replace with the desk + observer config when Q-06 is done. | S | Open |

Counts: **P0 2** (1 fixed) · **P1 10** (4 fixed) · **P2 9** · **P3 9** (1 fixed). Total 30 (Q-01…Q-30; Q-29 is the flake).

Checked and found sound (no finding): every outbound `fetch` in `src/desk`, `src/research`, `src/data` carries an
`AbortSignal.timeout`; websocket feeds reconnect with backoff and a no-message watchdog that writes a `GAP`
(`src/research/streams.ts:37-86`); trade-stream completeness is measured (`chainBreaks`) and observer restarts are
blind spots; candle labels count as known only when the minute closes (`dataset.ts:74`); X posts count 30 s after
their id time; stops jumped over sell at the jumping trade (`direct.ts:51`); LIVE halts rather than retries on an
unknown outcome; amounts in the guard are integer lamports (`bigint`).

## Professional-standard checklist

| # | Standard | Pass/fail | Evidence |
| --- | --- | --- | --- |
| 1 | The test suite is green and deterministic | PASS (after Q-29) | 3×275/275; the one known flake was a fixture bug, fixed |
| 2 | Every change is gated by CI (typecheck, both suites, build) | FAIL | No `.github/`; dashboard tests not in root `npm test` (Q-18) |
| 3 | Processes restart by themselves after a crash or reboot | FAIL | `start /min cmd /c` only (Q-06) |
| 4 | Money-critical state is persisted before anything optional | PASS (after Q-01) | Ledgers saved first, isolated from telemetry |
| 5 | No silent failure on the alert path | PASS (after Q-03) | Delivery failures counted, logged, in the status line; not yet on the dashboard (Q-17) |
| 6 | The owner sees within a minute that a source, the observer or the phone is down | FAIL | Desk scan staleness and HALTED are shown; observer, phone, providers, disk are not (Q-17) |
| 7 | Research data loss is visible in the data | PASS (after Q-04) | Write failures become `GAP source=ledger`; `blindSpots` should honour them (Q-13) |
| 8 | Features are point in time | PARTIAL | Trades, posts, candles, creator history: yes. X profile: fixed (Q-05). Metadata: no (Q-12) |
| 9 | Live and look-back use the same features | PARTIAL | Same code (test exists); inputs differ for metadata timing and creator history (Q-12, Q-22) |
| 10 | Phone calls are judged as the owner would trade them | FAIL | Judged at a 2 s bot fill (Q-07) |
| 11 | The gate controls for multiple testing | FAIL | ~45 candidates, no correction (Q-08) |
| 12 | Every call has a recorded outcome | FAIL | Unfilled / over-cap calls get none (Q-09) |
| 13 | Dangerous paths have direct tests | PARTIAL | Engine scenarios cover orders, exits, LIVE refusal, signer; guard boundaries and the phone default are untested (Q-15, Q-16) |
| 14 | Disk and memory are bounded on Raven | FAIL | No retention (Q-10); 1.5 GB heap child (Q-11) |
| 15 | Network calls have timeouts and bounded retries | PASS | All `fetch` with `AbortSignal.timeout`; stream retries back off |
| 16 | Secrets stay out of logs and the browser | PASS | Allowlisted env keys (`runtime.ts:42-53`), delivery records keep error class only (`watch.ts`, parity test) |
| 17 | Docs match the code | PARTIAL | Q-25, Q-26, Q-30 |
| 18 | Repository holds only source | FAIL | Committed snapshots and zips (Q-27) |

## Daily metrics for the CTO

| Metric | Definition | Data source |
| --- | --- | --- |
| **Phone call precision** | Of the CALLs sent in the last 24 h whose hold has ended: share whose `RES` reason is `TAKE_PROFIT`, with its Wilson 95 % interval and n. Reported twice: bot fill (as now) and phone fill (Q-07). Not stated below n = 30 | Observer ledger `data-desk/research/ev-*.jsonl(.gz)`: `SIG` with qualified = 1 and sent = 1, joined to `RES` on (mint, rule id) |
| **Rug share of calls** | Share of sent CALLs and INFO messages whose market cap 60 min after the message is ≤ 30 % of the message's (the 2 Oct audit's "dead or −70 %"), from the observer's candles; for graduated coins, from the pool once post-migration prices are recorded | `SIG`/`INFO` + `K` candles (`labels().mae[60] ≤ −0.7`); desk alerts: `AlertGenerated` in `data-desk/research-store` |
| **Unjudged call share** | Sent CALLs with no `RES` after hold + 90 s (should be 0 after Q-09) | `SIG` sent = 1 without `RES` |
| **Phone volume** | Messages per day by kind (CALL, INFO, research update, desk kinds) and delivered/failed | Observer status line `phone a/b delivered` (Q-03); desk `AlertDelivered` events |
| **Phone delivery health** | Failed deliveries per day; time since last successful delivery | `notifier().health()`, observer.log "phone delivery failed" lines |
| **Expected vs realised call result** | Mean net % of judged live calls vs the gate's later-period mean for the same rule | `RES` vs `qualified.json` `validation.meanPct` |
| **Observer coverage** | Share of launches with `chainBreaks = 0`; `GAP` records per day by source (logs, disk, ledger) | `readDataset()` + `features()`; `GAP` records |
| **Observer uptime** | Minutes with a `STAT` record ÷ minutes in the day | `STAT` (every 10 min) and `START` records |
| **Desk uptime / scan freshness** | Minutes with a heartbeat whose `lastScanAt` is < 30 s old ÷ minutes in the day; HALTED minutes per strategy | Desk heartbeat in `data-desk/research-store` (`runtime.ts:169-171`) |
| **Data freshness** | p95 of (decision time − newest trade obs) for live calls; DexScreener/Jupiter observation age at decision | `SIG` features; desk evidence snapshots (`AlertGenerated.payload`) |
| **Provider error rate** | Errors ÷ requests per provider per day (Jupiter, DexScreener, GeckoTerminal, RPC, X) | Desk event log `events-<MODE>.log.jsonl` FAILED events by source; `DataRuntime` health |
| **Tests** | Test count, pass count, flaky tests (a test that failed and passed on the same commit), suite duration | `npm test` output (CI once Q-18 exists) |
| **Disk and memory** | Free disk on Raven, research folder size growth/day, peak RSS of dashboard, observer, qualify child | Observer `checkDisk`, `qualify.log`, Task Manager export (until a probe exists) |
| **Spend** | Anthropic/Gemini reviews per day × price; Birdeye credits used | Review counters (`DESK_AI_REVIEWS_PER_HOUR`), provider dashboards |

## Top 10 fixes, in order

1. **Q-06** Supervise the dashboard and the observer on Raven (restart on crash and at boot) — open LIVE positions have no exits while the process is down.
2. **Q-17** A dead-man alert and a health strip (observer heartbeat, phone last-ok, disk, providers) — the owner must learn of an outage from the phone, not by looking.
3. **Q-10** Retention for rotated logs, tapes and research files, and rotation of `dashboard.log` / `observer.log` — the disk is the shared failure point.
4. **Q-07** Judge and qualify phone calls at a human fill delay — otherwise precision on paper says nothing about the owner's trades.
5. **Q-08** Multiple-testing control in the qualification gate (lower confidence bound, Holm, or the deflated Sharpe the experiment engine already has).
6. **Q-09** Record an outcome for every call (`NOT_FILLED`, cap hit) — precision needs a complete denominator.
7. **Q-12** Point-in-time metadata (`META` obs) for the 5 s / 15 s groups.
8. **Q-11** Bound the requalification child's memory on a 1.7 GB box.
9. **Q-18** CI on every push (typecheck, both suites, dashboard build).
10. **Q-15 / Q-16** Boundary tests for `DeskGuard` and the phone filter's default.

## Changes on this branch

| Commit | Finding | Test |
| --- | --- | --- |
| `b216ebc` desk: save ledgers before telemetry | Q-01 | `tests/cto-quality.test.ts` CTO-01 |
| `0d220f2` desk: phone-alert choice written atomically, corrupt file → nothing to the phone | Q-02 | CTO-02 |
| `d0b5a05` notifier: count and log failed phone deliveries | Q-03 | CTO-03 |
| `025a02c` research ledger: failed writes counted, `GAP`, dictionaries re-emitted | Q-04 | CTO-04 |
| `a9da6c4` research dataset: X account facts point in time | Q-05 | CTO-05 |
| `78ea593` tests(micro): one clock reading per snapshot | Q-29 | the micro suite itself |

Each regression test fails on the base branch and passes here. No strategy parameter, entry/exit rule, qualification
criterion, LIVE behaviour or signing/sending path was changed. Two changes alter what the owner sees: a corrupt
`phone-alerts.json` now means "nothing to the phone" (Q-02), and research reports at 60–300 s no longer see X
followers read later (Q-05).

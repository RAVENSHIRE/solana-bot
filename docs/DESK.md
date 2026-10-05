# Trading desk · TEST / LIVE

The dashboard's **Trading desk** tab runs one pipeline in two environments:

| | TEST / PAPER | LIVE |
| --- | --- | --- |
| Banner | `TEST / PAPER — NO REAL TRANSACTIONS` | `LIVE — REAL FUNDS` |
| Scanner, strategy, gates, quote, route, transaction build, RPC simulation, pre-flight | same code | same code |
| Signature | never requested | Phantom, one approval per transaction |
| Fill | paper fill from the passed unsigned simulation | confirmed on-chain balance deltas |
| Ledger / telemetry | `data-desk/ledger-PAPER.json` (FAIR), `ledger-PAPER-CRASH.json`, `events-PAPER.json` | `data-desk/ledger-LIVE-<wallet>.json` (FAIR), `ledger-LIVE-CRASH-<wallet>.json`, `events-LIVE.json` |

TEST and LIVE never run at the same time and never share data. Stopping keeps all telemetry and ledgers.

## Starting the dashboard on Windows

Use `dashboard\start-background.cmd`. It starts the dashboard minimized and writes its output to `data-desk\dashboard.log`; follow the log with:

```
Get-Content data-desk\dashboard.log -Wait
```

A console window that is clicked, or has text selected, pauses every program that writes to it (Windows QuickEdit). A dashboard started with `npm start` in a visible window can therefore freeze until the window gets a key press. On 1 Oct it stopped answering for minutes. With the output in a file this cannot happen.

### Auto-start and restart (unattended)

Run `ops\install-autostart.cmd` once (no admin rights needed). From then on a supervisor (`ops\supervise.mjs`) keeps the
research observer and the dashboard running:

- **A process that stops is started again**, after 3 s, doubling up to 5 min while it keeps crashing. The phone is told
  (at most once per half hour per process), and again when the PC comes back after the desk was down (reboot, sleep).
- **The supervisor itself comes back**: a Startup-folder shortcut starts it at logon, and a Task Scheduler task
  ("Solana desk watchdog") every 5 minutes. Only one runs at a time (`data-desk\supervisor.lock`).
- **The session comes back** (`data-desk\desk-session.json`, written by the dashboard whenever it changes): a running
  TEST resumes as it was. LIVE with the local key comes back **with exits only**: holdings are reconciled as at every
  LIVE start, then stops, targets and rug exits run for the open positions, and new entries stay paused until you
  press *Resume*. If the reconciliation fails it is retried every 30 s for 5 minutes, then the phone is told. LIVE with
  Phantom cannot sign by itself and is never resumed; the phone is told that its positions have no exits.
- Logs over 50 MB are moved to `.1` at a restart. The supervisor's own log is `data-desk\supervisor.log`.
- **A power cut or hard shutdown does not keep the desk down.** The desk's files are written to disk before they replace
  the old ones. A lock file that holds no process number and is older than a minute counts as left over. An unreadable TEST
  ledger or event file (on Raven on 3 Oct, every file written in the last second held only zero bytes) is moved aside
  as `<name>.damaged-<time>`, and TEST starts fresh; the desk log says which files it moved. An unreadable LIVE ledger
  still stops the desk (`LEDGER_INVALID`), because it is a record of real money: look at it before you remove it.

Commands: `node ops\supervise.mjs --status` (last heartbeat), `--restart` (after a `git pull`: restarts the supervisor too, so its own new code applies; no phone message),
`--stop` (stops everything and keeps the watchdog off), `--start`. `ops\uninstall-autostart.cmd` removes it. While it
is installed, `dashboard\start-background.cmd` and `start-research.cmd` refuse to start a second copy.

Limits: after a Windows Update reboot the desk starts when you log in (sign-in without a password, or auto-logon,
avoids the wait). A PC that sleeps stops everything: set *Sleep* to *Never* while plugged in.

## Operational controls and restart

Strategy toggles, TEST drill and TEST reset are switched in the dashboard and saved per mode (`DESK_DEPLOYMENT_MODE=EDITABLE`, the default). For an unattended deployment set `DESK_DEPLOYMENT_MODE=LOCKED` in `.env`: they are then fixed at startup by the flags below and rejected by the server; Pause, Stop and EXIT NOW remain available. The startup flags are `DESK_PAPER_FAIR_ENABLED`, `DESK_PAPER_CRASH_ENABLED`, `DESK_LIVE_FAIR_ENABLED`, `DESK_LIVE_CRASH_ENABLED`; LIVE CRASH defaults to false. All keys are allowlisted and validated at startup.

FAIR and CRASH retain their separate normal cooldowns. `DESK_FAIR_LOSS_REENTRY_MIN` (default 60) and `DESK_CRASH_LOSS_REENTRY_MIN` (default 30) set a minimum cooldown after a confirmed loss. `DESK_FAIR_FRESH_SIGNAL` and `DESK_CRASH_FRESH_SIGNAL` default to true: a post-exit observation is required even when the clock has elapsed. Completed TEST cycles still count toward cooldowns.

Before each LIVE start, the selected wallet's saved ledgers are loaded and checked for unresolved orders. Tracked token quantities must match the wallet's SPL and Token-2022 accounts; failed inventory or a mismatch refuses the start. `GET /api/trading/health` requires the local capability and reports scan staleness or a blocking issue without provider credentials.

## Capital

One source (`src/desk/config.ts`, overridable in `.env`):

- `DESK_PLANNED_CAPITAL_USD` — planned starting capital, default **5.45**
- `DESK_BASE_ENTRY_USD` — base entry, default **2.00**
- `DESK_SLIPPAGE_BPS` — slippage tolerance, default 100; it counts toward max drag

Native reserve (0.003 SOL) and max drag (1.5 %) are the project's existing micro values. The actual SOL balance always comes from the connected Phantom wallet; `data/wallet-monitor.json` no longer sets a planned budget.

## Strategies (run in parallel)

| | FAIR (fair launch) | CRASH |
| --- | --- | --- |
| Idea | Fair-launch trending tokens, every hard gate, momentum in two consecutive scans | The early, well-traded part of a young pool's first move; trades of up to 10 minutes targeting +100 % |
| Entry | QUALIFIED status (below) | One scan: graduated ≤ 15 min ago (age of the token's **first** AMM pool, not of whichever pool is deepest now), 5m price +10 % to +30 %, 5m volume ≥ $50K, market cap ≤ $300K, buy/sell ≥ 1.3, ≥ 40 buys, AMM liquidity ≥ $10K and ≥ 3 % of market cap, mint + freeze authority revoked, no dangerous extensions, top-10 ≤ 50 % and largest wallet ≤ 15 % when known, liquidity not dropping. Launch fairness is shown but **not required** |
| Exits | `RS_*` rules: stop loss, take profit, trailing stop, max hold | `CRASH_EXIT_MODE=quick` (default): take profit +100 % (= $2 unrealized on a $2 entry) · stop loss −35 % · time stop 10 min · no profit lock unless `CRASH_LOCK_PEAK_PCT` is set. `CRASH_EXIT_MODE=ride`: no take profit · trailing stop 35 % from the peak once +50 % was reached · stop loss −35 % · time stop 60 min |
| Re-entry after an exit | 30 min | `CRASH_REENTRY_MIN` (10 min) — a fresh signal only |
| Checked | every 5 s | every 2 s |
| Entry size / TEST sleeve | `DESK_BASE_ENTRY_USD` / `DESK_PLANNED_CAPITAL_USD` ($2 / $5.45) | `CRASH_ENTRY_USD` / `CRASH_CAPITAL_USD` ($2 / $10) |
| Slippage / max drag | `DESK_SLIPPAGE_BPS` (1 %) / 1.5 % | entries `CRASH_SLIPPAGE_BPS` (2.5 %), exits `CRASH_EXIT_SLIPPAGE_BPS` (10 %) / `CRASH_MAX_DRAG_BPS` (5 %) |
| Open positions | 2 | `CRASH_MAX_POSITIONS` (3) |

- Each strategy has its own ledger and, in TEST, its own sleeve; LIVE strategies share the Phantom wallet and its reserve check.
- A token is held by at most one strategy. Several entries can happen in one scan, up to each strategy's free slots; a candidate the guard blocks (e.g. max drag) is skipped for 5 minutes and the next one is tried.
- Early warnings (liquidity −30 % since entry, pump.fun creator selling) apply to both. Position checks run beside the discovery scan, so a slow scan never delays an exit. CRASH entries happen before the rate-limited launch-history checks.
- Strategy cards show entry, sleeve, positions, realized/unrealized PnL, trades, win rate, average return and hold, profit factor and max drawdown (drill trades excluded), plus toggles. Disabling a strategy stops new entries; open positions keep their exits.
- **CRASH is off in LIVE until you switch it on.** That click is saved in `data-desk/settings-LIVE.json`, as are all strategy and drill toggles per mode, so a restart never changes what the desk trades. CRASH trades need fast approvals: use Phantom Auto-Confirm. A rug can still happen inside one block — the exits limit, not remove, that risk.
- **PAUSE ENTRIES** stops new positions only. Open positions keep their stop loss, take profit, trailing and time stops (in LIVE each exit still needs its Phantom signature). STOP ends everything.
- **Why these rules (backtest, 30 Sep 2026):** every pump.fun graduation over 12 h (247 pools with minute candles, a fixed sample of the 698 that graduated), $2 per trade with sized impact, 0.3 % venue fee per side, $0.02 fixed cost and 3 % stop slippage:

  | Rules | Trades | Win | Avg per trade | Median | Profit factor | Halves (time) |
  | --- | --- | --- | --- | --- | --- | --- |
  | Old: pool ≤ 60 min, +10–200 %, ≥ $20K · SL 15 %, TP 100 %, lock 40/15, 4 min | 178 | 30 % | −8.8 % | −19 % | 0.53 | −5.8 % / −12.5 % |
  | Old rules, RIDE | 172 | 11 % | −11.6 % | −19 % | 0.49 | −6.9 % / −17.4 % |
  | Old rules with the old costs (full exit fee, rent never reclaimed) | 178 | 26 % | −18.8 % | −29 % | 0.28 | |
  | **New: pool ≤ 15 min, +10–30 %, ≥ $50K, ≤ $300K · SL 35 %, TP 100 %, 10 min** | 36 | 53 % | **+24.3 %** | +12.6 % | 2.41 | +20.9 % / +27.1 % |

  The entry rule carries the result: with the new exits the old entry still loses (−11 %/trade); chasing moves above +30 % or trading on less than $50K five-minute volume turns it negative. The profit lock cost about 10 points in every variant; stops at 15–25 % were shaken out. The new rules stay positive with 8 % stop slippage (+22.9 %), at $100 per trade (+22.1 %) and with the old costs (+14.3 %). **Limits:** one night of data; about 12,000 rule combinations were compared, so the best one is optimistic; buy/sell ratio, buy count and holder gates (which the desk also applies) are not in candles. Re-run `npm run desk:backtest` regularly and compare with TEST.
- **TEST record, 1–5 Oct (88 trades, the history saved after the 3 Oct power cut plus the trades since):** +$6.63 in
  total, +3.8 % per trade on average, median −18 %, 34 won. By day +18 %, −2.5 %, −4.4 %, then +58 % on 3 trades. A
  bootstrap luck test gives p = 0.23: the average could be chance. **Not ready for real money.** What the trades show:
  - Take profit (+100 %) was hit 23 times (+101 % each); the 10-minute time stop closed 14, 10 of them up (+25 %).
  - **The −35 % stop filled at −56 % on average** (36 trades; most between −42 % and −55 %): the price falls on between
    two checks, plus fees. Position and exit quotes now go to Jupiter before scan and entry quotes (a rate-limited
    Jupiter key used to queue them behind each other), short-hold custom strategies are checked every 2 s too, and a
    quiet position is re-quoted only every 10 s (see *Known limits*), so a position near its stop is not in line.
  - Entries at **$70K+ market cap on a pool 5+ minutes old** made +15.6 % on average (40 trades), the rest −6.1 % (48).
    Found in these same trades, so it is a hypothesis: the **CRASH 70K+** preset (`CRASH_70K`) runs it beside CRASH in
    TEST on the same signals with the same exits; only its trades from 5 Oct on count.
  - **CRASH's TEST variants** (research C1/C2, `TA-LAYER.md`, pre-registered 5 Oct; only trades after 5 Oct 21:00 UTC
    count): **C1** (`CRASH_C1`) enters only when the pool's previous resistance gives a stop at most 25 % below the
    price (TA2); **C2** (`CRASH_C2`) takes CRASH's entries with the stop at the previous resistance −3 % instead of
    −35 % (TA1), the −35 % stop then applies only without structure or while the pool's market cap cannot be read.
    The previous resistance is the last swing high a later minute closed above, below the price, read from the pool's
    minute candles (`structure.ts`; the GOLDEN tracker samples every fresh PumpSwap pool every 4 s, for 15 minutes
    while C1 or C2 is on). A pool with no candles yet is a C1 skip.
  - **Side by side:** `CRASH_70K`, C1 and C2 are *comparison variants* (`compareWith: CRASH`): they need CRASH's own
    entry signal, enter in CRASH's pass and, in TEST, may hold a coin CRASH holds (and the reverse). Until 5 Oct CRASH,
    entering first, kept `CRASH_70K` out of nearly every coin it signalled. In LIVE one wallet keeps one holder per coin.
  - Before any LIVE CRASH: about 100 more TEST trades positive after costs, the luck test passing, and the EXEC records
    showing how long a LIVE order takes from signal to confirmation.
- Other CRASH settings in `.env`: `CRASH_ENABLED`, `CRASH_TAKE_PROFIT_PCT`, `CRASH_LOCK_PEAK_PCT`, `CRASH_GIVEBACK_PTS`, `CRASH_STOP_LOSS_PCT`, `CRASH_MAX_HOLD_MIN`, `CRASH_TRAIL_ACTIVATION_PCT`, `CRASH_TRAIL_STOP_PCT`, `CRASH_RIDE_MAX_HOLD_MIN`.

### Custom strategies (your own rules, added in the dashboard)

Use the **Strategy** dropdown above the strategy cards to:

- pick one strategy, or show all of them;
- switch the picked strategy on or off (in the selected mode only);
- **add** a new strategy from a preset or from blank;
- **edit** or **delete** a custom strategy.

#### What a custom strategy is

A custom strategy is a set of rules. Every rule you fill in must pass; an empty field means no rule.

- **Entry**: market-cap band, minimum holders, pool age, 5m and 1h price-change bands, 5m and 1h volume, buy/sell ratio, minimum liquidity, top-10 and largest-wallet limits, and optionally a linked X account.
- **Exits**: take profit (empty means ride), stop loss, trailing stop, market-cap floor or target, and max hold.
- **Size and costs**: TEST capital, entry, max positions, slippage, exit slippage and max drag.
- **Re-entry**: a cooldown after each exit.

Mint and freeze authority revoked and no dangerous token extensions always apply; they cannot be switched off.

#### How it trades

- Custom strategies see every priced token, including those above FAIR's $1M band. A token kept only for them shows the tier **Custom only** and is never a FAIR entry.
- The **Custom** column in *Candidates* shows each strategy's verdict: entry-ready, or the first rule not met. The token's detail lists every check.
- Holders are counted first for tokens a custom strategy is interested in.
- Custom strategies enter after the scan has ranked its tokens. The desk keeps 60 tokens in memory; a token that is
  entry-ready for any strategy is never among the ones dropped. Until 5 Oct the drop went by FAIR's verdict, so half
  the custom-strategy signals were dropped before the custom strategies looked (5 Oct, 13:30–17:00 UTC: 26 of 52 coins,
  MIGRATION2 16 of 28); MIGRATION2 was entry-ready on SOLBORN for 20 minutes at $57K–$298K and never bought.
- Each strategy has its own ledger (`ledger-PAPER-<ID>.json`, `ledger-LIVE-<ID>-<wallet>.json`) and, in TEST, its own sleeve.
- A new strategy starts **ON in TEST and OFF in LIVE**.
- An edit applies to new entries at once, and to the exits of open positions.
- A strategy with an open position cannot be deleted. After deletion its ledger stays on disk.
- The rules are saved in `data-desk/strategies.json` and shared by both modes; the on/off switch is saved per mode.
- With `DESK_DEPLOYMENT_MODE=LOCKED`, adding, editing and deleting are refused.

#### Your four plays as presets

| Preset | Play | Entry | Exits |
| --- | --- | --- | --- |
| **MIGRATION** | Migration | $60K–$300K, pool < 1 h old (just graduated), 1h Vol/MC ≥ 30 %, ≥ 200 holders, top-10 ≤ 30 %, largest wallet ≤ 10 % | trailing stop 30 % once 2× is reached, stop −50 %, max 3 days, no stop-out in the first 60 s |
| **CONSOL** | Consolidation re-entry ("Crash Strategy") | $800K–$1.2M, pool ≥ 12 h old, 1h change −10 % to +10 % (sideways), 5m 0 to +8 %, 1h volume ≥ $30K, ≥ 500 holders | trailing stop 30 % from 3×, stop −30 %, max 3 days, no stop-out in the first 60 s |
| **SCALP** | 15-minute scalp | $400K–$1M, 5m +15 % to +80 %, 5m volume ≥ $50K, buy/sell ≥ 1.3 | take +60 %, stop −30 %, out after 25 min |
| **RUNNER** | Established runners | see below | see below |

The desk sells a position in one piece, so your profit ladder (2× / 5× / 10× / trail the rest) is approximated by a trailing stop that activates at the first ladder step. The desk's built-in **CRASH** strategy is *not* your Crash Strategy: CRASH trades young pumping pools for minutes; use **CONSOL** for consolidation re-entries.

#### Copycats

Before any entry the desk checks whether an older Solana token with the same ticker or name is at least 3× bigger (and ≥ $100K): every token the scanner has seen, then a DexScreener search. Such a clone is refused (`COPYCAT of …`). On 1 Oct the CRASH strategy bought a second "Jane" two minutes after it launched, while the real Jane was at $1M+; the clone rugged.

#### Presets

**RUNNER** (your style):

- **Entry**: holders ≥ 1,000; market cap $300K–$20M; pool older than 1 h; 1h change −15 % to +25 % (sideways); 5m change +1 % to +15 % (turning up again); 1h volume ≥ $100K; buy/sell ≥ 1.1; liquidity ≥ $50K; top-10 ≤ 40 %; largest wallet ≤ 10 %.
- **Exits**: no take profit; trailing stop 25 % below the peak once +30 % was reached; stop loss −25 %; max hold 7 days.

RUNNER has not been backtested: let it prove itself in TEST before switching it on in LIVE.

### Strategy assistant (Claude)

The *Strategy assistant* panel in *Strategies* is a chat with Claude (`claude-opus-5-5`). Describe how you pick, enter and exit coins. You can also put a wallet address in *Learn from wallet*: the desk then reads that wallet's last 60 transactions from the chain and gives Claude the swaps it finds, with the buys and sells per token, amounts, times and the estimated market cap at each trade (trade price × current supply).

What happens with an answer:

- Claude answers, asks at most two questions, or **proposes a strategy**.
- A proposal is checked like any custom strategy; if it fails a check, the panel says why and you can ask Claude to fix it.
- **Review in editor** opens the proposal in the rule editor. Nothing is saved or switched on until you press *Add strategy* there, and a new strategy starts in TEST only.
- Follow-up messages ("tighter stop", "only above $1M") edit the same proposal.

Setup and data:

- Add `ANTHROPIC_API_KEY` to `.env` and restart the dashboard. The key stays in the local server and is never sent to the browser.
- Sent to Claude: your messages, your existing custom strategies, and the named wallet's swap summary.
- Requests use structured output and Anthropic's server-side fallback for declined requests.

### OPEN: the opening screen (your basic screen)

> **OPEN is retired (5 Oct, research STRATEGY-REVIEW.md):** 69 TEST trades, −$113 (−$105 on the 55 the stale-baseline
> exit bug did not touch); 59 of 65 breakout alerts dead or −70 % within an hour. It stays off in TEST and LIVE, cannot
> be switched on, and its breakouts no longer reach the phone. The opening screen keeps running: research uses fast
> openers (the gate's sprint rules), and its breakouts still show in the dashboard and the event log.

From FIX6900 (`6bQ4…SmvC`) on 1 Oct: **$20K opening candle → $7K → $14K → $27K → $35K →** graduated, $500K+. The rules:

1. **Strong open:** the first one-minute candle reaches at least **$10K** market cap.
2. **Floor:** after that it never trades below **$6.7K**. Anything that does is a rug and is dropped.
3. **Breakout:** it breaks back above its opening high (×1.3, so **$26K** after a $20K open). An alert goes out to your phone at once, and **OPEN** buys.
4. **Hold for at least 6×** the first entry: no take profit and no trailing stop before that. The $6.7K floor is the stop; insiders dumping still sells it (rug defence). From 6× on, a 30 % trailing stop from the peak.
5. **Scale in:** add a base entry at **2×** and again at **4×** the first entry price (`OPEN_ADD_AT=2,4` in `.env`; once each, in order, never while entries are paused or the TEST sleeve cannot fund it).

How it works:
- Every new pump.fun launch is picked up within seconds (the radar's decoder, before its slower website and X checks), and its **bonding-curve market cap is taken every 4 s**, so the opening candle is measured from the first seconds, long before DexScreener lists the token. While the research observer runs, both come from its live stream (each trade carries the curve's reserves; no RPC calls); otherwise from the chain, one RPC call per 100 curves. The dashboard's *Opening screen* source line says which.
- Launches first seen more than 45 s after creation are not judged (their opening candle is unknown). Strong opens are watched for 45 minutes or until they graduate.
- The breakout alert names the opening high, the low and the breakout level, with a FOMO link. Copycats (a bigger, older token with the same name), impersonators and rugs found by the radar are never alerted.
- The breakout starts a scan at once; OPEN buys while the breakout is under 5 minutes old, the market cap is above the floor and not more than 1.6× the breakout level, insiders hold under 50 %, the largest wallet holds at most 20 % when known, and the safety gates pass.
- OPEN holds through graduation (no pre-graduation exit). Sizing: base entry ($2), TEST sleeve `OPEN_CAPITAL_USD` (default $15, enough for two positions with their adds), at most 2 positions, no re-entry for 4 h. ON in TEST, OFF in LIVE until you switch it on.
- The *Opening screen* panel shows every strong open: opening candle, low, now, peak, status (watching, BREAKOUT, rug, graduated first, no breakout) and whether OPEN bought it. The sources line counts launches in their first minute, strong opens, breakouts and rugs.

These rules come from one example. The alert audit of 1–2 Oct (65 breakouts, see *Which desk alerts reach the phone*) found no exit that makes them pay reliably at a realistic fill, and OPEN lost on all 7 TEST trades (−$11.77): its breakout alerts are off the phone by default (`DESK_ALERTS`), and it should stay in TEST.

### GOLDEN POCKET: graduated pools, only up and break and retest

> **5 Oct changes (research P1/P2):**
> - **3× ceiling:** a fill on a pool whose first minute topped more than 3× its graduation value (a pump.fun curve
>   completes at about 410.9 SOL, so about $270K at $220/SOL) is not alerted and not bought. First 10×, after the
>   $5.25M-first-candle "golden" fills that were rugs (CTi9…pump, ~100×); then 3× for the owner the same night:
>   "entries at $360K are too big for day scouting" (Addidas opened at 7.2×, NVIDIA at 6.6×). The shadow records
>   still follow every fill, so research can compare the groups.
> - **Brand-name coins** (Addidas, NVIDIA, AAPLE AI, Grok AI…) are never alerted or bought: see *Brand-name coins*.
> - **Alerts say what they are:** market cap, how far the pool opened above its graduation value, the previous
>   resistance and its stop, and "Not a qualified call".
> - **Shadow trades (no money):** every only-up fill is followed at bot speed (+2 s) and phone speed (+45 s) with
>   three exits judged together: (a) GOLDEN as it trades, (b) plus a +100 % take profit, (c) half sold at +100 %.
>   The take profit is the fix for "fomocoin" (5 Oct 16:53 UTC: +281 %, then −88 % three seconds later).
>   Records: `data-desk/golden-shadow.jsonl`; report: `npm run research:golden-shadow -- --size 2 --fee-pct 1.25
>   --fixed 0.03` (costs are options: they change with the provider and the size). P2 passes after ≥ 30 fills of
>   pools that opened at ≤ 3× with a positive average after costs.

> **Off by default (2 Oct).** The first 5 live TEST trades lost 57 % on average: the coins (SpaceX, Mr Beast, SIGF at $300–470K, 25–30× above their launch) rugged straight through the 5 % stop. The backtest below filled every stop at its level; with a stop that a rug gaps within a minute selling at that minute's close (`gapFill`), the deployed only-up rule makes **−33 % per trade** (PF 0.31, both halves), at every entry level. The numbers below are kept as the record of that mistake.

From 66hK2 (BULLISHCAT) on 1 Oct: graduated → **$163K** (the first high) → **$108K** (the dip) → **$225K** (breakout) → back to **$160K** (the old high, the "golden pocket") → **$642K**. The shape counts, not the level: the same ratios on a $20K curve or a $200K pool. Two variants, both read from every fresh graduation's PumpSwap pool:

1. **Only up (bought):** the pool's first **2 one-minute candles both close green, each above the previous close**. Bought from the third minute on, up to **12 % above candle 2's close**; the stop is **5 % under candle 2's close**; a **25 % trailing stop after +50 %**; sold after **60 minutes** at the latest.
2. **Break and retest (shown, not bought by default):** a first high, a dip of 15–50 % (deeper is a failed pattern), a breakout to ≥ 1.1× the first high, then a return into the pocket — from the old high +3 % down to 12 % under it, or the 0.5–0.65 retracement of the dip → breakout swing, whichever comes first — within 20 minutes. The stop is 5 % under the pocket; the take profit 5 % under the breakout high. `GOLDEN_RETEST_ENTRIES=true` in `.env` buys it too.

Backtest (`npm run desk:golden`, 12 h of graduations on 1 Oct, 533 pools, Birdeye minute candles, $2 per trade with fees, impact and 3 % stop slippage, judged by the weaker time half):

| Variant | Trades | Win | Mean / trade | Profit factor | Halves |
|---|---|---|---|---|---|
| **Only up as deployed:** 2 green, stop −5 %, trail 25 % after +50 %, 60 min | 310 | 17 % | **+7.9 %** | 2.0 | weaker half +7 % |
| Only up, same, only with ≥ $30K traded in the first minutes | 262 | 17 % | +9.8 % | 2.3 | +9 % / +10 % |
| Only up, same, 30 min hold | 310 | — | +13.7 % | 2.9 | weaker half +4 % |
| Only up, same, 120–240 min hold | 310 | — | −1 … −2 % | 0.8 | — |
| Break and retest, your levels (old high −12 %, stop 5–10 % under, sell 5–10 % under the resistance) | 84 | 24–31 % | −5 … −11 % | 0.4–0.7 | both negative |
| Break and retest, best of 768 rule sets | 120 | 51 % | +0.1 % | 1.0 | 0 % / 0 % |
| Baseline: every pool bought 10 min after graduation | 529 | 20–39 % | −3 … −6 % | 0.7 | — |

- The only-up result holds across its neighbours: 3 green candles, any volume filter ($0–60K in the first minutes; the pool reserves give no volume, so none is applied), 30–60 min holds. It does **not** hold past 2 hours, and a 10 % stop is worse than 5 %. Most trades lose about 9 % (the stop); a few runners (+100 … +700 %) carry it.
- The retest caught 66hK2 (+37 %) and FIX6900 (+48 %), but over all pools about half the retests fall straight through the stop.
- **Stop slippage decides it.** Most trades end at the stop, so what a stop really sells at matters most: the deployed rule makes +7.9 % per trade with 3 % slippage past the stop, +5.3 % with 6 %, +1.8 % with 10 % and −2.5 % with 15 %. The first live stop (TEST, 2 Oct) sold 8.7 % under its level: the TEST ledger, which sells at real Jupiter quotes, is the number to watch before LIVE.
- One day of data: watch the GOLDEN ledger in TEST before switching it on in LIVE.

How it works:
- Every graduation is read from the chain (the migration authority, as for CRASH) within seconds; one first seen more than 45 s after graduating (after a restart, say) is not watched, since its first candles are unknown. Its PumpSwap pool address is derived (the canonical pool of the mint, SOL- or PUMP-quoted) and both reserves are read **every 4 s** (one RPC call per 50 pools). Market cap = quote reserve ÷ token reserve × 1B supply × SOL (or PUMP) price.
- A fill is alerted at once ("GOLDEN POCKET: ABC at $112.0K") and starts a scan; GOLDEN buys while the fill is under 3 minutes old, the pool is above the pattern stop and not more than 8 % above the zone's top, no rug sign is known, the largest wallet holds at most 20 % when known, and the safety gates pass. A retest that is not bought is listed in the panel and the event log, never alerted.
- The pattern's stop (and a retest's take profit) are stored on the position as market caps and checked against the pool's reserves every 3 s: `POCKET_STOP` / `RESISTANCE_TARGET`. A 40 % stop loss stays as a backstop.
- Sizing: base entry ($2), TEST sleeve `GOLDEN_CAPITAL_USD` (default $15), at most 2 positions, no re-entry for 4 h. ON in TEST, OFF in LIVE until you switch it on.
- The pools are read only while they are used: GOLDEN switched on in the running mode, golden alerts going to the
  phone, or a GOLDEN position still open. Otherwise the sources line says *paused* and no RPC is spent on them.
- The *Golden pocket* panel shows every watched pool: minutes since graduation, high → dip → breakout, now, peak, pattern state, fill and stop, and GOLDEN's verdict.

### LAUNCH: the launch radar (the @glabuz pattern)

On 1 Oct @glabuz turned $500 into ~$15K on Meme Industries (`FFrRBPP9…pump`) by entering at ~$20K:

| UTC | Event | Curve market cap |
| --- | --- | --- |
| 16:07:22 | created on pump.fun | $6K → $14K in the first minute |
| 16:08:41 | the project's own X account @MemeInds posts (79 s after creation); custom website onsolchain.lol | ~$16K, flat for 4 minutes |
| 16:12 | first jump | $17.5K → $30K |
| 16:16:06 | graduates to PumpSwap | ~$47K; $800K+ two hours later |

The signal is the quality of the launch itself. Only a few of the ~50 pump.fun launches per minute have an own X account and a real project website that links back to it.

**How the radar works:**

- Every scan reads the new launches together with their metadata (X, website, Telegram): from the research observer's local live stream when it runs (no RPC calls; see [RESEARCH.md](RESEARCH.md#running-the-observer)), otherwise straight from the chain (pump.fun's mint authority, `TSLvdd1…`) over the RPC.
- It checks the website of every launch that has an X link.
- It scores each launch (`launches.ts`):

  | Signal | Points |
  | --- | --- |
  | Own X account | 3 |
  | Live project website with a title | 3 |
  | Website links the same X account | 2 |
  | Telegram | 1 |
  | Real description | 1 |

  Links to platforms and news sites don't count as a project website.

- It checks the **contract address** (CA) on the project's own pages. The metadata alone proves nothing: on 1 Oct the impersonator STASH (`Fx5E1…HQyJ`) copied @stashdfun and stashd.fun into its metadata, 14 h after the real token `3Bdwh…pump`, and scored 8. Now:
  - the X profile page (`x.com/<handle>`, as served without login, no API key) and the website, including its own script bundles, are read for Solana addresses;
  - **this mint written there** confirms the launch: +3 when the X account posted it, +2 when the website shows it;
  - **another token's CA there and never this one** marks an **IMPERSONATOR**: score 0, never shortlisted or bought, and an alert if it was shortlisted before;
  - a post by the account wins over a stale website;
  - launches not confirmed yet are re-read every 30 s for 12 minutes (the X page) and every 2 minutes (the website), since projects post the CA after creation (Meme Industries 79 s, Potato within the first minutes).

  | Confirmation | Points |
  | --- | --- |
  | X account posted this CA | +3 |
  | Website shows this CA | +2 |
  | X or website shows another CA | score 0 (IMPERSONATOR) |

- A launch named like a bigger, older Solana token (same name or ticker, $50K or more, at most 3 days older or still busier) is a **COPYCAT**: never shortlisted, never alerted. One DexScreener search per name, cached for 10 minutes. (On 1 Oct the FIX6900 copycat `3jxu74…cPVk` was alerted 8 minutes after the real FIX6900 graduated; a restart had cleared the radar's memory of the original.)
- A "website" whose URL carries a contract address (e.g. `otcdesks.cash/coin/<CA>`, which prints whatever address is in its URL) is a per-token page: no website points, never proof of the CA.
- Clones are marked **CLONE** and never shortlisted: a later launch that copies an earlier one's X account, website or name (on the first live run KEN appeared 3× and ROPAD 2×). If the project's own X account posts the clone's CA, the clone is the real token and the earlier "original" an impersonator.
- **X reach** comes from the same X profile page (no key needed): followers, account creation date, post count, blue check, and the views, likes and replies of the recent posts. The more followers, the higher the launch ranks:

  | X reach | Points |
  | --- | --- |
  | Followers ≥ 10K / ≥ 2K / ≥ 500 / ≥ 100 | +4 / +3 / +2 / +1 |
  | Followers below 25 | −1 |
  | Best own post in the last 3 days ≥ 50K / ≥ 10K / ≥ 2K views | +3 / +2 / +1 |
  | Account less than a day old with under 500 followers | −1 |
  | The linked X account does not exist | −3 |

  A linked *post* (x.com/…/status/…) counts too when it is the project's own: its author's handle matches the name or ticker, the website links it, or it posted this CA (Ansemmas on 1 Oct: a 5-day-old account, 401 followers, a 21.7K-view post; it went from $63K to $1.03M). A post by someone else — a celebrity, a company, a caller — is **narrative**, not the project's audience: no follower points, only the linked post's views (+1 from 100K, +2 from 1M). The same holds for an "own account" link to a big, old account (≥ 50K followers, over a year old) that never posted the CA (Bankcoin on 1 Oct linked a post by Circle's CEO, 198K followers). The radar shows such links as *narrative*.
- **Claude review** (with `ANTHROPIC_API_KEY`): every launch that reaches the shortlist score is read by Claude — token description, the website's visible text, the X bio and recent posts with their views, the CA check and the insiders — and rated STRONG (+3), OK (+1), WEAK (−1) or **SCAM** (never bought). It also scores idea and professionalism (0–10), says whether the material looks AI-made, and lists concrete scam signs (another CA, drainer warnings, "send SOL" giveaways, impersonation). One low-effort request per launch, at most 20 per hour (`DESK_AI_REVIEWS_PER_HOUR`; `DESK_AI_REVIEW=off` turns it off). At about $0.01–0.03 per review that is at most ~$0.60 an hour while the radar is busy. Everything sent is public. **Gemini as fallback** (with `GEMINI_API_KEY`, optional `GEMINI_MODEL`, default `gemini-2.5-flash`; a retired model is replaced by the newest flash model the key can use): the same prompt and verdict schema. Claude is asked first; when it is out of credits or its key is rejected it rests 30 minutes, then 1 h, 2 h, 4 h and at most 6 h while that goes on (credits do not come back by themselves; one good answer resets it), and Gemini reviews meanwhile (and the other way round). With only one key, only that one reviews. The data sources line says until when it rests.
- **X feed** (with `X_BEARER_TOKEN`): every 30 s the desk searches recent X posts for token launches and CAs (`DESK_X_QUERY` overrides the search; the default looks for "ca:", "pump.fun", "contract address", "just launched", "now live" on Solana, no reposts). Each post that names a mint becomes a signal with the author's followers and the post's impressions:
  - the project's own account posting this CA confirms it (+3);
  - another account posting it adds +1, or +2 with ≥ 10K views or followers;
  - a mint the radar did not see launch (older, or from another launchpad) is scanned like any candidate (source *X feed*).

  The X API's Basic plan allows 60 searches per 15 minutes; the desk uses 30 and waits out a rate limit. A refused token or plan (HTTP 401/403) or an account without search credits (HTTP 402) is asked again only every 6 hours; restart the desk after changing the plan or `X_BEARER_TOKEN`. Without a token the feed is off and the radar still reads X profile pages.
- **Rug defence** (`launch-risk.ts`). The two LAUNCH trades of 1 Oct that dumped at graduation:

  | | Insiders at creation | Peak | After graduating |
  | --- | --- | --- | --- |
  | ETF (5EvrB7…pump) | dev 26.6 % + 5 wallets = 40 % | +308 % | −84 % |
  | Potato (GicwGn7X…) | dev 5.1 % + 5 wallets = 15 % | +220 % | −90 %, X account deleted afterwards |

  A bundled creation alone does not mark a rug (ETF was the best trade). What both had in common is the insiders — the creator and every wallet that bought in the creation slot — selling into the migration, when Jupiter cannot route the token for a minute or two. So:
  - the insiders are read from the chain seconds after the launch is seen and shown in the radar (pump.fun's CreateV2 / Token-2022 launches included; the curve's own token account is not an insider; an unreadable creation is retried twice and then stays unknown, which does not block); a launch where they hold ≥ 50 % is never bought;
  - a held position sells as soon as the insiders sold 25 % of their bag and at least 1 % of supply (**RUG insiders sold**), checked every 8 s.
    Their bag is measured again at the first check after the entry, and so is the creator's (DEV_SELLING): what they
    sold before the desk bought is not a sale. Until 5 Oct the share from the launch was used, so a CRASH entry 30 min
    after the launch of SOLBORN (insiders 63 % at launch, 1.4 % by then) was sold 10 s later as a RUG; the coin went 9×;
  - a position bought on the curve sells **before graduation** when the curve is 90 % full and the insiders still hold ≥ 8 % (**PRE_GRADUATION**); insiders with a small bag are ridden through graduation;
  - a held launch's X account is re-read every minute: gone on two reads in a row after it existed → **RUG**, sold;
  - every rug is remembered in `data-desk/rugs.json` with its creator, X account and website: a later launch by the same creator, account or site scores 0 (**RUG HISTORY**). Potato is on the list from the start.
- From a score of 6 the launch is shortlisted: it appears under *Launch radar* (ranked by score, then followers) with columns for the **CA** (✓ on X, ✓ on site, ✗ FAKE, ✗ RUG, not yet), **X reach** (followers, best post views, account age, X-feed posts), **Insiders** and **Claude**'s verdict, an alert with a FOMO link goes to your phone, and the token is analysed like any candidate. A launch exposed later (impersonator, rug) is reported once and alerted.

**LAUNCH** (built-in strategy, ON in TEST, OFF in LIVE) buys a shortlisted launch:

- **Entry** (all of these):
  - never an impersonator, a rug (deleted X account, rug history, SCAM review) or a launch whose insiders hold ≥ 50 %; insiders read before the entry;
  - **on the curve**: from 1 minute after creation when the project's X account or website shows this CA, from 3 minutes otherwise, never after 12 minutes. Jupiter quotes new curve tokens 3–12 s after creation (measured on 1 Oct), so the evidence sets the window, not routing; market cap $5K–$40K; 5m volume ≥ $1K and ≥ 10 buys;
  - **after graduation** (the runners that outgrow the curve window — Ansemmas, WIRED): up to 90 minutes after creation, market cap $40K–$400K, score ≥ 9, X reach of ≥ 300 followers or a 5,000-view post, 5m volume ≥ $10K and ≥ 40 buys;
  - top-10 wallets ≤ 35 %, largest wallet ≤ 12 %, developer ≤ 10 % when known;
  - mint and freeze authority revoked;
  - not a copycat.
- **Exits:**
  - the rug exits above (insiders selling, before graduation while insiders hold a bag, X account deleted);
  - stop −40 % (not in the first 60 s);
  - trailing stop 35 % once 2× is reached;
  - max hold 4 h;
  - no re-entry for 4 h.

An "entry-ready" alert goes out with the FOMO link, so you can buy by hand in FOMO at the same moment. These rules are not backtested: watch the LAUNCH ledger in TEST before switching it on in LIVE.

### FOMO

FOMO has no public API: its token pages are share links into the app. What the desk does instead:

- Every token in *Candidates*, *Open positions* and *Watch* has a **FOMO** link that opens it in the FOMO app.
- *Watch → Load wallet holdings* lists what your FOMO wallet holds (paste its address), so you can set exit levels for each with one click and get alerts.
- *Learn from wallet* in the strategy assistant reads your FOMO wallet's trades.
- FOMO's *Migrated* list is pump.fun graduations, which the desk reads directly from the chain.

### Coin check: paste an address, get the reading

*Coin check* (sidebar, under Overview) answers "is this coin worth a look?" for any Solana token. Paste the contract
address, or a FOMO, pump.fun or Jupiter link: the check starts at once and takes 20–40 s. Read-only, never a trade.

- **Four sources:** Jupiter (holders and their change, real "organic" buying and selling, the developer wallet's
  history), DexScreener and GeckoTerminal (market cap, liquidity, the all-time high and how far below it, the decade
  levels), GoPlus and RugCheck (the contract), and the chain (the 20 largest holders, where each wallet got its first
  SOL, clusters of wallets funded by one source, the team's share, fresh wallets).
- **The reading on top:** a headline and the lines behind it, as for WWW and SI on 3 Oct: price and high, contract,
  holders, demand, and what would make it interesting. Green: holders rising and real buyers leading. Red: a blocked
  contract, or demand fading (holders falling or real sellers leading). It is not a qualified call.
- **All numbers** unfold below; a source that did not answer is listed, the rest still shows.
- **Add to watchlist** puts the coin on the research watchlist (`data-desk/research/watch-tokens.json`): the phone gets
  INFO when it rises 15 %+ in an hour with buyers leading, and the ladder records it every day.
- One check at a time; the same coin again within 2 minutes comes from the last check.

### Watch: exit rules for tokens you hold yourself

The *Watch* section (sidebar: Watch) guards tokens you bought outside the desk, on FOMO, in Phantom or anywhere else. Add the token's CA and the wallet that holds it, then set any of these levels:

- **Exit at market cap ≤** (floor), e.g. `30M`.
- **Trailing stop**, in % below the highest market cap seen since you added the token, e.g. `25`.
- **Take profit at market cap ≥** (target), e.g. `80M`.

How it runs:

- Market caps (DexScreener) are checked every 15 s and the wallet balance every minute, whether TEST or LIVE runs or not, as long as the dashboard runs.
- A level must be crossed in **two checks in a row**, so one bad data point never fires.
- A rule fires once. **Re-arm** it to watch again; the trailing stop's peak then restarts at the current market cap.
- Rules and alerts are kept in `data-desk/watch.json`.

**Alert** (any wallet) notifies you in three places:

- the dashboard;
- browser notifications (press *turn on*);
- your phone, when one of these is set in `.env`:
  - `DESK_NTFY_TOPIC=<long random name>`, then subscribe to that topic in the free ntfy app;
  - `DESK_TELEGRAM_BOT_TOKEN` and `DESK_TELEGRAM_CHAT_ID` for Telegram.

**Research recorder down:** the desk watches the research observer's ledger. When no ledger file changed for
10 minutes while the desk runs, one phone message says so ("Research recorder silent"), and one more when it records
again; the data sources show the last record's age. A PC that is off sends nothing (5 Oct: the observer had been down
about 32 h, 4–5 Oct, without anyone knowing).

Which desk alerts reach the phone: the **Phone** switches on the opening screen (OPEN breakouts, GOLDEN fills, rug sales, LAUNCH entry-ready, radar finds) — saved in `data-desk/phone-alerts.json`, applied at once and winning over `.env` — or else `DESK_ALERTS` in `.env`, a comma list of `golden` (GOLDEN POCKET fills), `rug` (a held position sold as a rug), `open` (OPEN breakouts), `launch` (LAUNCH entry-ready) and `radar` (a launch shortlisted, a radar rug, an impersonator), or `all`. The default is **none** (owner, 2 Oct: no rug confirmations on the phone, only qualified calls). Qualified calls, interesting coins (checkmarked project accounts that post their CA) and research updates come from the research observer, not the desk: see [RESEARCH.md](RESEARCH.md#what-reaches-the-phone-qualified-calls-interesting-coins-research-updates). Tapping an ntfy notification opens the coin in FOMO. OPEN calls say how fast the launch grew ("$3.4K → $28.9K in 68 s (×8.5)") and that fast openers often rug within minutes. Only **sprints** go to the phone, a breakout within 2 minutes of launch, at most 4 an hour: on 3 Oct every breakout went out (about 12 an hour, 159 by the afternoon) and the free ntfy quota ran out, so ntfy answered HTTP 429 and no alert of any kind reached the phone. Everything still shows in the dashboard and the event log (an OPEN alert held back by the limit is recorded as `SUPPRESSED_BY_LIMIT`). The observer's status line counts phone deliveries and failures.

Why that default — the alert audit of 1–2 Oct (175 phone alerts in 5 h, what each token did in the hour after its alert, Birdeye minute candles):

| Alert | Alerts | Dead or −70 % now | Best exit at a realistic fill (alert price +2 %) |
|---|---|---|---|
| Radar news | 88 | 63 of 68 shortlists | — (never bought) |
| OPEN breakout | 65 | 59 | −47.6 % per trade with OPEN's exits; +1.6 % at best (take profit +100 %, stop −30 %), one half −11 %, the other +14 % |
| LAUNCH entry-ready | 23 | 23 | −22 % with OPEN-style exits; +8–9 % with a trailing stop, carried by two outliers |

Most of the spike happens inside the minute the alert goes out: bought at that minute's high, every exit loses (OPEN −8 … −19 % per trade).

**Sell automatically** is available only for the local-key wallet (`DESK_LIVE_SIGNER=local-key`).

- It sells the wallet's whole balance through the same guarded path as a desk exit: Jupiter quote, route, pre-flight checks, signature persisted before broadcast, confirmation, then the empty account's rent is reclaimed.
- Tokens a desk strategy holds in the same wallet are left alone.
- A sale interrupted by a restart is never retried: check its signature on Solscan.
- FOMO's in-app wallet is a different wallet that the desk cannot sign for, so FOMO holdings get alerts.

### Going LIVE (Phantom)

1. Pull, restart the dashboard, open it in the browser with the Phantom extension and **Connect Phantom**.
2. Switch to **LIVE**, then **START LIVE SESSION** and **Enable Auto-Confirm** in Phantom. Phantom offers Auto-Confirm only to domains it has approved ("No supported networks found for this domain" on a local dashboard); then every order needs your approval within 15 s.
3. Switch CRASH on (and FAIR off if you only want CRASH); both choices are saved.
4. Keep the PC awake and the browser running. The dashboard polls from a Web Worker, so a hidden or minimized tab keeps the session and Auto-Confirm alive; closing the tab or the browser ends LIVE (by design).
5. Budget: the 0.003 SOL reserve and ≈ 0.002 SOL account rent per new token come out of the wallet before entries.

### Going LIVE with the local key (unattended, opt-in)

Add to `.env` (the key is already there as `WALLET_PRIVATE_KEY`):

```
DESK_LIVE_SIGNER=local-key
DESK_LIVE_MAX_ENTRIES=10      # new positions per LIVE session; exits are never capped
```

- Restart the dashboard. LIVE then shows **SIGNED AUTOMATICALLY BY THE LOCAL KEY**, and START LIVE SESSION needs no Phantom connection.
- Every order is signed in the local dashboard process, with no approval. The session keeps running when the browser tab is closed; STOP LIVE SESSION (or stopping the dashboard) ends it.
- The key is read only by `src/desk/local-signer.ts`, only for the LIVE engine. It must match `WALLET_PUBLIC_KEY` when that is set, and it is never logged, displayed or put in the desk environment. TEST never receives a signer.
- All other rails are unchanged: the 0.003 SOL reserve, the max drag per strategy, unsigned RPC simulation and pre-flight before signing, the signature saved before broadcast, and a halt (never a retry) when an outcome is unknown.
- CRASH is still off in LIVE until you switch it on (the choice is saved). Remove `DESK_LIVE_SIGNER` to go back to Phantom approvals.
- **Still asked to approve in Phantom?** Then the desk did not see the setting. The LIVE start line in the telemetry says `every order needs a Phantom signature` instead of `signed automatically by the local key`. Check that the line is in `.env` in the repo root (the same file as `RPC_ENDPOINTS`), that the file is saved, and restart the dashboard.

### EXIT NOW

Every open position has an **EXIT NOW** button in *Open positions*. It sells the whole position through the normal SELL path: the same guard, the strategy's exit slippage, and the same signer (the local key signs at once; with Phantom you approve within 15 s). While the desk runs, the position loop sells on its next tick and retries until the position is gone. With the desk stopped, one attempt runs immediately, and you can press the button again. A token bought outside the desk is not in its ledger; sell it in your wallet.

### A held token without a sell route

When a pool is drained or delisted, Jupiter answers its quotes with HTTP 400 (for example `COULD_NOT_FIND_ANY_ROUTE`). That refusal concerns one token. It is not treated as a Jupiter outage, so it never pauses quotes, entries or exits for other tokens. (Before this fix, three refusals paused every Jupiter call for 30 s, and one rugged TEST position blocked all entries for a day.)

The position shows **NO ROUTE since …** under *Open positions*. It is re-quoted every 2 minutes, and its exit rules resume as soon as a route returns. After 30 minutes without a route:

- **TEST** books it as a SELL at zero (`WRITE-OFF`), the realistic outcome.
- **LIVE** keeps it in the ledger because the tokens stay in the wallet, but it no longer occupies a strategy slot.

### Scale-up ladder ($10 → $100 → $1K → $10K per entry)

Advisory only — the desk never changes a size by itself. A strategy shows READY for the next rung after ≥ 20 closed trades with positive net PnL, profit factor ≥ 1.3 and a max drawdown within half its sleeve. Paper fills ignore latency and MEV, so confirm with LIVE fills before sizing up real money. The next size also needs pool liquidity of about 50× the entry (≈ 2 % impact); most sub-$1M meme pools cannot absorb $1K+ orders.

### Brand-name coins

The owner, 5 Oct: "these are scam coins, not interested in trading memecoin APPLE NVIDIA, makes no sense". A coin
whose name or symbol names a real company or one of its products (desk/brands.ts: Apple, NVIDIA, Adidas, Google and
Gemini, OpenAI and ChatGPT, Anthropic and Claude, xAI and Grok, Tesla, SpaceX, Amazon, Meta, …) is skipped by every
strategy (`BRAND_NAME` on the candidate's entry note), never shortlisted by the launch radar, and never sent to the
phone, neither as a GOLDEN/OPEN alert nor as a research call or INFO (the research records stay). Common misspellings
match ("Addidas", "AAPLE"); ordinary words do not ("Finance", "Phone", "Pineapple"). That evening AAPLE AI fell −89 %
and Grok AI −98 % within a minute of a TEST entry. Positions already open keep their exit rules.

### Level 1: Solana (the Levels card, under Capital)

The owner's levels (docs/MULTICHAIN.md): master Solana first, then one chain at a time. The card scores every strategy
that is on (or has trades) on its trades **opened since the clean start, 5 Oct 21:00 UTC** (after that day's fixes),
past TEST sleeve cycles included and retired strategies left out (desk/levels.ts):
- **Trades** ≥ 100, **average net** after costs > 0, **luck p** < 0.05: the share of 4,000 resamples of the returns,
  shifted to a zero mean, whose average reaches the real one (seeded, so the same trades always give the same p).
- **Stop fills**: STOP_LOSS exits and how many points past the stop they filled on average, net of costs; within 10
  points passes. SELL ledger rows now keep the exit rule that fired (`exitReason`), so this only counts exits made
  after the 5 Oct evening deploy; no stop yet is not a fail.
- A strategy passing all four may take the LIVE step: about 20 trades at the smallest size, then the owner's go. In
  LIVE the card counts those LIVE trades. Nothing switches by itself.

### Signal tape and replay

Every scan appends the market snapshot of each pumping young pool (price, market cap, liquidity, pool age, 5m volume, buys/sells, concentration, CRASH signal) to `data-desk/tape-<MODE>.jsonl`.

```
npx tsx src/scripts/desk-replay.ts --ledger data-desk/ledger-PAPER-CRASH.json [--sizes 2,10,100,1000,10000] [--horizon-min 30]
npx tsx src/scripts/desk-replay.ts --mint <MINT> --entry-at <ISO|ms> --entry-price <USD>
```

The replay recomputes each trade from GeckoTerminal minute candles under several exit rules (current CRASH rules, no take profit, a 50 % runner, hold) and entry sizes, with a constant-product impact estimate from the pool's depth. Downloaded data is cached (`data-desk/replay-cache`), so reruns give the same numbers. Minute candles hide the order of moves inside a minute; the replay assumes losses first, so it can understate what the 2-second exit loop achieves.

### Backtest on every graduation

```
npm run desk:backtest -- --hours 12 [--size 2] [--fixed-usd 0.02] [--mints A,B] [--out backtest.json]
```

Reads every pump.fun graduation of the last hours from the chain (the whole universe, not only tokens that pumped), each pool's depth and 24 h volume (DexScreener) and its minute candles (GeckoTerminal), then applies the CRASH entry rule minute by minute and replays each entry. Every trade pays sized impact, 0.3 % venue fee per side, fixed network costs and a 3 % slippage on stop-type exits. It searches entry rules (pool age, 5-minute move, volume, market cap, pullback entry) and exit rules (stop, take profit, trailing, profit lock, hold time) and ranks them by the weaker of two time halves, so a rule that only worked in one stretch does not win. `--mints` prints, for named tokens, what the pool did and when the current and best rules would have traded. Buy/sell ratio and holder concentration are not in candles and are not modelled. Only `RPC_ENDPOINTS` is read from `.env` (through the desk allowlist); everything downloaded is cached in `data-desk/backtest-cache`.

GOLDEN POCKET has its own backtest on the same graduations:

```
npm run desk:golden -- --hours 12 [--source birdeye|gecko] [--min-volume 5000] [--mints A,B] [--cached-only] [--out golden.json]
```

It runs the break and retest and the only-up variant over a grid of pattern rules × exits (stop, trailing stop, take profit under the resistance, hold time), next to your exact rules and a baseline (every pool bought 10 minutes after graduation), ranks by the weaker time half, prints an only-up sensitivity table, and for `--mints` the pattern each rule set saw and the trade it made. Candles come from Birdeye by default (`BIRDEYE_API_KEY`, token prices in USD, one request per second, about 35 credits per token — the free plan has 30,000 a month, so a 12 h run uses most of what is left); `--source gecko` uses GeckoTerminal instead (free, but about one pool per 20 s while the desk runs on the same connection). Every download is cached and reused (`--cached-only` never downloads).

### Trade audit (2 Oct): what each TEST trade's coin did

`node logs\trade-audit.mjs` on the PC pairs every buy and sell in the TEST ledgers (current and completed sleeve cycles) and reads each coin's 1-minute chart from 4 h before the entry to 2 h after (Birdeye, cached in `logs\trade-candles`). On 72 trades (medians):

| Strategy | Trades | Bought at (× launch) | High in 60 min after entry | Low in 60 min after entry | Result |
|---|---|---|---|---|---|
| CRASH | 25 | 19× | +170 % | −96 % | +$5.73 |
| LAUNCH | 19 | 2.5× | +51 % | −49 % | −$5.14 |
| OPEN | 7 | 4.4× | +21 % | −78 % | −$11.77 |
| GOLDEN | 5 | 28× | +25 % | −99 % | −$5.69 |

Almost every coin is gone within the hour. CRASH works because its coins still run after the entry and the +100 % take profit catches some of it. GOLDEN bought sniped launches (graduated and pushed to $300K+ within seconds, 25–30× their launch) that rugged through its stop.

**Backtests now fill gapped stops realistically.** A stop crossed within a minute that closes under it sells at that minute's close (`gapFill`, the default in `desk:golden` and `desk:backtest`; `--level-fill` for the old model). Under the old model GOLDEN's only-up rule showed +7.9 % per trade; realistically it is −33 %.

**Missed: 7cYaQc… (2 Oct).** A pump.fun coin (Token-2022, no "pump" suffix) that graduated at about $45K, dipped to $32K, broke out to $81K and ran to $932K: the break and retest of the old high. The desk saw it every scan from 01:51 and filtered it for a 5-minute buy/sell ratio of 0.96–1.27 (FAIR needs 1.4, CRASH 1.3); GOLDEN was not deployed yet. The CRASH tape now also records pools that fail only the buy/sell ratio (`blockedBy: "buySellRatio"`), so that gate can be measured.

### Costs per trade (and what the desk does about them)

- **Token-account rent** (~0.0015–0.002 SOL, about 9 % of a $2 position) leaves the wallet with every first buy of a token. With the local key the desk closes the emptied account right after the exit and the rent comes back; a LIVE session also closes empty accounts left by earlier desk trades once, after its first scan. With Phantom the accounts stay open (closing them would need another approval per exit). The ledger charges the rent to the trade until it is reclaimed, so net PnL matches the wallet. TEST closes accounts on paper.
- **Exit priority fee**: at most 1 % of what the sell returns (at least 50,000 lamports, never above `MAX_PRIORITY_FEE_LAMPORTS`). Entries stay bounded by the drag budget.

### TEST sleeve cycles (no manual reset needed)

When a TEST sleeve can no longer fund an entry and holds no open position, the desk archives it as a completed cycle (`ledger-PAPER[-CRASH].cycle-<time>.json`) and re-funds it at its planned capital. Trades, realized PnL, stats, the scale ladder, the ledger view and re-entry cooldowns all continue across cycles, also after a restart. LIVE never re-funds anything: the wallet is the budget.

### Holders

Each candidate shows its holder count and the share of the 10 largest wallets; its detail view lists the largest holders (from the 20 largest token accounts) with their share of supply, marked **wallet**, **pool / curve / program** (off-curve owners such as the PumpSwap vault or the bonding curve, which are excluded from concentration) or **DEV** (the pump.fun creator), each linked to Solscan, plus links to the token on FOMO and Solscan. The largest holders are refreshed every 3 minutes for the 8 most active candidates per scan (standard RPC calls); the holder count every 10 minutes for 3 per scan, through the DAS `getTokenAccounts` method (Helius and compatible RPCs, up to 2,000 owners, shown as "2,000+" beyond). An RPC without DAS shows the count as "?" with the reason.

### Candidates

The *Candidates* table separates the scan from the strategies. The scan columns are market data, FOMO-style:

- **Age** since the token appeared (its pump.fun creation, or its oldest pool), never the age of whichever pool is deepest now; below it, *grad.* = time since its first AMM pool (graduation), or *on curve*;
- market cap, liquidity (with the quote token when it is not SOL/USD), volume 5m and 1h, transactions in the last hour (buys / sells), price change 5m, 1h, 6h, buy/sell ratio, holders, X account and followers, mint/freeze authority, risk flags.

The **Strategies** column shows every *enabled* strategy's verdict: ✓ entry-ready, or the first rule it misses. A strategy that is off says nothing, and its rules no longer appear as the token's status in the telemetry (FAIR's buy/sell ≥ 1.4 and fair-launch gates were shown as "FILTERED" for every token while FAIR was off).

Pools quoted in another token count when they hold the real liquidity: at least $20K and 5× the best SOL/USDC/USDT pool (COMMIE on 1 Oct traded against AMC with $116K; its SOL pools held $6K, so the scan dropped it).

The copycat guard (an older same-name token at least 3× bigger) now applies only when that namesake is at most 3 days older or still the busier market, and never to a launch whose own X account posted its CA. WIRED on 1 Oct was blocked by a quiet 5-day-old WIRED and then ran from $75K to $2.7M.

### Why a token was not entered

Each candidate shows, per strategy, why this scan did not enter it: held by the other strategy, re-entry cooldown, the guard's last block and when it is retried, slots in use, or an unfundable sleeve. A candidate that was not re-assessed in the last completed scan is marked **STALE** and is never traded on; held tokens and the watchlist are always assessed first (up to 120 tokens per scan). Telemetry keeps separate windows for scanner outcomes and for signals, orders, positions and PnL, so executions never scroll out behind filter messages.

### Reset TEST

With TEST stopped, **RESET TEST** archives both paper ledgers and their cycles (`ledger-PAPER*.archived-<time>*.json`, never deleted) and restarts every sleeve and its statistics at the planned capital. Each new token locks ≈ 0.002 SOL of account rent in TEST exactly as in LIVE, so small sleeves run dry after several trades; reset, or raise `DESK_PLANNED_CAPITAL_USD` / `CRASH_CAPITAL_USD` for long TEST runs (they size TEST sleeves only).

## Pipeline

`SCAN → SIGNAL → FILTERS → QUOTE → DEX / ROUTE → SIMULATION → PRE-FLIGHT → PHANTOM SIGNATURE → SUBMITTED → CONFIRMED → POSITION → EXIT → REALIZED PnL` — every stage writes a timestamped event.

- **Discovery**: DexScreener top/latest boosts and latest profiles, GeckoTerminal trending and new pools, every pump.fun → PumpSwap graduation of the last 30 minutes read from the chain (signatures of pump.fun's migration authority, ≈ 2 per minute), plus the desk watchlist. Held tokens, graduations and the watchlist are assessed first. Discovery gets 12 s per scan and GeckoTerminal-bound evidence (trade flow, launch history) 20 s; unfinished requests are cancelled, so a rate-limited provider never stretches a scan to minutes.
- **Tiers**: trending / migrated below $1M (priority below $100K); ultra-early $2K–$10K, followed on the bonding curve up to $100K. Ultra-early tokens are classified (EARLY, PROMISING, WATCH, HIGH RISK, REJECT) and are never executed until they pass every hard gate as migrated tokens.
- **Hard gates** (blocking): 5m volume > $15K, liquidity > $10K, buy/sell > 1.4, mint and freeze authority revoked, no dangerous token extensions, top-10 wallet concentration ≤ 35 %, largest wallet ≤ 10 %, liquidity ≥ 3 % of market cap, liquidity drop < 25 % since the last scan. Developer allocation (≤ 5 %) and wash/clustering (≤ `RS_MAX_WASH_RATIO`) block when known and are flagged when unknown. An UNKNOWN blocking gate keeps a token on the watchlist.
- **Fair launch** (blocking, also for the TEST drill): a pump.fun curve that graduates within 5 minutes of launch was bought out at creation, and a market cap of $250K or more within the first 5 minutes is not a fair launch. Checked once per token from GeckoTerminal pool history.
- **Momentum confirmation** (FAIR): two consecutive scans with all gates passing, acceleration ≥ 1× and a non-negative 5-minute price change.
- **Scores**: FUNDAMENTAL, SOCIAL, MARKET, ONCHAIN, RISK, MOMENTUM, each with its factors. They rank candidates; they never override a gate.
- **Evidence**: OBSERVED / DERIVED / INFERRED; missing data is shown as UNKNOWN or UNVERIFIED, never filled in.
- **Exits** (FAIR; CRASH above): checked every 5 seconds, independent of the discovery scan. Early warnings first — pool liquidity 30 % below its level at entry, or the known pump.fun creator selling — then `RS_STOP_LOSS_PCT`, `RS_TAKE_PROFIT_PCT`, trailing stop and `RS_MAX_HOLD_MIN`, valued with an executable Jupiter quote. Exits are never blocked by TEST cash or the max-drag cap; a TEST exit that cannot be simulated is booked at the executable quote.
- **History**: besides the on-screen window, every event is appended to `data-desk/events-<MODE>.log.jsonl` (rotated at 20 MB).
- **Order timing (EXEC)**: every order that reached a quote writes one `EXEC` event: milliseconds from the decision to
  the quote, the built transaction, the simulation, the pre-flight and, LIVE only, the signature request, the signature
  and the broadcast, then the end; the amount filled (or simulated) against the quote, the priority fee, and whether
  it reverted on chain. TEST stops where a signature would be asked. Shown under *Execution* in the telemetry.
- **One simulation per order**: the guard simulates the built transaction with its account checks; the executor no
  longer simulates it a second time. The rent-exempt minimums are read once per run, and the wallet is read while the
  quote is requested, not after it.
- **GeckoTerminal** allows about 30 calls a minute per PC. The desk (8 a minute), its coin check and the research
  observer's ladder (at most 10 a minute) share it: a refusal (HTTP 429) rests every caller on the PC for at least a
  minute (`data-desk/geckoterminal-rest.json`), and a request never sleeps through a long rest.

## TEST without Phantom and the TEST drill

- If Phantom is not connected, TEST uses `WALLET_PUBLIC_KEY` from `.env` to build and simulate orders. It is only an address: the private key is never read and nothing is signed. LIVE always requires Phantom.
- **TEST drill** (button next to STOP TEST, or `desk:paper --drill`): when nothing qualifies, the desk opens a paper position in the best trending candidate whose safety gates pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity > $10K). Volume, buy-pressure, concentration and momentum gates are bypassed; the execution guard (reserve, max drag, simulation) is not. Drill fills are marked `DRILL` in the ledger. The drill verifies the mechanics (position → exit → PnL); it says nothing about the strategy's edge.

## X account data

The launch radar reads X profile pages as x.com serves them to logged-out visitors (followers, account age, posts, views) without any key. For the other candidates, and for the X feed, put your own bearer token in `.env` as `X_BEARER_TOKEN`; it is read by the local server only. Without it those X metrics stay UNVERIFIED and the X feed is off. An X account older than the project is flagged (`SOCIAL AGE MISMATCH`), never rewarded.

## Headless TEST run

```
npm run desk:paper -- --address <YOUR_PUBLIC_KEY> --scans 6 --probe
```

Runs TEST on live data (both strategies; `--no-crash` / `--no-fair` to switch one off), prints telemetry, candidates, pre-flight, ledgers and strategy stats. `--probe-mint <MINT>` runs one real quote → build → simulation → pre-flight without booking. It never signs and never reads a private key.

## Known limits

- With $2 entries, the 1.5 % max drag (including 1 % slippage tolerance) blocks many meme-coin routes before a transaction is built; the reason is shown on the event. CRASH allows 5 % for exactly this reason.
- Priority fee: each order authorizes a priority-fee budget (`MAX_PRIORITY_FEE_LAMPORTS`, within the drag cap for entries) and Jupiter's `PRIORITY_LEVEL` estimate picks the actual fee inside it; the fee actually charged is measured before signing.
- `JUPITER_MAX_RPS` (default 1) is what the key allows: the free plan answers 10 requests per 10 s (measured on Raven
  on 5 Oct: `x-ratelimit-current: 10`, and 5 of 6 requests at 2 per second were refused), so a higher setting only
  produces 429s; more needs a paid plan (portal.jup.ag). Held positions are therefore not quoted at every check: the
  DexScreener price of all of them (one request) is watched, and a position is re-quoted when its last Jupiter quote is
  10 s old, when that price is within 12 points of the stop or 15 of the target, when it moved 5 % since the last quote,
  and near the time stop. An active trailing stop or profit lock, market-cap and pocket levels, scale-ins and early
  warnings are quoted at every check. Every exit is still decided and booked on an executable Jupiter quote; the
  execution path shows how many checks needed none. A pool the desk reads on-chain (GOLDEN POCKET's 4-s reserve
  samples, which cover fresh graduations and every held pool, or the curve) is watched the same way: a 5 % move or a
  price within 12 points of the stop re-quotes at once, because DexScreener lags 10–30 s on a fresh pool. One-block
  rugs still fill far past any stop (5 Oct evening: CRYPTO, Catoppy and ROOMS went from flat or up to −83…−95 % between
  two checks).
- With Phantom, empty token accounts are not closed automatically (closing needs its own Phantom signature), so their rent stays locked. With the local key they are closed after each exit (see *Costs per trade*).
- Token-account rent (≈ 0.0015–0.002 SOL per new token) stays locked after an exit until the account is closed; the desk reports it as reserved, not as a fee.
- The real Phantom signature and Auto-Confirm flow can only be verified by the wallet owner.

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

## Capital

One source (`src/desk/config.ts`, overridable in `.env`):

- `DESK_PLANNED_CAPITAL_USD` — planned starting capital, default **5.45**
- `DESK_BASE_ENTRY_USD` — base entry, default **2.00**
- `DESK_SLIPPAGE_BPS` — slippage tolerance, default 100; it counts toward max drag

Native reserve (0.003 SOL) and max drag (1.5 %) are the project's existing micro values. The actual SOL balance always comes from the connected Phantom wallet; `data/wallet-monitor.json` no longer sets a planned budget.

## Strategies (run in parallel)

| | FAIR (fair launch) | CRASH |
| --- | --- | --- |
| Idea | Fair-launch trending tokens, every hard gate, momentum in two consecutive scans | Young pools pumping right now; 1–4 minute trades targeting +40–100 % |
| Entry | QUALIFIED status (below) | One scan: pool ≤ 60 min, 5m price +10 % to +200 %, 5m volume ≥ $20K, buy/sell ≥ 1.3, ≥ 40 buys, AMM liquidity ≥ $10K and ≥ 3 % of market cap, mint + freeze authority revoked, no dangerous extensions, top-10 ≤ 50 % and largest wallet ≤ 15 % when known, liquidity not dropping. Launch fairness is shown but **not required** |
| Exits | `RS_*` rules: stop loss, take profit, trailing stop, max hold | `CRASH_EXIT_MODE=quick` (default): take profit +100 % (= $2 unrealized on a $2 entry) · profit lock: once +40 % was reached, exit 15 points below the peak · stop loss −15 % · time stop 4 min. `CRASH_EXIT_MODE=ride`: no take profit · trailing stop 35 % from the peak once +50 % was reached · stop loss −15 % · time stop 60 min |
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
- QUICK vs RIDE on the tokens seen so far (minute candles, losses assumed first): SI's second leg from $312K — QUICK +45 %, RIDE +303 %; GM from $16K — QUICK +100 %, RIDE +37 %. Neither wins every time; `desk-replay` compares both on every closed trade.
- Other CRASH settings in `.env`: `CRASH_ENABLED`, `CRASH_TAKE_PROFIT_PCT`, `CRASH_LOCK_PEAK_PCT`, `CRASH_GIVEBACK_PTS`, `CRASH_STOP_LOSS_PCT`, `CRASH_MAX_HOLD_MIN`, `CRASH_TRAIL_ACTIVATION_PCT`, `CRASH_TRAIL_STOP_PCT`, `CRASH_RIDE_MAX_HOLD_MIN`.

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

### Scale-up ladder ($10 → $100 → $1K → $10K per entry)

Advisory only — the desk never changes a size by itself. A strategy shows READY for the next rung after ≥ 20 closed trades with positive net PnL, profit factor ≥ 1.3 and a max drawdown within half its sleeve. Paper fills ignore latency and MEV, so confirm with LIVE fills before sizing up real money. The next size also needs pool liquidity of about 50× the entry (≈ 2 % impact); most sub-$1M meme pools cannot absorb $1K+ orders.

### Signal tape and replay

Every scan appends the market snapshot of each pumping young pool (price, market cap, liquidity, pool age, 5m volume, buys/sells, concentration, CRASH signal) to `data-desk/tape-<MODE>.jsonl`.

```
npx tsx src/scripts/desk-replay.ts --ledger data-desk/ledger-PAPER-CRASH.json [--sizes 2,10,100,1000,10000] [--horizon-min 30]
npx tsx src/scripts/desk-replay.ts --mint <MINT> --entry-at <ISO|ms> --entry-price <USD>
```

The replay recomputes each trade from GeckoTerminal minute candles under several exit rules (current CRASH rules, no take profit, a 50 % runner, hold) and entry sizes, with a constant-product impact estimate from the pool's depth. Downloaded data is cached (`data-desk/replay-cache`), so reruns give the same numbers. Minute candles hide the order of moves inside a minute; the replay assumes losses first, so it can understate what the 2-second exit loop achieves.

### TEST sleeve cycles (no manual reset needed)

When a TEST sleeve can no longer fund an entry and holds no open position, the desk archives it as a completed cycle (`ledger-PAPER[-CRASH].cycle-<time>.json`) and re-funds it at its planned capital. Trades, realized PnL, stats, the scale ladder, the ledger view and re-entry cooldowns all continue across cycles, also after a restart. LIVE never re-funds anything: the wallet is the budget.

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

## TEST without Phantom and the TEST drill

- If Phantom is not connected, TEST uses `WALLET_PUBLIC_KEY` from `.env` to build and simulate orders. It is only an address: the private key is never read and nothing is signed. LIVE always requires Phantom.
- **TEST drill** (button next to STOP TEST, or `desk:paper --drill`): when nothing qualifies, the desk opens a paper position in the best trending candidate whose safety gates pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity > $10K). Volume, buy-pressure, concentration and momentum gates are bypassed; the execution guard (reserve, max drag, simulation) is not. Drill fills are marked `DRILL` in the ledger. The drill verifies the mechanics (position → exit → PnL); it says nothing about the strategy's edge.

## X account data

Without X API access every X metric stays UNVERIFIED. To enable it, put your own bearer token in `.env` as `X_BEARER_TOKEN`; it is read by the local server only. An X account older than the project is flagged (`SOCIAL AGE MISMATCH`), never rewarded.

## Headless TEST run

```
npm run desk:paper -- --address <YOUR_PUBLIC_KEY> --scans 6 --probe
```

Runs TEST on live data (both strategies; `--no-crash` / `--no-fair` to switch one off), prints telemetry, candidates, pre-flight, ledgers and strategy stats. `--probe-mint <MINT>` runs one real quote → build → simulation → pre-flight without booking. It never signs and never reads a private key.

## Known limits

- With $2 entries, the 1.5 % max drag (including 1 % slippage tolerance) blocks many meme-coin routes before a transaction is built; the reason is shown on the event. CRASH allows 5 % for exactly this reason.
- Priority fee: each order authorizes a priority-fee budget (`MAX_PRIORITY_FEE_LAMPORTS`, within the drag cap for entries) and Jupiter's `PRIORITY_LEVEL` estimate picks the actual fee inside it; the fee actually charged is measured before signing.
- `JUPITER_MAX_RPS` (default 1) limits how often positions can be valued; with several open positions each check takes that many seconds.
- Empty token accounts are not closed automatically (closing needs its own Phantom signature), so their rent stays locked.
- Token-account rent (≈ 0.0015–0.002 SOL per new token) stays locked after an exit until the account is closed; the desk reports it as reserved, not as a fee.
- The real Phantom signature and Auto-Confirm flow can only be verified by the wallet owner.

# Trading desk · TEST / LIVE

The dashboard's **Trading desk** tab runs one pipeline in two environments:

| | TEST / PAPER | LIVE |
| --- | --- | --- |
| Banner | `TEST / PAPER — NO REAL TRANSACTIONS` | `LIVE — REAL FUNDS` |
| Scanner, strategy, gates, quote, route, transaction build, RPC simulation, pre-flight | same code | same code |
| Signature | never requested | Phantom, one approval per transaction |
| Fill | paper fill from the passed unsigned simulation | confirmed on-chain balance deltas |
| Ledger / telemetry | `data-desk/ledger-PAPER.json`, `events-PAPER.json` | `data-desk/ledger-LIVE-<wallet>.json`, `events-LIVE.json` |

TEST and LIVE never run at the same time and never share data. Stopping keeps all telemetry and ledgers.

## Capital

One source (`src/desk/config.ts`, overridable in `.env`):

- `DESK_PLANNED_CAPITAL_USD` — planned starting capital, default **5.45**
- `DESK_BASE_ENTRY_USD` — base entry, default **2.00**
- `DESK_SLIPPAGE_BPS` — slippage tolerance, default 100; it counts toward max drag

Native reserve (0.003 SOL) and max drag (1.5 %) are the project's existing micro values. The actual SOL balance always comes from the connected Phantom wallet; `data/wallet-monitor.json` no longer sets a planned budget.

## Pipeline

`SCAN → SIGNAL → FILTERS → QUOTE → DEX / ROUTE → SIMULATION → PRE-FLIGHT → PHANTOM SIGNATURE → SUBMITTED → CONFIRMED → POSITION → EXIT → REALIZED PnL` — every stage writes a timestamped event.

- **Discovery**: DexScreener top/latest boosts and latest profiles, GeckoTerminal trending and new pools, plus the desk watchlist.
- **Tiers**: trending / migrated below $1M (priority below $100K); ultra-early $2K–$10K, followed on the bonding curve up to $100K. Ultra-early tokens are classified (EARLY, PROMISING, WATCH, HIGH RISK, REJECT) and are never executed until they pass every hard gate as migrated tokens.
- **Hard gates** (blocking): 5m volume > $15K, liquidity > $10K, buy/sell > 1.4, mint and freeze authority revoked, no dangerous token extensions, top-10 wallet concentration ≤ 35 %, largest wallet ≤ 10 %, liquidity ≥ 3 % of market cap, liquidity drop < 25 % since the last scan. Developer allocation (≤ 5 %) and wash/clustering (≤ `RS_MAX_WASH_RATIO`) block when known and are flagged when unknown. An UNKNOWN blocking gate keeps a token on the watchlist.
- **Momentum confirmation**: two consecutive scans with all gates passing, acceleration ≥ 1× and a non-negative 5-minute price change.
- **Scores**: FUNDAMENTAL, SOCIAL, MARKET, ONCHAIN, RISK, MOMENTUM, each with its factors. They rank candidates; they never override a gate.
- **Evidence**: OBSERVED / DERIVED / INFERRED; missing data is shown as UNKNOWN or UNVERIFIED, never filled in.
- **Exits**: `RS_TAKE_PROFIT_PCT`, `RS_STOP_LOSS_PCT`, trailing stop and `RS_MAX_HOLD_MIN`, valued with an executable Jupiter quote. The max-drag cap applies to entries only.

## TEST without Phantom and the TEST drill

- If Phantom is not connected, TEST uses `WALLET_PUBLIC_KEY` from `.env` to build and simulate orders. It is only an address: the private key is never read and nothing is signed. LIVE always requires Phantom.
- **TEST drill** (button next to STOP TEST, or `desk:paper --drill`): when nothing qualifies, the desk opens a paper position in the best trending candidate whose safety gates pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity > $10K). Volume, buy-pressure, concentration and momentum gates are bypassed; the execution guard (reserve, max drag, simulation) is not. Drill fills are marked `DRILL` in the ledger. The drill verifies the mechanics (position → exit → PnL); it says nothing about the strategy's edge.

## X account data

Without X API access every X metric stays UNVERIFIED. To enable it, put your own bearer token in `.env` as `X_BEARER_TOKEN`; it is read by the local server only. An X account older than the project is flagged (`SOCIAL AGE MISMATCH`), never rewarded.

## Headless TEST run

```
npm run desk:paper -- --address <YOUR_PUBLIC_KEY> --scans 6 --probe
```

Runs TEST on live data, prints telemetry, candidates, pre-flight and ledger. `--probe-mint <MINT>` runs one real quote → build → simulation → pre-flight without booking. It never signs and never reads a private key.

## Known limits

- With $2 entries, the 1.5 % max drag (including 1 % slippage tolerance) blocks many meme-coin routes before a transaction is built; the reason is shown on the event.
- Token-account rent (≈ 0.0015–0.002 SOL per new token) stays locked after an exit until the account is closed; the desk reports it as reserved, not as a fee.
- The real Phantom signature and Auto-Confirm flow can only be verified by the wallet owner.

# Market-data integration

Implemented on `codex/market-data-integration`, based on `f8666bc`. This branch also contains the previous local dashboard and isolated playbook changes. No dependency, database server, background process, portfolio migration, strategy weight, entry-score threshold, or risk-limit change is required.

## Architecture audit and baseline

The audit covered package/lock/configuration files, PM2, the entry point, core engine/portfolio/risk/journal, RPC failover, all executors, analysis helpers, both strategies, and utilities. Main was checked through GitHub: `package.json` was readable, while the three imported provider modules and `src/data` were absent. This was not inferred from a failed authentication request.

Before implementation, both `npm run typecheck` and `npm run build` exited with code 2. `TS2307` reported missing DexScreener, GeckoTerminal and Raydium modules. Dependent strategy expressions also produced implicit-any/property errors. These were pre-existing failures.

Principal defects found:

| Finding | Treatment |
| --- | --- |
| Missing provider implementations | Added compatible clients with runtime schemas |
| Missing values coerced to zero; FDV substituted for market cap | Nullable measurements; market cap required for cap filters |
| Unordered/gapped/partial candle history | Explicit milliseconds, sorted closed candles, gap list, partial list |
| Weak Jupiter response checks; invalid impact treated as zero | Validated identity, units, route, impact, slippage and issuance age |
| Reusing the first quote after paper re-quote failure | Strict fresh re-quote is the default |
| Roundtrip ignores both slippage bounds and refreshed entry edge | Minimum-output sizing of both legs, capped costs and execution-time check |
| Quote outage writes a position off after 30 misses | Retain it, record missed valuation, block new entries until valued |
| Stale USD price retained for support exit | Clear before management; use the position's original pool; quote exits first |
| Timeout races still-running scan | Cooperative abort; do not reschedule before the original work settles |
| Concurrent strategies can pass risk check before either books | Serialize risk-check, buy and booking; never bypass RiskManager |
| Rent inspection can overlap a new buy | Shared entry/maintenance exclusion plus open/in-flight mint exclusion |
| LP outage creates estimated fees across an unobserved gap | No accrual for missing intervals; retain unvalued paper positions |
| Confirmed transaction missing metadata booked as quote minimum | Return unknown execution status for reconciliation |
| Unsafe integer balances / unverified token-account owner | Validate safe integers, exact raw strings and ownership before use |
| Authenticated URLs in upstream errors | Central logger/journal/history redaction |

Implementation order was: audit and contract map → common transport/cache/health/storage → three provider clients → quality/quote/strategy integration → deterministic tests and public smoke validation → operational documentation and delivery. This keeps external-data normalization outside strategy scoring and transaction signing.

## Integration map and preserved methods

| Provider | Preserved calls | Consumer and purpose |
| --- | --- | --- |
| DexScreener | `getLatestBoostedTokens`, `getTopBoostedTokens`, `getLatestProfiles` | Reversal discovery; lists are discovery provenance, never bullish confirmations |
| DexScreener | `getPairsForTokens`, static `bestPairPerToken` | Reversal prefilter and price monitoring; batches of at most 30 mints |
| GeckoTerminal | `getTrendingPools`, `getNewPools` | Shared discovery for Reversal and SUTR |
| GeckoTerminal | `getOhlcv`, `getTrades` | Compatible wrappers; Reversal uses enriched `getOhlcvSeries` and `getTradeEvents` |
| GeckoTerminal | New `getPool` | Same-pool reconciliation immediately before a Reversal entry |
| Raydium | `listPools`, `getPoolsByIds` | SUTR paper LP selection and valuation; CLMM and stable curves excluded from x·y=k model |
| Jupiter | `quote`, `buildSwap`, static impact/route helpers | Quote-based valuation and executors; analytical caches cannot authorize execution |
| Solana RPC | Existing `ConnectionManager.execute` and confirmation stack | Mint/security checks, wallet/token balances, rent recovery and transaction settlement |
| RPC data adapter | `verifyMint`, `walletBalance`, `poolAccount`, `recentActivity` | Read-only typed inspection using the same ConnectionManager |

Provider HTTP → source limiter + shared priority gate → bounded transport → Zod validation → normalized observation → cache/history → quality assessment → existing analysis/score → fresh safety/quote checks → RiskManager → executor → journal/history.

Signing remains exclusively in the existing live execution path. Historical replay imports no wallet, provider client or executor. RPC adapter methods do not discover an off-chain wallet application's private watchlist.

## Observations and selection

`data-types.ts` defines TokenIdentity, PoolIdentity, MarketSnapshot, LiquiditySnapshot, OHLCVSeries, TradeEvent, WalletActivity, TokenSafetyResult, ExecutableQuote and DataSourceStatus. Every enriched market observation carries schema version, source, network, source timestamp (nullable), receipt timestamp, token mint, pool address, freshness/validation state and warnings. `dexSnapshot` and `geckoSnapshot` expose a common market model. Read-only executable-quote history explicitly sets `executionAuthorized: false`.

All time-series timestamps are Unix **milliseconds**. RPC activity retains the RPC field name `blockTime` in seconds; it is nullable. A candle's source time for freshness is its completed interval end. Pool creation time is not a price timestamp. Dex/Ray/Gecko snapshots generally lack an exchange observation timestamp: their `sourceAt` is null and freshness is **unknown**, even on a cache miss. Receipt-age gates cannot establish upstream freshness; the final executable quote remains essential.

Token identity is its full mint. A pool is its full address plus ordered base/quote mints. Symbols are display labels. Analytical selection requires a supported quote mint, positive known price/liquidity, known pool creation time, recent transaction activity and receipt age within the configured price limit. Choose greatest reported liquidity among eligible pools, with address as a deterministic tie-breaker. Strategy-specific pool-age/liquidity/cap filters still apply. Selected and rejected alternatives are recorded.

Reversal compares Dex and Gecko only for the **same pool and ordered mint pair**. Price differences above 20% or liquidity differences above 50% of the larger observation block a new entry by default; both tolerances are configurable data gates, not score bonuses. Prices are not averaged. Overlapping volume figures are not added. Market cap and FDV stay separate. A provider's zero liquidity is distinct from missing liquidity, but both prevent entry.

OHLCV uses explicit token mint and USD currency, removes identical duplicate intervals, rejects conflicting duplicates/invalid high-low relationships, detects gaps without interpolation, and excludes partial candles from indicators. No fabricated empty candles are inserted. Trade-event IDs deduplicate trades; multiple events in one transaction remain distinct. Buy/sell direction follows the requested mint's from/to flow, not a ticker or blindly trusted provider label.

## Strategy behavior

Reversal retains Support 25, Momentum 20, Exhaustion 10, Volume 20 and Accumulation 25, and all existing strategy settings. Data-quality rejection is separate from that score. Required closed history, gaps, candle age, recent trade evidence, wallet address availability, same-pool consistency and fresh on-chain safety are checked. At least 60 completed 5-minute candles remain required. Smart-money/organic-volume labels are heuristic classifications, not proof of economic ownership, organic demand or wallet profitability. Trades are a provider-limited sample (up to 300); the code does not claim exhaustive coverage.

SUTR discovery rejects unknown reserve, volume and pool age. A roundtrip estimates the buy's minimum tokens, quotes selling that quantity, then uses the sell's minimum SOL proceeds. It subtracts two base fees and two configured maximum priority fees, plus account-close base and priority fees when rent recovery is enabled, otherwise unrecovered ATA rent. Swap fees are already in Jupiter output and are not double-counted. The final executor buy quote must pass a new sell-quote edge check. Both legs remain **non-atomic**: a profitable estimate is not a guaranteed profit, and the second leg can fail or move adversely. Existing position-management loops retry independently of discovery.

LP remains paper-only in both execution modes, with existing fee/IL formulas, maximum holding period and exit conditions. Missing updates do not add fees or simulate a sale. The first update after an outage also accrues no gap fees. A valid continuous interval is capped at the configured LP cadence. Maximum-hold/price exits are evaluated once a valid valuation is available. The static hypothetical hedge excludes funding, borrow availability, short-sale execution, rebalancing, hedging fees and transaction costs; it does not represent an executable delta-neutral product.

Quotes are fetched independently, validated against the exact request and tracked by object issuance and fingerprint. Copies from cache/history, altered objects and stale quotes fail execution checks. Freshness is checked before swap-build requests, signing and initial sending. Rebroadcast/confirmation of an already-submitted transaction retains the existing sender behavior. Missing transaction metadata is unknown, not a measured fill. Existing reconstructed-buy accounting remains explicitly estimated/tagged; it blocks further entries pending reconciliation.

## Scheduling, cache and storage

| Category | Default local TTL | Use |
| --- | ---: | --- |
| Discovery | 60 s | Listings and pool rankings shared between strategies |
| Analysis | 15 s | Market snapshots, candles and recent trades |
| Position | 3 s | Active-pool monitoring |
| Execution | None | Jupiter quote/build; never analytical cache authorization |
| History | Append only | Signal inputs, decisions, quotes, health and trade results |

Existing TokenBucket limiters implement per-source pacing. Defaults are conservative: Dex 1 request/s (including its 60/min discovery endpoints), Gecko 8/min, Raydium 1/s; Jupiter and RPC retain their own configured limits. These are local settings, not an assertion of a purchased plan's quota. HTTP timeout defaults to 10 s with two retries, exponential jitter, Retry-After pauses and source cooldown after repeated failures. Invalid schemas/401/403 do not retry. Four active HTTP slots are allowed; ordinary work uses at most three, leaving capacity for position/execution requests. Priority does not preempt an already-running request or remove provider rate limits. Pending HTTP jobs are capped at 256; response bodies at 8 MiB; cache entries at 500. Abort signals stop pending HTTP work after task deadlines. Existing RPC calls have their existing timeouts/failover and may take longer to settle; the engine will not overlap the same task to compensate.

JSONL fits the existing journal deployment and avoids native database dependencies. A single PM2 writer appends to `STATE_DIR/market-history/market-{SIMULATION|LIVE}-*.jsonl`. History records have version, id, mode, receipt time, kind, source and redacted payload. Bigints serialize as decimal strings. Defaults: seven days and 128 MiB per mode, segments up to 8 MiB, individual records up to 2 MiB, pending records up to 500. Cleanup runs at segment rollover, at least every minute during writing, and on flush; the budget may be exceeded temporarily between cleanup passes. Dropped/failed history records are counted and visible, never substituted into portfolio state. Cache/history never overwrites portfolio checkpoints.

Replay is a bounded-file offline inspection stream with a receipt-time cutoff. It has no execution capability and does **not** claim to be a complete strategy backtester or a model of historical market impact. Gaps and dropped records limit reproducibility. Keep PM2 at one instance and give each independent process its own state directory. Existing journal retention remains a separate operational responsibility.

## Failure policy and observability

| Condition | Category / action |
| --- | --- |
| HTTP 5xx, timeout/network failure | Transient; bounded retries, then cooldown |
| HTTP 429 | Rate-limited; respect Retry-After and provider limiter |
| HTTP 401/403 | Configuration; no retry; check credentials/plan |
| JSON/schema/address/OHLC/negative values/conflicting events | Invalid response; reject observation |
| Old/future timestamps or elapsed receipt age | Stale/invalid data; block affected new entry |
| Missing history, liquidity, reserve or required wallet evidence | Explicit quality reason; no numeric substitute |
| RPC unavailable | Unavailable verification; no entry |
| Confirmed wrong owner/mint/program | On-chain verification failure |
| Quote identity/impact/minimum/age mismatch | Critical execution data; no trade authorization |
| Provider disagreement | Recorded same-pool quality rejection |

Existing Logger records source, latency, retry, failure category and cache outcome. Heartbeat includes per-source health, scan durations and dropped-history count. Journal and history record decisions and trade results. Auth headers, key-like fields and URL paths/queries are redacted. No raw upstream error body or signing transaction is persisted. Do not paste arbitrary bare credentials into log messages; redaction recognizes fields, assignments and URLs, not every possible secret string.

## Operations

Use Node 22.12+ for a shared bot/dashboard installation. Keep `.env`, wallet keys and state private. Install this feature branch in a separate checkout first if your Windows working tree contains newer uncommitted telemetry changes. Do not overwrite that tree with a source ZIP. The branch includes earlier local dashboard/playbook commits and must be reviewed as a whole relative to main.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run data:check
```

`data:check` only calls public discovery APIs; no wallet is loaded or transaction built. `npm test` uses deterministic synthetic fixtures strictly within tests and requires no funds or API keys. Configure the existing required `RPC_ENDPOINTS` and Jupiter API key separately. Root bootstrap still expects its existing wallet configuration, even in simulation; the isolated playbook has its own wallet-free paper profile. Root startup verifies mainnet genesis because these market providers describe mainnet. The simulation engine requires configured reachable RPC and Jupiter services; successful public smoke checks alone do not validate execution or profitability.

```bash
# .env: SIMULATION_MODE=true; existing RISK_*, RS_* and SUTR_* stay unchanged
npm start
# Later, inspect retained observations up to an explicit receipt time:
npm run data:replay -- ./data/market-history SIMULATION 2026-09-28T12:00:00Z
```

For PM2 use the existing single-instance `ecosystem.config.js` after a simulation review. The implementation does not start, reload or deploy a VPS. To roll back, stop the process, restore the previous code, retain portfolio/journal files, rebuild and restart with the same mode. The portfolio format is unchanged. History is optional and can be disabled without deleting authoritative state.

Troubleshooting:

- `SOURCE_TIMESTAMP_UNAVAILABLE`: the provider did not supply market observation time. This is not fixed by inventing a timestamp.
- `MISSING_CANDLES` / `INSUFFICIENT_CANDLES`: inspect the recorded series; low-activity pools often lack complete history. No entry is expected.
- `UNKNOWN_MARKET_CAP`: FDV cannot establish circulating market cap. Discovery can succeed while the cap filter blocks entry.
- 429/cooldown: reduce scans or request rates; inspect provider health. Raising concurrency will not raise your provider quota.
- Jupiter quote expired: rate-limiter/route/RPC delays consumed the quote budget. A later fresh attempt can retry; do not reuse the rejected quote.
- Position valuation misses: position remains managed and blocks new entries. Restore routing/RPC service and inspect its balance; a quote outage alone is not a writeoff.
- LP valuation unavailable: fees freeze and the paper position remains open until a valid observation returns.
- Empty dashboard fields: the market-data history is not a fabricated dashboard feed. The existing dashboard shows measured checkpoint/native telemetry; root history does not synthesize tick observations or USD equity for fields the engine has not produced.

## Primary API references (checked 2026-09-28)

- [DexScreener API reference](https://docs.dexscreener.com/api/reference): discovery and batched Solana token pairs.
- [GeckoTerminal API](https://api.geckoterminal.com/docs/index.html): mainnet pool discovery, token-specific OHLCV and trade data. Public endpoints have upstream caching; polling faster cannot guarantee fresher observations.
- [Raydium official SDK API implementation](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/api/api.ts), [URLs](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/api/url.ts), [types](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/api/type.ts): `/pools/info/list-v2` with `size`, `sortField`, `sortType`, `hasReward`, and `/pools/info/ids`.
- [Jupiter Metis get quote](https://developers.jup.ag/docs/swap/v1/get-quote): `outAmount` includes swap fees but not slippage; `otherAmountThreshold` is the minimum. Jupiter now describes Metis v1 as superseded by Swap V2. This change deliberately retains the existing v1 executor contract. A v2 migration needs separate execution testing.
- [Solana RPC](https://solana.com/docs/rpc): existing web3 ConnectionManager remains the sole RPC transport.

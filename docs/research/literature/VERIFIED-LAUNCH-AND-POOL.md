# Verified-coin INFO: a launch-size filter and a liquidity-pool check (owner, 5 Oct)

The owner likes the verified-coin INFO (`verified.ts`: Jupiter blue check, ≥ $1M market cap, ≥ $100K liquidity,
up ≥ 15 % in the hour). Two requests:

1. **Do not show coins that *launched* above $100K market cap.** The owner's view: runners launch normally, around
   $0–10K.
2. **A liquidity-pool check.**

Both are filters on an INFO (not a call), so they can go on the phone now. Recording continues for every coin
(`VT`), so the effect of the filter can be measured.

## 1. Launch size

New feature `launchMcapUsd`, the coin's market cap when it first traded:
- **pump.fun coins** (mint ending in `pump`, or a `PC`/`C` record in the ledger): the curve start, ≈ 28 SOL (about
  $3–4K). Below $100K by construction.
- **other coins:** the open of the first candle of the main pool. The fundamentals layer already reads pool candles
  from GeckoTerminal for the old-high study (`fundamentals/history.ts`). It is fetched once per coin and cached. It
  is a fact about the past, so there is no look-ahead.
- **unknown** when no candle can be read. An unknown coin is shown with "launch size unknown", never dropped
  silently.

Phone rule: no verified INFO when `launchMcapUsd` > $100K.

| # | Hypothesis | Test | Passes if |
| --- | --- | --- | --- |
| V-L | Verified movers that launched small (≤ $100K) beat those that launched big | every `VINFO` flag after 5 Oct 20:00 UTC, priced from `VT` at +1 h, +24 h and +7 d (flag ledger, `FRES`) | ≥ 30 flags per group; the small-launch group's +24 h mean after costs is higher, and the 90 % bootstrap interval of the difference is above 0 |

## 2. Liquidity-pool check (at the alert; everything from data the alert already reads or `VT` history)

| Check | Rule | Source |
| --- | --- | --- |
| Depth against size | liquidity ≥ 5 % of market cap (warn below 5 %, block below 2 %) | the alert's own numbers |
| Liquidity trend | warn if liquidity fell ≥ 30 % over 24 h or ≥ 15 % over 1 h (WWW on the watchlist: −31 %/24 h) | earlier `VT` records |
| Sell depth | the price impact of a $500 sell from a Jupiter quote: warn > 5 %, block > 15 % | one quote per alert |
| Pool split | the main pool holds ≥ 70 % of all the coin's liquidity; otherwise warn ("liquidity split across N pools") | DexScreener pairs (already read by the desk) |
| Quote token | SOL, USDC or USDT; otherwise warn | DexScreener pair |
| LP tokens | burned or locked ≥ 90 %, if RugCheck reports it; unknown is shown as unknown, never as safe | RugCheck, through `fundamentals/scanner.ts`. The mapping for LP status must be added, and the field must be confirmed in RugCheck's report first |

The alert carries one line: "pool OK" or the warnings, for example "pool: liq 4 % of mcap · −32 % in 24 h". A block
removes it from the phone, and the coin is still recorded.

| # | Hypothesis | Test | Passes if |
| --- | --- | --- | --- |
| PL | Verified movers with a clean pool check beat those with warnings | as V-L, split by pool check | as V-L |

## For the CTO

- `launchMcapUsd`, with its cache and the phone rule;
- the pool-check line and its two blocks;
- the LP-status mapping in `scanner.ts`, after confirming RugCheck's field.

Everything stays recorded in `VT`/`VINFO` with the new fields, so V-L and PL can be judged on later flags.

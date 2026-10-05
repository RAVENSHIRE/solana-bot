# Technical-analysis layer: show the first candles, set the stop at the previous resistance (owner, 5 Oct)

Owner: "If you could really see the first candle, you wouldn't invest. Better work on a technical-analysis layer where
the stop is always set to the previous resistance."

Two parts: **what the alert shows** (the owner's eye) and **where the stop goes** (a testable rule). Both run on the
minute candles the desk already has:
- launches: the curve's `K` records and raw trades;
- graduated pools: the golden tracker's pool candles;
- verified coins: GeckoTerminal candles through `fundamentals/market.ts`.

## Definitions (point in time: only candles complete by the decision time T)

- **Swing high:** a minute whose high is above the highs of the minute before and the minute after. It is confirmed
  only when the minute after has closed, so it is known one minute late, never earlier.
- **Previous resistance `R`:** the most recent confirmed swing high that a later candle *closed* above (a broken
  resistance), and that lies below the price at T. If there is none, there is no structural stop.
- **Structural stop:** `R × (1 − 3 %)`. **Stop distance:** `(entry − stop) / entry`.
- **Target:** the next confirmed swing high above the entry, or 2× the stop distance (2R) if there is none.
- **First-candle features:** `firstX` = first minute's high ÷ its open; `firstWick` = (high − close) ÷ (high − open),
  how much of the first minute's rise was given back.
- **Volatility:** `range5` = (highest high − lowest low) ÷ last close over the last 5 complete minutes.

## Alert text (no rule needed: the owner sees the chart in words)

Two lines added to OPEN, INFO, GOLDEN and verified alerts:

```
1st min $3.2K→$15.0K (×4.7, gave back 62 %) · 5 min range 140 %  ▁▃█▅▂
stop $11.8K (prev. resistance $12.2K, −21 %) · target $19.5K (+32 %)
```

If there is no previous resistance, the second line says "no structure yet: no stop level". That is a warning in
itself.

## Pre-registered (5 Oct ~20:30 UTC, before any TA data is scored)

Each test keeps the **same entries** and changes only the stop. The difference measures stop placement and nothing
else. Entries: `sprintBroad@60s`, `organicX@120s`, F1a's INFO entries, and P2's GOLDEN entries (when those exist).
All at phone fill (+45 s) and bot fill (+2 s).

| # | Hypothesis | Test | Passes if |
| --- | --- | --- | --- |
| TA1 | **A stop at the previous resistance beats a fixed stop.** Structural stop and target, 60 min max, against each entry group's fixed exit | same entries, both exits, costs as the gate | the structural exit's later mean after costs is higher in ≥ 3 of the 4 groups, and positive in at least one under the gate's rules (Holm, ≥ 100 trades) |
| TA2 | **Skip trades whose structure is too far away.** Entries with a stop distance > 25 % (or no structure) are not taken | TA1's entries, with and without the skip | the kept trades' mean is higher than all trades' mean, and the skipped group's mean is negative |
| TA3 | **A first candle that gave back most of its rise is a warning.** `firstWick` ≥ 0.5 as an exclusion | launch entries (sprint, organic, F1a) | the excluded group's later mean is below the kept group's, on ≥ 50 trades each |

**Thresholds** (3 % buffer, 25 % maximum distance, 0.5 wick, 2R) are fixed here and do not move after scoring.

## Why this fits the desk's evidence

- The losers so far came from **gaps through fixed stops**: GOLDEN's −57 % live and the −91 % TEST trade. A
  structural stop does not stop a one-block rug either. TA2 is what helps against that: it skips entries where the
  nearest structure is far below.
- CRWLR fell −47 % before running 4× (`CASE-2026-10-05-CRWLR.md`). A fixed −20 % stop sold it. Whether the previous
  resistance was below that dip is exactly what TA1 measures.
- GOLDEN already sets levels from its own pattern (`POCKET_STOP`, `RESISTANCE_TARGET` in `strategies.ts`). The TA
  layer generalises that to every strategy.

## For the CTO

- one pure function `structure(candles, T)` returning `R`, the stop, the target, `firstX`, `firstWick` and `range5`,
  with a test that live and backtest give the same values;
- the two alert lines;
- the TA1–TA3 variants in the qualification run.

## Owner's case, 5 Oct: `8nPoBHiBM6pybxMws9PA2JRb9BjkppBfqcZGmot4DMBC`, a range after a run

Owner: launched 4 Oct 22:30, ran to $2.1M, then from about 01:15 on 5 Oct held a **range of $500–800K** without
breaking it. "The longer it holds, the more likely the upside." I could not check the chart: the price sources are
blocked in this session.

**Why Raven sent no INFO, from the code:**
- correction (owner, 5 Oct): it **is** a pump.fun coin ("Human", Team Human), even though the address does not end
  in `pump`, so a missing `pump` suffix proves nothing. More likely, **the observer was not running**: the
  owner's INFO list has no INFO at all between 4 Oct 00:44 and 5 Oct 08:57 UTC, and the launch at 22:30 on 4 Oct
  falls inside that gap. The case extract (whether a `PC` record exists for this mint) would confirm it. A launch
  INFO also needs the project's own account to post the CA;
- the verified-coin INFO needs ≥ $1M market cap, a Jupiter check, a place on Jupiter's trending/organic/traded lists
  (or the watchlist), **and** +15 % in the hour. A coin ranging at $500–800K fails on market cap and on movement.

A quiet range is exactly what no current alert looks for.

| # | Hypothesis | Definition (point in time) | Test | Passes if |
| --- | --- | --- | --- | --- |
| TA4 | **A long range after a run breaks upward more often, the longer it holds.** Coins that ran ≥ 3× from launch and then traded in a band whose high is ≤ 1.8× its low (here $500–800K = 1.6×) for ≥ 4 h | hourly candles complete by T; the band is defined by the last 4 h, and it stays a band while no hourly close leaves it | on the ladder's coins (`research:fundamentals`, all chains), when the band breaks: up (a close above the band) against down. Split by how long the band held: 4–8 h, 8–24 h, > 24 h | the share of upward breaks rises with duration and is above 50 % for > 8 h, on ≥ 50 bands per bucket |
| TA4-trade | Buy the first hourly close above the band; stop below the band's high (the old resistance, as in TA1); target the run's high | as TA4 | phone fill, costs as the gate | the standard gate on ≥ 100 trades |

If TA4 holds, a **RANGE** alert ("held $500–800K for 14 h; broke out at $830K; stop $760K") follows as a separate,
switchable phone alert for coins between $100K and $10M. Until then, coins like this one go on the watchlist by hand
and are flagged with a date (`FLAG-LEDGER.md`).

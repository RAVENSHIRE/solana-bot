# MAYHEM: a strategy for pump.fun's mayhem-mode launches (owner, 5 Oct)

Owner: "coins in mayhem mode seem to always run, and they are already scanned very early: create a new strategy."
Two of the owner's INFO cases on 5 Oct were mayhem coins (@Teemlings, 298 buyers at 6 min; @spcxbar, 534 buyers at
9.5 min, graduated).

## Why the desk cannot judge mayhem coins today

- Every research rule excludes them (`qualify.ts`: `!l.mayhem`; `rules.ts`: `sprint` requires `mayhem !== true`).
- Their price is computed from the curve's virtual reserves, which do not follow the trades in mayhem mode
  (`dataset.ts`). The INFO text therefore prints "$0.0K (0 SOL)".
- How mayhem mode works is not documented in this repository, and pump.fun's pages are blocked from this session.
  So nothing below assumes anything about its mechanics.

**What is valid in mayhem mode:** each trade record (`T`) carries the SOL paid (`lamports`) and the tokens received.
`lamports / tokens` is the price the trade actually got. A price path built from trades works without the
reserves. Multiples relative to the entry need no supply figure.

**Limit:** raw trades are kept for each launch's first 10 minutes (1 h for curves past 25 %). Minute candles come
from the reserves and are not valid for mayhem. A trade-price label therefore covers 10 min, up to 60 min for curves
that pass 25 %, until the observer keeps mayhem trades longer.

## First look (owner runs it; not yet run)

The command in the owner's reply compares **every** mayhem launch with a 1-in-20 sample of normal launches. For both
it uses trade prices, a decision at +60 s and a phone fill at +105 s. It reports which came first: 2× or ½ of the
entry price, within the kept trade window. "Always runs" becomes a rate.

## Pre-registered (5 Oct, before any mayhem data is scored)

| # | Rule | Decision | Entry | Exits (fixed) | Judged on |
| --- | --- | --- | --- | --- | --- |
| M1 | **Every mayhem launch** (PumpPortal `mayhem` = 1 at creation) | +60 s | phone fill (+45 s), at the highest trade price in the fill window | +100 % target, −35 % stop, 10 min max, all on **trade prices** | launches created after 5 Oct 16:00 UTC; the standard gate; Holm family |
| M2 | M1 with breadth: ≥ 30 buyers and top wallet < 20 % at +60 s (buyer counts and shares come from trades, which stay valid in mayhem) | as M1 | as M1 | as M1 | as M1 |

**Code for the CTO:**
- a trade-price path for mayhem launches in `direct.ts`;
- keep mayhem trades for 60 min;
- add both groups to the catalog.

The two of the owner's 5 Oct mayhem cases above are known cases and are excluded.

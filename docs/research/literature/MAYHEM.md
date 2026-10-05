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

## First look, result (owner's run, 5 Oct)

| | Launches | 2× first | ½ first | Neither | Graduated |
| --- | --- | --- | --- | --- | --- |
| **Mayhem (all)** | 7,618 | 539 (7 %) | 4,661 (**61 %**) | 2,418 | 333 (4 %) |
| Normal (1 in 20 sample) | 1,029 | 53 (5 %) | 108 (10 %) | 868 | 22 (2 %) |

The prices are trade prices, the decision at +60 s, the fill at +105 s, and the window is the kept raw trades (10–60
min).

- **Mayhem does not "always run".** It halves first six times as often as a normal launch. It is far more volatile,
  not better.
- It reaches 2× slightly more often (7 % against 5 %) and graduates twice as often (4 % against 2 %). The mayhem
  winners the owner sees are real; they are 7 % of a very large group. Mayhem is about **27 % of all launches**
  (7,618 against ~20,600 normal, from the 1-in-20 sample).
- **A rough expectation for M1** (my approximation, not a simulation): 7 % reach +100 % (≈ +90 % net), at least 61 %
  hit the −35 % stop (≈ −40 % net with gaps), and the rest end flat (≈ −7.5 % costs). That comes to about
  **−20 % per trade**. M1 as registered will very likely fail. It stays registered so that it is judged rather than
  argued.
- Caveat: how trade prices behave in mayhem mode is not documented here. If some mayhem trades are protocol trades
  at off-market prices, both rates move. The CTO should check what mayhem trades are before relying on these numbers.
- **The useful split is breadth (M2) and graduation.** The owner's two mayhem cases had 298 and 534 buyers. The
  command for M2 is in the owner's reply. A mayhem coin that graduates belongs to F1b/G1 (pool prices, gate gap 5).

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

## Diagnostic (owner's run, 5 Oct): one wallet dominates mayhem launches

21,165 mayhem launches had buys within 60 s.

| Measure at +60 s | Value |
| --- | --- |
| buyers | median 3, 90th percentile 9, max 52 |
| top wallet's share of SOL bought | 10th percentile 0.64, median 0.66, 90th percentile 0.78 |
| most frequent top buyer | `BwWK17…de6s`: top buyer in **12,302** launches (58 %) |
| next | `3xtyS7…M6uc` 534 · `K6Eh9f…KHnR` 452 · `4UKLdT…hSiP` 316 · `HuBZkw…pb3S` 262 |

- **M2 as registered cannot match anything.** One wallet buys about two thirds of the first minute in most mayhem
  launches, so "top wallet < 20 %" never holds. The zero is the rule's fault, not the data's.
- `BwWK17…de6s` looks like mayhem mode's own trading wallet. That is an inference: the code does not say, and
  pump.fun's pages are blocked here. The other frequent wallets look like sniper bots that buy hundreds of launches.
- **M1's 61 % "halved first" includes this wallet's trades.** They are real executions, so a holder really sees
  those prices. But it means mayhem prices move with one actor, not with a crowd.
- **The same bots distort normal launches too.** `top1`, `hhi` and `effectiveBuyers` count a bot that buys hundreds of
  launches the same as a real buyer.

## Pre-registered after the diagnostic (5 Oct ~17:00 UTC; the thresholds come from the buyer distribution above, not from outcomes)

| # | Rule | Definition (no look-ahead) | Decision | Exits | Judged on |
| --- | --- | --- | --- | --- | --- |
| M2b | Mayhem with a real crowd | a frozen list **R**: wallets that were the top buyer in ≥ 100 launches before 5 Oct 17:00 UTC. At +120 s: ≥ 10 buyers not in R, and the largest buyer not in R < 30 % of the SOL bought by non-R wallets | +120 s, phone fill +45 s | as M1, on trade prices | mayhem launches after 5 Oct 17:00 UTC |
| B1 | Bot-free breadth for normal launches | new features `buyersExR`, `top1ExR`: the same as `buyers` and `top1` with R's wallets removed (point-in-time: R frozen at a date, judged after it). `broad15` rebuilt on them | as `broad15` | as `broad15` | normal launches after the freeze |

M2 stays registered as it was and fails by construction; it is not edited.

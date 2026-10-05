# Case, 5 Oct: "Using" (`6MLPGnAi8HHMKwB9oap28HCRXXEgmZhP9iSLoKpdpump`), a tweet coin the broad rules caught

Source: the owner's ledger extract (launch index 1086), pasted on 5 Oct ("great for automated system"). It is a
known case: it suggests hypotheses and never counts as evidence for them.

## Timeline (UTC; seconds after creation)

| Time | +s | Ledger |
| --- | --- | --- |
| 12:47:41 | −60 | the X **post** that the metadata links (`x.com/i/status/2107090348535337173`; the time comes from the post id) |
| 12:48:42 | 0 | creation "Using" / USING: **dev buy 1.98 SOL** (66.4M tokens, about 6.6 % of supply). No X account (the link is a post), no website |
| 12:48:47 | +5 | 12 buyers, top wallet **46 %** (the dev), 3 effective buyers, curve 16 % |
| 12:48:57 | +15 | 31 buyers, top 13 %, **dev already sold**, curve 34 % |
| 12:49:12 | +30 | 57 buyers, top 6 %, 27 effective, curve 50 %, 71 SOL |
| 12:49:42 | +60 | 101 buyers, 45 effective, curve 66 % (a sprint: 66 % of the curve per minute), 105 SOL |
| 12:50 | | dip: 137 → low 97 SOL (−29 %), sells 62 SOL against 64 SOL bought |
| 12:50:42 | +120 | 165 buyers, 58 effective, curve 81 %, 176 SOL |
| 12:51–12:52 | | 150 → 334 SOL |
| 12:53:12 | **+271** | graduated (pump-amm) at 411 SOL |
| 12:54:57 | | `sprint@60s` judged: **+8.2 % net** (trailing exit), entry 121 SOL, exit 141 SOL, peak +45.6 % |

Over the extract: 675 buys and 531 sells.

## What it shows

1. **The broad rules matched, and the "quality" filters excluded it.** `all`, `buyers5`, `broad15` and the sprints
   matched. `organic` and R2 require `devSold` false, and `ownX` requires an X account; both would have skipped it.
   The dev sold within 15 s, and the crowd carried the coin to graduation anyway. That is one case against the
   dev-sold filter. It is a reason to test the filter, not to drop it.
2. **At phone speed it was a win the gate can see.** It took 4.5 min to graduate, longer than Web's 56 s, so the
   rules decided at 60–120 s were holding before graduation. `sprint@60s` netted +8.2 % (trailing exit), giving
   back most of a +45.6 % peak. For `broad15@120s` the fill (+166 s) lands in the 12:51 minute (low 133, high
   261 SOL) before graduation at 411. The result depends on the trade order inside that minute (the −20 % stop
   against the +100 % target). Its `RES` is not in the extract: either it was not judged yet when the extract ran
   (holds end at about 13:06), or its judging was lost. The CTO should check which.
3. **A tweet coin.** The metadata links a *post*, not an account, posted 60 s before creation. Someone launched a
   coin on a fresh tweet within a minute. The desk reads that link as "no X" (`hasX` false), so this information is
   thrown away, although it costs nothing to compute: the post id carries its own time.

## New features (computable at creation, no network)

- `xLinkKind`: ACCOUNT / STATUS / COMMUNITY / NONE, from the metadata's X link (`parseXLink` already tells them apart).
- `xStatusAgeS`: for a STATUS link, the creation time minus the post time decoded from its id (`snowflakeMs`).
- `sameStatusRank`: how many earlier launches in the ledger linked the same post id (`META` records observed
  before this creation). 0 = the first launch on that tweet.

## Hypotheses

| # | Hypothesis | Decision / features | Exits | Passes if | Data / cost |
| --- | --- | --- | --- | --- | --- |
| T1 | **Fresh tweet coins with broad buying beat other broad launches**: `xLinkKind` = STATUS · `xStatusAgeS` ≤ 300 · `effectiveBuyers` ≥ 25 · `top1` < 0.15 | 60 and 120 s | `EXITS` and the sprint exits | the standard gate; and above `broad15` at the same delay | three cheap features from data already recorded; a live-parity test |
| T2 | **The first launch on a tweet beats its copies**: T1 split by `sameStatusRank` = 0 against ≥ 1 | as T1 | as T1 | the rank-0 group's later mean is higher on ≥ 50 trades each | as T1 |
| D1 | **An early dev sell is not a rug sign when the crowd is already broad**: among `broad15` at 60 s, `devSold` true (sold by T) against false | 60 s | as `broad15` | if the dev-sold half is not worse, relax the `devSold` filter in `organic` (pre-registered as a new group, not an edit) | none new |

Graduation timing: Web graduated in 56 s and Using in 271 s. G1's "≤ 180 s" would include Web and exclude Using.
Decision (main session, 5 Oct): both were pre-registered at 13:05 UTC, G1 (≤ 180 s) and G1b (≤ 300 s), as separate
rules in the Holm family. See the README.

# INFO scorecard, first look (owner's run, 5 Oct ~14:20 UTC)

Source: the owner ran the INFO one-liner over the whole observer ledger (2 Oct 20:56 → 5 Oct 14:17 UTC) and pasted
the output. **243 INFO flags.** For each flag the script took its market cap at the INFO and the curve's minute candles
from 45 s after the INFO up to 6 h, and recorded:
- which came first, the price at 2× or at ½ (when both happen inside one minute candle, ½ is counted first);
- whether the coin graduated within 6 h.

Prices stop at graduation, because the pool is not observed (gate gap 5). This is a description, **not a trade
simulation**: no costs, no stops, a 6 h window rather than F1a's 30 min.

| Market cap at INFO | Flags | 2× first | ½ first | Neither (no trades after) | Graduated ≤ 6 h |
| --- | --- | --- | --- | --- | --- |
| all | 243 | 19 % | 19 % | 62 % (35) | 12 % |
| < 40 SOL (curve start) | 118 | 11 % | 1 % | 88 % (34) | 1 % |
| 40–80 SOL | 65 | 29 % | 22 % | 49 % (1) | 2 % |
| 80–160 SOL | 36 | 33 % | 61 % | 6 % | 31 % |
| 160–300 SOL | 16 | 19 % | 50 % | 31 % | 50 % |
| ≥ 300 SOL (at graduation) | 8 | 0 % | 0 % | 100 % | 100 % |

| Followers at INFO | Flags | 2× first | ½ first | Graduated |
| --- | --- | --- | --- | --- |
| < 100 | 210 | 21 % | 19 % | 13 % |
| 100–999 | 18 | 6 % | 17 % | 6 % |
| ≥ 1,000 | 15 | 13 % | 20 % | 7 % |

## Reading

1. **Why the phone's INFO messages "only show rugs".** Half of all INFO flags (118) fire at the very start of the
   curve. 88 % of those never reach either 2× or ½ within 6 h, and 34 never traded again. They are mostly dead
   launches with a paid check.
2. **Almost every INFO passes on a paid check.** Nearly all flags carry the "individual" (paid blue) check, and 210
   of 243 accounts have under 100 followers. Reach does not help: ≥ 1,000 followers did no better. This agrees with
   the owner's point that a CA post alone is no safe signal.
3. **The middle band is where things happen.** At 40–160 SOL at the INFO, 2× comes first about a third of the time.
   Halving first is also common (22 % and 61 %), and above 80 SOL a third graduate, which is F1b's ground.
4. **This data has now been seen.** The bands above were chosen after looking. They suggest a rule; they are not
   evidence for it. A market-cap band for INFO can only be judged on INFO flags **after 5 Oct 14:17 UTC**.

## Pre-registered from this look (5 Oct, before any later data)

| # | Rule | Judged on |
| --- | --- | --- |
| F1c | F1a restricted to an INFO market cap of 40–160 SOL (exits as F1a: +100 %, −35 %, 30 min; phone fill 45 s) | INFO flags after 5 Oct 14:17 UTC only; the standard gate, Holm family |

## For the CTO

- **INFO has no dashboard switch.** It comes from the research observer, not the desk. It goes to the phone unless
  the observer runs with `--no-phone`, so the owner cannot see it or turn it off on the dashboard.
- **Proposal:** an INFO switch in the Phone panel and an INFO list on the dashboard. Until F1a or F1c passes, drop
  INFO flags under 40 SOL from the phone; keep recording them.

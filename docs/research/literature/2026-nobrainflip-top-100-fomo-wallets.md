# @nobrainflip: "I analyzed the 100 most profitable on-chain traders. Here is what the winners do differently"

- **Citation:** @nobrainflip (display name "Cyclops"; Telegram t.me/cyclopalpha), X article, 3 Oct 2026, 20:31 UTC.
  https://x.com/nobrainflip/status/2106482349839876484 (article id 2106440702749974528).
- **How it was read:** the owner fetched the full article JSON through `api.fxtwitter.com` on 5 Oct and pasted it
  here, because this cloud session cannot reach X. The six images (charts) were not visible, so only the text is used.
- **Author and incentives:** 544,991 followers, blue check (individual). The author reports $170K profit in 3 months
  ($210K → $385K). Every wallet link in the article carries the author's FOMO referral (`r=nobrainflip`), the article
  offers a fee-discount code, and "Part 2" is held back for the author's Telegram. **A practitioner post with a sales
  motive, not a study.**

## Question, data, method

- **Question:** what separates the top of FOMO's PnL leaderboard (insiders, devs, bots, luck, or habits)?
- **Data:** FOMO's leaderboard, the top 100 wallets by all-time PnL, $141M combined. PnL is computed on-chain and
  **combines realised and unrealised** profit. Per wallet: PnL, volume, trades, holdings, followers. Period: all-time,
  as of about 1–3 Oct 2026. Chains are not stated (FOMO is mostly Solana).
- **Method:** descriptive buckets (per-trade PnL by trade count, by followers, by number of coins held), plus a manual
  read of a few trade histories ("2 days and 100 wallets"). No statistics beyond one correlation, and no comparison
  group.

## Key results, as stated

1. 100 wallets, +$141M; 50 above $1M, 16 above $2M; the top 10 hold 32 % of the total.
2. **Trades:** median 1,373 per wallet (range 36 to 7,760). PnL per trade: under 300 trades **$4,162**; 300–2,000
   **$1,036**; over 2,000 **$417**. The author puts the cost of each trade (fees + slippage) at **2–6 %**.
3. **Followers:** followers and PnL correlate, but 17 of the 100 have under 10K followers ($11.4M together). PnL per
   trade: under 10K followers **$2,791**; 10K–100K **$789**; over 100K **$462**. The author's explanation: a big buy
   moves the price, and "when 2,000 people copy an entry, the entry runs, and the exit gets sold into them".
4. **Inside one top wallet (#4, DumbCrayonEater, $4.37M):** last 30 closed trades 8 wins, 22 losses (**27 % win
   rate**), **median hold 37 days**. One closed trade ($ANSEM, bought at 11 days old, held 90 days) made $843K.
   **$3.58M of the $4.37M (82 %) is one unsold position in $AI.**
5. **Holdings:** median 25 tokens. More coins goes with less per trade (correlation **−0.25**).
6. **Who they are:** a quarter hold an unsold winner; 18 "churned their way in"; the rest trade little, hold long,
   keep one big position and sell part of it.
7. **Nine "quiet" wallets** (under 20K followers, over $2,000 per trade, PnL 20–100 % of volume): end837, TheOldNite,
   tremendoustoad, LehmanFarters, dtrainz, kingofgotham, spartee, TheDazzleNovak, justtesting. These are FOMO profile
   names, not wallet addresses.

## Critical reading

- **Chosen on the outcome.** Only winners were sampled. "Fewer trades, more per trade" is partly arithmetic: in a
  list ranked by total PnL, a wallet with few trades can only get in with large profits per trade. Wallets with few
  trades that lost money are not in the sample. Whether trading less *causes* better results cannot be read from
  this.
- **Unrealised PnL.** At least one top-10 rank is 82 % an open position. A leaderboard number can halve without one
  trade being made.
- **No base rate.** Nothing on how many FOMO wallets that trade the same way lose.
- **What still holds up:** the cost argument (every trade pays fees and slippage) and the copy-trading argument (a
  public entry that many followers copy gets sold into them). Both are mechanisms the desk can measure.

## Transfer to Raven ($2 trades, pump.fun and established coins, 2026)

- **Costs.** The desk's own cost model makes the point harder than the article: at $2, 1.25 % per side plus a $0.10
  fixed cost is **~7.5 % per round trip** (`research-qualify.ts:23`, `direct.ts`). That is above the author's 2–6 %.
  Every additional rule match is a new 7.5 % hurdle, so the gate should reward fewer, better trades, which it
  partly does by requiring an average profit after costs.
- **Holding period.** The top wallet's edge was months-long holds of a few winners, with 27 % of trades winning.
  The desk's exits are 1 to 60 minutes. These are different games. For the owner's "established coins" target, the
  relevant tests are E1/E2 in `NARRATIVE-REGIME.md` with **7- and 30-day** horizons, not minutes.
- **Wallets, not only voices.** The observer already records the buying wallet of every pump.fun trade (`T`
  records). A list of tracked wallets turns "follow quiet winners" into a feature the desk can compute with no new
  data feed, as long as those wallets trade on pump.fun curves.

## Pre-registered hypotheses

| # | Hypothesis | Features / new feature | Decision | Gate | Value | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Launches bought early by a tracked "quiet" wallet beat the rest. New feature `trackedBuyers(T)`: distinct wallets from `data-desk/research/wallets.json` with a buy in `T` records observed by T | `trackedBuyers ≥ 1`, at 30, 60 and 120 s; entry priced after the desk's latency, so it is never at the wallet's own price | 30–120 s | the standard gate (≥ 100 later trades, mean after costs > 0), and above `all` at the same delay | high | low: the feature reads existing `T` records. The wallet addresses must be copied by hand from the FOMO profiles |
| W2 | Copy-trade exit liquidity: coins whose first tracked buyer has over 100K followers do worse after our read than coins whose first tracked buyer has under 20K | `trackedBuyers` split by the follower count recorded in `wallets.json` | 60–120 s | the < 20K group's later mean is above the > 100K group's, on ≥ 50 trades each | medium | low once W1 exists |
| W3 | On established coins, holding long beats taking profit fast | E1 entries, exits at +7 d and +30 d against +40 % and +100 % targets | `VT` check | the long-hold exit has the higher later mean after costs on ≥ 30 entries | medium | low: horizons only. Results need 30+ days of data |

## What the owner can supply

For W1, the **wallet addresses** behind the nine quiet profiles and the top 10. FOMO profiles need a login for the
API (`docs/RESEARCH.md`: the FOMO token expired), so the owner copies them from the app into
`data-desk/research/wallets.json` as `[{ "wallet", "fomo", "followers", "addedAt" }]`.

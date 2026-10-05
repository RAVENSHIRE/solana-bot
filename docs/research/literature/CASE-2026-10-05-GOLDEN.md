# Case, 5 Oct: GOLDEN POCKET alerts on rugs that open at $1M+ (`CTi9vcLMLZ8vVHgavYKkg61t6sRieaQE2dXVPsVpump`)

Owner, 5 Oct: "Golden pocket always sends rug tokens with 1mio plus first candle." The alert:
"Only up · first 2 candles only up to $5.25M → back to $5.26M, within 12 % of candle 2 ($5.25M), stop $4.99M",
known at 13:07:57 UTC, evidence `al_1302f2d0…`, data UNKNOWN, with no market cap, liquidity or volume.

## What the code shows (base branch, read 5 Oct)

1. **GOLDEN POCKET is OFF as a strategy for good reason.** `config.ts` records −33 % per trade in the backtest once
   gapped stops sell at the minute's close, and **−57 % on its first 5 live TEST trades** ("rugs fall through the stop
   in seconds"). Its alerts still reach the phone because the `golden` switch is on: the phone switches or
   `DESK_ALERTS`. The default is none (`engine.ts`, `DEFAULT_ALERTS`).
2. **The alert does not say it is not a call.** OPEN alerts carry "Not a qualified call…". The GOLDEN alert
   (`engine.ts`, `alertOnce('golden:…')`) does not, so a strategy that lost 57 % live reads like a buy signal.
3. **No market-cap sanity check.** `GOLDEN_RULES.floorUsd` is 0 and there is no ceiling. A pump.fun curve graduates
   near 411 SOL (the 5 Oct ledger cases), about $48K at the desk's default $118/SOL. A pool printing **$5.25M in its
   first two minutes is about 100× the graduation value**. That is either a manipulated pool or a wrong supply or
   quote in the candle source. Neither should reach the phone.
4. **"Back to" is not a pullback.** In `onlyUpStep` (`golden-pocket.ts`) the entry fills when any later minute's
   *low* is within 12 % above candle 2's close, at `min(limit, open)`. A third minute that opens at the close of
   candle 2 fills at once, which is what happened here ($5.25M → "back to" $5.26M). The pattern buys the third minute
   of a vertical move with no dip, the exact spot where a rug team sells.
5. **The evidence line is empty here too**, as for OPEN (`FLAG-LEDGER.md`, quick win 4): the alert comes from the
   golden tracker, not a scored candidate.

## Recommendations

- **Now (owner):** switch GOLDEN off the phone (dashboard Phone switches, or remove `golden` from `DESK_ALERTS`).
  It is a strategy that is off and lost live; its alerts are noise until something qualifies it.
- **For the CTO, if GOLDEN alerts are kept:**
  - a ceiling: no alert when the first pool candle's market cap exceeds 10× the graduation market cap (≈ $500K);
  - the "Not a qualified call" line;
  - the market cap and liquidity in the evidence.

  None of this makes GOLDEN profitable. It only stops the worst alerts.

## Hypothesis

| # | Hypothesis | Feature (no look-ahead) | Decision | Passes if | Cost |
| --- | --- | --- | --- | --- | --- |
| P1 | **A pool that opens far above its graduation value is a rug.** New feature `poolJumpX`: the high of the first pool minute divided by the graduation market cap (the last curve state before the `X` record) | at the G1 decision point, after the first pool minute | as an exclusion on G1: G1 with `poolJumpX` ≥ 10 removed beats G1, and the excluded group's +1 h mean is below −50 % on ≥ 30 cases | needs pool prices (gate gap 5), like G1 |

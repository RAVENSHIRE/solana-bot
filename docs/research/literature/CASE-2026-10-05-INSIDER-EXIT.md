# Case, 5 Oct: an insider-exit "RUG" on a runner (`26ZixeXtGBQe3DBrN4448oZaY5rnhwPrZNhAjZPopump`)

Owner, 5 Oct: "no rug but runner". The desk's alert at 15:30:35 UTC: "RUG insiders sold: they hold 1.4 % (was 63.2 %
at entry)". At that moment: market cap $65.1K, liquidity $21.7K, 5-minute volume $51.1K, **5 minutes +29 %**, data
DEGRADED (13). The ledger extract for this coin has not been pasted yet. It is a known case.

## What the code does (base branch, `src/desk/launch-risk.ts`, `engine.ts`)

- `insiderExit` sells a held curve position as soon as insiders (the creator and wallets in the creation slot or the
  next one) have sold **≥ 25 % of what they held at entry**, and at least 1 point of supply. It calls that "RUG",
  **whatever the price is doing**.
- `RISK.maxInsiderPctAtEntry` is 50: a curve "mostly in insider hands" is never bought. **This position had 63.2 %
  at entry.**

## Findings

1. **Selling into strength is not a rug.** Here the insiders distributed 98 % of their tokens while the price rose
   29 % in 5 minutes on $51K of volume. Buyers absorbed it. The rule cannot tell that apart from a dump, so it sells
   runners exactly when the supply overhang is gone. That is arguably the best moment to hold.
2. **63.2 % at entry, against a 50 % entry limit.** Either the position was not opened through the guarded entry (a
   WATCH position bought in Phantom, for example), or the insider share measured at entry differs from the one the
   entry check used. The CTO should check which. If it was a desk entry, the limit did not hold.
3. **The label.** "RUG" on a coin up 29 % reads as a false alarm, which is how the owner read it. "Insiders exited"
   with the price change would be accurate.

## Hypothesis

| # | Hypothesis | Test | Passes if | Cost |
| --- | --- | --- | --- | --- |
| X9 | **An insider exit is only a sell signal when the price confirms it.** When `insiderExit` fires, compare selling then against holding until the price is ≥ 15 % below its value at the exit signal, or 30 min, whichever first | every insider-exit event the desk recorded (TEST and LIVE), joined to the ledger's curve candles | holding with the price condition beats selling at once, after costs, on ≥ 30 events; the 63 %→1 % "distribution into demand" events are reported apart | the desk's exit events joined to the ledger: a script for the CTO |

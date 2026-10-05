# Flag ledger: every flag is a research point

Owner's idea, 3 Oct: the desk's own ledgers are the research source. Every coin the desk or the owner flags
(the FOMO watchlist, the phone's INFO messages, the test ledger) is followed forward and scored, the same way a rule
is. Example: **AGENCY**, `7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump`, was flagged and the owner reports it is now
near a $2M market cap.

This page adapts that idea to what the code already records. It needs no outside website: it runs on the observer's
ledger.

## What one winner can and cannot tell us

AGENCY at $2M shows that flags *can* find runners. It does not show that flagging *works*. That depends on the
denominator: how many flags of the same kind went to zero. The desk has been burnt by this before.
`src/research/curiosity/cases.ts` lists three rules written from one memorable coin (OPEN from FIX6900, GOLDEN POCKET
from 66hK2, LAUNCH from Meme Industries), and each failed in TEST. So the flag ledger scores **every** flag of a
kind, not only the ones we remember. A single case stays a *known case*: a story that suggests a hypothesis, and
evidence for none.

Not checked here: I could not confirm the $2M figure. This session's network blocks DexScreener, GeckoTerminal and
Jupiter. The figure is the owner's.

## What the ledger already records, and what it misses

| Flag source | Record today | Price followed afterwards? | Gap |
| --- | --- | --- | --- |
| Rule signals (shadow and qualified) | `SIG`, judged later as `RES` | yes: `RES` net % after the hold | none: this is the model to copy |
| Launch INFO (project posted its own CA, checkmark or ≥ 1,000 followers) | `INFO` (`calls.ts:103`) | only on the curve, up to graduation; the pool afterwards is not observed (`docs/RESEARCH.md`) | **no forward judge.** Also, `xRead` returns before recording when the phone is off (`calls.ts:81`, `!this.d.notify`) or past 8 per hour (`calls.ts:84`), so flags that were never sent leave no record. The denominator is then wrong in both cases |
| Verified coin moving (Jupiter blue check) | `VINFO`; every check also writes `VT` (price, market cap, liquidity, holders) | yes in raw form: `VT` every 5 min for as long as the coin stays on the lists or the watchlist | no forward label computed. A coin that drops off Jupiter's lists stops being priced (a survivor bias) |
| Owner's FOMO watchlist | `watch-tokens.json` (`mint`, `note`) | yes, through `VT` with check `W` | **no time and no price at the moment of the flag.** The ledger cannot say "flagged at $X on day D", so no return can be measured from the flag |
| Known cases | `curiosity/cases.ts` | not applicable | AGENCY's mint is `null` there. The test fixture (`tests/research.test.ts:48`) already holds it together with the @tryagency post |

## The design

1. **One flag record for every source.** `FLAG obs, m, source (INFO / VINFO / WATCH / OWNER / CASE), reason, market
   cap $ and price $ at obs, {facts at obs}`. It is written **whether or not the phone is on and whether or not the
   hourly cap was hit**: the cap limits messages, not records.
2. **The watchlist gets a timestamp.** A watchlist entry becomes `{ mint, note, addedAt, by }`. The observer writes
   `FLAG source=WATCH` the first time it sees a new mint, priced at that check. Entries without `addedAt` count from
   when they were first seen, never from earlier.
3. **A forward judge for flags, like `RES` for rules.** At +1 h, +6 h, +24 h and +7 d after the flag:
   `FRES obs, m, source, horizon, return %, max multiple, max drawdown %, rugged (−80 % from the flag), still priced
   0/1`. Prices come from `VT` while the coin is listed. After graduation or after the coin leaves the lists, they
   come from the fundamentals layer (`src/research/fundamentals/market.ts`, DexScreener and GeckoTerminal). A price
   that cannot be found is **unknown, not zero and not a win**, the same rule `history.ts` uses for censored
   horizons.
4. **Each source is a group in the gate.** Same tuning and validation split and the same costs as the rules, and
   the same "≥ 30 live results, no average loss" check. "Owner's eye" (OWNER and WATCH flags) then becomes a rule
   the gate can qualify, or reject, like any other. Cost note: price the trade at the flag's market cap plus the
   desk's latency. You cannot buy at the price you saw when you flagged.
5. **The report shows the whole distribution per source:** flags, % reaching 2× / 10×, % rugged, median return, and
   the return with the best flag removed. If one AGENCY makes up the whole average, the report says so. The
   platform already has `knownCaseDependence` (`backtest/analysis.ts:203`) for this.

## Pre-registered hypotheses from the flag ledger

Each one is judged on flags recorded **after** the record type ships. Nothing before that counts, and AGENCY itself
is excluded as a known case.

| # | Hypothesis | Test | Passes if | Value | Cost |
| --- | --- | --- | --- | --- | --- |
| F1 | Launch INFO flags (the project's own account posts its CA) beat every normal launch bought at the same delay | `FRES` +1 h and +24 h for INFO against `RES` of the `all` group at the same age, after costs | ≥ 100 INFO flags, mean after costs > 0, mean above the baseline, and true without the best 2 % of flags | high: the observer's best story (AGENCY) | medium: FLAG/FRES records plus post-graduation pricing |
| F2 | The INFO follower bar (1,000) is too high. Accounts with 300–999 followers that post their own CA do as well. The AGENCY fixture records @tryagency at 677 followers, which would not have triggered INFO under today's rule | record shadow flags for 300–999 followers (no phone message) and compare their `FRES` with the ≥ 1,000 flags | the shadow band's +24 h mean after costs is ≥ 0 and not lower than the ≥ 1,000 band, on ≥ 100 flags each | high | low: one more shadow source |
| F3 | The owner's watchlist flags (FOMO blue check) beat Jupiter-verified movers (VINFO) | `FRES` +24 h and +7 d, WATCH against VINFO | ≥ 30 WATCH flags (a small, slow source), mean after costs > 0 with a bootstrap 90 % interval above 0, and above VINFO | medium: it measures the owner's eye | low once `addedAt` exists |

## Quick wins for the CTO (code, not done here: this branch is documentation only)

1. `curiosity/cases.ts`: set AGENCY's `mint` to `7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump`. Source: the owner, 3 Oct,
   and the @tryagency post in `tests/research.test.ts:48`. Until this is set, AGENCY is not excluded from
   experiments as a known case.
2. `calls.ts` `xRead`: write the `INFO` record before the phone check and the hourly cap, with `sent 0/1`, as `SIG`
   already does.
3. `watch-tokens.json`: add `addedAt`.

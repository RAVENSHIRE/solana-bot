# Strategy review: which strategies work, could work or fail, and why (5 Oct)

Owner, 5 Oct: "Check all strategies; find out which are or could work and which don't. For the good ones improve
the win rate; for the others find out why they fail."

Sources:
- the desk's own records in the code and docs: `src/desk/config.ts` strategy summaries, `docs/DESK.md` backtests,
  TEST records and the alert audit of 1–2 Oct;
- the main session's gate runs;
- the owner's pastes of 5 Oct (OPEN card, INFO scorecard, mayhem run).

**FAIR's results are not in the repository.** Its strategy card would fill that row.

## Correction, 5 Oct 18:28 UTC (CTO, desk fix 6b89637)

The insider and creator exits ("RUG insiders sold", "DEV_SELLING") compared the holdings after the buy with the share
measured **at the launch**, often long before the entry. 189 such exits happened in TEST, 139 of them within 30 s
of the buy.

Trades cut within 60 s of the entry, per strategy:

| Strategy | Trades cut | Net of those trades | Strategy net |
| --- | --- | --- | --- |
| LAUNCH | 65 of 91 | −$30.92 | −$49.88 |
| CRASH_V1 | 23 of 57 | | |
| MIGRATION2 | 14 of 72 | −$2.88 | −$37.26 |
| OPEN | 14 of 69 | −$8.25 | −$113.06 |
| GOLDEN | 10 of 28 | −$2.14 | −$18.90 |
| CRASH | 9 of 92 | −$2.90 | +$4.95 |
| FAIR | 6 of 45 | | |

A second fix in the same commit: custom strategies lost about half their signals before 18:03 UTC on 5 Oct.

Effect on the verdicts below:
- **OPEN, MIGRATION and GOLDEN still fail for the reasons given.** The bug explains only a small part of their losses.
- **LAUNCH's TEST record is mostly the bug.** Its strategy verdict becomes **unknown until new trades after the fix**.
  The alert audit of 1–2 Oct (23 of 23 entry-ready coins dead or −70 % within an hour) measured prices after the
  alerts, not exits, so it still stands for the alert.
- CRASH's record is slightly understated (9 of 92 cut).
- C1–C4 and MG1–MG3 only count trades after 5 Oct 21:00 UTC, which is after the fix. No pre-registration changes.

## Verdict per strategy

| Strategy | Status | Evidence | Verdict |
| --- | --- | --- | --- |
| **CRASH** (young pools pumping, ≤ 10 min) | TEST | backtest +24.3 %/trade on 36 trades, but out of ~12,000 combinations (optimistic). **TEST 1–5 Oct: 88 trades, +3.8 % avg, median −18 %, 39 % won, luck p = 0.23** | **Could work: the best candidate.** Positive, but not yet distinguishable from luck |
| **CRASH_70K** (CRASH at ≥ $70K and pool ≥ 5 min) | TEST from 5 Oct | in CRASH's own trades: +15.6 % (40) against −6.1 % (48). Found in those trades, so only trades from 5 Oct count | **Could work** if its new trades confirm it |
| **GOLDEN** (graduated pools, only-up) | OFF | backtest −33 %/trade once gapped stops sell at the minute's close; −57 % on 5 live TEST trades; a TEST trade on 5 Oct sold at −91 % after a large gain | **Fails as is. Could work narrowly**: three owner cases fit P2 (pool opens ≤ 3× its graduation value), with a take profit (exits b/c) |
| **OPEN** (opening breakout) | OFF | TEST: **58 trades, 2 % won, −66.8 % avg, PF 0.12**; earlier 7 of 7 lost; alert audit 59 of 65 dead or −70 % within an hour | **Fails. Retire it.** |
| **LAUNCH** (radar: own X + site) | TEST | not backtested; audit 23 of 23 entry-ready dead or −70 % within an hour; −22 % with OPEN-like exits, +8–9 % with a trailing stop carried by two outliers | **Fails as an alert** (audit). **The strategy itself is unknown** until there are trades after the 5 Oct fix (its TEST record was mostly the stale-baseline exit bug). Its good part, a project posting its CA, is measured more cleanly by INFO F1a/F1c |
| **MIGRATION** (custom: graduations $60–300K in their first hour, Vol/MC > 30 %, holders, no whale; trail 30 % from 2×, stop −50 %, 3 days) | TEST | owner's card, 5 Oct: **66 trades, 24 % won, −16.4 % avg, PF 0.61**, best +542.3 %, worst −99.3 %, average hold 698 s, realised −$21.73 | **Fails today, but has real upside.** The single +542 % trade is worth about +$10.8. Without it the other 65 average about −25 %. The losers are the problem: a −50 % stop that rugs gap through to −99 % |
| **FAIR** (fair launch, two-scan momentum) | ON | no record in the repository | **Unknown**: paste its card |
| MIGRATION · CONSOL · SCALP · RUNNER presets | custom, TEST | not backtested | **Unknown.** CONSOL and RUNNER are the owner's range idea: test them through TA4 |
| Research gate rules (42) | shadow | 0 of 42 qualify. Best: organicX@120 s −0.9 %; R1 undecided (needs ~13 days); R2 failed; sprintBroad@60 s −3.6 % | **None works yet** |
| INFO (project posts its CA) | alert | 243 flags: under 40 SOL 88 % go nowhere; 40–160 SOL about a third reach 2× first | **Could work in the 40–160 SOL band** (F1c, judged on new flags) |
| MAYHEM | idea | 7,618 launches: 7 % reach 2× first, **61 % halve first**; one wallet tops 58 % of them | **Fails as "buy every mayhem coin"** (≈ −20 %/trade). M2b (crowd without that wallet) is open |

## Why the failing strategies fail: five causes, in order of the money lost

1. **They buy the top of the spike.** "Most of the spike happens inside the minute the alert goes out: bought at
   that minute's high, every exit loses" (alert audit, `DESK.md`). OPEN buys at its opening high × 1.3, LAUNCH after
   the spike, and GOLDEN on the third minute of a vertical move with no real dip.
2. **Stops gap.** A rug falls through the stop between two checks. CRASH's −35 % stop filled at **−56 %** on average
   (36 trades). GOLDEN's 5 % stop filled at about −57 %, and one TEST trade at −91 %.
3. **Stops sit far away.** OPEN's stop is the $6.7K floor, ≥ 48 % below a ≥ $13K entry, with `stopLossPct` 85 and no
   trailing exit before 6× (`holdUntilMultiple`). Every normal loss is −50 % or worse, so it needs about one trade in
   three to triple; it got 1 in 58.
4. **No take profit on coins that decay in minutes.** GOLDEN and OPEN ride a trailing stop with no fixed exit, so a
   one-block rug takes the whole gain back.
5. **The data hides part of the picture.**
   - Bots inflate or concentrate buyer counts (one wallet in 12,302 launches; B1).
   - Prices after graduation are not observed (gate gap 5).
   - The observer was down ~32 h without an alert (gate gap 6).
   - A CA on its own line is missed (`xCaPost` bug).

## Raising the win rate of the ones that could work (pre-registered; only trades after 5 Oct 21:00 UTC count)

| # | For | Change | Why it should raise the win rate |
| --- | --- | --- | --- |
| C1 | CRASH | **TA2**: skip the entry when the structural stop (previous resistance −3 %) is more than 25 % below the entry, or there is no structure | removes the trades whose loss is far and gappy, which today fill at −56 % |
| C2 | CRASH | **TA1**: stop at the previous resistance −3 % in place of −35 % fixed; target unchanged (+100 %, 10 min) | a nearer, structural stop loses less per loser. Whether it gets shaken out more is the test |
| C3 | CRASH | B1: buy/sell ratio and buy count without the frozen bot list (R) | stops bots from passing the "≥ 40 buys, buy/sell ≥ 1.3" gate |
| C4 | CRASH_70K | unchanged, judged on its own trades from 5 Oct | confirms or kills the one filter found so far |
| G-b/c | GOLDEN | P2 filter (pool opens ≤ 3× graduation value) with exits (b) +100 % take profit or (c) half at +100 % | the three 5 Oct cases: sane openers ran and 100× openers rugged. The take profit locks the gain before a rug |
| MG1 | MIGRATION | **TA2**: skip entries whose structural stop is > 25 % below, or with no structure | the losers are wide and gappy (−50 % stop, −99 % worst). Skipping far-structure entries cuts them, and the trailing exit still rides the winners |
| MG2 | MIGRATION | sell **half at 2×**, the rest on the 30 % trail as now | banks part of each runner before a one-block rug. The +542 % kind of trade still keeps half its run |
| MG3 | MIGRATION | P1 ceiling: skip pools whose first minute opened ≥ 3× the graduation value | the 100× openers were rugs (GOLDEN cases) |
| F1c | INFO | 40–160 SOL band, 30 min, +100 %/−35 % | the band where 2× comes first about a third of the time |

The CRASH variants run in TEST beside CRASH on the same signals, like CRASH_70K. Each needs ≥ 100 trades and the
luck test before LIVE.

## Retire or keep off

- **OPEN:** off and retired. Its useful idea, the fast opener, lives in the gate's sprint rules with fast exits.
- **LAUNCH:** keep it in TEST at most. Its phone alert stays off. Its signal (own CA post) is measured by F1a/F1c.
- **GOLDEN:** off and off the phone until P2 passes.
- **MAYHEM M1:** registered, expected to fail. Only M2b stays open.

## For the CTO, in order

1. **TA1/TA2** (`TA-LAYER.md`): one shared function `structure(candles, T)` for live and backtest, then C1/C2 as
   TEST variants of CRASH.
2. Retire OPEN, and put GOLDEN's 10× ceiling and P2 shadow records in place.
3. The dead-man alert for the observer (gate gap 6), and post-graduation pool prices (gate gap 5).
4. B1: the frozen bot list R and the bot-free breadth features.
5. Paste or export FAIR's and the presets' TEST cards, so their rows above stop being "unknown".

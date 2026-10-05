# Case, 5 Oct: CRWLR (`CACje8roivFzn8e9j3LU1hr4bvR87stmaS6AiVCnpump`), an INFO at $12K that ran

Source: the owner's ledger extract (launch indexes 200, then 42 and 569 in later hourly files), pasted on 5 Oct.
The owner: "called at 12k", "70k". The INFO was sent at 99.6 SOL, which is $11.8K at the desk's default $118/SOL. The
$70K is after graduation on the pool and is not in the ledger. It is a known case: it suggests hypotheses, never
evidence.

## Timeline (UTC; + after creation)

| Time | + | Ledger |
| --- | --- | --- |
| 12:26:53 | 0 | created: **dev buy 3.95 SOL (12.5 % of supply)**; X @crwlronsol, crwlr.fun, Telegram; description "an autonomous AI-powered indexing system that ingests real-time X data and evaluates newly launched tokens on pump.fun" (AI-agent narrative) |
| 12:27:14 | +21 s | X read: paid blue check (individual), **2 followers**, 0 posts, account **2.4 h old** |
| 12:27:36 | +43 s | @crwlronsol posts "ca:" followed by this address on a new line |
| 12:26–12:28 | | first minutes: high 99 SOL, back to 56–76, then 120 |
| 12:28:24 | +91 s | **OPEN alert to the phone** (the owner's "called at 12K"): "$9.0K → $13.5K in 91 s (×1.5); $10.1K open → low $8.8K → $13.5K: broke above the opening high; **insiders hold 39.2 %: dev 12.5 % + 3 wallets in the creation slot**"; data UNKNOWN (the empty evidence line, FLAG-LEDGER quick win 4) |
| 12:29:32 | +2.7 min | **INFO sent** at 99.6 SOL (own CA post, blue check) |
| 12:31 | | low **53 SOL** (−47 % from the INFO) |
| 12:44 | | 197 SOL; the 15-min rule exits at TIME, +27 % at best, −14 % for 60 s entries |
| 12:48 | | low 81 SOL |
| 13:22 | | 283 SOL (2.8× the INFO) |
| 13:39:38 | +72.7 min | **graduated** (411 SOL, 4.1× the INFO), then the pool (owner: $70K) |

Over the extract: 2,009 buys and 1,460 sells. The project posted a 50M-token Streamflow lock at 12:35:53 (read at 12:42).

## What it shows

1. **The phone got OPEN first (12:28:24, $13.5K), then INFO (12:29:32, $11.8K).** OPEN is the path that lost all
   7 TEST trades. INFO came through a project account posting its own CA with a paid check (2 followers), the same
   path as Web. **The insider line was a bundle warning that did not come true here.** Three wallets bought in the
   creation slot (about 27 %, plus the dev's 12.5 %), and the coin still ran 4×. That is one counterexample to H3
   (bundles mark rugs), not a refutation. The owner sends the winners, so the
   losing INFOs are not in view. The INFO scorecard below gives the denominator.
2. **The winner needed an hour and survived a −47 % drop.** The gate's exits (15–60 min, stops at −20/−25 %) would
   have stopped out at 12:31 or sold at TIME for a small gain. Coins like this pay only with long holds and no
   tight stop. That is W3/E2's question, now on the curve: a 6 h hold or "hold to graduation" against the current
   menu.
3. **Bug: the observer misses a CA that follows a line break.** The `XT` record of the 12:27:36 post has
   `mint: 0`, although its text is "ca:" + a new line + this exact address. Cause, reproduced here:
   `postAddresses` (`xread.ts`) runs the base58 regex over the post **as a JSON string**. There the line break is
   the two characters `\` `n`, so the letter `n` sits right before the address. That makes a 45-character base58
   run, which the bounded regex (32–44 characters) rejects entirely. INFO still fired, because it uses
   `raw.includes(mint)`, but **the dataset's `xCaPost` feature is false for every post that puts the CA on its own
   line**, a very common format ("ca:\n\n…"). Fix for the CTO: match on the parsed text fields (or replace the
   escapes `\n`, `\r`, `\t` with spaces first), then rebuild the feature. Every result that used `xCaPost` or `XT`
   `mint` (none of the gate's rules today) needs a re-run.
4. **Possible duplicate candles.** The 13:xx file has several `K` records for the same minute (13:10 four times,
   12:38 and 13:09 twice), some with a single trade. If late trades emit a second candle for a minute already
   written, the simulation reads both. Worth a check by the CTO. It does not change this case.

## Hypotheses

| # | Hypothesis | Test | Passes if | Cost |
| --- | --- | --- | --- | --- |
| F1′ | **INFO flags pay with a long hold, not with the gate's short exits** (F1 with exits fixed in advance): buy 45 s after the INFO; exit at graduation, at +6 h, or at −60 % | every `INFO` record, curve candles from the ledger (pool after graduation once gate gap 5 is closed) | ≥ 100 INFO flags, mean after costs > 0, bootstrap 90 % interval above 0, and true without the best 2 % | nothing new up to graduation |
| O1 | **OPEN alerts, scored like INFO**: every OPEN breakout the desk recorded, bought 45 s after the alert, with F1′'s long exits against OPEN's own | the desk's recorded breakouts ("every breakout is still shown and recorded"), curve candles from the ledger | as F1′; and OPEN with insider ≥ 30 % against < 30 % | the desk's breakout records joined to the ledger: a script for the CTO |
| I2 | **Young paid-check accounts (under 24 h, under 100 followers) are no worse than established ones among INFO flags**: CRWLR (2.4 h, 2 followers) and Web (1.4 h, 64) both ran | INFO split by `xAccountAgeH` and followers at the read | either way, it decides whether INFO should require reach | as F1′ |

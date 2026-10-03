# Voices: a scorecard for the people who move memecoins (and the TJR case)

Owner, 3 Oct: analyse a YouTube video about TJR (`youtu.be/LvnemCfJpQU`), judge TJR's impact on the space as a market
opportunity, improve Raven critically, and track at least 1,000 voices.

## What could and could not be checked

- **I did not watch the video.** This session's network blocks youtu.be and youtube.com. A web search for the
  video id found nothing, so I cannot say what it contains. Nothing below summarises it.
- **TJR, from search-result titles only (no page opened, kucoin.com and the others are blocked).** These are leads
  to verify, not facts:
  - "TJR" is the trader `_TJRTrades` on X.
  - Two coins carry the name: "The Top Floor Boss ($TJR)" and "TJR Island Memes".
  - Several headlines describe TJR and ANSEM coins surging in a "celebrity coin" trend, with very large one-day
    moves and an exchange listing.
  - A post attributed to TJR says successful Solana memecoin traders could do well in perpetual futures.

  None of these numbers is confirmed, so none is used below.
- **Verdict on TJR's impact:** not possible honestly without the video or one opened source. What the headlines
  point at is testable, though: **coins named after a big trader or influencer form their own narrative**
  ("celebrity / trader coins"), and they have a specific failure mode: anyone can launch a coin with a famous name
  without that person's consent. Raven can measure this instead of guessing (V2 and V3 below).

## Critical finding: Raven reads X only for the launch's own account

The observer reads one X account per launch: the one in the launch's metadata (`observer.ts` `readX`, one read
every 1.2 s, `OBSERVE.x.gapMs`). It never reads the people who move the market: callers, traders, KOLs. A post by a
large voice is the event the desk most wants to know about, and today it is invisible. Every case the owner has sent
(AGENCY, Super Inu, the X-trending launches) is about attention, and attention is the one input Raven does not
collect.

## The voice registry, design

**Do not hand-write 1,000 names.** A list typed from memory goes stale and has no evidence behind it. The registry
grows from the ledger itself, and every voice has a measured track record.

1. **Seed (automatic):** every X handle the observer has already seen.
   - Authors of `XT` posts that contain a contract address.
   - Accounts linked in launch metadata with at least 1,000 followers.
   - Handles in the bios and replies of those posts (one hop).

   At ~90 launches a minute, about half of which carry an X link (to be measured), the ledger passes 1,000 distinct
   handles within days.
2. **Owner seed:** `data-desk/research/voices.json` (`[{ handle, note, addedAt }]`) for voices the owner names, such
   as TJR's account.
3. **Reading:** each voice's last 20 posts through the existing fxtwitter reader, on its own slow lane. Cycle: hot
   voices (recent CA posts) every 15 min, the rest every 2 h. 1,000 voices every 2 h is ~500 reads an hour, about 17 %
   of the reader's capacity (one read per 1.2 s is 3,000 an hour). Record type `VP obs, handle, post id, post time,
   {mint or other CA, views, likes, reposts}`. The time a post is known is its post time plus read latency, as
   `X_POST_LATENCY_MS` already does for launches.
4. **Scorecard (forward, no hindsight):** every CA a voice posts is a flag (`FLAG source=VOICE`, `FLAG-LEDGER.md`),
   priced when the desk read it, not when it was posted. It is judged at +1 h, +24 h and +7 d after costs. Per voice:
   - calls, median return, % reaching 2×, % rugged;
   - **how fast the price had already moved before we could read the post** (a voice whose calls are bought before
     we see them is worth nothing to a $2 desk);
   - whether the voice dumps on its own call (the wallet linked in its bio or posts sells within an hour, where known).
5. **Ranking:** a voice is ranked only after ≥ 20 judged calls, on its later calls only. Old calls choose; new calls
   judge, the same split as the gate.

## Pre-registered hypotheses

| # | Hypothesis | Test | Passes if | Value | Cost |
| --- | --- | --- | --- | --- | --- |
| V1 | The top 10 % of voices by past scorecard keep beating the rest on their next calls | rank on calls before date D, judge calls after D at +24 h after costs, priced at our read time | ≥ 200 later calls from the top decile, mean after costs > 0 and above the other deciles | very high: the core of "follow the right voices" | medium: registry, reader lane, VP and FLAG records |
| V2 | "Name coins" (a launch named after a tracked voice) run only when that voice posts the CA itself | tag launches whose name or symbol matches a tracked handle or display name; split by whether the voice posted the CA by T | the endorsed group's +1 h mean after costs > 0 and above the unendorsed group; ≥ 30 endorsed | high: the TJR / ANSEM pattern as a rule | low once V1's registry exists |
| V3 | Unendorsed name coins rug: launches using a big voice's name without the voice's post are a fast exclusion | the `organic` group with unendorsed name coins excluded, against the full group | the exclusion improves the later mean and the group passes where it did not | medium | low |
| V4 | Several independent voices posting the same CA within 30 min beats one voice | count distinct voices (not following each other, where known) per CA by T | 3 or more voices: +24 h mean after costs > 0 and above 1 voice; ≥ 50 cases | high | low |

## What the owner can send

The video's main points in a few lines, or its transcript as a file in the repo. Then a card can be written from
it. Also TJR's exact X handle, and any voices you trust, for `voices.json`.

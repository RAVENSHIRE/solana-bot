# Brainstorm: the memecoin market as a whole (narratives, leaders, breadth)

Owner, 3 Oct: look at the whole memecoin market, not one launch at a time. Narratives come in waves: INU dogs, cats,
coins tied to a big name ("Mask" for Musk), "L1 finance and meme stockify". New projects worth watching are found on
X and in the trending lists. This page turns those observations into features the desk can compute at a decision
time and into hypotheses the gate can judge.

## The owner's cases of 3 Oct

These are known cases (`curiosity/cases.ts` rules): they suggest hypotheses and never count as evidence for them.
The network in this session blocks DexScreener, Jupiter and FOMO, so I could not look any of them up. What is
written below is what the owner sent, nothing more.

| Case | What the owner sent | Role |
| --- | --- | --- |
| Super Inu (FOMO blue check) | FOMO position card, 3 Oct: $20 invested, average entry at a $9.6M market cap, $44.4M now, +$33.84 (+165 %), position still open. The chart shows one buy and several sells | WINNER (established coin, INU narrative) |
| `GZw7LxHtQKSQ1YsGnpNH7SovnBF8X6poYgavHwrmRekp` | example of a narrative coin (INU / cat / big name) | to fill in: name, narrative, role |
| `5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump` | example of a narrative coin | to fill in |
| `GoADAwux19tGxb3W4ykPzZz8p5JCSYaxBRpuW7s9pump` | a new project found through X and the trending lists | to fill in |

One lesson is already in the card. The market cap went from $9.6M to $44.4M, which is 4.6× (+362 %), while the
position shows +165 %. My reading, which the card does not state: part of the position was sold on the way up,
which matches the sell markers on the chart. Selling into strength cost part of the run here. The exits question
for established coins (fixed targets or a trailing stop) is hypothesis E2 below.

## What the desk already has

- `regime/regime.ts`: BTC and SOL trend and volatility, and launch activity (HOT / NORMAL / COLD) at each decision.
  It describes the market, but not **which kind of memecoin** is hot.
- `VT` records (`verified.ts`): every 5 minutes, for each Jupiter-verified memecoin and each watchlist coin: market
  cap, liquidity, holders, organic score, price, and changes over 5 min, 1 h, 6 h and 24 h. That is a point-in-time
  panel of the established market, but nothing aggregates it yet.
- Launches: name, symbol and metadata description (`PC`, `C`, `META`) at creation.

## New features, all computable at decision time T from records observed by T

1. **Narrative tag** (version 1, frozen before any test): a keyword dictionary on name + symbol + description.
   - `DOG`: inu, doge, shib, dog, pup
   - `CAT`: cat, kitty, meow, nyan
   - `BIGNAME`: elon, musk, mask, tesla, grok, trump
   - `AI`: ai, agent, gpt, bot
   - `FINANCE`: bank, fund, finance, yield, l1, chain
   - `STOCK`: stock, share, ticker-like names of listed companies
   - `OTHER`

   A coin can carry several tags. Changing the dictionary makes a new version, and results are reported per version.
2. **Narrative heat** `heat(tag, T)`: launches with the tag in the last hour, divided by the median hourly count over
   the previous 24 h (the same construction as `activity`).
3. **Narrative graduation rate** `grad6h(tag, T)`: the tag's graduations in the last 6 h divided by its launches in
   the last 6 h. Only graduations observed by T count.
4. **Narrative leader** `leader(tag, T)`: the largest verified coin with the tag in the latest `VT` check, together
   with its 1 h and 24 h change.
5. **Narrative breadth** `breadth(tag, T)`: the share of the tag's verified coins whose 1 h change is above 0 in the
   latest check. **Market breadth**: the same over every verified memecoin.
6. **Holder growth** `dHolders24h(m, T)`: holders now divided by holders in the `VT` check closest to T − 24 h. It is
   unknown when the coin was not checked then, never 0.
7. **Copycat of a leader** `copycat(m, T)`: a launch whose name or symbol matches, after normalising case and
   spacing, a verified coin or a graduation from the last 24 h. Known examples: the FIX6900 copycat and the SIF clone
   in `cases.ts`.

## Pre-registered hypotheses

The gate judges each one on data recorded after the feature ships. Known cases (Super Inu and the three mints above,
once tagged) are excluded.

| # | Hypothesis | Decision and test | Passes if | Value | Cost |
| --- | --- | --- | --- | --- | --- |
| N1 | Launches in a hot narrative do better: the `organic` group restricted to tags whose `grad6h` is in the top third of tags | at 60 and 120 s, the same exits as `organic`; compared with `organic` in the cold tags | ≥ 100 later trades, mean after costs > 0 and above the cold-tag group, holding in at least two separate days | high | medium: tags and two aggregates |
| N2 | A leader lifts its narrative: when a tag's leader is up ≥ 15 % in 1 h, the tag's other verified coins beat the other tags' coins over the next 6 h | a flag at the first `VT` check after the leader crosses +15 %; forward return over 6 h with the flag ledger's judge (`FLAG-LEDGER.md`) | ≥ 50 events over ≥ 5 days, mean after costs > 0, above the same-time return of other tags | high: the owner's "INUs" idea | low: `VT` already has the data |
| N3 | VINFO movers only work when the market breadth is above 50 % | the VINFO flags split by breadth at the flag | the high-breadth half has a positive mean after costs and beats the low-breadth half; ≥ 30 flags each | medium: may simply silence bad days | low |
| N4 | Copycats of a leader rug more often | `copycat = true` against false in `all` and `organic`, at 30–120 s | the copycats' later mean is lower, and the rule "exclude copycats" passes the gate where the group without the exclusion does not | medium | low |
| E1 | Established coins whose holders grow keep running: verified memecoins with `dHolders24h` ≥ 1.10 and liquidity at least 5 % of market cap | entry at the `VT` check, judged at +24 h and +7 d | ≥ 30 entries over ≥ 5 days, bootstrap 90 % interval of the mean after costs above 0, above the verified coins without the condition | high: the owner's main target (established coins with a committed holder base) | low |
| E2 | On established coins, a trailing stop keeps more of a run than fixed targets do (see Super Inu's card) | on the E1 entries, compare exits: +40 % / +100 % fixed targets against a 25 % and a 35 % trail, pre-registered | the trailing exit's mean after costs is higher on the later period | medium | low |

## What to send to make this better

For each mint above: its name, the narrative you see in it, and when you spotted it. Better still, add them to the
watchlist with the date (see `FLAG-LEDGER.md`, `addedAt`). The tags dictionary is a first guess, so add the words you
see in the current waves before it is frozen.

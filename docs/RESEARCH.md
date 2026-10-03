# Research: launch, attention and demand

> The observer's ledger imports into the research platform's event store (`research:platform import --observer`), where its facts
> feed versioned features, point-in-time backtests and pre-registered experiments: [research/ARCHITECTURE.md](research/ARCHITECTURE.md).

The desk's backtests (2 Oct) showed no edge from chart rules alone: runners and rugs look alike in the first minutes.
The two runners we studied had signals outside the chart (AGENCY: the project's own X account posted the contract
address 2 minutes after launch; 7cYaQc: an organic curve). Those are hypotheses, not edges. This part of the repo
turns them into timestamped facts so they can be tested out of sample — before anything enters a trading score.

Rules of the dataset:

- **Facts, not scores.** The observer records what happened and when it was observed. Nothing is filtered on outcome.
- **Point in time.** Every record carries the time it was observed; a feature at decision time T may only use records
  observed at or before T. Event times (chain time of a trade, X post time from its id) are kept separately.
- **Coverage is part of the data.** Disconnects are `GAP` records; trade completeness per token is measured from the
  curve reserves each trade reports.

## Running the observer

```
dashboard\start-research.cmd            (Windows: minimized, log in data-desk\research\observer.log)
npm run research:observe -- [--sources public|public,helius] [--min-free-mb 700] [--dir data-desk/research]
```

Read-only: it never signs, trades or reads a key. It runs beside the desk and does not touch its data.

| Source | What | Cost |
| --- | --- | --- |
| PumpPortal websocket (`subscribeNewToken`, `subscribeMigration`) | every creation (creator, dev buy, metadata URI), every migration | free |
| Solana RPC websockets `logsSubscribe` (pump.fun program): api.mainnet-beta + publicnode, merged | every TradeEvent (wallet, SOL, tokens, curve reserves), CreateEvent, CompleteEvent | free. In a 45 s test (2 Oct) the public RPC delivered 81 % of the merged set and dropped its connection once; publicnode added the rest. `--sources public,publicnode,helius` adds Helius (may bill websocket traffic) |
| Launch metadata JSON via pump.fun's gateway (`pump.mypinata.cloud`) | X, website, Telegram, description, image | free; ~0.1 s. Never ipfs.io, which rate-limited this IP to HTTP 429 for every request (the desk's radar now uses the same gateway) |
| fxtwitter mirror (`api.fxtwitter.com/2/profile/<handle>/statuses`) | profile (incl. checkmark type: blue / gold business / grey government) and last 20 posts with exact times | free, unofficial; read at +20 s and +6 min for every launch with its own X account, +2.5/+15/+30 min while active; one read per 1.2 s |
| The launch's website | whether it shows this contract address | free; +6 min, +20 min while active |

**Local feed for the desk.** The observer serves the creations and migrations it sees on `127.0.0.1:3101/pump/events`,
and each curve's market cap as its last trade left it on `/pump/curves` (`RESEARCH_FEED_PORT`; local only). The desk's
launch radar, graduation feed and opening screen read them from there instead of polling Helius for pump.fun
signatures and curve accounts every few seconds; when the observer is not running (no answer for 10 s) or its own websockets are down, the desk
falls back to the RPC by itself (`DESK_PUMP_STREAM=off` forces the RPC). The dashboard's source line says which one
is in use: *launches from the research live stream* or *launches polled from the RPC*, and for the opening screen
*curves from the research live stream* or *read from the RPC*.

PumpPortal's trade stream needs a funded key (0.01 SOL per 10,000 messages); the RPC logs give the same trades for free.

Volumes (2 Oct): ~80 pump.fun trades/s, ~90 launches/min. Raw trades are kept for each launch's first 10 minutes
(an hour for curves past 25 %), minute candles for 6 hours on the curve. Bulk records pause below `--min-free-mb`.

## Files and records

`data-desk/research/ev-YYYYMMDD-HH.jsonl` (UTC hour; gzipped when the hour ends). One JSON array per line. `m` and `w`
are numbers from the file's own dictionaries (`["M", i, mint]`, `["W", i, wallet]`); `obs` is the time observed (ms).

| Type | Fields |
| --- | --- |
| `PC` | obs, m, creator w, signature prefix, name, symbol, uri, dev buy SOL, dev buy tokens, market cap SOL, mayhem 0/1 — PumpPortal creation |
| `C` | obs, chain ts (s), slot, m, creating wallet w, creator w (if different), signature prefix, name, symbol, uri — CreateEvent |
| `T` | obs, chain ts (s), slot, m, wallet w, buy 1/0, lamports, token units, virtual SOL, virtual tokens, real tokens (after the trade), signature prefix |
| `K` | minute (unix minutes), m, open, high, low, close (market cap SOL), buy lamports, sell lamports, buys, sells, unique buyers, first-time buyers, curve progress at close |
| `X` | obs, chain ts, m — the curve completed |
| `G` | obs, m, signature prefix, pool — migrated (PumpPortal) |
| `META` | obs, m, {tw, web, tg, desc, img, keys} or {error} |
| `XP` | obs, m, handle, {st, http, f followers, fg following, n posts, j joined ms, v verified, web, bio, posts} |
| `XT` | obs, m, handle, post id, post time ms, {a author, t text, v views, l likes, rp reposts, c replies, q quotes, rt repost, re reply-to, mint 1/0, ca other address} |
| `S` | obs, m, {u url, st status, h http, ti title, v CONFIRMED/CONTRADICTED/NONE, o other address, x X handles} |
| `GAP` | obs, source, detail — a feed disconnected or stalled, or low disk |
| `STAT` | obs, counters for the last 10 minutes |
| `START` / `STOP` | obs, settings / totals |

## Study design (the report)

Decision times 60, 120, 300 and 600 s after creation. Features use only records observed by then: curve progress,
velocity and acceleration; unique and first-time buyers and their acceleration; buyer concentration (HHI, top-1/top-5
share); buy/sell flow; dev buy and dev selling; metadata completeness; X account facts and whether its own CA post
existed by then; website CA; the creator's earlier launches in the dataset. Labels from the price at the decision time:
maximum gain and drawdown over 5 min, 15 min, 1 h and 6 h; reached 2×/5×/10× and graduated within 1 h and 6 h; 2× before
halving within 1 h; time to peak. A horizon's labels stay empty until the data covers the whole horizon (no early
counting of fast hits). The curve is observed up to graduation; the pool afterwards is not, so multiples are capped
at the graduation price.

Data quality: a missing trade shows as a break in the curve-state chain (each trade reports the reserves after it;
the reserves before it must be some earlier trade's). On 2 Oct 99 % of normal launches had no break; launches in
pump.fun's "mayhem mode" break by design (their curve moves without matching trades) and are a separate feature.
A blind spot is an observer restart or every trade feed down at once; `--strict` drops rows with either.
Cohorts are measured on the first 60 % of launches and checked, unchanged, on the last 40 %.

## What reaches the phone: qualified calls, interesting coins, research updates

The desk sends nothing to ntfy by default (no rug confirmations). The research observer sends three kinds of message:

1. **CALL** — a buy signal from a rule that passed the qualification gate below. No rule passes yet, so there are none
   until one does.
2. **INFO** — an interesting coin, *not* a call ("Not a qualified call — for your eyes"), of two kinds:
   - **a new launch whose own X account posted its contract address** and has a checkmark (blue, gold or grey) or
     ≥ 1,000 followers: the account (badge, followers, age), how many seconds after launch it posted the CA, the market
     cap, buyers and the link. A launch that only *links* a big or checkmarked account (often a copycat) does not count.
     At most 8 per hour, one per launch; `INFO` records.
   - **an established coin with a blue check that starts to move** (`src/research/verified.ts`): every 5 minutes the
     observer reads Jupiter's hourly top-trending, top-organic and top-traded lists (free token API). A coin counts when
     Jupiter marks it verified (its `isVerified` flag: the blue check in Jupiter and most Solana wallets), it is a
     memecoin or project coin (no stablecoins, staked SOL, majors, tokenised stocks, nothing with a mint or freeze
     authority) with ≥ $1M market cap and ≥ $100K liquidity — or it is on your **watchlist**. It is sent when it is up
     ≥ 15 % in the hour, still rising over 5 minutes, with more buyers than sellers and more bought than sold, and an
     organic score that is not low. At most 4 per hour; the same coin again only after 12 h or another +25 %. Every
     coin is recorded at every check (`VT`), so "verified movers" can be qualified like any rule once there is data.

   FOMO's blue check is FOMO's own: its token lists need a FOMO login (the `FOMO_JWT` in `.env` is a one-hour Privy
   token that expired on 21 Sep, and `FOMO_API_KEY` is not accepted there). Coins checked on FOMO but not on Jupiter go
   on the watchlist, `data-desk/research/watch-tokens.json`, read at every check (no restart):

   ```json
   [{ "mint": "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU", "note": "E/ACC, blue check on FOMO" }]
   ```

3. **Research** — when a rule starts or stops calling, and once a day (first requalification after 00:00 UTC): how
   many rules qualify and the closest candidate with its later-period result and the hit rate it still needs.

`--no-phone` keeps all three off the phone (records are still written); `--no-calls` turns the call engine off,
`--no-verified` the verified-coin watch.

**Rules** (`src/research/rules.ts`, fixed in code): a group of launches, a decision time after creation (5, 15, 30, 60
or 120 s) and an exit (+40 % or +100 % target, −20 %/−35 %/no stop, 15 or 60 min). Groups use only what the live
observer knows by the decision time: trades and curve state, the creation message (dev buy) and the metadata —
every normal launch; own X account; X + website; dev buy ≥ 1 SOL; ≥ 5 buyers; ≥ 15 buyers with no wallet over 30 %;
organic demand (curve rising, ≥ 3 effective buyers, top buyer < 50 %, dev not sold); organic + own X.
**Sprints** (owner, 3 Oct: GOOP HEAD went $3.4K → $28.9K in 68 s and $105K in the same minute, then died): launches whose
curve fills at ≥ 30 % of its length per minute in the first minutes, alone or with ≥ 10 buyers and no wallet over 30 %.
They are judged on fast exits only: a +40/100/200 % target, a −25 % stop, a trailing exit 20 % under the peak since the
fill ("keep the max") and 1 or 3 minutes at most ("end early"). A trailing or timed exit that is profitable on average
needs no target hits to pass.

**Gate** (`npm run research:qualify`, `src/research/qualify.ts`, rerun by the observer every 6 h on the last 48 h):
each group's exit is chosen on the earlier 60 % of launches; unchanged, on the later 40 % it must have

- at least 100 trades,
- a profit after costs on average ($2 trades, 1.25 % pump.fun fee per side, $0.10 per round trip),
- a target hit rate at least the rate at which its trades break even ("hits +40 % often enough to cover the losers"),
- a profit on the tuning period too,
- and, once 30 of its live calls are judged, no average loss live.

The result is `data-desk/research/qualified.json` — every candidate with its evidence and the reasons it failed.

**Live** (`src/research/calls.ts`, inside the observer): at each rule's decision time the launch's facts go through the
same feature code as the look-back (a test checks live and look-back features are identical). A qualified rule's
match goes to the phone ("CALL ABC: +40% target — buy now at $X, sell at $Y, stop $Z, rule evidence, link"); every
other candidate's match is a shadow call (`SIG` record, never sent). After the hold, each signal is judged with the
look-back's simulation (`RES` record); those live results feed the next qualification. A launch first seen too late
for a decision time is not called.

Records: `SIG` obs, m, rule id, qualified 0/1, market cap SOL at the decision, sent 0/1, {features} · `RES` obs, m, rule
id, qualified 0/1, net %, exit reason, entry and exit market cap SOL, peak % · `QUAL` obs, {qualified rule ids, data window}.
`INFO` obs, m, X handle, {badge, followers, ownCa, market cap SOL} · `VT` obs, m, symbol, checks (J Jupiter, M Moonshot,
W watchlist), market cap $, liquidity $, holders, organic score, price $, change % 5m/1h/6h/24h, net buyers 1h, bought $
1h, sold $ 1h, traders 1h · `VINFO` obs, m, symbol, why, checks, market cap $, price $.

## The market-cap ladder: every chain, levels, old highs, holders

The launch recorder above sees pump.fun in its first minutes. The ladder (`src/research/ladder.ts`, inside the
observer, `--no-ladder` to turn it off) records the rest of a coin's life, on every chain, so the owner's way of
trading can be tested instead of believed: the decade levels ($10K → $100K → $1M → $10M → $100M), a coin far under its
all-time high (WWW on 3 Oct: $1.15M after $8.2M the day before), and old runners coming back.

- **Universe, every 10 minutes:** Jupiter's top trending / organic / traded lists (Solana: holders, organic volume,
  holder change), GeckoTerminal's trending pools across every chain (Ethereum, Base, BNB, Robinhood Chain, …), and the
  watchlist. From $10K market cap and $10K liquidity; no stablecoins, majors, staked SOL, tokenised stocks, or coins
  with a live mint or freeze authority.
- **Tracked after it leaves the lists**, for 7 days (the watchlist always), so a coin's fall is recorded as well as its
  rise. A study of only the coins still trending would see only survivors.
- **History** once a day per coin: the all-time high, the 30-day low and last week's close, from Birdeye candles
  (Solana, `BIRDEYE_API_KEY`) or GeckoTerminal (other chains), hourly for coins under 10 days old.
- **Holders** once a day per Solana coin from $1M (and every watchlist coin), over the Helius endpoint in
  `RPC_ENDPOINTS`: the 20 largest holders, the wallet behind each, where each wallet got its first SOL, **clusters**
  (wallets funded by one source or by each other: likely one actor), the **team** (the developer, wallets it funded,
  wallets sharing its funder) and wallets under 7 days old. A funder with 1,000+ transactions is an exchange or a
  service and never links wallets. About 45 RPC calls per scan, at most 2 scans per 10 minutes.
  `npm run research:holders -- <mint>` prints one scan.

`npm run research:ladder` measures what followed each snapshot (one sample per coin per day): doubled, reached the next
level, got back to its all-time high, or halved first, within 24 hours and 7 days. Cohorts: tier, distance under the
high (the "mid tier, 80 %+ under" row is the WWW case), position between two levels, holders rising or falling, real
(organic) buying vs selling, an old runner coming back (high 45+ days old, fell 70 %+, now 50 %+ off its 30-day low),
team share, and chain. Each row shows the doubling rate in the earlier 60 % and the later 40 % of samples: an effect
that holds in only one is noise. Nothing here sends a message; a cohort becomes a phone rule only through the same
kind of gate as the launch rules.

Ladder records (folder `research/ladder`, same file format): `LT` obs, coin (`chain:address`), chain, address, pool,
symbol, name, developer, source · `LS` obs, coin, source, symbol, market cap $, liquidity $, price $, holders, organic
score, change % 1h/6h/24h, buys/sells 1h, buyers/sellers 1h, volume $ 1h, bought/sold $ 1h, organic bought/sold $ 1h,
net buyers 1h, holder change % 1h/24h, top-holder %, developer %, created · `LA` obs, coin, source, interval, candles,
high $, high time, 30-day low $ and time, close a week ago $ · `LH` obs, coin, {top 20 %, programs %, wallets %,
clusters %, team %, fresh %, largest cluster, developer, developer's funder, holders}.

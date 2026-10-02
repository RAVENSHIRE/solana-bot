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
| fxtwitter mirror (`api.fxtwitter.com/2/profile/<handle>/statuses`) | profile and last 20 posts with exact times | free, unofficial; read at +6 min for every launch with its own X account, +15/+30 min while active; one read per 1.2 s |
| The launch's website | whether it shows this contract address | free; +6 min, +20 min while active |

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

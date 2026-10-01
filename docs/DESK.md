# Trading desk · TEST / LIVE

The dashboard's **Trading desk** tab runs one pipeline in two environments:

| | TEST / PAPER | LIVE |
| --- | --- | --- |
| Banner | `TEST / PAPER — NO REAL TRANSACTIONS` | `LIVE — REAL FUNDS` |
| Scanner, strategy, gates, quote, route, transaction build, RPC simulation, pre-flight | same code | same code |
| Signature | never requested | Phantom, one approval per transaction |
| Fill | paper fill from the passed unsigned simulation | confirmed on-chain balance deltas |
| Ledger / telemetry | `data-desk/ledger-PAPER.json` (FAIR), `ledger-PAPER-CRASH.json`, `events-PAPER.json` | `data-desk/ledger-LIVE-<wallet>.json` (FAIR), `ledger-LIVE-CRASH-<wallet>.json`, `events-LIVE.json` |

TEST and LIVE never run at the same time and never share data. Stopping keeps all telemetry and ledgers.

## Starting the dashboard on Windows

Use `dashboard\start-background.cmd`. It starts the dashboard minimized and writes its output to `data-desk\dashboard.log`; follow the log with:

```
Get-Content data-desk\dashboard.log -Wait
```

A console window that is clicked, or has text selected, pauses every program that writes to it (Windows QuickEdit). A dashboard started with `npm start` in a visible window can therefore freeze until the window gets a key press. On 1 Oct it stopped answering for minutes. With the output in a file this cannot happen.

## Operational controls and restart

Strategy toggles, TEST drill and TEST reset are switched in the dashboard and saved per mode (`DESK_DEPLOYMENT_MODE=EDITABLE`, the default). For an unattended deployment set `DESK_DEPLOYMENT_MODE=LOCKED` in `.env`: they are then fixed at startup by the flags below and rejected by the server; Pause, Stop and EXIT NOW remain available. The startup flags are `DESK_PAPER_FAIR_ENABLED`, `DESK_PAPER_CRASH_ENABLED`, `DESK_LIVE_FAIR_ENABLED`, `DESK_LIVE_CRASH_ENABLED`; LIVE CRASH defaults to false. All keys are allowlisted and validated at startup.

FAIR and CRASH retain their separate normal cooldowns. `DESK_FAIR_LOSS_REENTRY_MIN` (default 60) and `DESK_CRASH_LOSS_REENTRY_MIN` (default 30) set a minimum cooldown after a confirmed loss. `DESK_FAIR_FRESH_SIGNAL` and `DESK_CRASH_FRESH_SIGNAL` default to true: a post-exit observation is required even when the clock has elapsed. Completed TEST cycles still count toward cooldowns.

Before each LIVE start, the selected wallet's saved ledgers are loaded and checked for unresolved orders. Tracked token quantities must match the wallet's SPL and Token-2022 accounts; failed inventory or a mismatch refuses the start. `GET /api/trading/health` requires the local capability and reports scan staleness or a blocking issue without provider credentials.

## Capital

One source (`src/desk/config.ts`, overridable in `.env`):

- `DESK_PLANNED_CAPITAL_USD` — planned starting capital, default **5.45**
- `DESK_BASE_ENTRY_USD` — base entry, default **2.00**
- `DESK_SLIPPAGE_BPS` — slippage tolerance, default 100; it counts toward max drag

Native reserve (0.003 SOL) and max drag (1.5 %) are the project's existing micro values. The actual SOL balance always comes from the connected Phantom wallet; `data/wallet-monitor.json` no longer sets a planned budget.

## Strategies (run in parallel)

| | FAIR (fair launch) | CRASH |
| --- | --- | --- |
| Idea | Fair-launch trending tokens, every hard gate, momentum in two consecutive scans | The early, well-traded part of a young pool's first move; trades of up to 10 minutes targeting +100 % |
| Entry | QUALIFIED status (below) | One scan: graduated ≤ 15 min ago (age of the token's **first** AMM pool, not of whichever pool is deepest now), 5m price +10 % to +30 %, 5m volume ≥ $50K, market cap ≤ $300K, buy/sell ≥ 1.3, ≥ 40 buys, AMM liquidity ≥ $10K and ≥ 3 % of market cap, mint + freeze authority revoked, no dangerous extensions, top-10 ≤ 50 % and largest wallet ≤ 15 % when known, liquidity not dropping. Launch fairness is shown but **not required** |
| Exits | `RS_*` rules: stop loss, take profit, trailing stop, max hold | `CRASH_EXIT_MODE=quick` (default): take profit +100 % (= $2 unrealized on a $2 entry) · stop loss −35 % · time stop 10 min · no profit lock unless `CRASH_LOCK_PEAK_PCT` is set. `CRASH_EXIT_MODE=ride`: no take profit · trailing stop 35 % from the peak once +50 % was reached · stop loss −35 % · time stop 60 min |
| Re-entry after an exit | 30 min | `CRASH_REENTRY_MIN` (10 min) — a fresh signal only |
| Checked | every 5 s | every 2 s |
| Entry size / TEST sleeve | `DESK_BASE_ENTRY_USD` / `DESK_PLANNED_CAPITAL_USD` ($2 / $5.45) | `CRASH_ENTRY_USD` / `CRASH_CAPITAL_USD` ($2 / $10) |
| Slippage / max drag | `DESK_SLIPPAGE_BPS` (1 %) / 1.5 % | entries `CRASH_SLIPPAGE_BPS` (2.5 %), exits `CRASH_EXIT_SLIPPAGE_BPS` (10 %) / `CRASH_MAX_DRAG_BPS` (5 %) |
| Open positions | 2 | `CRASH_MAX_POSITIONS` (3) |

- Each strategy has its own ledger and, in TEST, its own sleeve; LIVE strategies share the Phantom wallet and its reserve check.
- A token is held by at most one strategy. Several entries can happen in one scan, up to each strategy's free slots; a candidate the guard blocks (e.g. max drag) is skipped for 5 minutes and the next one is tried.
- Early warnings (liquidity −30 % since entry, pump.fun creator selling) apply to both. Position checks run beside the discovery scan, so a slow scan never delays an exit. CRASH entries happen before the rate-limited launch-history checks.
- Strategy cards show entry, sleeve, positions, realized/unrealized PnL, trades, win rate, average return and hold, profit factor and max drawdown (drill trades excluded), plus toggles. Disabling a strategy stops new entries; open positions keep their exits.
- **CRASH is off in LIVE until you switch it on.** That click is saved in `data-desk/settings-LIVE.json`, as are all strategy and drill toggles per mode, so a restart never changes what the desk trades. CRASH trades need fast approvals: use Phantom Auto-Confirm. A rug can still happen inside one block — the exits limit, not remove, that risk.
- **PAUSE ENTRIES** stops new positions only. Open positions keep their stop loss, take profit, trailing and time stops (in LIVE each exit still needs its Phantom signature). STOP ends everything.
- **Why these rules (backtest, 30 Sep 2026):** every pump.fun graduation over 12 h (247 pools with minute candles, a fixed sample of the 698 that graduated), $2 per trade with sized impact, 0.3 % venue fee per side, $0.02 fixed cost and 3 % stop slippage:

  | Rules | Trades | Win | Avg per trade | Median | Profit factor | Halves (time) |
  | --- | --- | --- | --- | --- | --- | --- |
  | Old: pool ≤ 60 min, +10–200 %, ≥ $20K · SL 15 %, TP 100 %, lock 40/15, 4 min | 178 | 30 % | −8.8 % | −19 % | 0.53 | −5.8 % / −12.5 % |
  | Old rules, RIDE | 172 | 11 % | −11.6 % | −19 % | 0.49 | −6.9 % / −17.4 % |
  | Old rules with the old costs (full exit fee, rent never reclaimed) | 178 | 26 % | −18.8 % | −29 % | 0.28 | |
  | **New: pool ≤ 15 min, +10–30 %, ≥ $50K, ≤ $300K · SL 35 %, TP 100 %, 10 min** | 36 | 53 % | **+24.3 %** | +12.6 % | 2.41 | +20.9 % / +27.1 % |

  The entry rule carries the result: with the new exits the old entry still loses (−11 %/trade); chasing moves above +30 % or trading on less than $50K five-minute volume turns it negative. The profit lock cost about 10 points in every variant; stops at 15–25 % were shaken out. The new rules stay positive with 8 % stop slippage (+22.9 %), at $100 per trade (+22.1 %) and with the old costs (+14.3 %). **Limits:** one night of data; about 12,000 rule combinations were compared, so the best one is optimistic; buy/sell ratio, buy count and holder gates (which the desk also applies) are not in candles. Re-run `npm run desk:backtest` regularly and compare with TEST.
- Other CRASH settings in `.env`: `CRASH_ENABLED`, `CRASH_TAKE_PROFIT_PCT`, `CRASH_LOCK_PEAK_PCT`, `CRASH_GIVEBACK_PTS`, `CRASH_STOP_LOSS_PCT`, `CRASH_MAX_HOLD_MIN`, `CRASH_TRAIL_ACTIVATION_PCT`, `CRASH_TRAIL_STOP_PCT`, `CRASH_RIDE_MAX_HOLD_MIN`.

### Custom strategies (your own rules, added in the dashboard)

Use the **Strategy** dropdown above the strategy cards to:

- pick one strategy, or show all of them;
- switch the picked strategy on or off (in the selected mode only);
- **add** a new strategy from a preset or from blank;
- **edit** or **delete** a custom strategy.

#### What a custom strategy is

A custom strategy is a set of rules. Every rule you fill in must pass; an empty field means no rule.

- **Entry**: market-cap band, minimum holders, pool age, 5m and 1h price-change bands, 5m and 1h volume, buy/sell ratio, minimum liquidity, top-10 and largest-wallet limits, and optionally a linked X account.
- **Exits**: take profit (empty means ride), stop loss, trailing stop, market-cap floor or target, and max hold.
- **Size and costs**: TEST capital, entry, max positions, slippage, exit slippage and max drag.
- **Re-entry**: a cooldown after each exit.

Mint and freeze authority revoked and no dangerous token extensions always apply; they cannot be switched off.

#### How it trades

- Custom strategies see every priced token, including those above FAIR's $1M band. A token kept only for them shows the tier **Custom only** and is never a FAIR entry.
- The **Custom** column in *Candidates* shows each strategy's verdict: entry-ready, or the first rule not met. The token's detail lists every check.
- Holders are counted first for tokens a custom strategy is interested in.
- Each strategy has its own ledger (`ledger-PAPER-<ID>.json`, `ledger-LIVE-<ID>-<wallet>.json`) and, in TEST, its own sleeve.
- A new strategy starts **ON in TEST and OFF in LIVE**.
- An edit applies to new entries at once, and to the exits of open positions.
- A strategy with an open position cannot be deleted. After deletion its ledger stays on disk.
- The rules are saved in `data-desk/strategies.json` and shared by both modes; the on/off switch is saved per mode.
- With `DESK_DEPLOYMENT_MODE=LOCKED`, adding, editing and deleting are refused.

#### Your four plays as presets

| Preset | Play | Entry | Exits |
| --- | --- | --- | --- |
| **MIGRATION** | Migration | $60K–$300K, pool < 1 h old (just graduated), 1h Vol/MC ≥ 30 %, ≥ 200 holders, top-10 ≤ 30 %, largest wallet ≤ 10 % | trailing stop 30 % once 2× is reached, stop −50 %, max 3 days, no stop-out in the first 60 s |
| **CONSOL** | Consolidation re-entry ("Crash Strategy") | $800K–$1.2M, pool ≥ 12 h old, 1h change −10 % to +10 % (sideways), 5m 0 to +8 %, 1h volume ≥ $30K, ≥ 500 holders | trailing stop 30 % from 3×, stop −30 %, max 3 days, no stop-out in the first 60 s |
| **SCALP** | 15-minute scalp | $400K–$1M, 5m +15 % to +80 %, 5m volume ≥ $50K, buy/sell ≥ 1.3 | take +60 %, stop −30 %, out after 25 min |
| **RUNNER** | Established runners | see below | see below |

The desk sells a position in one piece, so your profit ladder (2× / 5× / 10× / trail the rest) is approximated by a trailing stop that activates at the first ladder step. The desk's built-in **CRASH** strategy is *not* your Crash Strategy: CRASH trades young pumping pools for minutes; use **CONSOL** for consolidation re-entries.

#### Copycats

Before any entry the desk checks whether an older Solana token with the same ticker or name is at least 3× bigger (and ≥ $100K): every token the scanner has seen, then a DexScreener search. Such a clone is refused (`COPYCAT of …`). On 1 Oct the CRASH strategy bought a second "Jane" two minutes after it launched, while the real Jane was at $1M+; the clone rugged.

#### Presets

**RUNNER** (your style):

- **Entry**: holders ≥ 1,000; market cap $300K–$20M; pool older than 1 h; 1h change −15 % to +25 % (sideways); 5m change +1 % to +15 % (turning up again); 1h volume ≥ $100K; buy/sell ≥ 1.1; liquidity ≥ $50K; top-10 ≤ 40 %; largest wallet ≤ 10 %.
- **Exits**: no take profit; trailing stop 25 % below the peak once +30 % was reached; stop loss −25 %; max hold 7 days.

RUNNER has not been backtested: let it prove itself in TEST before switching it on in LIVE.

### Strategy assistant (Claude)

The *Strategy assistant* panel in *Strategies* is a chat with Claude (`claude-opus-5-5`). Describe how you pick, enter and exit coins. You can also put a wallet address in *Learn from wallet*: the desk then reads that wallet's last 60 transactions from the chain and gives Claude the swaps it finds, with the buys and sells per token, amounts, times and the estimated market cap at each trade (trade price × current supply).

What happens with an answer:

- Claude answers, asks at most two questions, or **proposes a strategy**.
- A proposal is checked like any custom strategy; if it fails a check, the panel says why and you can ask Claude to fix it.
- **Review in editor** opens the proposal in the rule editor. Nothing is saved or switched on until you press *Add strategy* there, and a new strategy starts in TEST only.
- Follow-up messages ("tighter stop", "only above $1M") edit the same proposal.

Setup and data:

- Add `ANTHROPIC_API_KEY` to `.env` and restart the dashboard. The key stays in the local server and is never sent to the browser.
- Sent to Claude: your messages, your existing custom strategies, and the named wallet's swap summary.
- Requests use structured output and Anthropic's server-side fallback for declined requests.

### LAUNCH: the launch radar (the @glabuz pattern)

On 1 Oct @glabuz turned $500 into ~$15K on Meme Industries (`FFrRBPP9…pump`) by entering at ~$20K:

| UTC | Event | Curve market cap |
| --- | --- | --- |
| 16:07:22 | created on pump.fun | $6K → $14K in the first minute |
| 16:08:41 | the project's own X account @MemeInds posts (79 s after creation); custom website onsolchain.lol | ~$16K, flat for 4 minutes |
| 16:12 | first jump | $17.5K → $30K |
| 16:16:06 | graduates to PumpSwap | ~$47K; $800K+ two hours later |

The signal is the quality of the launch itself. Only a few of the ~50 pump.fun launches per minute have an own X account and a real project website that links back to it.

**How the radar works:**

- Every scan reads the new launches straight from the chain (pump.fun's mint authority, `TSLvdd1…`) together with their metadata (X, website, Telegram).
- It checks the website of every launch that has an X link.
- It scores each launch (`launches.ts`):

  | Signal | Points |
  | --- | --- |
  | Own X account | 3 |
  | Live project website with a title | 3 |
  | Website links the same X account | 2 |
  | Telegram | 1 |
  | Real description | 1 |

  Links to platforms and news sites don't count as a project website.

- It checks the **contract address** (CA) on the project's own pages. The metadata alone proves nothing: on 1 Oct the impersonator STASH (`Fx5E1…HQyJ`) copied @stashdfun and stashd.fun into its metadata, 14 h after the real token `3Bdwh…pump`, and scored 8. Now:
  - the X profile page (`x.com/<handle>`, as served without login, no API key) and the website, including its own script bundles, are read for Solana addresses;
  - **this mint written there** confirms the launch: +3 when the X account posted it, +2 when the website shows it;
  - **another token's CA there and never this one** marks an **IMPERSONATOR**: score 0, never shortlisted or bought, and an alert if it was shortlisted before;
  - a post by the account wins over a stale website;
  - launches not confirmed yet are re-read every 30 s for 12 minutes (the X page) and every 2 minutes (the website), since projects post the CA after creation (Meme Industries 79 s, Potato within the first minutes).

  | Confirmation | Points |
  | --- | --- |
  | X account posted this CA | +3 |
  | Website shows this CA | +2 |
  | X or website shows another CA | score 0 (IMPERSONATOR) |

- Clones are marked **CLONE** and never shortlisted: a later launch that copies an earlier one's X account, website or name (on the first live run KEN appeared 3× and ROPAD 2×). If the project's own X account posts the clone's CA, the clone is the real token and the earlier "original" an impersonator.
- **X reach** comes from the same X profile page (no key needed): followers, account creation date, post count, blue check, and the views, likes and replies of the recent posts. The more followers, the higher the launch ranks:

  | X reach | Points |
  | --- | --- |
  | Followers ≥ 10K / ≥ 2K / ≥ 500 / ≥ 100 | +4 / +3 / +2 / +1 |
  | Followers below 25 | −1 |
  | Best own post in the last 3 days ≥ 50K / ≥ 10K / ≥ 2K views | +3 / +2 / +1 |
  | Account less than a day old with under 500 followers | −1 |
  | The linked X account does not exist | −3 |

  A linked *post* (x.com/…/status/…) counts too: its author's page is read for reach and for this CA (Ansemmas on 1 Oct: a 5-day-old account, 401 followers, a 21.7K-view post; it went from $63K to $1.03M).
- **Claude review** (with `ANTHROPIC_API_KEY`): every launch that reaches the shortlist score is read by Claude — token description, the website's visible text, the X bio and recent posts with their views, the CA check and the insiders — and rated STRONG (+3), OK (+1), WEAK (−1) or **SCAM** (never bought). It also scores idea and professionalism (0–10), says whether the material looks AI-made, and lists concrete scam signs (another CA, drainer warnings, "send SOL" giveaways, impersonation). One low-effort request per launch, at most 20 per hour (`DESK_AI_REVIEWS_PER_HOUR`; `DESK_AI_REVIEW=off` turns it off). At about $0.01–0.03 per review that is at most ~$0.60 an hour while the radar is busy. Everything sent is public.
- **X feed** (with `X_BEARER_TOKEN`): every 30 s the desk searches recent X posts for token launches and CAs (`DESK_X_QUERY` overrides the search; the default looks for "ca:", "pump.fun", "contract address", "just launched", "now live" on Solana, no reposts). Each post that names a mint becomes a signal with the author's followers and the post's impressions:
  - the project's own account posting this CA confirms it (+3);
  - another account posting it adds +1, or +2 with ≥ 10K views or followers;
  - a mint the radar did not see launch (older, or from another launchpad) is scanned like any candidate (source *X feed*).

  The X API's Basic plan allows 60 searches per 15 minutes; the desk uses 30 and waits out a rate limit. Without a token the feed is off and the radar still reads X profile pages.
- **Rug defence** (`launch-risk.ts`). The two LAUNCH trades of 1 Oct that dumped at graduation:

  | | Insiders at creation | Peak | After graduating |
  | --- | --- | --- | --- |
  | ETF (5EvrB7…pump) | dev 26.6 % + 5 wallets = 40 % | +308 % | −84 % |
  | Potato (GicwGn7X…) | dev 5.1 % + 5 wallets = 15 % | +220 % | −90 %, X account deleted afterwards |

  A bundled creation alone does not mark a rug (ETF was the best trade). What both had in common is the insiders — the creator and every wallet that bought in the creation slot — selling into the migration, when Jupiter cannot route the token for a minute or two. So:
  - the insiders are read from the chain seconds after the launch is seen and shown in the radar; a launch where they hold ≥ 50 % is never bought;
  - a held position sells as soon as the insiders sold 25 % of their bag and at least 1 % of supply (**RUG insiders sold**), checked every 8 s;
  - a position bought on the curve sells **before graduation** when the curve is 90 % full and the insiders still hold ≥ 8 % (**PRE_GRADUATION**); insiders with a small bag are ridden through graduation;
  - a held launch's X account is re-read every minute: gone on two reads in a row after it existed → **RUG**, sold;
  - every rug is remembered in `data-desk/rugs.json` with its creator, X account and website: a later launch by the same creator, account or site scores 0 (**RUG HISTORY**). Potato is on the list from the start.
- From a score of 6 the launch is shortlisted: it appears under *Launch radar* (ranked by score, then followers) with columns for the **CA** (✓ on X, ✓ on site, ✗ FAKE, ✗ RUG, not yet), **X reach** (followers, best post views, account age, X-feed posts), **Insiders** and **Claude**'s verdict, an alert with a FOMO link goes to your phone, and the token is analysed like any candidate. A launch exposed later (impersonator, rug) is reported once and alerted.

**LAUNCH** (built-in strategy, ON in TEST, OFF in LIVE) buys a shortlisted launch:

- **Entry** (all of these):
  - never an impersonator, a rug (deleted X account, rug history, SCAM review) or a launch whose insiders hold ≥ 50 %; insiders read before the entry;
  - **on the curve**: from 1 minute after creation when the project's X account or website shows this CA, from 3 minutes otherwise, never after 12 minutes. Jupiter quotes new curve tokens 3–12 s after creation (measured on 1 Oct), so the evidence sets the window, not routing; market cap $5K–$40K; 5m volume ≥ $1K and ≥ 10 buys;
  - **after graduation** (the runners that outgrow the curve window — Ansemmas, WIRED): up to 90 minutes after creation, market cap $40K–$400K, score ≥ 9, X reach of ≥ 300 followers or a 5,000-view post, 5m volume ≥ $10K and ≥ 40 buys;
  - top-10 wallets ≤ 35 %, largest wallet ≤ 12 %, developer ≤ 10 % when known;
  - mint and freeze authority revoked;
  - not a copycat.
- **Exits:**
  - the rug exits above (insiders selling, before graduation while insiders hold a bag, X account deleted);
  - stop −40 % (not in the first 60 s);
  - trailing stop 35 % once 2× is reached;
  - max hold 4 h;
  - no re-entry for 4 h.

An "entry-ready" alert goes out with the FOMO link, so you can buy by hand in FOMO at the same moment. These rules are not backtested: watch the LAUNCH ledger in TEST before switching it on in LIVE.

### FOMO

FOMO has no public API: its token pages are share links into the app. What the desk does instead:

- Every token in *Candidates*, *Open positions* and *Watch* has a **FOMO** link that opens it in the FOMO app.
- *Watch → Load wallet holdings* lists what your FOMO wallet holds (paste its address), so you can set exit levels for each with one click and get alerts.
- *Learn from wallet* in the strategy assistant reads your FOMO wallet's trades.
- FOMO's *Migrated* list is pump.fun graduations, which the desk reads directly from the chain.

### Watch: exit rules for tokens you hold yourself

The *Watch* section (sidebar: Watch) guards tokens you bought outside the desk, on FOMO, in Phantom or anywhere else. Add the token's CA and the wallet that holds it, then set any of these levels:

- **Exit at market cap ≤** (floor), e.g. `30M`.
- **Trailing stop**, in % below the highest market cap seen since you added the token, e.g. `25`.
- **Take profit at market cap ≥** (target), e.g. `80M`.

How it runs:

- Market caps (DexScreener) are checked every 15 s and the wallet balance every minute, whether TEST or LIVE runs or not, as long as the dashboard runs.
- A level must be crossed in **two checks in a row**, so one bad data point never fires.
- A rule fires once. **Re-arm** it to watch again; the trailing stop's peak then restarts at the current market cap.
- Rules and alerts are kept in `data-desk/watch.json`.

**Alert** (any wallet) notifies you in three places:

- the dashboard;
- browser notifications (press *turn on*);
- your phone, when one of these is set in `.env`:
  - `DESK_NTFY_TOPIC=<long random name>`, then subscribe to that topic in the free ntfy app;
  - `DESK_TELEGRAM_BOT_TOKEN` and `DESK_TELEGRAM_CHAT_ID` for Telegram.

**Sell automatically** is available only for the local-key wallet (`DESK_LIVE_SIGNER=local-key`).

- It sells the wallet's whole balance through the same guarded path as a desk exit: Jupiter quote, route, pre-flight checks, signature persisted before broadcast, confirmation, then the empty account's rent is reclaimed.
- Tokens a desk strategy holds in the same wallet are left alone.
- A sale interrupted by a restart is never retried: check its signature on Solscan.
- FOMO's in-app wallet is a different wallet that the desk cannot sign for, so FOMO holdings get alerts.

### Going LIVE (Phantom)

1. Pull, restart the dashboard, open it in the browser with the Phantom extension and **Connect Phantom**.
2. Switch to **LIVE**, then **START LIVE SESSION** and **Enable Auto-Confirm** in Phantom. Phantom offers Auto-Confirm only to domains it has approved ("No supported networks found for this domain" on a local dashboard); then every order needs your approval within 15 s.
3. Switch CRASH on (and FAIR off if you only want CRASH); both choices are saved.
4. Keep the PC awake and the browser running. The dashboard polls from a Web Worker, so a hidden or minimized tab keeps the session and Auto-Confirm alive; closing the tab or the browser ends LIVE (by design).
5. Budget: the 0.003 SOL reserve and ≈ 0.002 SOL account rent per new token come out of the wallet before entries.

### Going LIVE with the local key (unattended, opt-in)

Add to `.env` (the key is already there as `WALLET_PRIVATE_KEY`):

```
DESK_LIVE_SIGNER=local-key
DESK_LIVE_MAX_ENTRIES=10      # new positions per LIVE session; exits are never capped
```

- Restart the dashboard. LIVE then shows **SIGNED AUTOMATICALLY BY THE LOCAL KEY**, and START LIVE SESSION needs no Phantom connection.
- Every order is signed in the local dashboard process, with no approval. The session keeps running when the browser tab is closed; STOP LIVE SESSION (or stopping the dashboard) ends it.
- The key is read only by `src/desk/local-signer.ts`, only for the LIVE engine. It must match `WALLET_PUBLIC_KEY` when that is set, and it is never logged, displayed or put in the desk environment. TEST never receives a signer.
- All other rails are unchanged: the 0.003 SOL reserve, the max drag per strategy, unsigned RPC simulation and pre-flight before signing, the signature saved before broadcast, and a halt (never a retry) when an outcome is unknown.
- CRASH is still off in LIVE until you switch it on (the choice is saved). Remove `DESK_LIVE_SIGNER` to go back to Phantom approvals.
- **Still asked to approve in Phantom?** Then the desk did not see the setting. The LIVE start line in the telemetry says `every order needs a Phantom signature` instead of `signed automatically by the local key`. Check that the line is in `.env` in the repo root (the same file as `RPC_ENDPOINTS`), that the file is saved, and restart the dashboard.

### EXIT NOW

Every open position has an **EXIT NOW** button in *Open positions*. It sells the whole position through the normal SELL path: the same guard, the strategy's exit slippage, and the same signer (the local key signs at once; with Phantom you approve within 15 s). While the desk runs, the position loop sells on its next tick and retries until the position is gone. With the desk stopped, one attempt runs immediately, and you can press the button again. A token bought outside the desk is not in its ledger; sell it in your wallet.

### A held token without a sell route

When a pool is drained or delisted, Jupiter answers its quotes with HTTP 400 (for example `COULD_NOT_FIND_ANY_ROUTE`). That refusal concerns one token. It is not treated as a Jupiter outage, so it never pauses quotes, entries or exits for other tokens. (Before this fix, three refusals paused every Jupiter call for 30 s, and one rugged TEST position blocked all entries for a day.)

The position shows **NO ROUTE since …** under *Open positions*. It is re-quoted every 2 minutes, and its exit rules resume as soon as a route returns. After 30 minutes without a route:

- **TEST** books it as a SELL at zero (`WRITE-OFF`), the realistic outcome.
- **LIVE** keeps it in the ledger because the tokens stay in the wallet, but it no longer occupies a strategy slot.

### Scale-up ladder ($10 → $100 → $1K → $10K per entry)

Advisory only — the desk never changes a size by itself. A strategy shows READY for the next rung after ≥ 20 closed trades with positive net PnL, profit factor ≥ 1.3 and a max drawdown within half its sleeve. Paper fills ignore latency and MEV, so confirm with LIVE fills before sizing up real money. The next size also needs pool liquidity of about 50× the entry (≈ 2 % impact); most sub-$1M meme pools cannot absorb $1K+ orders.

### Signal tape and replay

Every scan appends the market snapshot of each pumping young pool (price, market cap, liquidity, pool age, 5m volume, buys/sells, concentration, CRASH signal) to `data-desk/tape-<MODE>.jsonl`.

```
npx tsx src/scripts/desk-replay.ts --ledger data-desk/ledger-PAPER-CRASH.json [--sizes 2,10,100,1000,10000] [--horizon-min 30]
npx tsx src/scripts/desk-replay.ts --mint <MINT> --entry-at <ISO|ms> --entry-price <USD>
```

The replay recomputes each trade from GeckoTerminal minute candles under several exit rules (current CRASH rules, no take profit, a 50 % runner, hold) and entry sizes, with a constant-product impact estimate from the pool's depth. Downloaded data is cached (`data-desk/replay-cache`), so reruns give the same numbers. Minute candles hide the order of moves inside a minute; the replay assumes losses first, so it can understate what the 2-second exit loop achieves.

### Backtest on every graduation

```
npm run desk:backtest -- --hours 12 [--size 2] [--fixed-usd 0.02] [--mints A,B] [--out backtest.json]
```

Reads every pump.fun graduation of the last hours from the chain (the whole universe, not only tokens that pumped), each pool's depth and 24 h volume (DexScreener) and its minute candles (GeckoTerminal), then applies the CRASH entry rule minute by minute and replays each entry. Every trade pays sized impact, 0.3 % venue fee per side, fixed network costs and a 3 % slippage on stop-type exits. It searches entry rules (pool age, 5-minute move, volume, market cap, pullback entry) and exit rules (stop, take profit, trailing, profit lock, hold time) and ranks them by the weaker of two time halves, so a rule that only worked in one stretch does not win. `--mints` prints, for named tokens, what the pool did and when the current and best rules would have traded. Buy/sell ratio and holder concentration are not in candles and are not modelled. Only `RPC_ENDPOINTS` is read from `.env` (through the desk allowlist); everything downloaded is cached in `data-desk/backtest-cache`.

### Costs per trade (and what the desk does about them)

- **Token-account rent** (~0.0015–0.002 SOL, about 9 % of a $2 position) leaves the wallet with every first buy of a token. With the local key the desk closes the emptied account right after the exit and the rent comes back; a LIVE session also closes empty accounts left by earlier desk trades once, after its first scan. With Phantom the accounts stay open (closing them would need another approval per exit). The ledger charges the rent to the trade until it is reclaimed, so net PnL matches the wallet. TEST closes accounts on paper.
- **Exit priority fee**: at most 1 % of what the sell returns (at least 50,000 lamports, never above `MAX_PRIORITY_FEE_LAMPORTS`). Entries stay bounded by the drag budget.

### TEST sleeve cycles (no manual reset needed)

When a TEST sleeve can no longer fund an entry and holds no open position, the desk archives it as a completed cycle (`ledger-PAPER[-CRASH].cycle-<time>.json`) and re-funds it at its planned capital. Trades, realized PnL, stats, the scale ladder, the ledger view and re-entry cooldowns all continue across cycles, also after a restart. LIVE never re-funds anything: the wallet is the budget.

### Holders

Each candidate shows its holder count and the share of the 10 largest wallets; its detail view lists the largest holders (from the 20 largest token accounts) with their share of supply, marked **wallet**, **pool / curve / program** (off-curve owners such as the PumpSwap vault or the bonding curve, which are excluded from concentration) or **DEV** (the pump.fun creator), each linked to Solscan, plus links to the token on FOMO and Solscan. The largest holders are refreshed every 3 minutes for the 8 most active candidates per scan (standard RPC calls); the holder count every 10 minutes for 3 per scan, through the DAS `getTokenAccounts` method (Helius and compatible RPCs, up to 2,000 owners, shown as "2,000+" beyond). An RPC without DAS shows the count as "?" with the reason.

### Candidates

The *Candidates* table separates the scan from the strategies. The scan columns are market data, FOMO-style:

- **Age** since the token appeared (its pump.fun creation, or its oldest pool), never the age of whichever pool is deepest now; below it, *grad.* = time since its first AMM pool (graduation), or *on curve*;
- market cap, liquidity (with the quote token when it is not SOL/USD), volume 5m and 1h, transactions in the last hour (buys / sells), price change 5m, 1h, 6h, buy/sell ratio, holders, X account and followers, mint/freeze authority, risk flags.

The **Strategies** column shows every *enabled* strategy's verdict: ✓ entry-ready, or the first rule it misses. A strategy that is off says nothing, and its rules no longer appear as the token's status in the telemetry (FAIR's buy/sell ≥ 1.4 and fair-launch gates were shown as "FILTERED" for every token while FAIR was off).

Pools quoted in another token count when they hold the real liquidity: at least $20K and 5× the best SOL/USDC/USDT pool (COMMIE on 1 Oct traded against AMC with $116K; its SOL pools held $6K, so the scan dropped it).

The copycat guard (an older same-name token at least 3× bigger) now applies only when that namesake is at most 3 days older or still the busier market, and never to a launch whose own X account posted its CA. WIRED on 1 Oct was blocked by a quiet 5-day-old WIRED and then ran from $75K to $2.7M.

### Why a token was not entered

Each candidate shows, per strategy, why this scan did not enter it: held by the other strategy, re-entry cooldown, the guard's last block and when it is retried, slots in use, or an unfundable sleeve. A candidate that was not re-assessed in the last completed scan is marked **STALE** and is never traded on; held tokens and the watchlist are always assessed first (up to 120 tokens per scan). Telemetry keeps separate windows for scanner outcomes and for signals, orders, positions and PnL, so executions never scroll out behind filter messages.

### Reset TEST

With TEST stopped, **RESET TEST** archives both paper ledgers and their cycles (`ledger-PAPER*.archived-<time>*.json`, never deleted) and restarts every sleeve and its statistics at the planned capital. Each new token locks ≈ 0.002 SOL of account rent in TEST exactly as in LIVE, so small sleeves run dry after several trades; reset, or raise `DESK_PLANNED_CAPITAL_USD` / `CRASH_CAPITAL_USD` for long TEST runs (they size TEST sleeves only).

## Pipeline

`SCAN → SIGNAL → FILTERS → QUOTE → DEX / ROUTE → SIMULATION → PRE-FLIGHT → PHANTOM SIGNATURE → SUBMITTED → CONFIRMED → POSITION → EXIT → REALIZED PnL` — every stage writes a timestamped event.

- **Discovery**: DexScreener top/latest boosts and latest profiles, GeckoTerminal trending and new pools, every pump.fun → PumpSwap graduation of the last 30 minutes read from the chain (signatures of pump.fun's migration authority, ≈ 2 per minute), plus the desk watchlist. Held tokens, graduations and the watchlist are assessed first. Discovery gets 12 s per scan and GeckoTerminal-bound evidence (trade flow, launch history) 20 s; unfinished requests are cancelled, so a rate-limited provider never stretches a scan to minutes.
- **Tiers**: trending / migrated below $1M (priority below $100K); ultra-early $2K–$10K, followed on the bonding curve up to $100K. Ultra-early tokens are classified (EARLY, PROMISING, WATCH, HIGH RISK, REJECT) and are never executed until they pass every hard gate as migrated tokens.
- **Hard gates** (blocking): 5m volume > $15K, liquidity > $10K, buy/sell > 1.4, mint and freeze authority revoked, no dangerous token extensions, top-10 wallet concentration ≤ 35 %, largest wallet ≤ 10 %, liquidity ≥ 3 % of market cap, liquidity drop < 25 % since the last scan. Developer allocation (≤ 5 %) and wash/clustering (≤ `RS_MAX_WASH_RATIO`) block when known and are flagged when unknown. An UNKNOWN blocking gate keeps a token on the watchlist.
- **Fair launch** (blocking, also for the TEST drill): a pump.fun curve that graduates within 5 minutes of launch was bought out at creation, and a market cap of $250K or more within the first 5 minutes is not a fair launch. Checked once per token from GeckoTerminal pool history.
- **Momentum confirmation** (FAIR): two consecutive scans with all gates passing, acceleration ≥ 1× and a non-negative 5-minute price change.
- **Scores**: FUNDAMENTAL, SOCIAL, MARKET, ONCHAIN, RISK, MOMENTUM, each with its factors. They rank candidates; they never override a gate.
- **Evidence**: OBSERVED / DERIVED / INFERRED; missing data is shown as UNKNOWN or UNVERIFIED, never filled in.
- **Exits** (FAIR; CRASH above): checked every 5 seconds, independent of the discovery scan. Early warnings first — pool liquidity 30 % below its level at entry, or the known pump.fun creator selling — then `RS_STOP_LOSS_PCT`, `RS_TAKE_PROFIT_PCT`, trailing stop and `RS_MAX_HOLD_MIN`, valued with an executable Jupiter quote. Exits are never blocked by TEST cash or the max-drag cap; a TEST exit that cannot be simulated is booked at the executable quote.
- **History**: besides the on-screen window, every event is appended to `data-desk/events-<MODE>.log.jsonl` (rotated at 20 MB).

## TEST without Phantom and the TEST drill

- If Phantom is not connected, TEST uses `WALLET_PUBLIC_KEY` from `.env` to build and simulate orders. It is only an address: the private key is never read and nothing is signed. LIVE always requires Phantom.
- **TEST drill** (button next to STOP TEST, or `desk:paper --drill`): when nothing qualifies, the desk opens a paper position in the best trending candidate whose safety gates pass (mint/freeze authority revoked, no dangerous extensions, AMM liquidity > $10K). Volume, buy-pressure, concentration and momentum gates are bypassed; the execution guard (reserve, max drag, simulation) is not. Drill fills are marked `DRILL` in the ledger. The drill verifies the mechanics (position → exit → PnL); it says nothing about the strategy's edge.

## X account data

The launch radar reads X profile pages as x.com serves them to logged-out visitors (followers, account age, posts, views) without any key. For the other candidates, and for the X feed, put your own bearer token in `.env` as `X_BEARER_TOKEN`; it is read by the local server only. Without it those X metrics stay UNVERIFIED and the X feed is off. An X account older than the project is flagged (`SOCIAL AGE MISMATCH`), never rewarded.

## Headless TEST run

```
npm run desk:paper -- --address <YOUR_PUBLIC_KEY> --scans 6 --probe
```

Runs TEST on live data (both strategies; `--no-crash` / `--no-fair` to switch one off), prints telemetry, candidates, pre-flight, ledgers and strategy stats. `--probe-mint <MINT>` runs one real quote → build → simulation → pre-flight without booking. It never signs and never reads a private key.

## Known limits

- With $2 entries, the 1.5 % max drag (including 1 % slippage tolerance) blocks many meme-coin routes before a transaction is built; the reason is shown on the event. CRASH allows 5 % for exactly this reason.
- Priority fee: each order authorizes a priority-fee budget (`MAX_PRIORITY_FEE_LAMPORTS`, within the drag cap for entries) and Jupiter's `PRIORITY_LEVEL` estimate picks the actual fee inside it; the fee actually charged is measured before signing.
- `JUPITER_MAX_RPS` (default 1) limits how often positions can be valued; with several open positions each check takes that many seconds.
- Empty token accounts are not closed automatically (closing needs its own Phantom signature), so their rent stays locked.
- Token-account rent (≈ 0.0015–0.002 SOL per new token) stays locked after an exit until the account is closed; the desk reports it as reserved, not as a fee.
- The real Phantom signature and Auto-Confirm flow can only be verified by the wallet owner.

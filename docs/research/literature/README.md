# Literature: status, gate gaps and hypotheses

Brief: [docs/swarm/briefs/RESEARCH.md](../../swarm/briefs/RESEARCH.md). Run of 3 Oct 2026, branch `claude/research-literature`.

## Status: mostly blocked. One card, from a source the owner fetched

Cards: [2026-nobrainflip-top-100-fomo-wallets.md](2026-nobrainflip-top-100-fomo-wallets.md): a practitioner
analysis of FOMO's top 100 wallets, read from the full text the owner pasted on 5 Oct (W1–W3).

The brief requires every claim to come from a source that was actually opened. In this cloud session the network
policy blocks every host that holds the papers. Web search works, but it returns only titles and links, and a search
snippet is not an opened source. So this run contains **no literature cards and no literature-backed numbers**.

Hosts tried on 3 Oct, all blocked by the egress proxy (WebFetch `EGRESS_BLOCKED`, or curl with no connection):
arxiv.org, export.arxiv.org, dl.acm.org, usenix.org, mdpi.com, eprint.iacr.org, ideas.repec.org, researchgate.net,
semanticscholar.org, papers.ssrn.com, link.springer.com, sciencedirect.com, doi.org, en.wikipedia.org,
web.archive.org, xusheng-xiao.github.io, netsec.ccert.edu.cn, wwwusers.di.uniroma1.it, docs.jito.wtf, solana.com,
helius.dev, pump.fun, medium.com, dune.com, chainalysis.com. www.smartcontractresearch.org did not resolve. Only
github.com, api.github.com, raw.githubusercontent.com and the package registries answered.

**To unblock:** add the hosts above (at least `arxiv.org`, `export.arxiv.org`, `dl.acm.org`, `www.usenix.org`,
`papers.ssrn.com`, `eprint.iacr.org`, `docs.jito.wtf`) to the environment's allowed domains, or pick a broader
network access level. Then rerun this brief. The reading list below is ready.

### Reading list, queued but not opened

These links came from web search results. Nothing here has been read. Titles and authors are the only details the
search results gave. No numbers are quoted.

| Topic | Source | Link (from search, not opened) |
| --- | --- | --- |
| 1 Scams | Xia et al., "Trade or Trick? Detecting and Characterizing Scam Tokens on Uniswap Decentralized Exchange", Proc. ACM Meas. Anal. Comput. Syst. 5(3) (SIGMETRICS 2022) | https://arxiv.org/pdf/2109.00229 · https://dl.acm.org/doi/10.1145/3491051 |
| 1 Scams | Cernera, La Morgia, Mei, Sassi, "Token Spammers, Rug Pulls, and Sniper Bots: An Analysis of the Ecosystem of Tokens in Ethereum and in the Binance Smart Chain (BNB)", USENIX Security 2023 | https://arxiv.org/pdf/2206.08202 |
| 1 Scams | Mazorra, Adan, Daza, "Do not rug on me: Zero-dimensional Scam Detection" (arXiv 2201.07220; journal version in *Mathematics* 10(6) 949, 2022) | https://eprint.iacr.org/2022/350 |
| 1 Scams | "Serial Scammers and Attack of the Clones: How Scammers Coordinate Multiple Rug Pulls on Decentralized Exchanges" (WWW 2025) | https://arxiv.org/pdf/2412.10993 |
| 1 Scams | "SoK: A Taxonomic Analysis of DeFi Rug Pulls: Types, Dataset, and Tool Assessment" | https://dl.acm.org/abs/10.1145/3728900 |
| 1 Scams | "TM-RugPull: A Temporally Sound, Multimodal Dataset for Early Detection of Rug Pulls" | https://arxiv.org/html/2602.21529v1 |
| 1 Scams | "LROO Rug Pull Detector: A Leakage-Resistant Framework Based on On-Chain and OSINT Signals" | https://arxiv.org/pdf/2603.11324 |
| 2–7 | Victor & Weintraud (WWW 2021); Kamps & Kleinberg (2018); La Morgia et al.; Bailey & López de Prado (deflated Sharpe ratio, PBO); Harvey & Liu; Jito docs; Kelly sizing | not searched yet: their hosts are blocked too |

## What the code shows without the literature

The section below cites only this repository, which was opened and read. It does not say what the literature
recommends. Once the sources are open, each point gets checked against them.

### Gate gaps, ranked (updated 5 Oct after the CTO's gate changes)

Fixed on the base branch since 3 Oct: live calls are judged at the gate's costs (`calls.ts:161`, `GATE_COSTS`). The
gate now buys at the owner's speed (`PHONE_FILL_MS` 45 s), runs a bootstrap luck test with Holm's correction at 0.05
over all rules in the run, and drops a rule that is carried by its best 1 % of trades. That covers old gaps 1, 2 and
5. Still open:

1. **The 48 h window is too short for the luck test it now applies.** See "What it takes to pass" below: at n ≈ 100
   a rule needs about +11 % average after costs. A realistic edge of a few percent needs several hundred to a
   thousand later trades, which the narrow groups only reach over weeks of data. This is not a change to the
   criteria: it is the window the criteria are applied to. It is for the owner and the CTO to decide.
2. **`xCaPost` has look-ahead against the live observer.** The backtest counts a CA post as known 30 s after its post
   time (`dataset.ts`, `post.at + X_POST_LATENCY_MS <= end`). The live observer reads X only at +20 s and +6 min,
   so a post made at +40 s is in the backtest at 120 s but unknown live until about +6 min. The catalog does not use
   the field yet (`rules.ts`). Any rule that does must use the read time (`XT` obs ≤ T); see R3.
3. **Repeated looks.** The gate reruns every 6 h on overlapping windows. Holm corrects within a run, not across
   runs, so a rule can pass once by luck in one of many runs. Suggestion: require a pass in two runs whose later
   periods do not overlap before the first CALL.
4. **One split, no gap between the periods.** A 60-minute hold from the last tuning launches can overlap the first
   validation launches. A one-hour embargo at the cut would remove that.
5. **No price after graduation.** A held coin that graduates is sold at the graduation price in the simulation
   (`direct.ts`), so a coin that graduates and then runs on the pool scores about 0 %. The 5 Oct case "Web"
   graduated 56 s after launch, and every rule judged it at −0.36 % ([CASE-2026-10-05-WEB.md](CASE-2026-10-05-WEB.md)).
   Fix: post-graduation pool prices, at least as labels (G1).

### Hypotheses (from the desk's own design, not the literature)

These are pre-registered so that the curiosity scout can test them on the observer's data. None of them claims
backing from a paper. All of them use only `Features` fields known at the decision time, or a new feature defined
here with no look-ahead.

| # | Hypothesis | Features / new feature | Delay | Gate verdict needed | Value | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | Launches whose creator has launched before and **never** graduated underperform first-time creators (serial creators) | `creatorLaunches ≥ 2 && creatorGraduations = 0` as an exclusion on `organic` | 60, 120 s | `organic` minus serial creators beats `organic` on the later 40 %, ≥ 100 trades, and is positive after the $0.10 cost | high: a cheap rug filter | low: both fields exist |
| H2 | Concentrated early buying predicts a rug better than buyer count does | `top5 ≥ 0.6` or `hhi ≥ 0.25` as an exclusion on `buyers5` / `broad15` | 30, 60 s | the excluded set's later mean is lower than the kept set's, and the kept set passes the gate | high | low |
| H3 | Same-slot buyers at creation (bundles) mark rugs. New feature `bundleShare`: the share of tokens bought, up to t, by wallets other than the creator whose trade sits in the creation slot or the next one (`Trade.slot`, observed ≤ t) | `bundleShare ≥ 0.2` as an exclusion | 15, 30, 60 s | as H2 | high | medium: a new feature in `dataset.ts` and a live-parity test |
| H4 | The gate's pass rate under permutation: shuffle each launch's group labels and rerun the gate 100 times. The share of reruns where any rule qualifies is the gate's false-pass rate | none (a test of the gate itself) | all | this sets a bar, it is not a call. If it is above 5 %, tighten the gate before trusting a CALL | very high: it tells whether a future CALL means anything | low: offline script |

## Next rules for the gate, ranked (5 Oct, at phone speed)

Context from the main session (5 Oct, 12:05 UTC run): 48 h, 26,496 normal launches, bought 45 s after the call.
**0 of 40 rules qualify.** The best is "organic demand and an own X account" at 120 s, with a +100 % target, a
−20 % stop and 60 min max: later average −0.9 % (n 95, needs 100), target hit 15 % (needs 16 %), luck p 0.58 (needs
≤ 0.0013). Every other rule is −7.5 % or worse; live calls lose 6–8 %.

### What it takes to pass (my estimate, not gate output)

Holm's first threshold over 40 rules is 0.05 / 40 = 0.00125, a one-sided z of about 3.0. So a rule needs a later
average of at least **3.0 × σ / √n**.

To estimate σ for the best rule's exit, I treat the outcomes as two points:
- a winner nets about **+90 %** (2× gross, 1.25 % fee per side, $0.10 on $2);
- with a 15 % hit rate and a −0.9 % mean, the losers then average about **−17 %**;
- that gives **σ ≈ 38 %**.

The real distribution has more spread, so these bars are optimistic:

| Later trades n | Mean needed after costs | Target hit rate needed (+100 % exit, losers at −17 %) |
| --- | --- | --- |
| 100 | ≈ +11.5 % | ≈ 27 % |
| 300 | ≈ +6.6 % | ≈ 22 % |
| 1,000 | ≈ +3.6 % | ≈ 19 % |

The best rule hits 15 %. **No filter on today's features is likely to lift it to 27 %.** Passing needs either a much
stronger signal or several hundred later trades, which means more data than 48 h (gate gap 1). This shapes the
ranking below: rules that keep their sample large and lose little to the 45 s delay come first.

Pre-register **only these three**. Each new rule raises Holm's count (40 → 43, a threshold of 0.00116). All three
use the existing exit menu, chosen on the tuning period as usual.

| Rank | Rule | Decision | Definition (Features at T, no look-ahead) | Why it should beat −0.9 % | Exits | Sample needed | Data / cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `steady300`: steady, broadly held curves | 300 s (a new catalog delay; 300 is already a `DECISION_S` time) | `progress` 0.15–0.60 · `velocity60` > 0 and ≤ 0.15 (rising under 15 % of the curve per minute) · `effectiveBuyers` ≥ 10 · `top1` < 0.15 · `top5` < 0.45 · `devSold` false · `sellShare` < 0.45 · not `mayhem` · not `gapInWindow` | The 45 s delay costs most on fast curves: the price runs while the owner opens FOMO. A slow, rising curve loses little in 45 s. By 300 s most sniper and bundle dumps have happened, and broad holding with the dev still in is the organic profile without the sprint. My inference: the best rule today is at the latest delay offered (120 s), which fits "later is better at phone speed" | `EXITS` menu: +40/+100 %, stop −20/−35 %/none, 15/60 min | ≥ 100 later trades, realistically 300+ (mean ≥ +6.6 %). Count the matches in the last 48 h first; under 250 means the window must grow | none new; one catalog delay |
| R2 | `organicXClean`: the best rule minus its rug markers | 120 s | `organic` and `hasX` (today's best group), excluding `creatorLaunches` ≥ 2 with `creatorGraduations` = 0 (serial creators, H1), and excluding `top5` ≥ 0.6 (concentration, H2) | It starts closest (−0.9 %, 1 point of hit rate short of break-even). The exclusions remove launches whose losses are structural (repeat creators who never graduate, a few wallets holding the supply). It only needs to remove losers faster than winners | Fixed in advance to today's best: +100 % target, −20 % stop, 60 min (no exit search, which also removes tuning freedom) | It loses sample (95 → fewer). At ~5 later trades an hour, n ≈ 300 needs about 6 days of data and n ≈ 1,000 about 3 weeks | none new |
| R3 | `ownCaSeen`: the project posted its own CA, as the live observer saw it | 420 s (after the +6 min X read plus fetch time) | `organic` and a new feature `xCaPostSeen`: an `XT` record by the launch's own linked handle, with `mint` = 1, **observed (obs) ≤ T** and posted ≤ T · and `xFollowers` ≥ 300 from an `XP` read with obs ≤ T | A team that posts its own address is the strongest non-chart signal in the desk's cases (AGENCY; the Sir Cat copycat had no own CA post and was rightly skipped). Using the read time removes the look-ahead in `xCaPost` (gate gap 2) | `EXITS` menu | Probably small, because own CA posts by 6 min are rare. Count them in the ledger first; likely 1–2 weeks of data for n ≥ 100 | one new feature with a live-parity test, one catalog delay |

**Results, gate run of 5 Oct 13:25 UTC** (main session; 48 h, 26,295 normal launches, phone fill 45 s, Holm over 42
rules): 0 of 42 qualified.

| Rule | Tuning | Later | Hit vs needed | Luck p | Status |
| --- | --- | --- | --- | --- | --- |
| R1 `steady300` (chosen exit: +40 %, −20 %, 60 min) | n 25, −18.3 % | n 15, +1.9 % (−0.3 % without its best trade) | 47 % vs 43 % | 0.41 | **Undecided: too rare for 48 h.** About 40 matches per 48 h (≈ 20 a day). 100 later trades means ≈ 250 matches in the window (later = 40 %), so **≈ 13 days of data**. Re-judge then, unchanged |
| R2 `organicXClean` (fixed +100 %, −20 %, 60 min) | n 160, −1.5 % | n 42, −8.4 % | 14 % vs 22 % | 0.91 | **Failed as registered.** Worse than `organicX` alone. Do not tune it |
| R3 `ownCaSeen` | — | — | — | — | **Dropped in this form** (owner, 5 Oct): a CA in the bio or a post is not a safe signal, rather the opposite, unless the project is an established brand or company. What is kept is the inverse: **R3-inv**, own CA in the bio or a post as a *risk flag*, unless the brand is established. "Established" is not yet defined as a feature: it needs a definition fixed before testing, for example a gold or grey check, or an account older than 180 days with ≥ 10K followers |

Best other rule in the run: `sprintBroad@60s`, −3.6 % later (n 195).

**R1–R3 cannot catch fast graduates.** A coin like "Web" (5 Oct) has already graduated at 120–420 s, so it is
not simulated at all. G1 in [CASE-2026-10-05-WEB.md](CASE-2026-10-05-WEB.md) (a decision at graduation, priced on
the pool) is the candidate for that class. It needs post-graduation prices first (gate gap 5). The 5 Oct case "Using"
([CASE-2026-10-05-USING.md](CASE-2026-10-05-USING.md)) adds a cheap feature family, tweet coins (T1, T2), and a
test of the dev-sold filter (D1). The GOLDEN POCKET alerts on $1M+ openers
([CASE-2026-10-05-GOLDEN.md](CASE-2026-10-05-GOLDEN.md)) add an exclusion for G1 (P1). CRWLR ([CASE-2026-10-05-CRWLR.md](CASE-2026-10-05-CRWLR.md)): an OPEN alert at $13.5K, then an INFO at $12K, that
ran 4× to graduation through a −47 % dip; a CA-detection bug (`xCaPost` misses a CA on its own line); F1′, I2.
The execution path, ranked changes for the CTO:
[EXECUTION.md](EXECUTION.md) (X1–X8).

**Pre-registered 5 Oct 13:05 UTC (fast graduates).** Both rules count in the Holm family when tested, and neither
threshold moves after this date. Neither can be tested until the gate has post-graduation pool prices (gate gap 5),
which is code work for the main session.

| # | Rule | Decision | Definition (no look-ahead) | Exits | Gate |
| --- | --- | --- | --- | --- | --- |
| G1 | Fast graduate, ≤ 180 s | at graduation (the `X`/`G` record's obs), filled 45 s later | curve completed ≤ 180 s after creation · `top1` < 0.10 · `effectiveBuyers` ≥ 30 at graduation · `devSold` false · not `mayhem` | +40/+100 % targets, −30 % stop, 60 min and 24 h, on pump-amm pool prices | standard gate on pool prices |
| G1b | Fast graduate, ≤ 300 s | as G1 | as G1, completed ≤ 300 s after creation | as G1 | as G1 |

**INFO as two strategies (owner, 5 Oct: "within the first 30 min, more time is more risk"; an INFO coin needs a
check after graduation).** These replace F1/F1′ and are pre-registered on 5 Oct before scoring any INFO data. Both
count in the Holm family.

| # | Rule | Decision | Entry | Exits (fixed) | Data |
| --- | --- | --- | --- | --- | --- |
| F1a | **INFO, early trade**: every `INFO` (own CA post by the project account, checkmark or ≥ 1,000 followers) | the INFO record's obs | 45 s later (phone) and 2 s later (bot), on the curve | +100 % target, −35 % stop, **30 min max**; a graduation inside the hold sells at the graduation price | the ledger as it is (curve candles, `INFO`) |
| F1b | **INFO coin after graduation**: an INFO coin whose curve completes within 6 h of its INFO, excluding a pool that opens ≥ 10× its graduation value (P1) | the `X`/`G` record's obs (like G1) | 45 s later, on the pump-amm pool | +100 % target, −30 % stop, 60 min and 24 h | post-graduation pool prices (gate gap 5) |

A coin can be traded by both: F1a in its first 30 minutes, then F1b after graduation. They are judged separately.
CRWLR and Web are known cases and are excluded from both.

Kept out of the gate for now:
- W1 (tracked wallets) waits for the wallet addresses.
- E1–E3 (established coins) belong to the ladder, not this launch gate. The ladder's first numbers (5 Oct, 685 coins,
  554 samples) argue for small targets and no MICRO tier: within 24 h, only 6 % doubled and 24 % halved first, MICRO
  coins halved first 55 % of the time, and MID/HIGH coins doubled 1–2 % of the time.

Open items: the @roundtablespace post of 4 Oct is still unread (the owner can paste its text). @massivedotgg was
read in part ("this is massive. 10.10.26 Drop your $SOL address"). On the watchlist: SI is 83 % below its high, with
a mass-launcher developer and holders −2.3 %/24 h; WWW is 93 % below its high, with liquidity −31 %/24 h. Neither
fits E1 (holder growth).

## Best practice the desk most obviously lacks

Updated 5 Oct: the gate now corrects for the number of rules (Holm over a bootstrap p-value), which was the gap
named here on 3 Oct. What the desk now most obviously lacks is **enough sample for that test**: the 48 h window
gives the best rule 95 later trades, while a realistic edge needs several hundred (gate gap 1).

See also [FLAG-LEDGER.md](FLAG-LEDGER.md): the owner's idea of scoring every flag (watchlist, INFO, known cases) as
a research point, with three more hypotheses (F1–F3). [NARRATIVE-REGIME.md](NARRATIVE-REGIME.md): narratives, leaders
and market breadth across the whole memecoin market (N1–N4, E1–E2). [VOICES.md](VOICES.md): a scorecard
for 1,000+ X voices grown from the ledger, the TJR "name coin" pattern (V1–V4).
The brief's topic 4 sources (deflated Sharpe ratio, PBO, Harvey and Liu) are the ones to open first to choose the
correction, once the hosts are allowed.

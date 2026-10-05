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

### Gate gaps, ranked

1. **The live check is judged at a lower cost than the backtest.** `research-qualify.ts:23` runs the gate with
   `fixedUsd` 0.10. The live judge, `CallEngine` (`calls.ts:159`), falls back to `DIRECT_DEFAULTS.fixedUsd` = 0.03
   (`direct.ts:18`), because `research-observe.ts:59` passes no `costs`. On a $2 trade that is 3.5 percentage points
   per trade in the live judge's favour. The rule "no average loss over 30 live calls" is therefore easier to pass
   than the backtest it is meant to confirm. This is a one-line fix for the CTO: pass the gate's costs to
   `CallEngine`.
2. **Many candidates, no correction for searching.** The catalog has 10 groups. Their delays give 40
   (group, delay) pairs: 6 groups × 5 delays, 2 × 2 (`organic*` from 60 s), and 2 × 3 (`sprint*` from 30 s). Each
   pair picks the best of 12 exits (or 6 fast exits), so the tuning period searches 34 × 12 + 6 × 6 = **444
   configurations**. Then **40 winners** go to the later period, and any one that passes reaches the phone. The
   later-period test is "mean > 0, n ≥ 100, hit rate ≥ break-even". It has no significance level and no adjustment
   for the 40 parallel tries. With fat-tailed returns, one or two of 40 rules can have a positive mean on 100 trades
   by chance alone.
3. **Repeated looks.** The gate reruns every 6 h on a rolling 48 h (`docs/RESEARCH.md`). Each rerun is another try
   on overlapping data. A rule that passes once becomes a CALL at once, and the 30-call live check only removes it
   later.
4. **One split, no gap between the periods.** The split is a single cut at 60 % of launches by creation time. A
   15- or 60-minute hold from the last tuning launches can overlap the first validation launches, and the same
   market hour lands on both sides. The gate has no purging, no embargo and no second fold.
5. **Mean only.** The gate has no check on how the profit is spread: the median, the share of profit from the top
   few trades, or the profit with the best 1–2 % of trades removed. A rule carried by one GOOP-HEAD-like spike
   passes the same as a steady one.

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

## Best practice the desk most obviously lacks

From the code alone: **a correction for how many rules are tried before one is called** (gap 2, measured by H4).
The research platform's experiment pipeline already computes a deflated Sharpe ratio (`experiments/runner.ts`). The
gate that decides what reaches the phone (`qualify.ts`) does not use it.

See also [FLAG-LEDGER.md](FLAG-LEDGER.md): the owner's idea of scoring every flag (watchlist, INFO, known cases) as
a research point, with three more hypotheses (F1–F3). [NARRATIVE-REGIME.md](NARRATIVE-REGIME.md): narratives, leaders
and market breadth across the whole memecoin market (N1–N4, E1–E2). [VOICES.md](VOICES.md): a scorecard
for 1,000+ X voices grown from the ledger, the TJR "name coin" pattern (V1–V4).
The brief's topic 4 sources (deflated Sharpe ratio, PBO, Harvey and Liu) are the ones to open first to choose the
correction, once the hosts are allowed.

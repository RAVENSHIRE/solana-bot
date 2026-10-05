# Fundamentals: tiers, milestones, old highs and a security scan

A read-only research layer for coins beyond the micro-cap launch window, on any chain DexScreener and GeckoTerminal
cover. It answers three questions the desk's scanners do not:

- **Where does this coin trade?** Its market-cap tier and the round milestones around it.
- **Is the upside real?** "8× back to the old high" is only upside if coins that fell that far get back often enough.
  The old-high study measures that.
- **Is the contract safe enough to look at?** GoPlus (every chain) and RugCheck (Solana) before a coin reaches the
  phone. A scan lowers the chance of a rug; it does not rule one out.

Nothing here trades or sends alerts yet. Wiring the scan into the phone alerts is the next step, after the provider
answers have been checked on the PC (see *Checking the scanner* below).

## Commands

```
npm run research:fundamentals -- --token <address> [--chain solana] [--raw]
npm run research:fundamentals -- --study --tokens tokens.txt [--chain solana] [--horizon-days 30] [--drawdown 80] [--timeframe day|hour] [--out study.json]
```

Chains: `solana`, `ethereum`, `bsc`, `base`, `arbitrum`, `polygon`, `avalanche`, `optimism`. In `tokens.txt` one
address per line, or `chain:address` (`base:0x…`); `#` starts a comment.

## The token card

| Line | Meaning |
| --- | --- |
| Market cap, FDV, liquidity, 24 h volume and trades | DexScreener, from the deepest pair where the token is the base token |
| Age | The earliest of the token's pairs on that chain, a proxy for its launch |
| Tier | MICRO under $100K · LOW $100K–$1M · MID $1M–$10M · HIGH $10M–$100M · LARGE $100M and up |
| Next milestone | The next round market cap ($10K, $100K, $1M, $10M, $100M, $1B), how many × away, and how far through the decade it is (log scale) |
| One entry at about 2 % impact | 2 % of pool liquidity, the same rule as the desk's scale-up ladder. It says which tiers can carry which entry size |
| History | GeckoTerminal candles of that pair (hourly when younger than 40 days, else daily): the high, the drop from it, the multiple back to it, and when each milestone was first closed above |
| Security | PASS, WARN, BLOCK or UNKNOWN, with every finding and the status of each provider |

## The studies

Both run over the list you give and use daily bars by default. Market cap is price × today's supply, which is right
for fixed-supply memecoins and wrong for coins that minted or burned a lot since.

**Milestones.** For every coin and level, the first close above it after a close below it, and what followed within
the horizon: reached 2× the level, reached 10× (the next milestone), still above at the end, the largest gain and
drawdown. Round milestones are compared with two **non-round control levels** in the same decade (≈ 2.34× and
≈ 5.37× the milestone). Only a clear gap between round and control means round numbers matter. Without the control,
a breakout rate says nothing.

**Old high.** For every coin, its first close at least 80 % (`--drawdown`) below the running high, and whether a later
high reached the old high within the horizon. Coins that fell within their first 7 days are shown apart from older
ones.

Read the results with these rules:

- **Censoring.** An outcome is unknown, not negative, while its horizon is still running when the history was read.
  Unknown outcomes are left out of the rates and counted as *censored*.
- **Dead coins are data.** GeckoTerminal leaves out intervals without trades, so a dead coin's bars simply stop. Once
  the horizon is over, that is a known outcome (it did not come back), not missing data.
- **Intervals.** Every rate carries a Wilson 95 % interval. Two rates whose intervals overlap widely are not different.
- **Failed requests are counted apart** and left out. A blocked API never looks like a dead coin.
- **The list decides the answer.** A list made from coins that are still alive today (a trending page, a watchlist,
  coins you remember) only holds survivors, and every rate will be too high. Build the list *before* looking at
  outcomes: for example every coin the verified watch or the observer recorded on a past day, whatever happened to it
  since.

## The scan

| Provider | BLOCK | WARN | INFO |
| --- | --- | --- | --- |
| GoPlus, EVM chains | honeypot, cannot sell all, cannot buy, transfers pausable, owner can change balances, hidden owner, ownership can be taken back, self-destruct, creator made honeypots before, buy or sell tax above 10 % | mintable, upgradeable proxy, tax can be changed (also per wallet), blacklist, trading cooldown, external calls, source not verified, tax 3–10 %, largest wallet above 15 %, top-10 wallets above 50 % | on the GoPlus trust list |
| GoPlus, Solana | live mint authority, live freeze authority, balance-changing authority, non-transferable | mint can be closed, fee, hook or default frozen state can be changed, transfer hook, any transfer fee, the holder limits above | mutable metadata, listed as trusted |
| RugCheck, Solana | marked rugged, live mint or freeze authority | every risk it rates `danger` | every risk it rates `warn`, and its risk score |

Pools, lockers and other contracts or locked balances do not count toward the holder limits. The holder limits are
the same as the desk's CRASH gates.

Missing fields, or fields with an unexpected shape, read as unknown and never as safe. With no provider answering,
the verdict is **UNKNOWN**, not PASS.

### Checking the scanner

The field mapping follows the providers' public docs. It was built and tested against recorded answer shapes, because
the cloud environment that wrote it cannot reach these APIs. Before the scan gates any alert, run it on the PC for a
few known coins with `--raw` (one clean coin, one with a live mint authority, one known honeypot on an EVM chain), and
check that the printed findings match the raw answers.

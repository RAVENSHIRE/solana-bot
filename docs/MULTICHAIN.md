# Beyond Solana: one level at a time (owner, 5 Oct)

Owner, 5 Oct: "find ways that the desk not only trades Solana", then: **"first master SOL"**, "not all at once",
"look at it like levels", Monad and Arc last, and two separate keys (the Solana key stays; the EVM chains get their
own key, which works on all of them).

Two missed coins prompted it: **CLAUS** (Ethereum, $0 → $6.9M in 24 h; never seen) and **BONER** (Robinhood Chain;
recorded by the research ladder since 3 Oct at about $50M, $75M two days later; nothing turned it into a call).

## The levels

A level is **mastered** when all four hold on that chain:

1. **TEST:** one strategy with at least 100 trades, positive on average after the measured costs, and the gate's
   luck test passing (the same bar as the research gate).
2. **Stops hold:** the average stop fill lies within about 10 points of the stop level (CRASH's −35 % stop filled at
   −56 % before the 5 Oct fixes).
3. **LIVE, smallest size:** about 20 trades with that chain's key, results inside the TEST range, no stuck or failed
   orders, nothing left behind (token accounts closed, approvals revoked).
4. **The owner says go.**

Only then does the next level open, starting in TEST again.

| Level | Chain | Swap cost (measured 5 Oct, per swap) | Prices / routes | Safety check | Notes |
| --- | --- | --- | --- | --- | --- |
| **1 (now)** | **Solana** | about $0.01–0.02 (round trip about $0.03) | Jupiter | on-chain gates, insiders, rug list | pump.fun first; Meteora launches (also Solana) after that |
| 2 | BNB Chain | $0.018 | KyberSwap, LI.FI | GoPlus | |
| 3 | Robinhood Chain | $0.018 buy, $0.034 sell | KyberSwap, LI.FI | GoPlus | BONER's chain; pools mostly against USDG |
| 4 | Base | $0.005 (+ $0.0003 L1 fee) | KyberSwap, LI.FI | GoPlus | cheapest measured |
| 5 | Hyperliquid (HyperEVM) | $0.005 | KyberSwap, LI.FI | **none yet**: GoPlus and honeypot.is do not cover it | needs its own sell check (a simulated buy and sell) before any entry |
| 6 | Ethereum | **$2.31** | KyberSwap, LI.FI | GoPlus | a round trip costs about $4.6 + approval: entries of about $100 to keep costs near 5 % |
| 7 | Monad | to measure | LI.FI | GoPlus | last, owner's order |
| 8 | Arc | to measure | LI.FI | GoPlus | last, owner's order |

The swap costs are KyberSwap's gas estimates on 5 Oct, for one swap; they change with each chain's gas price and
are measured again on every TEST trade (costs change per provider: nothing is hard-coded). All services above
answered without an API key.

## What each new level needs (built only when it opens)

The strategies, gates, exits, ledger logic, research gate, alerts and dashboard are chain-independent. A new chain
family needs:
- **Discovery:** DexScreener and GeckoTerminal already cover every chain above; plus that chain's launchpads.
- **Quotes and routing:** an EVM aggregator (KyberSwap returns the dollar amounts and the gas of every route).
- **Safety:** GoPlus token security (honeypot, buy and sell tax, owner rights), or a simulated sell where GoPlus
  has no coverage.
- **TEST ledger** per chain, with costs in dollars.
- **LIVE (after TEST):** the separate EVM key, Permit2 approvals, a simulated buy and sell before every order,
  private submission on Ethereum.

## Meanwhile

The research ladder keeps recording every chain's trending coins (it already does). When a level opens there is
history to test its rules on, before TEST trades start.

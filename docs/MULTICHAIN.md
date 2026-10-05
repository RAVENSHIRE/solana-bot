# Trading beyond Solana: plan (5 Oct)

Owner, 5 Oct: "find ways that the desk not only trades Solana". Two missed coins prompted it: **CLAUS** (Ethereum,
Uniswap v4, $0 → $6.9M in 24 h; never seen) and **BONER** (Robinhood Chain, Uniswap; recorded by the research ladder
since 3 Oct at ~$50M, $75M two days later; nothing turned the record into a call).

## What is Solana-only today

| Layer | Today | What another chain needs |
| --- | --- | --- |
| Discovery, market data | DexScreener (filtered to `solana`), GeckoTerminal, pump.fun | the same APIs for other chains (DexScreener and GeckoTerminal cover them; the ladder already reads every chain) plus each chain's launchpads |
| Quote and route | Jupiter | an EVM aggregator (0x, 1inch, KyberSwap, Odos, LI.FI or Uniswap's router); which ones route Robinhood Chain is to be checked |
| Transaction | Jupiter `/swap`, Solana RPC, simulation, priority fee | EVM transaction, gas, token approval (Permit2), simulation (`eth_call`), one RPC per chain |
| Wallet and signer | address only (TEST), Phantom or a local Solana key (LIVE) | Phantom also signs on Ethereum, Base and Polygon; or a separate local EVM key |
| Safety | mint and freeze authority, Token-2022 extensions, insiders, rug list | honeypot and sell-tax checks (GoPlus, honeypot.is, or a simulated buy and sell), owner and mint rights, liquidity lock |
| Ledger and costs | lamports, rent, priority fee | wei, gas in the native coin, approval cost |
| Research | the observer records pump.fun | the ladder already records every chain's trending pools |

About 24 desk and execution files are Solana-specific. The strategies, gates, exits, ledger logic, research gate,
alerts and dashboard are not, so the work is an adapter per chain family, not a rewrite.

## Costs decide the chains

Gas is a fixed cost per swap, like Solana's fees but larger and different on every chain. At $2 entries:
- **Ethereum mainnet:** gas can cost a large share of a $2 trade (a Uniswap swap is about 150K gas), so trades need
  a much larger size there. CLAUS-type coins are for larger entries.
- **Base, BNB Chain, Arbitrum-style L2s (Robinhood Chain is one):** gas of cents, so $2–10 entries are possible.
- These are estimates. Phase 0 measures them: aggregator quotes return the gas, and every TEST trade records it, the
  same way the desk measured $0.03 per Solana round trip (owner: costs change per provider; nothing is hard-coded).

## Phases

**Phase 0: see and paper-trade, no money (first).**
- Discovery on chosen EVM chains: DexScreener and GeckoTerminal new and trending pools, plus each chain's launchpads.
- Quotes from an EVM aggregator for entries and valuation, gas included.
- Honeypot and tax checks before any TEST entry.
- TEST ledgers per chain, with the existing strategies' rules and exits. Research rules on the ladder's multi-chain
  data (for example a decade-level breakout) go through the gate first.
- Alerts only for rules that pass the gate, as today.

**Phase 1: LIVE on one cheap chain.** One signer (Phantom's EVM account, or a separate local key that never enters
TEST), Permit2 approvals, a simulated buy and sell before every order, private submission where MEV matters. Small
size, the same guards and opt-in as Solana LIVE.

**Phase 2: more chains,** one adapter each, once Phase 1 has run cleanly.

## Decisions for the owner

1. Which chains first. Suggested: Base and BNB Chain (cheap gas, busy meme markets), then Robinhood Chain if an
   aggregator routes it; Ethereum only with larger entries.
2. Which wallet for LIVE later: Phantom's EVM account, or a separate local key.
3. API keys: some aggregators and safety services need a free key; RPC per chain (public, or a provider).

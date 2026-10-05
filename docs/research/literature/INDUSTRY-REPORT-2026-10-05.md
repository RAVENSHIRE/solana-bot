# Industry report pasted by the owner (5 Oct): what matters for Raven

**Status of the source.** The owner pasted an AI-written summary titled "State-of-the-Art in Meme Coin Trading & Bots
(2026)", with 39 cited links. **None of those links could be opened here**, because this session's network blocks
them. Every number below is the summary's claim, not something verified. Some parts are plainly speculative: it
guesses who "Jeff" is, and "Crawlers" is unidentified. Use it as a reading list and a list of hypotheses, not as
evidence.

## Claims that bear on the desk, and what they mean

| Claim (unverified) | Relevance to Raven | Action |
| --- | --- | --- |
| A multi-agent LLM copy-trading filter (coin, wallet and timing agents; "Resisting Manipulative Bots in Meme Coin Copy Trading", UCL/NTU, WWW'26, arXiv 2601.08641) gives copiers about **+3 % per trade under realistic frictions**, the only approach with a positive copier return | **Critical, in a sobering way.** Raven's round trip at $2 costs about **7.5 %** (1.25 % fee per side and $0.10 fixed). A +3 % edge is negative at that size. The $0.10 fixed cost alone is 5 % of $2, against 1 % of $10 | **K1:** report every gate result at $2, $5 and $10 entries (costs only, same trades). If a rule only passes at $10, the problem is fixed cost, not signal. Read the paper first when arXiv is reachable |
| Copy trading is adversarial: manipulative bots front-run copiers and fake signals | applies to W1′ (wallets from the ledger) and VOICES: a wallet that looks smart may be farming its copiers | W1′ must price entries at Raven's read time plus latency (already in the design), and drop wallets whose buys are followed by their own sells within minutes |
| Pro bots run under 75 ms from signal to broadcast: dedicated RPC, Jito ShredStream, Yellowstone gRPC, co-located | irrelevant at phone speed (45 s). It matters only if bot entries (X6) are switched on, and even then Raven cannot compete on milliseconds | do not chase latency. Keep to signals that are still good **45 s later** (the gate already tests at phone speed) |
| Jito bundles and private submission are standard MEV protection; sandwich attacks on Solana "largely mitigated" | X8 (`EXECUTION.md`): measure realised slippage first | unchanged: measure, then decide |
| GMGN offers an "Agent API" with smart-money data and execution for AI agents | a possible data source for wallet labels and smart-money signals; its cost and terms are unknown | a possible later data source for W1′/VOICES. Not before an owner decision |
| "Demystifying Solana Bots: From GitHub Blueprints to On-Chain …" (arXiv 2607.28424) | a study of bot behaviour on chain | on the reading list, next to the bot-wallet finding (`MAYHEM.md`: one wallet tops 58 % of mayhem launches) |

## The critical point for the CTO

**Raven's main structural handicap is not speed but cost per dollar traded.** At $2, about 7.5 % per round trip
must be earned before any edge shows, which is more than the best published copier edge in the summary. Three
consequences:
1. Report the gate at $2, $5 and $10 (K1).
2. Lower the fixed cost where possible: the priority-fee cap on entries (X5), and one simulation per order (X2).
3. Size up only through the existing scale-up ladder, once a rule passes at $2.

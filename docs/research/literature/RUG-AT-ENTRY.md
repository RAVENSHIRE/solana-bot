# Rugs at entry: C1/C2 replaced, and point-in-time features to separate rugs (5 Oct, 23:00 UTC)

From the CTO's TEST data (5 Oct evening):
- **C1/C2 could not apply.** CRASH buys 1–4 min after graduation, when the pool has no confirmed swing high. C2 traded
  as plain CRASH; C1 entered nothing.
- **One-block rugs decide the record.** CRASH has 5 trades since 21:00 UTC, average −36.9 %, 1 win. Three of them were
  rugs about 2 min after entry:

  | Coin | Path |
  | --- | --- |
  | CRYPTO | +5.6 % → −95 % in 22 s |
  | Catoppy | +63 % → −83 % in 24 s |
  | ROOMS | −8.6 % → −90 % in 11 s |

  COMEPUMP, held by C2, peaked at +89.9 % and was rugged to −96 % 9 min after entry. GOLDEN's SpongeBob stopped at
  −98.2 % against a −40 % stop.
- **The current entry gates do not separate the rugs.** Graduation age 1–4 min, cap $56–62K, 5-minute volume
  $55–122K and buy/sell 1.5–5.4 all overlap the non-rugs.

**No stop survives a one-block rug, so the lever is the entry.**

## Decision on C1/C2 (research's call)

- **C1/C2 as specified: dropped as "not testable", not "failed".** Their condition (a swing high on pool candles)
  cannot exist 1–4 min after graduation. No result from them counts either way.
- **Replaced by C1′/C2′ (option a), registered now.** The structure is built from the **bonding-curve phase**, which
  the observer records trade by trade, and carried across graduation in market-cap terms (the curve's market cap at
  graduation equals the pool's opening market cap). Same definitions as `TA-LAYER.md`, on curve minute candles plus the
  pool's minutes. Thresholds unchanged: 3 % buffer, 25 % maximum distance. Judged only on CRASH entries after the
  change ships.
- Option b (a later entry, ≥ 10 min after graduation) is a different strategy. It is not registered here.

## Point-in-time rug features at the CRASH entry (all from the observer's curve trades, known at graduation)

The observer has every curve trade of these coins (`T` records: wallet, buy or sell, tokens). Net balance per wallet
= tokens bought − tokens sold up to the graduation (`X` record). The curve's own account and the pool are excluded.

| Feature | Definition | Pre-registered threshold (fixed now, before looking) | Why |
| --- | --- | --- | --- |
| `insiderAtGrad` | the net balance at graduation of the creator plus every wallet that bought in the creation slot or the next, as a share of supply | ≥ 10 % | insiders who still hold at graduation can dump into the first pool minutes (the ETF and Potato cases in `DESK.md`: "insiders selling into the migration") |
| `top10AtGrad` | the net share of the 10 largest wallets at graduation | ≥ 35 % | a concentrated supply can drain the pool in one block |
| `sniperAtGrad` | the net share still held by wallets that bought within the first 3 slots, creator excluded | ≥ 15 % | bundled or sniper supply waiting for the pool |
| `botAtGrad` | the net share held by the frozen bot list R (`MAYHEM.md`) | ≥ 10 % | bot farms that exit together |
| `preGradSellShare` | sells ÷ (buys + sells) in SOL over the last 2 curve minutes before graduation | ≥ 0.45 | distribution into the graduation |
| `serialCreator` | `creatorLaunches` ≥ 2 and `creatorGraduations` = 0, from the dataset's creator history | true | H1 |
| `holdersAtGrad` | wallets with a positive net balance at graduation | < 150 | a thin holder base |

**Label:** a rug = the price at or below −70 % of the entry within 10 min of the entry, from the desk's own quotes
and exits (`exitReason` on SELL rows since 22:46 UTC) or pool candles.

| # | Hypothesis | Test | Passes if |
| --- | --- | --- | --- |
| RG1 | Each feature above, past its threshold, raises the 10-minute rug rate of CRASH-type entries | every CRASH signal (taken or not), the features at its graduation, the label from pool prices | for each feature: the rug rate above the threshold is ≥ 2× the rate below, on ≥ 20 rugs in total. Holm across the 7 features |
| RG2 | CRASH excluding entries that fail any feature that passed RG1 beats CRASH | the standard Level 1 card (≥ 100 trades, average > 0 after costs, luck p < 0.05) | as the card |

**The first step needs no new strategy.** Compute the seven features for every CRASH signal since 5 Oct 21:00 UTC,
including CRYPTO, Catoppy, ROOMS and COMEPUMP, and show rugs against non-rugs. That is descriptive and judges
nothing. RG1 then runs on signals from the moment the features are recorded.

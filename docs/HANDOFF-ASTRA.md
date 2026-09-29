# Handoff → GPT-6 Astra: Solana trading desk

Branch `claude/session-title-unavailable-wennx2` (PR RAVENSHIRE/solana-bot#1). The owner's working branch `codex/phantom-live-20260929` pulls from it. Everything below is on the branch; `docs/DESK.md` is the operator documentation.

## 1. Owner's goals for the next phase

1. **A live system.** Once deployed, the owner cannot manually override parameters. Configuration must come from versioned files / `.env`, be validated at start, and survive restarts. Nothing may depend on a manual click (today: RESET TEST, strategy toggles and the drill are in-memory UI actions).
2. **Store, reset and re-enter trades continuously and simultaneously, without supervision.**
   - Done in `f2438e0`: a dry TEST sleeve with nothing open is archived as a cycle and re-funded automatically. Stats, PnL, the ledger view and cooldowns continue across cycles and restarts.
   - Still open: strategy on/off flags and the drill are in memory only, and the 30-minute re-entry cooldown is fixed.
3. **Originals over clones.** The owner's finding:
   - The bot traded "SIF — Super Intelligence Face" `F4sTBdunw23aCMuTMJE7scem1VWwcoptL6iwaGeZt3Fe`, but the actual meme is SIF on PONS, `DhVcpV6UdtMKATyQm8E6CvpJmy91HdPibe9s7uzkwYuN`.
   - Likewise, Solana GM `4Kou9tGyJ83cvLjzHU1Vs2W1e31gTytGDBNxvQcigFpS` is a clone of Green Morning on BSC `0x13920fe6467e9e3c852b8d365a036c995f0f7777`.
   - Clones do not behave like originals. Detecting the characteristics, finding the original and entering early could beat trading clones with CRASH.

## 2. Open decision that belongs to the owner

**How LIVE orders are signed in an unattended deployment is not decided.**
- Today LIVE signs only through Phantom: one browser approval per transaction, with optional Auto-Confirm. LIVE stops when the browser session ends.
- The desk environment allowlist in `src/desk/runtime.ts` never reads `WALLET_PRIVATE_KEY`. That is by design.
- The owner reported Phantom not connecting and asked for signing with the key in `.env`. That was not implemented in this session: the previous agent's environment blocked it under its safety policy.
- Settle the signing model with the owner before any unattended LIVE work. This document does not specify one.

## 3. What exists (all tested)

| Area | Where | Notes |
| --- | --- | --- |
| Pipeline (TEST = LIVE path, paper signer stops where Phantom would sign) | `src/desk/engine.ts`, `guard.ts` | Guard: quote identity, slippage, spendable capital + 0.003 SOL reserve, max drag, unsigned RPC simulation, pre-flight record, signature persisted before broadcast, halt on unknown outcome |
| Strategies FAIR + CRASH in parallel | `src/desk/config.ts`, `strategies.ts` | Separate ledgers and TEST sleeves; one coin per strategy; several entries per scan; orders serialized; exits checked beside the scan (CRASH every 2 s) |
| Discovery, evidence, gates, fair-launch check | `discovery.ts`, `onchain.ts`, `launch.ts`, `social.ts`, `analysis.ts` | DexScreener + GeckoTerminal; OBSERVED / DERIVED / INFERRED evidence; UNKNOWN never filled in |
| Ledgers, telemetry | `ledger.ts` (zod `.strict()` schemas — keep backward compatible), `events.ts` | `data-desk/` is git-ignored |
| Signal tape + replay | `engine.ts` (tape), `replay.ts`, `src/scripts/desk-replay.ts` | Tape: `data-desk/tape-<MODE>.jsonl`. Replay: cached GeckoTerminal candles, exit variants, sizes with constant-product impact |
| Dashboard | `dashboard/server/trading.ts`, `dashboard/src/Desk.tsx` | Same-origin capability, Phantom broker, strategy cards, RESET TEST |
| Headless TEST | `npm run desk:paper -- --address <PUBKEY> --scans N [--no-crash|--no-fair]` | Ticks every second like the dashboard |

Checks before every push: `npm run typecheck && npm test` (132 tests) and `cd dashboard && npm test && npm run build`.

## 4. Evidence so far (paper fills on real market data)

| Token | Result | Note |
| --- | --- | --- |
| GM (Solana clone of BSC GM) | +110 %, +$2.21 in 75 s | Pool 93 s old at entry, $16K → $34K market cap; later ran to +727 % with two −55 % one-minute drops |
| SI | −26 % | Exit late: the headless runner did not tick during scans (fixed in `ee7981c`) |
| ASI | −19 % | Stop loss hit on the next 2 s check after a −5 % move in 2 s |

**GM at larger sizes.** The pool had ≈ $12.8K SOL-side depth at entry. At the bot's exit:

| Size | $2 | $10 | $100 | $1,000 | $10,000 |
| --- | --- | --- | --- | --- | --- |
| Result | +$2.17 | +$11 | +$105 | +$751 | −$2,836 |

The $10K buy alone would have moved the price ≈ 78 %. Scaling is a liquidity question first.

**Reproducibility gap.** Replaying the CRASH rules on GM's minute candles gives +41 %, while the bot got +101 % with its 2-second checks. Minute candles hide the order of moves within a minute.

## 5. Proposed work, in order

**P0 — unattended operation (no manual steps)**
1. Runtime settings as versioned config (strategy flags, drill off in deployment, sleeves, cooldowns), validated at start. The UI either writes through to that config or is read-only in deployment mode.
2. Sleeve lifecycle without RESET: done for TEST (`cycleSleeve` in `engine.ts`).
3. Re-entry policy:
   - Configurable cooldown per strategy.
   - Allow a re-entry into the same token only on a fresh signal, never immediately after a stop-loss.
4. Restart safety:
   - On start, manage exits before discovery.
   - Reconcile open LIVE positions and any `pending` / `halted` state against on-chain balances.
   - Alert, never auto-retry, on unknown outcomes.
5. Operations:
   - A health endpoint and heartbeat.
   - Alerts on halts, stalled scans and provider cooldowns.
   - Log rotation (events and tape already rotate at 20 MB).
6. Account rent: each new token locks ≈ 0.002 SOL in an empty token account after exit. Reclaiming it needs a signed close transaction, which depends on the signing decision in §2.
7. Data limits: GeckoTerminal answers 429 when two desks share an IP, which slows scans to 30–120 s. Options: a keyed API, more caching, or taking launch checks off the CRASH path (already done for entries).

**P1 — reproducibility**
1. Tape each position's 2-second valuations (price, value, peak, liquidity), so replays use the bot's own observed path instead of minute candles.
2. Replay tape signals (not only ledger trades), so entry-rule changes can be tested offline before deployment.
3. Once LIVE fills exist, report paper vs real fill differences per trade: slippage, latency, failed sends.

**P1 — ORIGIN strategy (the owner's idea)**

Market data for the SIF case, checked 29.09 ≈ 23:40 local:

| | Clone the desk traded | Original |
| --- | --- | --- |
| Mint | `F4sTBdunw23aCMuTMJE7scem1VWwcoptL6iwaGeZt3Fe` | `DhVcpV6UdtMKATyQm8E6CvpJmy91HdPibe9s7uzkwYuN` |
| Venue | PumpSwap | Raydium |
| Created | 23:19 | 23:11 (8 min earlier) |
| Market cap | $56K | $372K |
| Liquidity | $37K | $63K |
| 1h volume | $666K | $1.92M |
| 1h buys / sells | 3,155 / 1,129 | 14,519 / 12,474 |
| Website | none | xxdefi.com |

The same search (`/latest/dex/search?q=SIF`) also finds:
- Three more Solana clones on FluxBeam. Their "liquidity" is close to their market cap (≈ $0.7–1M) while 24 h volume is only ≈ $5–7K. Treat such pools as fake depth and exclude them.
- Four clones on the Robinhood chain, all created 23:12–23:34.

In both the SIF and the GM case, the original was earliest, had by far the most transactions, and had a website. The clones had none.

1. **Trigger:** any CRASH signal or trending token.
2. **Resolve siblings:** DexScreener search by symbol and name (`/latest/dex/search?q=<symbol>`), across chains. Same symbol, or near-identical name.
3. **Rank the original:**
   - Earliest launch (pool / curve creation).
   - Most cumulative volume and holders.
   - DexScreener profile, boosts and linked socials.
   - An X account that links to the website and predates the clones. Reuse `assessAuthenticity`, including SOCIAL AGE MISMATCH.
   - Depth, plus the usual mint / freeze / extension safety.
4. **Act:**
   - If the signal token is a clone and the original is on Solana, routable by Jupiter and passes safety, evaluate the original with its own momentum rules.
   - A clone of an original on another chain (GM on BSC) is a narrative follower: CRASH rules only, short hold.
5. **Validate:** tape every clone ↔ original pair. Compare their returns after the signal with the replay, before any LIVE use. Start with the SIF and GM pairs in §1.

**P2 — sizing**
- The scale ladder ($10 → $100 → $1K → $10K per entry) is advisory only (`scaleAdvice`).
- Before raising sizes, gate them on the pool's depth: the next size needs about 50× the entry in liquidity for ≈ 2 % impact.

## 6. Discovery: what was missed and what is fixed

**Missed early: SI** `7Wh6rxVWUBFCNCWCz7nLaV7z3SDr2M6rFTjjWP6aE8p1` (pump.fun, graduated 33 s after launch).
- The PumpSwap pool opened at 23:53:11. Market cap went $15K–$64K (to 23:56), $128K (23:57), then peaked at $447K (00:05).
- The desk first saw it at 00:08, at ≈ $396K. CRASH entered and was stopped out at −15 %.
- Why:
  - New tokens came only from GeckoTerminal's new-pools page 1, the 20 newest pools on all of Solana. That page scrolls past a pool within about a minute.
  - Scans took ~90 s waiting on GeckoTerminal's rate limit.

**Fixed in `18f29ad`.**
- `GraduationFeed` (`src/desk/migrations.ts`) reads every pump.fun graduation from the chain.
  - Source: signatures of pump.fun's migration authority `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`, whose `MigrateV2` → `CreatePool` transactions contain the mint.
  - Volume: ≈ 110 per hour.
  - Graduations stay in discovery for 30 min and are assessed right after held tokens.
- Discovery (12 s) and GeckoTerminal-bound evidence (20 s) have time budgets that cancel queued requests.
- Verified on the real chain: scans of 24–36 s, 7 graduations in discovery, and a CRASH entry 15 s after a new graduation. Instant rugs (−99.6 % within 5 min) were correctly rejected.

**Still not covered.**
- Tokens from other launchpads (LetsBonk, Believe, Meteora DBC, Raydium LaunchLab, PONS…). Each needs its own on-chain feed.
- The pre-graduation bonding-curve phase, which is not tradeable through the AMM path.

## 7. Known loose ends

- `DeskEngine.entryAllowance` (committed in `cbfa7fd`) is an unused optional cap on new entries per session. Use it or remove it.
- The PowerShell console shows `·` and `—` garbled in logs. Cosmetic: the dashboard renders UTF-8.
- Since `f2438e0` a dry TEST sleeve re-funds itself, so the owner's FAIR sleeve resumes after pulling.
- A young-pool CRASH entry can be refused by the global Jupiter price-impact limit (`MAX_PRICE_IMPACT_PCT`, 3 %) before CRASH's own 5 % drag cap applies. That is what happened to SIF at 23:21:22 ("Price Impact 3.25 % > Limit 3 %"). With 2.5 % slippage it would also have exceeded the drag cap, so the refusal was consistent.

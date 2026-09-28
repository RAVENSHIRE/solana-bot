# Engineering report — 2026-09-28

The missing market-data clients are implemented and integrated on local branch `codex/market-data-integration`, based on `f8666bc`. The shared layer validates provider observations, preserves unknown values, isolates analytical caches from execution, records bounded history and keeps provider failures observable.

## Verification actually performed

| Check | Result |
| --- | --- |
| Baseline root typecheck/build | Both failed before this change: missing provider imports and consequent strategy type errors |
| Root `npm run typecheck` | Passed |
| Root `npm test` | 58 passed, 0 failed (39 data/execution/strategy tests + 19 existing playbook tests) |
| Root `npm run build` | Passed |
| Root `npm run build:playbook` | Passed |
| Dashboard `npm test` | 6 passed, 0 failed |
| Dashboard `npm run build` | Passed |
| `npm run data:check` | Passed against public APIs: 20 Dex profiles, 20 Gecko pools, 3 Raydium pools at the observed run |
| Additional real-response normalization | Passed: Dex token-pair batch, 20 Gecko pools, Raydium list and ID lookup, 300 Gecko trade events |
| Real OHLCV response | Accepted and classified: 59 completed candles, 1 partial candle, 2 missing intervals; this sample correctly does not meet the 60-candle gap-free entry gate |
| Git whitespace check | Passed |
| Authenticated Jupiter/RPC full simulation bootstrap | **Unverified**: no configured account credentials used for an end-to-end trading run |
| Live transaction, funded execution, private wallet/watchlist integration | **Not performed** |
| Restart/deployment on the user's Windows PC or VPS | **Not performed** |

Two initial existing test failures exposed stale test assumptions (placeholder non-Solana quote addresses and a quote mock without the new freshness interface). Test fixtures were updated to valid public-key formats and the mock contract; all original behavioral tests now pass. No production mock data was added.

Public data checks are point-in-time compatibility evidence, not service availability guarantees. Tests use synthetic fixtures only in `tests/`. The optional bigint native binding reported a pure-JavaScript fallback; tests and builds succeeded without it. No benchmark or profitability claim is made.

## Delivered behavior

- Existing provider import paths and call signatures remain available. Rich series/trade/snapshot APIs add metadata without changing scoring formulas.
- Runtime Zod schemas reject malformed amounts, addresses, pool identities, timestamps, OHLC relations and missing execution-critical fields.
- One shared cache/HTTP gate, existing TokenBucket implementation, provider-specific rates, request sharing, retries, Retry-After, deadlines/cooldowns and bounded storage.
- Reversal retains the 25/20/10/20/25 score and existing entry threshold. New-entry quality gates are logged separately. Missing market cap cannot pass as FDV.
- SUTR keeps roundtrip, paper-only LP and rent recovery. Roundtrip uses slippage minima, capped priority fees and close-account cost; the final buy quote must still meet the edge threshold.
- RiskManager limits stay unchanged. Buy risk-check/execution/booking and rent maintenance are mutually exclusive; the unused bypass option was removed.
- Execution quote objects must be freshly issued, unchanged and within the configured age; historical/cached copies cannot build trades.
- No quote-based position writeoff. No LP outage fee invention. Missing confirmed transaction metadata stays unknown for reconciliation.
- Portfolio format, simulation/live separation, atomic persistence and PM2's single-instance design are preserved.
- Logger, journal and historical payloads redact known credential fields and authenticated URLs.

## Dependencies and credentials

No dependency was added; `package-lock.json` is unchanged. Public Dex/Gecko/Raydium clients require no keys for the tested routes. The existing Jupiter `api.jup.ag/swap/v1` integration needs its API key. Reliable Solana mainnet RPC requires the user's configured endpoint(s), with credentials if the provider requires them. Root initialization retains its existing wallet configuration requirement; data adapters, public smoke checking and replay do not load signing material.

## Limitations and remaining risks

1. There has been no funded or long-duration simulation/live validation, performance benchmark, profitability backtest, deployment or remote app restart.
2. Many market APIs omit source timestamps and cache upstream responses. The layer labels this uncertainty; local receipt freshness is not proof of current executable price.
3. Gecko trade history is a bounded sample. Wallet accumulation and wash-trade classification remain heuristics; there is no proof of common ownership, influencer intent, fundamentals or profitability.
4. RPC activity cannot expose off-chain FOMO account watchlists. No private SkullRaven account access, social graph or paid provider integration is claimed.
5. The existing non-atomic arbitrage can lose money between legs. Fees/rent are modeled conservatively for the normal account path, but Token-2022 account sizes, failed closes, unusual routes or landing conditions can add costs. LP hedging remains hypothetical and excludes funding/borrow/rebalancing costs.
6. Missing confirmed live fills use the existing tagged reconciliation path. Reconstructed buys have estimated basis and block new entries. Externally moved tokens and unknown sells still require operator reconciliation; this change is not a full wallet accounting ledger.
7. HTTP request cancellation is cooperative. Existing RPC calls settle under their own timeouts; the engine waits for settlement before scheduling the same task again. Shutdown keeps its prior grace/force-exit behavior.
8. History is bounded JSONL with an offline as-of reader, not a transaction-capable replay engine or complete historical strategy backtester. Dropped/gapped observations limit reproducibility. Existing trade-journal retention remains separate.
9. The root history is not synthesized dashboard telemetry. Existing UI fields stay unknown until the engine supplies measured data. New data-health information appears in heartbeat/history rather than a new dashboard panel.
10. Jupiter v1 remains the current repo contract, but official documentation now describes it as superseded by Swap V2. Migration should be a separate tested change.
11. Local changes include earlier dashboard/playbook commits absent from the previously inspected GitHub main. Do not overwrite a newer Windows working tree. Review/merge in a separate checkout.

## Repository delivery

The GitHub connector had previously rejected repository writes with HTTP 403. No alternate push path was used to bypass that denial. The feature branch and a PR-ready description are delivered locally; no remote PR was created, nothing was merged and no live deployment was performed. Use the source archive in a separate directory, or the Git bundle to preserve history. Review the branch against your actual current repository before importing it.

See `DATA-INTEGRATION.md` for the audit, dependency map, implementation sequence, API sources, defaults, failure policy and operational/rollback commands. Recommended next work: authenticated paper soak test and quote/health audit, explicit live-fill ledger reconciliation, fee/impact calibration, then separately tested Jupiter V2 migration and reproducible strategy evaluation.

## File inventory relative to f8666bc

Created:

- `docs/MARKET-DATA-PR.md`
- `docs/provider-smoke-2026-09-28.json`
- `docs/DATA-ENGINEERING-REPORT.md`
- `docs/DATA-INTEGRATION.md`
- `src/data/core/data-cache.ts`
- `src/data/core/data-health.ts`
- `src/data/core/data-runtime.ts`
- `src/data/core/data-types.ts`
- `src/data/core/data-validator.ts`
- `src/data/core/request-scope.ts`
- `src/data/dexscreener.ts`
- `src/data/geckoterminal.ts`
- `src/data/raydium.ts`
- `src/data/services/market-intelligence.ts`
- `src/data/solana-rpc.ts`
- `src/data/storage/market-data-store.ts`
- `src/execution/quote-validation.ts`
- `src/execution/roundtrip.ts`
- `src/scripts/replay-data.ts`
- `src/scripts/test-market-data.ts`
- `src/utils/redact.ts`
- `tests/market-data.test.ts`

Modified:

- `.env.example`
- `README.md`
- `package.json`
- `src/analysis/token-safety.ts`
- `src/analysis/wash-trading.ts`
- `src/config/config.ts`
- `src/core/engine.ts`
- `src/core/journal.ts`
- `src/core/types.ts`
- `src/data/http-client.ts`
- `src/execution/executor.ts`
- `src/execution/jupiter-client.ts`
- `src/execution/live-executor.ts`
- `src/execution/simulated-executor.ts`
- `src/execution/token-accounts.ts`
- `src/index.ts`
- `src/rpc/connection-manager.ts`
- `src/strategies/base-strategy.ts`
- `src/strategies/reversal-sniper/index.ts`
- `src/strategies/reversal-sniper/playbook/quotes.ts`
- `src/strategies/suck-up-the-rent/index.ts`
- `src/utils/logger.ts`
- `src/utils/rate-limiter.ts`
- `tests/playbook.test.ts`

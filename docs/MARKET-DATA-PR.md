# Restore validated market data and protect execution from provider failures

Main references three provider modules that are absent, preventing the bot from compiling. Existing quote validation, outage handling and roundtrip accounting also allow stale or incomplete observations to affect execution/accounting.

This branch adds compatible DexScreener, GeckoTerminal and Raydium clients, a shared bounded cache/HTTP/health/history layer, and a read-only RPC adapter. Both strategies receive validated observations with explicit missing values and quality gates. Existing score weights and RiskManager limits remain unchanged.

Execution quotes are independently refreshed and checked for request identity, impact, slippage, integrity and age. Roundtrips use both minimum-output bounds and recheck the edge on the actual entry quote. Missing quotes retain positions; LP outages freeze unsupported accrual; confirmed fills without metadata remain unknown. Task cancellation prevents overlapping scans after a timeout.

Validation: 58 bot/playbook tests, 6 dashboard tests, root typecheck/build, isolated playbook build and dashboard build pass. Public provider smoke checks and real candle/trade normalization passed. Authenticated end-to-end Jupiter/RPC trading and live deployment remain unverified/not performed.

This branch includes prior local dashboard/playbook work based on f8666bc. Review the complete diff relative to the target branch. No dependencies, portfolio migration, live LP transactions or changes to PM2 instance count. Details and limitations: docs/DATA-INTEGRATION.md and docs/DATA-ENGINEERING-REPORT.md.

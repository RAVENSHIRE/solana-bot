# Engineering status · 2026-09-29

Installed directly in Raven's Windows VS Code checkout on branch `codex/phantom-live-20260929`, starting from the verified clean commit `6d542b9`. The remote connection became available again; the earlier approval-review usage limit was not bypassed. Original files were backed up outside the repository before installation, and installed content was checked against Git blob hashes. No ZIP or manual patch copying was required.

## Implemented

- Phantom Browser SDK 2.0.3 injected connection, explicit manual approval and optional user-granted Mainnet Auto-Confirm. No app ID invented; no wallet secret imported by this path.
- One expiring browser session and one signature request at a time; exact message, owner, deadline and cryptographic signature validation on return.
- Origin/capability/session checks for local HTTP control. Loopback remains mandatory. New server starts are disarmed.
- Serial execution, browser heartbeat, pre-/post-approval guards and a final synchronous stop check after durable signature persistence. Unknown broadcast outcomes preserve the ledger and cannot automatically create another order.
- Coherent 10-USD default / 2-USD entry profile, measured wallet readiness, native reserve, fee cap, ATA rent and baseline-relative loss threshold. Existing ledgers migrate without resetting history or pending transactions.
- Wallet/live controls separated from market/simulation views; independently measured wallet balances, ledger results and explicit blockers.
- The small-live-test VS Code task now starts the Phantom dashboard disarmed. Local Keypair tasks remain explicitly labeled Legacy. V2 VPS requirements are documented separately.

## Verification

- Root: 105 tests passed; TypeScript check and production build passed, including on Raven/Windows.
- Dashboard: 11 tests passed; TypeScript and Vite production build passed, including the final Axios update on Raven/Windows and in the integration workspace.
- A Windows rerun exposed a transient `EPERM` during the watcher's test-fixture rename. The test now exercises the engine's existing atomic writer and its bounded sharing-violation retries; all assertions remain enabled and the Windows rerun passed.
- Tests use deterministic synthetic keys, transactions and injected providers/executors. They do not submit financial transactions.
- Covered: genuine signatures, message/signature tampering, expiry, disconnect, duplicate requests, missed heartbeat, concurrent scans, funding before baseline, unknown sends, missing quotes, stop during wallet approval, stop during durable persistence, API origin/capability/session isolation, and configuration excluding local wallet keys.
- Independent review additionally found and resolved shared-ledger locking, old scans during wallet replacement, and shutdown during a delayed connection factory; regression tests cover all three.
- Browser visual check could not complete: local Playwright browser installation failed, and the cloud browser refused the loopback URL. The real Phantom extension connection/Auto-Confirm flow has not been verified end to end on Raven.

## Dependency audit

- Dashboard pins the Phantom SDK's transitive Axios dependency to 1.18.0. After the update, its lockfile audit reports 0 high/critical and 15 moderate affected dependency nodes, originating from two advisories in `uuid` and `stream-json`.
- The inspected web3.js RPC path uses `jayson/lib/client/browser`, which calls UUID v4; the UUID advisory affects v3/v5/v6 with caller-provided buffers. The inspected Jayson stream utility uses StreamValues/Verifier, not the affected stream-json filters. This is a limited call-path review, not a proof that every third-party path is safe. Major dependency overrides were not forced merely to suppress audit output.
- The separate engine/root lockfile still reports 3 high and 6 moderate affected nodes. Its additional underlying high advisory is the existing `bigint-buffer` native conversion overflow, pulled in by SPL Token's buffer layout utilities; no patched upstream release is listed. The inspected SPL layouts decode fixed-width integers, and Raven's current startup reports that the native binding is unavailable and the JS fallback is used. Those observations do not remove the dependency finding or establish production security. This must be resolved or formally assessed before a VPS rollout.
- Sources: https://github.com/advisories/GHSA-mmx7-hfxf-jppx, https://github.com/advisories/GHSA-w5hq-g745-h8pq, https://github.com/advisories/GHSA-528h-pc64-c93x, https://github.com/advisories/GHSA-3gc7-fjrx-p6mg.

## Installed runtime check

- Restarted only the verified dashboard process; the replacement serves `http://localhost:3000` on loopback.
- HTTP checks: dashboard 200 with the newly built bundle; state API 200/ready; invalid wallet 400 without crashing the server; wallet API 200 with actual mainnet balances and explicitly partial USD valuation.
- The initial trading status was `WAITING_FOR_WALLET`, `active: false`, no session, pending signature or ledger. It exposed the intended 10-USD/2-USD profile, 0.003-SOL reserve, 1.5% cost cap and 7-USD planned halt threshold. An initialized ledger instead uses its recorded starting-equity threshold.
- Opened the local dashboard in the user's browser. Actual Phantom extension connection/signing remains a user-side verification, not an inferred success from HTTP tests.

## Remaining before the user's live pilot

The user connects Phantom, reviews the actual wallet/limits/blockers and explicitly enables the live session/signing. Account rent, fees or absent positive net quotes may still prevent any trade after funding. The remaining dependency findings above are disclosed; this is not an unqualified production-readiness certification.

No live trade, wallet funding, external publication, GitHub push or VPS deployment was performed in this iteration. No ZIP or manual-download delivery was created. Profitability and 24/7 readiness are not established by these tests.

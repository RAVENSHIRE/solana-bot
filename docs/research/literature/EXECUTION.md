# Execution path: what costs time and money on a $2 order, and what to change

For the CTO, 5 Oct. Read from the code on the base branch (`src/execution/*`, `src/desk/guard.ts`, `src/desk/engine.ts`,
`src/config/schema.ts`) and the owner's status page. The literature on priority fees, Jito bundles and sandwich
exposure (brief topic 5) is still unread, because those hosts are blocked here. **Nothing below relies on it.** Where
a decision needs it, the step is "measure first".

## The path today (one LIVE buy)

```
signal → Jupiter /quote ─► guard.beforeBuild: wallet snapshot (4 RPC calls) ─► Jupiter /swap (build)
       → guard.beforeSign: getFeeForMessage, snapshot again, simulate (unsigned), getMultipleAccounts
       → LiveExecutor pre-simulation (a second simulate; PRE_SIMULATE_TX defaults to true)
       → guard.beforeSend (preflight record) → Phantom: a person approves → guard.beforeSend: snapshot again
       → broadcast → poll getSignatureStatuses + getBlockHeight every 1.5 s, rebroadcast every 2 s → fill parsed
```

Phantom is only the signer; Jupiter is the router (as the status page says). TEST stops where Phantom would be asked
(`PaperExecution`), so **TEST never measures the steps after signing**: landing, confirmation, real slippage.

## Findings, ranked by what they cost a $2 order

1. **Nobody measures the path.** The research execution model assumes a 2 s entry latency and a 5 % failed-transaction
   rate (`research/execution/model.ts`, `DESK_LIKE`). These are guesses. The fill parser already computes the
   realised slippage against the quote (`live-executor.ts`, `parseFill`), but no stage timings are recorded.
   Without them every other change below is a guess too.
2. **Two simulations of the same transaction.** `guard.beforeSign` simulates (with account checks) and then
   `LiveExecutor` simulates again when `PRE_SIMULATE_TX` is true (the default). The guard's simulation is the stricter
   one, so the second adds a round trip and no safety.
3. **Constant values fetched on every snapshot.** `snapshot()` calls `getMinimumBalanceForRentExemption` twice per
   call (165 and 170 bytes). Those values do not change, yet a buy takes three snapshots, so that is up to six
   avoidable calls. Each snapshot also waits behind the previous step when it could start with the quote.
4. **Jupiter is rate-limited to 1 request per second by default** (`JUPITER_MAX_RPS` 1, a token bucket of one in
   `jupiter-client.ts`). One order needs a quote *and* a build, so the second call can wait up to a second, and an
   exit queues behind any other order. Set it to what the API key's plan actually allows.
5. **Priority fee on entries can take the whole cap.** The cap is 300,000 lamports (`MAX_PRIORITY_FEE_LAMPORTS`). The
   code's own comment says that is about 1.8 % of a $2 position, and exits are already limited to 1 % of notional
   (`EXIT_PRIORITY`). Entries still get the full cap when the drag budget allows. Whether a lower fee lands as fast
   is an empirical question (finding 1).
6. **Phantom means a person clicks.** That is why the gate assumes a 45 s fill. Bot-speed entries (the owner's
   "if the bot entered when it was sent to ntfy") cannot run through Phantom. The desk already signs WATCH exits
   with a local key (`local-signer.ts`, engine "Signed by the local key").
7. **Curve tokens go through the aggregator.** The scanner's ultra-early $2K–$10K tokens still trade on the pump.fun
   curve, and each order takes two Jupiter HTTP round trips plus the rate limit. The desk already reads curve state
   itself (`opening.ts`), so a buy or sell instruction for the curve could be built locally.
8. **Wide exit slippage.** Exits allow up to 15 % (`exitSlippageBps` 1,500 for GOLDEN). That is a deliberate
   choice (a failed sell in a dump is worse), but it is also the most a sandwich can take. Whether that happens to
   $2 orders is unknown until finding 1 is measured.
9. **Dead dependencies on the status page.** The X API returns HTTP 402 (no credits), and the Claude launch review
   fails for lack of API credits (0 done, 4 failed this hour). Each pass still calls them. Turn them off or back off
   until they are paid for, so they cost neither rate limit nor attention.

## Changes, in order (code for the CTO; none changes a risk gate)

| # | Change | Where | Why first | Risk |
| --- | --- | --- | --- | --- |
| X1 | **Record stage timings for every order, TEST and LIVE**: decision, quote, built, simulated, signature requested, signed, sent, confirmed. Also quoted against filled amount, priority fee paid, and reverted yes/no. One `EXEC` record per order in the desk ledger | `live-executor.ts`, `guard.ts`, desk events | everything else is tuned from it; it also calibrates `DESK_LIKE` in the research model | none |
| X2 | One simulation: skip the executor's pre-simulation when the desk guard has simulated | `live-executor.ts` (`preSimulate`) | removes a round trip with no loss of safety | none: the guard's simulation is the stricter one |
| X3 | Cache the rent-exemption minima once per run; start the wallet snapshot in parallel with the quote | `guard.ts` `snapshot`, `beforeBuild` | removes up to 6 calls and one sequential step per buy | none |
| X4 | Set `JUPITER_MAX_RPS` to the key's plan; give exits priority in the limiter | `.env` (owner), `jupiter-client.ts` | an exit should never wait behind a quote | none |
| X5 | Cap the entry priority fee at a share of notional, like exits (start at 1 %), and compare landing time and revert rate against the full cap using X1 | `guard.ts` (`EXIT_PRIORITY` logic for buys) | about 1 % of every $2 entry | slower landing on hot launches; X1 shows it |
| X6 | **Bot-speed entries only after shadow evidence**: a dedicated hot wallet with a local signer and only trading capital on it (the owner's Phantom stays the main wallet). Switched on per strategy only when its shadow results at bot speed pass (P2 for GOLDEN, sprints) | `local-signer.ts`, strategy config | the owner's main ask; the guard and caps stay as they are | a hot key on the PC: small balance, never in the repo, the owner's decision |
| X7 | Direct pump.fun curve orders for curve tokens, built locally from the curve state | new module beside `opening.ts` | removes two HTTP round trips and the Jupiter limit for the fastest trades | a new code path: TEST first, a parity check against Jupiter quotes |
| X8 | Decide on MEV protection (private submission or bundles) from X1's realised slippage, after the topic-5 sources are read | — | do not pay for protection before measuring the loss | — |

## For the research gate

Until X1 exists, the gate's phone-fill assumption (45 s, `PHONE_FILL_MS`) and the model's 2 s bot fill are the
only latency numbers, and neither is measured. Once LIVE or TEST orders record timings, replace both with the
measured median and 90th percentile, and report the gate at both.

# Next major update: the agentic swarm desk

> Status: plan (3 Oct 2026). Nothing here is built yet. Poster: [swarm/swarm-architecture.png](swarm/swarm-architecture.png).

## Where we are

The desk is one engine (`src/desk/engine.ts`) running ten hand-built strategies on 4-second scanners, with two LLM
calls bolted on: the launch review (`src/desk/review.ts`, Claude → Gemini) and the strategy chat
(`src/desk/assistant.ts`). Around it, two things already exist that a swarm needs and most bots never get:

- **A judge.** The research observer records every pump.fun launch as point-in-time facts; rules reach the phone only
  after the out-of-sample gate (`src/research/qualify.ts`); the research platform runs pre-registered experiments with a
  sealed holdout (`src/research/experiments/`).
- **An agent API with no trading tool.** `src/research/api/tools.ts` gives agents audited, role-scoped tools
  (READ, RESEARCH, HYPOTHESIS, HOLDOUT). Any order-like tool answers `TRADING_NOT_AVAILABLE`. Every call is an
  `AgentAction` event. Roles exist (DATA, FEATURE, BACKTEST, LEAKAGE, ADVERSARIAL, HYPOTHESIS, CURIOSITY_SCOUT,
  SUPERVISOR …); nothing runs them yet.

What is missing is the part that makes it a swarm: agents that run continuously, talk through one shared record, hand
work to each other, and a place where the owner can direct coding from the dashboard.

## Principles (non-negotiable)

1. **Agents propose, code disposes.** No model signs, sizes or times an order. Execution stays the deterministic
   executor and guard. The agent API keeps no TRADING capability.
2. **One blackboard.** Agents communicate through events in the research store (observations, hypotheses,
   experiments, verdicts, tasks), never through each other's chat. Every action is audited and replayable.
3. **Evidence promotes, nothing else.** Hypothesis → experiment (pre-registered, holdout once) → TEST strategy version →
   qualification gate → phone CALL. LIVE only by the owner, on the capital ladder.
4. **The hot path stays code.** Scanners and exits never wait on a model. Agents work on events and slower loops
   (seconds to hours).
5. **Budgets and a kill switch.** Each agent has a token and dollar budget, a rate limit and an off switch; a
   swarm-wide latched kill stops all model calls. Claude → Gemini rotation already exists for reviews.
6. **External text is data.** Token descriptions, X posts and websites are written by strangers (and scammers); they
   never become instructions. Agents see them inside quoted data blocks.

## The roster

| Tier | Agent | Kind | Trigger | Writes | Status |
| --- | --- | --- | --- | --- | --- |
| Sense | Observer, verified watch, local feed, desk scanners, X reads | code | streams | facts, `VT`, tape | exists |
| Analyse | **Launch analyst** (today's Claude review) | LLM, low effort | shortlisted launch | verdict | move into swarm |
| | **Narrative scout** | LLM + code | new launch names/links | `NarrativeCluster`: copies of one story, the leader | new |
| | **Migration analyst** | code + LLM note | every graduation | `MigrationCard` at decision time; outcome later | new |
| | **Forensics** | LLM | rug, stop-out, missed runner | post-mortem with evidence ids | new (today ad hoc) |
| Research | **Curiosity scout** | LLM | hourly | observations → hypotheses | exists, not running |
| | **Backtest / leakage / adversarial** | LLM + tools | new hypothesis | experiments, attacks | roles exist |
| | **Supervisor** | LLM + rule | experiment ready | opens holdout once, verdict | role exists |
| | **Reporter** | code + LLM | daily | research update to ntfy | partly (call engine) |
| Decide | **Risk officer**, allocator | code | every order | limits, kill, sizes | exists (`risk/`, guard) |
| | **Executor** | code | approved order | TEST fills / LIVE swaps | exists |
| Build | **Workshop coder** | Claude Agent SDK | owner prompt or SUPPORTED hypothesis | diff in a worktree | new |
| Oversight | **CTO** | LLM, high effort + code checks | daily, every merge and deploy | quality ledger, Workshop tasks | new (runs as a session now) |
| | **Research department** (literature scout) | LLM + web search | weekly, on owner question | literature cards → hypotheses | new (runs as a session now) |

Why these new ones: the Troy Moose day (2 Oct) had eight copies of one story within 25 minutes. Moose graduated in
4 minutes with 727 different curve buyers and went to $284K; the desk's MIGRATION2 bought the wrong copy. Its filters
read "buy/sell 1.0–1.3" and "graduated too fast" as bad signs. A narrative scout ranks copies; a migration card records
what was knowable at graduation; the research loop decides whether that ranking pays, out of sample, before any
strategy uses it.

## Oversight: the CTO and the research department

The owner's verdict (3 Oct): "many things aren't quite professional enough", and 90 % of calls are rugs. Two roles watch
the whole desk instead of one strategy:

- **CTO.** Owns quality, not trading. Every day and after every merge or deploy it reads the diff, the test and build
  results, the logs and the dashboard state, and keeps `docs/cto/QUALITY-LEDGER.md`: findings ranked P0–P3 with
  evidence (`file:line`, log line, record id), a proposed fix and a status. It tracks the numbers that say whether the
  desk is professional: call precision (share of phone calls that reached their target before their stop), rug share
  of calls, phone volume per day, test count and flaky tests, observer and dashboard uptime, data freshness, provider
  error rates, spend. It never changes code itself: a fix becomes a Workshop task, or a small reviewed commit while
  the Workshop does not exist yet.
- **Research department.** Searches the literature and practitioner write-ups for best practice in this space
  (scam/rug detection, wash trading and bot volume, pump-and-dump dynamics, attention and narratives, backtest
  overfitting, Solana execution and MEV, exits and sizing for small capital). Each source becomes a card in
  `docs/research/literature/`: what was studied, on which data, the result in numbers, whether it transfers to
  pump.fun in 2026, and one to three pre-registered hypotheses written in the observer's feature language. Those
  hypotheses go to the curiosity scout's queue and only the qualification gate decides whether any of them reaches
  the phone.

Until the `swarm` process exists, both run as separate Claude Code sessions on their own branches, briefed by
`docs/swarm/briefs/CTO.md` and `docs/swarm/briefs/RESEARCH.md`; this desk's main session reviews and merges their work.

## Orchestration

A third process on Raven, next to the observer and the dashboard: `npm run swarm`.

- **Bus:** subscribes to the observer's local feed (127.0.0.1:3101) and the research store; emits `AgentTask` and
  `AgentResult` events.
- **Scheduler:** event triggers (graduation → migration analyst) and cron (hourly scout, nightly research, daily report).
- **Runtime:** the Claude API Tool Runner (`@anthropic-ai/sdk`, `betaZodTool` + `toolRunner`) over `toolManifest(role)`.
  Structured outputs for every verdict, prompt caching on the frozen system prompt and tool list,
  `fallbacks: "default"` for refusals. Model `claude-opus-5-5`, effort per role: `low` for high-volume analysts,
  `high` for research, `xhigh` for the coder. Gemini (`GEMINI_API_KEY`) covers analysts when Claude is down.
- **Budgets:** a spend ledger per agent and per day (default cap $5/day until evidence says more), visible on the
  dashboard; over budget means queued, not dropped.
- **Dashboard "Agents" panel:** each agent's state, last actions, spend today, on/off switch, the swarm kill switch.

## Direct coding on the localhost page: the Workshop

A new tab on `http://localhost:3000`, where the owner tells the desk what to change and watches it being built.

1. **Ask.** A prompt box with context chips: a token, an alert, a trade, an experiment, a file. Example: "MIGRATION2:
   don't call a fast graduation unfair when it had more than 300 different buyers."
2. **Isolate.** Each run gets its own git worktree (`../solana-bot-ws/<run>`, node_modules linked, not copied: Raven has
   about 1.5 GB free) from the current branch.
3. **Build.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, the Claude Code harness as a library) works in
   that worktree with its own Read/Edit/Bash/Grep tools. Hooks deny anything outside the worktree, any read of `.env`,
   key files or wallet files, and any network access except the package registry. The agent process gets no
   secrets in its environment. Progress streams to the page (plan, files, test output).
4. **Prove.** Gates, shown as a checklist: typecheck, the full test suite, the 24-hour tape replay (TEST metrics before
   and after), a secret scan of the diff, diff size.
5. **Decide.** Buttons: *Apply* (merge into the local branch, restart the desk in TEST, never LIVE), *Discard*, *Ask
   again*, optional *Push branch*. Every run's transcript, diff and gate results are kept.

One run at a time, a dollar cap per run, and the agent can never toggle LIVE, change capital or touch the signer.
Later the supervisor can open Workshop runs itself for SUPPORTED hypotheses; they still wait for the owner's *Apply*.

## Phases

| Phase | Builds | Done when |
| --- | --- | --- |
| **0 · Foundations** (1–2 days) | Model access (Anthropic credits, or a Claude Code login on Raven for the Workshop; `GEMINI_API_KEY`), the `swarm` process with bus, scheduler, budgets, kill switch; Agents panel | swarm runs idle on Raven, shows on the dashboard, spends $0 until switched on |
| **1 · Workshop** (3–4 days) | worktree manager, Agent SDK runner with hooks, gates, SSE page, apply/restart in TEST | a one-line change requested on the page arrives as a green, applied diff in under 15 min; a test proves the agent cannot read `.env` |
| **2 · Analysts** (3 days) | narrative scout, migration analyst, post-migration prices (PumpSwap pool logs for 6 h after each graduation) | replaying 2 Oct, the scout groups the 8 Troy Moose copies and ranks Moose first at its graduation |
| **3 · Research loop** (1 week) | curiosity scout, backtest/leakage/adversarial agents, supervisor, nightly run, daily report | 5+ hypotheses tested a week, every verdict with evidence ids, zero holdout reuse |
| **4 · Promotion** (1 week) | SUPPORTED → Workshop drafts a strategy version → TEST shadow → qualification → phone CALL | first strategy that reaches the phone without hand-written code |
| **5 · More chains** (later) | Blockscout sensors (Ethereum, Base, BNB, Robinhood Chain) as new tier-1 sources | same swarm, new facts |
| **6 · FOMO execution** (later) | FOMO session refresh and order adapter behind the same executor and guard | owner-approved orders through FOMO |

## Cost (estimate, capped by the budget ledger)

Launch analyst at today's limit (20 reviews/hour): about $0.01–0.03 each. Scouts and nightly research: a few dollars a
day. A Workshop run: roughly $0.50–5 depending on the change. The default cap of $5/day keeps the swarm cheaper than one
bad entry until it earns more.

## Risks and answers

| Risk | Answer |
| --- | --- |
| Model writes broken or unsafe code | worktree isolation, gates, owner *Apply*, TEST only |
| Prompt injection from token text or X posts | external text only as quoted data, no tool can trade, every action audited |
| Overfitting by many agents searching | pre-registered experiments, sealed holdout once, deflated Sharpe, trial counts |
| Spend runaway | per-agent budgets, daily cap, latched kill switch |
| Raven resources (1.7 GB RAM free, 1.5 GB disk) | one Workshop run at a time, linked node_modules, agents are API calls not local models |

## Decisions for the owner

1. **Model access:** add Anthropic API credits (the key currently reports "credit balance too low"), or log in to Claude
   Code on Raven for the Workshop.
2. **Daily cap:** $5/day to start?
3. **Workshop push:** may *Apply* also push the branch to GitHub, or local only?

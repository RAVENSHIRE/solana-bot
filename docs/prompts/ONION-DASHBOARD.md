# Prompt: the "onion" desk dashboard (for ChatGPT / Codex)

Paste everything below the line into ChatGPT (Codex, connected to this repository) or into the Codex CLI in the repo
root. It is self-contained. Work on a new branch, never on `main`, and open a pull request when done.

---

You are working in the `solana-bot` repository (TypeScript, Node 22, React 18 + Vite, no UI framework). The trading
desk page is one long scroll of a dozen panels. The owner wants an **onion layout**: the fundamental numbers first,
every individual scan folded away with a one-line summary, unfolding layer by layer down to single rows.

## Files

- `dashboard/src/Desk.tsx`: `DeskPanel` renders every panel in order (`Capital`, `Strategies`, `Stages`, `Telemetry`,
  `PreflightCard`, `OpeningScreen`, `GoldenPocket`, `LaunchRadar`, `Candidates`, `Positions`, `Watch`, `Ledger`,
  `PathAudit`). Each sits in a `<div id="desk-…" className="desk-anchor">`.
- `dashboard/src/main.tsx`: the app shell; the sidebar (`SECTIONS`) scrolls to those `desk-…` ids.
- `dashboard/src/styles.css`: all styles (CSS variables, light and dark).
- `src/desk/types.ts`: `DeskStatus` (the data each panel gets; read only, do not change it).
- `dashboard/src/use-trading.ts`: `TradingSession` (polling, `t.desk(action, body)`); do not change it.

## Layers

**Layer 0, always visible, never folded:** the TEST/LIVE banner, the controls, every error/halt message, and the
Phantom "awaiting signature" box. Safety information is never hidden.

**Layer 1, the KPI strip** (new component `KpiStrip`, directly under the controls). Compact cards in one responsive
row, each with a big number, a small label and a tone (good / warn / bad / neutral):

1. Equity and total PnL: `capital.equityUsd`, `capital.realizedPnlUsd + (capital.unrealizedPnlUsd ?? 0)`, fees.
2. Open positions: `capital.openPositions` and their value `capital.positionsValueUsd`.
3. One card per **enabled** strategy (`strategies[]`): label, `stats.trades`, `stats.winRatePct`, `stats.netPnlUsd`,
   `stats.profitFactor`, and `halted` as a bad tone. Disabled strategies are counted in one small "n off" chip.
4. Screens at a glance: opening breakouts (`opening.counts.SIGNAL`), golden pocket fills (`golden.counts.ENTRY`),
   radar signals (`launches.filter(l => l.signal).length`), qualified candidates (`candidates` with status
   `QUALIFIED`).
5. Data health: age of `lastScanAt` (warn > 2 min, bad > 10 min), `scanning`, `xFeed.lastError`, the number of
   `sources` entries, and which phone alerts are on (`opening.phone`).

Clicking a KPI card unfolds and scrolls to the matching fold.

**Layer 2, folds.** Wrap every panel except layer 0 and the KPI strip in a new `Fold` component:

```tsx
<Fold id="desk-opening" title="Opening screen" summary="3 breakouts · 12 strong opens · 5 rugs" tone="warn">
  <OpeningScreen d={d} t={t} />
</Fold>
```

- Build it on `<details>`/`<summary>` (keyboard and screen reader support for free). The summary row shows the title,
  the one-line summary and a tone dot. Keep the existing `id` on the fold so the sidebar keeps working.
- The open/closed state of each fold persists in `localStorage` under `desk.folds`, read and written inside
  `try/catch` (private windows throw); without storage everything still works with the defaults.
- Defaults: everything closed, except `Positions` when there is at least one open position.
- An "Expand all" / "Collapse all" toggle sits at the right end of the KPI strip.
- Sidebar navigation (`go(id)` in `main.tsx`) opens the target fold before scrolling to it.
- A fold whose content gains something urgent opens itself once and pulses its dot: a new open position, a new
  breakout (`opening.counts.SIGNAL` grows), a new golden pocket fill, a strategy halt. Track the previous counts in a
  ref; do not re-open a fold the owner closed after that.

Summary lines (computed from `DeskStatus`, short, numbers first):

| Fold | Summary |
| --- | --- |
| Strategies | `4 on · 2 off · best: CRASH_V1 +$0.84` |
| Stages + telemetry + pre-flight (one fold, "Pipeline") | last event text and its age |
| Opening screen | `SIGNAL breakouts · STRONG strong opens · RUG rugs` from `opening.counts` |
| Golden pocket | `watched pools · DIP dipped · ENTRY filled` from `golden.counts` |
| Launch radar | `n shortlisted · n signals · n scams` (review verdict `SCAM`) |
| Candidates | `n qualified · n waiting · n filtered` |
| Positions | `n open · $value · unrealized $x` |
| Watch | `n rules · n triggered` |
| Ledger | `n trades today · net $x` |
| Execution path | number of layers and the provider of the quote layer |

**Layer 3** is the existing panel content, unchanged. **Layer 4**: tables already have row details
(`CandidateDetail`, `Holders`); keep them as they are.

## Constraints

- Presentation only. Do not change any server file (`dashboard/server/**`), `src/**`, the trading actions, the
  confirmation dialogs, or what any button does. No new npm dependencies.
- Keep every `aria-label` and every `desk-…` id. Keep the TEST (calm) and LIVE (red) colour coding.
- Works at phone width (375 px): the KPI strip wraps to two columns, no horizontal page scroll, 16 px side gutter.
- Respect `prefers-reduced-motion` for the pulse and the scroll.
- Match the code style of `Desk.tsx`: small function components, terse helpers, no comments that restate the code.

## Done when

- `npm run typecheck` and `npm test` pass in the repo root, and `npm run build` passes in `dashboard/`.
- The first screen of the desk shows the banner, the controls and the KPI strip; nothing else is unfolded unless a
  position is open.
- Every fold's summary is correct for an empty desk (no data yet: shows "—", never `NaN` or `undefined`) and for a
  busy one.
- Reloading the page keeps the folds the owner opened.
- A short note in `docs/DESK.md` ("Layout") describes the layers.

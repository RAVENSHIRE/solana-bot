import './polyfills';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotState } from "../shared/state";
import { Chart, Sparkline } from "./Chart";
import { useBotState } from "./use-state";
import { WalletPanel } from "./WalletPanel";
import { DeskPanel } from './Desk';
import { useTradingSession } from "./use-trading";
import {
  duration,
  money,
  numeric,
  percent,
  present,
  price,
  short,
  time,
  tone,
} from "./format";
import "./styles.css";

type Tab = "Positions" | "Decisions" | "Trades" | "Equity";
const tabs: Tab[] = ["Positions", "Decisions", "Trades", "Equity"];
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="2" />
        <rect x="15" y="3" width="6" height="6" rx="2" />
        <rect x="3" y="15" width="6" height="6" rx="2" />
        <rect x="15" y="15" width="6" height="6" rx="2" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v15a2 2 0 0 0 2 2h15M6 15l4-6 4 3 6-8" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="3" />
        <path d="M4 6V4h13M16 11h5v5h-5z" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l3-7 4 14 3-7h4" />
        <rect x="2" y="2" width="20" height="20" rx="5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" />
      </>
    ),
    arrow: <path d="m14 6-6 6 6 6M8 12h13" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v12h5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.chart}
    </svg>
  );
}
function Copy({ value }: { value: string | null | undefined }) {
  const [message, setMessage] = useState<string | null>(null);
  if (!value) return <span>--</span>;
  return (
    <button
      className="copy-button"
      title={value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setMessage("Copied");
        } catch {
          setMessage("Copy unavailable");
        }
        setTimeout(() => setMessage(null), 2000);
      }}
    >
      <span>{message || short(value)}</span>
      <Icon name="copy" size={12} />
    </button>
  );
}
function Badge({ action }: { action: string | null | undefined }) {
  return (
    <span className={`badge ${action?.toLowerCase() || ""}`}>
      {action || "--"}
    </span>
  );
}
function Empty({ label }: { label: string }) {
  return (
    <div className="empty-panel">
      <Icon name="layers" size={26} />
      <strong>No {label.toLowerCase()} recorded</strong>
      <p>Updates appear automatically as the bot writes its state.</p>
    </div>
  );
}

function Decisions({ data }: { data: BotState["decisions"] }) {
  if (!data.length) return <Empty label="decisions" />;
  return (
    <div>
      {[...data].reverse().map((d) => {
        const p = d.probabilities;
        const complete =
          present(p.long_pct) && present(p.short_pct) && present(p.wait_pct);
        const total =
          (p.long_pct ?? 0) + (p.short_pct ?? 0) + (p.wait_pct ?? 0);
        const valid = complete && Math.abs(total - 100) <= 0.5;
        return (
          <article className="decision" key={d.id}>
            <div className="row">
              <div className="row-start">
                <strong>{d.symbol || "--"}</strong>
                <Badge action={d.action} />
              </div>
              <time title={d.timestamp}>{time(d.timestamp)}</time>
            </div>
            <p className="action-label">{d.action_label || "--"}</p>
            {d.strategy_score === undefined && (
              <>
                <div
                  className={`probability-bar ${valid ? "" : "unavailable"}`}
                  role="img"
                  aria-label={`Long ${percent(p.long_pct)}, short ${percent(p.short_pct)}, wait ${percent(p.wait_pct)}`}
                >
                  {valid && (
                    <>
                      <span
                        className="long-segment"
                        style={{ width: `${p.long_pct}%` }}
                      />
                      <span
                        className="short-segment"
                        style={{ width: `${p.short_pct}%` }}
                      />
                      <span
                        className="wait-segment"
                        style={{ width: `${p.wait_pct}%` }}
                      />
                    </>
                  )}
                </div>
                <div className="probability-labels">
                  <span className="positive">Long {percent(p.long_pct)}</span>
                  <span className="negative">Short {percent(p.short_pct)}</span>
                  <span>Wait {percent(p.wait_pct)}</span>
                </div>
              </>
            )}
            <div className="decision-details">
              <span>
                {d.strategy_score !== undefined
                  ? `Strategy score ${numeric(d.strategy_score, 1)} / 100`
                  : `Confidence ${percent(d.confidence_pct)}`}
              </span>
              <span>
                {present(d.latency_ms) ? `${numeric(d.latency_ms)} ms` : "--"}
              </span>
            </div>
            <div className="safety">
              <span>
                Rug score <b>{percent(d.safety.rug_score_pct)}</b>
              </span>
              <span>
                Liquidity <b>{money(d.safety.liquidity_usd)}</b>
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
function Positions({ data }: { data: BotState["positions"] }) {
  if (!data.length) return <Empty label="positions" />;
  return (
    <div>
      {data.map((p) => (
        <article className="position" key={p.id}>
          <div className="row">
            <div className="row-start">
              <strong>{p.symbol || "--"}</strong>
              <Badge action={p.side} />
            </div>
            <span className={`pnl ${tone(p.unrealized_pnl_pct)}`}>
              {money(p.unrealized_pnl_usd)}{" "}
              <small>({percent(p.unrealized_pnl_pct)})</small>
            </span>
          </div>
          <div className="position-address">
            <Copy value={p.token_address} />
            <time title={p.opened_at}>{time(p.opened_at)}</time>
          </div>
          <dl className="detail-grid">
            <div>
              <dt>Entry price</dt>
              <dd>{price(p.entry_price_usd)}</dd>
            </div>
            <div>
              <dt>Current price</dt>
              <dd>{price(p.current_price_usd)}</dd>
            </div>
            <div>
              <dt>Size · tokens</dt>
              <dd>{numeric(p.size_tokens, 8)}</dd>
            </div>
            <div>
              <dt>Stop loss</dt>
              <dd>{price(p.stop_loss_usd)}</dd>
            </div>
            <div>
              <dt>Take profit</dt>
              <dd>{price(p.take_profit_usd)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
function Trades({ data }: { data: BotState["trade_history"] }) {
  if (!data.length) return <Empty label="trades" />;
  return (
    <div>
      {[...data].reverse().map((t) => (
        <article className="position" key={t.id}>
          <div className="row">
            <div className="row-start">
              <strong>{t.symbol || "--"}</strong>
              <Badge action={t.side} />
            </div>
            <time title={t.timestamp}>{time(t.timestamp)}</time>
          </div>
          <dl className="detail-grid">
            <div>
              <dt>Realized P&amp;L</dt>
              <dd className={tone(t.realized_pnl_pct)}>
                {money(t.realized_pnl_usd)}{" "}
                <small>({percent(t.realized_pnl_pct)})</small>
              </dd>
            </div>
            <div>
              <dt>Slippage</dt>
              <dd>{percent(t.slippage_pct)}</dd>
            </div>
          </dl>
          <div className="row transaction">
            <span>Transaction</span>
            <Copy value={t.tx_hash} />
          </div>
        </article>
      ))}
    </div>
  );
}

const DecisionList = React.memo(Decisions);
const PositionList = React.memo(Positions);
const TradeList = React.memo(Trades);
const PriceChart = React.memo(Chart);
const EMPTY: never[] = [];

function App() {
  const trading=useTradingSession();
  const [workspace,setWorkspace]=useState<'wallet'|'market'>('wallet');
  const feed = useBotState();
  const state = feed.state,
    meta = state?.meta,
    metrics = state?.metrics;
  const equityPoints = React.useMemo(
    () =>
      (state?.equity_curve ?? EMPTY).map((p) => ({
        timestamp: p.timestamp,
        price: p.equity_usd,
      })),
    [state?.equity_curve],
  );
  const [tab, setTab] = useState<Tab>("Decisions");
  const [selected, setSelected] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (showInfo) dialog.current?.showModal();
  }, [showInfo]);
  const item = state?.watchlist.find((t) => t.id === selected);
  const active = state?.active_token;
  const runtime = feed.runtime;
  const solBasis = feed.source === "checkpoint" || feed.source === "runtime";
  const isActive = !item || item.id === active?.contract_address;
  const chartToken = item
    ? (feed.token_charts?.[item.id] ?? (isActive ? active : null))
    : active;
  const symbol = item ? item.symbol : active?.symbol;
  const tokenName = item ? item.name : active?.name;
  const currentPrice = item ? item.price_usd : active?.current_price_usd;
  const status = !feed.connected
    ? "Connecting"
    : feed.status === "invalid"
      ? "Invalid state"
      : feed.status === "missing"
        ? "Waiting for state"
        : feed.stale
          ? "Stale state"
          : runtime
            ? "Bot telemetry connected"
            : "Portfolio connected";
  const healthy = feed.connected && feed.status === "ready" && !feed.stale;
  const cards = [
    { label: "Equity", value: money(metrics?.total_equity_usd) },
    {
      label: solBasis ? "Return · SOL book" : "Return",
      value: percent(metrics?.return_percentage),
      color: tone(metrics?.return_percentage),
    },
    { label: "Fees paid", value: money(metrics?.gas_priority_fees_paid_usd) },
    {
      label: "Trades",
      value: numeric(metrics?.total_trades),
      sub: `${percent(metrics?.win_rate_percentage)} won`,
    },
    { label: "Avg. hold", value: duration(metrics?.avg_hold_duration_seconds) },
    {
      label: runtime ? "Drawdown · SOL history" : "Max drawdown",
      value: percent(metrics?.max_drawdown_percentage),
      color:
        present(metrics?.max_drawdown_percentage) &&
        metrics.max_drawdown_percentage > 0
          ? "negative"
          : "",
    },
    {
      label: "Decision time",
      value: present(metrics?.avg_decision_time_ms)
        ? `${numeric(metrics.avg_decision_time_ms)} ms`
        : "--",
      sub: `${numeric(metrics?.total_decisions)} ${runtime ? "retained decisions" : "decisions"}`,
    },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Dashboard navigation">
        <div className="brand" title="Solana Bot">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <nav>
          <button
            title="Dashboard overview"
            aria-label="Dashboard overview"
            onClick={() => {
              setWorkspace("wallet");
              setTab("Decisions");
              setSelected(null);
            }}
          >
            <Icon name="grid" />
          </button>
          <button
            title="Positions"
            aria-label="Positions"
            className={workspace==="market" && tab === "Positions" ? "selected" : ""}
            onClick={() => {setWorkspace("market");setTab("Positions");}}
          >
            <Icon name="wallet" />
          </button>
          <button
            title="Decisions"
            aria-label="Decisions"
            className={workspace==="market" && tab === "Decisions" ? "selected" : ""}
            onClick={() => {setWorkspace("market");setTab("Decisions");}}
          >
            <Icon name="activity" />
          </button>
          <button
            title="Trades"
            aria-label="Trades"
            className={workspace==="market" && tab === "Trades" ? "selected" : ""}
            onClick={() => {setWorkspace("market");setTab("Trades");}}
          >
            <Icon name="layers" />
          </button>
          <button
            title="Equity"
            aria-label="Equity"
            className={workspace==="market" && tab === "Equity" ? "selected" : ""}
            onClick={() => {setWorkspace("market");setTab("Equity");}}
          >
            <Icon name="chart" />
          </button>
        </nav>
        <button
          className="sidebar-info"
          title="Data source information"
          aria-label="Data source information"
          onClick={() => setShowInfo(true)}
        >
          <Icon name="info" />
        </button>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <div className="topbar-left">
            <Icon name="grid" size={16} />
            <span className="topbar-divider" />
            <span>Trading workspace</span>
          </div>
          <div className="stats" hidden={workspace==='wallet'} title="Active / skipped / closed tokens">
            <Icon name="clock" size={16} />
            <span>
              Stats ({numeric(meta?.active_tokens_count)} |{" "}
              {numeric(meta?.skipped_tokens_count)} |{" "}
              {numeric(meta?.closed_tokens_count)})
            </span>
          </div>
        </div>
        <main className="main">
          <header className="page-header">
            <div className="page-heading">
              <Icon name="arrow" size={19} />
              <h1>{workspace==='wallet'?'Solana trading desk':'Simulation / backtest'}</h1>
              {workspace==='wallet'?<p>Phantom wallet · TEST and LIVE share one pipeline</p>:<p>
                {meta?.network || "--"} <span>·</span>{" "}
                {present(meta?.decision_cadence_seconds)
                  ? `${runtime ? "scan" : "a decision"} every ${numeric(meta.decision_cadence_seconds, 1)} seconds`
                  : "Decision cadence --"}
              </p>}
            </div>
            <div className="header-actions">
              <span className="mode">
                <Icon name="activity" size={16} />
                {workspace==='wallet'?(!trading.online?'OFFLINE':trading.view?.mode==='LIVE'?`LIVE${trading.view.desk?.scanner?' · RUNNING':''}`:`TEST${trading.view?.desk?.scanner?' · RUNNING':''}`):`SIMULATION / BACKTEST · ${meta?.mode || "--"}`}
              </span>
              <button
                className="source-button"
                onClick={() => setShowInfo(true)}
              >
                <Icon name="info" size={17} />
                Data source
              </button>
            </div>
          </header>
          <nav className="workspace-tabs" aria-label="Dashboard workspace">
            <button aria-pressed={workspace==='wallet'} onClick={()=>setWorkspace('wallet')}>Trading desk · TEST / LIVE</button>
            <button aria-pressed={workspace==='market'} onClick={()=>setWorkspace('market')}>Simulation / backtest</button>
          </nav>
          <div hidden={workspace!=='wallet'} className="desk-workspace">
            <DeskPanel t={trading}/>
            <WalletPanel address={trading.address} connected={trading.connected}/>
          </div>
          <div hidden={workspace!=='market'}>
          <p className="sim-banner" role="note"><strong>SIMULATION / BACKTEST</strong> Recorded telemetry of the separate strategy engine. Its equity, trades and PnL are never mixed with TEST or LIVE.</p>
          <section className="metric-grid" aria-label="Performance metrics">
            {cards.map((card) => (
              <article className="metric" key={card.label}>
                <h2>{card.label}</h2>
                <strong className={card.color || ""}>{card.value}</strong>
                {card.sub && <span>{card.sub}</span>}
              </article>
            ))}
          </section>
          {feed.source === "checkpoint" && (
            <p className="feed-notice" role="status">
              Portfolio connected. Runtime telemetry is missing. Start the bot
              with <code>npm run sim</code> from the repository root.
            </p>
          )}
          {runtime && !state?.watchlist.length && (
            <p className="feed-notice" role="status">
              Bot telemetry connected. Waiting for the first token evaluation.
            </p>
          )}
          <div className="content-grid">
            <section className="market-column" aria-label="Market overview">
              <div className="market-panel panel">
                <div className="market-header">
                  <div className="token-identity">
                    <span className="token-avatar">
                      {symbol?.slice(0, 1) || "—"}
                    </span>
                    <div>
                      <h2>{tokenName || "Waiting for a token"}</h2>
                      <span>{symbol || "--"}</span>
                    </div>
                    <strong
                      className={`token-price ${tone(chartToken?.baseline_entry_price != null && currentPrice != null ? currentPrice - chartToken.baseline_entry_price : null)}`}
                    >
                      {price(currentPrice)}
                    </strong>
                  </div>
                  <div className="market-range">
                    <span title="Price change at the two-minute high">
                      H{" "}
                      <b className="positive">
                        {percent(chartToken?.price_change_2m_high)}
                      </b>
                    </span>
                    <span title="Price change at the two-minute low">
                      L{" "}
                      <b className="negative">
                        {percent(chartToken?.price_change_2m_low)}
                      </b>
                    </span>
                    <span>2m change</span>
                  </div>
                </div>
                <PriceChart
                  points={chartToken?.ticks ?? EMPTY}
                  baseline={chartToken?.baseline_entry_price}
                />
                <div className="market-footer">
                  <Copy value={chartToken?.contract_address} />
                  <span>
                    {item && !chartToken
                      ? "No timestamped observations for this token"
                      : "Recorded price ticks · USD"}
                  </span>
                </div>
              </div>
              <div className="watchlist" aria-label="Token watchlist">
                {state?.watchlist.length ? (
                  state.watchlist.map((t) => (
                    <button
                      key={t.id}
                      className={`watch-card ${selected === t.id || (!selected && t.id === active?.contract_address) ? "active" : ""}`}
                      onClick={() => setSelected(t.id)}
                      aria-pressed={
                        selected === t.id ||
                        (!selected && t.id === active?.contract_address)
                      }
                    >
                      <div className="watch-name">
                        <span className="small-avatar">
                          {t.symbol?.slice(0, 1) || "—"}
                        </span>
                        {t.name || t.symbol || "--"}
                      </div>
                      <div className="watch-price">
                        <strong>{price(t.price_usd)}</strong>
                        <Sparkline values={t.sparkline} />
                      </div>
                      <div className="watch-action">
                        <Badge action={t.ai_status.action} />
                        <span>
                          {t.strategy_score !== undefined
                            ? `Score ${numeric(t.strategy_score, 1)}`
                            : percent(t.ai_status.confidence_pct)}
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="watch-empty">
                    <Icon name="layers" size={18} />
                    <span>Watchlist waiting for token data</span>
                    <span>--</span>
                  </div>
                )}
              </div>
            </section>
            <section
              className="activity-panel panel"
              aria-label="Trading activity"
            >
              <div className="tabs" role="tablist" aria-label="Activity views">
                {tabs.map((t, i) => (
                  <button
                    id={`tab-${t}`}
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    aria-controls={`panel-${t}`}
                    tabIndex={tab === t ? 0 : -1}
                    onClick={() => setTab(t)}
                    onKeyDown={(e) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          e.key,
                        )
                      ) {
                        e.preventDefault();
                        const next =
                          e.key === "Home"
                            ? tabs[0]
                            : e.key === "End"
                              ? tabs[3]
                              : tabs[
                                  (i + (e.key === "ArrowRight" ? 1 : 3)) %
                                    tabs.length
                                ];
                        setTab(next);
                        document.getElementById(`tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div
                className="activity-scroll"
                role="tabpanel"
                id={`panel-${tab}`}
                aria-labelledby={`tab-${tab}`}
                tabIndex={0}
              >
                {tab === "Decisions" && (
                  <DecisionList data={state?.decisions ?? EMPTY} />
                )}
                {tab === "Positions" && (
                  <PositionList data={state?.positions ?? EMPTY} />
                )}
                {tab === "Trades" && (
                  <TradeList data={state?.trade_history ?? EMPTY} />
                )}
                {tab === "Equity" && (
                  <div className="equity-view">
                    <div className="equity-heading">
                      <span>Portfolio equity</span>
                      <strong>{money(metrics?.total_equity_usd)}</strong>
                    </div>
                    <PriceChart label="Equity" compact points={equityPoints} />
                    <p>USD equity over recorded observations</p>
                  </div>
                )}
              </div>
              {solBasis && (
                <p className="checkpoint-note">
                  {runtime
                    ? "Measured strategy scores · P&L percentages are in SOL."
                    : "Portfolio checkpoint · P&L percentages are in SOL."}
                </p>
              )}
            </section>
          </div>
          <footer className="statusbar">
            <div role="status">
              <span className={`status-dot ${healthy ? "healthy" : ""}`} />
              {status}
              {feed.updated_at && (
                <span className="updated">
                  · updated {time(feed.updated_at)}
                  {feed.stale ? ` · ${duration(feed.age)} ago` : ""}
                </span>
              )}
            </div>
            <div>
              RPC{" "}
              {present(meta?.rpc_latency_ms)
                ? `${numeric(meta.rpc_latency_ms)} ms`
                : "--"}
              <span className="footer-separator">·</span>Read-only monitor
            </div>
          </footer>
          {feed.message && (
            <p className="feed-message" role="status">
              {feed.message}
            </p>
          )}
          </div>
        </main>
      </div>
      {showInfo && (
        <div className="modal-backdrop" onClick={() => setShowInfo(false)}>
          <dialog
            ref={dialog}
            onCancel={() => setShowInfo(false)}
            aria-labelledby="source-title"
            className="source-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowInfo(false);
            }}
          >
            <div className="row">
              <h2 id="source-title">Data source</h2>
              <button
                autoFocus
                aria-label="Close data source"
                onClick={() => setShowInfo(false)}
              >
                ×
              </button>
            </div>
            <p>
              This dashboard reads the local bot state and receives updates
              automatically. The separate Phantom session can submit guarded swaps after you start it and approve signing in your wallet.
            </p>
            <dl>
              <div>
                <dt>Connection</dt>
                <dd>{status}</dd>
              </div>
              <div>
                <dt>State format</dt>
                <dd>
                  {feed.source === "checkpoint"
                    ? "Portfolio checkpoint v1"
                    : feed.source === "runtime"
                      ? "Portfolio + bot telemetry v1"
                      : feed.source === "contract"
                        ? "Dashboard contract"
                        : "--"}
                </dd>
              </div>
              <div>
                <dt>File</dt>
                <dd className="file-path">{feed.file_path ?? "--"}</dd>
              </div>
              <div>
                <dt>Last file update</dt>
                <dd>
                  {feed.updated_at
                    ? new Date(feed.updated_at).toLocaleString()
                    : "--"}
                </dd>
              </div>
            </dl>
            <p>
              {feed.source === "checkpoint"
                ? "This checkpoint stores SOL accounting. Return uses cash plus position entry costs, and average hold uses the retained closed-trade history. USD valuation, price ticks, AI decisions, RPC latency and other unrecorded telemetry display --."
                : runtime
                  ? "The bot records prices, decisions, RPC latency and equity. Strategy scores are rule-based, not AI confidence. Return uses SOL book value; drawdown uses retained SOL equity history. USD fees and P&L remain -- when execution-time conversion is unavailable. USD equity history starts when the producer records USD samples."
                  : "All values come from the state file. Missing measurements display --. An empty chart means no observations have been recorded."}
            </p>
          </dialog>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

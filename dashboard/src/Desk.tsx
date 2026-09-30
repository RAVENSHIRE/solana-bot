import { Fragment, useMemo, useState } from 'react';
import type { Candidate, DeskEvent, DeskStatus, Evidence, Preflight, Stage, StrategyView } from '../../src/desk/types';
import type { TradingSession } from './use-trading';
import { money, numeric, short, time } from './format';

const PIPELINE: Array<{ label: string; stages: Stage[] }> = [
  { label: 'Scan', stages: ['SCANNING'] }, { label: 'Signal', stages: ['QUALIFIED', 'WAITING', 'WATCHLIST'] }, { label: 'Filters', stages: ['FILTERED'] },
  { label: 'Quote', stages: ['QUOTE'] }, { label: 'DEX / route', stages: ['ROUTE'] }, { label: 'Simulation', stages: ['SIMULATION'] },
  { label: 'Pre-flight', stages: ['PREFLIGHT'] }, { label: 'Phantom signature', stages: ['AWAITING_SIGNATURE'] }, { label: 'Submitted', stages: ['SUBMITTED'] },
  { label: 'Confirmed', stages: ['CONFIRMED'] }, { label: 'Position', stages: ['POSITION'] }, { label: 'Exit', stages: ['EXIT'] }, { label: 'Realized PnL', stages: ['PNL'] },
];
const EXPLAIN: Record<string, string> = {
  STOP_CURRENT_MODE_FIRST: 'Stop the running TEST or LIVE session before switching mode.',
  STOP_LIVE_FIRST: 'Stop the LIVE session before starting TEST.', STOP_TEST_FIRST: 'Stop TEST before starting a LIVE session.',
  WALLET_SESSION_REQUIRED: 'Connect Phantom and keep this tab open to run LIVE.', SESSION_REQUIRED: 'Connect Phantom first.',
  TRANSACTION_RECONCILIATION_REQUIRED: 'A transaction outcome is unknown. Check it on Solscan before resuming; nothing is retried automatically.',
  RPC_NOT_CONFIGURED: 'Set RPC_ENDPOINTS in the local .env.', JUPITER_API_KEY_REQUIRED: 'Set JUPITER_API_KEY in the local .env (never in the browser).',
  INSTANCE_LOCK: 'Another dashboard process owns data-desk. Close it first.', SCANNER_OFF: 'Start the scanner first.',
  RESET_TEST_ONLY: 'Reset is only available in TEST.', INVALID_STRATEGY: 'Unknown strategy.',
  POSITION_NOT_FOUND: 'That position is no longer open in the desk ledger (already sold, or held outside the desk: sell it in your wallet).',
  AUTO_CONFIRM_UNAVAILABLE_FOR_DOMAIN: 'Phantom does not offer Auto-Confirm for this domain (only for domains it has approved). LIVE orders need your approval in Phantom within 15 s.',
};
const describe = (code: string | null) => code ? EXPLAIN[code] ?? code.replaceAll('_', ' ') : null;
const fine = (v: number | null | undefined, d = 4) => v === null || v === undefined || !Number.isFinite(v) ? '--' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
const sol = (lamports: string | null | undefined) => lamports == null ? '--' : `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
const ago = (at: number | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
const pct = (v: number | null | undefined, d = 1) => v === null || v === undefined ? 'UNKNOWN' : `${v.toFixed(d)}%`;
const usdOrUnknown = (v: number | null | undefined) => v === null || v === undefined ? 'UNKNOWN' : money(v);

export function DeskPanel({ t }: { t: TradingSession }) {
  const v = t.view, d = v?.desk ?? null, live = v?.mode === 'LIVE', localKey = live && d?.signer === 'LOCAL_KEY';
  return <section className={`desk ${live ? 'desk-live' : 'desk-test'}`} aria-label="Trading desk">
    <div className={`env-banner ${live ? 'live' : 'test'}`} role="status">
      <strong>{live ? (localKey ? 'LIVE — REAL FUNDS · SIGNED AUTOMATICALLY BY THE LOCAL KEY' : 'LIVE — REAL FUNDS') : 'TEST / PAPER — NO REAL TRANSACTIONS'}</strong>
      <span>{!live ? 'Same scanner, strategy, risk, quote, route and simulation as LIVE. No signature is ever requested.'
        : localKey ? 'Orders are signed by WALLET_PRIVATE_KEY from .env without any approval, also when this tab is closed. STOP LIVE SESSION ends it.'
        : 'Signer: PHANTOM. Every order, including exits, needs your approval in Phantom within 15 s. For unattended trading add DESK_LIVE_SIGNER=local-key to .env in the repo root, save it, and restart the dashboard.'}</span>
    </div>
    <Controls t={t} d={d} />
    {v?.deskError && <p className="trading-error" role="alert">Desk unavailable: {describe(v.deskError)}</p>}
    {t.error && <p className="trading-error" role="alert">{describe(t.error)}</p>}
    {d?.halted && <p className="trading-error" role="alert">HALTED: {describe(d.halted)}</p>}
    {live && v?.pending && <div className="signature-request" role="status">
      <strong>AWAITING PHANTOM SIGNATURE</strong>
      <span>A pre-flight-checked transaction is waiting. Expires {time(new Date(v.pending.expiresAt).toISOString())}; expired quotes are never sent.</span>
      <button className="primary-action" disabled={!!t.busy || !t.online} onClick={() => void t.approve()}>Review in Phantom</button>
    </div>}
    {d && <>
      <Capital d={d} />
      <Strategies d={d} t={t} />
      <Stages events={d.events} />
      <div className="desk-grid">
        <Telemetry events={d.events} />
        <PreflightCard p={d.preflights[0] ?? null} live={live} />
      </div>
      <Candidates list={d.candidates} probe={live ? null : mint => void t.desk('probe', { mint })} busy={!!t.busy} />
      <Positions d={d} busy={!!t.busy || !t.online} exit={p => {
        const how = !live ? 'This is a TEST position: the sale is paper only.' : localKey ? 'The local key signs the sale immediately (REAL FUNDS).'
          : 'Phantom will ask you to approve the sale within 15 s (REAL FUNDS).';
        if (window.confirm(`EXIT NOW: sell the whole ${p.symbol ?? p.mint} position at the current Jupiter quote (exit slippage applies)? ${how}`)) void t.desk('exit', { mint: p.mint });
      }} />
      <Ledger d={d} />
      <PathAudit d={d} />
    </>}
    {!d && !v?.deskError && <p className="trading-intro">Starting the local desk…</p>}
  </section>;
}

function Controls({ t, d }: { t: TradingSession; d: DeskStatus | null }) {
  const v = t.view, live = v?.mode === 'LIVE', running = !!d?.scanner, busy = !!t.busy || !t.online, localKey = live && d?.signer === 'LOCAL_KEY';
  const chip = (on: boolean, yes: string, no: string) => <span className={`chip ${on ? 'on' : 'off'}`}>{on ? yes : no}</span>;
  return <div className="desk-controls">
    <div className="mode-switch" role="radiogroup" aria-label="Environment">
      {(['PAPER', 'LIVE'] as const).map(m => <button key={m} role="radio" aria-checked={v?.mode === m} disabled={busy || running}
        onClick={() => void t.desk('select-mode', { mode: m })}>{m === 'PAPER' ? '● TEST / PAPER' : '● LIVE'}</button>)}
    </div>
    <div className="chips">
      {chip(running, 'SCANNER: ON', 'SCANNER: OFF')}
      {chip(!!d?.execution, 'ENTRIES: ON', running ? 'ENTRIES: PAUSED (exits keep running)' : 'ENTRIES: OFF')}
      {localKey ? <span className="chip live">WALLET: LOCAL KEY {short(d?.wallet.address ?? null)} (signs automatically)</span>
        : t.connected ? chip(true, `WALLET: PHANTOM ${short(t.address)}`, '') : d?.wallet.source === 'CONFIGURED'
        ? <span className="chip on">WALLET: .env ADDRESS {short(d.wallet.address)} (TEST, no signing)</span> : chip(false, '', 'WALLET: DISCONNECTED')}
      {live && running && d?.entriesLeft !== null && d?.entriesLeft !== undefined && <span className="chip on">NEW ENTRIES LEFT: {d.entriesLeft}</span>}
      {!live && chip(!!d?.drill, 'DRILL: ON', 'DRILL: OFF')}
      {d?.scanning && <span className="chip on">SCANNING…</span>}
    </div>
    <div className="trading-actions">
      {!t.connected ? <button className="source-button" disabled={!!t.busy} onClick={() => void t.connect()}>{t.busy === 'connect' ? 'Connecting…' : 'Connect Phantom'}</button>
        : <button className="source-button" disabled={!!t.busy} onClick={() => void t.disconnect()}>Disconnect</button>}
      {!live ? <>
        <button className="primary-action" disabled={busy || running} onClick={() => void t.desk('start-test')}>START TEST</button>
        <button className="stop-action" disabled={busy || !running} onClick={() => void t.desk('stop-test')}>STOP TEST</button>
        <button className="source-button" disabled={busy} title="Paper entries in the best safe candidate even when strategy gates are not met"
          onClick={() => void t.desk(d?.drill ? 'drill-off' : 'drill-on')}>{d?.drill ? 'TEST DRILL: TURN OFF' : 'TEST DRILL: TURN ON'}</button>
        <button className="source-button" disabled={busy || running} title="Archive both TEST ledgers and restart every sleeve at its planned capital"
          onClick={() => { if (window.confirm('Archive both TEST ledgers (kept on disk) and restart every TEST sleeve at its planned capital? Open paper positions end with the archive.')) void t.desk('reset-test'); }}>RESET TEST</button>
      </> : <>
        <button className="primary-action live" disabled={busy || running || (!t.connected && !localKey)}
          onClick={() => void (async () => {
            if (localKey) {
              if (window.confirm('Start LIVE with REAL FUNDS? Orders will be signed automatically by the local key from .env, without any approval.')) await t.desk('start-live');
              return;
            }
            if (await t.desk('start-live') && !t.auto && !t.autoUnsupported) await t.enableAuto();
          })()}>START LIVE SESSION</button>
        <button className="stop-action" disabled={busy || !running} onClick={() => void t.desk('stop-live')}>STOP LIVE SESSION</button>
      </>}
      <button className="source-button" disabled={busy || !running || !d?.execution} title="No new entries; open positions keep their exits"
        onClick={() => void t.desk('pause')}>PAUSE ENTRIES</button>
      <button className="source-button" disabled={busy || !running || !!d?.execution} onClick={() => void t.desk('resume')}>RESUME ENTRIES</button>
      {live && !localKey && t.connected && !t.auto && !t.autoUnsupported && <button className="source-button" disabled={busy} onClick={() => void t.enableAuto()}>Enable Auto-Confirm</button>}
      {live && !localKey && t.auto && <span className="chip on">Auto-Confirm granted in Phantom</span>}
      {live && !localKey && t.autoUnsupported && <span className="chip off">Auto-Confirm: not offered for this domain</span>}
    </div>
    {live && running && !localKey && !t.auto && <p className="trading-error" role="alert">
      Auto-Confirm is OFF: every LIVE order waits at most 15 s for your approval in Phantom, and a missed approval pauses entries.
      {t.autoUnsupported ? ' Phantom offers Auto-Confirm only to domains it has approved, not to this local dashboard: approve each order in Phantom.'
        : <> Click <strong>Enable Auto-Confirm</strong> and accept the permission in Phantom once for this session.</>}</p>}
    <p className="desk-note">{d?.message ? `Last result: ${describe(d.message)} · ` : ''}Last scan {ago(d?.lastScanAt)}{d?.nextScanAt ? ` · next ${ago(d.nextScanAt)}` : ''}. Stopping keeps all telemetry and ledger data.</p>
  </div>;
}

function Capital({ d }: { d: DeskStatus }) {
  const c = d.capital, test = d.mode === 'PAPER';
  const row = (label: string, value: string, note?: string) => <div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
  return <div className="capital">
    <section><h3>{d.wallet.source === 'LOCAL_KEY' ? 'Wallet · local key' : 'Phantom wallet'} <em>actual</em></h3>
      {row('Actual SOL', c.walletSol === null ? (d.wallet.address ? 'reading…' : '--') : `${numeric(c.walletSol, 6)} SOL`,
        d.wallet.source === 'LOCAL_KEY' ? `${short(d.wallet.address)} · signs with WALLET_PRIVATE_KEY` : d.wallet.connected ? short(d.wallet.address)
          : d.wallet.source === 'CONFIGURED' ? `${short(d.wallet.address)} · from .env (read-only)` : 'Connect Phantom')}
      {row('Actual USD value', money(c.walletUsd), c.solUsd ? `SOL ${money(c.solUsd)}` : undefined)}
      {row('Last wallet sync', ago(c.lastWalletSync))}
    </section>
    <section><h3>Trading config</h3>
      {row('Planned starting capital', money(c.plannedStartingCapitalUsd))}
      {row('Base entry', money(c.baseEntryUsd))}
      {row('Native SOL reserve', `${numeric(c.reserveSol, 3)} SOL`)}
      {row('Max drag', `${numeric(c.maxDragPct, 1)}%`, `slippage tolerance ${c.slippageBps} bps counts toward it`)}
    </section>
    <section><h3>{test ? 'TEST capital & PnL' : 'LIVE capital & PnL'}</h3>
      {test && row('TEST cash', money(c.paperCashUsd), 'all strategy sleeves; separate from wallet')}
      {!test && row('Available SOL', c.availableSol === null ? '--' : `${numeric(c.availableSol, 6)} SOL`)}
      {row('Reserved SOL', `${numeric(c.reservedSol, 6)} SOL`, 'native reserve + token-account rent')}
      {row('Spendable capital', money(c.spendableUsd))}
      {row('Open positions', `${c.openPositions} · ${money(c.positionsValueUsd)}`)}
      {row('Unrealized PnL', fine(c.unrealizedPnlUsd))}
      {row('Realized PnL', fine(c.realizedPnlUsd))}
      {row('Total fees', fine(c.totalFeesUsd))}
      {row('Equity', money(c.equityUsd))}
    </section>
  </div>;
}

const signed = (v: number | null | undefined, d = 1) => v === null || v === undefined ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;

function Strategies({ d, t }: { d: DeskStatus; t: TradingSession }) {
  const busy = !!t.busy || !t.online, test = d.mode === 'PAPER';
  return <div className="strategies" aria-label="Strategies">{d.strategies.map((s: StrategyView) => {
    const x = s.stats, row = (label: string, value: string) => <div><span>{label}</span><strong>{value}</strong></div>;
    return <section key={s.id} className={`strategy ${s.enabled ? 'on' : 'off'}`}>
      <div className="card-head"><h3>{s.label}</h3>
        <button className={s.enabled ? 'source-button' : 'primary-action'} disabled={busy}
          onClick={() => void t.desk('strategy', { strategy: s.id, enabled: !s.enabled })}>{s.enabled ? 'ON · turn off' : 'OFF · turn on'}</button></div>
      <p className="desk-note">{s.summary}{!test && s.id === 'CRASH' ? ' · LIVE: starts OFF every session; fast trades need Phantom Auto-Confirm.' : ''}</p>
      {s.halted && <p className="trading-error">HALTED: {describe(s.halted)}</p>}
      <div className="strategy-kpis">
        {row('Entry', `${money(s.entryUsd)} · drag ≤ ${numeric(s.maxDragPct, 1)}%`)}
        {row(test ? 'TEST sleeve' : 'Budget', test ? `${money(s.cashUsd)} of ${money(s.capitalUsd)}` : 'Phantom wallet (shared)')}
        {row('Positions', `${s.openPositions} / ${s.maxOpenPositions} · checked every ${s.positionCheckSec}s`)}
        {row(s.cycles ? `Unrealized · realized (${s.cycles + 1} cycles)` : 'Unrealized · realized', `${fine(s.unrealizedPnlUsd)} · ${fine(s.realizedPnlUsd)}`)}
        {row('Trades · win rate', `${x.trades} · ${x.winRatePct === null ? '--' : `${x.winRatePct.toFixed(0)}%`}`)}
        {row('Avg return · hold', `${signed(x.avgReturnPct)} · ${x.avgHoldSec === null ? '--' : `${Math.round(x.avgHoldSec)}s`}`)}
        {row('Best · worst', `${signed(x.bestReturnPct)} · ${signed(x.worstReturnPct)}`)}
        {row('Profit factor · max DD', `${x.trades && !x.losses ? '∞' : x.profitFactor?.toFixed(2) ?? '--'} · ${fine(x.maxDrawdownUsd, 2)}`)}
      </div>
      {(x.drillTrades > 0 || x.failedOrders > 0) && <p className="desk-note">{x.drillTrades} drill trade(s) excluded from stats · {x.failedOrders} failed order(s)</p>}
      <details><summary>Exit rules</summary><ul>{s.exitRules.map(r => <li key={r}>{r}</li>)}</ul></details>
      <details><summary>Scale-up ladder $10 → $100 → $1K → $10K: {s.scale.nextEntryUsd === null ? 'top' : s.scale.ready ? `READY to test ${money(s.scale.nextEntryUsd)} entries` : `stay at ${money(s.scale.currentEntryUsd)}`}</summary>
        <table className="gates"><tbody>{s.scale.checks.map(c => <tr key={c.label}><td>{c.label}</td><td className={c.ok ? 'gate-pass' : 'gate-unknown'}>{c.ok ? 'PASS' : 'NOT YET'}</td>
          <td>{c.actual}</td><td>{c.required}</td></tr>)}</tbody></table>
        <p className="desk-note">{s.scale.note} Advisory only: sizes change only when you edit .env.</p></details>
    </section>;
  })}</div>;
}

function Stages({ events }: { events: DeskEvent[] }) {
  const latest = useMemo(() => PIPELINE.map(p => events.find(e => p.stages.includes(e.stage)) ?? null), [events]);
  const newest = Math.max(0, ...latest.map(e => e?.at ?? 0));
  return <ol className="stages" aria-label="Execution pipeline">
    {PIPELINE.map((p, i) => <li key={p.label} className={latest[i] ? (latest[i]!.at === newest ? 'active' : 'seen') : ''}>
      <span>{p.label}</span><small>{latest[i] ? ago(latest[i]!.at) : '—'}</small></li>)}
  </ol>;
}

function Telemetry({ events }: { events: DeskEvent[] }) {
  const [filter, setFilter] = useState<'ALL' | 'EXEC' | 'REJECTED'>('ALL');
  const shown = events.filter(e => filter === 'ALL' || (filter === 'REJECTED' ? ['FILTERED', 'WAITING', 'FAILED'].includes(e.stage)
    : !['FILTERED', 'WATCHLIST', 'WAITING', 'SCANNING'].includes(e.stage))).slice(0, 150);
  return <section className="panel desk-card" aria-label="Live scanner telemetry">
    <div className="card-head"><h3>Live scanner telemetry</h3>
      <div className="filters">{(['ALL', 'EXEC', 'REJECTED'] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
        {f === 'ALL' ? 'All' : f === 'EXEC' ? 'Execution' : 'Rejections'}</button>)}</div></div>
    <ul className="events">{shown.map(e => <li key={e.id}>
      <time>{ago(e.at)}</time><span className={`tag tag-${e.stage.toLowerCase()}`}>[{e.stage.replace('_', ' ')}]</span>
      <span className="event-token" title={e.mint ?? undefined}>{e.symbol ?? (e.mint ? short(e.mint) : '')}</span><span>{e.message}</span></li>)}
      {!shown.length && <li>{events.length ? 'No events of this kind in the current window.' : 'No events yet. Start TEST or a LIVE session.'}</li>}</ul>
  </section>;
}

function PreflightCard({ p, live }: { p: Preflight | null; live: boolean }) {
  if (!p) return <section className="panel desk-card"><h3>Pre-flight</h3><p className="trading-intro">No order has reached pre-flight yet. The latest quote, route, simulation and signature state appear here.</p></section>;
  const rows: Array<[string, string]> = [
    ['Token / CA', `${p.symbol ?? ''} ${p.mint}`], ['DEX / route', `${p.router} · ${p.route}`], ['Entry size', p.side === 'BUY' ? `${p.amountIn} (${money(p.entrySizeUsd)})` : p.amountIn],
    ['Expected output', p.expectedOut], ['Minimum output', p.minimumOut], ['Price impact', `${p.priceImpactPct.toFixed(4)}%`], ['Slippage', `${p.slippageBps} bps`],
    ['Priority fee cap', sol(p.priorityFeeLamports)], ['Network fee (incl. priority)', sol(p.networkFeeLamports)], ['Account rent (refundable)', sol(p.accountRentLamports)],
    ['Total drag', p.dragPct === null ? '--' : `${p.dragPct.toFixed(2)}%`], ['Simulation', `${p.simulation.status} — ${p.simulation.detail}`],
    ['Balance check', `${p.balanceCheck.ok ? 'PASSED' : 'FAILED'} — ${p.balanceCheck.detail}`], ['Risk status', p.riskStatus],
    ['Signature', p.signature === 'NOT_REQUESTED_TEST' ? 'NOT REQUESTED (TEST)' : p.signature.replaceAll('_', ' ')],
    ['Tx signature', p.txSignature ?? '--'], ['Outcome', p.outcome.replaceAll('_', ' ')],
  ];
  return <section className="panel desk-card" aria-label="Pre-flight">
    <div className="card-head"><h3>Pre-flight · {p.side} · {ago(p.at)}</h3><span className={`chip ${live ? 'live' : 'on'}`}>{p.mode === 'LIVE' ? 'LIVE' : 'TEST'}</span></div>
    <dl className="kv">{rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{k === 'Tx signature' && p.txSignature
      ? <a href={`https://solscan.io/tx/${encodeURIComponent(p.txSignature)}`} target="_blank" rel="noreferrer">{short(p.txSignature)} ↗</a> : val}</dd></div>)}</dl>
    <details><summary>Route pools (AMM keys)</summary><ul className="mono">{p.ammKeys.map(k => <li key={k}>{k}</li>)}</ul></details>
  </section>;
}

function Candidates({ list, probe, busy }: { list: Candidate[]; probe: ((mint: string) => void) | null; busy: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return <section className="panel desk-card" aria-label="Candidates">
    <div className="card-head"><h3>Candidates · what is scanned and why it passed or failed</h3><small>{list.length} shown</small></div>
    <div className="wallet-table"><table className="cand"><thead><tr>
      <th>Token / CA</th><th>Tier</th><th>FAIR status</th><th>CRASH</th><th>Market cap</th><th>Pool age</th><th>Liquidity</th><th>5m vol</th><th>Buy/sell</th><th>Accel.</th>
      <th title="Owners with a balance · share of the 10 largest wallets (pools and curves excluded)">Holders</th><th>Dev</th><th>Website</th><th>X</th><th>X activity</th><th>Narrative</th><th>Mint / freeze</th><th>Risk flags</th></tr></thead>
      <tbody>{list.map(c => <Fragment key={c.mint}>
        <tr className={`status-${c.status.toLowerCase()}${c.stale ? ' stale' : ''}`} onClick={() => setOpen(open === c.mint ? null : c.mint)} aria-expanded={open === c.mint}>
          <td title={c.mint}><strong>{c.symbol ?? '?'}</strong><br /><small>{short(c.mint)}</small></td>
          <td>{c.tier === 'ULTRA_EARLY' ? 'Ultra-early' : 'Trending'}</td>
          <td>{c.stale ? <span className="badge-stale" title="Not re-assessed in the last scan; never traded on">STALE · {ago(c.updatedAt)}</span>
            : <span className={`badge-${c.status.toLowerCase()}`}>{c.status}</span>}<br /><small>{c.entryNotes?.FAIR ?? c.classification.replace('_', ' ')}</small></td>
          <td title={c.crash?.summary}>{c.stale ? <span className="badge-stale">STALE</span> : c.crash?.signal ? <span className="badge-qualified">SIGNAL</span> : <span className="badge-filtered">no</span>}<br />
            <small>{c.entryNotes?.CRASH ?? (c.crash ? (c.crash.signal ? 'entry-ready' : c.crash.summary.split(':')[0]) : '--')}</small></td>
          <td>{usdOrUnknown(c.metrics.marketCapUsd)}</td><td>{c.metrics.poolAgeMin === null ? 'UNKNOWN' : `${numeric(c.metrics.poolAgeMin, 0)}m`}</td>
          <td>{usdOrUnknown(c.metrics.liquidityUsd)}</td><td>{usdOrUnknown(c.metrics.volume5mUsd)}</td>
          <td>{c.metrics.buySellRatio5m === null ? 'UNKNOWN' : c.metrics.buySellRatio5m.toFixed(2)}</td>
          <td>{c.metrics.volumeAcceleration === null ? 'UNKNOWN' : `${c.metrics.volumeAcceleration.toFixed(2)}×`}</td>
          <td>{holderCount(c.holders)}<br /><small>top-10 {pct(c.metrics.top10WalletPct)}</small></td><td>{pct(c.metrics.developerPct, 2)}</td><td>{c.social.websiteStatus}</td>
          <td>{c.social.x.kind === 'NONE' ? 'none' : `${c.social.x.kind}${c.social.x.handle ? ` @${c.social.x.handle}` : ''}`}<br /><small className={`auth-${c.social.authenticity.toLowerCase()}`}>{c.social.authenticity}</small></td>
          <td>{c.social.xPosts7d === null ? 'UNKNOWN' : `${c.social.xPosts7d} posts/7d`}</td><td>{c.social.narrativeVelocity}</td>
          <td>{c.onchain.mintAuthority === null ? 'UNKNOWN' : `${c.onchain.mintAuthority ? 'ACTIVE' : 'revoked'} / ${c.onchain.freezeAuthority ? 'ACTIVE' : 'revoked'}`}</td>
          <td>{c.riskFlags.length ? c.riskFlags.slice(0, 2).join('; ') : '—'}</td>
        </tr>
        {open === c.mint && <tr className="detail-row"><td colSpan={18}><CandidateDetail c={c} probe={probe} busy={busy} /></td></tr>}
      </Fragment>)}
      {!list.length && <tr><td colSpan={18}>No candidates yet. The first scan starts with TEST or a LIVE session.</td></tr>}</tbody></table></div>
  </section>;
}

const holderCount = (h: Candidate['holders']) => !h ? 'UNKNOWN' : h.count === null ? '?' : `${h.count.toLocaleString('en-US')}${h.countCapped ? '+' : ''}`;

/** The largest holders, so wallets can be checked without opening each one elsewhere. */
function Holders({ c }: { c: Candidate }) {
  const h = c.holders, kind = { WALLET: 'wallet', PROGRAM: 'pool / curve / program', DEV: 'DEV (creator)' } as const;
  return <div className="holders">
    <h4>Holders · {holderCount(h)} {h?.countNote ? <small>({h.countNote})</small> : null}</h4>
    <p className="desk-note">
      <a href={`https://fomo.family/tokens/solana/${encodeURIComponent(c.mint)}`} target="_blank" rel="noreferrer">FOMO ↗</a> ·{' '}
      <a href={`https://solscan.io/token/${encodeURIComponent(c.mint)}#holders`} target="_blank" rel="noreferrer">Solscan holders ↗</a>
      {h && <> · top-10 wallets {h.top10WalletPct.toFixed(1)}% · largest wallet {h.largestWalletPct.toFixed(1)}% · pools/curves {h.programOwnedPct.toFixed(1)}% · read {ago(h.at)}</>}
    </p>
    {h ? <table className="gates"><thead><tr><th>#</th><th>Owner</th><th>Share of supply</th><th>Type</th></tr></thead><tbody>
      {h.top.map((x, i) => <tr key={x.owner} className={x.kind === 'DEV' ? 'holder-dev' : undefined}><td>{i + 1}</td>
        <td className="mono"><a href={`https://solscan.io/account/${encodeURIComponent(x.owner)}`} target="_blank" rel="noreferrer" title={x.owner}>{short(x.owner)} ↗</a></td>
        <td>{x.pct.toFixed(2)}%</td><td>{kind[x.kind]}</td></tr>)}
      {!h.top.length && <tr><td colSpan={4}>No holder accounts returned.</td></tr>}</tbody></table>
      : <p className="desk-note">Not read yet: the largest holders of the most active candidates are refreshed every few minutes.</p>}
  </div>;
}

function CandidateDetail({ c, probe, busy }: { c: Candidate; probe: ((mint: string) => void) | null; busy: boolean }) {
  const groups: Array<[Evidence['kind'], string]> = [['OBSERVED', 'Observed'], ['DERIVED', 'Derived'], ['INFERRED', 'Inferred']];
  return <div className="cand-detail">
    {probe && <div className="probe-row"><button className="source-button" disabled={busy || c.onchain.decimals === null} onClick={() => probe(c.mint)}>Run TEST pre-flight probe</button>
      <small>Real quote, route, transaction build and RPC simulation for your wallet address. Nothing is booked and no signature is requested.</small></div>}
    <p><strong>{c.name ?? c.symbol}</strong> · <span className="mono">{c.mint}</span> · <a href={c.pair.url} target="_blank" rel="noreferrer">{c.pair.dex} pool ↗</a> · sources: {c.sources.join(', ')}</p>
    <p className="reasons">{c.reasons.join(' · ')}</p>
    <Holders c={c} />
    {c.social.authenticityFlags.some(f => f.includes('MISMATCH')) && <p className="warn">⚠ SOCIAL AGE MISMATCH — {c.social.authenticityFlags.find(f => f.includes('MISMATCH'))}</p>}
    <div className="detail-grid">
      <div><h4>Hard gates (FAIR)</h4><table className="gates"><tbody>{c.gates.map(g => <tr key={g.key}><td>{g.label}</td>
        <td className={`gate-${g.status.toLowerCase()}`}>{g.status}{!g.blocking && g.status !== 'PASS' ? ' (flag)' : ''}</td><td>{g.actual}</td><td>{g.required}</td></tr>)}</tbody></table>
        {c.crash && <><h4>CRASH entry checks · {c.crash.signal ? 'SIGNAL' : 'no signal'}</h4><table className="gates"><tbody>{c.crash.checks.map(g => <tr key={g.key}><td>{g.label}</td>
          <td className={`gate-${g.status.toLowerCase()}`}>{g.status}{!g.blocking && g.status !== 'PASS' ? ' (flag)' : ''}</td><td>{g.actual}</td><td>{g.required}</td></tr>)}</tbody></table></>}
        <p className="desk-note">Analytical scores, not guarantees of future performance. Fundamentals never override a failed gate.</p></div>
      <div><h4>Component scores</h4>{c.scores.map(s => <details key={s.key}><summary><span>{s.key}</span><strong>{s.score}</strong></summary>
        <ul>{s.factors.map(f => <li key={f.label}>{f.label}: {f.points}/{f.max} <small>({f.basis})</small></li>)}</ul></details>)}</div>
      <div><h4>Evidence</h4>{groups.map(([kind, label]) => <details key={kind} open={kind === 'OBSERVED'}><summary>{label}</summary>
        <dl className="kv">{c.evidence.filter(e => e.kind === kind).map(e => <div key={e.key}><dt>{e.label}</dt>
          <dd className={e.value === null ? 'unknown' : ''} title={[e.source, e.note].filter(Boolean).join(' — ')}>{e.display}<small>{e.source}{e.note ? ` · ${e.note}` : ''}</small></dd></div>)}</dl></details>)}
        <h4>X authenticity: {c.social.authenticity}</h4><ul>{c.social.authenticityFlags.map(f => <li key={f}>{f}</li>)}</ul></div>
    </div>
  </div>;
}

function Positions({ d, busy, exit }: { d: DeskStatus; busy: boolean; exit: (p: DeskStatus['positions'][number]) => void }) {
  const solUsd = d.capital.solUsd;
  return <section className="panel desk-card" aria-label="Open positions">
    <div className="card-head"><h3>Open positions · {d.mode === 'PAPER' ? 'TEST' : 'LIVE'}</h3>
      <small>Exits run by rule every few seconds while the desk runs. EXIT NOW sells a position immediately through the same guarded path.</small></div>
    <div className="wallet-table"><table><thead><tr><th>Strategy</th><th>Token</th><th>Quantity (raw)</th><th>Entry price</th><th>Current price</th><th>Cost</th><th>Value</th><th>Unrealized</th><th>Route</th><th>Opened</th><th></th></tr></thead>
      <tbody>{d.positions.map(p => {
        const value = p.lastValueLamports && solUsd ? Number(p.lastValueLamports) / 1e9 * solUsd : null;
        return <tr key={p.id}><td>{p.strategy ?? 'FAIR'}</td><td title={p.mint}>{p.symbol ?? short(p.mint)}</td><td>{p.qtyRaw}</td><td>{p.entryPriceUsd?.toPrecision(6) ?? '--'}</td>
          <td>{p.lastPriceUsd?.toPrecision(6) ?? '--'}</td><td>{fine(p.costUsd)}</td><td>{fine(value)}</td><td>{fine(value === null ? null : value - p.costUsd)}</td>
          <td>{p.route}</td><td>{ago(p.openedAt)}</td>
          <td><button className="stop-action" disabled={busy || !!p.exitRequested} onClick={() => exit(p)}>{p.exitRequested ? 'SELLING…' : 'EXIT NOW'}</button></td></tr>;
      })}{!d.positions.length && <tr><td colSpan={11}>No open positions.</td></tr>}</tbody></table></div>
  </section>;
}

function Ledger({ d }: { d: DeskStatus }) {
  return <section className="panel desk-card" aria-label="Ledger">
    <div className="card-head"><h3>{d.mode === 'PAPER' ? 'TEST ledgers' : 'LIVE ledgers'} · persistent · one per strategy</h3><small>Router fees are already inside the quoted output; net PnL does not subtract them twice.</small></div>
    <div className="wallet-table"><table><thead><tr><th>Time</th><th>Strategy</th><th>Tx signature</th><th>Token / CA</th><th>DEX / route</th><th>Side</th><th>Quantity</th><th>Entry</th><th>Exit</th>
      <th>Gross PnL</th><th>Network fee</th><th>Router fee</th><th>Total fees</th><th>Net PnL</th><th>Status</th></tr></thead>
      <tbody>{d.ledger.map(e => <tr key={`${e.strategy}-${e.id}`}><td>{ago(e.at)}</td><td>{e.strategy ?? 'FAIR'}</td>
        <td>{e.txSignature ? <a href={`https://solscan.io/tx/${encodeURIComponent(e.txSignature)}`} target="_blank" rel="noreferrer">{short(e.txSignature)}</a> : 'TEST — none'}</td>
        <td title={e.mint}>{e.symbol ?? ''} <small>{short(e.mint)}</small></td><td>{e.router} · {e.route}</td><td>{e.side}</td><td>{e.quantity}</td>
        <td>{e.entryPriceUsd?.toPrecision(6) ?? '--'}</td><td>{e.exitPriceUsd?.toPrecision(6) ?? '--'}</td><td>{fine(e.grossPnlUsd)}</td>
        <td>{fine(e.networkFeeUsd)}</td><td>{fine(e.routerFeeUsd)}</td><td>{fine(e.totalFeesUsd)}</td><td>{fine(e.netPnlUsd)}</td>
        <td title={e.note ?? undefined}>{e.status.replace('_', ' ')}</td></tr>)}
        {!d.ledger.length && <tr><td colSpan={15}>No executions recorded. Nothing is ever back-filled.</td></tr>}</tbody></table></div>
  </section>;
}

function PathAudit({ d }: { d: DeskStatus }) {
  return <section className="panel desk-card" aria-label="Execution path">
    <div className="card-head"><h3>Actual execution path</h3><small>Phantom is the wallet and signer, not the DEX.</small></div>
    <dl className="kv two">{d.path.map(p => <div key={p.layer}><dt>{p.layer}</dt><dd>{p.provider}</dd></div>)}</dl>
    <h4>Data sources (last scan)</h4>
    <dl className="kv two">{Object.entries(d.sources).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={v.startsWith('UNAVAILABLE') ? 'unknown' : ''}>{v}</dd></div>)}</dl>
  </section>;
}

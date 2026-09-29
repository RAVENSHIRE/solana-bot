import { Fragment, useMemo, useState } from 'react';
import type { Candidate, DeskEvent, DeskStatus, Evidence, Preflight, Stage } from '../../src/desk/types';
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
};
const describe = (code: string | null) => code ? EXPLAIN[code] ?? code.replaceAll('_', ' ') : null;
const fine = (v: number | null | undefined, d = 4) => v === null || v === undefined || !Number.isFinite(v) ? '--' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
const sol = (lamports: string | null | undefined) => lamports == null ? '--' : `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
const ago = (at: number | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
const pct = (v: number | null | undefined, d = 1) => v === null || v === undefined ? 'UNKNOWN' : `${v.toFixed(d)}%`;
const usdOrUnknown = (v: number | null | undefined) => v === null || v === undefined ? 'UNKNOWN' : money(v);

export function DeskPanel({ t }: { t: TradingSession }) {
  const v = t.view, d = v?.desk ?? null, live = v?.mode === 'LIVE';
  return <section className={`desk ${live ? 'desk-live' : 'desk-test'}`} aria-label="Trading desk">
    <div className={`env-banner ${live ? 'live' : 'test'}`} role="status">
      <strong>{live ? 'LIVE — REAL FUNDS' : 'TEST / PAPER — NO REAL TRANSACTIONS'}</strong>
      <span>{live ? 'Every order requires your Phantom signature.' : 'Same scanner, strategy, risk, quote, route and simulation as LIVE. No signature is ever requested.'}</span>
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
      <Stages events={d.events} />
      <div className="desk-grid">
        <Telemetry events={d.events} />
        <PreflightCard p={d.preflights[0] ?? null} live={live} />
      </div>
      <Candidates list={d.candidates} probe={live ? null : mint => void t.desk('probe', { mint })} busy={!!t.busy} />
      <Positions d={d} />
      <Ledger d={d} />
      <PathAudit d={d} />
    </>}
    {!d && !v?.deskError && <p className="trading-intro">Starting the local desk…</p>}
  </section>;
}

function Controls({ t, d }: { t: TradingSession; d: DeskStatus | null }) {
  const v = t.view, live = v?.mode === 'LIVE', running = !!d?.scanner, busy = !!t.busy || !t.online;
  const chip = (on: boolean, yes: string, no: string) => <span className={`chip ${on ? 'on' : 'off'}`}>{on ? yes : no}</span>;
  return <div className="desk-controls">
    <div className="mode-switch" role="radiogroup" aria-label="Environment">
      {(['PAPER', 'LIVE'] as const).map(m => <button key={m} role="radio" aria-checked={v?.mode === m} disabled={busy || running}
        onClick={() => void t.desk('select-mode', { mode: m })}>{m === 'PAPER' ? '● TEST / PAPER' : '● LIVE'}</button>)}
    </div>
    <div className="chips">
      {chip(running, 'SCANNER: ON', 'SCANNER: OFF')}
      {chip(!!d?.execution, 'EXECUTION: ENABLED', 'EXECUTION: DISABLED')}
      {t.connected ? chip(true, `WALLET: PHANTOM ${short(t.address)}`, '') : d?.wallet.source === 'CONFIGURED'
        ? <span className="chip on">WALLET: .env ADDRESS {short(d.wallet.address)} (TEST, no signing)</span> : chip(false, '', 'WALLET: DISCONNECTED')}
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
      </> : <>
        <button className="primary-action live" disabled={busy || running || !t.connected} onClick={() => void t.desk('start-live')}>START LIVE SESSION</button>
        <button className="stop-action" disabled={busy || !running} onClick={() => void t.desk('stop-live')}>STOP LIVE SESSION</button>
      </>}
      <button className="source-button" disabled={busy || !running || !d?.execution} onClick={() => void t.desk('pause')}>PAUSE EXECUTION</button>
      <button className="source-button" disabled={busy || !running || !!d?.execution} onClick={() => void t.desk('resume')}>RESUME EXECUTION</button>
      {live && t.connected && !t.auto && <button className="source-button" disabled={busy} onClick={() => void t.enableAuto()}>Enable Auto-Confirm</button>}
      {live && t.auto && <span className="chip on">Auto-Confirm granted in Phantom</span>}
    </div>
    <p className="desk-note">{d?.message ? `Last result: ${describe(d.message)} · ` : ''}Last scan {ago(d?.lastScanAt)}{d?.nextScanAt ? ` · next ${ago(d.nextScanAt)}` : ''}. Stopping keeps all telemetry and ledger data.</p>
  </div>;
}

function Capital({ d }: { d: DeskStatus }) {
  const c = d.capital, test = d.mode === 'PAPER';
  const row = (label: string, value: string, note?: string) => <div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
  return <div className="capital">
    <section><h3>Phantom wallet <em>actual</em></h3>
      {row('Actual SOL', c.walletSol === null ? '--' : `${numeric(c.walletSol, 6)} SOL`, d.wallet.connected ? short(d.wallet.address) : d.wallet.source === 'CONFIGURED' ? `${short(d.wallet.address)} · from .env (read-only)` : 'Connect Phantom')}
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
      {test && row('TEST cash', money(c.paperCashUsd), 'starts at planned capital; separate from wallet')}
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
      {!shown.length && <li>No events yet. Start TEST or a LIVE session.</li>}</ul>
  </section>;
}

function PreflightCard({ p, live }: { p: Preflight | null; live: boolean }) {
  if (!p) return <section className="panel desk-card"><h3>Pre-flight</h3><p className="trading-intro">No order has reached pre-flight yet. The latest quote, route, simulation and signature state appear here.</p></section>;
  const rows: Array<[string, string]> = [
    ['Token / CA', `${p.symbol ?? ''} ${p.mint}`], ['DEX / route', `${p.router} · ${p.route}`], ['Entry size', p.side === 'BUY' ? `${p.amountIn} (${money(p.entrySizeUsd)})` : p.amountIn],
    ['Expected output', p.expectedOut], ['Minimum output', p.minimumOut], ['Price impact', `${p.priceImpactPct.toFixed(4)}%`], ['Slippage', `${p.slippageBps} bps`],
    ['Priority fee', sol(p.priorityFeeLamports)], ['Network fee', sol(p.networkFeeLamports)], ['Account rent (refundable)', sol(p.accountRentLamports)],
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
      <th>Token / CA</th><th>Tier</th><th>Status</th><th>Market cap</th><th>Pool age</th><th>Liquidity</th><th>5m vol</th><th>Buy/sell</th><th>Accel.</th>
      <th>Top-10</th><th>Dev</th><th>Website</th><th>X</th><th>X activity</th><th>Narrative</th><th>Mint / freeze</th><th>Risk flags</th></tr></thead>
      <tbody>{list.map(c => <Fragment key={c.mint}>
        <tr className={`status-${c.status.toLowerCase()}`} onClick={() => setOpen(open === c.mint ? null : c.mint)} aria-expanded={open === c.mint}>
          <td title={c.mint}><strong>{c.symbol ?? '?'}</strong><br /><small>{short(c.mint)}</small></td>
          <td>{c.tier === 'ULTRA_EARLY' ? 'Ultra-early' : 'Trending'}</td>
          <td><span className={`badge-${c.status.toLowerCase()}`}>{c.status}</span><br /><small>{c.classification.replace('_', ' ')}</small></td>
          <td>{usdOrUnknown(c.metrics.marketCapUsd)}</td><td>{c.metrics.poolAgeMin === null ? 'UNKNOWN' : `${numeric(c.metrics.poolAgeMin, 0)}m`}</td>
          <td>{usdOrUnknown(c.metrics.liquidityUsd)}</td><td>{usdOrUnknown(c.metrics.volume5mUsd)}</td>
          <td>{c.metrics.buySellRatio5m === null ? 'UNKNOWN' : c.metrics.buySellRatio5m.toFixed(2)}</td>
          <td>{c.metrics.volumeAcceleration === null ? 'UNKNOWN' : `${c.metrics.volumeAcceleration.toFixed(2)}×`}</td>
          <td>{pct(c.metrics.top10WalletPct)}</td><td>{pct(c.metrics.developerPct, 2)}</td><td>{c.social.websiteStatus}</td>
          <td>{c.social.x.kind === 'NONE' ? 'none' : `${c.social.x.kind}${c.social.x.handle ? ` @${c.social.x.handle}` : ''}`}<br /><small className={`auth-${c.social.authenticity.toLowerCase()}`}>{c.social.authenticity}</small></td>
          <td>{c.social.xPosts7d === null ? 'UNKNOWN' : `${c.social.xPosts7d} posts/7d`}</td><td>{c.social.narrativeVelocity}</td>
          <td>{c.onchain.mintAuthority === null ? 'UNKNOWN' : `${c.onchain.mintAuthority ? 'ACTIVE' : 'revoked'} / ${c.onchain.freezeAuthority ? 'ACTIVE' : 'revoked'}`}</td>
          <td>{c.riskFlags.length ? c.riskFlags.slice(0, 2).join('; ') : '—'}</td>
        </tr>
        {open === c.mint && <tr className="detail-row"><td colSpan={17}><CandidateDetail c={c} probe={probe} busy={busy} /></td></tr>}
      </Fragment>)}
      {!list.length && <tr><td colSpan={17}>No candidates yet. The first scan starts with TEST or a LIVE session.</td></tr>}</tbody></table></div>
  </section>;
}

function CandidateDetail({ c, probe, busy }: { c: Candidate; probe: ((mint: string) => void) | null; busy: boolean }) {
  const groups: Array<[Evidence['kind'], string]> = [['OBSERVED', 'Observed'], ['DERIVED', 'Derived'], ['INFERRED', 'Inferred']];
  return <div className="cand-detail">
    {probe && <div className="probe-row"><button className="source-button" disabled={busy || c.onchain.decimals === null} onClick={() => probe(c.mint)}>Run TEST pre-flight probe</button>
      <small>Real quote, route, transaction build and RPC simulation for your wallet address. Nothing is booked and no signature is requested.</small></div>}
    <p><strong>{c.name ?? c.symbol}</strong> · <span className="mono">{c.mint}</span> · <a href={c.pair.url} target="_blank" rel="noreferrer">{c.pair.dex} pool ↗</a> · sources: {c.sources.join(', ')}</p>
    <p className="reasons">{c.reasons.join(' · ')}</p>
    {c.social.authenticityFlags.some(f => f.includes('MISMATCH')) && <p className="warn">⚠ SOCIAL AGE MISMATCH — {c.social.authenticityFlags.find(f => f.includes('MISMATCH'))}</p>}
    <div className="detail-grid">
      <div><h4>Hard gates</h4><table className="gates"><tbody>{c.gates.map(g => <tr key={g.key}><td>{g.label}</td>
        <td className={`gate-${g.status.toLowerCase()}`}>{g.status}{!g.blocking && g.status !== 'PASS' ? ' (flag)' : ''}</td><td>{g.actual}</td><td>{g.required}</td></tr>)}</tbody></table>
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

function Positions({ d }: { d: DeskStatus }) {
  const solUsd = d.capital.solUsd;
  return <section className="panel desk-card" aria-label="Open positions">
    <div className="card-head"><h3>Open positions · {d.mode === 'PAPER' ? 'TEST' : 'LIVE'}</h3></div>
    <div className="wallet-table"><table><thead><tr><th>Token</th><th>Quantity (raw)</th><th>Entry price</th><th>Current price</th><th>Cost</th><th>Value</th><th>Unrealized</th><th>Route</th><th>Opened</th></tr></thead>
      <tbody>{d.positions.map(p => {
        const value = p.lastValueLamports && solUsd ? Number(p.lastValueLamports) / 1e9 * solUsd : null;
        return <tr key={p.id}><td title={p.mint}>{p.symbol ?? short(p.mint)}</td><td>{p.qtyRaw}</td><td>{p.entryPriceUsd?.toPrecision(6) ?? '--'}</td>
          <td>{p.lastPriceUsd?.toPrecision(6) ?? '--'}</td><td>{fine(p.costUsd)}</td><td>{fine(value)}</td><td>{fine(value === null ? null : value - p.costUsd)}</td>
          <td>{p.route}</td><td>{ago(p.openedAt)}</td></tr>;
      })}{!d.positions.length && <tr><td colSpan={9}>No open positions.</td></tr>}</tbody></table></div>
  </section>;
}

function Ledger({ d }: { d: DeskStatus }) {
  return <section className="panel desk-card" aria-label="Ledger">
    <div className="card-head"><h3>{d.mode === 'PAPER' ? 'TEST ledger' : 'LIVE ledger'} · persistent</h3><small>Router fees are already inside the quoted output; net PnL does not subtract them twice.</small></div>
    <div className="wallet-table"><table><thead><tr><th>Time</th><th>Tx signature</th><th>Token / CA</th><th>DEX / route</th><th>Side</th><th>Quantity</th><th>Entry</th><th>Exit</th>
      <th>Gross PnL</th><th>Network fee</th><th>Router fee</th><th>Total fees</th><th>Net PnL</th><th>Status</th></tr></thead>
      <tbody>{d.ledger.map(e => <tr key={e.id}><td>{ago(e.at)}</td>
        <td>{e.txSignature ? <a href={`https://solscan.io/tx/${encodeURIComponent(e.txSignature)}`} target="_blank" rel="noreferrer">{short(e.txSignature)}</a> : 'TEST — none'}</td>
        <td title={e.mint}>{e.symbol ?? ''} <small>{short(e.mint)}</small></td><td>{e.router} · {e.route}</td><td>{e.side}</td><td>{e.quantity}</td>
        <td>{e.entryPriceUsd?.toPrecision(6) ?? '--'}</td><td>{e.exitPriceUsd?.toPrecision(6) ?? '--'}</td><td>{fine(e.grossPnlUsd)}</td>
        <td>{fine(e.networkFeeUsd)}</td><td>{fine(e.routerFeeUsd)}</td><td>{fine(e.totalFeesUsd)}</td><td>{fine(e.netPnlUsd)}</td>
        <td title={e.note ?? undefined}>{e.status.replace('_', ' ')}</td></tr>)}
        {!d.ledger.length && <tr><td colSpan={14}>No executions recorded. Nothing is ever back-filled.</td></tr>}</tbody></table></div>
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

import type { TradingSession } from './use-trading';
import { money, numeric, time } from './format';

const explanations:Record<string,string>={
  CONNECT_PHANTOM:'Connect the Phantom account you want to use.',
  WALLET_CHECK_PENDING:'Checking RPC balances and current SOL / USDC prices.',
  FUND_TO_PLANNED_BUDGET:'Fund the connected wallet to approximately the planned starting budget.',
  FUNDING_BELOW_KILL_THRESHOLD:'The wallet is below the minimum funding threshold.',
  SOL_RESERVE_FLOOR:'Keep the required native SOL reserve available for network fees.',
  INSUFFICIENT_NATIVE_FOR_TRADE_AND_RESERVE:'More native SOL is needed for the order, reserve and temporary account rent.',
  ATA_RENT_EXCEEDS_FEE_CAP:'Creating a USDC token account would exceed the fee limit. Funding alone does not clear this gate.',
  MINIMUM_FEES_EXCEED_CAP:'Even the minimum network costs exceed the transaction fee limit.',
  WALLET_EXCEEDS_MICRO_BUDGET:'The wallet exceeds this micro profile. Use a dedicated test account near the displayed budget.',
  NO_POSITIVE_NET_QUOTED_EDGE:'No positive round-trip quote after fees. The scanner waits; no order is submitted.',
  FEE_CAP:'Expected fees, slippage, spread and account rent exceed the limit.',
  UNEXPLAINED_BALANCE_CHANGE:'Balances changed outside the recorded trades. Review the ledger before resuming.',
  TRANSACTION_RECONCILIATION_REQUIRED:'A transaction needs reconciliation. Automatic retries are blocked.',
  WALLET_CHECKED_START_REQUIRED:'Wallet checks passed. Start the session to scan for eligible quotes.',
  ARMED_AWAITING_GATES:'Session armed. Orders still require every market, fee and signature gate.',
  SCAN_FAILED_CHECK_LOCAL_LOG:'A provider or transaction check failed. No readiness claim is available.',
  INSTANCE_LOCK:'Another process owns this wallet ledger. Stop it before connecting here.',
  LEGACY_INSTANCE_LOCK:'An older micro instance owns this ledger. Stop it and check the recorded transaction before clearing its lock.',
  STATE_INVALID:'The existing ledger could not be validated. It has not been reset.',
  RPC_NOT_CONFIGURED:'Set the existing Solana RPC endpoint in the local configuration.',
  JUPITER_API_KEY_REQUIRED:'The local Jupiter API key is missing. Add it to the local configuration, never to the browser.',
  SCAN_IN_PROGRESS:'A check is still running. Wait for it to finish before starting the session.',
  WALLET_SESSION_MISMATCH:'The wallet session expired or changed. Reconnect Phantom.',
};
const describe=(code:string)=>explanations[code]??code.replaceAll('_',' ');
const labels:Record<string,string>={WAITING_FOR_WALLET:'Connect your wallet',DISARMED:'Trading paused',WAITING_FOR_GATES:'Waiting for checks',SCANNING:'Scanning live quotes',SIGNATURE_REQUIRED:'Phantom approval needed',HALTED:'Execution halted'};
export function TradingPanel({session:t}:{session:TradingSession}) {
  const s=t.status,p=s?.profile,r=s?.report,l=s?.ledger;
  return <section className="trading-panel panel" aria-label="Phantom live trading controls">
    <div className="trading-heading"><div><span className="eyebrow">PHANTOM · SOL / USDC</span><h2>{!t.online?'Trading service unavailable':labels[s?.status??'']??'Checking local service'}</h2></div>
      <span className={`execution-pill ${s?.active&&t.online?'armed':''}`}>{t.online?(s?.active?'LIVE SESSION':'DISARMED'):'OFFLINE'}</span></div>
    <p className="trading-intro">Your wallet stays in Phantom. A session scans only while this browser is connected. Every swap is checked again before submission.</p>
    <div className="trading-limits">
      <div><span>Starting budget</span><strong>{money(p?.budgetUsd)}</strong></div>
      <div><span>Default entry</span><strong>{money(p?.tradeUsd)}</strong></div>
      <div><span>Native reserve</span><strong>{p?`${numeric(p.reserveSol,3)} SOL`:'--'}</strong></div>
      <div><span>Max. total drag</span><strong>{p?`${numeric(p.feeCapPct,1)}%`:'--'}</strong></div>
    </div>
    <div className="trading-actions">
      {!t.connected?<button className="primary-action" disabled={!!t.busy} onClick={()=>void t.connect()}>{t.busy==='connect'?'Connecting…':'Connect Phantom'}</button>:<>
        <button className="primary-action" disabled={!!t.busy||!t.online||s?.active||s?.status==='HALTED'} onClick={()=>void t.arm()}>Start live session</button>
        <button className="stop-action" onClick={()=>void t.stop()}>Stop execution</button>
        <button className="source-button" disabled={!!t.busy} onClick={()=>void t.disconnect()}>Disconnect</button>
      </>}
    </div>
    {t.connected&&<div className="approval-row"><span>{t.auto?'Auto-Confirm approved in Phantom':'Manual Phantom approval per transaction'}</span>
      {!t.auto&&<button className="source-button" disabled={!!t.busy||!t.online} onClick={()=>void t.enableAuto()}>Enable Auto-Confirm</button>}
      <small>Browser keeps the session alive. Inactivity expiry: {s?.session?time(new Date(s.session.expiresAt).toISOString()):'--'}. Closing this tab pauses execution.</small></div>}
    {s?.pending&&<div className="signature-request" role="status"><strong>Fresh swap ready for wallet review</strong><span>Expires {time(new Date(s.pending.expiresAt).toISOString())}. Expired quotes are never sent.</span>
      <button className="primary-action" disabled={!!t.busy||!t.online} onClick={()=>void t.approve()}>Review in Phantom</button></div>}
    {t.error&&<p className="trading-error" role="alert">{describe(t.error)}</p>}
    <div className="readiness-list" aria-live="polite">
      {(s?.blockers??[]).map(code=><p key={code}><span className="gate-dot"/>{describe(code)}</p>)}
      {s?.message&&!s.blockers.includes(s.message)&&<p><span className="gate-dot"/>{describe(s.message)}</p>}
      {r&&!s?.blockers.length&&<p>Wallet checks complete. A fresh quote, positive net round-trip quote, RPC simulation and Phantom signature are still required.</p>}
    </div>
    <details className="trading-details"><summary>Risk limits & account checks</summary><dl>
      <div><dt>SOL + canonical USDC balance</dt><dd>{money(r?.scopedEquityUsd)}</dd></div>
      <div><dt>Funding gap to plan</dt><dd>{money(r?.fundingShortfallUsd)}</dd></div>
      <div><dt>Equity halt threshold</dt><dd>{money(p?.killUsd)} · 30% below recorded start</dd></div>
      <div><dt>USDC account</dt><dd>{r?(r.ataExists?'Already exists':`Creation rent ${money(r.ataRentUsd)}`):'--'}</dd></div>
      <div><dt>Estimated fee budget / order</dt><dd>{money(r?.feeCapUsd)}</dd></div>
      <div><dt>Other token accounts</dt><dd>{r?`${r.unsupportedHoldings.length} excluded from trading`:'--'}</dd></div>
    </dl><p>The fee cap includes network costs, slippage, spread and new account rent. Market quotes do not establish a statistical edge. Stopping prevents new submissions; it does not liquidate holdings or cancel transactions already broadcast.</p></details>
    <div className="live-ledger"><h3>Live session results</h3><div className="trading-limits">
      <div><span>Tracked equity</span><strong>{money(l?.equityUsd)}</strong></div>
      <div><span>Realized net P&L</span><strong>{money(l?.realizedNetUsd)}</strong></div>
      <div><span>Closed trades</span><strong>{l?numeric(l.closedTrades):'--'}</strong></div>
      <div><span>Network fees paid</span><strong>{money(l?.feesUsd)}</strong></div>
    </div>{!l&&<p>No live ledger yet. It starts after funding, arming and wallet checks.</p>}
      {l?.openPosition&&<p>One tracked USDC position is open.</p>}
      {l?.pendingSignature&&<p>Awaiting settlement or reconciliation: <code>{l.pendingSignature}</code></p>}
      {!!l?.fills.length&&<details><summary>Recorded transactions</summary><ul>{l.fills.map((f,i)=><li key={f.signature??i}>{f.side} · {time(new Date(f.at).toISOString())} · net {money(f.pnlUsd)} {f.signature&&<a href={`https://solscan.io/tx/${encodeURIComponent(f.signature)}`} target="_blank" rel="noreferrer">Transaction ↗</a>}</li>)}</ul></details>}
      {l?.cloudReady&&<p>Performance threshold reached. VPS review available; no deployment or statistical edge is implied.</p>}
    </div>
  </section>;
}

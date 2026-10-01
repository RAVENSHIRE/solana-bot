import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, DeskEvent, DeskStatus, Evidence, Preflight, Stage, StrategyView } from '../../src/desk/types';
import type { RuleSpecInput } from '../../src/desk/custom';
import type { Holding, WatchRule, WatchView } from '../../src/desk/watch';
import type { AssistantAnswer, TradingSession } from './use-trading';
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
  STRATEGY_HAS_POSITIONS: 'This strategy still holds a position (TEST or LIVE). Sell or wait for its exit before deleting it.',
  BUILTIN_STRATEGY: 'FAIR, CRASH, LAUNCH and OPEN are built in: they can be switched off, not edited or deleted.',
  CONFIG_LOCKED: 'The desk runs with DESK_DEPLOYMENT_MODE=LOCKED: strategies are fixed at startup.',
  WATCH_SELL_NEEDS_LOCAL_KEY: 'Automatic selling works only for the local-key wallet (DESK_LIVE_SIGNER=local-key). Other wallets (FOMO, Phantom) get alerts: choose ALERT.',
  WATCH_UNAVAILABLE: 'The watch starts with the desk; check the desk error above.', WATCH_LIMIT: 'At most 50 watched tokens.',
  ASSISTANT_NOT_CONFIGURED: 'Add ANTHROPIC_API_KEY to .env and restart the dashboard.', ASSISTANT_BUSY: 'Claude is still answering the previous message.',
  ASSISTANT_AUTH: 'Claude rejected the API key: check ANTHROPIC_API_KEY in .env.', ASSISTANT_RATE_LIMITED: 'Claude is rate-limited right now; try again in a minute.',
  ASSISTANT_NO_CREDITS: 'Your Anthropic API account has no credits: add credits under Plans & Billing in the Anthropic console.',
  ASSISTANT_OFFLINE: 'Claude could not be reached (network).', ASSISTANT_UNAVAILABLE: 'Claude is unavailable right now; try again shortly.',
  ASSISTANT_BAD_REQUEST: 'The chat was rejected; start a new chat.', INVALID_CHAT: 'The chat could not be sent; start a new chat.',
  HOLDINGS_UNAVAILABLE: 'The wallet\'s token accounts could not be read (RPC). Try again.',
  WALLET_HISTORY_UNAVAILABLE: 'The wallet\'s transactions could not be read (RPC). Try again, or leave the wallet empty.', INVALID_ADDRESS: 'That is not a Solana address.',
  POSITION_NOT_FOUND: 'That position is no longer open in the desk ledger (already sold, or held outside the desk: sell it in your wallet).',
  PHANTOM_PROVIDER: 'Phantom could not connect from this page: open the dashboard in the browser profile where the Phantom extension is installed and unlocked. With DESK_LIVE_SIGNER=local-key in .env, LIVE needs no Phantom connection at all.',
  AUTO_CONFIRM_UNAVAILABLE_FOR_DOMAIN: 'Phantom does not offer Auto-Confirm for this domain (only for domains it has approved). LIVE orders need your approval in Phantom within 15 s.',
};
const describe = (code: string | null) => !code ? null : /supported wallet provider|wallet provider/i.test(code) ? EXPLAIN.PHANTOM_PROVIDER
  : code.startsWith('INVALID_STRATEGY_SPEC: ') ? `Strategy not saved — ${code.slice(23)}` : code.startsWith('INVALID_WATCH: ') ? `Not watched — ${code.slice(15)}`
  : EXPLAIN[code] ?? code.replaceAll('_', ' ');
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
      <div id="desk-overview" className="desk-anchor"><Capital d={d} /></div>
      <div id="desk-strategies" className="desk-anchor"><Strategies d={d} t={t} /></div>
      <Stages events={d.events} />
      <div id="desk-telemetry" className="desk-grid desk-anchor">
        <Telemetry events={d.events} />
        <PreflightCard p={d.preflights[0] ?? null} live={live} />
      </div>
      <div id="desk-opening" className="desk-anchor"><OpeningScreen d={d} /></div>
      <div id="desk-launches" className="desk-anchor"><LaunchRadar d={d} /></div>
      <div id="desk-candidates" className="desk-anchor"><Candidates list={d.candidates} probe={live ? null : mint => void t.desk('probe', { mint })} busy={!!t.busy} /></div>
      <div id="desk-positions" className="desk-anchor"><Positions d={d} busy={!!t.busy || !t.online} exit={p => {
        const how = !live ? 'This is a TEST position: the sale is paper only.' : localKey ? 'The local key signs the sale immediately (REAL FUNDS).'
          : 'Phantom will ask you to approve the sale within 15 s (REAL FUNDS).';
        if (window.confirm(`EXIT NOW: sell the whole ${p.symbol ?? p.mint} position at the current Jupiter quote (exit slippage applies)? ${how}`)) void t.desk('exit', { mint: p.mint });
      }} /></div>
      <div id="desk-watch" className="desk-anchor"><Watch t={t} d={d} /></div>
      <div id="desk-trades" className="desk-anchor"><Ledger d={d} /></div>
      <PathAudit d={d} />
    </>}
    {!d && !v?.deskError && <p className="trading-intro">Starting the local desk…</p>}
  </section>;
}

function Controls({ t, d }: { t: TradingSession; d: DeskStatus | null }) {
  const v = t.view, live = v?.mode === 'LIVE', running = !!d?.scanner, busy = !!t.busy || !t.online, localKey = live && d?.signer === 'LOCAL_KEY', locked = d?.operational?.deploymentMode === 'LOCKED';
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
      {d?.operational && <span className="chip on">CONFIG: {d.operational.deploymentMode}</span>}
      {d?.scanning && <span className="chip on">SCANNING…</span>}
    </div>
    <div className="trading-actions">
      {/* Phantom is only the signer for LIVE without the local key; TEST reads the .env address and never signs. */}
      {live && !localKey && (!t.connected ? <button className="source-button" disabled={!!t.busy} onClick={() => void t.connect()}>{t.busy === 'connect' ? 'Connecting…' : 'Connect Phantom'}</button>
        : <button className="source-button" disabled={!!t.busy} onClick={() => void t.disconnect()}>Disconnect</button>)}
      {!live ? <>
        <button className="primary-action" disabled={busy || running} onClick={() => void t.desk('start-test')}>START TEST</button>
        <button className="stop-action" disabled={busy || !running} onClick={() => void t.desk('stop-test')}>STOP TEST</button>
        <button className="source-button" disabled={busy || locked} title={locked ? 'Fixed at startup' : 'Paper entries in the best safe candidate even when strategy gates are not met'}
          onClick={() => void t.desk(d?.drill ? 'drill-off' : 'drill-on')}>{d?.drill ? 'TEST DRILL: TURN OFF' : 'TEST DRILL: TURN ON'}</button>
        <button className="source-button" disabled={busy || running || locked} title={locked ? 'Fixed at startup' : 'Archive both TEST ledgers and restart every sleeve at its planned capital'}
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
    {locked && <p className="desk-note">Strategies and TEST drill are fixed at startup. Pause and Stop stay available.</p>}
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
    <section><h3>{test ? 'TEST capital & PnL' : 'LIVE capital & PnL'}</h3>
      {test && row('TEST cash', money(c.paperCashUsd), 'all strategy sleeves; separate from wallet')}
      {!test && row('Available SOL', c.availableSol === null ? '--' : `${numeric(c.availableSol, 6)} SOL`)}
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

type Spec = RuleSpecInput;
type Group = 'entry' | 'exits' | 'sizing';
/** Editor fields of a custom strategy; an empty optional field means "no rule". */
const FIELDS: Array<{ group: Group | null; key: string; label: string; optional: boolean }> = [
  { group: 'entry', key: 'minMarketCapUsd', label: 'Min market cap ($)', optional: true }, { group: 'entry', key: 'maxMarketCapUsd', label: 'Max market cap ($)', optional: true },
  { group: 'entry', key: 'minHolders', label: 'Min holders', optional: true }, { group: 'entry', key: 'minLiquidityUsd', label: 'Min liquidity ($)', optional: false },
  { group: 'entry', key: 'minPoolAgeMin', label: 'Min pool age (min)', optional: true }, { group: 'entry', key: 'maxPoolAgeMin', label: 'Max pool age (min)', optional: true },
  { group: 'entry', key: 'minPriceChange5mPct', label: '5m change from (%)', optional: true }, { group: 'entry', key: 'maxPriceChange5mPct', label: '5m change to (%)', optional: true },
  { group: 'entry', key: 'minPriceChange1hPct', label: '1h change from (%)', optional: true }, { group: 'entry', key: 'maxPriceChange1hPct', label: '1h change to (%)', optional: true },
  { group: 'entry', key: 'minVolume5mUsd', label: 'Min 5m volume ($)', optional: true }, { group: 'entry', key: 'minVolume1hUsd', label: 'Min 1h volume ($)', optional: true },
  { group: 'entry', key: 'minVolume1hToMcapPct', label: 'Min 1h Vol/MC (%)', optional: true },
  { group: 'entry', key: 'minBuySellRatio', label: 'Min buy/sell ratio (5m)', optional: true },
  { group: 'entry', key: 'maxTop10WalletPct', label: 'Max top-10 wallets (%)', optional: true }, { group: 'entry', key: 'maxLargestWalletPct', label: 'Max largest wallet (%)', optional: true },
  { group: 'exits', key: 'takeProfitPct', label: 'Take profit (%) — empty: ride', optional: true }, { group: 'exits', key: 'stopLossPct', label: 'Stop loss (%)', optional: false },
  { group: 'exits', key: 'trailingActivationPct', label: 'Trailing stop from (+%)', optional: true }, { group: 'exits', key: 'trailingStopPct', label: 'Trailing stop (% below peak)', optional: true },
  { group: 'exits', key: 'marketCapFloorUsd', label: 'Exit at market cap ≤ ($)', optional: true }, { group: 'exits', key: 'marketCapTargetUsd', label: 'Exit at market cap ≥ ($)', optional: true },
  { group: 'exits', key: 'maxHoldMin', label: 'Max hold (min)', optional: false },
  { group: 'exits', key: 'graceSec', label: 'No stop-out in first (s)', optional: false },
  { group: 'sizing', key: 'capitalUsd', label: 'TEST capital ($)', optional: false }, { group: 'sizing', key: 'entryUsd', label: 'Entry size ($)', optional: false },
  { group: 'sizing', key: 'maxOpenPositions', label: 'Max open positions', optional: false }, { group: 'sizing', key: 'maxDragPct', label: 'Max drag (%)', optional: false },
  { group: 'sizing', key: 'slippageBps', label: 'Slippage (bps)', optional: false }, { group: 'sizing', key: 'exitSlippageBps', label: 'Exit slippage (bps)', optional: false },
  { group: null, key: 'reentryCooldownMin', label: 'Re-entry cooldown (min)', optional: false },
];
const PRESET_HINT: Record<string, string> = {
  RUNNER: 'established runners, >1,000 holders, trailing stop', MIGRATION: 'your migration play, $60K–$300K right after graduation',
  CONSOL: 'your "Crash Strategy": $800K–$1.2M consolidation re-entry', SCALP: 'your 15-minute catalyst scalp, $400K–$1M',
  CRASH_V1: 'the original CRASH rules from the first night, to compare with today\'s CRASH',
};
const BLANK: Spec = { id: 'MY_STRATEGY', label: 'My strategy', summary: '', entry: { minLiquidityUsd: 20_000 },
  exits: { stopLossPct: 30, maxHoldMin: 240, graceSec: 0 }, sizing: { capitalUsd: 5.45, entryUsd: 2, maxOpenPositions: 2, slippageBps: 300, exitSlippageBps: 500, maxDragPct: 8 }, reentryCooldownMin: 60 };
const fieldValue = (spec: Spec, f: typeof FIELDS[number]): unknown => f.group ? (spec[f.group] as Record<string, unknown>)[f.key] : (spec as unknown as Record<string, unknown>)[f.key];

function StrategyEditor({ spec, isNew, busy, save, cancel }: { spec: Spec; isNew: boolean; busy: boolean; save: (s: Spec) => void; cancel: () => void }) {
  const [draft, setDraft] = useState<Spec>(() => structuredClone(spec));
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map(f => { const v = fieldValue(spec, f); return [f.key, v === null || v === undefined ? '' : String(v)]; })));
  const build = (): Spec => {
    const next = structuredClone(draft);
    for (const f of FIELDS) {
      const raw = text[f.key]?.trim() ?? '', value = raw === '' ? (f.optional ? null : Number.NaN) : Number(raw);
      if (f.group) (next[f.group] as Record<string, unknown>)[f.key] = value; else (next as unknown as Record<string, unknown>)[f.key] = value;
    }
    return next;
  };
  const input = (f: typeof FIELDS[number]) => <label key={f.key}><span>{f.label}</span>
    <input inputMode="decimal" value={text[f.key] ?? ''} placeholder={f.optional ? 'no rule' : 'required'} onChange={e => setText({ ...text, [f.key]: e.target.value })} /></label>;
  const group = (g: Group | null, title: string) => <fieldset><legend>{title}</legend><div className="spec-grid">{FIELDS.filter(f => f.group === g).map(input)}</div></fieldset>;
  return <form className="strategy-editor" onSubmit={e => { e.preventDefault(); save(build()); }}>
    <div className="spec-grid">
      <label><span>Id (A–Z, 0–9, _)</span><input value={draft.id} disabled={!isNew} onChange={e => setDraft({ ...draft, id: e.target.value.toUpperCase() })} /></label>
      <label><span>Name</span><input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
    </div>
    <label className="spec-wide"><span>Idea (shown on the card)</span><textarea rows={2} value={draft.summary ?? ''} onChange={e => setDraft({ ...draft, summary: e.target.value })} /></label>
    {group('entry', 'Entry — every rule must pass (safety gates always apply)')}
    <label className="spec-check"><input type="checkbox" checked={!!draft.entry.requireXAccount} onChange={e => setDraft({ ...draft, entry: { ...draft.entry, requireXAccount: e.target.checked } })} /> Require a linked X account</label>
    {group('exits', 'Exits')}
    {group('sizing', 'Size and costs')}
    {group(null, 'Re-entry')}
    <div className="spec-actions"><button className="primary-action" type="submit" disabled={busy}>{isNew ? 'Add strategy' : 'Save changes'}</button>
      <button className="source-button" type="button" onClick={cancel}>Cancel</button></div>
    <p className="desk-note">{isNew ? 'A new strategy starts ON in TEST and OFF in LIVE.' : 'Changes apply to new entries at once; open positions switch to the new exit rules.'} Untested rules: let them prove themselves in TEST first.</p>
  </form>;
}

type ChatTurn = { role: 'user' | 'assistant'; content: string; answer?: AssistantAnswer };
/**
 * Strategy assistant: describe how you trade (or name a wallet whose trades show it) and Claude proposes a rule
 * strategy. A proposal only opens in the editor; you review and add it, and it starts in TEST.
 */
function StrategyChat({ t, open }: { t: TradingSession; open: (spec: Spec) => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]), [text, setText] = useState(''), [wallet, setWallet] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const ready = !!t.view?.assistant;
  const send = async () => {
    const content = text.trim();
    if (!content || pending) return;
    const next: ChatTurn[] = [...turns, { role: 'user', content }];
    setTurns(next); setText(''); setPending(true); setError(null);
    try {
      const answer = await t.ask(next.map(({ role, content: c }) => ({ role, content: c })), wallet.trim() || null);
      // Claude sees its own earlier proposal in the history, so "make the stop tighter" edits the same strategy.
      const remembered = answer.strategy ? `${answer.reply}\n\n[Proposed strategy: ${JSON.stringify(answer.strategy)}]` : answer.reply;
      setTurns([...next, { role: 'assistant', content: remembered, answer }]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Assistant unavailable'); setTurns(turns); setText(content); }
    finally { setPending(false); }
  };
  const lastWallet = [...turns].reverse().find(x => x.answer?.wallet)?.answer?.wallet ?? null;
  return <details className="panel strategy-chat" open={turns.length > 0 || undefined}>
    <summary><strong>Strategy assistant (Claude)</strong> — describe how you trade, or name a wallet whose trades show it</summary>
    {!ready ? <p className="desk-note">Add <code>ANTHROPIC_API_KEY=…</code> (from console.anthropic.com) to <code>.env</code> in the repo root and restart the dashboard. The key stays in the local server.</p> : <>
      <div className="chat-log" aria-live="polite">
        {!turns.length && <p className="desk-note">For example: "I buy FOMO trending tokens with over 1,000 holders after they move sideways for an hour, and sell when they fall 25% from the top." Add a wallet address below and Claude also reads its recent swaps (entries, exits, market caps).</p>}
        {turns.map((x, i) => <div key={i} className={`chat-turn ${x.role}`}>
          <p>{x.role === 'assistant' ? x.answer?.reply ?? x.content : x.content}</p>
          {x.answer?.strategy && <div className="chat-proposal"><strong>Proposed: {x.answer.strategy.label}</strong> <small>({x.answer.strategy.id})</small>
            <span>{x.answer.strategy.summary}</span>
            <button className="primary-action" type="button" onClick={() => open(x.answer!.strategy!)}>Review in editor</button></div>}
          {x.answer?.specError && <p className="trading-error">The proposal does not pass the desk's checks ({x.answer.specError}). Ask Claude to fix it.</p>}
        </div>)}
        {pending && <p className="desk-note">Claude is thinking{wallet.trim() ? ' (and reading the wallet\'s trades)' : ''}… this can take up to a minute.</p>}
      </div>
      {lastWallet && <details><summary>Wallet {short(lastWallet.wallet)}: {lastWallet.trades} swaps in {lastWallet.tokens.length} tokens (last {lastWallet.scanned} transactions)</summary>
        <div className="wallet-table"><table><thead><tr><th>Token</th><th>Swaps</th><th>Bought</th><th>Sold</th><th>First buy at</th><th>Last sell at</th><th>Now</th></tr></thead>
          <tbody>{lastWallet.tokens.map(x => <tr key={x.mint}><td title={x.mint}>{x.symbol ?? short(x.mint)}{x.stillHeld ? ' · held' : ''}</td><td>{x.trades}</td>
            <td>{money(x.boughtUsd)}</td><td>{money(x.soldUsd)}</td><td>{cap(x.firstBuyMcapUsd)}</td><td>{cap(x.lastSellMcapUsd)}</td><td>{cap(x.nowMcapUsd)}</td></tr>)}</tbody></table></div>
        <p className="desk-note">Market caps are estimates: trade price × current supply, SOL at today's price.</p></details>}
      {error && <p className="trading-error" role="alert">{describe(error)}</p>}
      <form className="chat-input" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea rows={3} value={text} placeholder="How do you pick, enter and exit a coin?" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <label><span>Learn from wallet (optional)</span><input value={wallet} placeholder="your FOMO or Phantom address" onChange={e => setWallet(e.target.value)} /></label>
        <div className="spec-actions"><button className="primary-action" type="submit" disabled={pending || !text.trim()}>{pending ? 'Waiting…' : 'Send'}</button>
          {turns.length > 0 && <button className="source-button" type="button" disabled={pending} onClick={() => { setTurns([]); setError(null); }}>New chat</button>}</div>
      </form>
      <p className="desk-note">Sent to Claude ({'claude-opus-5-5'}): your messages, your custom strategies and, if given, the wallet's recent swaps. Proposals are never saved or switched on by themselves.</p>
    </>}
  </details>;
}

function Strategies({ d, t }: { d: DeskStatus; t: TradingSession }) {
  const busy = !!t.busy || !t.online, test = d.mode === 'PAPER', locked = d.operational?.deploymentMode === 'LOCKED';
  const [selected, setSelected] = useState('ALL');
  const [editor, setEditor] = useState<{ spec: Spec; isNew: boolean } | null>(null);
  const known = new Set(d.strategies.map(s => s.id)), current = d.strategies.find(s => s.id === selected) ?? null;
  const freeId = (base: string) => { let id = base, n = 2; while (known.has(id)) id = `${base.slice(0, 14)}${n++}`; return id; };
  const choose = (value: string) => {
    if (value.startsWith('new:')) {
      const key = value.slice(4), template = key === 'BLANK' ? BLANK : d.presets?.[key];
      if (template) setEditor({ spec: { ...structuredClone(template), id: freeId(template.id) }, isNew: true });
      return;
    }
    setSelected(value); setEditor(null);
  };
  const save = async (spec: Spec) => { if (await t.desk('strategy-save', { spec })) { setEditor(null); setSelected(spec.id); } };
  const remove = async (s: StrategyView) => {
    if (!window.confirm(`Delete ${s.label}? Its ledger and trade history stay on disk.`)) return;
    if (await t.desk('strategy-delete', { strategy: s.id })) setSelected('ALL');
  };
  const shown = selected === 'ALL' || !current ? d.strategies : [current];
  return <div aria-label="Strategies">
    <div className="strategy-bar panel">
      <label><span>Strategy</span>
        <select value={current ? selected : 'ALL'} onChange={e => choose(e.target.value)} disabled={!!editor}>
          <option value="ALL">All strategies ({d.strategies.length})</option>
          {d.strategies.map(s => <option key={s.id} value={s.id}>{s.label} — {s.enabled ? 'ON' : 'OFF'}{s.spec ? ' · custom' : ''}</option>)}
          {!locked && <optgroup label="Add a strategy">
            {Object.entries(d.presets ?? {}).map(([k, p]) => <option key={k} value={`new:${k}`}>+ {p.label} preset — {PRESET_HINT[k] ?? p.summary}</option>)}
            <option value="new:BLANK">+ Blank strategy</option>
          </optgroup>}
        </select></label>
      {current && <button className={current.enabled ? 'source-button' : 'primary-action'} disabled={busy || locked}
        onClick={() => void t.desk('strategy', { strategy: current.id, enabled: !current.enabled })}>{current.enabled ? `${current.label} ON · turn off` : `${current.label} OFF · turn on`}</button>}
      {current?.spec && !editor && !locked && <button className="source-button" onClick={() => setEditor({ spec: current.spec!, isNew: false })}>Edit rules</button>}
      {current?.spec && !editor && !locked && <button className="stop-action" disabled={busy} onClick={() => void remove(current)}>Delete</button>}
      <small>{test ? 'TEST' : 'LIVE'}: switches apply to this mode only. Custom strategies trade their own ledger{test ? ' and TEST sleeve' : ''}.</small>
    </div>
    <StrategyChat t={t} open={spec => setEditor({ spec, isNew: !known.has(spec.id) })} />
    {editor && <StrategyEditor key={`${editor.spec.id}-${editor.isNew}`} spec={editor.spec} isNew={editor.isNew} busy={busy} save={s => void save(s)} cancel={() => setEditor(null)} />}
    <div className="strategies">{shown.map((s: StrategyView) => {
    const x = s.stats, row = (label: string, value: string) => <div><span>{label}</span><strong>{value}</strong></div>;
    return <section key={s.id} className={`strategy ${s.enabled ? 'on' : 'off'}`}>
      <div className="card-head"><h3>{s.label}{s.spec ? <small> · custom</small> : null}</h3>
        <button className={s.enabled ? 'source-button' : 'primary-action'} disabled={busy || locked}
          onClick={() => void t.desk('strategy', { strategy: s.id, enabled: !s.enabled })}>{s.enabled ? 'ON · turn off' : 'OFF · turn on'}</button></div>
      <p className="desk-note">{s.summary}{!test && (s.id === 'CRASH' || s.spec) && !d.operational ? ' · LIVE: starts OFF by default.' : ''}{d.operational ? ` · Re-entry ${s.reentryCooldownMin ?? '--'} min; after loss at least ${(d.operational.lossCooldownMs[s.id] ?? (s.reentryCooldownMin ?? 0) * 60000) / 60000} min` : ''}</p>
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
      {s.spec && <details><summary>Entry rules</summary><ul>{entryRuleText(s.spec).map(r => <li key={r}>{r}</li>)}</ul></details>}
    </section>;
  })}</div>
  </div>;
}

/** Plain-language entry rules of a custom strategy (the safety gates are implied). */
function entryRuleText(s: Spec): string[] {
  const e = s.entry, k = (n: number) => n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}K` : `$${n}`;
  const band = (lo: number | null | undefined, hi: number | null | undefined, f: (n: number) => string, what: string) =>
    lo != null && hi != null ? [`${what} ${f(lo)} to ${f(hi)}`] : lo != null ? [`${what} ≥ ${f(lo)}`] : hi != null ? [`${what} ≤ ${f(hi)}`] : [];
  const p = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
  return [...band(e.minMarketCapUsd, e.maxMarketCapUsd, k, 'Market cap'), ...(e.minHolders != null ? [`Holders ≥ ${e.minHolders.toLocaleString('en-US')}`] : []),
    ...band(e.minPoolAgeMin, e.maxPoolAgeMin, n => `${n} min`, 'Pool age'), ...band(e.minPriceChange5mPct, e.maxPriceChange5mPct, p, '5m change'),
    ...band(e.minPriceChange1hPct, e.maxPriceChange1hPct, p, '1h change'), ...band(e.minVolume5mUsd, null, k, '5m volume'), ...band(e.minVolume1hUsd, null, k, '1h volume'), ...band(e.minVolume1hToMcapPct, null, n => `${n}%`, '1h Vol/MC'),
    ...band(e.minBuySellRatio, null, n => String(n), 'Buy/sell ratio'), ...band(e.minLiquidityUsd ?? 10_000, null, k, 'Liquidity'),
    ...band(null, e.maxTop10WalletPct, n => `${n}%`, 'Top-10 wallets'), ...band(null, e.maxLargestWalletPct, n => `${n}%`, 'Largest wallet'),
    ...(e.requireXAccount ? ['X account linked'] : []), 'Always: mint and freeze authority revoked, no dangerous token extensions'];
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

/**
 * Candidates: the general scan (market data for every token found, FOMO-style) and, separately, what each ENABLED
 * strategy says about it. A strategy that is off says nothing; the scan itself never filters on a strategy's rules.
 */
function Candidates({ list, probe, busy }: { list: Candidate[]; probe: ((mint: string) => void) | null; busy: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const age = (m: number | null | undefined) => m == null ? '?' : m < 60 ? `${Math.round(m)}m` : m < 2_880 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)}h` : `${Math.round(m / 1_440)}d`;
  const change = (v: number | null | undefined) => v == null ? '--' : <span className={v >= 0 ? 'chg-up' : 'chg-down'}>{v >= 0 ? '+' : ''}{v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)}%</span>;
  return <section className="panel desk-card" aria-label="Candidates">
    <div className="card-head"><h3>Candidates · market data, and what each enabled strategy says</h3><small>{list.length} shown · age = since the token appeared, not the pool</small></div>
    <div className="wallet-table"><table className="cand"><thead><tr>
      <th>Token / CA</th><th title="Since creation (pump.fun) or the oldest pool; after: since graduation / first AMM pool">Age</th><th>Market cap</th><th>Liquidity</th>
      <th>Vol 5m / 1h</th><th title="Buys / sells in the last hour">Txns 1h</th><th>5m</th><th>1h</th><th>6h</th><th>Buy/sell 5m</th>
      <th title="Owners with a balance · share of the 10 largest wallets (pools and curves excluded)">Holders</th><th>X</th>
      <th title="Every enabled strategy: entry-ready, or the first rule it misses">Strategies</th><th>Mint / freeze</th><th>Risk flags</th></tr></thead>
      <tbody>{list.map(c => { const m = c.metrics, v = c.verdicts ?? []; return <Fragment key={c.mint}>
        <tr className={`${v.some(x => x.signal) ? 'status-qualified' : 'status-watchlist'}${c.stale ? ' stale' : ''}`} onClick={() => setOpen(open === c.mint ? null : c.mint)} aria-expanded={open === c.mint}>
          <td title={c.mint}><strong>{c.symbol ?? '?'}</strong> <Fomo mint={c.mint} /><br /><small>{short(c.mint)}{c.sources.includes('launch-radar') ? ' · radar' : ''}{c.sources.includes('x-feed') ? ' · X feed' : ''}</small></td>
          <td>{age(m.tokenAgeMin ?? m.poolAgeMin)}<br /><small>{m.migration === 'BONDING_CURVE' ? 'on curve' : m.firstPoolAgeMin != null ? `grad. ${age(m.firstPoolAgeMin)}` : ''}</small></td>
          <td>{usdOrUnknown(m.marketCapUsd)}</td><td>{usdOrUnknown(m.liquidityUsd)}<br /><small>{m.quote && !['SOL', 'WSOL', 'USDC', 'USDT'].includes(m.quote) ? `vs ${m.quote}` : ''}</small></td>
          <td>{usdOrUnknown(m.volume5mUsd)}<br /><small>{usdOrUnknown(m.volume1hUsd)}</small></td>
          <td>{m.buys1h == null ? '--' : `${m.buys1h} / ${m.sells1h ?? 0}`}</td>
          <td>{change(m.priceChange5mPct)}</td><td>{change(m.priceChange1hPct)}</td><td>{change(m.priceChange6hPct)}</td>
          <td>{m.buySellRatio5m === null ? '--' : m.buySellRatio5m.toFixed(2)}</td>
          <td>{holderCount(c.holders)}<br /><small>top-10 {pct(m.top10WalletPct)}</small></td>
          <td>{c.social.x.kind === 'NONE' ? 'none' : `${c.social.x.handle ? `@${c.social.x.handle}` : c.social.x.kind.toLowerCase()}`}
            <br /><small>{c.social.xFollowers != null ? `${c.social.xFollowers.toLocaleString('en-US')} followers` : c.social.authenticity}</small></td>
          <td>{c.stale ? <span className="badge-stale" title="Not re-assessed in the last scan; never traded on">STALE · {ago(c.updatedAt)}</span>
            : v.length ? v.map(x => <div key={x.id} title={x.summary}>{x.signal ? <span className="badge-qualified">{x.id} ✓</span> : <span className="badge-filtered">{x.id}</span>}
              {' '}<small>{c.entryNotes?.[x.id] ?? (x.signal ? 'entry-ready' : x.summary.split(':')[0])}</small></div>)
            : <small>no enabled strategy covers it</small>}</td>
          <td>{c.onchain.mintAuthority === null ? '?' : `${c.onchain.mintAuthority ? 'ACTIVE' : 'revoked'} / ${c.onchain.freezeAuthority ? 'ACTIVE' : 'revoked'}`}</td>
          <td>{c.riskFlags.length ? c.riskFlags.slice(0, 2).join('; ') : '—'}</td>
        </tr>
        {open === c.mint && <tr className="detail-row"><td colSpan={15}><CandidateDetail c={c} probe={probe} busy={busy} /></td></tr>}
      </Fragment>; })}
      {!list.length && <tr><td colSpan={15}>No candidates yet. The first scan starts with TEST or a LIVE session.</td></tr>}</tbody></table></div>
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
        {c.launch && <><h4>LAUNCH entry checks · {c.launch.signal.signal ? 'SIGNAL' : 'no signal'} · score {c.launch.score}</h4><p className="desk-note">{c.launch.reasons.join(' · ')}</p>
          <table className="gates"><tbody>{c.launch.signal.checks.map(g => <tr key={g.key}><td>{g.label}</td><td className={`gate-${g.status.toLowerCase()}`}>{g.status}{!g.blocking && g.status !== 'PASS' ? ' (flag)' : ''}</td><td>{g.actual}</td><td>{g.required}</td></tr>)}</tbody></table></>}
        {Object.entries(c.rules ?? {}).map(([id, r]) => <Fragment key={id}><h4>{id} entry checks · {r.signal ? 'SIGNAL' : 'no signal'}</h4><table className="gates"><tbody>
          {r.checks.map(g => <tr key={g.key}><td>{g.label}</td><td className={`gate-${g.status.toLowerCase()}`}>{g.status}</td><td>{g.actual}</td><td>{g.required}</td></tr>)}</tbody></table></Fragment>)}
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
        return <tr key={p.id}><td>{p.strategy ?? 'FAIR'}</td><td title={p.mint}>{p.symbol ?? short(p.mint)} <Fomo mint={p.mint} /></td><td>{p.qtyRaw}</td><td>{p.entryPriceUsd?.toPrecision(6) ?? '--'}</td>
          <td>{p.lastPriceUsd?.toPrecision(6) ?? '--'}</td><td>{fine(p.costUsd)}</td><td>{fine(value)}</td><td>{fine(value === null ? null : value - p.costUsd)}</td>
          <td>{p.noRouteSince ? <span className="unknown" title="Jupiter finds no route to sell this token (pool drained or delisted). Re-quoted every 2 min; it exits if a route returns.">NO ROUTE since {ago(p.noRouteSince)}</span> : p.route}</td><td>{ago(p.openedAt)}</td>
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

/** Opens the token in the FOMO app (on the phone) or its FOMO page. */
const Fomo = ({ mint }: { mint: string }) => <a className="fomo-link" href={`https://fomo.family/tokens/solana/${mint}`} target="_blank" rel="noreferrer" title="Open in FOMO" onClick={e => e.stopPropagation()}>FOMO</a>;
const cap = (n: number | null | undefined) => n == null ? '--' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
/** Accepts 30000000, 30m, 30M, 450k, $1.2M. */
const parseCap = (v: string): number | null => {
  const m = /^\$?\s*([\d.,]+)\s*([kKmMbB]?)$/.exec(v.trim());
  if (!m) return null;
  const unit: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
  const n = Number(m[1]!.replaceAll(',', '')) * (unit[m[2]!.toLowerCase()] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function watchStatus(r: WatchRule): { text: string; tone: string } {
  const t = r.triggered;
  if (t) return { text: `${t.outcome.replace('_', ' ')} · ${ago(t.at)} — ${t.reason}${t.detail ? ` · ${t.detail}` : ''}`, tone: t.outcome === 'SOLD' ? 'gate-pass' : t.outcome === 'SELL_FAILED' ? 'gate-fail' : 'gate-unknown' };
  if (r.lastError) return { text: r.lastError, tone: 'gate-unknown' };
  if (r.pending) return { text: `CONFIRMING (${r.pending.count}/2): ${r.pending.reason}`, tone: 'gate-unknown' };
  return { text: r.checkedAt ? `watching · checked ${ago(r.checkedAt)}` : 'waiting for the first check', tone: 'gate-pass' };
}

/**
 * Exit rules for tokens you hold yourself (FOMO, Phantom, …): alert, or with the local-key wallet sell, at a market-cap
 * floor, a trailing stop from the peak, or a target. Runs while the dashboard runs, with the desk started or not.
 */
function Watch({ t, d }: { t: TradingSession; d: DeskStatus }) {
  const w: WatchView | null | undefined = t.view?.watch, busy = !!t.busy || !t.online;
  const [form, setForm] = useState({ mint: '', wallet: '', floor: '', target: '', trail: '', action: 'ALERT', note: '' });
  const [perm, setPerm] = useState<string>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [held, setHeld] = useState<{ wallet: string; holdings: Holding[] } | null>(null), [loading, setLoading] = useState(false), [heldError, setHeldError] = useState<string | null>(null);
  const loadHoldings = async () => {
    setLoading(true); setHeldError(null);
    try { setHeld(await t.holdings(wallet)); } catch (e) { setHeldError(e instanceof Error ? e.message : 'HOLDINGS_UNAVAILABLE'); } finally { setLoading(false); }
  };
  const seen = useRef<number | null>(null);
  const wallet = form.wallet.trim() || w?.sellWallet || d.wallet.address || '';
  // Browser notifications for alerts that arrive while this tab is open.
  useEffect(() => {
    const newest = w?.alerts[0]?.at ?? 0;
    if (seen.current === null) { seen.current = newest; return; }
    if (perm === 'granted') for (const a of [...(w?.alerts ?? [])].reverse()) if (a.at > seen.current) new Notification(a.title, { body: a.body, tag: `${a.ruleId}-${a.at}` });
    seen.current = Math.max(seen.current, newest);
  }, [w?.alerts, perm]);
  if (!w) return null;
  const canSell = !!w.sellWallet && wallet === w.sellWallet;
  const submit = async () => {
    const rule = { mint: form.mint.trim(), wallet, action: canSell ? form.action : 'ALERT', note: form.note,
      marketCapFloorUsd: form.floor.trim() ? parseCap(form.floor) ?? -1 : null, marketCapTargetUsd: form.target.trim() ? parseCap(form.target) ?? -1 : null,
      trailingStopPct: form.trail.trim() ? Number(form.trail) : null };
    if (await t.desk('watch-add', { rule })) setForm({ ...form, mint: '', floor: '', target: '', trail: '', note: '' });
  };
  const field = (key: keyof typeof form, label: string, placeholder: string) => <label key={key}><span>{label}</span>
    <input value={form[key]} placeholder={placeholder} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>;
  return <section className="panel desk-card" aria-label="Watch">
    <div className="card-head"><h3>Watch · exit rules for tokens you hold yourself</h3>
      <small>Market cap checked every 15 s, with or without the desk running. A rule fires after two checks in a row.</small></div>
    <form className="watch-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {field('mint', 'Token (CA)', 'e.g. 9AQMJ…pump')}
      {field('wallet', 'Wallet holding it (e.g. your FOMO wallet)', w.sellWallet ?? d.wallet.address ?? 'your FOMO or Phantom address')}
      {field('floor', 'Exit at market cap ≤', 'e.g. 30M')}
      {field('trail', 'Trailing stop (% below peak)', 'e.g. 25')}
      {field('target', 'Take profit at market cap ≥', 'e.g. 80M')}
      <label><span>Action</span><select value={canSell ? form.action : 'ALERT'} disabled={!canSell} onChange={e => setForm({ ...form, action: e.target.value })}>
        <option value="ALERT">Alert me</option><option value="SELL">Sell everything automatically (local key)</option></select></label>
      {field('note', 'Note (shown in the alert)', 'e.g. my plan: out below 30M')}
      <div className="spec-actions"><button className="primary-action" type="submit" disabled={busy || !form.mint.trim()}>Watch token</button>
        <button className="source-button" type="button" disabled={loading || !wallet} onClick={() => void loadHoldings()}>{loading ? 'Loading…' : 'Load wallet holdings'}</button></div>
    </form>
    {heldError && <p className="trading-error" role="alert">{describe(heldError)}</p>}
    {held && <details open><summary>{short(held.wallet)} holds {held.holdings.length} token(s) — pick one to watch</summary>
      <div className="wallet-table"><table><thead><tr><th>Token</th><th>Balance</th><th>Value</th><th>Market cap</th><th></th></tr></thead>
        <tbody>{held.holdings.map(h => <tr key={h.mint}><td title={h.mint}><strong>{h.symbol ?? short(h.mint)}</strong> <Fomo mint={h.mint} /></td>
          <td>{numeric(h.balance, 2)}</td><td>{h.valueUsd === null ? '--' : money(h.valueUsd)}</td><td>{cap(h.marketCapUsd)}</td>
          <td>{w.rules.some(r => r.mint === h.mint && r.wallet === held.wallet) ? 'watched'
            : <button className="source-button" type="button" onClick={() => setForm({ ...form, mint: h.mint, wallet: held.wallet })}>Set levels</button>}</td></tr>)}
          {!held.holdings.length && <tr><td colSpan={5}>No tokens in this wallet.</td></tr>}</tbody></table></div></details>}
    <p className="desk-note">{w.sellWallet ? `Automatic selling is available for the local-key wallet ${short(w.sellWallet)} only; for FOMO or other wallets you get alerts. ` : 'Automatic selling needs DESK_LIVE_SIGNER=local-key; until then every rule alerts. '}
      Phone alerts: {w.channels.length ? w.channels.join(' + ') : 'off — add DESK_NTFY_TOPIC (ntfy app) or DESK_TELEGRAM_BOT_TOKEN + DESK_TELEGRAM_CHAT_ID to .env'}. Browser alerts: {perm === 'granted' ? 'on' : perm === 'unsupported' ? 'not supported here'
        : <button className="source-button" type="button" onClick={() => void Notification.requestPermission().then(setPerm)}>turn on</button>}</p>
    <div className="wallet-table"><table><thead><tr><th>Token</th><th>Wallet</th><th>Market cap</th><th>Peak since added</th><th>Rules</th><th>Balance</th><th>Status</th><th></th></tr></thead>
      <tbody>{w.rules.map(r => { const st = watchStatus(r); return <tr key={r.id}>
        <td title={r.mint}><strong>{r.symbol ?? '?'}</strong> <Fomo mint={r.mint} /><br /><small>{short(r.mint)}</small></td>
        <td title={r.wallet}>{short(r.wallet)}{r.wallet === w.sellWallet ? <><br /><small>local key</small></> : null}</td>
        <td>{cap(r.lastMarketCapUsd)}</td><td>{cap(r.peakMarketCapUsd)}</td>
        <td>{[r.marketCapFloorUsd != null && `floor ${cap(r.marketCapFloorUsd)}`, r.trailingStopPct != null && `trail ${r.trailingStopPct}%`, r.marketCapTargetUsd != null && `target ${cap(r.marketCapTargetUsd)}`].filter(Boolean).join(' · ')}<br />
          <small>{r.action === 'SELL' ? 'SELL automatically' : 'alert'}{r.note ? ` · ${r.note}` : ''}</small></td>
        <td>{r.balanceRaw === null ? '--' : r.decimals === null ? r.balanceRaw : numeric(Number(r.balanceRaw) / 10 ** r.decimals, 2)}</td>
        <td className={st.tone}>{st.text}{r.triggered?.signature && <> · <a href={`https://solscan.io/tx/${encodeURIComponent(r.triggered.signature)}`} target="_blank" rel="noreferrer">tx</a></>}</td>
        <td>{r.triggered && <button className="source-button" disabled={busy} onClick={() => void t.desk('watch-rearm', { id: r.id })}>Re-arm</button>}
          <button className="source-button" disabled={busy} onClick={() => { if (window.confirm(`Stop watching ${r.symbol ?? r.mint}?`)) void t.desk('watch-remove', { id: r.id }); }}>Remove</button></td></tr>; })}
        {!w.rules.length && <tr><td colSpan={8}>Nothing watched yet. Add a token you hold, e.g. with a market-cap floor at your exit level.</td></tr>}</tbody></table></div>
    {w.alerts.length > 0 && <details open><summary>Alerts ({w.alerts.length})</summary><ul className="watch-alerts">{w.alerts.slice(0, 10).map(a =>
      <li key={`${a.ruleId}-${a.at}`}><strong>{ago(a.at)} · {a.title}</strong> — {a.body}</li>)}</ul></details>}
  </section>;
}

/**
 * Opening screen (the owner's basic screen): every new pump.fun launch's market cap is read from its bonding curve every
 * few seconds. A launch whose first one-minute candle reached $10K and that never fell below $6.7K is watched; when it
 * breaks back above its opening high (×1.3) an alert goes out at once and OPEN buys, holds for at least 6× and adds.
 */
function OpeningScreen({ d }: { d: DeskStatus }) {
  const o = d.opening, list = o?.list ?? [], k = (v: number | null) => v == null ? '--' : `$${(v / 1000).toFixed(1)}K`;
  const mins = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 60_000))} min`;
  const label: Record<string, string> = { STRONG: 'watching', SIGNAL: 'BREAKOUT', RUG: 'rug (below floor)', GRADUATED: 'graduated first', EXPIRED: 'no breakout' };
  return <section className="panel desk-card" aria-label="Opening screen">
    <div className="card-head"><h3>Opening screen · 10K+ opening candle, never below 6.7K, breakout above the open</h3>
      <small>{o ? `${o.counts.OPENING ?? 0} launches in their first minute · ${o.counts.STRONG ?? 0} strong opens watched · ${o.counts.SIGNAL ?? 0} breakouts · ${o.counts.RUG ?? 0} fell below 6.7K · ${o.counts.WEAK ?? 0} weak opens skipped`
        : 'Runs while TEST or LIVE scans.'} Market caps are read from each launch's bonding curve every 4 s.</small></div>
    <div className="wallet-table"><table><thead><tr><th>Token</th><th>Age</th><th>Opening candle</th><th>Low</th><th>Now</th><th>Peak</th><th>Status</th><th>OPEN</th></tr></thead>
      <tbody>{list.map(x => <tr key={x.mint} className={x.status === 'SIGNAL' ? 'launch-ready' : x.status === 'RUG' ? 'launch-fake' : ''}>
        <td title={x.mint}><strong>{x.symbol}</strong> <Fomo mint={x.mint} /><br /><small>{x.name.slice(0, 32)}</small></td>
        <td>{mins(x.at)}</td><td>{k(x.openHighUsd)}</td><td>{k(x.lowUsd)}</td><td>{k(x.lastUsd)}</td><td>{k(x.peakUsd)}</td>
        <td title={x.detail}><small>{x.status === 'SIGNAL' ? `BREAKOUT at ${k(x.signalUsd)}` : label[x.status] ?? x.status}</small></td>
        <td><small>{x.held ? `held by ${x.held}` : x.entry ?? (x.status === 'SIGNAL' ? 'waiting for market data' : '--')}</small></td></tr>)}
        {!list.length && <tr><td colSpan={8}>No strong opening candle yet.</td></tr>}</tbody></table></div>
  </section>;
}

/**
 * Launch radar: fresh pump.fun launches with their own X account and a live website (the @glabuz Meme Industries
 * pattern), shortlisted seconds after creation and ranked by score and X followers. The X page is read for followers,
 * account age, post views and the contract address; the website for the CA too (another CA marks an impersonator);
 * the chain for the insiders (dev + creation-slot buyers); Claude reviews the idea and the site. LAUNCH buys the best
 * on the curve 1–12 min in, or after graduation when the X reach is strong; each find is an alert with a FOMO link.
 */
function LaunchRadar({ d }: { d: DeskStatus }) {
  const list = d.launches ?? [], mins = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 60_000))} min`;
  type L = NonNullable<DeskStatus['launches']>[number];
  const ca = (c: L['ca']) => !c ? '--' : c.status === 'X' ? '✓ on X' : c.status === 'WEBSITE' ? '✓ on site' : c.status === 'IMPERSONATOR' ? '✗ FAKE' : 'not yet';
  const num = (n: number | null | undefined) => n == null ? '?' : n >= 10_000 ? `${(n / 1000).toFixed(0)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  const x = d.xFeed;
  return <section className="panel desk-card" aria-label="Launch radar">
    <div className="card-head"><h3>Launch radar · new pump.fun launches with their own X account and a website</h3>
      <small>About 50 launches a minute are read from the chain. The X page (followers, account age, post views, CA), the website (CA) and the insiders
        (dev + creation-slot wallets) are checked; Claude rates the idea and the site. More followers rank higher. LAUNCH buys $5K–$40K on the curve 1–12 min in,
        or $40K–$400K after graduation with strong X reach; it sells when insiders sell, before graduation while they hold ≥ 8%, and on any rug sign.
        X feed: {x ? (x.configured ? (x.lastError ?? `${x.signals} token posts read`) : 'off (set X_BEARER_TOKEN in .env)') : 'off'}.</small></div>
    <div className="wallet-table"><table><thead><tr><th>Token</th><th>Age</th><th>Score</th><th>CA</th><th title="Followers · best post views (3 days) · account age">X reach</th>
      <th title="Creator + wallets that bought in the creation slot">Insiders</th><th>Claude</th><th>Why</th><th>Links</th><th>Market cap</th><th>Status</th></tr></thead>
      <tbody>{list.map(l => <tr key={l.mint} className={l.signal ? 'launch-ready' : l.rug || l.ca?.status === 'IMPERSONATOR' ? 'launch-fake' : ''}>
        <td title={l.mint}><strong>{l.symbol}</strong> <Fomo mint={l.mint} /><br /><small>{l.name.slice(0, 40)}</small></td>
        <td>{mins(l.at)}</td><td>{l.score}</td><td title={l.ca?.detail}><small>{l.rug ? '✗ RUG' : ca(l.ca)}</small></td>
        <td><small>{l.ownX === false ? <>narrative: someone else's account<br />({num(l.followers)} followers)</> : <>{num(l.followers)} followers</>}<br />{l.bestViews != null ? `${num(l.bestViews)} views` : '--'}{l.accountAgeDays != null ? ` · ${l.accountAgeDays < 1 ? `${Math.max(1, Math.round(l.accountAgeDays * 24))} h` : `${Math.round(l.accountAgeDays)} d`} old` : ''}
          {l.xPosts ? <><br />{l.xPosts} X-feed post{l.xPosts > 1 ? 's' : ''}</> : null}</small></td>
        <td title={l.insiders ?? undefined}><small>{l.insiderPct != null ? `${l.insiderPct.toFixed(1)}%` : 'reading'}</small></td>
        <td title={l.review ? `${l.review.summary}${l.review.scamSignals.length ? ` · Scam signs: ${l.review.scamSignals.join('; ')}` : ''}` : undefined}>
          <small>{l.review ? <>{l.review.verdict}<br />idea {l.review.idea}/10 · site {l.review.professionalism}/10</> : '--'}</small></td>
        <td><small>{l.reasons.join(' · ')}</small></td>
        <td><small>{l.x ? <a href={l.x} target="_blank" rel="noreferrer">X</a> : 'no X'}{' · '}
          {l.website ? <a href={l.website} target="_blank" rel="noreferrer">{(() => { try { return new URL(l.website).hostname; } catch { return 'site'; } })()}</a> : 'no site'}</small></td>
        <td>{cap(l.marketCapUsd)}</td><td><small>{l.signal ? 'ENTRY-READY · ' : ''}{l.status}</small></td></tr>)}
        {!list.length && <tr><td colSpan={11}>No launch with its own X account and a live website yet. The radar runs while TEST or LIVE scans.</td></tr>}</tbody></table></div>
  </section>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { phantomProvider, type PhantomListener } from './phantom';
import type { DeskMode, DeskStatus } from '../../src/desk/types';
import type { WatchView } from '../../src/desk/watch';
import type { RuleSpec } from '../../src/desk/custom';
import type { BrowserSDK } from '@phantom/browser-sdk';
import type { PollConfig, PollResult } from './poll-worker';

export interface TradingView {
  session: { address: string; expiresAt: number } | null;
  pending: { id: string; transactionBase64: string; expiresAt: number } | null;
  mode: DeskMode; desk: DeskStatus | null; deskError: string | null;
  /** Exit rules for tokens held outside the desk's strategies (null until the desk has started). */
  watch?: WatchView | null;
  /** The strategy assistant is configured (ANTHROPIC_API_KEY in .env). */
  assistant?: boolean;
}
export interface AssistantAnswer {
  reply: string; strategy: RuleSpec | null; specError: string | null; model: string; stopReason: string | null;
  wallet: null | { wallet: string; scanned: number; trades: number; tokens: Array<{ mint: string; symbol: string | null; trades: number; boughtUsd: number; soldUsd: number;
    firstBuyMcapUsd: number | null; lastSellMcapUsd: number | null; nowMcapUsd: number | null; stillHeld: boolean }> };
}
export type DeskAction = 'select-mode' | 'start-test' | 'stop-test' | 'start-live' | 'pause' | 'resume' | 'stop-live' | 'probe' | 'drill-on' | 'drill-off' | 'strategy-save' | 'strategy-delete' | 'watch-add' | 'watch-remove' | 'watch-rearm' |
  'strategy' | 'reset-test' | 'exit';
interface Session { id: string; address: string }
const message = (error: unknown) => error instanceof Error ? error.message : 'Local service unavailable';

export function useTradingSession() {
  const [view, setView] = useState<TradingView | null>(null), [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false), [auto, setAuto] = useState(false), [revision, setRevision] = useState(0);
  const [autoUnsupported, setAutoUnsupported] = useState(false);
  const sessionRef = useRef<Session | null>(null), cap = useRef<string | null>(null), sdk = useRef<BrowserSDK | null>(null);
  const generation = useRef(0), signing = useRef(false), autoRef = useRef(false), seen = useRef(new Set<string>());
  const getCapability = useCallback(async () => {
    if (cap.current) return cap.current;
    const r = await fetch('/api/trading/bootstrap', { cache: 'no-store', credentials: 'same-origin' }), body = await r.json();
    if (!r.ok || typeof body.capability !== 'string') throw new Error('Local trading service unavailable');
    cap.current = body.capability; return body.capability as string;
  }, []);
  const post = useCallback(async (action: string, body: Record<string, unknown>) => {
    const token = await getCapability();
    const r = await fetch(`/api/trading/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Local-Capability': token }, body: JSON.stringify(body) });
    const result = await r.json(); if (!r.ok) { if (r.status === 403) cap.current = null; throw new Error(result.detail ? `${result.message}: ${result.detail}` : result.message ?? 'Request rejected'); }
    return result;
  }, [getCapability]);
  const invalidate = useCallback((why: string | null) => {
    generation.current++; autoRef.current = false; setAuto(false);
    const previous = sessionRef.current; sessionRef.current = null; setSession(null); setError(why);
    if (previous) void post('disconnect', { sessionId: previous.id }).catch(() => {});
    void sdk.current?.disableAutoConfirm().catch(() => {});
  }, [post]);
  useEffect(() => {
    const provider = phantomProvider();
    const changed: PhantomListener = key => { if (sessionRef.current && key?.toString() !== sessionRef.current.address) invalidate('Wallet changed. Connect again.'); };
    const disconnected = () => invalidate('Phantom disconnected. LIVE session stopped.');
    provider?.on('accountChanged', changed); provider?.on('disconnect', disconnected);
    return () => { provider?.removeListener('accountChanged', changed); provider?.removeListener('disconnect', disconnected); };
  }, [invalidate, session]);
  useEffect(() => {
    // Polling (and with it the LIVE heartbeat) runs in a worker: hidden tabs throttle page timers to about once a minute.
    let active = true;
    const worker = new Worker(new URL('./poll-worker.ts', import.meta.url), { type: 'module' });
    const configure = async () => {
      const capability = session ? await getCapability() : null;
      if (active) worker.postMessage({ sessionId: session?.id ?? null, capability, intervalMs: session ? 1500 : 2500 } satisfies PollConfig);
    };
    worker.onmessage = (e: MessageEvent<PollResult>) => {
      if (!active) return;
      const r = e.data;
      if (r.ok) {
        const body = r.body as TradingView;
        setView(body); setOnline(true);
        if (session && (!body.session || body.session.expiresAt <= Date.now())) invalidate('Session expired. Reconnect Phantom.');
        return;
      }
      if (session && ['WALLET_SESSION_MISMATCH', 'WALLET_SESSION_EXPIRED'].includes(r.message)) invalidate('Session expired. Reconnect Phantom.');
      if (r.status === 403) { cap.current = null; void configure().catch(e2 => setError(message(e2))); }
      setOnline(false); setError(r.message);
    };
    void configure().catch(e => { if (active) { setOnline(false); setError(message(e)); } });
    return () => { active = false; worker.terminate(); };
  }, [session, revision, getCapability, invalidate]);
  const connect = async () => {
    if (!phantomProvider()?.isPhantom) { setError('Open localhost in the browser with your Phantom extension.'); return; }
    setBusy('connect'); setError(null); const attempt = ++generation.current;
    try {
      const { BrowserSDK, AddressType } = await import('@phantom/browser-sdk');
      sdk.current ??= new BrowserSDK({ providers: ['injected'], addressTypes: [AddressType.solana] });
      await sdk.current.connect({ provider: 'injected' });
      const address = sdk.current.solana.publicKey;
      if (!address || generation.current !== attempt) throw new Error('Wallet connection changed');
      const result = await post('connect', { address });
      if (generation.current !== attempt || phantomProvider()?.publicKey?.toString() !== address) { await post('disconnect', { sessionId: result.sessionId }); throw new Error('Wallet changed'); }
      const next = { id: result.sessionId as string, address }; sessionRef.current = next; setSession(next);
      autoRef.current = false; setAuto(false); seen.current.clear(); setRevision(v => v + 1);
    } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };
  /** Strategy chat with Claude; the caller shows its own progress and errors (it can take a minute). */
  const ask = (messages: Array<{ role: 'user' | 'assistant'; content: string }>, wallet: string | null): Promise<AssistantAnswer> =>
    post('assistant', { messages, ...(wallet ? { wallet } : {}) }) as Promise<AssistantAnswer>;
  /** Resolves true when the desk accepted the action. */
  const desk = async (action: DeskAction, extra: Record<string, unknown> = {}): Promise<boolean> => {
    // Stopping ends auto-signing even if the request itself fails. Pause only stops entries: exits must stay signable.
    if (action === 'stop-live' || action === 'stop-test') { autoRef.current = false; setAuto(false); generation.current++; }
    setBusy(action); setError(null);
    try { await post('desk', { action, ...extra, ...(sessionRef.current ? { sessionId: sessionRef.current.id } : {}) }); setRevision(v => v + 1); return true; }
    catch (e) { setError(message(e)); return false; }
    finally { setBusy(null); if (action === 'stop-live') void sdk.current?.disableAutoConfirm().catch(() => {}); }
  };
  const enableAuto = async () => {
    if (!sdk.current || !sessionRef.current || autoUnsupported) return; setBusy('auto'); setError(null);
    const attempt = generation.current, current = sessionRef.current;
    try {
      const { NetworkId } = await import('@phantom/browser-sdk');
      const result = await sdk.current.enableAutoConfirm({ chains: [NetworkId.SOLANA_MAINNET] });
      if (attempt !== generation.current || sessionRef.current?.id !== current.id) { await sdk.current.disableAutoConfirm(); return; }
      const enabled = result.enabled && result.chains.includes(NetworkId.SOLANA_MAINNET);
      autoRef.current = enabled; setAuto(enabled); if (!enabled) throw new Error('Phantom did not enable Auto-Confirm. Manual approval remains available.');
    } catch (e) {
      autoRef.current = false; setAuto(false);
      // Phantom offers Auto-Confirm only to domains it has approved; a local dashboard is not one of them.
      if (/no supported networks/i.test(message(e))) { setAutoUnsupported(true); setError('AUTO_CONFIRM_UNAVAILABLE_FOR_DOMAIN'); }
      else setError(message(e));
    } finally { setBusy(null); }
  };
  const liveExecuting = view?.mode === 'LIVE' && !!view.desk?.scanner && !!view.desk?.execution;
  const approve = useCallback(async (automatic = false) => {
    const current = sessionRef.current, pending = view?.pending, client = sdk.current, attempt = generation.current;
    if (signing.current || !current || !pending || !client || !liveExecuting || pending.expiresAt <= Date.now()) return;
    if (automatic && (!autoRef.current || seen.current.has(pending.id))) return;
    signing.current = true; seen.current.add(pending.id); setBusy('sign'); setError(null);
    try {
      if (automatic) {
        const { NetworkId } = await import('@phantom/browser-sdk'); const permission = await client.getAutoConfirmStatus();
        if (!autoRef.current || !permission.enabled || !permission.chains.includes(NetworkId.SOLANA_MAINNET)) throw new Error('Auto-Confirm permission expired.');
      }
      if (attempt !== generation.current || phantomProvider()?.publicKey?.toString() !== current.address) throw new Error('Wallet changed or session stopped');
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(pending.transactionBase64), c => c.charCodeAt(0)));
      if (tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== current.address) throw new Error('Unexpected transaction signer');
      const original = tx.message.serialize(), signed = await client.solana.signTransaction(tx);
      if (!('message' in signed)) throw new Error('Unexpected transaction format');
      const bytes = signed.message.serialize();
      if (bytes.length !== original.length || bytes.some((b, i) => b !== original[i])) throw new Error('Transaction changed during signing');
      if (attempt !== generation.current || sessionRef.current?.id !== current.id || phantomProvider()?.publicKey?.toString() !== current.address || pending.expiresAt <= Date.now())
        throw new Error('Request expired or stopped. Signature was not submitted.');
      let binary = ''; for (const byte of signed.serialize()) binary += String.fromCharCode(byte);
      await post('signed', { sessionId: current.id, requestId: pending.id, transactionBase64: btoa(binary) }); setRevision(v => v + 1);
    } catch (e) {
      setError(message(e)); autoRef.current = false; setAuto(false);
      await post('reject', { sessionId: current.id, requestId: pending.id }).catch(() => {});
      await post('desk', { action: 'pause', sessionId: current.id }).catch(() => {}); void client.disableAutoConfirm().catch(() => {});
    } finally { signing.current = false; setBusy(null); }
  }, [view, post, liveExecuting]);
  useEffect(() => { if (auto && liveExecuting && view?.pending) void approve(true); }, [auto, view, approve, liveExecuting]);
  return { view, address: session?.address ?? null, connected: !!session, online, busy, error, auto, autoUnsupported, connect, desk, ask, enableAuto,
    approve: () => approve(false), disconnect: async () => { invalidate(null); try { await sdk.current?.disconnect(); } catch (e) { setError(message(e)); } } };
}
export type TradingSession = ReturnType<typeof useTradingSession>;

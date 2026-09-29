import { useCallback, useEffect, useRef, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { phantomProvider, type PhantomListener } from './phantom';
import type { DeskMode, DeskStatus } from '../../src/desk/types';
import type { BrowserSDK } from '@phantom/browser-sdk';

export interface TradingView {
  session: { address: string; expiresAt: number } | null;
  pending: { id: string; transactionBase64: string; expiresAt: number } | null;
  mode: DeskMode; desk: DeskStatus | null; deskError: string | null;
}
export type DeskAction = 'select-mode' | 'start-test' | 'stop-test' | 'start-live' | 'pause' | 'resume' | 'stop-live' | 'probe';
interface Session { id: string; address: string }
const message = (error: unknown) => error instanceof Error ? error.message : 'Local service unavailable';

export function useTradingSession() {
  const [view, setView] = useState<TradingView | null>(null), [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false), [auto, setAuto] = useState(false), [revision, setRevision] = useState(0);
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
    const result = await r.json(); if (!r.ok) { if (r.status === 403) cap.current = null; throw new Error(result.message ?? 'Request rejected'); }
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
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController;
    const poll = async () => {
      controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const token = session ? await getCapability() : null;
        const r = await fetch('/api/trading', { cache: 'no-store', signal: controller.signal,
          headers: session ? { 'X-Local-Capability': token!, 'X-Wallet-Session': session.id } : undefined });
        const body = await r.json();
        if (!r.ok) {
          if (active && session && ['WALLET_SESSION_MISMATCH', 'WALLET_SESSION_EXPIRED'].includes(body.message)) invalidate('Session expired. Reconnect Phantom.');
          throw new Error(body.message ?? 'Trading status unavailable');
        }
        if (active) { setView(body); setOnline(true); if (session && (!body.session || body.session.expiresAt <= Date.now())) invalidate('Session expired. Reconnect Phantom.'); }
      } catch (e) { if (active) { setOnline(false); setError(message(e)); } }
      finally { clearTimeout(timeout); if (active) timer = setTimeout(() => void poll(), session ? 1500 : 2500); }
    };
    void poll(); return () => { active = false; controller?.abort(); clearTimeout(timer); };
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
  const desk = async (action: DeskAction, extra: Record<string, unknown> = {}) => {
    // Local cancellation stops auto-signing even if the request itself fails.
    if (action === 'pause' || action === 'stop-live' || action === 'stop-test') { autoRef.current = false; setAuto(false); generation.current++; }
    setBusy(action); setError(null);
    try { await post('desk', { action, ...extra, ...(sessionRef.current ? { sessionId: sessionRef.current.id } : {}) }); setRevision(v => v + 1); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); if (action === 'pause' || action === 'stop-live') void sdk.current?.disableAutoConfirm().catch(() => {}); }
  };
  const enableAuto = async () => {
    if (!sdk.current || !sessionRef.current) return; setBusy('auto'); setError(null);
    const attempt = generation.current, current = sessionRef.current;
    try {
      const { NetworkId } = await import('@phantom/browser-sdk');
      const result = await sdk.current.enableAutoConfirm({ chains: [NetworkId.SOLANA_MAINNET] });
      if (attempt !== generation.current || sessionRef.current?.id !== current.id) { await sdk.current.disableAutoConfirm(); return; }
      const enabled = result.enabled && result.chains.includes(NetworkId.SOLANA_MAINNET);
      autoRef.current = enabled; setAuto(enabled); if (!enabled) throw new Error('Phantom did not enable Auto-Confirm. Manual approval remains available.');
    } catch (e) { autoRef.current = false; setAuto(false); setError(message(e)); } finally { setBusy(null); }
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
  return { view, address: session?.address ?? null, connected: !!session, online, busy, error, auto, connect, desk, enableAuto,
    approve: () => approve(false), disconnect: async () => { invalidate(null); try { await sdk.current?.disconnect(); } catch (e) { setError(message(e)); } } };
}
export type TradingSession = ReturnType<typeof useTradingSession>;

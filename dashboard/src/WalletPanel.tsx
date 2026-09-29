import { useEffect, useState } from 'react';
import type { WalletBalance } from '../../src/data/wallet-monitor';
import { money, numeric, short, time } from './format';

type Key = { toString():string };
type Listener = (key?:Key|null)=>void;
interface PhantomProvider {
  isPhantom?:boolean; isConnected?:boolean; publicKey?:Key|null;
  connect(options?:{onlyIfTrusted:boolean}):Promise<{publicKey:Key}>;
  disconnect():Promise<void>;
  on(event:string,callback:Listener):void;
  removeListener(event:string,callback:Listener):void;
}
declare global { interface Window { phantom?:{solana?:PhantomProvider} } }
interface WalletResponse { balance:WalletBalance|null; configuredAddress?:string|null; plannedStartUsd?:number|null; message?:string|null }

export function WalletPanel() {
  const [address,setAddress]=useState<string|null>(null);
  const [connected,setConnected]=useState(false);
  const [data,setData]=useState<WalletResponse|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [connectionError,setConnectionError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    const provider=window.phantom?.solana;
    if(!provider?.isPhantom)return;
    let active=true;
    const changed:Listener=key=>{
      if(!active)return;
      setAddress(key?.toString()??null);setConnected(!!key);setData(null);setConnectionError(null);
    };
    const onConnect:Listener=key=>changed(key??provider.publicKey);
    const disconnected=()=>changed(null);
    provider.on('accountChanged',changed);provider.on('connect',onConnect);provider.on('disconnect',disconnected);
    if(provider.isConnected&&provider.publicKey)changed(provider.publicKey);
    else void provider.connect({onlyIfTrusted:true}).then(result=>changed(result.publicKey)).catch(()=>{});
    return ()=>{active=false;provider.removeListener('accountChanged',changed);provider.removeListener('connect',onConnect);provider.removeListener('disconnect',disconnected);};
  },[]);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    let controller:AbortController|undefined;
    setData(null);setError(null);
    const poll=async()=>{
      controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),25000);
      try {
        const response=await fetch(`/api/wallet${address?`?address=${encodeURIComponent(address)}`:''}`,{signal:controller.signal,cache:'no-store'});
        const next:WalletResponse=await response.json();
        if(!response.ok)throw new Error(next.message??'Wallet data unavailable.');
        if(active){setData(next);setError(null);}
      } catch(problem) {
        if(active){setData(null);setError(problem instanceof Error&&problem.name!=='AbortError'?problem.message:'Wallet request timed out.');}
      } finally {
        clearTimeout(timeout);if(active)timer=setTimeout(()=>void poll(),15000);
      }
    };
    void poll();
    return ()=>{active=false;controller?.abort();if(timer)clearTimeout(timer);};
  },[address]);
  const connect=async()=>{
    const provider=window.phantom?.solana;
    if(!provider?.isPhantom){setConnectionError('Open this dashboard in the browser with the Phantom extension.');return;}
    setBusy(true);setConnectionError(null);
    try {
      const result=await provider.connect();setAddress(result.publicKey.toString());setConnected(true);
    } catch {setConnectionError('Phantom connection was not approved.');}
    finally {setBusy(false);}
  };
  const disconnect=async()=>{
    try {await window.phantom?.solana?.disconnect();setAddress(null);setConnected(false);}
    catch {setConnectionError('Could not disconnect Phantom.');}
  };
  const balance=data?.balance,shownAddress=address??balance?.address??data?.configuredAddress;
  return <section className="wallet-panel" aria-label="Actual Solana wallet balance">
    <div className="wallet-heading">
      <div><h2>{connected?'Phantom wallet':'Wallet balance'} <span>Solana · read only</span></h2>
        <p title={shownAddress??undefined}>{shownAddress?short(shownAddress):'Select a wallet'} · {connected?'Connected with Phantom':'Configured public address'}</p></div>
      <div className="wallet-actions">
        <button className="source-button" onClick={()=>void connect()} disabled={busy}>{busy?'Connecting…':connected?'Phantom connected':'Connect Phantom'}</button>
        {connected&&<button className="source-button" onClick={()=>void disconnect()}>Disconnect</button>}
      </div>
    </div>
    <div className="wallet-values">
      <div><span>Native SOL</span><strong>{balance?numeric(balance.nativeSol,9):'--'} SOL</strong><small>{money(balance?.nativeUsd)}</small></div>
      <div><span>{balance?.totalValueUsd==null?'Priced assets · subtotal':'Wallet value · estimated'}</span><strong>{money(balance?.totalValueUsd??balance?.pricedValueUsd)}</strong><small>RPC balances · market prices</small></div>
      <div><span>Planned starting capital</span><strong>{money(data?.plannedStartUsd)}</strong><small>Planning value · separate from balance</small></div>
    </div>
    {balance&&<details className="wallet-tokens"><summary>Token balances ({balance.tokens.length})</summary>
      <div className="wallet-table"><table><thead><tr><th>Token</th><th>Amount</th><th>Estimated USD</th></tr></thead><tbody>
        {balance.tokens.map(t=><tr key={t.mint}><td title={t.mint}>{t.symbol||short(t.mint)}</td><td>{t.amount}</td><td>{money(t.valueUsd)}</td></tr>)}
        {!balance.tokens.length&&<tr><td colSpan={3}>No funded SPL token accounts found.</td></tr>}
      </tbody></table></div>
    </details>}
    <p className="wallet-status" role="status">{error??connectionError??data?.message??(balance?`Updated ${time(balance.observedAt)} · refreshes every 15 seconds`:'Reading wallet…')}
      {balance&&(!balance.tokensComplete||balance.unpricedTokenCount>0)&&` · Partial valuation: ${balance.unpricedTokenCount} token(s) without a price${!balance.tokensComplete?'; token RPC incomplete':''}.`}
    </p>
  </section>;
}

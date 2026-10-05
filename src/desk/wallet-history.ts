import { PublicKey, type Connection } from '@solana/web3.js';
import { SOL_MINT, USDC_MINT } from '../core/types';
import type { DexScreenerClient } from '../data/dexscreener';
import { selectPair } from './discovery';

/**
 * A wallet's recent swaps read from the chain, for the strategy assistant ("learn from my trades"): which tokens were
 * bought and sold, when, for how much, and at roughly which market cap. Market caps are estimates: the trade's price
 * times the token's current supply, with SOL valued at today's price.
 */
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', DUST_USD = 1;
export interface WalletTrade { signature: string; at: number | null; mint: string; side: 'BUY' | 'SELL'; tokens: number; valueUsd: number; priceUsd: number; marketCapUsd: number | null }
export interface TokenHistory {
  mint: string; symbol: string | null; trades: WalletTrade[]; boughtUsd: number; soldUsd: number;
  firstBuyMcapUsd: number | null; lastSellMcapUsd: number | null; nowMcapUsd: number | null; stillHeld: boolean;
}
export interface WalletHistory { wallet: string; scanned: number; trades: number; tokens: TokenHistory[]; note: string }

interface RawBalance { mint: string; owner?: string; accountIndex: number; uiTokenAmount: { amount: string; decimals: number } }
interface RawTx {
  blockTime?: number | null;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: RawBalance[] | null; postTokenBalances?: RawBalance[] | null } | null;
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
}

/** One swap of `wallet` in a transaction: exactly one token changed against SOL/WSOL, USDC or USDT moving the other way. */
export function swapOf(tx: RawTx, wallet: string, signature: string, solUsd: number): Omit<WalletTrade, 'marketCapUsd'> | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey), i = keys.indexOf(wallet);
  const delta = new Map<string, { raw: bigint; decimals: number }>();
  const add = (b: RawBalance, sign: 1n | -1n) => {
    if (b.owner !== wallet) return;
    const d = delta.get(b.mint) ?? { raw: 0n, decimals: b.uiTokenAmount.decimals };
    d.raw += sign * BigInt(b.uiTokenAmount.amount); delta.set(b.mint, d);
  };
  for (const b of tx.meta.preTokenBalances ?? []) add(b, -1n);
  for (const b of tx.meta.postTokenBalances ?? []) add(b, 1n);
  // The fee payer (index 0) also paid the network fee; it is not part of the trade.
  const lamports = (i >= 0 ? BigInt(tx.meta.postBalances[i]! - tx.meta.preBalances[i]! + (i === 0 ? tx.meta.fee : 0)) : 0n) + (delta.get(SOL_MINT)?.raw ?? 0n);
  const quoteUsd = Number(lamports) / 1e9 * solUsd + [USDC_MINT, USDT_MINT].reduce((a, m) => a + Number(delta.get(m)?.raw ?? 0n) / 1e6, 0);
  const tokens = [...delta].filter(([m, d]) => ![SOL_MINT, USDC_MINT, USDT_MINT].includes(m) && d.raw !== 0n);
  if (tokens.length !== 1) return null;
  const [mint, d] = tokens[0]!, amount = Number(d.raw) / 10 ** d.decimals, side = d.raw > 0n ? 'BUY' : 'SELL';
  // A buy pays the quote asset, a sell receives it; anything else (or dust such as account rent) is a transfer, airdrop or LP move.
  if ((side === 'BUY' && quoteUsd > -DUST_USD) || (side === 'SELL' && quoteUsd < DUST_USD)) return null;
  const valueUsd = Math.abs(quoteUsd), tokensAbs = Math.abs(amount);
  return { signature, at: tx.blockTime ? tx.blockTime * 1000 : null, mint, side, tokens: tokensAbs, valueUsd, priceUsd: valueUsd / tokensAbs };
}

export async function walletHistory(o: {
  wallet: string; solUsd: number; limit?: number; maxTokens?: number;
  rpc: { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> };
  dex: Pick<DexScreenerClient, 'getPairsForTokens'>;
}): Promise<WalletHistory> {
  const owner = new PublicKey(o.wallet), limit = o.limit ?? 60, maxTokens = o.maxTokens ?? 20;
  const sigs = (await o.rpc.execute('wallet-history:signatures', c => c.getSignaturesForAddress(owner, { limit }, 'confirmed'))).filter(s => !s.err);
  const trades: Array<Omit<WalletTrade, 'marketCapUsd'>> = [];
  for (const s of sigs) {
    try {
      const tx = await o.rpc.execute('wallet-history:tx', async c => {
        const rpc = c as unknown as { _rpcRequest(method: string, args: unknown[]): Promise<{ result?: RawTx | null; error?: { message: string } }> };
        const res = await rpc._rpcRequest('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (res.error) throw new Error(res.error.message);
        return res.result ?? null;
      });
      const t = tx ? swapOf(tx, o.wallet, s.signature, o.solUsd) : null;
      if (t) trades.push(t);
    } catch { /* one unreadable transaction never hides the rest */ }
  }
  const mints = [...new Set(trades.map(t => t.mint))].slice(0, maxTokens);
  const supply = new Map<string, number>();
  for (const m of mints) {
    try { const r = await o.rpc.execute('wallet-history:supply', c => c.getTokenSupply(new PublicKey(m), 'confirmed')); supply.set(m, Number(r.value.amount) / 10 ** r.value.decimals); }
    catch { /* market cap stays unknown */ }
  }
  const pairs = mints.length ? await o.dex.getPairsForTokens(mints).catch(() => []) : [];
  const tokens: TokenHistory[] = mints.map(mint => {
    const list = trades.filter(t => t.mint === mint).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      .map(t => ({ ...t, marketCapUsd: supply.has(mint) ? t.priceUsd * supply.get(mint)! : null }));
    const pair = selectPair(pairs, mint, Date.now()), net = list.reduce((a, t) => a + (t.side === 'BUY' ? t.tokens : -t.tokens), 0);
    return { mint, symbol: pair?.baseToken.symbol ?? null, trades: list,
      boughtUsd: list.filter(t => t.side === 'BUY').reduce((a, t) => a + t.valueUsd, 0), soldUsd: list.filter(t => t.side === 'SELL').reduce((a, t) => a + t.valueUsd, 0),
      firstBuyMcapUsd: list.find(t => t.side === 'BUY')?.marketCapUsd ?? null, lastSellMcapUsd: list.filter(t => t.side === 'SELL').at(-1)?.marketCapUsd ?? null,
      nowMcapUsd: pair?.marketCap ?? pair?.fdv ?? null, stillHeld: net > 0 };
  });
  return { wallet: o.wallet, scanned: sigs.length, trades: trades.length, tokens,
    note: `Last ${sigs.length} transactions; market caps estimated from each trade's price × current supply, SOL at today's $${o.solUsd.toFixed(2)}.` };
}

const k = (n: number | null) => n === null ? '?' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
/** Compact text for the assistant: one block per token, oldest trade first. */
export function historyText(h: WalletHistory): string {
  if (!h.tokens.length) return `Wallet ${h.wallet}: no token swaps found in the last ${h.scanned} transactions.`;
  return [`Wallet ${h.wallet} — ${h.trades} swaps in ${h.tokens.length} tokens. ${h.note}`, ...h.tokens.map(t => {
    const pnl = t.soldUsd - t.boughtUsd;
    return `${t.symbol ?? t.mint.slice(0, 6)} (${t.mint}): bought $${t.boughtUsd.toFixed(0)}, sold $${t.soldUsd.toFixed(0)}${t.stillHeld ? ' (still held)' : ''}, realized ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}; ` +
      `first buy at ${k(t.firstBuyMcapUsd)}, last sell at ${k(t.lastSellMcapUsd)}, now ${k(t.nowMcapUsd)}\n` +
      t.trades.map(x => `  ${x.at ? new Date(x.at).toISOString().slice(0, 16).replace('T', ' ') : '?'} ${x.side} $${x.valueUsd.toFixed(0)} at ${k(x.marketCapUsd)}`).join('\n');
  })].join('\n');
}

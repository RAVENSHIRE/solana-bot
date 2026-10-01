import fs from 'node:fs/promises';
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { z } from 'zod';
import type { DexScreenerClient } from '../data/dexscreener';
import { atomicWriteFile } from '../utils/fs';
import { errorMessage } from '../utils/errors';
import { pairMetrics, selectPair } from './discovery';

/**
 * Watch: exit rules for tokens you hold yourself (bought on FOMO, in Phantom, anywhere), independent of the desk's
 * strategies and running whenever the dashboard runs, with the desk started or not.
 *
 * Each rule watches one token in one wallet: a market-cap floor, a trailing stop from the highest market cap seen
 * since the rule was added, and a market-cap target. A condition must hold in two consecutive checks before it
 * triggers, so one bad data point never sells. A triggered rule alerts (dashboard, browser, and optionally ntfy or
 * Telegram on your phone) and, when its action is SELL and the wallet is the desk's local-key wallet, sells the
 * wallet's whole balance through the desk's guarded LIVE sell path. A rule triggers once; re-arm it to watch again.
 */
export const WATCH = Object.freeze({ checkMs: 15_000, balanceMs: 60_000, confirmations: 2, maxRules: 50, maxAlerts: 100 });

const address = z.string().trim().refine(v => { try { return new PublicKey(v).toBase58() === v; } catch { return false; } }, 'not a Solana address');
export const watchInputSchema = z.object({
  mint: address, wallet: address,
  trailingStopPct: z.number().finite().positive().max(95).nullable().default(null),
  marketCapFloorUsd: z.number().finite().positive().nullable().default(null),
  marketCapTargetUsd: z.number().finite().positive().nullable().default(null),
  action: z.enum(['ALERT', 'SELL']).default('ALERT'),
  note: z.string().trim().max(200).default(''),
}).strict().superRefine((r, ctx) => {
  if (r.trailingStopPct === null && r.marketCapFloorUsd === null && r.marketCapTargetUsd === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set a floor, a target or a trailing stop', path: ['marketCapFloorUsd'] });
  if (r.marketCapFloorUsd !== null && r.marketCapTargetUsd !== null && r.marketCapFloorUsd >= r.marketCapTargetUsd)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'floor must be below the target', path: ['marketCapFloorUsd'] });
});
export type WatchInput = z.input<typeof watchInputSchema>;

export interface WatchRule extends z.infer<typeof watchInputSchema> {
  id: string; symbol: string | null; createdAt: number;
  /** Highest market cap seen since the rule was added (or re-armed): the trailing stop's reference. */
  peakMarketCapUsd: number | null; peakAt: number | null;
  lastMarketCapUsd: number | null; lastPriceUsd: number | null; checkedAt: number | null;
  /** Wallet balance of the token (raw units) and when it was read; null until the first read. */
  balanceRaw: string | null; decimals: number | null; balanceAt: number | null;
  /** The condition seen in the last check (a trigger needs it twice in a row). */
  pending: { reason: string; count: number } | null;
  lastError: string | null;
  triggered: null | { at: number; reason: string; outcome: 'ALERTED' | 'SELLING' | 'SOLD' | 'SELL_FAILED' | 'ALERT_ONLY'; detail: string; signature: string | null };
}
export interface WatchAlert { at: number; ruleId: string; mint: string; symbol: string | null; title: string; body: string }
export interface WatchView {
  rules: WatchRule[]; alerts: WatchAlert[];
  /** The wallet SELL rules may act on (the local key), or null: then every rule only alerts. */
  sellWallet: string | null; channels: string[];
}

export interface WatchSell { mint: string; symbol: string | null; amountRaw: bigint; decimals: number; reason: string; onSigned: (signature: string) => Promise<void> }
export interface WatchDeps {
  file: string;
  dex: Pick<DexScreenerClient, 'getPairsForTokens'>;
  /** Raw token balance (all accounts of the owner for the mint) and the mint's decimals. */
  balance: (wallet: string, mint: string) => Promise<{ raw: bigint; decimals: number | null }>;
  notify: (title: string, body: string) => Promise<void>;
  channels: string[];
  /** LIVE with the local key only: sells through the desk's guarded path; resolves to the signature. */
  sell: ((s: WatchSell) => Promise<{ signature: string; detail: string }>) | null;
  sellWallet: string | null;
  clock?: () => number;
}

const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;

/** The exit condition met by this market cap, if any: floor first (protects), then the trailing stop, then the target. */
export function watchReason(r: Pick<WatchRule, 'marketCapFloorUsd' | 'marketCapTargetUsd' | 'trailingStopPct' | 'peakMarketCapUsd'>, cap: number): string | null {
  if (r.marketCapFloorUsd !== null && cap <= r.marketCapFloorUsd) return `MCAP_FLOOR ${usd(cap)} ≤ ${usd(r.marketCapFloorUsd)}`;
  if (r.trailingStopPct !== null && r.peakMarketCapUsd !== null && cap <= r.peakMarketCapUsd * (1 - r.trailingStopPct / 100))
    return `TRAILING_STOP ${usd(cap)} is ${((1 - cap / r.peakMarketCapUsd) * 100).toFixed(1)}% below the peak ${usd(r.peakMarketCapUsd)} (stop ${r.trailingStopPct}%)`;
  if (r.marketCapTargetUsd !== null && cap >= r.marketCapTargetUsd) return `MCAP_TARGET ${usd(cap)} ≥ ${usd(r.marketCapTargetUsd)}`;
  return null;
}

export class HoldingsWatch {
  private rules: WatchRule[] = [];
  private alerts: WatchAlert[] = [];
  private running: Promise<void> | null = null;
  private lastCheckAt = 0;
  private constructor(private readonly d: WatchDeps) {}

  static async open(d: WatchDeps): Promise<HoldingsWatch> {
    const w = new HoldingsWatch(d);
    try {
      const saved = JSON.parse(await fs.readFile(d.file, 'utf8')) as { rules?: WatchRule[]; alerts?: WatchAlert[] };
      w.rules = Array.isArray(saved.rules) ? saved.rules.filter(r => watchInputSchema.safeParse(pick(r)).success) : [];
      w.alerts = Array.isArray(saved.alerts) ? saved.alerts.slice(-WATCH.maxAlerts) : [];
      // A sale interrupted by a restart is never retried blindly: its outcome must be checked on-chain.
      for (const r of w.rules) if (r.triggered?.outcome === 'SELLING')
        r.triggered = { ...r.triggered, outcome: 'SELL_FAILED', detail: `Interrupted by a restart${r.triggered.signature ? `; check ${r.triggered.signature} on Solscan` : ''}` };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return w;
  }
  private get now(): number { return (this.d.clock ?? Date.now)(); }

  add(input: unknown): WatchRule {
    const parsed = watchInputSchema.safeParse(input);
    if (!parsed.success) { const i = parsed.error.issues[0]!; throw new Error(`INVALID_WATCH: ${i.path.join('.')}${i.path.length ? ': ' : ''}${i.message}`); }
    const r = parsed.data;
    if (r.action === 'SELL' && r.wallet !== this.d.sellWallet) throw new Error('WATCH_SELL_NEEDS_LOCAL_KEY');
    const id = `${r.mint.slice(0, 8)}-${r.wallet.slice(0, 6)}`;
    if (!this.rules.some(x => x.id === id) && this.rules.length >= WATCH.maxRules) throw new Error('WATCH_LIMIT');
    const old = this.rules.find(x => x.id === id);
    const rule: WatchRule = { ...r, id, symbol: old?.symbol ?? null, createdAt: this.now, peakMarketCapUsd: old?.lastMarketCapUsd ?? null, peakAt: old?.lastMarketCapUsd ? this.now : null,
      lastMarketCapUsd: old?.lastMarketCapUsd ?? null, lastPriceUsd: old?.lastPriceUsd ?? null, checkedAt: old?.checkedAt ?? null,
      balanceRaw: old?.balanceRaw ?? null, decimals: old?.decimals ?? null, balanceAt: old?.balanceAt ?? null, pending: null, lastError: null, triggered: null };
    this.rules = [...this.rules.filter(x => x.id !== id), rule];
    this.lastCheckAt = 0; void this.save();
    return rule;
  }
  remove(id: string): void { this.rules = this.rules.filter(r => r.id !== id); void this.save(); }
  /** Watches again after a trigger; the trailing stop's peak restarts at the current market cap. */
  rearm(id: string): void {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error('WATCH_NOT_FOUND');
    if (r.triggered?.outcome === 'SELLING') throw new Error('WATCH_SELL_IN_PROGRESS');
    Object.assign(r, { triggered: null, pending: null, peakMarketCapUsd: r.lastMarketCapUsd, peakAt: r.lastMarketCapUsd ? this.now : null, createdAt: this.now });
    this.lastCheckAt = 0; void this.save();
  }
  view(): WatchView { return { rules: this.rules.map(r => ({ ...r })), alerts: [...this.alerts].reverse(), sellWallet: this.d.sellWallet, channels: this.d.channels }; }

  /** Called every second by the host; a check runs every WATCH.checkMs. */
  tick(): void {
    if (this.running || this.now - this.lastCheckAt < WATCH.checkMs || !this.rules.some(r => !r.triggered)) return;
    this.lastCheckAt = this.now;
    this.running = this.check().catch(() => undefined).finally(() => { this.running = null; });
  }
  async settled(): Promise<void> { await this.running; }

  async check(): Promise<void> {
    const active = this.rules.filter(r => !r.triggered), now = this.now;
    if (!active.length) return;
    let pairs: Awaited<ReturnType<WatchDeps['dex']['getPairsForTokens']>> = [];
    try { pairs = await this.d.dex.getPairsForTokens([...new Set(active.map(r => r.mint))]); }
    catch (error) { for (const r of active) r.lastError = `market data unavailable: ${errorMessage(error)}`; await this.save(); return; }
    for (const r of active) {
      if (now - (r.balanceAt ?? 0) >= WATCH.balanceMs) {
        try { const b = await this.d.balance(r.wallet, r.mint); r.balanceRaw = String(b.raw); r.decimals = b.decimals ?? r.decimals; r.balanceAt = now; }
        catch (error) { r.lastError = `balance unavailable: ${errorMessage(error)}`; }
      }
      const pair = selectPair(pairs, r.mint, now);
      const cap = pair ? pairMetrics(pair, now).marketCapUsd : null;
      if (!pair || cap === null) { r.lastError = 'no fresh market cap (DexScreener)'; r.pending = null; continue; }
      r.symbol = pair.baseToken.symbol ?? r.symbol; r.lastMarketCapUsd = cap; r.lastPriceUsd = pair.priceUsd; r.checkedAt = now; r.lastError = null;
      if (r.peakMarketCapUsd === null || cap > r.peakMarketCapUsd) { r.peakMarketCapUsd = cap; r.peakAt = now; }
      const reason = watchReason(r, cap);
      if (!reason) { r.pending = null; continue; }
      const kind = reason.split(' ')[0]!;
      r.pending = r.pending && r.pending.reason.split(' ')[0] === kind ? { reason, count: r.pending.count + 1 } : { reason, count: 1 };
      if (r.pending.count >= WATCH.confirmations) await this.trigger(r, reason);
    }
    await this.save();
  }

  private async trigger(r: WatchRule, reason: string): Promise<void> {
    const name = r.symbol ?? `${r.mint.slice(0, 6)}…`, held = r.balanceRaw === null ? null : BigInt(r.balanceRaw);
    r.pending = null;
    if (held === 0n) { r.triggered = { at: this.now, reason, outcome: 'ALERT_ONLY', detail: 'The wallet holds none of this token (already sold?)', signature: null }; return; }
    const canSell = r.action === 'SELL' && !!this.d.sell && r.wallet === this.d.sellWallet && held !== null && r.decimals !== null;
    r.triggered = { at: this.now, reason, outcome: canSell ? 'SELLING' : r.action === 'SELL' ? 'ALERT_ONLY' : 'ALERTED', signature: null,
      detail: canSell ? 'Selling the whole balance' : r.action === 'SELL' ? 'SELL needs the local key (DESK_LIVE_SIGNER=local-key) and a known balance: alert only' : 'Alert only' };
    await this.alert(r, `${name}: ${reason.split(' ')[0]!.replace('_', ' ')}`, `${reason}${canSell ? ' — selling now.' : ' — sell it in your wallet.'}${r.note ? ` Note: ${r.note}` : ''}`);
    if (!canSell) { await this.save(); return; }
    await this.save();
    try {
      const sold = await this.d.sell!({ mint: r.mint, symbol: r.symbol, amountRaw: held!, decimals: r.decimals!, reason,
        onSigned: async signature => { r.triggered = { ...r.triggered!, signature }; await this.save(); } });
      r.triggered = { ...r.triggered, outcome: 'SOLD', signature: sold.signature, detail: sold.detail };
      r.balanceAt = null;
      await this.alert(r, `${name}: SOLD`, `${sold.detail} (${sold.signature})`);
    } catch (error) {
      r.triggered = { ...r.triggered, outcome: 'SELL_FAILED', detail: errorMessage(error) };
      await this.alert(r, `${name}: SELL FAILED`, `${errorMessage(error)} — sell it in your wallet now.`);
    }
  }

  private async alert(r: WatchRule, title: string, body: string): Promise<void> {
    this.alerts.push({ at: this.now, ruleId: r.id, mint: r.mint, symbol: r.symbol, title, body });
    if (this.alerts.length > WATCH.maxAlerts) this.alerts.splice(0, this.alerts.length - WATCH.maxAlerts);
    await this.d.notify(title, body).catch(() => undefined);
  }
  private async save(): Promise<void> {
    await atomicWriteFile(this.d.file, JSON.stringify({ version: 1, rules: this.rules, alerts: this.alerts }, null, 2)).catch(() => undefined);
  }
}

function pick(r: WatchRule): WatchInput {
  return { mint: r.mint, wallet: r.wallet, trailingStopPct: r.trailingStopPct, marketCapFloorUsd: r.marketCapFloorUsd, marketCapTargetUsd: r.marketCapTargetUsd, action: r.action, note: r.note };
}

/**
 * Phone notifications, opt-in through .env: DESK_NTFY_TOPIC (the ntfy app, no account; pick a long random topic) and/or
 * DESK_TELEGRAM_BOT_TOKEN with DESK_TELEGRAM_CHAT_ID. Failures are swallowed: an alert must never block a sale.
 */
export function notifier(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): { notify: (title: string, body: string) => Promise<void>; channels: string[] } {
  const send: Array<(title: string, body: string) => Promise<unknown>> = [], channels: string[] = [];
  const topic = env.DESK_NTFY_TOPIC?.trim();
  if (topic && /^[A-Za-z0-9_-]{8,64}$/.test(topic)) {
    const server = (env.DESK_NTFY_SERVER?.trim() || 'https://ntfy.sh').replace(/\/$/, '');
    send.push((title, body) => fetcher(`${server}/${topic}`, { method: 'POST', body, headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: 'high' }, signal: AbortSignal.timeout(10_000) }));
    channels.push('ntfy');
  }
  const token = env.DESK_TELEGRAM_BOT_TOKEN?.trim(), chat = env.DESK_TELEGRAM_CHAT_ID?.trim();
  if (token && chat && /^\d+:[A-Za-z0-9_-]+$/.test(token) && /^-?\d+$/.test(chat)) {
    send.push((title, body) => fetcher(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}` }), signal: AbortSignal.timeout(10_000) }));
    channels.push('Telegram');
  }
  return { channels, notify: async (title, body) => { await Promise.allSettled(send.map(f => f(title, body))); } };
}

export interface Holding { mint: string; symbol: string | null; balance: number; valueUsd: number | null; marketCapUsd: number | null; fomoUrl: string }
/** Link that opens the token in the FOMO app (or its web page). */
export const fomoUrl = (mint: string) => `https://fomo.family/tokens/solana/${mint}`;

/**
 * The tokens a wallet holds now (e.g. the FOMO in-app wallet), largest value first, so each can be put under Watch
 * with one click. Read-only: token accounts from the RPC, prices from DexScreener.
 */
export async function walletHoldings(o: { wallet: string; rpc: { execute<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> };
  dex: Pick<DexScreenerClient, 'getPairsForTokens'>; max?: number }): Promise<Holding[]> {
  const owner = new PublicKey(o.wallet), balances = new Map<string, { raw: bigint; decimals: number }>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await o.rpc.execute('watch:holdings', c => c.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed'));
    for (const a of res.value) {
      const info = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string; decimals: number } };
      const raw = BigInt(info.tokenAmount.amount);
      if (raw <= 0n) continue;
      const prev = balances.get(info.mint);
      balances.set(info.mint, { raw: (prev?.raw ?? 0n) + raw, decimals: info.tokenAmount.decimals });
    }
  }
  const mints = [...balances.keys()].slice(0, o.max ?? 60), now = Date.now();
  const pairs = mints.length ? await o.dex.getPairsForTokens(mints).catch(() => []) : [];
  return mints.map(mint => {
    const b = balances.get(mint)!, pair = selectPair(pairs, mint, now), balance = Number(b.raw) / 10 ** b.decimals;
    return { mint, symbol: pair?.baseToken.symbol ?? null, balance, valueUsd: pair?.priceUsd ? balance * pair.priceUsd : null,
      marketCapUsd: pair ? pairMetrics(pair, now).marketCapUsd : null, fomoUrl: fomoUrl(mint) };
  }).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

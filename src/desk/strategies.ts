import { CRASH_ENTRY, type ExitRules, type StrategyProfile } from './config';
import type { Candidate, CandidateMetrics, CrashSignal, DeskMode, GateResult, LedgerEntry, ScaleAdvice, StrategyStats } from './types';

const usd = (n: number | null) => n === null ? 'UNKNOWN' : `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const pct = (n: number | null, d = 1) => n === null ? 'UNKNOWN' : `${n.toFixed(d)}%`;

function check(key: string, label: string, value: number | null, pass: (v: number) => boolean, actual: string, required: string, blocking = true): GateResult {
  return { key, label, status: value === null ? 'UNKNOWN' : pass(value) ? 'PASS' : 'FAIL', actual, required, blocking };
}

/** Market-only part of the CRASH entry: decides whether a token gets deep (safety) analysis first in this scan. */
function marketChecks(m: CandidateMetrics): GateResult[] {
  const r = CRASH_ENTRY, ratio = m.liquidityUsd !== null && m.marketCapUsd ? m.liquidityUsd / m.marketCapUsd : null;
  return [
    check('crashAge', 'Pool age', m.poolAgeMin, v => v <= r.maxPoolAgeMin, m.poolAgeMin === null ? 'UNKNOWN' : `${Math.round(m.poolAgeMin)} min`, `≤ ${r.maxPoolAgeMin} min`),
    check('crashPump', '5m price change', m.priceChange5mPct, v => v >= r.minPriceChange5mPct && v <= r.maxPriceChange5mPct, pct(m.priceChange5mPct),
      `+${r.minPriceChange5mPct}% to +${r.maxPriceChange5mPct}%`),
    check('crashVolume', '5m volume', m.volume5mUsd, v => v >= r.minVolume5mUsd, usd(m.volume5mUsd), `≥ ${usd(r.minVolume5mUsd)}`),
    check('crashBuySell', 'Buy/sell ratio (5m)', m.buySellRatio5m, v => v >= r.minBuySellRatio, m.buySellRatio5m?.toFixed(2) ?? 'UNKNOWN', `≥ ${r.minBuySellRatio}`),
    check('crashBuys', 'Buys (5m)', m.buys5m, v => v >= r.minBuys5m, m.buys5m === null ? 'UNKNOWN' : String(m.buys5m), `≥ ${r.minBuys5m}`),
    m.migration === 'BONDING_CURVE' && m.liquidityUsd === null
      ? { key: 'crashLiquidity', label: 'AMM liquidity', status: 'FAIL', actual: 'bonding curve — no AMM pool yet', required: `≥ ${usd(r.minLiquidityUsd)}`, blocking: true }
      : check('crashLiquidity', 'AMM liquidity', m.liquidityUsd, v => v >= r.minLiquidityUsd, usd(m.liquidityUsd), `≥ ${usd(r.minLiquidityUsd)}`),
    check('crashLiquidityRatio', 'Liquidity vs market cap', ratio, v => v >= r.minLiquidityToMarketCap, pct(ratio === null ? null : ratio * 100), `≥ ${r.minLiquidityToMarketCap * 100}%`),
    ...(Number.isFinite(r.maxMarketCapUsd) ? [check('crashMcap', 'Market cap', m.marketCapUsd, v => v <= r.maxMarketCapUsd, usd(m.marketCapUsd), `≤ ${usd(r.maxMarketCapUsd)}`)] : []),
  ];
}

export function crashMarketHint(m: CandidateMetrics): boolean { return marketChecks(m).every(g => g.status === 'PASS'); }

/**
 * CRASH entry: a young pool pumping right now with real buy pressure, and every safety gate passed. Launch fairness is
 * shown but not required; concentration blocks only when it is known to be extreme.
 */
export function crashCheck(c: Candidate): CrashSignal {
  const r = CRASH_ENTRY, m = c.metrics, gate = (key: string) => c.gates.find(g => g.key === key);
  const from = (key: string, blocking = true): GateResult => {
    const g = gate(key);
    return g ? { ...g, blocking } : { key, label: key, status: 'UNKNOWN', actual: 'not evaluated', required: 'PASS', blocking };
  };
  const drop = gate('liquidityDrop');
  const fair = gate('fairLaunch');
  const checks: GateResult[] = [
    ...marketChecks(m),
    from('mintAuthority'), from('freezeAuthority'), from('contract'),
    check('crashTop10', 'Top-10 wallet concentration', m.top10WalletPct, v => v <= r.maxTop10WalletPct, pct(m.top10WalletPct), `≤ ${r.maxTop10WalletPct}%`, m.top10WalletPct !== null),
    check('crashLargest', 'Largest single wallet', m.largestWalletPct, v => v <= r.maxLargestWalletPct, pct(m.largestWalletPct), `≤ ${r.maxLargestWalletPct}%`, m.largestWalletPct !== null),
    ...(drop ? [{ ...drop, blocking: drop.status !== 'UNKNOWN' && drop.blocking }] : []),
    ...(fair ? [{ ...fair, blocking: false, required: 'shown only — not required for CRASH' }] : []),
  ];
  const signal = checks.every(g => !g.blocking || g.status === 'PASS');
  const miss = checks.find(g => g.blocking && g.status !== 'PASS');
  const summary = signal
    ? `${pct(m.priceChange5mPct)} in 5m · pool ${Math.round(m.poolAgeMin ?? 0)} min · ${usd(m.volume5mUsd)} 5m volume · buy/sell ${m.buySellRatio5m?.toFixed(2)}`
    : `${miss!.label}: ${miss!.actual} (${miss!.required})`;
  return { signal, checks, summary };
}

/** One rule set for both strategies; percentages are net of the entry fee (value vs cost). */
export function exitReason(r: ExitRules, x: { pnlPct: number; peakPct: number; fromPeakPct: number; heldMs: number; marketCapUsd?: number | null }): string | null {
  const settling = x.heldMs < (r.graceMs ?? 0);
  if (x.pnlPct <= -r.stopLossPct && !settling) return `STOP_LOSS ${x.pnlPct.toFixed(2)}% ≤ -${r.stopLossPct}%`;
  const cap = x.marketCapUsd ?? null, mc = r.marketCap;
  if (mc && cap !== null && mc.floorUsd !== null && cap <= mc.floorUsd) return `MCAP_FLOOR ${usd(cap)} ≤ ${usd(mc.floorUsd)}`;
  if (mc && cap !== null && mc.targetUsd !== null && cap >= mc.targetUsd) return `MCAP_TARGET ${usd(cap)} ≥ ${usd(mc.targetUsd)}`;
  if (x.pnlPct >= r.takeProfitPct) return `TAKE_PROFIT ${x.pnlPct.toFixed(2)}% ≥ ${r.takeProfitPct}%`;
  if (r.giveback && x.peakPct >= r.giveback.lockPeakPct && x.pnlPct <= x.peakPct - r.giveback.points)
    return `PROFIT_LOCK ${x.pnlPct >= 0 ? '+' : ''}${x.pnlPct.toFixed(2)}% after a +${x.peakPct.toFixed(2)}% peak (gave back ≥ ${r.giveback.points} pts)`;
  if (r.trailing && !settling && x.peakPct >= r.trailing.activationPct && x.fromPeakPct <= -r.trailing.stopPct) return `TRAILING_STOP ${x.fromPeakPct.toFixed(2)}% from peak`;
  if (x.heldMs >= r.maxHoldMin * 60_000) return `MAX_HOLD ${r.maxHoldMin} min`;
  return null;
}

export function exitRuleText(p: StrategyProfile): string[] {
  const r = p.exits, target = p.entryUsd * r.takeProfitPct / 100;
  return [
    ...(p.exitMode !== 'rules' ? [`Exit mode ${p.exitMode.toUpperCase()}`] : []),
    Number.isFinite(r.takeProfitPct) ? `Take profit at +${r.takeProfitPct}% (${usd(target)} unrealized on a ${usd(p.entryUsd)} entry)`
      : 'No take profit: the trailing stop rides the move',
    ...(r.giveback ? [`Profit lock: once +${r.giveback.lockPeakPct}% was reached, exit ${r.giveback.points} points below the peak`] : []),
    ...(r.trailing ? [`Trailing stop ${r.trailing.stopPct}% from the peak after +${r.trailing.activationPct}%`] : []),
    `Stop loss at -${r.stopLossPct}%${r.graceMs ? ` (not in the first ${r.graceMs / 1000} s)` : ''}`,
    ...(r.marketCap?.floorUsd != null ? [`Exit when the market cap falls to ${usd(r.marketCap.floorUsd)}`] : []),
    ...(r.marketCap?.targetUsd != null ? [`Exit when the market cap reaches ${usd(r.marketCap.targetUsd)}`] : []),
    r.maxHoldMin >= 1_440 ? `Time stop after ${+(r.maxHoldMin / 1_440).toFixed(1)} days` : `Time stop after ${r.maxHoldMin} min`, `Re-entry after an exit: ${p.reentryCooldownMs / 60_000} min`,
    'Early warnings: pool liquidity -30% since entry, or the pump.fun creator selling',
    `Checked every ${p.positionCheckMs / 1000} s with an executable Jupiter quote`,
  ];
}

/** Closed trades from one strategy ledger. Each SELL is matched to the BUY that opened it. */
export function strategyStats(entries: LedgerEntry[]): StrategyStats {
  const open = new Map<string, LedgerEntry>();
  const trades: Array<{ net: number; pct: number | null; holdMs: number | null }> = [];
  let drillTrades = 0, failedOrders = 0;
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (e.status === 'FAILED' || e.status === 'UNKNOWN') { failedOrders++; continue; }
    if (e.side === 'BUY') { open.set(e.mint, e); continue; }
    const buy = open.get(e.mint) ?? null;
    open.delete(e.mint);
    if (e.note?.startsWith('DRILL') || buy?.note?.startsWith('DRILL')) { drillTrades++; continue; }
    if (e.netPnlUsd === null) continue;
    const qty = Number(e.quantity), cost = e.entryPriceUsd !== null && Number.isFinite(qty) ? e.entryPriceUsd * qty + (buy?.networkFeeUsd ?? 0) : null;
    trades.push({ net: e.netPnlUsd, pct: cost ? e.netPnlUsd / cost * 100 : null, holdMs: buy ? e.at - buy.at : null });
  }
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const gain = wins.reduce((a, t) => a + t.net, 0), loss = -losses.reduce((a, t) => a + t.net, 0);
  const pcts = trades.map(t => t.pct).filter((v): v is number => v !== null), holds = trades.map(t => t.holdMs).filter((v): v is number => v !== null);
  let cum = 0, peak = 0, maxDrawdownUsd = 0;
  for (const t of trades) { cum += t.net; peak = Math.max(peak, cum); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cum); }
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null;
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    netPnlUsd: cum, avgReturnPct: avg(pcts), bestReturnPct: pcts.length ? Math.max(...pcts) : null, worstReturnPct: pcts.length ? Math.min(...pcts) : null,
    avgHoldSec: holds.length ? avg(holds)! / 1000 : null, profitFactor: loss > 0 ? gain / loss : null, maxDrawdownUsd, drillTrades, failedOrders };
}

export const SCALE_LADDER = [10, 100, 1_000, 10_000] as const;
export const SCALE_RULES = Object.freeze({ minTrades: 20, minProfitFactor: 1.3, maxDrawdownOfCapital: 0.5, maxImpactShareOfLiquidity: 0.02 });

/**
 * Advisory only: the desk never changes an entry size by itself. Sizes are raised by editing .env after the
 * current size has proven itself — first in TEST, then with LIVE fills.
 */
export function scaleAdvice(p: StrategyProfile, s: StrategyStats, mode: DeskMode): ScaleAdvice {
  const k = SCALE_RULES, next = SCALE_LADDER.find(x => x > p.entryUsd + 1e-9) ?? null;
  const pf = s.losses === 0 ? (s.trades > 0 ? Infinity : null) : s.profitFactor;
  const checks = [
    { label: 'Closed trades', ok: s.trades >= k.minTrades, actual: String(s.trades), required: `≥ ${k.minTrades}` },
    { label: 'Net PnL', ok: s.netPnlUsd > 0, actual: `${s.netPnlUsd < 0 ? '-' : ''}$${Math.abs(s.netPnlUsd).toFixed(2)}`, required: '> $0' },
    { label: 'Profit factor', ok: pf !== null && pf >= k.minProfitFactor, actual: pf === null ? '--' : pf === Infinity ? 'no losses' : pf.toFixed(2), required: `≥ ${k.minProfitFactor}` },
    { label: 'Max drawdown', ok: s.maxDrawdownUsd <= p.capitalUsd * k.maxDrawdownOfCapital, actual: `$${s.maxDrawdownUsd.toFixed(2)}`,
      required: `≤ $${(p.capitalUsd * k.maxDrawdownOfCapital).toFixed(2)} (half the sleeve)` },
  ];
  const ready = next !== null && checks.every(c => c.ok);
  const nextMinLiquidityUsd = next === null ? null : next / k.maxImpactShareOfLiquidity;
  const note = next === null ? 'Top of the ladder.'
    : `${ready ? `Ready to try ${usd(next)} entries` : `Stay at ${usd(p.entryUsd)}`}${mode === 'PAPER' ? ' — paper fills ignore latency and MEV; confirm with LIVE fills before sizing up real money' : ''}. ` +
      `At ${usd(next)} per entry the pool needs ≥ ${usd(nextMinLiquidityUsd)} liquidity to keep impact near 2%; most sub-$1M meme pools cannot absorb $1K+ orders.`;
  return { currentEntryUsd: p.entryUsd, nextEntryUsd: next, ready, checks, nextMinLiquidityUsd, note };
}

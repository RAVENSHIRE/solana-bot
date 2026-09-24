import type { PoolTrade } from '../core/types';
import { clamp, round } from '../utils/format';

export interface Accumulator {
  wallet: string;
  buyUsd: number;
  sellUsd: number;
  buys: number;
  /** Käufe über ≥ 5 Minuten verteilt (geduldiges Einsammeln statt Einzel-FOMO). */
  steady: boolean;
  known: boolean;
}

export interface SmartMoneyAnalysis {
  accumulators: Accumulator[];
  accumulatorCount: number;
  steadyCount: number;
  knownSmartBuyers: number;
  knownSmartSellers: number;
  accumulatedUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  netFlowUsd: number;
  /** Käuferanteil in der jüngeren Hälfte minus älterer Hälfte (positiv = Kaufdruck nimmt zu). */
  buyShareShift: number;
  /** 0–100 */
  clusterScore: number;
}

export interface SmartMoneyOptions {
  minAccumulationUsd: number;
  knownWallets: ReadonlySet<string>;
  /** Wallets, die als Wash-Trader erkannt wurden, werden ignoriert. */
  excludeWallets?: ReadonlySet<string>;
}

/**
 * Erkennt Akkumulations-Cluster: mehrere unabhängige Wallets, die im Abwärtstrend
 * nennenswert kaufen, kaum verkaufen und über die Zeit verteilt nachkaufen.
 * Optional werden bekannte Smart-Money-Wallets (RS_SMART_MONEY_WALLETS) stärker gewichtet.
 */
export function analyzeSmartMoney(trades: PoolTrade[], o: SmartMoneyOptions): SmartMoneyAnalysis {
  const clean = o.excludeWallets ? trades.filter((t) => !o.excludeWallets!.has(t.wallet)) : trades;
  const per = new Map<string, { buyUsd: number; sellUsd: number; buys: number; firstBuy: number; lastBuy: number }>();
  let buyVol = 0;
  let sellVol = 0;
  let knownSellers = 0;
  const knownSellerSet = new Set<string>();

  for (const t of clean) {
    let w = per.get(t.wallet);
    if (!w) {
      w = { buyUsd: 0, sellUsd: 0, buys: 0, firstBuy: Infinity, lastBuy: 0 };
      per.set(t.wallet, w);
    }
    if (t.kind === 'buy') {
      w.buyUsd += t.volumeUsd;
      w.buys++;
      w.firstBuy = Math.min(w.firstBuy, t.ts);
      w.lastBuy = Math.max(w.lastBuy, t.ts);
      buyVol += t.volumeUsd;
    } else {
      w.sellUsd += t.volumeUsd;
      sellVol += t.volumeUsd;
      if (o.knownWallets.has(t.wallet) && !knownSellerSet.has(t.wallet)) {
        knownSellerSet.add(t.wallet);
        knownSellers++;
      }
    }
  }

  const accumulators: Accumulator[] = [];
  for (const [wallet, w] of per) {
    const known = o.knownWallets.has(wallet);
    const minUsd = known ? o.minAccumulationUsd / 2 : o.minAccumulationUsd;
    if (w.buyUsd < minUsd) continue;
    if (w.sellUsd > w.buyUsd * 0.1) continue;
    if (w.buys < 2 && w.buyUsd < o.minAccumulationUsd * 3 && !known) continue;
    accumulators.push({
      wallet,
      buyUsd: round(w.buyUsd, 0),
      sellUsd: round(w.sellUsd, 0),
      buys: w.buys,
      steady: w.buys >= 2 && w.lastBuy - w.firstBuy >= 5 * 60_000,
      known,
    });
  }
  accumulators.sort((a, b) => b.buyUsd - a.buyUsd);

  // Kaufdruck-Verschiebung: jüngere vs. ältere Hälfte des Zeitfensters
  let buyShareShift = 0;
  if (clean.length >= 20) {
    const sorted = [...clean].sort((a, b) => a.ts - b.ts);
    const mid = Math.floor(sorted.length / 2);
    const share = (arr: PoolTrade[]): number => {
      const b = arr.filter((t) => t.kind === 'buy').reduce((s, t) => s + t.volumeUsd, 0);
      const all = arr.reduce((s, t) => s + t.volumeUsd, 0);
      return all > 0 ? b / all : 0.5;
    };
    buyShareShift = share(sorted.slice(mid)) - share(sorted.slice(0, mid));
  }

  const knownBuyers = accumulators.filter((a) => a.known).length;
  const steadyCount = accumulators.filter((a) => a.steady).length;
  const accumulatedUsd = accumulators.reduce((s, a) => s + a.buyUsd, 0);
  const total = buyVol + sellVol;
  const netFlow = buyVol - sellVol;

  let score = 0;
  score += Math.min(40, accumulators.length * 8);
  score += Math.min(15, steadyCount * 5);
  score += Math.min(25, knownBuyers * 12.5);
  score -= Math.min(25, knownSellers * 12.5);
  score += total > 0 ? clamp((netFlow / total) * 40, -10, 10) : 0;
  score += clamp(buyShareShift * 50, -10, 10);

  return {
    accumulators,
    accumulatorCount: accumulators.length,
    steadyCount,
    knownSmartBuyers: knownBuyers,
    knownSmartSellers: knownSellers,
    accumulatedUsd: round(accumulatedUsd, 0),
    buyVolumeUsd: round(buyVol, 0),
    sellVolumeUsd: round(sellVol, 0),
    netFlowUsd: round(netFlow, 0),
    buyShareShift: round(buyShareShift, 3),
    clusterScore: round(clamp(score, 0, 100), 1),
  };
}

import type { PoolTrade } from '../core/types';
import { clamp, round } from '../utils/format';
import { coefficientOfVariation } from './indicators';

export interface VolumeQuality {
  tradeCount: number;
  totalVolumeUsd: number;
  uniqueWallets: number;
  /** Eindeutige Wallets / Trades (niedrig = wenige Wallets erzeugen viel Aktivität). */
  uniqueWalletRatio: number;
  washVolumeUsd: number;
  /** Anteil des Volumens, der als Wash-Trading klassifiziert wurde (0–1). */
  washRatio: number;
  /** Volumenanteil der aktivsten Wallet. */
  topWalletShare: number;
  /** Variationskoeffizient der Tradegrößen (sehr niedrig = Bot-Muster). */
  sizeCv: number;
  dustRatio: number;
  /** 0–100: Wie "echt" ist das Volumen? */
  organicScore: number;
  washWallets: Set<string>;
  flags: string[];
}

interface WalletAgg {
  buyUsd: number;
  sellUsd: number;
  trades: PoolTrade[];
}

const ROUND_TRIP_WINDOW_MS = 120_000;
const ROUND_TRIP_SIZE_TOLERANCE = 0.15;
const DUST_USD = 5;

/**
 * Unterscheidet organisches Volumen von Wash-Trading anhand der Einzel-Trades:
 *  1. Round-Tripper: Wallet kauft und verkauft nahezu dasselbe Volumen (Netto ≈ 0)
 *  2. Schnelle Hin-und-Her-Trades: Kauf ↔ Verkauf gleicher Größe innerhalb von 2 Minuten
 *  3. Identische Größen-Buckets über viele Wallets (Bot-Farmen mit festen Beträgen)
 *  4. Dust-Spam (Mikro-Trades, die nur den Trade-Zähler aufblähen)
 */
export function analyzeVolumeQuality(trades: PoolTrade[]): VolumeQuality {
  const flags: string[] = [];
  const total = trades.reduce((s, t) => s + t.volumeUsd, 0);
  const empty: VolumeQuality = {
    tradeCount: trades.length,
    totalVolumeUsd: total,
    uniqueWallets: 0,
    uniqueWalletRatio: 0,
    washVolumeUsd: 0,
    washRatio: 0,
    topWalletShare: 0,
    sizeCv: 0,
    dustRatio: 0,
    organicScore: 0,
    washWallets: new Set(),
    flags: ['zu wenige Trades'],
  };
  if (trades.length < 10 || total <= 0) return empty;

  const wallets = new Map<string, WalletAgg>();
  for (const t of trades) {
    let w = wallets.get(t.wallet);
    if (!w) {
      w = { buyUsd: 0, sellUsd: 0, trades: [] };
      wallets.set(t.wallet, w);
    }
    if (t.kind === 'buy') w.buyUsd += t.volumeUsd;
    else w.sellUsd += t.volumeUsd;
    w.trades.push(t);
  }

  const washTx = new Set<string>();
  const washWallets = new Set<string>();

  for (const [addr, w] of wallets) {
    // (1) Balancierte Wallets
    const hi = Math.max(w.buyUsd, w.sellUsd);
    const lo = Math.min(w.buyUsd, w.sellUsd);
    if (w.trades.length >= 2 && hi > 0 && lo / hi >= 0.8) {
      washWallets.add(addr);
      for (const t of w.trades) washTx.add(t.id ?? t.txHash);
      continue;
    }
    // (2) Schnelle Round-Trips gleicher Größe
    const sorted = [...w.trades].sort((a, b) => a.ts - b.ts);
    let pairs = 0;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (a.kind === b.kind || b.ts - a.ts > ROUND_TRIP_WINDOW_MS) continue;
      const big = Math.max(a.volumeUsd, b.volumeUsd);
      if (big > 0 && Math.abs(a.volumeUsd - b.volumeUsd) / big <= ROUND_TRIP_SIZE_TOLERANCE) {
        washTx.add(a.id ?? a.txHash);
        washTx.add(b.id ?? b.txHash);
        pairs++;
      }
    }
    if (pairs >= 2) washWallets.add(addr);
  }

  // (3) Identische Größen-Buckets (2 signifikante Stellen) über ≥ 3 Wallets
  const buckets = new Map<string, PoolTrade[]>();
  for (const t of trades) {
    if (t.volumeUsd < DUST_USD) continue;
    const key = t.volumeUsd.toPrecision(2);
    const list = buckets.get(key) ?? [];
    list.push(t);
    buckets.set(key, list);
  }
  let repeatedCount = 0;
  for (const list of buckets.values()) {
    const distinctWallets = new Set(list.map((t) => t.wallet)).size;
    if (list.length >= 5 && distinctWallets >= 3 && list.length / trades.length >= 0.08) {
      repeatedCount += list.length;
      for (const t of list) washTx.add(t.id ?? t.txHash);
    }
  }
  if (repeatedCount / trades.length > 0.25) flags.push('viele identische Tradegrößen');

  // (4) Dust
  const dust = trades.filter((t) => t.volumeUsd < DUST_USD).length;
  const dustRatio = dust / trades.length;
  if (dustRatio > 0.3) flags.push('Dust-Spam');

  const washVolume = trades.filter((t) => washTx.has(t.id ?? t.txHash)).reduce((s, t) => s + t.volumeUsd, 0);
  const washRatio = clamp(washVolume / total, 0, 1);
  const uniqueWalletRatio = wallets.size / trades.length;
  const topWalletShare = Math.max(...[...wallets.values()].map((w) => w.buyUsd + w.sellUsd)) / total;
  const sizeCv = coefficientOfVariation(trades.map((t) => t.volumeUsd));

  if (washRatio > 0.3) flags.push(`Wash-Anteil ${Math.round(washRatio * 100)}%`);
  if (uniqueWalletRatio < 0.3) flags.push('wenige aktive Wallets');
  if (topWalletShare > 0.25) flags.push(`Top-Wallet ${Math.round(topWalletShare * 100)}% des Volumens`);
  if (sizeCv < 0.3 && trades.length > 20) flags.push('uniforme Tradegrößen');

  let score = 100;
  score -= washRatio * 70;
  if (uniqueWalletRatio < 0.3) score -= ((0.3 - uniqueWalletRatio) / 0.3) * 20;
  if (topWalletShare > 0.25) score -= Math.min(20, (topWalletShare - 0.25) * 60);
  if (sizeCv < 0.3 && trades.length > 20) score -= 10;
  if (dustRatio > 0.3) score -= Math.min(15, dustRatio * 20);

  return {
    tradeCount: trades.length,
    totalVolumeUsd: round(total, 0),
    uniqueWallets: wallets.size,
    uniqueWalletRatio: round(uniqueWalletRatio, 3),
    washVolumeUsd: round(washVolume, 0),
    washRatio: round(washRatio, 3),
    topWalletShare: round(topWalletShare, 3),
    sizeCv: round(sizeCv, 3),
    dustRatio: round(dustRatio, 3),
    organicScore: round(clamp(score, 0, 100), 1),
    washWallets,
    flags,
  };
}

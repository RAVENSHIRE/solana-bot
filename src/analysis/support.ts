import type { Candle } from '../core/types';
import { findPivotLows } from './indicators';

export interface SupportLevel {
  price: number;
  touches: number;
  firstIndex: number;
  lastIndex: number;
}

export interface SupportAnalysis {
  levels: SupportLevel[];
  /** Nächstes Support-Level unterhalb (oder knapp über) dem aktuellen Preis. */
  nearest: SupportLevel | null;
  /** Abstand des aktuellen Preises zum nächsten Support in %. */
  distancePct: number | null;
  /** Die beiden jüngsten Pivot-Tiefs bilden ein höheres Tief. */
  higherLow: boolean;
  /** Preis markiert in den letzten Kerzen neue Tiefs → "fallendes Messer", kein Einstieg. */
  fallingKnife: boolean;
  lowestLow: number;
  currentPrice: number;
  pivotIndices: number[];
}

/**
 * Bodenbildung: Pivot-Tiefs werden per Preis-Toleranz zu Zonen geclustert.
 * Eine Zone mit mehreren Berührungen (Double/Triple Bottom) ist ein belastbarer Support.
 */
export function analyzeSupport(candles: Candle[], tolerancePct: number, pivotWidth = 3): SupportAnalysis {
  const lows = candles.map((c) => c.l);
  const current = candles[candles.length - 1]?.c ?? 0;
  const lowestLow = lows.length > 0 ? Math.min(...lows) : 0;
  const pivots = findPivotLows(lows, pivotWidth, pivotWidth);

  // Clustering: sortiert nach Preis, benachbarte Pivots innerhalb der Toleranz zusammenfassen
  const sorted = [...pivots].sort((a, b) => lows[a]! - lows[b]!);
  const clusters: number[][] = [];
  for (const idx of sorted) {
    const price = lows[idx]!;
    const cluster = clusters[clusters.length - 1];
    if (cluster) {
      const avg = cluster.reduce((s, i) => s + lows[i]!, 0) / cluster.length;
      if (Math.abs(price - avg) / avg <= tolerancePct / 100) {
        cluster.push(idx);
        continue;
      }
    }
    clusters.push([idx]);
  }

  const levels: SupportLevel[] = clusters
    .map((cl) => ({
      price: cl.reduce((s, i) => s + lows[i]!, 0) / cl.length,
      touches: cl.length,
      firstIndex: Math.min(...cl),
      lastIndex: Math.max(...cl),
    }))
    .sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex);

  const tol = 1 + tolerancePct / 100;
  const below = levels.filter((l) => l.price <= current * tol).sort((a, b) => b.price - a.price);
  // Bevorzugt: nächstes Level mit ≥ 2 Berührungen, sonst das nächstgelegene
  const nearest = below.find((l) => l.touches >= 2) ?? below[0] ?? null;
  const distancePct = nearest && nearest.price > 0 ? ((current - nearest.price) / nearest.price) * 100 : null;

  const chrono = [...pivots].sort((a, b) => a - b);
  const p1 = chrono[chrono.length - 2];
  const p2 = chrono[chrono.length - 1];
  const higherLow = p1 !== undefined && p2 !== undefined && lows[p2]! > lows[p1]! * (1 + 0.002);

  const recent = lows.slice(-3);
  const fallingKnife = recent.length > 0 && Math.min(...recent) <= lowestLow * 1.0005;

  return { levels, nearest, distancePct, higherLow, fallingKnife, lowestLow, currentPrice: current, pivotIndices: chrono };
}

/**
 * Bullische Divergenz: Preis bildet ein tieferes Tief, der RSI aber ein höheres Tief
 * (nachlassender Verkaufsdruck). Geprüft an den beiden jüngsten Pivot-Tiefs.
 */
export function bullishDivergence(candles: Candle[], rsiValues: number[], pivotIndices: number[]): boolean {
  const recent = pivotIndices.filter((i) => i >= candles.length - 60).slice(-2);
  if (recent.length < 2) return false;
  const [a, b] = recent as [number, number];
  const ra = rsiValues[a];
  const rb = rsiValues[b];
  if (ra === undefined || rb === undefined || Number.isNaN(ra) || Number.isNaN(rb)) return false;
  return candles[b]!.l < candles[a]!.l && rb > ra + 2 && ra < 40;
}

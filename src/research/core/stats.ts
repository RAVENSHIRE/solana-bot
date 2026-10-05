import { seededRng } from './random';

/**
 * Small, dependency-free statistics for research verdicts. Every function returns null instead of a number when the
 * sample cannot support one, so an empty or tiny result never reads as "0 %".
 */

export const sum = (xs: readonly number[]): number => xs.reduce((a, x) => a + x, 0);
export const mean = (xs: readonly number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length || !(q >= 0 && q <= 1)) return null;
  const s = [...xs].sort((a, b) => a - b), pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
export const median = (xs: readonly number[]): number | null => quantile(xs, 0.5);

/** Sample standard deviation (n − 1). */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1));
}

export function skewness(xs: readonly number[]): number | null {
  const n = xs.length, s = stdev(xs);
  if (n < 3 || !s) return null;
  const m = sum(xs) / n;
  return sum(xs.map(x => ((x - m) / s) ** 3)) / n;
}

/** Kurtosis (not excess: 3 for a normal distribution). */
export function kurtosis(xs: readonly number[]): number | null {
  const n = xs.length, s = stdev(xs);
  if (n < 4 || !s) return null;
  const m = sum(xs) / n;
  return sum(xs.map(x => ((x - m) / s) ** 4)) / n;
}

/** Gross profit ÷ gross loss; null without a loss (an infinite factor is not a measurement). */
export function profitFactor(returns: readonly number[]): number | null {
  const gain = sum(returns.filter(r => r > 0)), loss = -sum(returns.filter(r => r < 0));
  return loss > 0 ? gain / loss : null;
}

/** Largest peak-to-trough fall of the cumulative PnL path (in PnL units, ≥ 0). */
export function maxDrawdown(pnls: readonly number[]): number {
  let equity = 0, peak = 0, worst = 0;
  for (const p of pnls) { equity += p; peak = Math.max(peak, equity); worst = Math.max(worst, peak - equity); }
  return worst;
}

/** Per-observation Sharpe ratio (mean ÷ sample stdev); no annualisation, trades are not evenly spaced. */
export function sharpe(xs: readonly number[]): number | null {
  const m = mean(xs), s = stdev(xs);
  return m === null || !s ? null : m / s;
}

export function tStat(xs: readonly number[]): number | null {
  const s = stdev(xs), m = mean(xs);
  return m === null || !s ? null : m / (s / Math.sqrt(xs.length));
}

export interface Interval { low: number; high: number; level: number; resamples: number }

/** Percentile bootstrap of a statistic (default: the mean), seeded. */
export function bootstrapCi(xs: readonly number[], o: { level?: number; resamples?: number; seed?: number; stat?: (s: number[]) => number } = {}): Interval | null {
  if (xs.length < 2) return null;
  const level = o.level ?? 0.95, n = o.resamples ?? 2_000, rng = seededRng(o.seed ?? 1), stat = o.stat ?? ((s: number[]) => sum(s) / s.length);
  const stats: number[] = [];
  const sample = new Array<number>(xs.length);
  for (let b = 0; b < n; b++) {
    for (let i = 0; i < xs.length; i++) sample[i] = xs[Math.floor(rng() * xs.length)]!;
    stats.push(stat(sample));
  }
  return { low: quantile(stats, (1 - level) / 2)!, high: quantile(stats, 1 - (1 - level) / 2)!, level, resamples: n };
}

/** Bootstrap interval of mean(a) − mean(b) for two independent samples (strategy vs baseline). */
export function bootstrapDiffCi(a: readonly number[], b: readonly number[], o: { level?: number; resamples?: number; seed?: number } = {}): Interval | null {
  if (a.length < 2 || b.length < 2) return null;
  const level = o.level ?? 0.95, n = o.resamples ?? 2_000, rng = seededRng(o.seed ?? 1), diffs: number[] = [];
  for (let k = 0; k < n; k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(rng() * a.length)]!;
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(rng() * b.length)]!;
    diffs.push(sa / a.length - sb / b.length);
  }
  return { low: quantile(diffs, (1 - level) / 2)!, high: quantile(diffs, 1 - (1 - level) / 2)!, level, resamples: n };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam; relative error < 1.2e-9). */
export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normalInv: p must be in (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Probabilistic Sharpe ratio: the probability that the true per-trade Sharpe exceeds `benchmark`, given the sample's
 * length, skew and fat tails (Bailey & López de Prado 2012). Meme-coin returns are very skewed; this penalises it.
 */
export function probabilisticSharpe(xs: readonly number[], benchmark = 0): number | null {
  const sr = sharpe(xs), g3 = skewness(xs), g4 = kurtosis(xs), n = xs.length;
  if (sr === null || g3 === null || g4 === null) return null;
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;
  return normalCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

const EULER_GAMMA = 0.5772156649015329;

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014): the probabilistic Sharpe against the Sharpe that the best of
 * `trials` strategies with no edge would reach by luck. `trials` is the number of rule sets compared before this one
 * was picked — the desk's grid search compares thousands. `trialSharpeVariance` is the variance of the trials' Sharpe
 * ratios; without it the estimator variance of this sample's Sharpe is used (conservative only when trials are alike).
 */
export function deflatedSharpe(xs: readonly number[], trials: number, trialSharpeVariance?: number): { dsr: number | null; expectedMaxSharpe: number | null } {
  const sr = sharpe(xs), g3 = skewness(xs), g4 = kurtosis(xs), n = xs.length;
  if (sr === null || g3 === null || g4 === null || !(trials >= 1)) return { dsr: null, expectedMaxSharpe: null };
  const estVar = (1 - g3 * sr + ((g4 - 1) / 4) * sr * sr) / (n - 1);
  const v = trialSharpeVariance ?? estVar;
  const expectedMaxSharpe = trials <= 1 ? 0 : Math.sqrt(Math.max(0, v)) *
    ((1 - EULER_GAMMA) * normalInv(1 - 1 / trials) + EULER_GAMMA * normalInv(1 - 1 / (trials * Math.E)));
  return { dsr: probabilisticSharpe(xs, expectedMaxSharpe), expectedMaxSharpe };
}

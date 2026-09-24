/**
 * Technische Basis-Indikatoren. Alle Funktionen liefern Arrays gleicher Länge wie die Eingabe;
 * Werte in der Aufwärmphase sind NaN.
 */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** Variationskoeffizient (σ/μ) – misst die Streuung relativ zum Mittelwert. */
export function coefficientOfVariation(values: number[]): number {
  const m = mean(values);
  return m === 0 ? 0 : stdev(values) / Math.abs(m);
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI nach Wilder (Glättung 1/period). */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const calc = (): number => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

/**
 * Pivot-Tiefs: Kerze i ist ein Pivot, wenn ihr Low ≤ allen Lows in [i-left, i+right].
 * Liefert Indizes aufsteigend.
 */
export function findPivotLows(lows: number[], left = 3, right = 3): number[] {
  const out: number[] = [];
  for (let i = left; i < lows.length - right; i++) {
    const v = lows[i]!;
    let isPivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && lows[j]! < v) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push(i);
  }
  return out;
}

/** Letzter endlicher Wert eines Indikator-Arrays (oder NaN). */
export function last(values: number[], offset = 0): number {
  const v = values[values.length - 1 - offset];
  return v === undefined ? NaN : v;
}

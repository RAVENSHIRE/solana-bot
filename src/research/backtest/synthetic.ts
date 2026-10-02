import { seededRng } from '../core/random';
import { makeEvent } from '../events/factory';
import type { EventInput, ResearchEvent } from '../events/types';

/**
 * Synthetic markets with a KNOWN truth, to test the research machine itself: on a market with a planted edge the
 * pipeline must find it, on a market without one it must not. Every event is tagged `source: synthetic` and
 * `payload.synthetic: true`; synthetic data must never be mixed into a real dataset (ingest refuses the source).
 *
 * Each token graduates, then trades in 1-minute bars for an hour. Half of them make a CRASH-like first move (+10–30 %
 * in five minutes on ≥ $50K volume within 15 minutes of graduation). What happens after that move is the planted truth:
 * with `edge`, it runs to 2.2× with probability `pWin`; otherwise it falls 45 %. The other tokens drift sideways.
 */
export interface SyntheticOptions {
  tokens: number;
  start: number;
  seed: number;
  /** Probability that a first move continues (the edge). 0.25 ≈ no edge after costs, 0.7 = a strong edge. */
  pWin: number;
  /** Minutes between graduations. */
  spacingMin?: number;
  /** How long after a bar closes a real-time system would have it. */
  availabilityLagMs?: number;
}

const MIN = 60_000;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function syntheticMint(i: number, seed: number): string {
  const rng = seededRng(seed * 7919 + i);
  return Array.from({ length: 44 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join('');
}

export function syntheticMarket(o: SyntheticOptions): ResearchEvent[] {
  const rng = seededRng(o.seed), out: ResearchEvent[] = [], lag = o.availabilityLagMs ?? 5_000, spacing = o.spacingMin ?? 6;
  const push = (i: EventInput) => out.push(makeEvent({ ...i, payload: { ...i.payload, synthetic: true }, producer: { component: 'synthetic', version: '1' } }, i.observed_at ?? i.timestamp));
  for (let i = 0; i < o.tokens; i++) {
    const token = syntheticMint(i, o.seed), g = o.start + i * spacing * MIN;
    push({ event_type: 'Graduation', token, timestamp: g, observed_at: g + 2_000, source: 'synthetic', payload: { pool: `pool${i}` } });
    const mover = rng() < 0.5, moveAt = 3 + Math.floor(rng() * 5), win = rng() < o.pWin;
    let price = 0.00003 * (0.8 + rng() * 0.4);
    const bars: Array<{ o: number; c: number; h: number; l: number; v: number }> = [];
    for (let m = 0; m < 60; m++) {
      const open = price;
      let drift = (rng() - 0.5) * 0.02, volume = 1_000 + rng() * 2_000;
      if (mover && m >= moveAt && m < moveAt + 5) { drift = 0.035 + rng() * 0.015; volume = 14_000 + rng() * 6_000; }
      else if (mover && m >= moveAt + 5 && m < moveAt + 15) { drift = win ? 0.085 : -0.07; volume = 8_000; }
      price = open * (1 + drift);
      const hi = Math.max(open, price) * (1 + rng() * 0.01), lo = Math.min(open, price) * (1 - rng() * 0.01);
      bars.push({ o: open, c: price, h: hi, l: lo, v: volume });
    }
    for (const [m, b] of bars.entries()) {
      const close = g + (m + 1) * MIN, liquidity = 25_000 * Math.sqrt(b.c / 0.00003);
      push({ event_type: 'Candle', token, timestamp: close, observed_at: close + lag, source: 'synthetic',
        payload: { interval_ms: MIN, start: close - MIN, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, supply: 1e9 } });
      push({ event_type: 'LiquidityChange', token, timestamp: close, observed_at: close + lag, source: 'synthetic', payload: { liquidity_usd: liquidity } });
    }
  }
  // Reference prices for the regime: SOL drifts up, BTC sideways, hourly.
  const hours = Math.ceil((o.tokens * spacing + 60) / 60) + 26;
  for (let h = -26; h < hours; h++) {
    const t = o.start + h * 3_600_000;
    push({ event_type: 'MarketSnapshot', token: 'REF:SOL', timestamp: t, observed_at: t + lag, source: 'synthetic', payload: { price_usd: 150 * (1 + 0.004 * h) * (1 + (rng() - 0.5) * 0.01) } });
    push({ event_type: 'MarketSnapshot', token: 'REF:BTC', timestamp: t, observed_at: t + lag, source: 'synthetic', payload: { price_usd: 60_000 * (1 + (rng() - 0.5) * 0.004) } });
  }
  return out;
}

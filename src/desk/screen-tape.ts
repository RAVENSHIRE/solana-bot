import type { ResearchLedger } from '../research/ledger';
import type { OpeningState } from './opening';
import type { Candidate } from './types';

/**
 * The live screens on disk, with exact timestamps (owner, 6 Oct: "I can't re-evaluate or optimize the code if the
 * progression with exact timestamps exists only in memory"). Every reading the dashboard's screens are built from:
 *
 *   OS  opening screen, every curve read (every 4 s per watched launch)   at, mint, status, market cap USD
 *   OC  opening screen, a status change (strong open, breakout, rug …)   at, mint, status, symbol, name, open high, low, last, peak, detail
 *   GS  golden pocket, every pool read (every 4 s per watched pool)       at, mint, market cap USD, liquidity USD, phase
 *   CS  candidates, every candidate of every scan (every 20 s)            at, mint, mode, symbol, status, metrics, verdicts [id, signal, summary]
 *
 * Written like the research ledger: data-desk/screens/ev-YYYYMMDD-HH.jsonl, one JSON array per line, mints as
 * per-file numbers (`["M", i, mint]`), gzipped once the hour is over, paused while free disk space is low. Never throws.
 */
export interface ScreenTape {
  openingSample(s: OpeningState, at: number, usd: number): void;
  openingChange(s: OpeningState, at: number): void;
  goldenSample(mint: string, at: number, capUsd: number, liquidityUsd: number | null, phase: string): void;
  candidate(c: Candidate, verdicts: ReadonlyArray<{ id: string; signal: boolean; summary: string }>, at: number, mode: string): void;
}

const r0 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v);
const r2 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

export function screenTape(ledger: Pick<ResearchLedger, 'put' | 'lowDisk'>): ScreenTape {
  const put = (rec: Parameters<ResearchLedger['put']>[0]) => { try { if (!ledger.lowDisk) ledger.put(rec); } catch { /* a screen never stops over its record */ } };
  return {
    openingSample: (s, at, usd) => put(['OS', at, { $m: s.mint }, s.status, r0(usd)]),
    openingChange: (s, at) => put(['OC', at, { $m: s.mint }, s.status, s.symbol, s.name, r0(s.openHighUsd), r0(s.lowUsd), r0(s.lastUsd), r0(s.peakUsd), s.detail]),
    goldenSample: (mint, at, cap, liq, phase) => put(['GS', at, { $m: mint }, r0(cap), r0(liq), phase]),
    candidate: (c, verdicts, at, mode) => {
      const m = c.metrics;
      put(['CS', at, { $m: c.mint }, mode, c.symbol, c.status, {
        mc: r0(m.marketCapUsd), px: m.priceUsd, liq: r0(m.liquidityUsd), age: r2(m.tokenAgeMin ?? null), pool: r2(m.poolAgeMin), v5: r0(m.volume5mUsd), v1h: r0(m.volume1hUsd),
        b5: m.buys5m, s5: m.sells5m, bs: r2(m.buySellRatio5m), c5: r2(m.priceChange5mPct), c1h: r2(m.priceChange1hPct), top10: r2(m.top10WalletPct), top1: r2(m.largestWalletPct),
        dev: r2(m.developerPct), dex: c.pair.dex, pair: c.pair.address,
      }, verdicts.map(v => [v.id, v.signal ? 1 : 0, v.summary.slice(0, 160)])]);
    },
  };
}

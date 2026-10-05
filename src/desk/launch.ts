import type { GeckoTerminalClient } from '../data/geckoterminal';

export interface LaunchCheck {
  launchedAt: number; poolsChecked: number; curvePool: string | null;
  /** Seconds between the pump.fun curve's creation and its first migrated pool; null without a curve or migration. */
  migratedAfterSec: number | null;
  /** Highest market cap observed in the first minutes after launch (price × supply). */
  earlyHighMcUsd: number | null;
  /** Largest high ÷ open of a pool's first candle. */
  firstCandleMultiple: number | null;
  windowMin: number;
}

const WINDOW_MS = 5 * 60_000;

/**
 * Launch fairness from the pools' own history: a curve bought out in its creation transaction graduates within
 * seconds, and a bundled launch prints its first candles far above a normal starting market cap.
 */
export async function launchCheck(gecko: GeckoTerminalClient, mint: string, supplyUi: number | null): Promise<LaunchCheck> {
  const pools = (await gecko.getTokenPools(mint)).filter(p => p.baseTokenMint === mint && p.createdAt !== null)
    .sort((a, b) => a.createdAt! - b.createdAt!);
  if (!pools.length) throw new Error('No pool history for this token');
  const launchedAt = pools[0]!.createdAt!;
  const curve = pools.find(p => p.dex === 'pump-fun') ?? null;
  const migrated = pools.find(p => p.dex !== 'pump-fun')?.createdAt ?? null;
  const before = Math.floor((launchedAt + WINDOW_MS + 60_000) / 1000);
  let high: number | null = null, multiple: number | null = null;
  for (const pool of pools.slice(0, 2)) {
    const series = await gecko.getCandlesBefore(pool.address, mint, before, 10);
    const early = [...series.candles, ...series.partial].filter(c => c.t >= launchedAt - 60_000 && c.t <= launchedAt + WINDOW_MS).sort((a, b) => a.t - b.t);
    for (const c of early) high = Math.max(high ?? 0, c.h);
    if (early[0] && early[0].o > 0) multiple = Math.max(multiple ?? 0, early[0].h / early[0].o);
  }
  return { launchedAt, poolsChecked: pools.length, curvePool: curve?.address ?? null,
    migratedAfterSec: curve && migrated !== null ? Math.max(0, (migrated - curve.createdAt!) / 1000) : null,
    earlyHighMcUsd: high !== null && supplyUi !== null ? high * supplyUi : null, firstCandleMultiple: multiple, windowMin: WINDOW_MS / 60_000 };
}

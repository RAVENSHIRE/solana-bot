import { DexScreenerClient } from '../data/dexscreener';
import { GeckoTerminalClient } from '../data/geckoterminal';
import { RaydiumClient } from '../data/raydium';
import { DataRuntime } from '../data/core/data-runtime';
import { Logger } from '../utils/logger';
/** Public read-only smoke check. No wallet or Jupiter key is loaded. */
async function main(): Promise<void> {
  const log = new Logger('data-smoke'); const data = new DataRuntime(log);
  const dex = new DexScreenerClient(log, data); const gecko = new GeckoTerminalClient(log, data); const ray = new RaydiumClient(log, data);
  const results = await Promise.allSettled([dex.getLatestProfiles(), gecko.getTrendingPools(), ray.listPools({ sortField: 'volume24h', pageSize: 3 })]);
  results.forEach((r, i) => log.info('Public provider check', { source: ['dexscreener', 'geckoterminal', 'raydium'][i],
    ok: r.status === 'fulfilled', count: r.status === 'fulfilled' ? r.value.length : null }));
  if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
}
void main().catch(() => { process.exitCode = 1; });

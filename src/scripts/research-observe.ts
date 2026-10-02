/**
 * Research observer: records every pump.fun launch, its trades, metadata, X posts and website as observed facts.
 * Read-only: it never signs, never trades and never reads a private key.
 *
 *   npm run research:observe -- [--dir data-desk/research] [--sources public,publicnode[,helius]] [--min-free-mb 700]
 *
 * Trade sources are merged, each transaction once. "helius" adds the first Helius endpoint of RPC_ENDPOINTS;
 * Helius may bill websocket traffic against the plan's credits, so it is off unless asked for.
 */
import path from 'node:path';
import { deskEnvironment } from '../desk/runtime';
import { ResearchLedger } from '../research/ledger';
import { ResearchObserver, PUBLIC_RPC_WS, PUBLICNODE_WS } from '../research/observer';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const repo = path.resolve(arg('env') ?? '.'), env = await deskEnvironment(repo);
  const dir = path.resolve(arg('dir') ?? path.join(repo, 'data-desk', 'research'));
  const wanted = (arg('sources') ?? process.env.RESEARCH_SOURCES ?? 'public,publicnode').split(',').map(s => s.trim().toLowerCase());
  const sources: string[] = [];
  if (wanted.includes('public')) sources.push(PUBLIC_RPC_WS);
  if (wanted.includes('publicnode')) sources.push(PUBLICNODE_WS);
  if (wanted.includes('helius')) {
    const helius = (env.RPC_ENDPOINTS ?? '').split(',').map(s => s.trim()).find(s => /helius/i.test(s));
    if (helius) sources.push(helius.replace(/^http/, 'ws')); else console.log('no Helius endpoint in RPC_ENDPOINTS; public RPC only');
  }
  if (!sources.length) sources.push(PUBLIC_RPC_WS);
  const ledger = new ResearchLedger({ dir, minFreeMb: Number(arg('min-free-mb') ?? process.env.RESEARCH_MIN_FREE_MB ?? 700) });
  await ledger.start();
  const observer = new ResearchObserver({ ledger, tradeSources: sources, log: line => console.log(line) });
  observer.start();
  console.log(`research observer: ${dir} · trade sources: ${wanted.filter(w => ['public', 'publicnode', 'helius'].includes(w)).join(' + ') || 'public'} · status every 10 min`);
  const stop = async () => { observer.stop(); await ledger.close(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  setInterval(() => console.log(observer.status()), 60_000).unref();
}

main().catch(error => { console.error(`research:observe failed: ${(error as Error).message}`); process.exit(1); });

/**
 * Holder scan for one Solana token: its 20 largest holders, who funded each wallet, clusters (one actor behind several
 * wallets), the team's share (developer, wallets it funded, wallets sharing its funder) and fresh wallets. Read-only.
 *
 *   npm run research:holders -- <mint> [--dev <wallet>]
 *
 * Uses the Helius endpoint in RPC_ENDPOINTS when there is one (about 45 calls), and Jupiter for the developer wallet.
 */
import { Connection } from '@solana/web3.js';
import { deskEnvironment } from '../desk/runtime';
import { rpcHolders, scanHolders } from '../research/holders';
import { JupiterTokens } from '../research/verified';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const short = (a: string | null) => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '–';

async function main(): Promise<void> {
  const mint = process.argv.slice(2).find(a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
  if (!mint) throw new Error('usage: npm run research:holders -- <mint> [--dev <wallet>]');
  const env = await deskEnvironment('.');
  const endpoints = (env.RPC_ENDPOINTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const url = endpoints.find(e => /helius/i.test(e)) ?? endpoints[0] ?? 'https://api.mainnet-beta.solana.com';
  const token = (await new JupiterTokens({ apiKey: env.JUPITER_API_KEY?.trim() || null }).get(`search?query=${mint}`).catch(() => []))[0];
  const dev = arg('dev') ?? token?.dev ?? null;
  const s = await scanHolders(rpcHolders(new Connection(url, 'confirmed')), mint, { dev });
  console.log(`${token?.symbol ?? mint} · supply ${s.supply.toLocaleString('en-US')} · developer ${short(dev)}${s.devFunder ? ` (funded by ${short(s.devFunder)})` : ''}`);
  console.log(`  top 20: ${s.topPct.toFixed(1)} % (programs/pools ${s.programPct.toFixed(1)} %, wallets ${s.walletPct.toFixed(1)} %)`);
  console.log(`  clusters ${s.clusterPct.toFixed(1)} % · team ${s.teamPct.toFixed(1)} % · wallets under 7 days old ${s.freshPct.toFixed(1)} %` +
    `${s.largest ? ` · largest cluster ${s.largest.pct.toFixed(1)} % in ${s.largest.wallets} wallets (funder ${short(s.largest.funder)})` : ''}` +
    `${s.services.length ? ` · ${s.services.length} busy funder(s) ignored (exchanges/services)` : ''}`);
  for (const h of s.holders) {
    console.log(`  ${h.pct.toFixed(2).padStart(6)} %  ${h.owner}  ${h.kind === 'program' ? 'program/pool' : `wallet · ${h.busy ? '1000+ tx' : h.firstAt ? `first tx ${new Date(h.firstAt).toISOString().slice(0, 10)}` : 'no history'}` +
      ` · funded by ${short(h.funder)}${h.cluster !== null ? ` · cluster ${h.cluster}` : ''}${h.team ? ' · TEAM' : ''}`}`);
  }
}

main().catch(error => { console.error(`research:holders failed: ${(error as Error).message}`); process.exit(1); });

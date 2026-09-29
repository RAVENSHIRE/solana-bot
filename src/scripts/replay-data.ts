import path from 'node:path';
import { replay } from '../data/storage/market-data-store';
/** Offline inspection only: never loads config, wallet, network clients or executors. */
async function main(): Promise<void> {
  const [dir, mode, cutoff] = process.argv.slice(2);
  if (!dir || !['SIMULATION', 'LIVE'].includes(mode ?? '') || !cutoff || !Number.isFinite(Date.parse(cutoff)))
    throw new Error('Usage: npm run data:replay -- <history-directory> SIMULATION|LIVE <ISO-as-of>');
  for await (const row of replay(path.resolve(dir), mode as 'SIMULATION' | 'LIVE', Date.parse(cutoff))) {
    if (!process.stdout.write(JSON.stringify(row) + '\n')) await new Promise<void>(resolve => process.stdout.once('drain', resolve));
  }
}
void main().catch(() => { process.stderr.write('Replay failed: check arguments and history integrity\n'); process.exitCode = 1; });

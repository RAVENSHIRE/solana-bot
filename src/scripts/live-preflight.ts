/** Read-only: validates credentials, mainnet, balance and real Jupiter quotes. Never signs or sends. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNT_SIZE } from '@solana/spl-token';
import { loadConfig } from '../config/config';
import { SOL_MINT, USDC_MINT, BASE_FEE_LAMPORTS } from '../core/types';
import { ConnectionManager } from '../rpc/connection-manager';
import { JupiterClient } from '../execution/jupiter-client';
import { loadWalletFromEnv } from '../utils/wallet';
import { rootLogger as log } from '../utils/logger';
import { solToLamports, lamportsToSol } from '../utils/format';
import { safeInteger, parse } from '../data/core/data-validator';
import { redactText } from '../utils/redact';

async function main(): Promise<void> {
  const cfg = loadConfig({ ...process.env, SIMULATION_MODE: 'true' });
  const wallet = loadWalletFromEnv();
  const rpc = new ConnectionManager(cfg.rpc.endpoints, {
    commitment: 'confirmed', maxRps: cfg.rpc.maxRps, timeoutMs: cfg.rpc.timeoutMs, logger: log,
  });
  const genesis = await rpc.execute('getGenesisHash', c => c.getGenesisHash());
  if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Mainnet RPC required');
  const balance = BigInt(parse(safeInteger, await rpc.execute('getBalance', c => c.getBalance(wallet.publicKey)), 'solana-rpc'));
  const rent = BigInt(parse(safeInteger, await rpc.execute('getRent', c => c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)), 'solana-rpc'));
  // Reserve for a conventional token account plus two base/maximum priority fees.
  // Token extensions or more complex routes may require additional funds; this is not a fee guarantee.
  const reserve = rent + 2n * (BASE_FEE_LAMPORTS + BigInt(cfg.jupiter.maxPriorityFeeLamports));
  const input = solToLamports(cfg.rs.tradeSizeSol);
  const rawBudget = process.env.LIVE_TEST_BUDGET_SOL;
  if (rawBudget !== undefined) {
    const budget = Number(rawBudget);
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid LIVE_TEST_BUDGET_SOL');
    if (balance > solToLamports(budget)) throw new Error('Wallet balance exceeds test budget. Use a separately funded test wallet.');
    if (balance < input + reserve) throw new Error(`Insufficient balance: entry plus estimated reserve needs ${lamportsToSol(input + reserve, 9)} SOL`);
  }
  const jupiter = new JupiterClient(cfg.jupiter, log);
  const buy = await jupiter.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amountRaw: input, slippageBps: cfg.execution.defaultSlippageBps });
  const sell = await jupiter.quote({ inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: BigInt(buy.otherAmountThreshold), slippageBps: cfg.execution.defaultSlippageBps });
  const report = {
    checkedAt: new Date().toISOString(), readOnly: true, wallet: wallet.publicKey.toBase58(), genesis,
    balanceSol: Number(balance) / 1e9, probeInputSol: cfg.rs.tradeSizeSol,
    minimumProbeUsdc: Number(buy.otherAmountThreshold) / 1e6,
    minimumReturnSol: Number(sell.otherAmountThreshold) / 1e9,
    reserveSol: Number(reserve) / 1e9, budgetChecked: rawBudget !== undefined,
    scope: 'RPC, wallet and SOL/USDC quotes only; no memecoin sellability or profitability guarantee',
  };
  await fs.mkdir(cfg.stateDir, { recursive: true });
  await fs.writeFile(path.join(cfg.stateDir, 'live-preflight.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(redactText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });

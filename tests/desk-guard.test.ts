import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DeskGuard, EXIT_PRIORITY, type DeskGuardDeps } from '../src/desk/guard';
import { SOL_MINT } from '../src/core/types';
import type { JupiterQuote } from '../src/execution/jupiter-client';
import type { SwapRequest } from '../src/execution/executor';
import { LiveExecutor } from '../src/execution/live-executor';

// DeskGuard boundaries (CTO quality ledger Q-15): each pre-signature gate exactly at its limit and one lamport past it.
// Synthetic fixtures only; nothing is signed or sent.

const owner = Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey;
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(72)).publicKey.toBase58();
const RENT = 2_039_280n, RESERVE = 3_000_000n, CAP = 100_000n, BASE_FEE = 5_000n;
const ENTRY = 20_000_000n; // $2 at $100 per SOL

function guard(o: { native?: bigint; mode?: 'PAPER' | 'LIVE'; paperCash?: bigint | null; heldRaw?: bigint; drill?: boolean; stopped?: boolean; exitSlippageBps?: number; rpc?: unknown } = {}) {
  const connection = {
    getBalance: async () => Number(o.native ?? 1_000_000_000n),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getMinimumBalanceForRentExemption: async () => Number(RENT),
  };
  const events: string[] = [];
  const deps: DeskGuardDeps = {
    mode: o.mode ?? 'LIVE', rpc: (o.rpc ?? { execute: async (_l: string, fn: (c: typeof connection) => unknown) => fn(connection) }) as never,
    jupiter: { assertFresh: () => undefined } as never, owner, mint: MINT, symbol: 'TEST', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, solUsd: 100,
    slippageBps: 100, exitSlippageBps: o.exitSlippageBps, maxDragBps: 150n, reserveLamports: RESERVE, configuredPriorityCap: CAP, baseEntryUsd: 2,
    paperCashLamports: o.paperCash ?? null, heldRaw: o.heldRaw ?? 0n, stopped: () => o.stopped ?? false, enforceDrag: o.drill ? false : undefined,
    onSigned: async () => undefined, event: (stage, message) => { events.push(`${stage} ${message}`); },
  };
  return { g: new DeskGuard(deps), events };
}
const buy = (inAmount: bigint, out: bigint, min: bigint, slippageBps = 100): [SwapRequest, JupiterQuote] => [
  { side: 'BUY', mint: MINT, amountRaw: inAmount, slippageBps },
  { inputMint: SOL_MINT, outputMint: MINT, inAmount: String(inAmount), outAmount: String(out), otherAmountThreshold: String(min), swapMode: 'ExactIn', slippageBps, priceImpactPct: '0', routePlan: [] } as JupiterQuote,
];
const sell = (amount: bigint, out: bigint, min: bigint, slippageBps = 100): [SwapRequest, JupiterQuote] => [
  { side: 'SELL', mint: MINT, amountRaw: amount, slippageBps },
  { inputMint: MINT, outputMint: SOL_MINT, inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(min), swapMode: 'ExactIn', slippageBps, priceImpactPct: '0', routePlan: [] } as JupiterQuote,
];
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c);

test('max drag: an entry whose slippage + fees use exactly the 1.5 % budget passes; one lamport more is FEE_CAP', async () => {
  // Budget 1.5 % of 0.02 SOL = 300,000 lamports; base fee 5,000; slippage 295,000 leaves 0 for the priority fee.
  const { g } = guard();
  const at = await g.beforeBuild(...buy(ENTRY, 1_000_000n, 985_250n));
  assert.equal(at.priorityFeeCapLamports, 0, 'nothing left for a priority fee');
  await code(guard().g.beforeBuild(...buy(ENTRY, 1_000_000n, 985_249n)), 'FEE_CAP');
  // A TEST drill may exceed the drag (reported), never the other gates.
  const drill = guard({ drill: true, mode: 'PAPER', paperCash: 1_000_000_000n });
  await drill.g.beforeBuild(...buy(ENTRY, 1_000_000n, 900_000n));
  assert.ok(drill.events.some(e => e.includes('DRILL: drag above')));
});

test('reserve floor: the wallet must keep 0.003 SOL after the order, fees and the account-rent budget', async () => {
  // No slippage: priority = the configured cap. Needed = entry + (base fee + cap) + ATA rent + temp rent + reserve.
  const need = ENTRY + BASE_FEE + CAP + RENT + RENT + RESERVE;
  await guard({ native: need }).g.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n));
  await code(guard({ native: need - 1n }).g.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n)), 'SOL_RESERVE_FLOOR');
});

test('TEST sleeve: an entry needs paper cash for the order, fees and rent, to the lamport', async () => {
  const need = ENTRY + BASE_FEE + CAP + RENT + RENT;
  await guard({ mode: 'PAPER', paperCash: need }).g.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n));
  await code(guard({ mode: 'PAPER', paperCash: need - 1n }).g.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n)), 'TEST_CAPITAL_INSUFFICIENT');
});

test('size, slippage and identity: oversize entries, escalated slippage and a swapped pair are refused before any build', async () => {
  await code(guard().g.beforeBuild(...buy(20_500_000n, 1_000_000n, 1_000_000n)), 'POSITION_SIZE_LIMIT');
  await code(guard().g.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n, 101)), 'SLIPPAGE_ESCALATION_BLOCKED');
  const [req, q] = buy(ENTRY, 1_000_000n, 1_000_000n);
  await code(guard().g.beforeBuild(req, { ...q, slippageBps: 50 }), 'SLIPPAGE_ESCALATION_BLOCKED');
  await code(guard().g.beforeBuild(req, { ...q, inAmount: String(ENTRY + 1n) }), 'PAIR_OR_AMOUNT_MISMATCH');
  await code(guard().g.beforeBuild(req, { ...q, outputMint: SOL_MINT }), 'PAIR_OR_AMOUNT_MISMATCH');
  await code(guard({ stopped: true }).g.beforeBuild(req, q), 'STOP_REQUESTED');
});

test('exits: never capped by drag or TEST cash, only the tracked size, the exit slippage limit and the 1 % priority budget', async () => {
  const held = 1_000_000n;
  // A dump: 40 % under the quote is accepted for a sell (risk reduction), with TEST cash at zero.
  const exit = guard({ mode: 'PAPER', paperCash: 0n, heldRaw: held, exitSlippageBps: 1_000 });
  const r = await exit.g.beforeBuild(...sell(held, 2_000_000n, 1_200_000n, 1_000));
  assert.equal(BigInt(r.priorityFeeCapLamports), EXIT_PRIORITY.floorLamports, '1 % of 0.002 SOL (20,000) is under the 50,000 floor');
  const mid = await guard({ heldRaw: held, mode: 'PAPER' }).g.beforeBuild(...sell(held, 8_000_000n, 8_000_000n));
  assert.equal(mid.priorityFeeCapLamports, 80_000, '1 % of what the sell returns');
  const big = await guard({ heldRaw: held, mode: 'PAPER' }).g.beforeBuild(...sell(held, 9_000_000_000n, 9_000_000_000n));
  assert.equal(BigInt(big.priorityFeeCapLamports), CAP, 'never above the configured cap');
  await code(guard({ heldRaw: held, exitSlippageBps: 1_000 }).g.beforeBuild(...sell(held, 20_000_000n, 12_000_000n, 1_001)), 'SLIPPAGE_ESCALATION_BLOCKED');
  await code(guard({ heldRaw: held }).g.beforeBuild(...sell(held + 1n, 20_000_000n, 20_000_000n)), 'UNTRACKED_POSITION');
  // LIVE: the wallet must hold the tokens it sells (the fake wallet holds none).
  await code(guard({ heldRaw: held, mode: 'LIVE' }).g.beforeBuild(...sell(held, 20_000_000n, 20_000_000n)), 'UNTRACKED_POSITION');
});

test('execution review X2/X3: rent read once per RPC manager, the wallet read runs while the quote is asked, one simulation per order, every step marked', async () => {
  const reads = { rent: 0, balance: 0 };
  const connection = { getBalance: async () => { reads.balance++; return 1_000_000_000; }, getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getMinimumBalanceForRentExemption: async () => { reads.rent++; return Number(RENT); } };
  const rpc = { execute: async (_l: string, fn: (c: typeof connection) => unknown) => fn(connection) };
  const a = guard({ rpc }).g, b = guard({ rpc }).g;
  await a.snapshot(); await a.snapshot(); await b.snapshot();
  assert.equal(reads.rent, 1, 'the 165-byte minimum is read once, not twice per snapshot (three snapshots per buy)');
  // The snapshot started with the quote is the one beforeBuild uses: one wallet read, not two.
  const c = guard({ rpc }).g, before = reads.balance;
  c.prefetch(); await c.beforeBuild(...buy(ENTRY, 1_000_000n, 1_000_000n));
  assert.equal(reads.balance - before, 1);
  assert.ok(c.marks.quoted, 'the quote step is marked'); assert.equal(c.simulates, true);
  // The executor skips its own pre-simulation when the guard simulates; a guard that does not keeps it.
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message());
  for (const simulates of [true, false]) {
    let sims = 0;
    const g = { simulates, beforeBuild: async () => ({ priorityFeeCapLamports: 0 }), beforeSign: async () => undefined,
      beforeSend: async () => { throw new Error('stop before signing'); } };
    const jupiter = { quote: async () => buy(ENTRY, 1_000_000n, 1_000_000n)[1], assertFresh: () => undefined,
      buildSwap: async () => ({ swapTransaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 1, prioritizationFeeLamports: 0 }) };
    const exec = new LiveExecutor({ cfg: { execution: { preSimulate: true, maxPriceImpactPct: 5 } }, owner, guard: g, jupiter, logger: { debug: () => undefined },
      rpc: { execute: async (label: string, fn: (c: unknown) => unknown) => { if (label === 'simulateTransaction') sims++; return fn({ simulateTransaction: async () => ({ value: { err: null, logs: [] } }) }); } } } as never,
      { publicKey: owner, signTransaction: async () => { throw new Error('never signed'); } } as never, {} as never);
    await assert.rejects(exec.swap(buy(ENTRY, 1_000_000n, 1_000_000n)[0]), /stop before signing/);
    assert.equal(sims, simulates ? 0 : 1, simulates ? 'the guard already simulated' : 'no guard simulation: the executor simulates');
  }
});

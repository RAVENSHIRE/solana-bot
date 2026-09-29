import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Portfolio } from '../src/core/portfolio';
import { RiskManager } from '../src/core/risk-manager';
import { BASE_FEE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, type Candle, type Position } from '../src/core/types';
import { SwapError, type TradeExecutor, type SwapRequest, type SwapFill } from '../src/execution/executor';
import { SimulatedExecutor } from '../src/execution/simulated-executor';
import { Logger, configureLogger } from '../src/utils/logger';
import { config } from '../src/strategies/reversal-sniper/playbook/runtime';
import { PLAYBOOK, evaluate, hasThirtyMinuteSupport, type Snapshot, type EntryEvidence, type Cycle } from '../src/strategies/reversal-sniper/playbook/model';
import { PlaybookController } from '../src/strategies/reversal-sniper/playbook/controller';
import { ownerConcentration, volumeWindow } from '../src/strategies/reversal-sniper/playbook/market';
import { validateQuote } from '../src/strategies/reversal-sniper/playbook/quotes';
import { PlaybookTelemetry } from '../src/strategies/reversal-sniper/playbook/telemetry';
import { adaptTelemetry } from '../dashboard/server/telemetry-adapter';

configureLogger({ level: 'error', color: false });
const log = new Logger('test');
const now = 1_800_000_000_000;
const snapshot: Snapshot = { mint: 'test-mint', symbol: 'TEST', pairAddress: 'test-pair', observedAt: now,
  priceUsd: 1, solUsd: 1000, marketCapUsd: 100_000, liquidityUsd: 50_000, hasWebsite: true, hasTwitter: true };
const evidence: EntryEvidence = { safetyOk: true, safetyReasons: [], top10OwnerFraction: 0.2,
  buyVolumeUsd: 700, sellVolumeUsd: 300, completeVolumeWindow: true, consolidated: true };
const opts = { now, maxCap: 1_000_000, initialStopPct: 12, maxHoldMs: 360 * 60_000 };
const cycle: Cycle = { mint: snapshot.mint, symbol: 'TEST', pairAddress: snapshot.pairAddress, decimals: 0,
  phase: 'holding', initialSizeLamports: 200_000_000n, peakUsd: 1, reEntryUsed: false, positionId: 'pos' };
const position = (): Position => ({ id: 'pos', strategy: PLAYBOOK, mint: snapshot.mint, symbol: 'TEST', decimals: 0,
  pairAddress: snapshot.pairAddress, tokenAmountRaw: 200n, costLamports: 200_000_000n, entryInputLamports: 200_000_000n,
  entryPriceUsd: 1, openedAt: now, peakValueLamports: 200_000_000n, lastValueLamports: 200_000_000n, lastCheckedAt: now,
  exitRules: { takeProfitPct: 0, stopLossPct: 12, trailingActivationPct: 100, trailingStopPct: 20, maxHoldMs: opts.maxHoldMs },
  entrySignal: 'test', tags: { playbookOriginalRaw: '200', playbookPeakUsd: 1, playbook2x: false, playbook5x: false, playbookReentry: false },
  closing: false, exitFailures: 0, valuationMisses: 0 });

test('entry requires strict market-cap/volume bounds and actual evidence', () => {
  assert.equal(evaluate(snapshot, undefined, undefined, evidence, opts).type, 'BUY');
  for (const invalid of [
    { ...evidence, buyVolumeUsd: 650, sellVolumeUsd: 350 }, { ...evidence, buyVolumeUsd: 0, sellVolumeUsd: 0 },
    { ...evidence, buyVolumeUsd: NaN }, { ...evidence, completeVolumeWindow: false },
    { ...evidence, top10OwnerFraction: null }, { ...evidence, top10OwnerFraction: .250001 },
    { ...evidence, safetyOk: false },
  ]) assert.equal(evaluate(snapshot, undefined, undefined, invalid, opts).type, 'SKIP');
  for (const invalid of [{ ...snapshot, marketCapUsd: 1_000_000 }, { ...snapshot, marketCapUsd: null },
    { ...snapshot, hasTwitter: false }, { ...snapshot, hasWebsite: false }])
    assert.equal(evaluate(invalid, undefined, undefined, evidence, opts).type, 'SKIP');
  assert.equal(evaluate(snapshot, undefined, undefined, { ...evidence, top10OwnerFraction: .25 }, opts).type, 'BUY');
});
test('stale, future or invalid prices never trade', () => {
  for (const price of [0, NaN, Infinity, -1]) assert.equal(evaluate({ ...snapshot, priceUsd: price }, cycle, position(), undefined, opts).type, 'WAIT');
  for (const observedAt of [now - 90_001, now + 1]) assert.equal(evaluate({ ...snapshot, observedAt }, cycle, position(), evidence, opts).type, 'WAIT');
});
test('exit checks ignore unavailable/failed entry safety; stops precede taking profit', () => {
  const p = position(); p.tags.playbook2x = true; p.tags.playbookPeakUsd = 10;
  assert.match(evaluate({ ...snapshot, priceUsd: 8 }, cycle, p, { ...evidence, safetyOk: false }, opts).reason, /TRAILING/);
  assert.match(evaluate({ ...snapshot, priceUsd: .88 }, cycle, position(), undefined, opts).reason, /INITIAL_STOP/);
  p.tags.playbookReentry = true; p.tags.playbookPeakUsd = 1;
  assert.match(evaluate({ ...snapshot, priceUsd: .9 }, cycle, p, undefined, opts).reason, /REENTRY_STOP/);
});
test('Phoenix only after full exit, 80% drop, support and strict reversal volume', () => {
  const watched = { ...cycle, phase: 'watching' as const, positionId: null, peakUsd: 5 };
  assert.equal(evaluate(snapshot, watched, undefined, evidence, opts).type, 'RE_ENTRY');
  for (const invalid of [{ ...evidence, consolidated: false }, { ...evidence, buyVolumeUsd: 450, sellVolumeUsd: 300 }])
    assert.equal(evaluate(snapshot, watched, undefined, invalid, opts).type, 'WAIT');
  assert.equal(evaluate({ ...snapshot, priceUsd: 1.01 }, watched, undefined, evidence, opts).type, 'WAIT');
  assert.equal(evaluate(snapshot, { ...watched, reEntryUsed: true }, undefined, evidence, opts).type, 'SKIP');
});
test('support requires 30 full minutes after a low and rejects missing/duplicate/new-low candles', () => {
  const candles: Candle[] = Array.from({ length: 31 }, (_, i) => ({ t: now - (31 - i) * 60_000, o: 1.1, h: 1.2, l: i === 0 ? 1 : 1.05, c: 1.1, v: 10 }));
  assert.equal(hasThirtyMinuteSupport(candles, now, 1.1), true);
  assert.equal(hasThirtyMinuteSupport(candles.slice(1), now, 1.1), false);
  assert.equal(hasThirtyMinuteSupport([...candles.slice(1), candles[1]!], now, 1.1), false);
  assert.equal(hasThirtyMinuteSupport(candles.map((c, i) => i === 15 ? { ...c, l: .99 } : c), now, 1.1), false);
  assert.equal(hasThirtyMinuteSupport(candles, now + 60_000, 1.1), false);
  assert.equal(hasThirtyMinuteSupport(candles, now, .99), false);
});
test('holder aggregation detects split wallets and rejects incomplete supply', () => {
  const accounts = Array.from({ length: 100 }, (_, i) => ({ owner: `owner${i}`, amount: 1n }));
  assert.equal(ownerConcentration(accounts, 100n), .1);
  assert.equal(ownerConcentration(accounts.map((a, i) => ({ ...a, owner: i < 30 ? 'same-wallet' : a.owner })), 100n), .39);
  assert.throws(() => ownerConcentration(accounts.slice(1), 100n), /reconcile/);
});
test('volume uses USD amounts, deduplicates IDs, and rejects truncated or stale windows', () => {
  const trade = (id: string, kind: 'buy' | 'sell', volume: number, at: number) => ({ id, attributes: { kind, volume_in_usd: volume, block_timestamp: new Date(at).toISOString(),
    from_token_address: kind === 'buy' ? 'quote' : 'mint', to_token_address: kind === 'buy' ? 'mint' : 'quote' } });
  const buy = trade('buy', 'buy', 900, now - 1000);
  const rows = [trade('old', 'sell', 5000, now - 301_000), buy, buy, trade('sell', 'sell', 100, now - 2000)];
  assert.deepEqual(volumeWindow(rows, now, 'mint'), { buyVolumeUsd: 900, sellVolumeUsd: 100, completeVolumeWindow: true });
  assert.equal(volumeWindow(rows.slice(1), now, 'mint').completeVolumeWindow, false);
  assert.equal(volumeWindow(rows, now + 100_000, 'mint').completeVolumeWindow, false);
  assert.deepEqual(volumeWindow(rows.map(t => ({ ...t, attributes: { ...t.attributes, kind: t.attributes.kind === 'buy' ? 'sell' : 'buy' } })), now, 'mint'),
    { buyVolumeUsd: 900, sellVolumeUsd: 100, completeVolumeWindow: true });
});

class Executor implements TradeExecutor {
  readonly mode = 'SIMULATION'; readonly owner = Keypair.generate().publicKey;
  calls: SwapRequest[] = []; price = 1; fail = false; rentCalls = 0;
  constructor(private readonly portfolio: Portfolio) {}
  async swap(req: SwapRequest): Promise<SwapFill> {
    this.calls.push(req);
    if (this.fail) throw new SwapError('test slippage failure', 'slippage', BASE_FEE_LAMPORTS);
    const out = req.side === 'BUY' ? BigInt(Math.floor(Number(req.amountRaw) / 1e9 * 1000 / this.price)) : BigInt(Math.floor(Number(req.amountRaw) * this.price / 1000 * 1e9));
    const rent = req.side === 'BUY' ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n;
    return { simulated: true, signature: null, side: req.side, mint: req.mint, inAmountRaw: req.amountRaw,
      outAmountRaw: out, quotedOutRaw: out, minOutRaw: out, solDeltaLamports: req.side === 'BUY' ? -(req.amountRaw + BASE_FEE_LAMPORTS + rent) : out - BASE_FEE_LAMPORTS,
      feeLamports: BASE_FEE_LAMPORTS, rentLamports: rent, priceImpactPct: 0, realizedSlippageBps: 0, route: 'test', latencyMs: 1 };
  }
  async getSolBalanceLamports() { return this.portfolio.virtualSolLamports(); }
  async getTokenBalanceRaw(mint: string) { return this.portfolio.positions().filter(p => p.mint === mint).reduce((n, p) => n + p.tokenAmountRaw, 0n); }
  async closeTokenAccountIfEmpty() { this.rentCalls++; return TOKEN_ACCOUNT_RENT_LAMPORTS - BASE_FEE_LAMPORTS; }
  async reclaimEmptyAccounts() { return { found: 0, closed: 0, reclaimableLamports: 0n, reclaimedLamports: 0n, signatures: [] }; }
  async estimatePriorityFeeLamports() { return 0n; }
}
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playbook-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const cfg = config({ RPC_ENDPOINTS: 'https://example.invalid', JUPITER_API_KEY: 'test', PLAYBOOK_STATE_DIR: dir }).cfg;
  const portfolio = await Portfolio.load(dir, 'SIMULATION', 10_000_000_000n, log);
  const executor = new Executor(portfolio);
  const records: unknown[] = [];
  const makeController = (pf = portfolio, ex = executor) => new PlaybookController(pf, ex, new RiskManager(cfg.risk, pf, log), cfg,
    { ...opts, tradeSizeLamports: 200_000_000n }, r => records.push(r));
  const control = makeController();
  const step = (price: number, at = now, e: EntryEvidence | undefined = evidence) => {
    executor.price = price; return control.process({ ...snapshot, priceUsd: price, observedAt: at }, e, 0, at);
  };
  return { cfg, dir, portfolio, executor, control, records, step, makeController };
}
test('gap above 5x sells 50% then 25% ORIGINAL tokens once; cash/cost/fees reconcile', async t => {
  const f = await fixture(t);
  assert.equal((await f.step(1)).type, 'BUY');
  const initialCost = f.portfolio.positions()[0]!.costLamports;
  await f.step(5, now + 1);
  assert.equal(f.portfolio.positions()[0]!.tokenAmountRaw, 100n);
  await f.step(5, now + 2);
  assert.equal(f.portfolio.positions()[0]!.tokenAmountRaw, 50n);
  await f.step(5, now + 3);
  assert.equal(f.executor.calls.length, 3);
  assert.equal(f.executor.rentCalls, 0);
  assert.equal(f.portfolio.recentClosed().reduce((n, p) => n + p.costLamports, 0n) + f.portfolio.positions()[0]!.costLamports, initialCost);
  await f.step(4, now + 4); // exact trailing stop threshold
  assert.equal(f.portfolio.positions().length, 0);
  assert.equal(f.executor.rentCalls, 1);
  assert.equal(f.portfolio.stats(PLAYBOOK).feesLamports, BASE_FEE_LAMPORTS * 5n);
  assert.equal(f.portfolio.virtualSolLamports() - 10_000_000_000n, f.portfolio.stats(PLAYBOOK).realizedPnlLamports);
  assert.equal(f.control.cycles.get(snapshot.mint)!.phase, 'watching');
});
test('failed exit charges fees without flags/balance changes and retries once successful', async t => {
  const f = await fixture(t); await f.step(1);
  f.executor.fail = true;
  const before = f.portfolio.virtualSolLamports();
  await f.step(2, now + 1);
  assert.equal(f.portfolio.positions()[0]!.tags.playbook2x, false);
  assert.equal(f.portfolio.positions()[0]!.tokenAmountRaw, 200n);
  assert.equal(f.portfolio.virtualSolLamports(), before - BASE_FEE_LAMPORTS);
  f.executor.fail = false; await f.step(2, now + 2);
  assert.equal(f.portfolio.positions()[0]!.tokenAmountRaw, 100n);
});
test('restart preserves 2x flag; post-exit Phoenix opens a separate 25% lot and cannot repeat', async t => {
  const f = await fixture(t); await f.step(1); await f.step(2, now + 1);
  const restored = await Portfolio.load(f.dir, 'SIMULATION', 999n, log);
  const executor = new Executor(restored);
  const controller = f.makeController(restored, executor);
  const step = (px: number, at: number) => { executor.price = px; return controller.process({ ...snapshot, priceUsd: px, observedAt: at }, evidence, 0, at); };
  await step(2, now + 2);
  assert.equal(executor.calls.length, 0);
  await step(1.6, now + 3);
  assert.equal(restored.positions().length, 0);
  assert.equal(controller.cycles.get(snapshot.mint)!.phase, 'watching');
  assert.equal((await step(.4, now + 4)).type, 'RE_ENTRY');
  const reentry = restored.positions()[0]!;
  assert.equal(reentry.entryInputLamports, 50_000_000n);
  assert.equal(reentry.tags.playbookReentry, true);
  assert.equal(reentry.entryPriceUsd, .4);
  await step(.36, now + 5);
  assert.equal(restored.positions().length, 0);
  assert.equal((await step(.35, now + 6)).type, 'SKIP');
  await restored.flush();
  const reload = await Portfolio.load(f.dir, 'SIMULATION', 999n, log);
  assert.equal(f.makeController(reload, new Executor(reload)).cycles.get(snapshot.mint)!.phase, 'done');
  assert.equal(reload.virtualSolLamports() - 10_000_000_000n, reload.stats(PLAYBOOK).realizedPnlLamports);
});
test('concurrent evaluations cannot duplicate entries or sell a tranche twice', async t => {
  const f = await fixture(t);
  await Promise.all([f.step(1), f.step(1)]);
  assert.equal(f.executor.calls.length, 1);
  await Promise.all([f.step(2, now + 1), f.step(2, now + 1)]);
  assert.equal(f.executor.calls.length, 2);
  assert.equal(f.portfolio.positions()[0]!.tokenAmountRaw, 100n);
});
test('risk gate blocks entries but does not block exits after daily loss', async t => {
  const f = await fixture(t); await f.step(1);
  f.portfolio.chargeFee(PLAYBOOK, 200_000_000n);
  assert.equal((await f.step(.88, now + 1)).type, 'SELL');
  const s = { ...snapshot, mint: 'different', observedAt: now + 2 };
  assert.match((await f.control.process(s, evidence, 0, now + 2)).reason, /RISK/);
});
test('unknown positions cannot be silently adopted', async t => {
  const f = await fixture(t); f.portfolio.openPosition(position());
  assert.throws(() => f.makeController(), /Unrecognized/);
  await f.portfolio.flush();
});
test('strict paper restart never resets corrupt or wrong-mode state', async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'state-SIMULATION.json');
  for (const raw of ['{broken', '{"mode":"LIVE"}', '{"mode":"SIMULATION","virtualSolLamports":{"$bigint":"bad"}}']) {
    await fs.writeFile(file, raw);
    await assert.rejects(Portfolio.load(f.dir, 'SIMULATION', 10_000_000_000n, log, true), /unlesbar/);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});
test('partial raw-unit rounding conserves basis and leaves dust for final close', async t => {
  const f = await fixture(t);
  const p = position(); p.tokenAmountRaw = 7n; p.costLamports = 101n; p.entryInputLamports = 97n; p.tags.playbookRent = '3';
  f.portfolio.openPosition(p);
  f.portfolio.closePartial(p.id, 3n, 100n, '2x');
  f.portfolio.closePartial(p.id, 1n, 100n, '5x');
  f.portfolio.closePosition(p.id, 100n, 'close');
  assert.equal(f.portfolio.recentClosed().reduce((n, t) => n + t.costLamports, 0n), 101n);
  assert.equal(f.portfolio.stats(PLAYBOOK).realizedPnlLamports, 199n);
  await f.portfolio.flush();
});
test('paper profile forces simulation, isolated state and ignores wallet secret', () => {
  const c = config({ SIMULATION_MODE: 'false', WALLET_PRIVATE_KEY: 'do-not-use', RPC_ENDPOINTS: 'https://example.invalid', JUPITER_API_KEY: 'test' });
  assert.equal(c.cfg.mode, 'SIMULATION'); assert.equal(c.cfg.paper.startingBalanceSol, 10);
  assert.equal(c.cfg.rs.tradeSizeSol, .2); assert.equal(c.cfg.paper.useWalletBalance, false);
  assert.throws(() => config({ PLAYBOOK_STATE_DIR: './data' }), /separate/);
});
const request = { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountRaw: 100n, slippageBps: 150 };
const quote = { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '100', outAmount: '1000', otherAmountThreshold: '985', swapMode: 'ExactIn', slippageBps: 150,
  priceImpactPct: '0.01', routePlan: [{ percent: 100, swapInfo: { ammKey: '11111111111111111111111111111111', inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '100', outAmount: '1000' } }] };
test('invalid quote impact and mismatched input cannot be accepted as zero impact', () => {
  assert.equal(validateQuote(quote, request).outAmount, '1000');
  for (const patch of [{ priceImpactPct: 'NaN' }, { priceImpactPct: '' }, { inAmount: '99' }, { outputMint: 'other' }, { outAmount: '0' }, { otherAmountThreshold: '1001' }])
    assert.throws(() => validateQuote({ ...quote, ...patch }, request));
});
test('strict simulated executor refuses missing re-quote instead of filling stale quote', async t => {
  const f = await fixture(t); let calls = 0;
  const executor = new SimulatedExecutor({ cfg: { ...f.cfg, paper: { ...f.cfg.paper, latencyMs: 0 } },
    rpc: { execute: async () => [] }, jupiter: { assertFresh: () => {}, quote: async () => { if (++calls > 1) throw new Error('offline'); return { ...quote, inAmount: '100' }; } },
    logger: log, owner: Keypair.generate().publicKey,
  } as any, f.portfolio, true);
  await assert.rejects(executor.swap({ side: 'BUY', mint: 'output', amountRaw: 100n, slippageBps: 150 }), /Fresh simulation re-quote/);
});
test('telemetry writes observed values and null confidence, never mock market numbers', async t => {
  const f = await fixture(t);
  const telemetry = new PlaybookTelemetry(f.dir);
  const at = Date.now();
  telemetry.observe({ ...snapshot, observedAt: at }, { type: 'SKIP', reason: 'SAFETY' }, 12);
  telemetry.markEquity(10_000_000_000n, at);
  await telemetry.flush();
  const data = JSON.parse(await fs.readFile(path.join(f.dir, 'dashboard-SIMULATION.json'), 'utf8'));
  assert.equal(data.watchlist[0].price_usd, snapshot.priceUsd);
  assert.equal(data.decisions[0].score, null);
  assert.equal(data.equity[0].equity_usd, 10 * snapshot.solUsd!);
  const state = JSON.parse(await fs.readFile(path.join(f.dir, 'state-SIMULATION.json'), 'utf8'));
  const dashboard = adaptTelemetry(data, state);
  assert.equal(dashboard.state.metrics.total_equity_usd, 10_000);
  assert.equal(dashboard.state.watchlist[0]!.price_usd, 1);
  assert.equal(dashboard.state.decisions[0]!.confidence_pct, null);
});

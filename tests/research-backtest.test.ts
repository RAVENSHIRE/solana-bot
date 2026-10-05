import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDataset } from '../src/research/events/dataset';
import type { ResearchEvent } from '../src/research/events/types';
import { standardRegistry } from '../src/research/features/library';
import { StrategyRegistry } from '../src/research/strategy/versioning';
import { CRASHCANDLE_V001 } from '../src/research/strategy/catalog';
import { DESK_LIKE } from '../src/research/execution/model';
import { RESEARCH_DEFAULT_LIMITS } from '../src/research/risk/engine';
import { runBacktest, type BacktestConfig } from '../src/research/backtest/engine';
import { ablation, adversarial, byRegime, fixedDelayBaseline, knownCaseDependence, randomEntryBaseline, sensitivity, timeSplit, variant, walkForward } from '../src/research/backtest/analysis';
import { syntheticMarket, syntheticMint } from '../src/research/backtest/synthetic';
import { computeRegime, regimeKey } from '../src/research/regime/regime';
import { ExperimentRegistry } from '../src/research/experiments/registry';
import { runExperiment, type ExperimentPlan } from '../src/research/experiments/runner';
import { verifyLog } from '../src/research/core/append-log';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const features = standardRegistry();
const strategies = new StrategyRegistry(features);
const crash = strategies.register(CRASHCANDLE_V001);
const RISK = { ...RESEARCH_DEFAULT_LIMITS, maxDailyLossUsd: 1e9, maxDrawdownUsd: 1e9 };
const config = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({ strategy: crash, features, execution: DESK_LIKE, risk: RISK, mode: 'AVAILABLE', seed: 7,
  datasetVersion: null, codeVersion: 'test', regime: v => regimeKey(computeRegime(v)), ...over });

const markets = new Map<string, ResearchEvent[]>();
const market = (pWin: number, tokens: number, seed = 3) => {
  const key = `${pWin}:${tokens}:${seed}`;
  if (!markets.has(key)) markets.set(key, syntheticMarket({ tokens, start: T0, seed, pWin }));
  return markets.get(key)!;
};

test('a backtest is reproducible and identified by what it is made of', () => {
  const events = market(0.7, 60);
  const a = runBacktest(events, config()), b = runBacktest(events, config());
  assert.equal(a.run_id, b.run_id);
  assert.deepEqual(a.trades, b.trades);
  assert.ok(a.trades.length > 10, `trades: ${a.trades.length}`);
  assert.notEqual(runBacktest(events, config({ execution: { ...DESK_LIKE, entryLatencyMs: 5_000 } })).run_id, a.run_id);
  assert.notEqual(runBacktest(events, config({ seed: 8 })).run_id, a.run_id);
  assert.deepEqual(a.featureErrors, {});
  assert.ok(a.assumptions.some(x => x.startsWith('SYSTEM_HEALTH_ASSUMED')));
});

test('decisions only see the past; outcomes come from the path after the decision', () => {
  const events = market(0.7, 60), r = runBacktest(events, config());
  for (const t of r.trades) {
    assert.ok(t.features['pool_age_min@v1']! <= 15);
    if (t.entry) assert.ok(t.entry.at > t.decisionTime, 'the order lands after the decision');
  }
  const filled = r.trades.filter(t => t.status === 'FILLED');
  assert.ok(r.metrics.executionGapPct! > 0, 'executable trades are worse than the chart');
  assert.ok(filled.every(t => t.theoretical.returnPct !== null));
  // A strategy with the same rules but decisions restricted to a period trades only there.
  const period = { from: T0 + 2 * 3_600_000, to: T0 + 4 * 3_600_000 };
  const p = runBacktest(events, config({ period }));
  assert.ok(p.trades.length > 0 && p.trades.every(t => t.decisionTime >= period.from && t.decisionTime < period.to));
  const excluded = syntheticMint(0, 3);
  assert.ok(runBacktest(events, config({ excludeTokens: [excluded] })).trades.every(t => t.token !== excluded));
});

test('risk overrides the strategy inside a backtest', () => {
  const events = market(0.7, 60);
  const unhealthy = runBacktest(events, config({ healthy: () => false }));
  assert.equal(unhealthy.trades.length, 0);
  assert.ok(unhealthy.riskDenials.SYSTEM_UNHEALTHY! > 0);
  const tight = runBacktest(events, config({ risk: { ...RISK, minLiquidityUsd: 1e9 } }));
  assert.equal(tight.trades.length, 0);
});

test('research designs: baselines, walk-forward, ablation, sensitivity, adversarial, regimes, known cases', () => {
  const events = market(0.7, 60), cfg = config(), base = runBacktest(events, cfg);
  const random = randomEntryBaseline(events, cfg, base, 10);
  assert.ok(random.strategyMeanPct! > random.baselineMeanPct!, 'a planted edge beats random entries');
  assert.ok(random.differenceCi95!.low > 0);
  assert.ok(fixedDelayBaseline(events, cfg, base).baselineMeanPct! < base.metrics.meanReturnPct!);

  const tighter = variant(crash, 'sl20', { exit: { ...crash.exit, stopLossPct: 20 } });
  const wf = walkForward(events, cfg, [crash, tighter], { from: T0, to: T0 + 7 * 3_600_000, trainMs: 3 * 3_600_000, testMs: 3_600_000, minTrainTrades: 3 });
  assert.ok(wf.folds.length >= 3);
  assert.equal(wf.trials, 2 * wf.folds.length);
  assert.ok(wf.folds.every(f => f.test.from === f.train.to));

  const ab = ablation(events, cfg, base);
  assert.equal(ab.length, crash.entry.length);
  assert.ok(ab.every(v => v.variant.startsWith('crashcandle_v001~minus_')));
  assert.ok(!strategies.has(ab[0]!.variant), 'variants are never registered');

  const sens = sensitivity(events, cfg, [0.9, 1.1], base);
  assert.equal(sens.variants.length, crash.entry.length * 2 + 3 * 2);
  assert.ok(Array.isArray(sens.cliffs));

  const adv = adversarial(events, cfg, base);
  assert.equal(adv.length, 7);
  assert.ok(adv.find(v => v.change.startsWith('costs'))!.metrics.meanReturnPct! < base.metrics.meanReturnPct!);

  const regimes = byRegime(base.trades);
  assert.ok(Object.keys(regimes).some(k => k.startsWith('SOL_')), JSON.stringify(Object.keys(regimes)));
  const firstToken = base.trades[0]!.token;
  const dep = knownCaseDependence(base.trades, [firstToken]);
  assert.equal(dep.all.signals - dep.withoutCases.signals, dep.caseTrades);
});

async function experiment(pWin: number, registry: ExperimentRegistry, over: Partial<ExperimentPlan> = {}) {
  const events = market(pWin, 240, 5);
  const { manifest, events: ds } = buildDataset(events, { description: `synthetic pWin=${pWin}`, createdAt: T0 });
  const [training, validation, test] = timeSplit(T0, T0 + 25 * 3_600_000, [0.5, 0.2, 0.3]);
  let clock = T0 + 30 * 3_600_000;
  return runExperiment(registry, { hypothesis: `CRASH-like first moves continue (synthetic pWin=${pWin})`, config: config(), dataset: manifest, events: ds,
    periods: { training: training!, validation: validation!, test: test! }, trials: 1, actor: 'test', now: () => clock++, baselineRepetitions: 15, ...over });
}

test('the machine finds a planted edge, and only then', async () => {
  const registry = ExperimentRegistry.memory();
  const edge = await experiment(0.7, registry);
  assert.equal(edge.record.result, 'SUPPORTED', `${edge.record.failure_reason} ${JSON.stringify(edge.record.metrics?.meanReturnCi95)}`);
  assert.ok(edge.record.sample_size >= 30);
  assert.equal(edge.record.holdout.use_number, 1);
  assert.equal(edge.record.holdout.contaminated, false);

  const none = await experiment(0.2, registry);
  assert.notEqual(none.record.result, 'SUPPORTED');
  assert.ok(['REJECTED', 'INCONCLUSIVE'].includes(none.record.result), none.record.result);

  // The same claim judged after comparing 10,000 rule sets needs far more evidence than after one.
  const many = await experiment(0.7, registry, { trials: 10_000, hypothesis: 'same edge, found by a large grid search' });
  assert.ok(many.record.deflated_sharpe! < edge.record.deflated_sharpe!);
});

test('the holdout is sealed: opened once per experiment, reuse is flagged, then refused', async () => {
  const registry = ExperimentRegistry.memory({ holdoutBudget: 2 });
  const first = await experiment(0.7, registry);
  assert.equal(first.record.holdout.contaminated, false);
  // Re-registering the identical design is the same experiment: it does not run again.
  const again = await experiment(0.7, registry);
  assert.equal(again.record.experiment_id, first.record.experiment_id);
  assert.equal(again.test, null);
  await assert.rejects(() => registry.openHoldout(first.record.experiment_id, 'x', T0), /EXPERIMENT_CONCLUDED/);
  const second = await experiment(0.7, registry, { hypothesis: 'a second look at the same test period' });
  assert.equal(second.record.holdout.contaminated, true);
  assert.match(second.record.notes[0]!, /HOLDOUT_CONTAMINATED/);
  await assert.rejects(() => experiment(0.7, registry, { hypothesis: 'a third look' }), /HOLDOUT_BUDGET_EXHAUSTED/);
});

test('a strategy built on a leaking feature is INVALID before its holdout is touched', async () => {
  const events = market(0.7, 240, 5);
  const leaky = standardRegistry();
  // "Will this token's price ever be twice the current one?" – computable only from the future.
  leaky.register({ name: 'future_double', version: 1, definition: 'peeks at later bars', unit: '0/1', sources: ['Candle'], lookbackMs: null, timestamp: 'DECISION_TIME',
    missing: 'NULL', dependencies: [], leakageRisk: 'HIGH', leakageNotes: 'deliberately leaks, for the test',
    compute: (v, c) => {
      const now = v.latest(['Candle'], c.token);
      if (!now) return null;
      return events.some(e => e.token === c.token && e.event_type === 'Candle' && (e.payload.c as number) > (now.payload.c as number) * 2) ? 1 : 0;
    } });
  const reg = new StrategyRegistry(leaky);
  const cheat = reg.register({ ...CRASHCANDLE_V001, id: 'cheat_v001', family: 'cheat', entry: [...CRASHCANDLE_V001.entry, { feature: 'future_double@v1', op: '>=', value: 1 }] });
  const registry = ExperimentRegistry.memory();
  const run = await experiment(0.7, registry, { config: { ...config(), strategy: cheat, features: leaky }, hypothesis: 'cheating' });
  assert.equal(run.record.result, 'INVALID');
  assert.match(run.record.failure_reason!, /LEAKAGE/);
  assert.equal(run.record.holdout.opened, false);
  assert.equal(run.test, null);
});

test('experiments are kept in an append-only, verifiable log', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-exp-'));
  const registry = await ExperimentRegistry.open(dir);
  const run = await experiment(0.2, registry);
  await registry.close();
  const reopened = await ExperimentRegistry.open(dir);
  const rec = reopened.get(run.record.experiment_id)!;
  assert.equal(rec.result, run.record.result);
  assert.ok(rec.validation_metrics);
  for (const key of ['experiment_id', 'hypothesis', 'dataset_version', 'feature_versions', 'strategy_version', 'training_period', 'validation_period', 'test_period',
    'execution_model', 'transaction_cost_model', 'result', 'metrics', 'sample_size', 'failure_reason', 'timestamp'] as const) assert.ok(key in rec, key);
  await reopened.close();
  assert.equal((await verifyLog(dir, 'experiments')).ok, true);
});

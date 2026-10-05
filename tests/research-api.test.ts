import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MemoryEventStore } from '../src/research/events/store';
import { standardRegistry } from '../src/research/features/library';
import { StrategyRegistry } from '../src/research/strategy/versioning';
import { CRASHCANDLE_V001 } from '../src/research/strategy/catalog';
import { DESK_LIKE } from '../src/research/execution/model';
import { RESEARCH_DEFAULT_LIMITS } from '../src/research/risk/engine';
import { ExperimentRegistry } from '../src/research/experiments/registry';
import { HypothesisBook } from '../src/research/curiosity/hypothesis';
import { KNOWN_CASES, knownCaseTokens, matchesKnownCase } from '../src/research/curiosity/cases';
import { syntheticMarket } from '../src/research/backtest/synthetic';
import { ResearchApi, ROLE_CAPABILITIES, memoryContext, toolManifest, type Principal } from '../src/research/api/tools';
import { parsePrincipals, startServer } from '../src/research/api/server';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const events = syntheticMarket({ tokens: 240, start: T0, seed: 5, pWin: 0.7 });

function setup() {
  const features = standardRegistry(), strategies = new StrategyRegistry(features), audit = new MemoryEventStore(() => T0);
  strategies.register(CRASHCANDLE_V001);
  let clock = T0 + 40 * 3_600_000;
  const ctx = memoryContext({ events, features, strategies, experiments: ExperimentRegistry.memory(), hypotheses: HypothesisBook.memory(), execution: DESK_LIKE,
    risk: { ...RESEARCH_DEFAULT_LIMITS, maxDailyLossUsd: 1e9, maxDrawdownUsd: 1e9 }, audit, now: () => clock++, codeVersion: 'test' });
  return { api: new ResearchApi(ctx), audit, ctx };
}
const as = (role: Principal['role'], id = role.toLowerCase()): Principal => ({ id, role });

test('capabilities are separated by role, and no role can trade', async () => {
  const { api, audit } = setup();
  assert.equal((await api.call(as('DATA_AGENT'), 'get_data_quality')).ok, true);
  const denied = await api.call(as('DATA_AGENT'), 'run_backtest', { strategy: 'crashcandle_v001' });
  assert.deepEqual(denied.ok ? null : denied.error.code, 'CAPABILITY_DENIED');
  const scout = await api.call(as('CURIOSITY_SCOUT'), 'create_experiment', { hypothesis: 'x', strategy: 'crashcandle_v001', trials: 1 });
  assert.equal(scout.ok ? null : scout.error.code, 'CAPABILITY_DENIED');
  const backtester = await api.call(as('BACKTEST_AGENT'), 'conclude_experiment', { hypothesis: 'x', strategy: 'crashcandle_v001', trials: 1 });
  assert.equal(backtester.ok ? null : backtester.error.code, 'CAPABILITY_DENIED', 'only HOLDOUT may open a test period');
  for (const role of Object.keys(ROLE_CAPABILITIES) as Array<Principal['role']>) {
    const r = await api.call(as(role), 'place_order', { token: 'x', usd: 100 });
    assert.equal(r.ok ? null : r.error.code, 'TRADING_NOT_AVAILABLE');
    assert.ok(!(ROLE_CAPABILITIES[role] as readonly string[]).includes('TRADING'));
  }
  assert.ok(toolManifest('BACKTEST_AGENT').every(t => t.capability !== 'HOLDOUT'));
  assert.ok(toolManifest('SUPERVISOR_AGENT').some(t => t.name === 'conclude_experiment'));
  assert.ok(toolManifest().every(t => !/trade|order|swap|sign/.test(t.name)));
  // Every call is audited, allowed or denied.
  const actions = (await audit.query({ types: ['AgentAction'] })).map(e => e.payload);
  assert.equal(actions.length, 4 + Object.keys(ROLE_CAPABILITIES).length);
  assert.ok(actions.some(a => a.tool === 'place_order' && a.error === 'TRADING_NOT_AVAILABLE'));
});

test('read tools answer from what was known; bad arguments are errors, not exceptions', async () => {
  const { api } = setup();
  const token = events.find(e => e.event_type === 'Candle')!.token!;
  const info = await api.call(as('REPORTING_AGENT'), 'get_token', { token });
  assert.ok(info.ok && (info.data as { known: boolean }).known);
  const early = await api.call(as('DATA_AGENT'), 'get_token_events', { token, known_by: new Date(T0 + 30_000).toISOString() });
  assert.ok(early.ok && (early.data as unknown[]).length <= 2);
  const f = await api.call(as('FEATURE_AGENT'), 'get_feature', { token, at: T0 + 20 * 60_000, features: ['price_usd@v1', 'pool_age_min@v1'] });
  assert.ok(f.ok);
  assert.equal((f.data as { values: Record<string, number> }).values['pool_age_min@v1'], 20);
  const bad = await api.call(as('FEATURE_AGENT'), 'get_feature', { token, at: 'yesterday' });
  assert.equal(bad.ok ? null : bad.error.code, 'INVALID_ARGUMENT');
  const unknown = await api.call(as('FEATURE_AGENT'), 'get_feature', { token, at: T0, features: ['nope@v1'] });
  assert.equal(unknown.ok ? null : unknown.error.code, 'INVALID_ARGUMENT');
  const why = await api.call(as('REPORTING_AGENT'), 'explain_missing_alert', { token, from: T0, to: T0 + 3_600_000 });
  assert.ok(why.ok);
});

test('curiosity scout → hypothesis → experiment (holdout closed) → supervisor concludes', async () => {
  const { api, ctx } = setup();
  const scout = as('CURIOSITY_SCOUT', 'scout-1');
  const obs = await api.call(scout, 'submit_observation', { text: 'Fresh pools that rise 10–30 % on heavy volume in their first quarter hour often keep going.', tags: ['momentum'] });
  assert.ok(obs.ok);
  const untestable = await api.call(scout, 'submit_hypothesis', { statement: 'They go up.', condition: [{ feature: 'vibes@v1', op: '>', value: 1 }], direction: 'HIGHER', horizon_min: 30, falsification: 'no' });
  assert.equal(untestable.ok ? null : untestable.error.code, 'INVALID_ARGUMENT');
  assert.match(untestable.ok ? '' : untestable.error.message, /UNKNOWN_FEATURE vibes@v1.*NO_FALSIFICATION/);
  const hyp = await api.call(scout, 'submit_hypothesis', {
    statement: 'Pools under 15 minutes old that rise 10–30 % in five minutes on at least $50K volume return more than random entries over 30 minutes.',
    observation_ids: [(obs as { data: { id: string } }).data.id],
    condition: [{ feature: 'pool_age_min@v1', op: '<=', value: 15 }, { feature: 'price_change_5m_pct@v1', op: 'between', value: [10, 30] }, { feature: 'volume_5m_usd@v1', op: '>=', value: 50_000 }],
    direction: 'HIGHER', horizon_min: 30, falsification: 'The holdout mean net return is not above random entries (difference interval includes zero or is below it).' });
  assert.ok(hyp.ok, JSON.stringify(hyp));
  const hypothesisId = (hyp as { data: { id: string } }).data.id;

  const designed = await api.call(as('BACKTEST_AGENT'), 'create_experiment', { hypothesis: 'scout-1 momentum hypothesis', hypothesis_id: hypothesisId, strategy: 'unused', trials: 1 });
  assert.ok(designed.ok, JSON.stringify(designed));
  const rec = (designed as { data: { record: { result: string; holdout: { opened: boolean }; experiment_id: string } } }).data.record;
  assert.equal(rec.result, 'PENDING');
  assert.equal(rec.holdout.opened, false);
  assert.equal(ctx.hypotheses.get(hypothesisId)!.status, 'TESTING');

  const concluded = await api.call(as('SUPERVISOR_AGENT', 'supervisor'), 'conclude_experiment', { hypothesis: 'scout-1 momentum hypothesis', hypothesis_id: hypothesisId, strategy: 'unused', trials: 1 });
  assert.ok(concluded.ok, JSON.stringify(concluded));
  const final = (concluded as { data: { record: { result: string; experiment_id: string; holdout: { opened: boolean } } } }).data.record;
  assert.equal(final.experiment_id, rec.experiment_id, 'the same pre-registered experiment continues');
  assert.equal(final.holdout.opened, true);
  assert.ok(['SUPPORTED', 'INCONCLUSIVE'].includes(final.result), final.result);
  assert.notEqual(ctx.hypotheses.get(hypothesisId)!.status, 'TESTING');
  const listed = await api.call(as('REPORTING_AGENT'), 'list_experiments');
  assert.ok(listed.ok && (listed.data as unknown[]).length === 1);
});

test('known cases match by full mint or recorded prefix, and are excluded by default', () => {
  assert.equal(matchesKnownCase('GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H')!.label, 'GAwhcph…9S9H');
  assert.equal(matchesKnownCase('7cYaQcAuSTSfUcDXqVM3mAkpSpQo1GiLqm8QDZmPz2kE')!.role, 'MISSED');
  assert.equal(matchesKnownCase('6bQ4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxNOPE'), null, 'prefix and suffix both have to match');
  assert.deepEqual(knownCaseTokens(['So11111111111111111111111111111111111111112', 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H']), ['GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H']);
  assert.ok(KNOWN_CASES.every(c => c.note && c.source));
});

test('HTTP surface: loopback, bearer tokens bound to roles', async () => {
  const { api } = setup();
  assert.throws(() => parsePrincipals('DATA_AGENT:a:short'), /24 characters/);
  const principals = parsePrincipals('DATA_AGENT:data-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaa,SUPERVISOR_AGENT:sup:bbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await assert.rejects(() => startServer(api, { host: '0.0.0.0', port: 0, principals }), /loopback/);
  const server = await startServer(api, { port: 0, principals });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/tools`)).status, 401);
    const tools = await (await fetch(`${base}/tools`, { headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).json() as { data: { tools: Array<{ capability: string }> } };
    assert.ok(tools.data.tools.every(t => t.capability === 'READ'));
    const ok = await fetch(`${base}/tools/get_data_quality`, { method: 'POST', headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, body: '{}' });
    assert.equal(ok.status, 200);
    const denied = await fetch(`${base}/tools/run_backtest`, { method: 'POST', headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, body: '{"strategy":"crashcandle_v001"}' });
    assert.equal(denied.status, 403);
    const trade = await fetch(`${base}/tools/place_order`, { method: 'POST', headers: { Authorization: 'Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, body: '{}' });
    assert.equal(trade.status, 404);
    assert.equal((await trade.json() as { error: { code: string } }).error.code, 'TRADING_NOT_AVAILABLE');
    assert.equal((await fetch(`${base}/tools/get_data_quality`, { method: 'POST', headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, body: '[1]' })).status, 400);
  } finally { server.close(); }
});

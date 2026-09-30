import test from 'node:test';
import assert from 'node:assert/strict';
import { deskOperational } from '../src/desk/config';

test('locked startup configuration keeps LIVE CRASH disabled and validates overrides', () => {
  const defaults = deskOperational({});
  assert.equal(defaults.deploymentMode, 'LOCKED');
  assert.equal(defaults.strategyEnabled.LIVE.CRASH, false);
  assert.equal(defaults.lossCooldownMs.FAIR, 60 * 60_000);
  const selected = deskOperational({ DESK_DEPLOYMENT_MODE: 'EDITABLE', DESK_LIVE_CRASH_ENABLED: 'true' });
  assert.equal(selected.strategyEnabled.LIVE.CRASH, true);
  assert.throws(() => deskOperational({ DESK_FAIR_LOSS_REENTRY_MIN: '0' }));
});

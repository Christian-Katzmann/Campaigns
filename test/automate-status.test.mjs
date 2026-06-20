import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseAutomateState, deriveCodexRuntime } from '../lib/automate-providers.mjs';

function runtime(overrides = {}) {
  return deriveCodexRuntime({
    stateData: { campaign: { status: 'active' } },
    activeRun: null,
    pendingAutomation: null,
    registry: null,
    run: null,
    lock: null,
    sessionStat: null,
    maxMinutes: 60,
    runDirMissing: false,
    ...overrides,
  });
}

test('fresh session activity keeps an expired active_run visually running', () => {
  const result = runtime({
    activeRun: { automation_id: 'run-1', expired: true },
    sessionStat: { mtimeMs: Date.now() - 1_000 },
  });

  assert.deepEqual(result, { status: 'active', isActive: true });
});

test('stale active_run without fresh session proof becomes stalled', () => {
  const result = runtime({
    activeRun: { automation_id: 'run-1', expired: true },
    sessionStat: { mtimeMs: Date.now() - 20 * 60_000 },
  });

  assert.deepEqual(result, { status: 'stalled', isActive: false });
});

test('failed campaign without live worker proof stays a failure state', () => {
  const result = runtime({
    stateData: { campaign: { status: 'failed' } },
  });

  assert.deepEqual(result, { status: 'failed', isActive: false });
});

test('provider arbitration lets a live worker beat a stale warning', () => {
  const winner = chooseAutomateState([
    {
      provider: { name: 'claude' },
      index: 0,
      state: { backend: 'claude', status: 'failed', is_active: false },
    },
    {
      provider: { name: 'codex' },
      index: 1,
      state: { backend: 'codex', status: 'active', is_active: true },
    },
  ]);

  assert.equal(winner.state.backend, 'codex');
});

test('active_run beats old warning state', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'active' },
      cursor: { step_id: '4.1' },
      history: [{ event: 'step_failed', step_id: '0.1', message: 'old failure' }],
    },
    activeRun: { automation_id: 'run-4-1', step_id: '4.1', expired: false },
  });

  assert.deepEqual(result, { status: 'active', isActive: true });
});

test('pending automation beats old warning state', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'active' },
      cursor: { step_id: '4.1' },
      history: [{ event: 'step_failed', step_id: '0.1', message: 'old failure' }],
    },
    pendingAutomation: {
      id: 'run-4-1',
      status: 'ACTIVE',
      expected_next: 'step 4.1 - Next implementation',
      step_id: '4.1',
    },
  });

  assert.deepEqual(result, { status: 'queued', isActive: false });
});

test('current unresolved issue still needs attention without active or pending work', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'blocked' },
      phase: 'blocked',
      cursor: { step_id: '4.1' },
      blockers: [{ message: 'Current step failed' }],
    },
  });

  assert.deepEqual(result, { status: 'failed', isActive: false });
});

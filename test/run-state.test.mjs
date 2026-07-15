import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RUN_EVENT_NAMES,
  RunStateTransitionError,
  assertValidRunState,
  createRunState,
  transitionRunState,
  upgradeRunState,
  validateRunState,
} from '../lib/run-state.mjs';

const BASE_TIME = Date.parse('2026-07-14T12:00:00.000Z');
let clock = 0;

function at() {
  clock += 1;
  return new Date(BASE_TIME + clock * 1_000).toISOString();
}

function stateWithSteps(stepIds = ['1.1']) {
  return createRunState({
    id: `run-${clock}`,
    created_at: at(),
    identity: {
      registry_id: 'registry-campaign-a',
      source: {
        campaign_path: '/repo/campaigns/a.md',
        repo_root: '/repo',
      },
      execution: {
        campaign_path: '/repo-worktrees/a/campaigns/a.md',
        repo_root: '/repo-worktrees/a',
        branch: 'campaign/a',
      },
    },
    steps: stepIds.map((id) => ({ id, name: `Step ${id}`, phase: id.split('.')[0] })),
    config: {
      runner: 'test-runner',
      model: 'test-model',
      effort: 'high',
      watchdog: {
        minimum_runtime_ms: 60_000,
        stall_window_ms: 30_000,
      },
    },
    artifacts: {
      run_dir: '/state/runs/a',
      receipts_dir: '/state/runs/a/receipts',
      final_review_path: '/state/runs/a/final-review.md',
    },
  });
}

function worker(id = `worker-${clock}`) {
  return {
    runner: 'test-runner',
    invocation_id: id,
    pid: 1234,
    log_path: `/state/runs/a/${id}.log`,
  };
}

function move(state, event, fields = {}) {
  return transitionRunState(state, { event, at: at(), ...fields });
}

function completeSteps(state) {
  let next = move(state, 'run_started');
  for (const step of next.steps) {
    next = move(next, 'step_started', { step_id: step.id, worker: worker() });
    next = move(next, 'step_completed', {
      step_id: step.id,
      receipt_path: `/state/runs/a/receipts/${step.id}.md`,
    });
  }
  return move(next, 'run_reached_final_review');
}

function reviewingState() {
  return move(completeSteps(stateWithSteps()), 'final_review_started');
}

test('creates a valid runner-neutral ledger with stable source and execution identity', () => {
  const state = stateWithSteps(['1.1', '1.2']);

  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.equal(state.run.identity.registry_id, 'registry-campaign-a');
  assert.equal(state.run.identity.source.campaign_path, '/repo/campaigns/a.md');
  assert.equal(state.run.identity.execution.branch, 'campaign/a');
  assert.equal(state.history[0].event, 'run_created');
  assert.doesNotMatch(JSON.stringify(state), /claude_|codex_/i);
});

test('version-1 ledgers upgrade with cap defaults and the explicit stop status', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'stopped_by_user');
  const old = structuredClone(state);
  old.schema_version = 1;
  for (const step of old.steps) {
    delete step.runner;
    delete step.model;
    delete step.effort;
  }
  delete old.config.max_steps_per_run;
  delete old.config.max_run_minutes;
  delete old.config.stop_grace_ms;
  old.run.status = 'stopped';
  for (const entry of old.history) {
    if (entry.to_status === 'stopped_by_user') entry.to_status = 'stopped';
  }

  const upgraded = upgradeRunState(old);
  assert.equal(upgraded.schema_version, 3);
  assert.equal(upgraded.run.status, 'stopped_by_user');
  assert.equal(upgraded.config.max_steps_per_run, 50);
  assert.equal(upgraded.config.max_run_minutes, 360);
  assert.equal(upgraded.config.stop_grace_ms, 3_000);
  assert.equal(upgraded.steps[0].runner, null);
  assert.equal(upgraded.steps[0].model, null);
  assert.equal(upgraded.steps[0].effort, null);
  assertValidRunState(upgraded);
});

test('completed steps retain the actual runner, model, and effort', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', {
    step_id: '1.1',
    worker: { ...worker(), runner: 'codex' },
  });
  state = move(state, 'step_completed', {
    step_id: '1.1',
    receipt_path: '/state/runs/a/receipts/1.1.md',
    runner: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  assert.deepEqual(
    (({ runner, model, effort }) => ({ runner, model, effort }))(state.steps[0]),
    { runner: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
  );
  assertValidRunState(state);
});

test('runs every normal step and review transition through merge', () => {
  let state = completeSteps(stateWithSteps(['1.1', '1.2']));
  assert.equal(state.run.status, 'awaiting_review');

  state = move(state, 'final_review_started');
  state = move(state, 'final_review_needs_work', {
    reasons: ['acceptance-miss'],
    review_path: '/state/runs/a/final-review.md',
  });
  state = move(state, 'final_rework_completed', {
    attempt: 1,
    commit_sha: 'abc123',
  });
  state = move(state, 'final_review_started');
  state = move(state, 'final_review_approved', {
    review_path: '/state/runs/a/final-review.md',
  });
  state = move(state, 'campaign_merged');

  assert.equal(state.run.status, 'merged');
  assert.equal(state.review.status, 'approved');
  assert.equal(state.review.attempts, 2);
  assert.ok(state.run.ended_at);
  assertValidRunState(state);
});

test('campaign_completed is a legal reviewed terminal event', () => {
  const state = move(reviewingState(), 'campaign_completed', {
    review_path: '/state/runs/a/final-review.md',
  });

  assert.equal(state.run.status, 'completed');
  assert.equal(state.review.verdict, 'APPROVED');
});

test('an unparseable review waits for a human without inventing a status name', () => {
  let state = reviewingState();
  state = move(state, 'final_review_reasked', { issue: 'missing-verdict' });
  state = move(state, 'review_unparseable', {
    review_path: '/state/runs/a/final-review.md',
  });

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.review.status, 'awaiting_human');
  assert.equal(state.review.attempts, 2);
  assert.equal(state.history.at(-1).event, 'review_unparseable');
  assertValidRunState(state);
});

test('a pending step may be explicitly skipped before review', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_skipped', { step_id: '1.1', message: 'Not needed.' });
  state = move(state, 'run_reached_final_review');

  assert.equal(state.steps[0].status, 'skipped');
  assert.equal(state.run.status, 'awaiting_review');
});

test('each preflight failure blocks without consuming a step attempt and can be retried', () => {
  for (const event of [
    'preflight_dirty_worktree',
    'preflight_branch_unavailable',
    'preflight_campaign_invalid',
  ]) {
    let state = move(stateWithSteps(), event, { message: `Fix ${event}.` });
    assert.equal(state.run.status, 'blocked');
    assert.equal(state.steps[0].attempt, 0);
    assert.equal(state.blockers[0].event, event);

    state = move(state, 'run_started');
    assert.equal(state.run.status, 'running');
    assert.deepEqual(state.blockers, []);
  }
});

test('a failed step can be reset by recovery and attempted again', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'step_failed', {
    step_id: '1.1',
    failure: {
      code: 'completion_signal_missing',
      message: 'Runner exited without the completion marker.',
      retryable: true,
      output_tail: 'last worker output',
    },
  });
  state = move(state, 'recovery_started', { step_id: '1.1' });
  state = move(state, 'stale_lock_released', { message: 'Removed stale lock.' });
  state = move(state, 'step_reset_by_recover', { step_id: '1.1' });
  state = move(state, 'recovery_completed', { resume_status: 'running' });
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'step_completed', {
    step_id: '1.1',
    receipt_path: '/state/runs/a/receipts/1.1.md',
  });

  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[0].attempt, 2);
  assert.equal(state.steps[0].failure, null);
});

test('check_failed is a structured non-terminal event at step and review boundaries', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'check_failed', {
    step_id: '1.1',
    message: 'Executable check failed.',
    details: { scope: 'step', failures: [{ command: 'npm test', exit_code: 1 }] },
  });
  assert.equal(state.run.status, 'running');
  assert.equal(state.steps[0].status, 'running');
  assert.equal(state.history.at(-1).details.scope, 'step');

  state = move(state, 'step_completed', {
    step_id: '1.1',
    receipt_path: '/state/runs/a/receipts/1.1.md',
  });
  state = move(state, 'run_reached_final_review');
  state = move(state, 'check_failed', {
    message: 'Campaign check failed.',
    details: { scope: 'campaign', failures: [{ command: 'npm test', exit_code: 1 }] },
  });
  assert.equal(state.run.status, 'awaiting_review');
  assertValidRunState(state);
});

test('a user-stopped live step can be continued by recovery', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'stopped_by_user', { message: 'Stopped from the board.' });
  assert.equal(state.run.status, 'stopped_by_user');
  state = move(state, 'recovery_started', { step_id: '1.1' });
  state = move(state, 'step_continued_by_recover', {
    step_id: '1.1',
    worker: worker('continued-worker'),
  });

  assert.equal(state.run.status, 'running');
  assert.equal(state.steps[0].status, 'running');
  assert.equal(state.worker.invocation_id, 'continued-worker');
});

test('a run cap stops the active step with a structured terminal reason', () => {
  let state = move(stateWithSteps(), 'run_started');
  state = move(state, 'step_started', { step_id: '1.1', worker: worker() });
  state = move(state, 'cap_reached', {
    step_id: '1.1',
    message: 'Run-time cap reached.',
    details: { cap: 'max_run_minutes', limit: 60 },
  });

  assert.equal(state.run.status, 'cap_reached');
  assert.equal(state.steps[0].status, 'stopped');
  assert.equal(state.worker, null);
  assert.equal(state.history.at(-1).details.cap, 'max_run_minutes');
  assertValidRunState(state);
});

test('recovery failure halts a blocked run', () => {
  let state = move(stateWithSteps(), 'preflight_dirty_worktree', {
    message: 'Clean the worktree.',
  });
  state = move(state, 'recovery_started');
  state = move(state, 'recovery_failed', { message: 'Could not repair safely.' });

  assert.equal(state.run.status, 'halted');
});

test('a halted final review can recover to the review boundary', () => {
  let state = move(completeSteps(stateWithSteps()), 'final_review_halted', {
    verdict: 'AMBIGUOUS',
    reasons: ['malformed-verdict'],
    review_path: '/state/runs/a/final-review.md',
  });
  state = move(state, 'recovery_started');
  state = move(state, 'recovery_completed', { resume_status: 'awaiting_review' });

  assert.equal(state.run.status, 'awaiting_review');
  assert.equal(state.review.status, 'pending');
});

test('force merge is explicit and becomes an immutable successful terminal state', () => {
  const state = move(completeSteps(stateWithSteps()), 'force_merged_unreviewed', {
    explicit: true,
    reasons: ['operator override'],
  });

  assert.equal(state.run.status, 'force_merged');
  assert.equal(state.review.status, 'unreviewed');
  assert.throws(
    () => move(state, 'final_review_halted', { reasons: [] }),
    /successful terminal runs cannot be reopened or halted/,
  );
});

test('all audit taxonomy events have a first-class schema name', () => {
  for (const event of [
    'check_failed',
    'step_failed',
    'review_unparseable',
    'final_review_halted',
    'force_merged_unreviewed',
    'cap_reached',
    'stopped_by_user',
    'step_reset_by_recover',
    'step_continued_by_recover',
  ]) {
    assert.ok(RUN_EVENT_NAMES.includes(event), event);
  }
});

test('completed and merged runs can never become halted', () => {
  const completed = move(reviewingState(), 'final_review_approved', {
    review_path: '/state/runs/a/final-review.md',
  });
  const merged = move(completed, 'campaign_merged');

  for (const state of [completed, merged]) {
    assert.throws(
      () => move(state, 'final_review_halted', { reasons: [] }),
      RunStateTransitionError,
    );
    assert.notEqual(state.run.status, 'halted');
  }
});

test('validation rejects a ledger that claims halted after completion', () => {
  const state = move(reviewingState(), 'campaign_completed', {
    review_path: '/state/runs/a/final-review.md',
  });
  const mislabeledTerminal = structuredClone(state);
  mislabeledTerminal.run.status = 'halted';
  mislabeledTerminal.run.ended_at = null;
  mislabeledTerminal.history.at(-1).to_status = 'halted';

  const mislabeledResult = validateRunState(mislabeledTerminal);
  assert.equal(mislabeledResult.valid, false);
  assert.ok(
    mislabeledResult.errors.some((error) => error.includes('campaign_completed cannot end at halted')),
  );

  const corrupt = structuredClone(state);
  corrupt.run.status = 'halted';
  corrupt.run.ended_at = null;
  corrupt.history.push({
    sequence: corrupt.history.length + 1,
    at: at(),
    event: 'final_review_halted',
    from_status: 'completed',
    to_status: 'halted',
    step_id: null,
    message: 'Impossible old-engine state.',
    details: {},
  });

  const result = validateRunState(corrupt);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('leaves a successful terminal state')));
});

test('key illegal step and review transitions throw without mutating state', () => {
  const pending = stateWithSteps(['1.1', '1.2']);
  const running = move(pending, 'run_started');
  const stepRunning = move(running, 'step_started', { step_id: '1.1', worker: worker() });

  assert.throws(
    () => move(running, 'step_completed', {
      step_id: '1.1',
      receipt_path: '/state/runs/a/receipts/1.1.md',
    }),
    /expected running/,
  );
  assert.throws(
    () => move(stepRunning, 'step_started', { step_id: '1.2', worker: worker() }),
    /another step is already running/,
  );
  assert.throws(() => move(running, 'run_reached_final_review'), /unfinished steps/);
  assert.equal(running.steps[0].status, 'pending');
});

test('force merge without an explicit operator choice is illegal', () => {
  const state = completeSteps(stateWithSteps());
  assert.throws(() => move(state, 'force_merged_unreviewed'), /requires explicit: true/);
});

test('identity rejects relative paths and requires a nullable registry field', () => {
  const base = {
    id: 'bad-run',
    steps: [],
    config: {
      runner: 'test',
      model: null,
      effort: null,
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1 },
    },
    artifacts: {
      run_dir: '/state/run',
      receipts_dir: '/state/run/receipts',
      final_review_path: null,
    },
  };

  assert.throws(
    () => createRunState({
      ...base,
      identity: {
        source: { campaign_path: '/repo/a.md', repo_root: '/repo' },
        execution: { campaign_path: '/repo/a.md', repo_root: '/repo', branch: 'main' },
      },
    }),
    /registry_id must be present/,
  );
  assert.throws(
    () => createRunState({
      ...base,
      identity: {
        registry_id: null,
        source: { campaign_path: 'campaigns/a.md', repo_root: '/repo' },
        execution: { campaign_path: '/repo/a.md', repo_root: '/repo', branch: 'main' },
      },
    }),
    /absolute path/,
  );
});

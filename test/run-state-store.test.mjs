import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  RUN_EVENT_NAMES,
  RUN_STATE_VERSION,
  RUN_STATUSES,
  createRunState,
  transitionRunState,
} from '../lib/run-state.mjs';
import { runJournalPath } from '../lib/run-journal.mjs';
import {
  engineEventLogPath,
  persistRunState,
  readRunState,
  validateEngineEvent,
} from '../lib/run-state-store.mjs';

const FIXTURES = path.resolve('test/fixtures/run-state');
const SCHEMA_PATH = path.resolve('schema/run-state.schema.json');

test('published schema accepts generated ledgers and stays aligned with runtime enums', async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  assert.equal(schema.properties.schema_version.const, RUN_STATE_VERSION);
  assert.deepEqual(schema.$defs.run_status.enum, RUN_STATUSES);
  assert.deepEqual(schema.$defs.run_event.enum, RUN_EVENT_NAMES);

  let state = fixtureState();
  for (const next of [
    () => transitionRunState(state, { event: 'run_started', at: at(1) }),
    () => transitionRunState(state, {
      event: 'step_started',
      at: at(2),
      step_id: '1.1',
      worker: {
        runner: 'fixture',
        invocation_id: 'worker-1',
        pid: 123,
        log_path: '/fixtures/runs/current/logs/1.1.log',
      },
    }),
    () => transitionRunState(state, {
      event: 'step_completed',
      at: at(3),
      step_id: '1.1',
      receipt_path: '/fixtures/runs/current/receipts/1.1.md',
      commit_range: { base_oid: '1'.repeat(40), head_oid: '2'.repeat(40) },
      details: { usage: nullUsage() },
    }),
    () => transitionRunState(state, { event: 'run_reached_final_review', at: at(4) }),
    () => transitionRunState(state, {
      event: 'final_review_started',
      at: at(5),
      reviewer_runner: 'reviewer',
      reviewer_family: 'other',
      reviewer_ladder_tier: 'cross_family',
    }),
    () => transitionRunState(state, {
      event: 'final_review_approved',
      at: at(6),
      review_path: '/fixtures/runs/current/final-review.md',
      details: { usage: nullUsage() },
    }),
  ]) {
    assert.deepEqual(validateWithSchema(state, schema), []);
    state = next();
  }
  assert.deepEqual(validateWithSchema(state, schema), []);
});

test('older fixture ledgers migrate, persist atomically, and read idempotently', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-state-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const fixture of ['v1-running.json', 'v7-reviewing.json']) {
    const statePath = path.join(root, fixture);
    await writeFile(statePath, await readFile(path.join(FIXTURES, fixture), 'utf8'));
    const first = await readRunState(statePath);
    const firstBytes = await readFile(statePath, 'utf8');
    const second = await readRunState(statePath);
    const secondBytes = await readFile(statePath, 'utf8');

    assert.equal(first.schema_version, RUN_STATE_VERSION);
    assert.deepEqual(second, first);
    assert.equal(secondBytes, firstBytes);
    assert.equal(JSON.parse(firstBytes).schema_version, RUN_STATE_VERSION);
    assert.equal((await readFile(engineEventLogPath(statePath), 'utf8')).trim().split('\n').length, first.history.length);
  }

  const reviewed = await readRunState(path.join(root, 'v7-reviewing.json'));
  assert.equal(reviewed.review.reviewer_runner, 'claude');
  assert.equal(reviewed.review.reviewer_ladder_tier, 'same_family');
});

test('invalid source bytes remain untouched', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-state-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json');
  const invalid = JSON.parse(await readFile(path.join(FIXTURES, 'v1-running.json'), 'utf8'));
  delete invalid.run.id;
  const original = `${JSON.stringify(invalid, null, 2)}\n`;
  await writeFile(statePath, original);

  await assert.rejects(readRunState(statePath), /run\.id/);
  assert.equal(await readFile(statePath, 'utf8'), original);
  await assert.rejects(readFile(engineEventLogPath(statePath), 'utf8'), { code: 'ENOENT' });
});

test('event log is redacted, ordered, and duplicate-free', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json');
  await writeFile(path.join(root, 'campaign.md'), '# Journal fixture\n', 'utf8');
  let state = fixtureState(root);
  state = transitionRunState(state, { event: 'run_started', at: at(1) });
  state = transitionRunState(state, {
    event: 'check_failed',
    at: at(2),
    message: 'AUTH_SECRET=event-secret',
    details: { access_token: 'token-secret' },
  });

  await persistRunState(statePath, state);
  await persistRunState(statePath, state);
  const lines = (await readFile(engineEventLogPath(statePath), 'utf8')).trim().split('\n');
  const events = lines.map((line) => JSON.parse(line));

  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  assert.equal(events[2].details.access_token, '[REDACTED]');
  assert.doesNotMatch(lines.join('\n'), /event-secret|token-secret/);
  assert.doesNotMatch(await readFile(runJournalPath(statePath), 'utf8'), /event-secret|token-secret/);
  assert.deepEqual(validateEngineEvent({}), {
    valid: false,
    errors: [
      'event must be a published run event',
      'at must be an ISO-8601 timestamp',
      'run_id must be a non-empty string',
      'sequence must be a positive integer',
    ],
  });
  for (const event of events) assert.equal(validateEngineEvent(event).valid, true);
});

function fixtureState(root = '/fixtures/runs/current') {
  return createRunState({
    id: 'fixture-current',
    created_at: at(0),
    identity: {
      registry_id: null,
      source: { campaign_path: path.join(root, 'campaign.md'), repo_root: root },
      execution: {
        campaign_path: path.join(root, 'campaign.md'),
        repo_root: root,
        branch: 'campaign/current',
      },
    },
    steps: [{ id: '1.1', name: 'Current step', phase: '1' }],
    config: {
      runner: 'fixture',
      model: 'fixture-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    },
    artifacts: {
      run_dir: root,
      receipts_dir: path.join(root, 'receipts'),
      final_review_path: path.join(root, 'final-review.md'),
    },
  });
}

function nullUsage() {
  return { input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null };
}

function at(offset) {
  return new Date(Date.parse('2026-07-15T04:00:00.000Z') + offset * 1_000).toISOString();
}

function validateWithSchema(value, schema, root = schema, location = '$') {
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split('/').reduce((current, key) => current[key], root);
    return validateWithSchema(value, target, root, location);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => (
      validateWithSchema(value, candidate, root, location).length === 0
    ));
    return matches.length === 1 ? [] : [`${location} must match exactly one schema`];
  }
  const errors = [];
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${location} has wrong constant`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location} is outside enum`);
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [`${location} has wrong type`];
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${location} is too short`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${location} misses pattern`);
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) errors.push(`${location} is not a date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${location} is below minimum`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${location} is below exclusive minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${location} has too few items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${location} has duplicate items`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateWithSchema(item, schema.items, root, `${location}[${index}]`)));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        errors.push(...validateWithSchema(item, schema.properties[key], root, `${location}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} is not allowed`);
      }
    }
    for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      for (const dependency of dependencies) {
        if (!Object.hasOwn(value, dependency)) errors.push(`${location}.${dependency} is required by ${key}`);
      }
    }
  }
  return errors;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

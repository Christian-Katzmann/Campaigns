import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from './registry.mjs';
import { redactValue, writeRedactedState } from './redaction.mjs';
import {
  RUN_EVENT_NAMES,
  assertValidRunState,
  upgradeRunState,
} from './run-state.mjs';

const RUN_EVENT_SET = new Set(RUN_EVENT_NAMES);

export function engineEventLogPath(statePath) {
  const resolved = path.resolve(statePath);
  const name = path.basename(resolved);
  return path.join(
    path.dirname(resolved),
    name === 'state.json' ? 'events.jsonl' : `${name.slice(0, -path.extname(name).length)}.events.jsonl`,
  );
}

export function engineEventsFromRunState(state) {
  assertValidRunState(state);
  return state.history.map((entry) => {
    const event = {
      event: entry.event,
      at: entry.at,
      run_id: state.run.id,
      sequence: entry.sequence,
    };
    if (entry.step_id != null) event.step_id = entry.step_id;
    if (Object.keys(entry.details).length > 0) event.details = structuredClone(entry.details);
    return event;
  });
}

export function validateEngineEvent(event) {
  const errors = [];
  if (!isObject(event)) return { valid: false, errors: ['event must be an object'] };
  if (!RUN_EVENT_SET.has(event.event)) errors.push('event must be a published run event');
  if (!isTimestamp(event.at)) errors.push('at must be an ISO-8601 timestamp');
  if (!nonEmptyString(event.run_id)) errors.push('run_id must be a non-empty string');
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    errors.push('sequence must be a positive integer');
  }
  if (Object.hasOwn(event, 'step_id') && !nonEmptyString(event.step_id)) {
    errors.push('step_id must be a non-empty string when present');
  }
  if (Object.hasOwn(event, 'details') && !isObject(event.details)) {
    errors.push('details must be an object when present');
  } else if (Object.hasOwn(event.details ?? {}, 'usage')) {
    errors.push(...validateUsage(event.details.usage));
  }
  const unknown = Object.keys(event).filter((key) => (
    !['event', 'at', 'run_id', 'sequence', 'step_id', 'details'].includes(key)
  ));
  if (unknown.length > 0) errors.push(`unknown fields: ${unknown.join(', ')}`);
  return { valid: errors.length === 0, errors };
}

export async function readRunState(statePath) {
  const raw = await readFile(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  const state = upgradeRunState(parsed);
  assertValidRunState(state);
  if (state !== parsed) await persistRunState(statePath, state);
  return state;
}

export async function persistRunState(statePath, state) {
  assertValidRunState(state);
  const redacted = redactValue(state);
  assertValidRunState(redacted);
  const events = engineEventsFromRunState(redacted);
  for (const [index, event] of events.entries()) {
    const result = validateEngineEvent(event);
    if (!result.valid) {
      throw new TypeError(`Invalid engine event ${index + 1}: ${result.errors.join('; ')}`);
    }
  }
  await writeRedactedState(statePath, state);
  await writeFileAtomic(
    engineEventLogPath(statePath),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateUsage(usage) {
  if (!isObject(usage)) return ['details.usage must be an object'];
  const fields = ['input_tokens', 'output_tokens', 'total_tokens', 'cost_usd'];
  const errors = [];
  for (const field of fields) {
    if (!Object.hasOwn(usage, field)) errors.push(`details.usage.${field} is required`);
  }
  for (const field of fields.slice(0, 3)) {
    const value = usage[field];
    if (!(value == null || (Number.isInteger(value) && value >= 0))) {
      errors.push(`details.usage.${field} must be null or a non-negative integer`);
    }
  }
  if (!(usage.cost_usd == null || (
    typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0
  ))) {
    errors.push('details.usage.cost_usd must be null or a non-negative number');
  }
  const unknown = Object.keys(usage).filter((field) => !fields.includes(field));
  if (unknown.length > 0) errors.push(`details.usage has unknown fields: ${unknown.join(', ')}`);
  return errors;
}

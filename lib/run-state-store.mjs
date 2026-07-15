import { access, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from './registry.mjs';
import { redactValue } from './redaction.mjs';
import {
  appendRunJournalEvent,
  foldRunJournal,
  hashRunDocument,
  readRunJournal,
  runJournalPath,
  withRunJournalLock,
} from './run-journal.mjs';
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
  const journalPath = runJournalPath(statePath);
  if (await fileExists(journalPath)) {
    let journal;
    try {
      journal = await readRunJournal(journalPath, { repairTornTail: false });
    } catch (error) {
      if (error.code !== 'RUN_JOURNAL_TORN_TAIL') throw error;
      journal = await withRunJournalLock(journalPath, () => readRunJournal(journalPath));
    }
    if (journal.length > 0) {
      const folded = foldRunJournal(journal);
      const state = upgradeRunState(folded.state);
      assertValidRunState(state);
      if (state !== folded.state) await persistRunState(statePath, state);
      return redactValue(state);
    }
  }

  const parsed = JSON.parse(await readFile(statePath, 'utf8'));
  const state = upgradeRunState(parsed);
  assertValidRunState(state);
  await persistRunState(statePath, state);
  return redactValue(state);
}

export async function persistRunState(statePath, state) {
  assertValidRunState(state);
  const journalPath = runJournalPath(statePath);
  await withRunJournalLock(journalPath, () => persistRunStateUnlocked(statePath, state));
}

async function persistRunStateUnlocked(statePath, state) {
  const journalPath = runJournalPath(statePath);
  const journalState = redactValue(state);
  assertValidRunState(journalState);
  let journal = await readRunJournal(journalPath);
  if (journal.length > 0 && foldRunJournal(journal).run_id !== journalState.run.id) {
    await archiveJournal(journalPath, foldRunJournal(journal).run_id);
    journal = [];
  }

  const snapshotExists = await fileExists(statePath);
  const document = await readCampaignDocument(journalState);
  const type = journal.length === 0
    ? snapshotExists ? 'snapshot_imported' : 'run_initialized'
    : 'state_persisted';
  if (type === 'run_initialized' && document == null) {
    throw new TypeError('A native run journal requires the initial campaign Markdown.');
  }

  journal.push(await appendStateEvent(journalPath, journalState, type, document, journal));
  const folded = foldRunJournal(journal);
  assertValidRunState(folded.state);
  await projectRunState(statePath, folded.state);
}

export async function writeRunDocumentTransition({
  statePath,
  campaignPath,
  beforeMarkdown,
  afterMarkdown,
  kind,
  stepId = null,
}) {
  const liveMarkdown = await readFile(campaignPath, 'utf8');
  if (liveMarkdown !== beforeMarkdown) {
    throw new TypeError(`Campaign Markdown changed before ${kind} could be recorded.`);
  }
  const state = await readRunState(statePath);
  const journalPath = runJournalPath(statePath);
  await withRunJournalLock(journalPath, async () => {
    const journal = await readRunJournal(journalPath);
    const foldedBefore = foldRunJournal(journal);
    if (foldedBefore.run_id !== state.run.id) throw new TypeError('Run journal changed before document write.');
    if (await readFile(campaignPath, 'utf8') !== beforeMarkdown) {
      throw new TypeError(`Campaign Markdown changed before ${kind} could be recorded.`);
    }
    const beforeHash = hashRunDocument(beforeMarkdown);
    if (foldedBefore.current_document?.hash !== beforeHash) {
      journal.push(await appendDocumentEvent(journalPath, state.run.id, {
        campaign_path: path.resolve(campaignPath),
        kind: 'document_observed',
        step_id: stepId,
        before_hash: foldedBefore.current_document?.hash ?? beforeHash,
        after_hash: beforeHash,
        markdown: beforeMarkdown,
      }, journal));
    }
    await writeFileAtomic(campaignPath, afterMarkdown);
    journal.push(await appendDocumentEvent(journalPath, state.run.id, {
      campaign_path: path.resolve(campaignPath),
      kind,
      step_id: stepId,
      before_hash: beforeHash,
      after_hash: hashRunDocument(afterMarkdown),
      markdown: afterMarkdown,
    }, journal));
    const folded = foldRunJournal(journal);
    await projectRunState(statePath, folded.state);
  });
}

async function appendStateEvent(journalPath, state, type, document = null, journal = null) {
  return appendRunJournalEvent(journalPath, {
    type,
    run_id: state.run.id,
    payload: {
      state: structuredClone(state),
      ...(type === 'snapshot_imported' ? { replay: 'non_historical_snapshot' } : {}),
      ...(['run_initialized', 'snapshot_imported'].includes(type) && document != null
        ? { document }
        : {}),
    },
  }, { locked: true, events: journal });
}

async function appendDocumentEvent(journalPath, runId, document, journal) {
  return appendRunJournalEvent(journalPath, {
    type: 'document_transition',
    run_id: runId,
    payload: { document },
  }, { locked: true, events: journal });
}

async function projectRunState(statePath, state) {
  const redacted = redactValue(state);
  assertValidRunState(redacted);
  const events = engineEventsFromRunState(redacted);
  for (const [index, event] of events.entries()) {
    const result = validateEngineEvent(event);
    if (!result.valid) {
      throw new TypeError(`Invalid engine event ${index + 1}: ${result.errors.join('; ')}`);
    }
  }
  await writeIfChanged(statePath, `${JSON.stringify(redacted, null, 2)}\n`);
  await writeIfChanged(
    engineEventLogPath(statePath),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

async function readCampaignDocument(state) {
  const candidates = [
    state.run.identity.execution.campaign_path,
    state.run.identity.source.campaign_path,
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  for (const campaignPath of candidates) {
    try {
      const markdown = await readFile(campaignPath, 'utf8');
      return {
        campaign_path: path.resolve(campaignPath),
        markdown,
        hash: hashRunDocument(markdown),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function archiveJournal(journalPath, runId) {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const extension = path.extname(journalPath);
  const stem = journalPath.slice(0, -extension.length).replace(/\.jsonl$/, '');
  let archivePath = `${stem}-${safeRunId}${extension}`;
  if (await fileExists(archivePath)) archivePath = `${stem}-${safeRunId}-${Date.now()}${extension}`;
  await rename(journalPath, archivePath);
}

async function writeIfChanged(filePath, contents) {
  try {
    if (await readFile(filePath, 'utf8') === contents) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileAtomic(filePath, contents);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

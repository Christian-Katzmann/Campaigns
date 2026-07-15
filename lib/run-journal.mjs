import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const RUN_JOURNAL_VERSION = 1;

const EVENT_TYPES = new Set([
  'run_initialized',
  'snapshot_imported',
  'state_persisted',
  'document_transition',
]);

export function runJournalPath(statePath) {
  const resolved = path.resolve(statePath);
  const name = path.basename(resolved);
  return path.join(
    path.dirname(resolved),
    name === 'state.json'
      ? 'journal.jsonl'
      : `${name.slice(0, -path.extname(name).length)}.journal.jsonl`,
  );
}

export function hashRunDocument(markdown) {
  return createHash('sha256').update(String(markdown)).digest('hex');
}

export function hashRunJournalEvent(event) {
  const unsigned = structuredClone(event);
  delete unsigned.hash;
  return createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
}

export function createRunJournalEvent(previous, input) {
  if (!isObject(input)) throw new TypeError('journal event input must be an object');
  if (!EVENT_TYPES.has(input.type)) throw new TypeError(`unsupported journal event type: ${input.type}`);
  if (!nonEmptyString(input.run_id)) throw new TypeError('journal event run_id must be a non-empty string');
  const at = input.at ?? new Date().toISOString();
  if (!isTimestamp(at)) throw new TypeError('journal event at must be an ISO-8601 timestamp');
  const payload = structuredClone(input.payload ?? {});
  const reserved = ['journal_version', 'sequence', 'at', 'type', 'run_id', 'previous_hash', 'hash'];
  const collision = reserved.find((field) => Object.hasOwn(payload, field));
  if (collision) throw new TypeError(`journal event payload cannot replace ${collision}`);
  const event = {
    journal_version: RUN_JOURNAL_VERSION,
    sequence: previous == null ? 1 : previous.sequence + 1,
    at,
    type: input.type,
    run_id: input.run_id,
    previous_hash: previous?.hash ?? null,
    ...payload,
  };
  event.hash = hashRunJournalEvent(event);
  return event;
}

export function foldRunJournal(events) {
  if (!Array.isArray(events)) throw new TypeError('journal must be an array');
  let state = null;
  let runId = null;
  let previous = null;
  let exactReplay = false;
  let currentDocument = null;
  const documents = [];

  for (const [index, event] of events.entries()) {
    validateEnvelope(event, previous, index);
    if (index === 0 && !['run_initialized', 'snapshot_imported'].includes(event.type)) {
      throw journalError(index, 'first event must initialize or import the run');
    }
    if (runId == null) runId = event.run_id;
    if (event.run_id !== runId) throw journalError(index, 'run_id changed within one journal');

    if (['run_initialized', 'snapshot_imported', 'state_persisted'].includes(event.type)) {
      if (!isObject(event.state)) throw journalError(index, `${event.type} must include state`);
      if (event.state.run?.id !== runId) throw journalError(index, 'state run id does not match journal run id');
      state = structuredClone(event.state);
    }

    if (event.type === 'run_initialized') {
      if (index !== 0) throw journalError(index, 'run_initialized must be the first event');
      exactReplay = true;
      currentDocument = validateDocumentSnapshot(event.document, index);
      documents.push({
        sequence: event.sequence,
        at: event.at,
        type: event.type,
        ...structuredClone(currentDocument),
      });
    } else if (event.type === 'snapshot_imported') {
      if (index !== 0) throw journalError(index, 'snapshot_imported must be the first event');
      if (event.replay !== 'non_historical_snapshot') {
        throw journalError(index, 'snapshot_imported must be labelled non_historical_snapshot');
      }
      exactReplay = false;
      if (event.document != null) {
        currentDocument = validateDocumentSnapshot(event.document, index);
        documents.push({
          sequence: event.sequence,
          at: event.at,
          type: event.type,
          ...structuredClone(currentDocument),
        });
      }
    } else if (event.type === 'document_transition') {
      const transition = validateDocumentTransition(event.document, index);
      if (currentDocument != null && transition.before_hash !== currentDocument.hash) {
        throw journalError(index, 'before_hash does not match the previous document');
      }
      currentDocument = {
        campaign_path: transition.campaign_path,
        markdown: transition.markdown,
        hash: transition.after_hash,
      };
      documents.push({
        sequence: event.sequence,
        at: event.at,
        type: event.type,
        kind: transition.kind,
        step_id: transition.step_id,
        before_hash: transition.before_hash,
        after_hash: transition.after_hash,
        ...structuredClone(currentDocument),
      });
    }
    previous = event;
  }

  return {
    state,
    run_id: runId,
    exact_replay: exactReplay,
    replay_scope: exactReplay ? 'native_journal' : 'snapshot_forward_only',
    current_document: currentDocument,
    documents,
  };
}

export async function readRunJournal(journalPath, { repairTornTail = true } = {}) {
  let bytes;
  try {
    bytes = await readFile(journalPath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (bytes.length === 0) return [];

  if (bytes.at(-1) !== 0x0a) {
    if (!repairTornTail) {
      const error = new TypeError('Run journal has a torn final line.');
      error.code = 'RUN_JOURNAL_TORN_TAIL';
      throw error;
    }
    const finalNewline = bytes.lastIndexOf(0x0a);
    const keepBytes = finalNewline < 0 ? 0 : finalNewline + 1;
    const handle = await open(journalPath, 'r+');
    try {
      await handle.truncate(keepBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    bytes = bytes.subarray(0, keepBytes);
  }

  if (bytes.length === 0) return [];
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  const events = lines.map((line, index) => {
    if (!line) throw journalError(index, 'blank lines are not allowed');
    try {
      return JSON.parse(line);
    } catch (error) {
      throw journalError(index, `invalid JSON: ${error.message}`);
    }
  });
  foldRunJournal(events);
  return events;
}

export async function appendRunJournalEvent(journalPath, input, { locked = false, events = null } = {}) {
  if (!locked) {
    return withRunJournalLock(journalPath, () => (
      appendRunJournalEvent(journalPath, input, { locked: true })
    ));
  }
  await mkdir(path.dirname(journalPath), { recursive: true });
  const currentEvents = events ?? await readRunJournal(journalPath);
  const event = createRunJournalEvent(currentEvents.at(-1) ?? null, input);
  const handle = await open(journalPath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}

export async function withRunJournalLock(journalPath, callback) {
  const lockPath = `${journalPath}.lock`;
  await mkdir(path.dirname(journalPath), { recursive: true });
  const token = randomUUID();
  const startedAt = Date.now();
  let handle;
  while (handle == null) {
    try {
      const candidate = await open(lockPath, 'wx', 0o600);
      try {
        await candidate.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeStaleJournalLock(lockPath)) continue;
      if (Date.now() - startedAt >= 15_000) {
        throw new Error(`Timed out waiting for run journal lock: ${lockPath}`);
      }
      await delay(10);
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.token === token) await rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validateEnvelope(event, previous, index) {
  if (!isObject(event)) throw journalError(index, 'event must be an object');
  if (event.journal_version !== RUN_JOURNAL_VERSION) {
    throw journalError(index, `journal_version must be ${RUN_JOURNAL_VERSION}`);
  }
  if (event.sequence !== index + 1) throw journalError(index, `sequence must be ${index + 1}`);
  if (!isTimestamp(event.at)) throw journalError(index, 'at must be an ISO-8601 timestamp');
  if (!EVENT_TYPES.has(event.type)) throw journalError(index, `unsupported type ${event.type}`);
  if (!nonEmptyString(event.run_id)) throw journalError(index, 'run_id must be a non-empty string');
  if (event.previous_hash !== (previous?.hash ?? null)) throw journalError(index, 'previous_hash mismatch');
  if (!/^[0-9a-f]{64}$/.test(event.hash ?? '')) throw journalError(index, 'hash must be sha256 hex');
  if (hashRunJournalEvent(event) !== event.hash) throw journalError(index, 'hash mismatch');
}

function validateDocumentSnapshot(document, index) {
  if (!isObject(document)) throw journalError(index, 'initial event must include document');
  if (!nonEmptyString(document.campaign_path)) throw journalError(index, 'document campaign_path is required');
  if (typeof document.markdown !== 'string') throw journalError(index, 'document markdown must be a string');
  if (document.hash !== hashRunDocument(document.markdown)) throw journalError(index, 'document hash mismatch');
  return structuredClone(document);
}

function validateDocumentTransition(document, index) {
  if (!isObject(document)) throw journalError(index, 'document_transition must include document');
  if (!nonEmptyString(document.campaign_path)) throw journalError(index, 'document campaign_path is required');
  if (!nonEmptyString(document.kind)) throw journalError(index, 'document kind is required');
  if (!(document.step_id == null || nonEmptyString(document.step_id))) {
    throw journalError(index, 'document step_id must be null or a non-empty string');
  }
  if (!/^[0-9a-f]{64}$/.test(document.before_hash ?? '')) throw journalError(index, 'before_hash must be sha256 hex');
  if (!/^[0-9a-f]{64}$/.test(document.after_hash ?? '')) throw journalError(index, 'after_hash must be sha256 hex');
  if (typeof document.markdown !== 'string') throw journalError(index, 'document markdown must be a string');
  if (document.after_hash !== hashRunDocument(document.markdown)) throw journalError(index, 'after_hash mismatch');
  return structuredClone(document);
}

function journalError(index, message) {
  return new TypeError(`Invalid run journal event ${index + 1}: ${message}`);
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

async function removeStaleJournalLock(lockPath) {
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs < 1_000) return false;
    } catch (statError) {
      if (statError.code === 'ENOENT') return true;
      throw statError;
    }
    await rm(lockPath, { force: true });
    return true;
  }
  if (processIsAlive(lock.pid)) return false;
  await rm(lockPath, { force: true });
  return true;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

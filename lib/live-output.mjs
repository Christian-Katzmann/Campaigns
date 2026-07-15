import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LIVE_OUTPUT_MAX_BYTES = 64 * 1024;
export const LIVE_OUTPUT_FILE_MAX_BYTES = 96 * 1024;

export async function createLiveOutputTransport({ filePath, runId, stepId, invocationId }) {
  const identity = {
    run_id: requireValue(runId, 'runId'),
    step_id: requireValue(stepId, 'stepId'),
    invocation_id: requireValue(invocationId, 'invocationId'),
  };
  const target = path.resolve(requireValue(filePath, 'filePath'));
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await rm(temporary, { force: true });

  let retained = Buffer.alloc(0);
  let endCursor = 0;
  let dirty = false;
  let closing = false;
  let closed = false;
  let flushing = null;

  const snapshot = () => ({
    version: 1,
    ...identity,
    start_cursor: endCursor - retained.length,
    end_cursor: endCursor,
    data_base64: retained.toString('base64'),
    updated_at: new Date().toISOString(),
  });

  const writeSnapshot = async (value) => {
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    } catch {
      // Live output is observational. Runner completion must not depend on it.
      await rm(temporary, { force: true }).catch(() => {});
    }
  };

  const flush = () => {
    if (flushing || closed) return flushing;
    flushing = (async () => {
      while (dirty && !closed) {
        dirty = false;
        await writeSnapshot(snapshot());
      }
    })().finally(() => {
      flushing = null;
      if (dirty && !closed) flush();
    });
    return flushing;
  };

  await writeSnapshot(snapshot());

  return {
    append(chunk) {
      if (closing || closed) return;
      const incoming = Buffer.from(String(chunk ?? ''), 'utf8');
      if (incoming.length === 0) return;
      endCursor += incoming.length;
      if (incoming.length >= LIVE_OUTPUT_MAX_BYTES) {
        retained = Buffer.from(incoming.subarray(incoming.length - LIVE_OUTPUT_MAX_BYTES));
      } else {
        const keep = Math.max(0, LIVE_OUTPUT_MAX_BYTES - incoming.length);
        const previous = retained.length > keep ? retained.subarray(retained.length - keep) : retained;
        retained = Buffer.concat([previous, incoming], previous.length + incoming.length);
      }
      dirty = true;
      flush();
    },
    async close() {
      if (closing || closed) return;
      closing = true;
      await flushing;
      if (dirty) {
        dirty = false;
        await writeSnapshot(snapshot());
      }
      closed = true;
      await Promise.all([
        rm(target, { force: true }),
        rm(temporary, { force: true }),
      ]);
    },
  };
}

export async function readLiveOutputSnapshot(filePath, expected = {}) {
  const target = path.resolve(filePath);
  const details = await stat(target);
  if (!details.isFile() || details.size > LIVE_OUTPUT_FILE_MAX_BYTES) {
    throw new Error('Live output transport exceeded its byte bound.');
  }
  const parsed = JSON.parse(await readFile(target, 'utf8'));
  if (parsed?.version !== 1) throw new Error('Unsupported live output transport.');
  for (const [field, value] of Object.entries({
    run_id: expected.runId,
    step_id: expected.stepId,
    invocation_id: expected.invocationId,
  })) {
    if (value != null && parsed[field] !== value) throw new Error(`Live output ${field} mismatch.`);
  }
  if (
    !Number.isSafeInteger(parsed.start_cursor)
    || !Number.isSafeInteger(parsed.end_cursor)
    || parsed.start_cursor < 0
    || parsed.end_cursor < parsed.start_cursor
    || typeof parsed.data_base64 !== 'string'
  ) {
    throw new Error('Malformed live output transport.');
  }
  const data = Buffer.from(parsed.data_base64, 'base64');
  if (data.length > LIVE_OUTPUT_MAX_BYTES || data.length !== parsed.end_cursor - parsed.start_cursor) {
    throw new Error('Malformed live output transport bounds.');
  }
  return { ...parsed, data };
}

function requireValue(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required.`);
  return value;
}

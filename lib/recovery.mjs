import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { defaultCampaignsRunsDir, runPathsForCampaign } from './pump.mjs';
import { writeFileAtomic } from './registry.mjs';
import { assertValidRunState, transitionRunState, upgradeRunState } from './run-state.mjs';

const SALVAGE_TAIL_BYTES = 16_000;

export class RecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryError';
  }
}

export async function recoverCampaign(campaignFile, options = {}) {
  const env = options.env ?? process.env;
  const campaignPath = path.resolve(campaignFile);
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const paths = runPathsForCampaign(campaignPath, runsDir);
  let state = await readState(paths.statePath);
  const lock = await readRunLock(paths.lockPath);
  const activePid = firstLivePid([lock?.data?.pid, state.worker?.pid]);

  if (activePid) {
    throw new RecoveryError(`Run is still active (pid ${activePid}); recovery made no changes.`);
  }

  const runningStep = state.steps.find((step) => step.status === 'running') ?? null;
  const deadWorker = Boolean(runningStep);
  const staleLock = Boolean(lock);
  const recoverableStep = state.steps.find((step) => ['failed', 'stopped'].includes(step.status)) ?? null;
  const reviewHalt = state.run.status === 'halted'
    && state.steps.every((step) => ['completed', 'skipped'].includes(step.status));

  if (!staleLock && !deadWorker && !recoverableStep && !reviewHalt && state.run.status !== 'blocked') {
    throw new RecoveryError(`Run status ${state.run.status} has no safe recovery action.`);
  }

  const actions = [];
  let stepToReset = recoverableStep;

  if (deadWorker) {
    const outputTail = await readTail(state.worker?.log_path);
    state = transitionRunState(state, {
      event: 'step_failed',
      step_id: runningStep.id,
      message: `Worker process disappeared during Step ${runningStep.id}; salvaged its output for retry.`,
      failure: {
        code: 'worker_exit',
        message: 'Worker process is no longer running.',
        retryable: true,
        output_tail: outputTail || 'No worker output was available to salvage.',
      },
      details: {
        worker_pid: state.worker?.pid ?? null,
        log_path: state.worker?.log_path ?? null,
      },
    });
    stepToReset = state.steps.find((step) => step.id === runningStep.id);
    actions.push('failed_dead_worker_with_salvage');
  }

  if (state.run.status !== 'recovering') {
    state = transitionRunState(state, {
      event: 'recovery_started',
      step_id: stepToReset?.id ?? null,
      message: 'Diagnosed the interrupted run and started safe recovery.',
      details: {
        stale_lock: staleLock,
        dead_worker: deadWorker,
        previous_status: state.run.status,
      },
    });
  }

  if (staleLock) {
    await rm(paths.lockPath, { force: true });
    state = transitionRunState(state, {
      event: 'stale_lock_released',
      step_id: stepToReset?.id ?? null,
      message: 'Released the stale run lock.',
      details: {
        lock_path: paths.lockPath,
        lock_pid: integerOrNull(lock.data?.pid),
      },
    });
    actions.push('released_stale_lock');
  }

  if (stepToReset) {
    const previousStatus = stepToReset.status;
    state = transitionRunState(state, {
      event: 'step_reset_by_recover',
      step_id: stepToReset.id,
      message: `Reset Step ${stepToReset.id} to pending for the next run.`,
      details: { previous_step_status: previousStatus },
    });
    actions.push('reset_step');
  }

  if (state.recovery?.from_status === 'blocked') actions.push('cleared_blocker_for_retry');
  if (reviewHalt) actions.push('returned_to_review_boundary');

  const resumeStatus = reviewHalt || state.recovery?.from_status === 'awaiting_review'
    ? 'awaiting_review'
    : state.recovery?.from_status === 'pending'
      ? 'pending'
      : 'running';
  state = transitionRunState(state, {
    event: 'recovery_completed',
    step_id: stepToReset?.id ?? null,
    resume_status: resumeStatus,
    message: `Recovery completed; run is ${resumeStatus}.`,
    details: { actions },
  });
  await writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);

  return {
    ok: true,
    message: `Recovered campaign; run is ${resumeStatus} and ready for ${resumeStatus === 'awaiting_review' ? 'review' : 'campaigns run'}.`,
    campaignPath,
    statePath: paths.statePath,
    status: resumeStatus,
    actions,
    state,
  };
}

async function readState(statePath) {
  let state;
  try {
    state = upgradeRunState(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RecoveryError(`No new-engine run state found for this campaign: ${statePath}`);
    }
    if (error instanceof SyntaxError) throw new RecoveryError(`Run state is not valid JSON: ${statePath}`);
    throw error;
  }
  try {
    assertValidRunState(state);
  } catch (error) {
    throw new RecoveryError(error.message);
  }
  return state;
}

async function readRunLock(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      // A malformed lock cannot identify a live owner, so recovery treats it as stale.
    }
    return { raw, data };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function firstLivePid(values) {
  for (const value of values) {
    const pid = integerOrNull(value);
    if (pid && isProcessAlive(pid)) return pid;
  }
  return null;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readTail(filePath, maxBytes = SALVAGE_TAIL_BYTES) {
  if (!filePath) return '';
  let handle;
  try {
    const details = await stat(filePath);
    const length = Math.min(details.size, maxBytes);
    const buffer = Buffer.alloc(length);
    handle = await open(filePath, 'r');
    await handle.read(buffer, 0, length, Math.max(0, details.size - length));
    return buffer.toString('utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    await handle?.close();
  }
}

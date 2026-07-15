import { execFile } from 'node:child_process';
import { readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  defaultCampaignsRunsDir,
  pruneExecutionWorktree,
  runPathsForCampaign,
} from './pump.mjs';
import { redactText, writeRedactedFile, writeRedactedState } from './redaction.mjs';
import { assertValidRunState, transitionRunState, upgradeRunState } from './run-state.mjs';

const SALVAGE_TAIL_BYTES = 16_000;
const execFileAsync = promisify(execFile);

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
  const activePid = firstLivePid([
    lock?.data?.pid,
    ...(state.workers ?? []).map((worker) => worker?.pid),
    state.worker?.pid,
  ]);

  if (activePid) {
    throw new RecoveryError(`Run is still active (pid ${activePid}); recovery made no changes.`);
  }

  const runningSteps = state.steps.filter((step) => step.status === 'running');
  const deadWorker = runningSteps.length > 0;
  const staleLock = Boolean(lock);
  const recoverableStep = state.steps.find((step) => ['failed', 'stopped'].includes(step.status)) ?? null;
  const reviewHalt = state.run.status === 'halted'
    && state.steps.every((step) => ['completed', 'skipped'].includes(step.status));

  if (!staleLock && !deadWorker && !recoverableStep && !reviewHalt && state.run.status !== 'blocked') {
    throw new RecoveryError(`Run status ${state.run.status} has no safe recovery action.`);
  }

  const actions = [];
  let stepToReset = recoverableStep;

  if (state.artifacts.worktree && !state.artifacts.worktree.pruned_at) {
    const safe = await executionWorktreeIsSafe(state);
    if (safe) {
      actions.push('adopted_execution_worktree');
    } else {
      const pruned = await pruneExecutionWorktree(state, paths.statePath, { deleteBranch: false });
      if (!pruned.branchRetained) {
        throw new RecoveryError('Recovery pruned the execution worktree but could not retain its branch.');
      }
      actions.push('pruned_execution_worktree_retained_branch');
    }
  }

  if (deadWorker) {
    for (const runningStep of runningSteps) {
      const worker = state.workers?.find((candidate) => candidate.step_id === runningStep.id)
        ?? state.worker;
      const outputTail = await readTail(worker?.log_path);
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
          worker_pid: worker?.pid ?? null,
          log_path: worker?.log_path ?? null,
        },
      });
    }
    stepToReset = state.steps.find((step) => step.id === runningSteps[0].id);
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

  const stepsToReset = state.steps.filter((step) => ['failed', 'stopped'].includes(step.status));
  for (const resetStep of stepsToReset) {
    const previousStatus = resetStep.status;
    state = transitionRunState(state, {
      event: 'step_reset_by_recover',
      step_id: resetStep.id,
      message: `Reset Step ${resetStep.id} to pending for the next run.`,
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
  await writeRedactedState(paths.statePath, state);

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
  try {
    const raw = await readFile(filePath, 'utf8');
    const redacted = redactText(raw);
    if (redacted !== raw) await writeRedactedFile(filePath, redacted);
    const bytes = Buffer.from(redacted);
    return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function executionWorktreeIsSafe(state) {
  const worktree = state.artifacts.worktree;
  try {
    const expectedPath = await realpath(worktree.path);
    const listed = await execFileAsync('git', [
      '-C', state.run.identity.source.repo_root, 'worktree', 'list', '--porcelain',
    ]);
    const record = listed.stdout.split(/\n\n+/).find((candidate) => (
      candidate.split('\n').includes(`worktree ${expectedPath}`)
    ));
    if (!record || !record.split('\n').includes(`branch refs/heads/${worktree.branch}`)) return false;
    const status = await execFileAsync('git', [
      '-C', worktree.path, 'status', '--porcelain=v1', '--untracked-files=all',
    ]);
    return status.stdout.trim() === '';
  } catch {
    return false;
  }
}

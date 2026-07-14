import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, realpathSync, watch as watchFileSystem } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  deliverRemoteNotification,
  displayNativeNotification,
  sanitizeNotificationSettings,
} from './notifications.mjs';
import { readRegistry, writeFileAtomic } from './registry.mjs';
import {
  createStreamingRedactor,
  redactText,
  writeRedactedFile,
  writeRedactedState,
} from './redaction.mjs';
import { runFinalReview, runFixAttempt } from './review.mjs';
import {
  assertValidRunState,
  createRunState,
  transitionRunState,
  upgradeRunState,
} from './run-state.mjs';
import {
  buildRunnerInvocation,
  classifyRunnerResult,
  createRunnerCompletionInstruction,
  createRunnerRegistry,
  DEFAULT_RUNNER_CONFIG_PATH,
} from './runners.mjs';
import {
  CHECK_LINE_REGEX,
  extractFinalReview,
  extractStepSections,
  linkChecksToSteps,
  parseMarkdown,
} from '../public/lib/parser.mjs';

export const DEFAULT_MAX_STEPS_PER_RUN = 50;
export const DEFAULT_MAX_RUN_MINUTES = 360;
export const DEFAULT_STOP_GRACE_MS = 3_000;

export class PumpLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PumpLockError';
  }
}

export class PumpRunError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PumpRunError';
    Object.assign(this, details);
  }
}

export class CampaignStopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CampaignStopError';
  }
}

class StepPreflightError extends Error {
  constructor(event, message, details = {}) {
    super(message);
    this.name = 'StepPreflightError';
    this.event = event;
    this.details = details;
  }
}

export function defaultCampaignsDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.CAMPAIGNS_REGISTRY_DIR) return path.resolve(env.CAMPAIGNS_REGISTRY_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Campaigns');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Campaigns');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'campaigns');
}

export function defaultCampaignsRunsDir(env = process.env) {
  return path.resolve(env.CAMPAIGNS_RUNS_DIR || path.join(defaultCampaignsDataDir(env), 'runs'));
}

export function runPathsForCampaign(campaignFile, runsDir = defaultCampaignsRunsDir()) {
  let campaignPath = path.resolve(campaignFile);
  try {
    campaignPath = realpathSync.native(campaignPath);
  } catch {
    // Recovery still needs a stable lookup when the campaign file was deleted.
  }
  const stem = path.basename(campaignPath, path.extname(campaignPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'campaign';
  const digest = createHash('sha256').update(campaignPath).digest('hex').slice(0, 12);
  const runDir = path.join(path.resolve(runsDir), `${stem}-${digest}`);
  return {
    runDir,
    statePath: path.join(runDir, 'state.json'),
    lockPath: path.join(runDir, 'run.lock'),
    receiptsDir: path.join(runDir, 'receipts'),
    logsDir: path.join(runDir, 'logs'),
    finalReviewPath: path.join(runDir, 'final-review.md'),
    stopRequestPath: path.join(runDir, 'stop-request.json'),
  };
}

export async function requestCampaignStop(campaignFile, options = {}) {
  const env = options.env ?? process.env;
  const campaignPath = await canonicalExistingPath(campaignFile, 'Campaign file');
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const paths = runPathsForCampaign(campaignPath, runsDir);
  let state;
  try {
    state = upgradeRunState(JSON.parse(await readFile(paths.statePath, 'utf8')));
    assertValidRunState(state);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new CampaignStopError(`No active run found for ${campaignPath}.`);
    }
    throw error;
  }

  const activeStatuses = new Set([
    'pending',
    'running',
    'blocked',
    'failed',
    'awaiting_review',
    'awaiting_human_review',
    'reviewing',
    'reworking',
    'recovering',
  ]);
  if (!activeStatuses.has(state.run.status)) {
    throw new CampaignStopError(`Campaign run is ${state.run.status}, not active.`);
  }

  const requestedAt = new Date().toISOString();
  const graceMs = positiveIntegerOr(
    numberOption(options.stopGraceMs) ?? state.config.stop_grace_ms,
    DEFAULT_STOP_GRACE_MS,
    'stop grace',
  );
  await writeFileAtomic(paths.stopRequestPath, `${JSON.stringify({
    version: 1,
    requested_at: requestedAt,
    requested_by_pid: process.pid,
    grace_ms: graceMs,
  }, null, 2)}\n`);

  const startedAt = Date.now();
  const waitTimeoutMs = positiveIntegerOr(
    numberOption(options.waitTimeoutMs),
    graceMs + 5_000,
    'stop wait timeout',
  );
  let groupTerminated = false;
  while (Date.now() - startedAt < waitTimeoutMs) {
    state = upgradeRunState(JSON.parse(await readFile(paths.statePath, 'utf8')));
    if (state.run.status === 'stopped_by_user') {
      return { ok: true, campaignPath, statePath: paths.statePath, state, groupTerminated };
    }

    if (!groupTerminated && Date.now() - startedAt >= graceMs && isProcessAlive(state.worker?.pid)) {
      groupTerminated = true;
      signalProcessGroupPid(state.worker.pid, 'SIGTERM');
      await delay(250);
      if (isProcessAlive(state.worker?.pid)) signalProcessGroupPid(state.worker.pid, 'SIGKILL');
    }

    const lock = await readLock(paths.lockPath);
    if (!isProcessAlive(lock?.pid) && !isProcessAlive(state.worker?.pid)) {
      const salvagePath = await writeStopSalvage(state, paths);
      state = transitionRunState(state, {
        event: 'stopped_by_user',
        step_id: state.run.current_step_id,
        message: 'Stopped by user after the pump process exited.',
        details: {
          forced: groupTerminated,
          grace_ms: graceMs,
          salvage_path: salvagePath,
        },
      });
      await persistState(paths.statePath, state);
      return { ok: true, campaignPath, statePath: paths.statePath, state, groupTerminated };
    }
    await delay(25);
  }

  throw new CampaignStopError(`Stop request did not settle within ${waitTimeoutMs}ms.`);
}

export function parseCampaignPlan(markdown) {
  const blocks = parseMarkdown(markdown);
  const sections = extractStepSections(blocks, markdown);
  const checkByStep = linkChecksToSteps(blocks, sections);
  const blockIndexes = new Map(blocks.map((block, index) => [block.id, index]));
  const steps = sections.map((section) => {
    const check = checkByStep.get(section.anchorId);
    if (!check) throw new PumpRunError(`Step ${section.number} has no linked progress checkbox.`);
    const start = blockIndexes.get(section.anchorId);
    let prompt = null;
    for (let index = start + 1; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'heading' && block.level <= 2) break;
      if (block.type === 'code') {
        prompt = block.content;
        break;
      }
    }
    if (!prompt?.trim()) throw new PumpRunError(`Step ${section.number} has no fenced prompt.`);
    return {
      id: section.number,
      name: section.title.replace(/^steps?\s+[\d.x–-]+(?:\s*[–-]\s*[\d.x]+)?\s*[—–-]?\s*/i, '').trim()
        || `Step ${section.number}`,
      phase: section.number.match(/^\d+/)?.[0] ?? null,
      checked: check.checked,
      checklistLine: check.lineStart,
      prompt,
    };
  });
  if (steps.length === 0) throw new PumpRunError('Campaign has no runnable steps.');

  const { title, branch } = parseCampaignMetadata(blocks);
  const finalReview = extractFinalReview(blocks);
  const finalReviewPrompt = finalReview?.code?.content?.trim() || null;

  return { title, branch, steps, finalReviewPrompt };
}

function parseCampaignMetadata(blocks) {
  const title = blocks.find((block) => block.type === 'heading' && block.level === 1)?.text ?? 'Campaign';
  const branch = blocks
    .filter((block) => block.type === 'list')
    .flatMap((block) => block.items)
    .map((item) => item.text.match(/^\*\*Branch:\*\*\s*`([^`]+)`/i)?.[1] ?? null)
    .find(Boolean) ?? null;
  return { title, branch };
}

export async function runCampaign(campaignFile, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout === undefined ? process.stdout : options.stdout;
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const campaignPath = await canonicalExistingPath(campaignFile, 'Campaign file');
  const configPath = path.resolve(options.configPath ?? DEFAULT_RUNNER_CONFIG_PATH);
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const repoRoot = await resolveContainedRepoRoot(
    campaignPath,
    options.repoRoot ?? rawConfig.run?.repoRoot,
  );
  const paths = runPathsForCampaign(campaignPath, runsDir);

  await mkdir(paths.runDir, { recursive: true });
  await rm(paths.stopRequestPath, { force: true });
  const lock = await acquireRunLock(paths.lockPath, campaignPath);
  try {
    const runnerRegistry = createRunnerRegistry(rawConfig);
    const initialMarkdown = await readFile(campaignPath, 'utf8');
    const initialBlocks = parseMarkdown(initialMarkdown);
    let initialParseError = null;
    let initialPlan;
    try {
      initialPlan = parseCampaignPlan(initialMarkdown);
    } catch (error) {
      initialParseError = error;
      initialPlan = { ...parseCampaignMetadata(initialBlocks), steps: [] };
    }
    const requestedBranch = options.branch ?? rawConfig.run?.branch ?? initialPlan.branch;
    const mergeTargetBranch = await discoverDefaultBranch(repoRoot, requestedBranch);
    const branch = await resolveRequestedBranch(repoRoot, requestedBranch);
    const plan = initialPlan;
    const runnerName = options.runner ?? runnerRegistry.defaultRunner;
    const runner = runnerRegistry.get(runnerName);
    const requestedEffort = options.effort ?? runner.defaults.effort;
    const effort = runner.effortMap[requestedEffort] ?? requestedEffort;
    const model = options.model ?? runner.defaults.model;
    const identity = await resolveRunIdentity({
      campaignPath,
      repoRoot,
      branch,
      mergeTargetBranch,
      registryId: options.registryId ?? null,
      env,
    });
    const maxFixAttempts = positiveIntegerOr(
      rawConfig.review?.maxFixAttempts,
      2,
      'review.maxFixAttempts',
    );
    const forceMergeUnreviewed = options.forceMergeUnreviewed === true
      || rawConfig.review?.forceMergeUnreviewed === true;
    const maxStepsPerRun = positiveIntegerOr(
      numberOption(options.maxStepsPerRun) ?? rawConfig.run?.max_steps_per_run,
      DEFAULT_MAX_STEPS_PER_RUN,
      'run.max_steps_per_run',
    );
    const maxRunMinutes = positiveNumberOr(
      numberOption(options.maxRunMinutes) ?? rawConfig.run?.max_run_minutes,
      DEFAULT_MAX_RUN_MINUTES,
      'run.max_run_minutes',
    );
    const stopGraceMs = positiveIntegerOr(
      numberOption(options.stopGraceMs) ?? rawConfig.run?.stop_grace_ms,
      DEFAULT_STOP_GRACE_MS,
      'run.stop_grace_ms',
    );

    await mkdir(paths.receiptsDir, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    let state = await loadOrCreateState({
      paths,
      plan,
      identity,
      runnerName,
      model,
      effort,
      watchdog: runnerRegistry.watchdog,
      maxFixAttempts,
      forceMergeUnreviewed,
      maxStepsPerRun,
      maxRunMinutes,
      stopGraceMs,
      allowPlanMismatch: Boolean(initialParseError),
    });

    if (state.worker?.pid && isProcessAlive(state.worker.pid)) {
      throw new PumpLockError(
        `A worker for this campaign is still running (pid ${state.worker.pid}).`,
      );
    }
    state = await prepareStateForResume(
      state,
      plan,
      paths.statePath,
      { allowPlanMismatch: Boolean(initialParseError) },
    );

    if (state.run.status === 'awaiting_review') {
      return runReviewBoundary({
        state,
        plan,
        paths,
        runnerRegistry,
        runnerName,
        repoRoot,
        model,
        effort,
        env,
        options,
        stdout,
        stderr,
      });
    }
    if ([
      'awaiting_human_review',
      'cap_reached',
      'stopped_by_user',
      'completed',
      'merged',
      'force_merged',
    ].includes(state.run.status)) {
      stdout?.write(`Campaign run is ${state.run.status}.\nState: ${paths.statePath}\n`);
      return { ...paths, state };
    }

    if (initialParseError) {
      const stepId = state.steps.find((step) => step.status === 'pending')?.id ?? null;
      const message = `Preflight stopped run start${stepId ? ` before Step ${stepId}` : ''}: campaign markdown is invalid (${initialParseError.message}). Remedy: restore the step checklist and fenced prompts, then rerun campaigns run.`;
      state = transitionRunState(state, {
        event: 'preflight_campaign_invalid',
        step_id: stepId,
        message,
        details: {
          cause: initialParseError.message,
          campaign_path: campaignPath,
        },
      });
      await persistState(paths.statePath, state);
      throw new PumpRunError(message, {
        statePath: paths.statePath,
        preflightEvent: 'preflight_campaign_invalid',
      });
    }

    const runDeadlineMs = Date.parse(state.run.started_at) + state.config.max_run_minutes * 60_000;
    let preflightStage = 'run start';
    while (true) {
      if (await hasStopRequest(paths.stopRequestPath)) {
        state = transitionRunState(state, {
          event: 'stopped_by_user',
          message: 'Stopped by user at a campaign boundary.',
          details: { forced: false, boundary: true },
        });
        await persistState(paths.statePath, state);
        stdout?.write(`Campaign stopped by user.\nState: ${paths.statePath}\n`);
        return { ...paths, state };
      }
      if (Date.now() >= runDeadlineMs) {
        state = transitionRunState(state, {
          event: 'cap_reached',
          message: `Run-time cap reached after ${state.config.max_run_minutes} minutes.`,
          details: {
            cap: 'max_run_minutes',
            limit: state.config.max_run_minutes,
          },
        });
        await persistState(paths.statePath, state);
        stdout?.write(`Run-time cap reached.\nState: ${paths.statePath}\n`);
        return { ...paths, state };
      }
      const preflightStepId = state.steps.find((step) => step.status === 'pending')?.id ?? null;
      let currentPlan;
      try {
        currentPlan = await runStepPreflight({
          campaignPath,
          repoRoot,
          branch,
          state,
          stepId: preflightStepId,
          stage: preflightStage,
        });
      } catch (error) {
        if (!(error instanceof StepPreflightError)) throw error;
        state = transitionRunState(state, {
          event: error.event,
          step_id: preflightStepId,
          message: error.message,
          details: error.details,
        });
        await persistState(paths.statePath, state);
        throw new PumpRunError(error.message, {
          statePath: paths.statePath,
          preflightEvent: error.event,
        });
      }
      state = await syncCheckedSteps(state, currentPlan, paths.statePath);
      const nextStep = currentPlan.steps.find((step) => !step.checked);

      if (!nextStep) {
        if (state.run.status !== 'awaiting_review') {
          state = transitionRunState(state, {
            event: 'run_reached_final_review',
            message: 'All implementation steps are checked; final review is ready.',
          });
          await persistState(paths.statePath, state);
        }
        return runReviewBoundary({
          state,
          plan: currentPlan,
          paths,
          runnerRegistry,
          runnerName,
          repoRoot,
          model,
          effort,
          env,
          options,
          stdout,
          stderr,
        });
      }

      const completedThisRun = state.history.filter((entry) => entry.event === 'step_completed').length;
      if (completedThisRun >= state.config.max_steps_per_run) {
        state = transitionRunState(state, {
          event: 'cap_reached',
          step_id: nextStep.id,
          message: `Step cap reached after ${completedThisRun} completed steps; Step ${nextStep.id} was not started.`,
          details: {
            cap: 'max_steps_per_run',
            limit: state.config.max_steps_per_run,
            completed_steps: completedThisRun,
          },
        });
        await persistState(paths.statePath, state);
        stdout?.write(`Step cap reached.\nState: ${paths.statePath}\n`);
        return { ...paths, state };
      }

      const ledgerStep = state.steps.find((step) => step.id === nextStep.id);
      if (ledgerStep.status !== 'pending') {
        throw new PumpRunError(
          `Markdown says Step ${nextStep.id} is unchecked, but its ledger status is ${ledgerStep.status}.`,
          { statePath: paths.statePath },
        );
      }

      const invocationId = randomUUID();
      const attempt = ledgerStep.attempt + 1;
      const logPath = path.join(paths.logsDir, `${safeStepId(nextStep.id)}-${attempt}.log`);
      const outputPath = path.join(paths.logsDir, `${safeStepId(nextStep.id)}-${attempt}-last-message.md`);
      const receiptPath = path.join(paths.receiptsDir, `${safeStepId(nextStep.id)}-${attempt}.md`);
      const expected = {
        run_id: state.run.id,
        step_id: nextStep.id,
        invocation_id: invocationId,
      };
      const prompt = buildWorkerPrompt(state, nextStep, runnerRegistry, runnerName, expected);
      const invocation = buildRunnerInvocation(runnerRegistry, runnerName, {
        prompt,
        repoRoot,
        outputPath,
        model,
        effort,
        env,
      });

      stdout?.write(`Starting Step ${nextStep.id}: ${nextStep.name}\n`);
      const result = await runRunnerInvocation(invocation, {
        cwd: repoRoot,
        containmentRoot: repoRoot,
        logPath,
        ignoredActivityPaths: [paths.runDir],
        signal: options.signal,
        stopRequestPath: paths.stopRequestPath,
        stopGraceMs: state.config.stop_grace_ms,
        deadlineMs: runDeadlineMs,
        stdout,
        stderr,
        watchdog: state.config.watchdog,
        onSpawn: async (pid) => {
          state = transitionRunState(state, {
            event: 'step_started',
            step_id: nextStep.id,
            message: `Started Step ${nextStep.id}: ${nextStep.name}`,
            worker: {
              runner: runnerName,
              invocation_id: invocationId,
              pid,
              log_path: logPath,
            },
          });
          await persistState(paths.statePath, state);
        },
      });
      if (result.stop?.requested || result.cap) {
        if (result.stop?.requested && !result.stop.forced) {
          const boundaryResult = classifyRunnerResult(runnerRegistry, runnerName, {
            ...result,
            expected,
            receiptPath,
          });
          if (boundaryResult.completed) {
            await writeReceipt(receiptPath, {
              runId: state.run.id,
              step: nextStep,
              runner: invocation.runner,
              model: invocation.model,
              effort: invocation.effort,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              logPath,
            });
            const ticked = await tickCampaignStep(campaignPath, nextStep.id);
            state = transitionRunState(state, {
              ...boundaryResult.transition,
              message: `Completed Step ${nextStep.id} before the stop boundary.`,
            });
            await persistState(paths.statePath, state);
            if (ticked) await commitCampaignTick(repoRoot, campaignPath, nextStep.id);
            state = transitionRunState(state, {
              event: 'stopped_by_user',
              step_id: nextStep.id,
              message: `Stopped by user after Step ${nextStep.id} reached the boundary.`,
              details: { forced: false, boundary: true, receipt_path: receiptPath },
            });
            await persistState(paths.statePath, state);
            return { ...paths, state };
          }
        }
        const event = result.stop?.requested ? 'stopped_by_user' : 'cap_reached';
        const message = result.stop?.requested
          ? `Stopped by user during Step ${nextStep.id}${result.stop.forced ? '; worker process group terminated after grace period' : ''}.`
          : `Run-time cap reached during Step ${nextStep.id}; worker process group terminated.`;
        await writeReceipt(receiptPath, {
          runId: state.run.id,
          step: nextStep,
          runner: invocation.runner,
          model: invocation.model,
          effort: invocation.effort,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          logPath,
          status: event,
          outputTail: result.outputTail,
        });
        state = transitionRunState(state, {
          event,
          step_id: nextStep.id,
          message,
          details: {
            cap: result.cap?.kind ?? null,
            forced: result.stop?.forced ?? true,
            grace_ms: result.stop?.grace_ms ?? null,
            salvage_path: receiptPath,
            output_tail: result.outputTail,
          },
        });
        await persistState(paths.statePath, state);
        stdout?.write(`${message}\nSalvage: ${receiptPath}\nState: ${paths.statePath}\n`);
        return { ...paths, state };
      }
      const classified = result.watchdog?.stalled
        ? {
            completed: false,
            transition: {
              event: 'step_failed',
              step_id: nextStep.id,
              failure: {
                code: 'watchdog_stalled',
                message: result.watchdog.message,
                retryable: true,
                output_tail: result.outputTail,
              },
            },
          }
        : classifyRunnerResult(runnerRegistry, runnerName, {
            ...result,
            expected,
            receiptPath,
          });

      if (!classified.completed) {
        if (result.watchdog?.stalled) {
          await writeReceipt(receiptPath, {
            runId: state.run.id,
            step: nextStep,
            runner: invocation.runner,
            model: invocation.model,
            effort: invocation.effort,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            logPath,
            status: 'failed',
            failure: classified.transition.failure,
            outputTail: result.outputTail,
          });
        }
        state = transitionRunState(state, {
          ...classified.transition,
          message: classified.transition.failure.message,
        });
        await persistState(paths.statePath, state);
        throw new PumpRunError(
          `Step ${nextStep.id} failed: ${classified.transition.failure.message}`,
          { statePath: paths.statePath, failure: classified.transition.failure },
        );
      }

      await writeReceipt(receiptPath, {
        runId: state.run.id,
        step: nextStep,
        runner: invocation.runner,
        model: invocation.model,
        effort: invocation.effort,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        logPath,
      });
      const ticked = await tickCampaignStep(campaignPath, nextStep.id);
      state = transitionRunState(state, {
        ...classified.transition,
        message: `Completed Step ${nextStep.id}: ${nextStep.name}`,
      });
      await persistState(paths.statePath, state);
      if (ticked) await commitCampaignTick(repoRoot, campaignPath, nextStep.id);
      stdout?.write(`Completed Step ${nextStep.id}. Receipt: ${receiptPath}\n`);
      preflightStage = 'between steps';
    }
  } finally {
    await rm(paths.stopRequestPath, { force: true });
    await releaseRunLock(paths.lockPath, lock.token);
  }
}

async function runReviewBoundary({
  state: initialState,
  plan,
  paths,
  runnerRegistry,
  runnerName,
  repoRoot,
  model,
  effort,
  env,
  options,
  stdout,
  stderr,
}) {
  let state = initialState;
  let review = null;
  let reviewRound = 0;
  let fixAttempts = 0;
  const runDeadlineMs = Date.parse(state.run.started_at) + state.config.max_run_minutes * 60_000;
  const guardedRunInvocation = (invocation, invocationOptions) => runRunnerInvocation(invocation, {
    ...invocationOptions,
    containmentRoot: repoRoot,
    stopRequestPath: paths.stopRequestPath,
    stopGraceMs: state.config.stop_grace_ms,
    deadlineMs: runDeadlineMs,
  });

  while (true) {
    if (await hasStopRequest(paths.stopRequestPath)) {
      state = transitionRunState(state, {
        event: 'stopped_by_user',
        message: 'Stopped by user at the final-review boundary.',
        details: { forced: false, boundary: true },
      });
      await persistState(paths.statePath, state);
      return { ...paths, state };
    }
    if (Date.now() >= runDeadlineMs) {
      state = transitionRunState(state, {
        event: 'cap_reached',
        message: `Run-time cap reached after ${state.config.max_run_minutes} minutes before final review.`,
        details: { cap: 'max_run_minutes', limit: state.config.max_run_minutes },
      });
      await persistState(paths.statePath, state);
      return { ...paths, state };
    }
    reviewRound += 1;
    state = transitionRunState(state, {
      event: 'final_review_started',
      message: `Final review round ${reviewRound} started.`,
    });
    await persistState(paths.statePath, state);
    stdout?.write(`Starting final review round ${reviewRound}.\n`);

    review = await runFinalReview({
      state,
      reviewPrompt: plan.finalReviewPrompt,
      reviewRound,
      registry: runnerRegistry,
      runnerName,
      repoRoot,
      paths,
      model,
      effort,
      env,
      watchdog: state.config.watchdog,
      signal: options.signal,
      stdout,
      stderr,
      runInvocation: guardedRunInvocation,
      onReask: async ({ issue }) => {
        state = transitionRunState(state, {
          event: 'final_review_reasked',
          message: `Final review was re-asked once: ${issue}.`,
          issue,
        });
        await persistState(paths.statePath, state);
      },
    });

    if (review.kind === 'stopped' || review.kind === 'cap_reached') {
      const event = review.kind === 'stopped' ? 'stopped_by_user' : 'cap_reached';
      state = transitionRunState(state, {
        event,
        message: review.kind === 'stopped'
          ? 'Stopped by user during final review.'
          : 'Run-time cap reached during final review.',
        details: {
          cap: review.cap?.kind ?? null,
          forced: review.stop?.forced ?? true,
          grace_ms: review.stop?.grace_ms ?? null,
          salvage_path: review.review_path,
          output_tail: review.output_tail,
        },
      });
      await persistState(paths.statePath, state);
      return { ...paths, state, review };
    }

    const common = {
      reasons: review.reasons,
      raw_tags: review.raw_tags,
      review_path: review.review_path,
    };
    if (review.kind === 'approved') {
      const merge = await mergeCampaignBranch(state);
      if (!merge.ok) {
        state = transitionRunState(state, {
          event: 'review_merge_failed',
          message: `Approved review could not merge: ${merge.error}`,
          error: merge.error,
          verdict: 'APPROVED',
          ...common,
        });
        await persistState(paths.statePath, state);
        await notifyAwaitingHumanReview(state, env, options);
        return { ...paths, state, review, merge };
      }
      state = transitionRunState(state, {
        event: 'final_review_approved',
        message: 'Final review approved the campaign.',
        ...common,
      });
      if (merge.reason !== 'source_is_target') {
        state = transitionRunState(state, {
          event: 'campaign_merged',
          message: merge.skipped
            ? `Campaign was already merged into ${merge.target_branch}.`
            : `Merged ${merge.source_branch} into ${merge.target_branch}.`,
          details: merge,
        });
      }
      await persistState(paths.statePath, state);
      const outcome = merge.reason === 'source_is_target'
        ? `completed on ${merge.target_branch}`
        : `merged into ${merge.target_branch}`;
      stdout?.write(`Final review APPROVED; ${outcome}.\nState: ${paths.statePath}\n`);
      return { ...paths, state, review, merge };
    }

    if (review.kind === 'unparseable') {
      state = transitionRunState(state, {
        event: 'review_unparseable',
        message: 'Final review remained unparseable after one structured re-ask.',
        ...common,
      });
      await persistState(paths.statePath, state);
      return finishUnreviewed({ state, review, paths, env, options, stdout });
    }

    state = transitionRunState(state, {
      event: 'final_review_needs_work',
      message: 'Final review found work to fix.',
      ...common,
    });
    await persistState(paths.statePath, state);

    let committed = false;
    while (fixAttempts < (state.config.max_fix_attempts ?? 2)) {
      fixAttempts += 1;
      state = transitionRunState(state, {
        event: 'final_fix_started',
        attempt: fixAttempts,
        message: `Started final-review fix attempt ${fixAttempts}.`,
      });
      await persistState(paths.statePath, state);

      const fix = await runFixAttempt({
        attempt: fixAttempts,
        state,
        review,
        acceptanceCriteria: plan.finalReviewPrompt,
        registry: runnerRegistry,
        runnerName,
        repoRoot,
        paths,
        model,
        effort,
        env,
        watchdog: state.config.watchdog,
        signal: options.signal,
        stdout,
        stderr,
        runInvocation: guardedRunInvocation,
        readHead: gitHead,
      });
      if (fix.stop?.requested || fix.cap) {
        const event = fix.stop?.requested ? 'stopped_by_user' : 'cap_reached';
        state = transitionRunState(state, {
          event,
          message: fix.stop?.requested
            ? 'Stopped by user during final-review rework.'
            : 'Run-time cap reached during final-review rework.',
          details: {
            cap: fix.cap?.kind ?? null,
            forced: fix.stop?.forced ?? true,
            grace_ms: fix.stop?.grace_ms ?? null,
            salvage_path: fix.log_path,
            output_tail: fix.output_tail,
          },
        });
        await persistState(paths.statePath, state);
        return { ...paths, state, review };
      }
      if (!fix.committed) {
        const reason = fix.watchdog?.stalled
          ? 'runner_stalled'
          : fix.exit_code === 0 ? 'no_commit' : 'runner_failed';
        state = transitionRunState(state, {
          event: 'final_fix_failed',
          attempt: fixAttempts,
          reason,
          log_path: fix.log_path,
          message: `Fix attempt ${fixAttempts} failed: ${reason}.`,
        });
        await persistState(paths.statePath, state);
        continue;
      }

      state = transitionRunState(state, {
        event: 'final_rework_completed',
        attempt: fixAttempts,
        commit_sha: fix.commit_sha,
        message: `Fix attempt ${fixAttempts} committed ${fix.commit_sha}.`,
      });
      await persistState(paths.statePath, state);
      committed = true;
      break;
    }

    if (committed) continue;

    if (state.config.force_merge_unreviewed) {
      return finishUnreviewed({ state, review, paths, env, options, stdout });
    }
    state = transitionRunState(state, {
      event: 'review_fix_attempts_exhausted',
      attempts: fixAttempts,
      message: `Final-review fix cap reached after ${fixAttempts} attempts.`,
    });
    await persistState(paths.statePath, state);
    await notifyAwaitingHumanReview(state, env, options);
    stdout?.write(`Final review NEEDS WORK; awaiting human review after ${fixAttempts} fix attempts.\nState: ${paths.statePath}\n`);
    return { ...paths, state, review };
  }
}

async function finishUnreviewed({ state: initialState, review, paths, env, options, stdout }) {
  let state = initialState;
  if (!state.config.force_merge_unreviewed) {
    await notifyAwaitingHumanReview(state, env, options);
    stdout?.write(`Final review requires human attention.\nState: ${paths.statePath}\n`);
    return { ...paths, state, review };
  }

  const merge = await mergeCampaignBranch(state);
  if (!merge.ok) {
    state = transitionRunState(state, {
      event: 'review_merge_failed',
      message: `Explicit force-merge could not merge: ${merge.error}`,
      error: merge.error,
      verdict: review.verdict,
      reasons: review.reasons,
      raw_tags: review.raw_tags,
      review_path: review.review_path,
    });
    await persistState(paths.statePath, state);
    await notifyAwaitingHumanReview(state, env, options);
    return { ...paths, state, review, merge };
  }
  state = transitionRunState(state, {
    event: 'force_merged_unreviewed',
    explicit: true,
    reasons: review.reasons,
    raw_tags: review.raw_tags,
    message: `Explicitly force-merged ${merge.source_branch} into ${merge.target_branch}.`,
    details: merge,
  });
  await persistState(paths.statePath, state);
  stdout?.write(`Force-merged unreviewed work into ${merge.target_branch}.\nState: ${paths.statePath}\n`);
  return { ...paths, state, review, merge };
}

export async function mergeCampaignBranch(state) {
  const execution = state.run.identity.execution;
  const sourceBranch = execution.branch;
  const targetBranch = execution.merge_target_branch
    ?? await discoverDefaultBranch(execution.repo_root, sourceBranch);
  const repoRoot = execution.repo_root;
  const sourceHead = await gitHead(repoRoot, sourceBranch);
  const base = {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    source_sha: sourceHead,
  };
  if (sourceBranch === targetBranch) {
    return { ok: true, skipped: true, reason: 'source_is_target', target_sha: sourceHead, ...base };
  }

  const sourceStatus = await gitResult(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!sourceStatus.ok) return { ok: false, error: sourceStatus.error, ...base };
  if (sourceStatus.stdout.trim()) {
    return { ok: false, error: `source worktree is dirty: ${sourceStatus.stdout.trim()}`, ...base };
  }

  const worktrees = await listGitWorktrees(repoRoot);
  const existing = worktrees.find((worktree) => worktree.branch === targetBranch);
  let targetRoot = existing?.path ?? null;
  let temporary = false;
  if (!targetRoot) {
    targetRoot = path.join(state.artifacts.run_dir, `merge-target-${randomUUID()}`);
    const added = await gitResult(repoRoot, ['worktree', 'add', targetRoot, targetBranch]);
    if (!added.ok) return { ok: false, error: `could not prepare merge target: ${added.error}`, ...base };
    temporary = true;
  }

  try {
    const status = await gitResult(targetRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.ok) return { ok: false, error: status.error, ...base };
    if (status.stdout.trim()) {
      return { ok: false, error: `merge target ${targetBranch} is dirty: ${status.stdout.trim()}`, ...base };
    }

    const targetHead = await gitHead(targetRoot, targetBranch);
    const sourceIsMerged = await gitIsAncestor(repoRoot, sourceHead, targetHead);
    if (sourceIsMerged) {
      return { ok: true, skipped: true, reason: 'already_merged', target_sha: targetHead, ...base };
    }
    const canFastForward = await gitIsAncestor(repoRoot, targetHead, sourceHead);
    if (!canFastForward) {
      return {
        ok: false,
        error: `merge target ${targetBranch} has diverged from ${sourceBranch}`,
        target_sha: targetHead,
        ...base,
      };
    }

    const merged = await gitResult(targetRoot, ['merge', '--ff-only', sourceBranch]);
    if (!merged.ok) return { ok: false, error: `fast-forward merge failed: ${merged.error}`, ...base };
    const targetSha = await gitHead(targetRoot, targetBranch);
    if (!(await gitIsAncestor(repoRoot, sourceHead, targetSha))) {
      return { ok: false, error: 'merge verification failed', target_sha: targetSha, ...base };
    }
    return { ok: true, skipped: false, target_sha: targetSha, ...base };
  } finally {
    if (temporary) {
      await runCommand('git', ['-C', repoRoot, 'worktree', 'remove', targetRoot]);
    }
  }
}

async function notifyAwaitingHumanReview(state, env, options) {
  if (typeof options.notifyAwaitingHumanReview === 'function') {
    await options.notifyAwaitingHumanReview(state);
    return;
  }
  let settings;
  try {
    const settingsPath = path.join(defaultCampaignsDataDir(env), 'notification-settings.json');
    settings = sanitizeNotificationSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    options.stderr?.write(`Could not read notification settings: ${error.message}\n`);
    return;
  }
  const title = 'Campaign needs review';
  const message = `${path.basename(state.run.identity.execution.campaign_path)} is awaiting human review.`;
  const deliveries = [];
  if (settings.macNotificationsEnabled) {
    deliveries.push(displayNativeNotification(title, message, 'Basso'));
  }
  if (settings.ntfyTopic || settings.webhookUrl) {
    deliveries.push(deliverRemoteNotification({
      title,
      message,
      ntfyTopic: settings.ntfyTopic,
      webhookUrl: settings.webhookUrl,
      fetchImpl: options.notificationFetch,
    }));
  }
  await Promise.allSettled(deliveries);
}

async function acquireRunLock(lockPath, campaignPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        campaign_path: campaignPath,
        started_at: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      await handle.close();
      return { token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readLock(lockPath);
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new PumpLockError(
          `Campaign run already active (pid ${existing.pid}, started ${existing.started_at ?? 'unknown'}).`,
        );
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new PumpLockError('Could not acquire the campaign run lock.');
}

async function releaseRunLock(lockPath, token) {
  const existing = await readLock(lockPath);
  if (existing?.token === token) await rm(lockPath, { force: true });
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {};
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function loadOrCreateState({
  paths,
  plan,
  identity,
  runnerName,
  model,
  effort,
  watchdog,
  maxFixAttempts,
  forceMergeUnreviewed,
  maxStepsPerRun,
  maxRunMinutes,
  stopGraceMs,
  allowPlanMismatch = false,
}) {
  try {
    const state = upgradeRunState(JSON.parse(await readFile(paths.statePath, 'utf8')));
    assertValidRunState(state);
    if (allowPlanMismatch) return state;

    const invalidCampaignBootstrap = (
      state.steps.length === 0
      && plan.steps.length > 0
      && state.run.status === 'blocked'
      && state.blockers.some((blocker) => blocker.event === 'preflight_campaign_invalid')
    );
    if (!invalidCampaignBootstrap) assertSameSteps(state, plan);

    const reopened = state.steps.some((step) => (
      ['completed', 'skipped'].includes(step.status)
      && !plan.steps.find((candidate) => candidate.id === step.id)?.checked
    ));
    if (!invalidCampaignBootstrap && !reopened) return state;
    if (state.worker?.pid && isProcessAlive(state.worker.pid)) {
      throw new PumpLockError(`Cannot reopen the campaign while worker pid ${state.worker.pid} is running.`);
    }

    const archivePath = path.join(paths.runDir, `state-${safeStepId(state.run.id)}.json`);
    await rename(paths.statePath, archivePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let state = createRunState({
    id: randomUUID(),
    identity,
    steps: plan.steps.map((step) => ({ id: step.id, name: step.name, phase: step.phase })),
    config: {
      runner: runnerName,
      model,
      effort,
      watchdog,
      max_fix_attempts: maxFixAttempts,
      force_merge_unreviewed: forceMergeUnreviewed,
      max_steps_per_run: maxStepsPerRun,
      max_run_minutes: maxRunMinutes,
      stop_grace_ms: stopGraceMs,
    },
    artifacts: {
      run_dir: paths.runDir,
      receipts_dir: paths.receiptsDir,
      final_review_path: paths.finalReviewPath,
    },
  });
  state = transitionRunState(state, { event: 'run_started', message: 'Campaign run started.' });
  await persistState(paths.statePath, state);
  return state;
}

async function prepareStateForResume(state, plan, statePath, { allowPlanMismatch = false } = {}) {
  if (state.run.status === 'pending' || state.run.status === 'blocked') {
    state = transitionRunState(state, { event: 'run_started', message: 'Campaign run resumed.' });
  } else if (state.run.status === 'running' && state.run.current_step_id) {
    const stepId = state.run.current_step_id;
    state = transitionRunState(state, {
      event: 'step_failed',
      step_id: stepId,
      message: `Previous pump stopped during Step ${stepId}.`,
      failure: {
        code: 'unknown',
        message: 'Previous pump stopped before the worker reported completion.',
        retryable: true,
        output_tail: null,
      },
    });
  }

  if (state.run.status === 'failed') {
    const step = state.steps.find((candidate) => ['failed', 'stopped'].includes(candidate.status));
    state = transitionRunState(state, {
      event: 'recovery_started',
      step_id: step?.id ?? null,
      message: 'Resuming an interrupted campaign run.',
    });
    if (step) {
      state = transitionRunState(state, {
        event: 'step_reset_by_recover',
        step_id: step.id,
        message: `Reset Step ${step.id} to pending for resume.`,
      });
    }
    state = transitionRunState(state, {
      event: 'recovery_completed',
      resume_status: 'running',
      message: 'Interrupted run recovered.',
    });
  }

  if ([
    'awaiting_review',
    'awaiting_human_review',
    'cap_reached',
    'stopped_by_user',
    'completed',
    'merged',
    'force_merged',
  ].includes(state.run.status)) {
    return state;
  }
  if (state.run.status !== 'running') {
    throw new PumpRunError(`Run cannot resume from status ${state.run.status}.`, { statePath });
  }
  if (!allowPlanMismatch) assertSameSteps(state, plan);
  await persistState(statePath, state);
  return state;
}

async function syncCheckedSteps(state, plan, statePath) {
  if (state.run.status === 'awaiting_review') return state;
  for (const planStep of plan.steps) {
    const step = state.steps.find((candidate) => candidate.id === planStep.id);
    if (planStep.checked && step.status === 'pending') {
      state = transitionRunState(state, {
        event: 'step_skipped',
        step_id: step.id,
        message: 'Already checked in campaign markdown; markdown is source of truth.',
      });
    }
  }
  await persistState(statePath, state);
  return state;
}

function assertSameSteps(state, plan) {
  const stateIds = state.steps.map((step) => step.id);
  const planIds = plan.steps.map((step) => step.id);
  if (stateIds.length !== planIds.length || stateIds.some((id, index) => id !== planIds[index])) {
    throw new PumpRunError('Campaign steps changed since this run ledger was created.');
  }
}

async function persistState(statePath, state) {
  assertValidRunState(state);
  await writeRedactedState(statePath, state);
}

async function resolveRunIdentity({ campaignPath, repoRoot, branch, mergeTargetBranch, registryId, env }) {
  const registryDir = defaultCampaignsDataDir(env);
  const registry = await readRegistry(path.join(registryDir, 'registry.json'));
  const entry = registryId
    ? registry.campaigns.find((candidate) => candidate.id === registryId)
    : registry.campaigns.find((candidate) => path.resolve(candidate.filePath) === campaignPath);
  const sourceCampaignPath = entry?.filePath ? path.resolve(entry.filePath) : campaignPath;
  let sourceRepoRoot = repoRoot;
  try {
    sourceRepoRoot = await findGitRoot(path.dirname(sourceCampaignPath));
  } catch {
    // An execution worktree can outlive a missing source checkout; keep the known execution root.
  }
  return {
    registry_id: entry?.id ?? registryId ?? null,
    source: { campaign_path: sourceCampaignPath, repo_root: sourceRepoRoot },
    execution: {
      campaign_path: campaignPath,
      repo_root: repoRoot,
      branch,
      merge_target_branch: mergeTargetBranch,
      merge_target_repo_root: sourceRepoRoot,
    },
  };
}

async function findGitRoot(cwd) {
  const result = await runCommand('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new PumpRunError(`Campaign is not inside a Git repository: ${cwd}`);
  }
  return realpath(path.resolve(result.stdout.trim()));
}

async function resolveContainedRepoRoot(campaignPath, override) {
  const candidate = override == null
    ? await findGitRoot(path.dirname(campaignPath))
    : await canonicalExistingPath(override, 'Repository root');
  const repoRoot = await findGitRoot(candidate);
  if (override != null && repoRoot !== candidate) {
    throw new PumpRunError(`--repo must name the Git root itself: ${repoRoot}`);
  }
  assertPathContained(repoRoot, campaignPath, 'Campaign file');
  return repoRoot;
}

async function canonicalExistingPath(value, label) {
  try {
    return await realpath(path.resolve(value));
  } catch (error) {
    throw new PumpRunError(`${label} does not exist: ${path.resolve(value)}`, { cause: error });
  }
}

function assertPathContained(repoRoot, candidate, label) {
  if (!isSameOrInside(candidate, repoRoot)) {
    throw new PumpRunError(`${label} resolves outside repository root ${repoRoot}: ${candidate}`);
  }
}

export async function discoverDefaultBranch(repoRoot, requestedBranch = null) {
  const remoteHead = await runCommand('git', [
    '-C', repoRoot,
    'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead.exitCode === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace(/^origin\//, '');
  }

  const worktrees = await listGitWorktrees(repoRoot);
  const primaryBranch = worktrees[0]?.branch;
  if (primaryBranch && primaryBranch !== requestedBranch) return primaryBranch;

  const current = await runCommand('git', ['-C', repoRoot, 'branch', '--show-current']);
  const currentBranch = current.stdout.trim();
  if (current.exitCode === 0 && currentBranch && currentBranch !== requestedBranch) return currentBranch;

  const configured = await runCommand('git', ['-C', repoRoot, 'config', '--get', 'init.defaultBranch']);
  if (configured.exitCode === 0 && configured.stdout.trim()) return configured.stdout.trim();

  const branches = await runCommand('git', [
    '-C', repoRoot,
    'for-each-ref', '--format=%(refname:short)', 'refs/heads',
  ]);
  const candidates = branches.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  for (const conventional of ['main', 'master']) {
    if (candidates.includes(conventional)) return conventional;
  }
  const fallback = candidates.find((candidate) => candidate !== requestedBranch);
  if (fallback) return fallback;
  if (currentBranch) return currentBranch;
  throw new PumpRunError('Could not discover the repository default branch.');
}

async function listGitWorktrees(repoRoot) {
  const result = await runCommand('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) throw new PumpRunError(result.stderr.trim() || 'Could not list Git worktrees.');
  const records = result.stdout.trim().split(/\n\n+/).filter(Boolean);
  return records.map((record) => {
    const lines = record.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? '';
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice(7) ?? '';
    return {
      path: path.resolve(worktreePath),
      branch: branchRef.replace(/^refs\/heads\//, '') || null,
    };
  });
}

async function gitHead(repoRoot, ref = 'HEAD') {
  const result = await gitResult(repoRoot, ['rev-parse', '--verify', ref]);
  if (!result.ok) throw new PumpRunError(result.error);
  return result.stdout.trim();
}

async function gitIsAncestor(repoRoot, ancestor, descendant) {
  const result = await runCommand('git', [
    '-C', repoRoot,
    'merge-base', '--is-ancestor', ancestor, descendant,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new PumpRunError(result.stderr.trim() || 'Could not compare Git branches.');
}

async function gitResult(repoRoot, args) {
  const result = await runCommand('git', ['-C', repoRoot, ...args]);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    error: result.stderr.trim() || result.stdout.trim() || `git ${args[0]} exited ${result.exitCode}`,
  };
}

function positiveIntegerOr(value, fallback, label) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function positiveNumberOr(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

function numberOption(value) {
  if (value == null || value === '') return null;
  return typeof value === 'number' ? value : Number(value);
}

async function resolveRequestedBranch(repoRoot, requestedBranch) {
  const current = await runCommand('git', ['-C', repoRoot, 'branch', '--show-current']);
  if (current.exitCode !== 0) throw new PumpRunError(current.stderr.trim() || 'Could not read Git branch.');
  const branch = requestedBranch?.trim() || current.stdout.trim();
  if (!branch) throw new PumpRunError('A branch is required when running from detached HEAD.');
  return branch;
}

async function runStepPreflight({ campaignPath, repoRoot, branch, state, stepId, stage }) {
  let plan;
  try {
    plan = parseCampaignPlan(await readFile(campaignPath, 'utf8'));
    assertSameSteps(state, plan);
  } catch (error) {
    const message = `Preflight stopped ${stage}${stepId ? ` before Step ${stepId}` : ''}: campaign markdown is invalid (${error.message}). Remedy: restore the step checklist and fenced prompts, then rerun campaigns run.`;
    throw new StepPreflightError('preflight_campaign_invalid', message, {
      cause: error.message,
      campaign_path: campaignPath,
    });
  }

  const status = await runCommand('git', [
    '-C', repoRoot,
    'status', '--porcelain=v1', '--untracked-files=all',
  ]);
  if (status.exitCode !== 0) {
    const cause = status.stderr.trim() || 'git status failed';
    const message = `Preflight stopped ${stage}${stepId ? ` before Step ${stepId}` : ''}: Git could not inspect the worktree (${cause}). Remedy: repair the repository, then rerun campaigns run.`;
    throw new StepPreflightError('preflight_branch_unavailable', message, { cause, branch });
  }
  if (status.stdout.trim()) {
    const message = `Preflight stopped ${stage}${stepId ? ` before Step ${stepId}` : ''}: the worktree has uncommitted changes. Remedy: commit, stash, or discard them, then rerun campaigns run.`;
    throw new StepPreflightError('preflight_dirty_worktree', message, {
      paths: status.stdout.trim().split('\n'),
    });
  }

  try {
    await assertBranchCanBePrepared(repoRoot, branch);
    await prepareBranch(repoRoot, branch);
  } catch (error) {
    const message = `Preflight stopped ${stage}${stepId ? ` before Step ${stepId}` : ''}: branch ${branch} cannot be checked out or created (${error.message}). Remedy: resolve the branch or worktree conflict, then rerun campaigns run.`;
    throw new StepPreflightError('preflight_branch_unavailable', message, {
      branch,
      cause: error.message,
    });
  }

  try {
    plan = parseCampaignPlan(await readFile(campaignPath, 'utf8'));
    assertSameSteps(state, plan);
    return plan;
  } catch (error) {
    const message = `Preflight stopped ${stage}${stepId ? ` before Step ${stepId}` : ''}: campaign markdown is invalid after checking out ${branch} (${error.message}). Remedy: restore the campaign file on that branch, then rerun campaigns run.`;
    throw new StepPreflightError('preflight_campaign_invalid', message, {
      cause: error.message,
      branch,
      campaign_path: campaignPath,
    });
  }
}

async function assertBranchCanBePrepared(repoRoot, branch) {
  const valid = await runCommand('git', ['-C', repoRoot, 'check-ref-format', '--branch', branch]);
  if (valid.exitCode !== 0) {
    throw new PumpRunError(valid.stderr.trim() || `Invalid branch name: ${branch}`);
  }

  const current = await runCommand('git', ['-C', repoRoot, 'branch', '--show-current']);
  if (current.exitCode !== 0) {
    throw new PumpRunError(current.stderr.trim() || 'Could not read Git branch.');
  }
  if (current.stdout.trim() === branch) return;

  const exists = await runCommand('git', [
    '-C', repoRoot,
    'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
  ]);
  if (exists.exitCode !== 0) return;

  const dryRun = await runCommand('git', ['-C', repoRoot, 'read-tree', '-n', '-m', 'HEAD', branch]);
  if (dryRun.exitCode !== 0) {
    throw new PumpRunError(dryRun.stderr.trim() || `Could not dry-run checkout of ${branch}.`);
  }
}

async function prepareBranch(repoRoot, requestedBranch) {
  const current = await runCommand('git', ['-C', repoRoot, 'branch', '--show-current']);
  if (current.exitCode !== 0) throw new PumpRunError(current.stderr.trim() || 'Could not read Git branch.');
  const currentBranch = current.stdout.trim();
  const branch = requestedBranch?.trim() || currentBranch;
  if (!branch) throw new PumpRunError('A branch is required when running from detached HEAD.');
  if (branch === currentBranch) return branch;

  const exists = await runCommand('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = exists.exitCode === 0 ? ['switch', branch] : ['switch', '-c', branch];
  const switched = await runCommand('git', ['-C', repoRoot, ...args]);
  if (switched.exitCode !== 0) {
    throw new PumpRunError(`Could not prepare branch ${branch}: ${switched.stderr.trim()}`);
  }
  return branch;
}

function buildWorkerPrompt(state, step, registry, runnerName, expected) {
  return [
    `Campaign: ${state.run.identity.execution.campaign_path}`,
    `Run id: ${state.run.id}`,
    `Step: ${step.id} — ${step.name}`,
    '',
    step.prompt.trim(),
    '',
    createRunnerCompletionInstruction(registry, runnerName, expected),
  ].join('\n');
}

async function runRunnerInvocation(invocation, options) {
  const canonicalCwd = await canonicalExistingPath(options.cwd, 'Worker cwd');
  const containmentRoot = await canonicalExistingPath(
    options.containmentRoot ?? options.cwd,
    'Worker containment root',
  );
  assertPathContained(containmentRoot, canonicalCwd, 'Worker cwd');
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: 'a' });
  const logRedactor = createStreamingRedactor();
  const stagedOutput = await stageRunnerOutput(invocation);
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let watchdogResult = null;
  let stopResult = null;
  let capResult = null;
  let killTimer = null;
  let stopping = false;
  let polling = false;
  const markActivity = () => { lastActivityAt = Date.now(); };
  const activityMonitor = await watchRepoActivity(
    options.cwd,
    options.ignoredActivityPaths ?? [],
    markActivity,
  );
  const child = spawn(stagedOutput.invocation.command, stagedOutput.invocation.args, {
    cwd: canonicalCwd,
    env: stagedOutput.invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    markActivity();
    stdout += chunk;
    const safe = logRedactor.push(chunk);
    if (safe) log.write(safe);
    options.stdout?.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    markActivity();
    stderr += chunk;
    const safe = logRedactor.push(chunk);
    if (safe) log.write(safe);
    options.stderr?.write(chunk);
  });

  const closed = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (exitCode, signal) => {
      const signalExitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
      resolve({
        exitCode: spawnError ? 127 : (exitCode ?? signalExitCode),
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? '\n' : ''}${spawnError.message}` : stderr,
      });
    });
  });
  const abort = () => {
    stopping = true;
    signalChildProcessGroup(child, 'SIGTERM');
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const watchdog = options.watchdog;
  const watchdogPollInterval = Math.max(10, Math.min(250, Math.floor(watchdog.stall_window_ms / 4)));
  const pollInterval = options.stopRequestPath ? Math.min(25, watchdogPollInterval) : watchdogPollInterval;
  const pollRunner = async () => {
    if (polling) return;
    polling = true;
    try {
    const now = Date.now();
    const runtimeMs = now - startedAt;
    const inactiveMs = now - lastActivityAt;
    const childAlive = child.exitCode == null && child.signalCode == null;

    if (stopResult == null && options.stopRequestPath && await hasStopRequest(options.stopRequestPath)) {
      stopResult = {
        requested: true,
        forced: false,
        requested_at_ms: now,
        grace_ms: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      };
      stopping = true;
    }

    if (
      stopResult?.requested
      && !stopResult.forced
      && childAlive
      && now - stopResult.requested_at_ms >= stopResult.grace_ms
    ) {
      stopResult.forced = true;
      signalChildProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
      killTimer.unref?.();
    }

    if (capResult == null && options.deadlineMs && now >= options.deadlineMs && childAlive) {
      capResult = {
        kind: 'max_run_minutes',
        deadline_ms: options.deadlineMs,
      };
      stopping = true;
      signalChildProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
      killTimer.unref?.();
    }

    if (
      watchdogResult == null
      && !stopping
      && childAlive
      && runtimeMs >= watchdog.minimum_runtime_ms
      && inactiveMs >= watchdog.stall_window_ms
    ) {
      watchdogResult = {
        stalled: true,
        runtime_ms: runtimeMs,
        inactive_ms: inactiveMs,
        message: `Runner stalled after ${runtimeMs}ms with no stdout, stderr, repository file, or Git index activity for ${inactiveMs}ms (minimum runtime ${watchdog.minimum_runtime_ms}ms; stall window ${watchdog.stall_window_ms}ms).`,
      };
      stopping = true;
      signalChildProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
      killTimer.unref?.();
    }
    } finally {
      polling = false;
    }
  };
  const watchdogTimer = setInterval(() => { void pollRunner(); }, pollInterval);
  watchdogTimer.unref?.();

  let result;
  try {
    await options.onSpawn(child.pid ?? null);
    if (options.signal?.aborted) abort();
    child.stdin.end(stagedOutput.invocation.stdin ?? '');
    await pollRunner();
    result = await closed;
  } catch (error) {
    signalChildProcessGroup(child, 'SIGTERM');
    await closed;
    throw error;
  } finally {
    clearInterval(watchdogTimer);
    if (killTimer) clearTimeout(killTimer);
    activityMonitor.close();
    options.signal?.removeEventListener('abort', abort);
    const safeTail = logRedactor.flush();
    if (safeTail) log.write(safeTail);
    await new Promise((resolve) => log.end(resolve));
    await stagedOutput.persist();
  }

  let outputTail = null;
  if (watchdogResult || stopResult || capResult) {
    try {
      outputTail = tailText(await readFile(options.logPath, 'utf8'));
    } catch {
      outputTail = tailText(`${stdout}${stderr ? `\n${stderr}` : ''}`);
    }
  }
  return {
    ...result,
    watchdog: watchdogResult,
    stop: stopResult,
    cap: capResult,
    outputTail,
  };
}

async function stageRunnerOutput(invocation) {
  if (!invocation.outputPath) {
    return { invocation, persist: async () => {} };
  }
  const rawDir = await mkdtemp(path.join(tmpdir(), 'campaigns-runner-output-'));
  const rawPath = path.join(rawDir, path.basename(invocation.outputPath));
  const args = invocation.args.map((argument) => (
    argument === invocation.outputPath ? rawPath : argument
  ));
  if (args.every((argument, index) => argument === invocation.args[index])) {
    await rm(rawDir, { recursive: true, force: true });
    throw new PumpRunError('Runner output path was not present as a standalone argument.');
  }
  return {
    invocation: { ...invocation, args },
    async persist() {
      try {
        const raw = await readFile(rawPath, 'utf8');
        await writeRedactedFile(invocation.outputPath, raw);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        await rm(rawDir, { recursive: true, force: true });
      }
    },
  };
}

async function watchRepoActivity(repoRoot, ignoredPaths, onActivity) {
  const watchers = [];
  const ignored = ignoredPaths.map((candidate) => path.resolve(candidate));
  const addWatcher = (watchPath, recursive, resolveEventPath) => {
    try {
      const watcher = watchFileSystem(
        watchPath,
        { recursive, persistent: false },
        (_event, filename) => {
          const eventPath = resolveEventPath(filename);
          if (ignored.some((candidate) => isSameOrInside(eventPath, candidate))) return;
          onActivity();
        },
      );
      watcher.on('error', () => {});
      watchers.push(watcher);
      return true;
    } catch {
      return false;
    }
  };

  if (!addWatcher(repoRoot, true, (filename) => path.resolve(repoRoot, String(filename ?? '')))) {
    addWatcher(repoRoot, false, (filename) => path.resolve(repoRoot, String(filename ?? '')));
  }

  const gitIndex = await runCommand('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'index']);
  if (gitIndex.exitCode === 0 && gitIndex.stdout.trim()) {
    const indexPath = path.resolve(repoRoot, gitIndex.stdout.trim());
    addWatcher(indexPath, false, () => indexPath);
  }

  return {
    close() {
      for (const watcher of watchers) watcher.close();
    },
  };
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hasStopRequest(stopRequestPath) {
  try {
    await readFile(stopRequestPath, 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function signalChildProcessGroup(child, signal) {
  if (signalProcessGroupPid(child.pid, signal)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function signalProcessGroupPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (['ESRCH', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

async function writeStopSalvage(state, paths) {
  const outputTail = tailText(await readOptionalText(state.worker?.log_path));
  if (!outputTail) return null;
  const salvagePath = path.join(paths.receiptsDir, 'stop-salvage.md');
  await mkdir(paths.receiptsDir, { recursive: true });
  await writeRedactedFile(salvagePath, [
    '# User stop salvage',
    '',
    `- Run: \`${state.run.id}\``,
    `- Step: \`${state.run.current_step_id ?? 'none'}\``,
    '',
    '## Output tail',
    '',
    '```text',
    outputTail,
    '```',
    '',
  ].join('\n'));
  return salvagePath;
}

async function readOptionalText(filePath) {
  if (!filePath) return '';
  try {
    const raw = await readFile(filePath, 'utf8');
    const redacted = redactText(raw);
    if (redacted !== raw) await writeRedactedFile(filePath, redacted);
    return redacted;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tailText(value, maxCharacters = 4_000) {
  const text = String(value ?? '');
  return text.slice(-maxCharacters);
}

async function writeReceipt(receiptPath, receipt) {
  const stdoutFence = fenceFor(receipt.stdout);
  const stderrFence = fenceFor(receipt.stderr);
  const tailFence = fenceFor(receipt.outputTail);
  const body = [
    `# Step ${receipt.step.id} receipt`,
    '',
    `- Run: \`${receipt.runId}\``,
    `- Step: ${receipt.step.name}`,
    `- Runner: \`${receipt.runner}\``,
    `- Model: \`${receipt.model}\``,
    `- Effort: \`${receipt.effort}\``,
    `- Exit code: \`${receipt.exitCode}\``,
    `- Status: \`${receipt.status ?? 'completed'}\``,
    `- Worker log: \`${receipt.logPath}\``,
    ...(receipt.failure ? [
      `- Failure: \`${receipt.failure.code}\` — ${receipt.failure.message}`,
    ] : []),
    '',
    '## stdout',
    '',
    stdoutFence,
    receipt.stdout,
    stdoutFence,
    '',
    '## stderr',
    '',
    stderrFence,
    receipt.stderr,
    stderrFence,
    ...(receipt.outputTail == null ? [] : [
      '',
      '## Salvaged output tail',
      '',
      tailFence,
      receipt.outputTail,
      tailFence,
    ]),
    '',
  ].join('\n');
  await writeRedactedFile(receiptPath, body);
}

function fenceFor(value) {
  const runs = String(value).match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '`'.repeat(Math.max(3, longest + 1));
}

async function tickCampaignStep(campaignPath, stepId) {
  const markdown = await readFile(campaignPath, 'utf8');
  const plan = parseCampaignPlan(markdown);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new PumpRunError(`Step ${stepId} disappeared before its checkbox was updated.`);
  if (step.checked) return false;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const match = lines[step.checklistLine]?.match(CHECK_LINE_REGEX);
  if (!match) throw new PumpRunError(`Could not update the checkbox for Step ${stepId}.`);
  lines[step.checklistLine] = `${match[1]}x${match[3]}${match[4]}`;
  await writeFileAtomic(campaignPath, lines.join('\n'));
  return true;
}

async function commitCampaignTick(repoRoot, campaignPath, stepId) {
  const relative = path.relative(await realpath(repoRoot), await realpath(campaignPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;
  const status = await runCommand('git', ['-C', repoRoot, 'status', '--short', '--', relative]);
  if (status.exitCode !== 0) throw new PumpRunError(`Could not inspect Step ${stepId} checkbox: ${status.stderr.trim()}`);
  if (!status.stdout.trim() || status.stdout.trimStart().startsWith('??')) return;
  const added = await runCommand('git', ['-C', repoRoot, 'add', '--', relative]);
  if (added.exitCode !== 0) throw new PumpRunError(`Could not stage Step ${stepId} checkbox: ${added.stderr.trim()}`);
  const committed = await runCommand('git', [
    '-C', repoRoot,
    '-c', 'commit.gpgSign=false',
    'commit', '-m', `Complete campaign step ${stepId}`, '--', relative,
  ]);
  if (committed.exitCode !== 0) {
    throw new PumpRunError(`Could not commit Step ${stepId} checkbox: ${committed.stderr.trim()}`);
  }
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: error.message }));
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function safeStepId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

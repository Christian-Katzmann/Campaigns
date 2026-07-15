import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  deliverRemoteNotification,
  displayNativeNotification,
  sanitizeNotificationSettings,
} from './notifications.mjs';
import { resolveCampaignConfig } from './config.mjs';
import { readRegistry, writeFileAtomic } from './registry.mjs';
import {
  redactAndCapText,
  redactText,
  writeRedactedFile,
  writeRedactedState,
} from './redaction.mjs';
import { runRunnerInvocation, signalProcessGroupPid } from './runner-process.mjs';
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
} from './runners.mjs';
import {
  CHECK_LINE_REGEX,
  extractFinalReview,
  extractStepSections,
  linkChecksToSteps,
  parseModelSegment,
  parseExecutableChecks,
  parseMarkdown,
} from '../public/lib/parser.mjs';

export const DEFAULT_MAX_STEPS_PER_RUN = 50;
export const DEFAULT_MAX_RUN_MINUTES = 360;
export const DEFAULT_STOP_GRACE_MS = 3_000;
export const DEFAULT_MAX_PARALLEL_STEPS = 2;
export const DEFAULT_AWAITING_HUMAN_CLEANUP_MS = 24 * 60 * 60 * 1_000;
export const CHECK_OUTPUT_MAX_CHARACTERS = 4_096;

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

    const activePids = activeWorkerPids(state);
    if (!groupTerminated && Date.now() - startedAt >= graceMs && activePids.length > 0) {
      groupTerminated = true;
      for (const pid of activePids) signalProcessGroupPid(pid, 'SIGTERM');
      await delay(250);
      for (const pid of activeWorkerPids(state)) signalProcessGroupPid(pid, 'SIGKILL');
    }

    const lock = await readLock(paths.lockPath);
    if (!isProcessAlive(lock?.pid) && activeWorkerPids(state).length === 0) {
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
    const step = {
      id: section.number,
      name: section.title.replace(/^steps?\s+[\d.x–-]+(?:\s*[–-]\s*[\d.x]+)?\s*[—–-]?\s*/i, '').trim()
        || `Step ${section.number}`,
      phase: section.number.match(/^\d+/)?.[0] ?? null,
      checked: check.checked,
      checklistLine: check.lineStart,
      prompt,
    };
    if (section.model) step.model = section.model;
    if (section.parallel) step.parallel = section.parallel;
    if (section.lane) step.lane = section.lane;
    const checks = parseExecutableChecks(prompt);
    if (checks.length > 0) step.checks = checks;
    return step;
  });
  if (steps.length === 0) throw new PumpRunError('Campaign has no runnable steps.');

  const { title, branch } = parseCampaignMetadata(blocks);
  const finalReview = extractFinalReview(blocks);
  const finalReviewPrompt = finalReview?.code?.content?.trim() || null;

  return { title, branch, steps, finalReviewPrompt };
}

export function resolveParallelStepGroup(plan, stepId) {
  const steps = plan?.steps ?? [];
  const start = steps.find((step) => step.id === stepId);
  if (!start?.parallel?.isParallel) return { steps: start ? [start] : [], reason: null };
  if (start.parallel.siblingSteps.length === 0) {
    return { steps: [start], reason: `Step ${stepId} has Parallel:YES without a sibling step.` };
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  const ids = new Set([start.id]);
  const queue = [start];
  while (queue.length > 0) {
    const step = queue.shift();
    for (const siblingId of step.parallel?.siblingSteps ?? []) {
      const sibling = byId.get(siblingId);
      if (!sibling) {
        return { steps: [start], reason: `Step ${step.id} links to missing Step ${siblingId}.` };
      }
      if (sibling.phase !== start.phase) {
        return {
          steps: [start],
          reason: `Step ${step.id} links across phases to Step ${sibling.id}; parallel groups must stay in one phase.`,
        };
      }
      if (sibling.checked) {
        return { steps: [start], reason: `Step ${step.id} links to already-completed Step ${sibling.id}.` };
      }
      if (
        !sibling.parallel?.isParallel
        || !sibling.parallel.siblingSteps.includes(step.id)
      ) {
        return {
          steps: [start],
          reason: `Steps ${step.id} and ${sibling.id} do not declare reciprocal Parallel links.`,
        };
      }
      if (!ids.has(sibling.id)) {
        ids.add(sibling.id);
        queue.push(sibling);
      }
    }
  }

  const group = steps.filter((step) => ids.has(step.id));
  return group.length > 1
    ? { steps: group, reason: null }
    : { steps: [start], reason: `Step ${stepId} has no valid reciprocal parallel sibling.` };
}

export function resolveParallelLaneSafety(steps) {
  for (const step of steps) {
    if (!step.lane?.globs?.length) {
      return {
        safe: false,
        reason: `Step ${step.id} is missing or has an unparseable Lane declaration.`,
      };
    }
  }

  for (let leftIndex = 0; leftIndex < steps.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < steps.length; rightIndex += 1) {
      const left = steps[leftIndex];
      const right = steps[rightIndex];
      for (const leftGlob of left.lane.globs) {
        for (const rightGlob of right.lane.globs) {
          if (!laneGlobsOverlap(leftGlob, rightGlob)) continue;
          return {
            safe: false,
            reason: `Steps ${left.id} and ${right.id} have overlapping lanes (`
              + `\`${leftGlob}\` and \`${rightGlob}\`).`,
          };
        }
      }
    }
  }
  return { safe: true, reason: null };
}

export function laneGlobsOverlap(leftGlob, rightGlob) {
  const left = globPrefix(leftGlob).replace(/\/+$/, '');
  const right = globPrefix(rightGlob).replace(/\/+$/, '');
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function globPrefix(glob) {
  const value = String(glob || '');
  const wildcardIndex = Math.min(
    ...['*', '?', '['].map((character) => value.indexOf(character)).filter((index) => index >= 0),
    value.length,
  );
  return value.slice(0, wildcardIndex);
}

export function resolveStepRunnerSelection(registry, step, options = {}) {
  const fallbackRunner = options.fallbackRunner ?? registry.defaultRunner;
  const fallback = registry.get(fallbackRunner);
  const fallbackEffort = options.fallbackEffort ?? fallback.defaults.effort;
  const fallbackSelection = {
    runner: fallbackRunner,
    model: options.fallbackModel ?? fallback.defaults.model,
    effort: fallback.effortMap[fallbackEffort] ?? fallbackEffort,
  };
  const segment = parseModelSegment(step?.model?.primary ?? step?.model?.claudeCode ?? '');
  if (!segment) return fallbackSelection;
  const wantedModel = catalogKey(segment.model);

  for (const runnerName of registry.names) {
    const runner = registry.get(runnerName);
    const model = runner.models.find((candidate) => (
      catalogKey(candidate.id) === wantedModel || catalogKey(candidate.label) === wantedModel
    ));
    if (!model) continue;
    const wantedEffort = catalogKey(segment.effort);
    const catalogEffort = runner.efforts.find((candidate) => (
      catalogKey(candidate.id) === wantedEffort || catalogKey(candidate.label) === wantedEffort
    ));
    const alias = segment.effort.trim().toLowerCase().replace(/\s+/g, '-');
    const effort = catalogEffort?.id ?? runner.effortMap[alias] ?? runner.defaults.effort;
    return { runner: runnerName, model: model.id, effort };
  }
  return fallbackSelection;
}

export function buildStepRunnerInvocation(registry, step, options = {}) {
  const selection = resolveStepRunnerSelection(registry, step, options);
  return buildRunnerInvocation(registry, selection.runner, {
    ...options,
    model: selection.model,
    effort: selection.effort,
  });
}

function catalogKey(value) {
  return String(value ?? '').trim().toLowerCase();
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
  if (options.repoRoot !== undefined) {
    await resolveContainedRepoRoot(campaignPath, options.repoRoot);
  }
  const resolvedConfig = await resolveCampaignConfig({
    campaignPath,
    env,
    cli: options,
    explicitConfigPath: options.configPath,
  });
  const rawConfig = resolvedConfig.config;
  const effective = resolvedConfig.effective;
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const sourceRepoRoot = await resolveContainedRepoRoot(
    campaignPath,
    effective.repoRoot,
  );
  let repoRoot = sourceRepoRoot;
  const paths = runPathsForCampaign(campaignPath, runsDir);

  await mkdir(paths.runDir, { recursive: true });
  await rm(paths.stopRequestPath, { force: true });
  const lock = await acquireRunLock(paths.lockPath, campaignPath);
  let state = null;
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
    const requestedBranch = effective.branch ?? initialPlan.branch;
    const mergeTargetBranch = await discoverDefaultBranch(sourceRepoRoot, requestedBranch);
    const campaignBranch = await resolveRequestedBranch(sourceRepoRoot, requestedBranch);
    let branch = campaignBranch;
    const plan = initialPlan;
    const runnerName = effective.runner ?? runnerRegistry.defaultRunner;
    const runner = runnerRegistry.get(runnerName);
    const requestedEffort = effective.effort ?? runner.defaults.effort;
    const effort = runner.effortMap[requestedEffort] ?? requestedEffort;
    const model = effective.model ?? runner.defaults.model;
    const identity = await resolveRunIdentity({
      campaignPath,
      repoRoot: sourceRepoRoot,
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
    const forceMergeUnreviewed = effective.forceMergeUnreviewed === true;
    const maxStepsPerRun = positiveIntegerOr(
      numberOption(effective.maxStepsPerRun),
      DEFAULT_MAX_STEPS_PER_RUN,
      'run.max_steps_per_run',
    );
    const maxRunMinutes = positiveNumberOr(
      numberOption(effective.maxRunMinutes),
      DEFAULT_MAX_RUN_MINUTES,
      'run.max_run_minutes',
    );
    const stopGraceMs = positiveIntegerOr(
      numberOption(effective.stopGraceMs),
      DEFAULT_STOP_GRACE_MS,
      'run.stop_grace_ms',
    );
    const maxParallelSteps = positiveIntegerOr(
      numberOption(effective.maxParallelSteps),
      DEFAULT_MAX_PARALLEL_STEPS,
      'run.max_parallel_steps',
    );

    await mkdir(paths.receiptsDir, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    state = await loadOrCreateState({
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
      maxParallelSteps,
      worktreeEnabled: options.noWorktree !== true,
      allowPlanMismatch: Boolean(initialParseError),
    });

    const liveWorkerPids = activeWorkerPids(state);
    if (liveWorkerPids.length > 0) {
      throw new PumpLockError(
        `Workers for this campaign are still running (pids ${liveWorkerPids.join(', ')}).`,
      );
    }
    state = await prepareStateForResume(
      state,
      plan,
      paths.statePath,
      { allowPlanMismatch: Boolean(initialParseError) },
    );

    state = await sweepExpiredExecutionWorktree(state, paths.statePath, {
      now: options.now,
    });
    if (state.config.worktree_enabled) {
      try {
        state = await ensureExecutionWorktree({
          state,
          statePath: paths.statePath,
          campaignPath,
          sourceRepoRoot,
          campaignBranch,
          paths,
        });
      } catch (error) {
        if (!(error instanceof StepPreflightError)) throw error;
        const stepId = state.steps.find((step) => step.status === 'pending')?.id ?? null;
        state = transitionRunState(state, {
          event: error.event,
          step_id: stepId,
          message: error.message,
          details: error.details,
        });
        await persistState(paths.statePath, state);
        throw new PumpRunError(error.message, {
          statePath: paths.statePath,
          preflightEvent: error.event,
        });
      }
      repoRoot = state.run.identity.execution.repo_root;
      branch = state.run.identity.execution.branch;
    }

    if (state.run.status === 'awaiting_review') {
      const result = await runReviewBoundary({
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
      state = result.state;
      return result;
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
        const result = await runReviewBoundary({
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
        state = result.state;
        return result;
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

      let parallelGroup = resolveParallelStepGroup(currentPlan, nextStep.id);
      if (!parallelGroup.reason && parallelGroup.steps.length > 1) {
        const laneSafety = resolveParallelLaneSafety(parallelGroup.steps);
        if (!laneSafety.safe) parallelGroup = { steps: [nextStep], reason: laneSafety.reason };
      }
      if (parallelGroup.reason) {
        state = transitionRunState(state, {
          event: 'parallel_group_demoted',
          step_id: nextStep.id,
          message: `Ran Step ${nextStep.id} sequentially: ${parallelGroup.reason}`,
          details: { reason: parallelGroup.reason },
        });
        await persistState(paths.statePath, state);
      }
      if (parallelGroup.steps.length > 1) {
        if (completedThisRun + parallelGroup.steps.length > state.config.max_steps_per_run) {
          state = transitionRunState(state, {
            event: 'cap_reached',
            step_id: nextStep.id,
            message: `Step cap would split the parallel group starting at Step ${nextStep.id}; the group was not started.`,
            details: {
              cap: 'max_steps_per_run',
              limit: state.config.max_steps_per_run,
              group_steps: parallelGroup.steps.map((step) => step.id),
            },
          });
          await persistState(paths.statePath, state);
          return { ...paths, state };
        }
        const groupResult = await runParallelStepGroup({
          state,
          plan: currentPlan,
          steps: parallelGroup.steps,
          paths,
          campaignPath,
          sourceRepoRoot,
          repoRoot,
          runnerRegistry,
          runnerName,
          model,
          effort,
          env,
          options,
          stdout,
          stderr,
          runDeadlineMs,
        });
        state = groupResult.state;
        if (groupResult.terminal) return { ...paths, state };
        if (groupResult.failure) {
          throw new PumpRunError(groupResult.failure.message, {
            statePath: paths.statePath,
            failure: groupResult.failure,
          });
        }
        preflightStage = 'between steps';
        continue;
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
      const stepSelection = resolveStepRunnerSelection(runnerRegistry, nextStep, {
        fallbackRunner: runnerName,
        fallbackModel: model,
        fallbackEffort: effort,
      });
      const prompt = buildWorkerPrompt(
        state,
        nextStep,
        runnerRegistry,
        stepSelection.runner,
        expected,
      );
      const invocation = buildStepRunnerInvocation(runnerRegistry, nextStep, {
        prompt,
        repoRoot,
        outputPath,
        fallbackRunner: runnerName,
        fallbackModel: model,
        fallbackEffort: effort,
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
          const boundaryResult = classifyRunnerResult(runnerRegistry, invocation.runner, {
            ...result,
            expected,
            receiptPath,
          });
          if (boundaryResult.completed) {
            const boundaryChecks = await runExecutableChecks(nextStep.checks ?? [], { cwd: repoRoot });
            const boundaryFailures = boundaryChecks.filter((check) => !check.passed);
            if (boundaryFailures.length > 0) {
              state = transitionRunState(state, {
                event: 'check_failed',
                step_id: nextStep.id,
                message: `Step ${nextStep.id} executable checks failed (${boundaryFailures.length}) at the stop boundary.`,
                details: { scope: 'step', run: 1, failures: boundaryFailures },
              });
              await persistState(paths.statePath, state);
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
                status: 'stopped_by_user',
                checkRuns: [boundaryChecks],
              });
              state = transitionRunState(state, {
                event: 'stopped_by_user',
                step_id: nextStep.id,
                message: `Stopped by user after Step ${nextStep.id} checks failed at the boundary.`,
                details: { forced: false, boundary: true, receipt_path: receiptPath },
              });
              await persistState(paths.statePath, state);
              return { ...paths, state };
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
              checkRuns: [boundaryChecks],
            });
            const ticked = await tickCampaignStep(campaignPath, nextStep.id);
            state = transitionRunState(state, {
              ...boundaryResult.transition,
              runner: invocation.runner,
              model: invocation.model,
              effort: invocation.effort,
              message: `Completed Step ${nextStep.id} before the stop boundary.`,
            });
            await persistState(paths.statePath, state);
            if (ticked && !state.config.worktree_enabled) {
              await commitCampaignTick(sourceRepoRoot, campaignPath, nextStep.id);
            }
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
        : classifyRunnerResult(runnerRegistry, invocation.runner, {
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

      const checkGate = await runCheckFixLoop({
        state,
        checks: nextStep.checks ?? [],
        scope: 'step',
        step: nextStep,
        acceptanceCriteria: nextStep.prompt,
        paths,
        runnerRegistry,
        runnerName: invocation.runner,
        repoRoot,
        model: invocation.model,
        effort: invocation.effort,
        env,
        options,
        stdout,
        stderr,
        runInvocation: (fixInvocation, fixOptions) => runRunnerInvocation(fixInvocation, {
          ...fixOptions,
          containmentRoot: repoRoot,
          stopRequestPath: paths.stopRequestPath,
          stopGraceMs: state.config.stop_grace_ms,
          deadlineMs: runDeadlineMs,
        }),
      });
      state = checkGate.state;
      if (checkGate.stop?.requested || checkGate.cap) {
        const event = checkGate.stop?.requested ? 'stopped_by_user' : 'cap_reached';
        const message = checkGate.stop?.requested
          ? `Stopped by user while fixing checks for Step ${nextStep.id}.`
          : `Run-time cap reached while fixing checks for Step ${nextStep.id}.`;
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
          outputTail: checkGate.fix?.output_tail,
          checkRuns: checkGate.runs,
        });
        state = transitionRunState(state, {
          event,
          step_id: nextStep.id,
          message,
          details: {
            cap: checkGate.cap?.kind ?? null,
            forced: checkGate.stop?.forced ?? true,
            grace_ms: checkGate.stop?.grace_ms ?? null,
            salvage_path: receiptPath,
            output_tail: checkGate.fix?.output_tail,
          },
        });
        await persistState(paths.statePath, state);
        return { ...paths, state };
      }
      if (!checkGate.passed) {
        const failures = checkGate.runs.at(-1)?.filter((check) => !check.passed) ?? [];
        const outputTail = tailText(formatCheckFailureEvidence(failures)
          || 'Executable checks passed, but the fix worker did not commit the repair.');
        const failure = {
          code: 'tool_failure',
          message: `Executable checks for Step ${nextStep.id} did not pass after ${checkGate.fixes.length} fix attempts.`,
          retryable: true,
          output_tail: outputTail,
        };
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
          failure,
          outputTail,
          checkRuns: checkGate.runs,
        });
        state = transitionRunState(state, {
          event: 'step_failed',
          step_id: nextStep.id,
          failure,
          message: failure.message,
        });
        await persistState(paths.statePath, state);
        throw new PumpRunError(failure.message, { statePath: paths.statePath, failure });
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
        checkRuns: checkGate.runs,
      });
      const ticked = await tickCampaignStep(campaignPath, nextStep.id);
      state = transitionRunState(state, {
        ...classified.transition,
        runner: invocation.runner,
        model: invocation.model,
        effort: invocation.effort,
        message: `Completed Step ${nextStep.id}: ${nextStep.name}`,
      });
      await persistState(paths.statePath, state);
      if (ticked && !state.config.worktree_enabled) {
        await commitCampaignTick(sourceRepoRoot, campaignPath, nextStep.id);
      }
      stdout?.write(`Completed Step ${nextStep.id}. Receipt: ${receiptPath}\n`);
      preflightStage = 'between steps';
    }
  } finally {
    try {
      await rm(paths.stopRequestPath, { force: true });
      if (state?.artifacts?.parallel_worktrees?.some((worktree) => !worktree.pruned_at)) {
        const cleanupRoot = state.run.identity.execution.repo_root;
        for (const worktree of state.artifacts.parallel_worktrees.filter((candidate) => !candidate.pruned_at)) {
          await pruneParallelStepWorktree(state, paths.statePath, cleanupRoot, worktree, false);
        }
      }
      if (state?.config.worktree_enabled) {
        await settleExecutionWorktree(state, paths.statePath, {
          now: options.now,
          awaitingHumanCleanupMs: options.awaitingHumanCleanupMs,
        });
      }
    } finally {
      await releaseRunLock(paths.lockPath, lock.token);
    }
  }
}

async function runParallelStepGroup({
  state: initialState,
  plan,
  steps,
  paths,
  campaignPath,
  sourceRepoRoot,
  repoRoot,
  runnerRegistry,
  runnerName,
  model,
  effort,
  env,
  options,
  stdout,
  stderr,
  runDeadlineMs,
}) {
  let state = initialState;
  let stateWrite = Promise.resolve();
  const transition = (input) => {
    stateWrite = stateWrite.then(async () => {
      state = transitionRunState(state, input);
      await persistState(paths.statePath, state);
    });
    return stateWrite;
  };
  const orderedSteps = [...steps].sort((left, right) => compareStepIds(left.id, right.id));
  const phase = orderedSteps[0].phase;
  const phaseBase = await gitHead(repoRoot);

  await transition({
    event: 'parallel_group_started',
    step_id: orderedSteps[0].id,
    message: `Started parallel group: ${orderedSteps.map((step) => `Step ${step.id}`).join(', ')}.`,
    details: {
      phase,
      base_sha: phaseBase,
      step_ids: orderedSteps.map((step) => step.id),
      max_parallel_steps: state.config.max_parallel_steps,
    },
  });

  const jobs = [];
  try {
    for (const step of orderedSteps) {
      const worktree = await createParallelStepWorktree({ state, repoRoot, paths, step, phaseBase });
      jobs.push({ step, worktree });
      await persistState(paths.statePath, state);
    }
  } catch (error) {
    for (const job of jobs) {
      await pruneParallelStepWorktree(state, paths.statePath, repoRoot, job.worktree, false);
    }
    throw error;
  }

  const outcomes = new Array(jobs.length);
  let nextJobIndex = 0;
  let stopLaunching = false;
  const runJob = async (job, index) => {
    const ledgerStep = state.steps.find((candidate) => candidate.id === job.step.id);
    const attempt = ledgerStep.attempt + 1;
    const invocationId = randomUUID();
    const logPath = path.join(paths.logsDir, `${safeStepId(job.step.id)}-${attempt}.log`);
    const outputPath = path.join(paths.logsDir, `${safeStepId(job.step.id)}-${attempt}-last-message.md`);
    const receiptPath = path.join(paths.receiptsDir, `${safeStepId(job.step.id)}-${attempt}.md`);
    const expected = {
      run_id: state.run.id,
      step_id: job.step.id,
      invocation_id: invocationId,
    };
    const selection = resolveStepRunnerSelection(runnerRegistry, job.step, {
      fallbackRunner: runnerName,
      fallbackModel: model,
      fallbackEffort: effort,
    });
    const invocation = buildStepRunnerInvocation(runnerRegistry, job.step, {
      prompt: buildWorkerPrompt(state, job.step, runnerRegistry, selection.runner, expected),
      repoRoot: job.worktree.path,
      outputPath,
      fallbackRunner: runnerName,
      fallbackModel: model,
      fallbackEffort: effort,
      env,
    });
    let started = false;
    let result;
    stdout?.write(`Starting Step ${job.step.id}: ${job.step.name} (parallel)\n`);
    try {
      result = await runRunnerInvocation(invocation, {
        cwd: job.worktree.path,
        containmentRoot: job.worktree.path,
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
          started = true;
          await transition({
            event: 'step_started',
            step_id: job.step.id,
            message: `Started Step ${job.step.id}: ${job.step.name}`,
            worker: {
              runner: selection.runner,
              invocation_id: invocationId,
              pid,
              log_path: logPath,
            },
          });
        },
      });
    } catch (error) {
      if (!started) {
        await transition({
          event: 'step_started',
          step_id: job.step.id,
          message: `Started Step ${job.step.id}: ${job.step.name}`,
          worker: {
            runner: selection.runner,
            invocation_id: invocationId,
            pid: null,
            log_path: logPath,
          },
        });
      }
      result = {
        exitCode: 127,
        stdout: '',
        stderr: error.message,
        watchdog: null,
        stop: null,
        cap: null,
        outputTail: error.message,
      };
    }
    outcomes[index] = {
      job,
      result,
      invocation,
      expected,
      receiptPath,
      logPath,
      selection,
    };
    if (result.stop?.requested || result.cap) stopLaunching = true;
  };
  const workers = Array.from(
    { length: Math.min(state.config.max_parallel_steps, jobs.length) },
    async () => {
      while (!stopLaunching) {
        const index = nextJobIndex;
        nextJobIndex += 1;
        if (index >= jobs.length) return;
        await runJob(jobs[index], index);
      }
    },
  );
  await Promise.all(workers);
  await stateWrite;

  const terminalOutcome = outcomes.find((outcome) => outcome?.result.stop?.requested || outcome?.result.cap);
  if (terminalOutcome) {
    const event = terminalOutcome.result.stop?.requested ? 'stopped_by_user' : 'cap_reached';
    for (const outcome of outcomes.filter(Boolean)) {
      await writeReceipt(outcome.receiptPath, {
        runId: state.run.id,
        step: outcome.job.step,
        runner: outcome.invocation.runner,
        model: outcome.invocation.model,
        effort: outcome.invocation.effort,
        exitCode: outcome.result.exitCode,
        stdout: outcome.result.stdout,
        stderr: outcome.result.stderr,
        logPath: outcome.logPath,
        status: event,
        outputTail: outcome.result.outputTail,
      });
    }
    for (const job of jobs) {
      await pruneParallelStepWorktree(state, paths.statePath, repoRoot, job.worktree, false);
    }
    state = transitionRunState(state, {
      event,
      step_id: terminalOutcome.job.step.id,
      message: event === 'stopped_by_user'
        ? 'Stopped every active worker in the parallel group.'
        : 'Run-time cap reached while the parallel group was active.',
      details: {
        forced: terminalOutcome.result.stop?.forced ?? true,
        group_steps: orderedSteps.map((step) => step.id),
      },
    });
    await persistState(paths.statePath, state);
    return { state, terminal: true, failure: null };
  }

  const classified = outcomes.filter(Boolean).map((outcome) => {
    const result = outcome.result.watchdog?.stalled
      ? {
          completed: false,
          transition: {
            event: 'step_failed',
            step_id: outcome.job.step.id,
            failure: {
              code: 'watchdog_stalled',
              message: outcome.result.watchdog.message,
              retryable: true,
              output_tail: outcome.result.outputTail,
            },
          },
        }
      : classifyRunnerResult(runnerRegistry, outcome.invocation.runner, {
          ...outcome.result,
          expected: outcome.expected,
          receiptPath: outcome.receiptPath,
        });
    return { ...outcome, classified: result, merged: false };
  });

  for (const outcome of classified.sort((left, right) => (
    compareStepIds(left.job.step.id, right.job.step.id)
  ))) {
    if (!outcome.classified.completed) continue;
    const dirty = await gitResult(outcome.job.worktree.path, [
      'status', '--porcelain=v1', '--untracked-files=all',
    ]);
    if (!dirty.ok || dirty.stdout.trim()) {
      outcome.classified = parallelFailure(
        outcome.job.step.id,
        'tool_failure',
        !dirty.ok
          ? `Could not inspect Step ${outcome.job.step.id} worktree: ${dirty.error}`
          : `Step ${outcome.job.step.id} reported completion with uncommitted changes.`,
        dirty.stdout,
      );
      continue;
    }
    const merged = await gitResult(repoRoot, ['merge', '--no-edit', outcome.job.worktree.branch]);
    if (!merged.ok) {
      await gitResult(repoRoot, ['merge', '--abort']);
      outcome.classified = parallelFailure(
        outcome.job.step.id,
        'merge_conflict',
        `Could not merge Step ${outcome.job.step.id}: ${merged.error}`,
        merged.error,
      );
      continue;
    }
    outcome.merged = true;
    const ledgerWorktree = state.artifacts.parallel_worktrees.find((candidate) => (
      candidate.path === outcome.job.worktree.path
    ));
    if (ledgerWorktree) ledgerWorktree.merged_at = new Date().toISOString();
    await transition({
      event: 'parallel_step_merged',
      step_id: outcome.job.step.id,
      message: `Merged Step ${outcome.job.step.id} into the run branch.`,
      details: { branch: outcome.job.worktree.branch, base_sha: phaseBase },
    });
  }

  const phaseChecks = uniqueChecks(
    plan.steps.filter((step) => step.phase === phase).flatMap((step) => step.checks ?? []),
  );
  let phaseCheckRuns = [];
  if (classified.every((outcome) => outcome.classified.completed && outcome.merged)) {
    const results = await runExecutableChecks(phaseChecks, { cwd: repoRoot });
    phaseCheckRuns = [results];
    const failures = results.filter((check) => !check.passed);
    if (failures.length > 0) {
      await transition({
        event: 'check_failed',
        step_id: orderedSteps[0].id,
        message: `Phase ${phase} post-merge executable checks failed (${failures.length}).`,
        details: { scope: 'phase', phase, run: 1, failures },
      });
      const affected = classified[0];
      affected.classified = parallelFailure(
        affected.job.step.id,
        'tool_failure',
        `Phase ${phase} post-merge executable checks failed.`,
        formatCheckFailureEvidence(failures),
      );
    }
  }

  await transition({
    event: 'parallel_group_joined',
    step_id: orderedSteps[0].id,
    message: `Joined parallel group for Phase ${phase}.`,
    details: {
      phase,
      completed: classified.filter((outcome) => outcome.classified.completed).map((outcome) => outcome.job.step.id),
      failed: classified.filter((outcome) => !outcome.classified.completed).map((outcome) => outcome.job.step.id),
    },
  });

  const wholeGroupSucceeded = classified.every((outcome) => (
    outcome.classified.completed && outcome.merged
  ));
  for (const outcome of classified) {
    await pruneParallelStepWorktree(
      state,
      paths.statePath,
      repoRoot,
      outcome.job.worktree,
      wholeGroupSucceeded && outcome.classified.completed && outcome.merged,
    );
  }

  let firstFailure = null;
  for (const outcome of classified.sort((left, right) => (
    compareStepIds(left.job.step.id, right.job.step.id)
  ))) {
    if (outcome.classified.completed) {
      await writeReceipt(outcome.receiptPath, {
        runId: state.run.id,
        step: outcome.job.step,
        runner: outcome.invocation.runner,
        model: outcome.invocation.model,
        effort: outcome.invocation.effort,
        exitCode: outcome.result.exitCode,
        stdout: outcome.result.stdout,
        stderr: outcome.result.stderr,
        logPath: outcome.logPath,
        checkRuns: phaseCheckRuns,
      });
      const ticked = await tickCampaignStep(campaignPath, outcome.job.step.id);
      state = transitionRunState(state, {
        ...outcome.classified.transition,
        runner: outcome.invocation.runner,
        model: outcome.invocation.model,
        effort: outcome.invocation.effort,
        message: `Completed Step ${outcome.job.step.id}: ${outcome.job.step.name}`,
      });
      await persistState(paths.statePath, state);
      if (ticked && !state.config.worktree_enabled) {
        await commitCampaignTick(sourceRepoRoot, campaignPath, outcome.job.step.id);
      }
      stdout?.write(`Completed Step ${outcome.job.step.id}. Receipt: ${outcome.receiptPath}\n`);
      continue;
    }
    const failure = outcome.classified.transition.failure;
    firstFailure ??= failure;
    await writeReceipt(outcome.receiptPath, {
      runId: state.run.id,
      step: outcome.job.step,
      runner: outcome.invocation.runner,
      model: outcome.invocation.model,
      effort: outcome.invocation.effort,
      exitCode: outcome.result.exitCode,
      stdout: outcome.result.stdout,
      stderr: outcome.result.stderr,
      logPath: outcome.logPath,
      status: 'failed',
      failure,
      outputTail: failure.output_tail,
      checkRuns: phaseCheckRuns,
    });
    state = transitionRunState(state, {
      ...outcome.classified.transition,
      message: failure.message,
    });
    await persistState(paths.statePath, state);
  }
  return { state, terminal: false, failure: firstFailure };
}

async function createParallelStepWorktree({ state, repoRoot, paths, step, phaseBase }) {
  const runSuffix = state.run.id.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
  const stepSuffix = safeStepId(step.id).toLowerCase();
  const branch = `campaigns/parallel-${runSuffix}-${stepSuffix}`;
  const worktreePath = path.join(paths.runDir, `parallel-${runSuffix}-${stepSuffix}`);
  const added = await gitResult(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, phaseBase]);
  if (!added.ok) throw new PumpRunError(`Could not create Step ${step.id} worktree: ${added.error}`);
  try {
    await carryWorktreeEssentials(repoRoot, worktreePath);
  } catch (error) {
    await gitResult(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    await gitResult(repoRoot, ['branch', '-D', branch]);
    throw new PumpRunError(`Could not prepare Step ${step.id} worktree: ${error.message}`);
  }
  const record = {
    step_id: step.id,
    path: await realpath(worktreePath),
    branch,
    base_sha: phaseBase,
    created_at: new Date().toISOString(),
    merged_at: null,
    pruned_at: null,
  };
  state.artifacts.parallel_worktrees.push(record);
  return record;
}

async function pruneParallelStepWorktree(state, statePath, repoRoot, worktree, deleteBranch) {
  const record = state.artifacts.parallel_worktrees.find((candidate) => (
    candidate.path === worktree.path
  )) ?? worktree;
  if (record.pruned_at) return;
  const registered = (await listGitWorktrees(repoRoot)).find((candidate) => (
    candidate.path === canonicalPath(record.path)
  ));
  if (registered) {
    if (await pathExists(record.path)) {
      await snapshotDirtyExecutionWorktree(record.path);
      let removed = await gitResult(repoRoot, ['worktree', 'remove', record.path]);
      if (!removed.ok) removed = await gitResult(repoRoot, ['worktree', 'remove', '--force', record.path]);
      if (!removed.ok) throw new PumpRunError(`Could not prune Step ${record.step_id} worktree: ${removed.error}`);
    } else {
      await gitResult(repoRoot, ['worktree', 'prune', '--expire', 'now']);
    }
  }
  await gitResult(repoRoot, ['worktree', 'prune']);
  if ((await listGitWorktrees(repoRoot)).some((candidate) => candidate.path === canonicalPath(record.path))) {
    throw new PumpRunError(`Could not prune orphaned Step ${record.step_id} worktree.`);
  }
  if (deleteBranch) await gitResult(repoRoot, ['branch', '-d', record.branch]);
  record.pruned_at = new Date().toISOString();
  await persistState(statePath, state);
}

function parallelFailure(stepId, code, message, outputTail) {
  return {
    completed: false,
    transition: {
      event: 'step_failed',
      step_id: stepId,
      failure: {
        code,
        message,
        retryable: true,
        output_tail: tailText(outputTail),
      },
    },
  };
}

function uniqueChecks(checks) {
  const seen = new Set();
  return checks.filter((check) => {
    const key = JSON.stringify(check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareStepIds(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return String(left).localeCompare(String(right));
}

async function runCheckFixLoop({
  state: initialState,
  checks,
  scope,
  step = null,
  acceptanceCriteria,
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
  runInvocation,
}) {
  let state = initialState;
  const runs = [];
  const fixes = [];
  let results = await runExecutableChecks(checks, { cwd: repoRoot });
  runs.push(results);
  let failures = results.filter((result) => !result.passed);
  if (failures.length === 0) return { state, passed: true, runs, fixes };

  const recordFailure = async () => {
    const label = scope === 'campaign' ? 'Campaign executable checks' : `Step ${step.id} executable checks`;
    state = transitionRunState(state, {
      event: 'check_failed',
      step_id: step?.id ?? null,
      message: `${label} failed (${failures.length}).`,
      details: {
        scope,
        run: runs.length,
        failures,
      },
    });
    await persistState(paths.statePath, state);
  };
  await recordFailure();

  let evidence = formatCheckFailureEvidence(failures);
  const maxAttempts = state.config.max_fix_attempts ?? 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const scopeName = scope === 'campaign' ? 'the campaign' : `Step ${step.id}`;
    const fix = await runFixAttempt({
      attempt,
      state,
      context: {
        instruction: `Fix the executable-check failures for ${scopeName}.`,
        evidenceHeading: 'Failing checks',
        evidence,
        acceptanceCriteria,
        logPrefix: scope === 'campaign'
          ? 'campaign-check-fix'
          : `step-${safeStepId(step.id)}-check-fix`,
      },
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
      runInvocation,
      readHead: gitHead,
    });
    fixes.push(fix);
    if (fix.stop?.requested || fix.cap) {
      return { state, passed: false, runs, fixes, stop: fix.stop, cap: fix.cap, fix };
    }

    results = await runExecutableChecks(checks, { cwd: repoRoot });
    runs.push(results);
    failures = results.filter((result) => !result.passed);
    if (failures.length === 0 && fix.committed) {
      return { state, passed: true, runs, fixes };
    }
    if (failures.length > 0) {
      await recordFailure();
      evidence = formatCheckFailureEvidence(failures);
    } else {
      evidence = 'All checks pass in the current worktree, but the previous fix did not create a commit. Commit the verified fix before exiting.';
    }
  }

  return { state, passed: false, runs, fixes };
}

function formatCheckFailureEvidence(failures) {
  return failures.map((failure, index) => [
    `### Failure ${index + 1}${failure.step_id ? ` — Step ${failure.step_id}` : ''}`,
    '',
    `Command: ${failure.command}`,
    `Expected exit: ${failure.expected_exit}`,
    `Actual exit: ${failure.exit_code}`,
    `Timeout: ${failure.timeout_ms}ms${failure.timed_out ? ' (timed out)' : ''}`,
    ...(failure.expected_output == null ? [] : [`Expected output substring: ${failure.expected_output}`]),
    `Failure: ${failure.failure}`,
    '',
    'Captured output:',
    failure.output || '(no output)',
  ].join('\n')).join('\n\n');
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
    const campaignChecks = plan.steps.flatMap((step) => (step.checks ?? []).map((check) => ({
      ...check,
      stepId: step.id,
      stepName: step.name,
    })));
    const checkGate = await runCheckFixLoop({
      state,
      checks: campaignChecks,
      scope: 'campaign',
      acceptanceCriteria: `Read the full campaign and its acceptance criteria in ${state.run.identity.source.campaign_path}.`,
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
      runInvocation: guardedRunInvocation,
    });
    state = checkGate.state;
    if (checkGate.stop?.requested || checkGate.cap) {
      const event = checkGate.stop?.requested ? 'stopped_by_user' : 'cap_reached';
      state = transitionRunState(state, {
        event,
        message: checkGate.stop?.requested
          ? 'Stopped by user while fixing campaign checks before final review.'
          : 'Run-time cap reached while fixing campaign checks before final review.',
        details: {
          cap: checkGate.cap?.kind ?? null,
          forced: checkGate.stop?.forced ?? true,
          grace_ms: checkGate.stop?.grace_ms ?? null,
          salvage_path: checkGate.fix?.log_path ?? null,
          output_tail: checkGate.fix?.output_tail,
        },
      });
      await persistState(paths.statePath, state);
      return { ...paths, state };
    }
    if (!checkGate.passed) {
      state = transitionRunState(state, {
        event: 'final_review_halted',
        message: `Campaign checks still fail after ${checkGate.fixes.length} fix attempts; LLM review did not start.`,
        reasons: [],
        review_path: null,
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
  const worktree = state.artifacts.worktree;
  if (worktree && worktree.pruned_at == null) {
    const adopted = await adoptExecutionBranch(state);
    if (!adopted.ok) return adopted;
    const merged = await mergeBranchSafely({
      repoRoot: state.run.identity.source.repo_root,
      sourceRoot: state.run.identity.source.repo_root,
      sourceBranch: worktree.base_branch,
      targetBranch: execution.merge_target_branch
        ?? await discoverDefaultBranch(state.run.identity.source.repo_root, worktree.base_branch),
      runDir: state.artifacts.run_dir,
    });
    return { ...merged, execution_branch: worktree.branch };
  }
  return mergeBranchSafely({
    repoRoot: execution.repo_root,
    sourceRoot: execution.repo_root,
    sourceBranch: execution.branch,
    targetBranch: execution.merge_target_branch
      ?? await discoverDefaultBranch(execution.repo_root, execution.branch),
    runDir: state.artifacts.run_dir,
  });
}

async function adoptExecutionBranch(state) {
  const execution = state.run.identity.execution;
  const source = state.run.identity.source;
  const worktree = state.artifacts.worktree;
  const base = {
    source_branch: worktree.base_branch,
    target_branch: execution.merge_target_branch,
    execution_branch: worktree.branch,
  };
  const executionStatus = await gitResult(worktree.path, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ]);
  if (!executionStatus.ok) return { ok: false, error: executionStatus.error, ...base };
  if (executionStatus.stdout.trim()) {
    return { ok: false, error: `source worktree is dirty: ${executionStatus.stdout.trim()}`, ...base };
  }

  const current = await gitResult(source.repo_root, ['branch', '--show-current']);
  if (!current.ok) return { ok: false, error: current.error, ...base };
  if (current.stdout.trim() !== worktree.base_branch) {
    return {
      ok: false,
      error: `campaign checkout is on ${current.stdout.trim() || 'detached HEAD'}, expected ${worktree.base_branch}`,
      ...base,
    };
  }
  const sourceStatus = await gitResult(source.repo_root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ]);
  if (!sourceStatus.ok) return { ok: false, error: sourceStatus.error, ...base };
  const relativeCampaign = path.relative(
    await realpath(source.repo_root),
    await realpath(source.campaign_path),
  );
  const unrelated = parsePorcelainZPaths(sourceStatus.stdout)
    .filter((candidate) => candidate !== relativeCampaign);
  if (unrelated.length > 0) {
    return { ok: false, error: `campaign checkout is dirty: ${unrelated.join(', ')}`, ...base };
  }

  const baseHead = await gitHead(source.repo_root, worktree.base_branch);
  const executionHead = await gitHead(source.repo_root, worktree.branch);
  if (!(await gitIsAncestor(source.repo_root, baseHead, executionHead))) {
    return { ok: false, error: `${worktree.branch} diverged from ${worktree.base_branch}`, ...base };
  }
  const advanced = await gitResult(source.repo_root, ['merge', '--ff-only', worktree.branch]);
  if (!advanced.ok) {
    return { ok: false, error: `could not adopt execution branch: ${advanced.error}`, ...base };
  }
  await commitCampaignTick(source.repo_root, source.campaign_path, 'progress');
  return { ok: true, ...base };
}

async function mergeBranchSafely({ repoRoot, sourceRoot, sourceBranch, targetBranch, runDir }) {
  const sourceHead = await gitHead(repoRoot, sourceBranch);
  const base = {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    source_sha: sourceHead,
  };
  if (sourceBranch === targetBranch) {
    return { ok: true, skipped: true, reason: 'source_is_target', target_sha: sourceHead, ...base };
  }

  const sourceStatus = await gitResult(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!sourceStatus.ok) return { ok: false, error: sourceStatus.error, ...base };
  if (sourceStatus.stdout.trim()) {
    return { ok: false, error: `source worktree is dirty: ${sourceStatus.stdout.trim()}`, ...base };
  }

  const worktrees = await listGitWorktrees(repoRoot);
  const existing = worktrees.find((worktree) => worktree.branch === targetBranch);
  let targetRoot = existing?.path ?? null;
  let temporary = false;
  if (!targetRoot) {
    targetRoot = path.join(runDir, `merge-target-${randomUUID()}`);
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

function activeWorkerPids(state) {
  const workers = Array.isArray(state?.workers) && state.workers.length > 0
    ? state.workers
    : state?.worker
      ? [state.worker]
      : [];
  return [...new Set(workers.map((worker) => worker?.pid))]
    .filter((pid) => isProcessAlive(pid));
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
  maxParallelSteps,
  worktreeEnabled,
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
    const liveWorkerPids = activeWorkerPids(state);
    if (liveWorkerPids.length > 0) {
      throw new PumpLockError(`Cannot reopen the campaign while worker pids ${liveWorkerPids.join(', ')} are running.`);
    }

    const archivePath = path.join(paths.runDir, `state-${safeStepId(state.run.id)}.json`);
    await rename(paths.statePath, archivePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let state = createRunState({
    id: randomUUID(),
    identity,
    steps: plan.steps.map((step) => ({
      id: step.id,
      name: step.name,
      phase: step.phase,
      parallel: step.parallel ?? null,
      lane: step.lane ?? null,
    })),
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
      max_parallel_steps: maxParallelSteps,
      worktree_enabled: worktreeEnabled,
    },
    artifacts: {
      run_dir: paths.runDir,
      receipts_dir: paths.receiptsDir,
      final_review_path: paths.finalReviewPath,
      worktree: null,
      parallel_worktrees: [],
    },
  });
  state = transitionRunState(state, { event: 'run_started', message: 'Campaign run started.' });
  await persistState(paths.statePath, state);
  return state;
}

async function prepareStateForResume(state, plan, statePath, { allowPlanMismatch = false } = {}) {
  if (!allowPlanMismatch) syncPlanMetadata(state, plan);
  if (state.run.status === 'pending' || state.run.status === 'blocked') {
    state = transitionRunState(state, { event: 'run_started', message: 'Campaign run resumed.' });
  } else if (state.run.status === 'running' && state.run.current_step_ids.length > 0) {
    for (const stepId of [...state.run.current_step_ids]) {
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
  }

  if (state.run.status === 'failed') {
    const failedSteps = state.steps.filter((candidate) => ['failed', 'stopped'].includes(candidate.status));
    const step = failedSteps[0];
    state = transitionRunState(state, {
      event: 'recovery_started',
      step_id: step?.id ?? null,
      message: 'Resuming an interrupted campaign run.',
    });
    for (const failedStep of failedSteps) {
      state = transitionRunState(state, {
        event: 'step_reset_by_recover',
        step_id: failedStep.id,
        message: `Reset Step ${failedStep.id} to pending for resume.`,
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
  syncPlanMetadata(state, plan);
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

function syncPlanMetadata(state, plan) {
  for (const planStep of plan.steps) {
    const ledgerStep = state.steps.find((candidate) => candidate.id === planStep.id);
    if (!ledgerStep) continue;
    ledgerStep.parallel = planStep.parallel
      ? {
          is_parallel: planStep.parallel.isParallel,
          sibling_steps: [...planStep.parallel.siblingSteps],
        }
      : null;
    ledgerStep.lane = planStep.lane
      ? { globs: [...planStep.lane.globs] }
      : null;
  }
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

async function ensureExecutionWorktree({
  state,
  statePath,
  campaignPath,
  sourceRepoRoot,
  campaignBranch,
  paths,
}) {
  const worktree = state.artifacts.worktree;
  const settled = new Set([
    'awaiting_human_review',
    'cap_reached',
    'stopped_by_user',
    'halted',
    'completed',
    'merged',
    'force_merged',
  ]);
  if ((worktree?.pruned_at && settled.has(state.run.status)) || (settled.has(state.run.status) && !worktree)) {
    return state;
  }

  if (worktree) {
    const registered = (await listGitWorktrees(sourceRepoRoot)).find((candidate) => (
      candidate.path === canonicalPath(worktree.path)
    ));
    if (registered) {
      if (registered.branch !== worktree.branch) {
        throw new PumpRunError(
          `Execution worktree ${worktree.path} is on ${registered.branch ?? 'detached HEAD'}, expected ${worktree.branch}.`,
        );
      }
      return state;
    }
    if (settled.has(state.run.status)) return state;
    if (await pathExists(worktree.path)) {
      throw new PumpRunError(`Execution worktree path exists but is not registered: ${worktree.path}`);
    }
    const restored = await gitResult(sourceRepoRoot, ['worktree', 'add', worktree.path, worktree.branch]);
    if (!restored.ok) {
      throw new PumpRunError(`Could not restore execution worktree: ${restored.error}`);
    }
    try {
      await carryWorktreeEssentials(sourceRepoRoot, worktree.path);
    } catch (error) {
      await gitResult(sourceRepoRoot, ['worktree', 'remove', '--force', worktree.path]);
      throw new PumpRunError(`Could not restore execution worktree essentials: ${error.message}`);
    }
    worktree.pruned_at = null;
    worktree.cleanup_deadline = null;
    state.run.identity.execution.repo_root = canonicalPath(worktree.path);
    await persistState(statePath, state);
    return state;
  }

  await prepareSourceBranchForIsolation({
    campaignPath,
    repoRoot: sourceRepoRoot,
    branch: campaignBranch,
  });
  const slug = campaignBranch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 32) || 'campaign';
  const suffix = state.run.id.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
  const executionBranch = `campaigns/run-${slug}-${suffix}`;
  const executionPath = path.join(paths.runDir, `worktree-${suffix}`);
  const added = await gitResult(sourceRepoRoot, [
    'worktree', 'add', '-b', executionBranch, executionPath, campaignBranch,
  ]);
  if (!added.ok) {
    throw new StepPreflightError(
      'preflight_branch_unavailable',
      `Preflight stopped run start: the isolated worktree could not be created (${added.error}). Remedy: repair the repository, then rerun campaigns run.`,
      { branch: campaignBranch, cause: added.error },
    );
  }
  let canonicalExecutionPath;
  try {
    await carryWorktreeEssentials(sourceRepoRoot, executionPath);
    canonicalExecutionPath = await realpath(executionPath);
  } catch (error) {
    await gitResult(sourceRepoRoot, ['worktree', 'remove', '--force', executionPath]);
    await gitResult(sourceRepoRoot, ['branch', '-D', executionBranch]);
    throw new StepPreflightError(
      'preflight_branch_unavailable',
      `Preflight stopped run start: the isolated worktree could not be prepared (${error.message}). Remedy: repair the repository, then rerun campaigns run.`,
      { branch: campaignBranch, cause: error.message },
    );
  }
  const relativeCampaign = path.relative(sourceRepoRoot, campaignPath);
  const createdAt = new Date().toISOString();
  state.artifacts.worktree = {
    path: canonicalExecutionPath,
    branch: executionBranch,
    base_branch: campaignBranch,
    created_at: createdAt,
    cleanup_deadline: null,
    pruned_at: null,
  };
  state.run.identity.execution = {
    ...state.run.identity.execution,
    campaign_path: path.join(canonicalExecutionPath, relativeCampaign),
    repo_root: canonicalExecutionPath,
    branch: executionBranch,
  };
  await persistState(statePath, state);
  return state;
}

async function prepareSourceBranchForIsolation({ campaignPath, repoRoot, branch }) {
  const status = await runCommand('git', [
    '-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all',
  ]);
  if (status.exitCode !== 0) {
    const cause = status.stderr.trim() || 'git status failed';
    throw new StepPreflightError(
      'preflight_branch_unavailable',
      `Preflight stopped run start: Git could not inspect the campaign checkout (${cause}). Remedy: repair the repository, then rerun campaigns run.`,
      { cause, branch },
    );
  }
  if (status.stdout.trim()) {
    throw new StepPreflightError(
      'preflight_dirty_worktree',
      'Preflight stopped run start: the campaign checkout has uncommitted changes. Remedy: commit, stash, or discard them, then rerun campaigns run.',
      { paths: status.stdout.trim().split('\n') },
    );
  }
  try {
    await assertBranchCanBePrepared(repoRoot, branch);
    await prepareBranch(repoRoot, branch);
    await readFile(campaignPath, 'utf8');
  } catch (error) {
    throw new StepPreflightError(
      'preflight_branch_unavailable',
      `Preflight stopped run start: branch ${branch} cannot host the campaign (${error.message}). Remedy: repair the branch, then rerun campaigns run.`,
      { branch, cause: error.message },
    );
  }
}

async function carryWorktreeEssentials(sourceRepoRoot, executionPath) {
  const entries = await readdir(sourceRepoRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name === '.env' || entry.name.startsWith('.env.'))) {
      await copyFile(path.join(sourceRepoRoot, entry.name), path.join(executionPath, entry.name));
    }
  }
  const sourceModules = path.join(sourceRepoRoot, 'node_modules');
  const targetModules = path.join(executionPath, 'node_modules');
  if (await pathExists(sourceModules) && !(await pathExists(targetModules))) {
    await symlink(sourceModules, targetModules, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

export async function sweepExpiredExecutionWorktree(state, statePath, { now } = {}) {
  const worktree = state?.artifacts?.worktree;
  if (
    state?.run?.status !== 'awaiting_human_review'
    || !worktree
    || worktree.pruned_at
    || !worktree.cleanup_deadline
    || Date.parse(worktree.cleanup_deadline) > nowMilliseconds(now)
  ) return state;
  await pruneExecutionWorktree(state, statePath, { deleteBranch: false, now });
  return state;
}

async function settleExecutionWorktree(state, statePath, { now, awaitingHumanCleanupMs } = {}) {
  const worktree = state.artifacts.worktree;
  if (!worktree || worktree.pruned_at) return state;
  if (state.run.status === 'awaiting_human_review') {
    if (!worktree.cleanup_deadline) {
      const holdMs = positiveIntegerOr(
        numberOption(awaitingHumanCleanupMs),
        DEFAULT_AWAITING_HUMAN_CLEANUP_MS,
        'awaiting-human cleanup',
      );
      worktree.cleanup_deadline = new Date(nowMilliseconds(now) + holdMs).toISOString();
      await persistState(statePath, state);
    }
    return sweepExpiredExecutionWorktree(state, statePath, { now });
  }
  if (![
    'failed',
    'cap_reached',
    'stopped_by_user',
    'halted',
    'completed',
    'merged',
    'force_merged',
  ].includes(state.run.status)) return state;
  await pruneExecutionWorktree(state, statePath, {
    deleteBranch: ['completed', 'merged', 'force_merged'].includes(state.run.status),
    now,
  });
  return state;
}

export async function pruneExecutionWorktree(state, statePath, { deleteBranch = false, now } = {}) {
  const worktree = state?.artifacts?.worktree;
  if (!worktree || worktree.pruned_at) return { pruned: false, branchRetained: true };
  const repoRoot = state.run.identity.source.repo_root;
  const registered = (await listGitWorktrees(repoRoot)).find((candidate) => (
    candidate.path === canonicalPath(worktree.path)
  ));
  if (registered) {
    await snapshotDirtyExecutionWorktree(worktree.path);
    let removed = await gitResult(repoRoot, ['worktree', 'remove', worktree.path]);
    if (!removed.ok) removed = await gitResult(repoRoot, ['worktree', 'remove', '--force', worktree.path]);
    if (!removed.ok) throw new PumpRunError(`Could not prune execution worktree: ${removed.error}`);
  }
  await gitResult(repoRoot, ['worktree', 'prune']);
  let branchRetained = true;
  if (deleteBranch) {
    const deleted = await gitResult(repoRoot, ['branch', '-d', worktree.branch]);
    branchRetained = !deleted.ok;
  }
  worktree.pruned_at = new Date(nowMilliseconds(now)).toISOString();
  await persistState(statePath, state);
  return { pruned: true, branchRetained };
}

async function snapshotDirtyExecutionWorktree(worktreePath) {
  const status = await gitResult(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok) throw new PumpRunError(`Could not inspect execution worktree: ${status.error}`);
  if (!status.stdout.trim()) return false;
  const added = await gitResult(worktreePath, ['add', '-A']);
  if (!added.ok) throw new PumpRunError(`Could not preserve interrupted worktree changes: ${added.error}`);
  const committed = await gitResult(worktreePath, [
    '-c', 'commit.gpgSign=false', 'commit', '-m', 'Preserve interrupted campaign work',
  ]);
  if (!committed.ok) {
    throw new PumpRunError(`Could not preserve interrupted worktree changes: ${committed.error}`);
  }
  return true;
}

function nowMilliseconds(now) {
  if (typeof now === 'function') return Number(now());
  if (now instanceof Date) return now.getTime();
  if (now != null) return Number(now);
  return Date.now();
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function parsePorcelainZPaths(output) {
  const entries = String(output).split('\0');
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(status)) index += 1;
  }
  return paths;
}

async function resolveRunIdentity({ campaignPath, repoRoot, branch, mergeTargetBranch, registryId, env }) {
  const registryDir = defaultCampaignsDataDir(env);
  const registry = await readRegistry(path.join(registryDir, 'registry.json'));
  const entry = registryId
    ? registry.campaigns.find((candidate) => candidate.id === registryId)
    : registry.campaigns.find((candidate) => path.resolve(candidate.filePath) === campaignPath);
  let sourceCampaignPath = entry?.filePath ? path.resolve(entry.filePath) : campaignPath;
  try {
    sourceCampaignPath = await realpath(sourceCampaignPath);
  } catch {
    // Keep the registered absolute path when the source checkout disappeared.
  }
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
      path: canonicalPath(worktreePath),
      branch: branchRef.replace(/^refs\/heads\//, '') || null,
    };
  });
}

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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
    `Campaign: ${state.run.identity.source.campaign_path}`,
    `Run id: ${state.run.id}`,
    `Step: ${step.id} — ${step.name}`,
    '',
    step.prompt.trim(),
    '',
    'Commit the verified step changes before reporting completion. Use one high-level commit and keep unrelated paths out; the next step starts only from a clean worktree.',
    '',
    createRunnerCompletionInstruction(registry, runnerName, expected),
  ].join('\n');
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

async function writeStopSalvage(state, paths) {
  const workers = state.workers?.length
    ? state.workers
    : state.worker
      ? [{ step_id: state.run.current_step_id, ...state.worker }]
      : [];
  const outputTail = tailText((await Promise.all(workers.map(async (worker) => {
    const tail = await readOptionalText(worker.log_path);
    return tail ? `Step ${worker.step_id ?? 'unknown'}\n${tail}` : '';
  }))).filter(Boolean).join('\n\n'));
  if (!outputTail) return null;
  const salvagePath = path.join(paths.receiptsDir, 'stop-salvage.md');
  await mkdir(paths.receiptsDir, { recursive: true });
  await writeRedactedFile(salvagePath, [
    '# User stop salvage',
    '',
    `- Run: \`${state.run.id}\``,
    `- Steps: \`${state.run.current_step_ids?.join(', ') || state.run.current_step_id || 'none'}\``,
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
    ...formatCheckRuns(receipt.checkRuns),
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

function formatCheckRuns(checkRuns) {
  if (!Array.isArray(checkRuns) || checkRuns.every((run) => run.length === 0)) return [];
  const lines = ['', '## Executable checks', ''];
  for (const [runIndex, checks] of checkRuns.entries()) {
    if (checkRuns.length > 1) lines.push(`### Run ${runIndex + 1}`, '');
    for (const [checkIndex, check] of checks.entries()) {
      const commandFence = fenceFor(check.command);
      const output = check.output || '(no output)';
      const outputFence = fenceFor(output);
      lines.push(
        `#### Check ${checkIndex + 1}${check.step_id ? ` — Step ${check.step_id}` : ''}`,
        '',
        `- Outcome: \`${check.passed ? 'pass' : 'fail'}\``,
        `- Exit: \`${check.exit_code}\` (expected \`${check.expected_exit}\`)`,
        `- Timeout: \`${check.timeout_ms}ms\`${check.timed_out ? ' — timed out' : ''}`,
        ...(check.expected_output == null ? [] : [
          `- Expected output substring: \`${check.expected_output}\``,
        ]),
        ...(check.failure == null ? [] : [`- Failure: ${check.failure}`]),
        '',
        'Command:',
        '',
        commandFence,
        check.command,
        commandFence,
        '',
        'Captured output:',
        '',
        outputFence,
        output,
        outputFence,
        '',
      );
    }
  }
  return lines;
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

export async function runExecutableChecks(checks, { cwd } = {}) {
  if (!Array.isArray(checks)) throw new TypeError('checks must be an array');
  const results = [];
  for (const check of checks) results.push(await runExecutableCheck(check, cwd));
  return results;
}

async function runExecutableCheck(check, cwd) {
  const execution = await runShellCheck(check.command, cwd, check.timeoutMs);
  const captured = [
    execution.stdout ? `stdout:\n${execution.stdout}` : '',
    execution.stderr ? `stderr:\n${execution.stderr}` : '',
  ].filter(Boolean).join('\n\n');
  const combined = `${execution.stdout}${execution.stderr}`;
  const failures = [];
  if (execution.timedOut) failures.push(`timed out after ${check.timeoutMs}ms`);
  if (execution.exitCode !== check.expectedExit) {
    failures.push(`expected exit ${check.expectedExit}, received ${execution.exitCode}`);
  }
  if (check.expectedOutput != null && !combined.includes(check.expectedOutput)) {
    failures.push(`missing expected output substring: ${redactText(check.expectedOutput)}`);
  }
  return {
    ...(check.stepId == null ? {} : { step_id: check.stepId }),
    ...(check.stepName == null ? {} : { step_name: check.stepName }),
    command: redactText(check.command),
    expected_exit: check.expectedExit,
    expected_output: check.expectedOutput == null ? null : redactText(check.expectedOutput),
    timeout_ms: check.timeoutMs,
    exit_code: execution.exitCode,
    timed_out: execution.timedOut,
    passed: failures.length === 0,
    failure: failures.join('; ') || null,
    output: redactAndCapText(captured, CHECK_OUTPUT_MAX_CHARACTERS),
  };
}

function runShellCheck(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let timedOut = false;
    let forceTimer = null;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      timedOut = true;
      signalCheckProcess(child, 'SIGTERM');
      forceTimer = setTimeout(() => signalCheckProcess(child, 'SIGKILL'), 250);
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (spawnError) stderr += `${stderr ? '\n' : ''}${spawnError.message}`;
      resolve({
        exitCode: spawnError ? 127 : (exitCode ?? 1),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function signalCheckProcess(child, signal) {
  signalProcessGroupPid(child.pid, signal);
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

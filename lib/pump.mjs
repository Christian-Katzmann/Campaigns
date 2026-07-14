import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { readRegistry, writeFileAtomic } from './registry.mjs';
import {
  assertValidRunState,
  createRunState,
  transitionRunState,
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
  extractStepSections,
  linkChecksToSteps,
  parseMarkdown,
} from '../public/lib/parser.mjs';

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
  const campaignPath = path.resolve(campaignFile);
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
  };
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

  const title = blocks.find((block) => block.type === 'heading' && block.level === 1)?.text ?? 'Campaign';
  const branch = blocks
    .filter((block) => block.type === 'list')
    .flatMap((block) => block.items)
    .map((item) => item.text.match(/^\*\*Branch:\*\*\s*`([^`]+)`/i)?.[1] ?? null)
    .find(Boolean) ?? null;

  return { title, branch, steps };
}

export async function runCampaign(campaignFile, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout === undefined ? process.stdout : options.stdout;
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const campaignPath = path.resolve(campaignFile);
  const configPath = path.resolve(options.configPath ?? DEFAULT_RUNNER_CONFIG_PATH);
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const paths = runPathsForCampaign(campaignPath, runsDir);

  await mkdir(paths.runDir, { recursive: true });
  const lock = await acquireRunLock(paths.lockPath, campaignPath);
  try {
    const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
    const runnerRegistry = createRunnerRegistry(rawConfig);
    const initialMarkdown = await readFile(campaignPath, 'utf8');
    const initialPlan = parseCampaignPlan(initialMarkdown);
    const repoRoot = path.resolve(
      options.repoRoot ?? rawConfig.run?.repoRoot ?? await findGitRoot(path.dirname(campaignPath)),
    );
    const requestedBranch = options.branch ?? rawConfig.run?.branch ?? initialPlan.branch;
    const branch = await prepareBranch(repoRoot, requestedBranch);
    const markdown = await readFile(campaignPath, 'utf8');
    const plan = parseCampaignPlan(markdown);
    const runnerName = options.runner ?? runnerRegistry.defaultRunner;
    const runner = runnerRegistry.get(runnerName);
    const requestedEffort = options.effort ?? runner.defaults.effort;
    const effort = runner.effortMap[requestedEffort] ?? requestedEffort;
    const model = options.model ?? runner.defaults.model;
    const identity = await resolveRunIdentity({
      campaignPath,
      repoRoot,
      branch,
      registryId: options.registryId ?? null,
      env,
    });

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
    });

    if (state.worker?.pid && isProcessAlive(state.worker.pid)) {
      throw new PumpLockError(
        `A worker for this campaign is still running (pid ${state.worker.pid}).`,
      );
    }
    state = await prepareStateForResume(state, plan, paths.statePath);
    state = await syncCheckedSteps(state, plan, paths.statePath);

    if (state.run.status === 'awaiting_review') {
      stdout?.write(`Campaign already awaits final review.\nState: ${paths.statePath}\n`);
      return { ...paths, state };
    }

    while (true) {
      const currentMarkdown = await readFile(campaignPath, 'utf8');
      const currentPlan = parseCampaignPlan(currentMarkdown);
      assertSameSteps(state, currentPlan);
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
        stdout?.write(`All implementation steps complete; awaiting final review.\nState: ${paths.statePath}\n`);
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
        logPath,
        signal: options.signal,
        stdout,
        stderr,
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
      const classified = classifyRunnerResult(runnerRegistry, runnerName, {
        ...result,
        expected,
        receiptPath,
      });

      if (!classified.completed) {
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
    }
  } finally {
    await releaseRunLock(paths.lockPath, lock.token);
  }
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

async function loadOrCreateState({ paths, plan, identity, runnerName, model, effort, watchdog }) {
  try {
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
    assertValidRunState(state);
    assertSameSteps(state, plan);

    const reopened = state.steps.some((step) => (
      ['completed', 'skipped'].includes(step.status)
      && !plan.steps.find((candidate) => candidate.id === step.id)?.checked
    ));
    if (!reopened) return state;
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

async function prepareStateForResume(state, plan, statePath) {
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

  if (state.run.status === 'failed' || state.run.status === 'stopped') {
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

  if (['awaiting_review', 'completed', 'merged', 'force_merged'].includes(state.run.status)) {
    return state;
  }
  if (state.run.status !== 'running') {
    throw new PumpRunError(`Run cannot resume from status ${state.run.status}.`, { statePath });
  }
  assertSameSteps(state, plan);
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
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function resolveRunIdentity({ campaignPath, repoRoot, branch, registryId, env }) {
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
    execution: { campaign_path: campaignPath, repo_root: repoRoot, branch },
  };
}

async function findGitRoot(cwd) {
  const result = await runCommand('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new PumpRunError(`Campaign is not inside a Git repository: ${cwd}`);
  }
  return path.resolve(result.stdout.trim());
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
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: 'a' });
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    log.write(chunk);
    options.stdout?.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    log.write(chunk);
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
  const abort = () => child.kill('SIGTERM');
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    await options.onSpawn(child.pid ?? null);
    if (options.signal?.aborted) abort();
    child.stdin.end(invocation.stdin ?? '');
    return await closed;
  } catch (error) {
    child.kill('SIGTERM');
    await closed;
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await new Promise((resolve) => log.end(resolve));
  }
}

async function writeReceipt(receiptPath, receipt) {
  const stdoutFence = fenceFor(receipt.stdout);
  const stderrFence = fenceFor(receipt.stderr);
  const body = [
    `# Step ${receipt.step.id} receipt`,
    '',
    `- Run: \`${receipt.runId}\``,
    `- Step: ${receipt.step.name}`,
    `- Runner: \`${receipt.runner}\``,
    `- Model: \`${receipt.model}\``,
    `- Effort: \`${receipt.effort}\``,
    `- Exit code: \`${receipt.exitCode}\``,
    `- Worker log: \`${receipt.logPath}\``,
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
    '',
  ].join('\n');
  await writeFileAtomic(receiptPath, body);
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

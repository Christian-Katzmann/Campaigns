import { execFile, spawn } from 'node:child_process';
import { open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  defaultCampaignsRunsDir,
  runPathsForCampaign,
  sweepExpiredExecutionWorktree,
} from './pump.mjs';
import { assertValidRunState, upgradeRunState } from './run-state.mjs';

const AUTOMATE_BASE =
  process.env.CAMPAIGNS_AUTOMATE_BASE || path.join(homedir(), '.claude-automate', 'campaigns');
const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), '.codex');
const CODEX_DB = path.join(CODEX_HOME, 'sqlite', 'codex-dev.db');
const CODEX_SESSIONS = path.join(CODEX_HOME, 'sessions');
const CODEX_RECOVER_SCRIPT =
  process.env.CAMPAIGNS_CODEX_RECOVER ||
  path.join(homedir(), 'Dev', 'skills', 'campaign-automate', 'scripts', 'campaign_recover.py');
const CODEX_SQLITE_CACHE_TTL_MS = 5_000;
const CODEX_STATE_INDEX_TTL_MS = 2_000;
const GIT_IDENTITY_CACHE_TTL_MS = 30_000;
// New launcher states resolve by registry id/source path, so a missing Git
// checkout only affects the legacy fallback. Cache that miss long enough to
// avoid respawning doomed git probes on every UI poll.
const GIT_IDENTITY_NEGATIVE_TTL_MS = 30_000;
const CODEX_SESSION_TAIL_BYTES = 200_000;
const CODEX_SESSION_IDLE_MS = 15 * 60_000;
const CODEX_NON_STEP_UNIT_TYPES = new Set([
  'final_review',
  'final_rework',
  'step_review',
  'step_rework',
  'phase_review',
]);
const ATTENTION_EVENT_PATTERN = /(failed|failure|error|blocked|blocker|halted|deferred|cooldown|stalled|timeout)/i;

// Provider order only breaks ties. Real running/pending/attention status wins
// first, so an old backend warning cannot hide a live worker from the UI.
const providers = [engineProvider(), claudeProvider(), codexProvider()];
const providerOverlapWarnings = new Set();
const codexSqliteCache = new Map();
const codexStateIndexCache = new Map();
const gitRepoIdentityCache = new Map();

export async function getAutomateProviderAvailability() {
  const [engine, claude, codex] = await Promise.all([
    isDirectory(defaultCampaignsRunsDir()),
    isDirectory(AUTOMATE_BASE),
    isDirectory(CODEX_HOME),
  ]);
  return {
    available: engine || claude || codex,
    providers: { engine, claude, codex },
  };
}

export async function getAutomateState(filePath, { summary = false, registryId = null } = {}) {
  const matches = [];
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const state = await provider.getState(filePath, { summary, registryId });
    if (state) {
      matches.push({ provider, state, index });
    }
  }
  if (matches.length === 0) return null;

  const winner = chooseAutomateState(matches);
  if (!summary && matches.length > 1) {
    await warnIfProviderOverlap(
      winner.provider,
      matches.filter((match) => match.provider !== winner.provider).map((match) => match.provider),
      filePath,
    );
  }
  return winner.state;
}

export async function getAutomateStates(filePath, { summary = false, registryId = null } = {}) {
  const matches = [];
  for (const provider of providers) {
    const state = await provider.getState(filePath, { summary, registryId });
    if (state) matches.push(state);
  }
  return matches;
}

export async function nudgeAutomateState(filePath, mode, { registryId = null } = {}) {
  for (const provider of providers) {
    if (await provider.detect(filePath, { registryId })) {
      return provider.nudge(filePath, mode);
    }
  }

  return { ok: false, message: 'No automation state found for this campaign.' };
}

async function warnIfProviderOverlap(winningProvider, remainingProviders, filePath) {
  for (const provider of remainingProviders) {
    if (!provider.detect) continue;
    const key = `${winningProvider.name}:${provider.name}:${path.resolve(filePath)}`;
    if (providerOverlapWarnings.has(key)) continue;
    if (await provider.detect(filePath)) {
      providerOverlapWarnings.add(key);
      console.warn(
        `automate-providers: both ${winningProvider.name} and ${provider.name} match ${filePath}; ${winningProvider.name} wins.`,
      );
    }
  }
}

export function chooseAutomateState(matches) {
  return [...matches].sort((a, b) => {
    const priorityDiff = automateStatePriority(b.state) - automateStatePriority(a.state);
    if (priorityDiff !== 0) return priorityDiff;
    return a.index - b.index;
  })[0];
}

function automateStatePriority(state) {
  const status = state?.status === 'active' && state?.is_active === false ? 'stalled' : state?.status;
  if (status === 'active' || status === 'running') return 100;
  if (status === 'queued' || status === 'scheduled') return 80;
  if (status === 'paused' || status === 'parked') return 70;
  if ([
    'stalled',
    'blocked',
    'awaiting_human_review',
    'cap_reached',
    'stopped_by_user',
  ].includes(status)) return 60;
  if (status === 'failed' || status === 'halted' || status === 'abandoned') return 50;
  if (status === 'completed' || status === 'complete') return 40;
  return 0;
}

function nudgeClaudeAutomateState(filePath, mode) {
  const slug = path.basename(filePath, '.md');
  const modeFlags = {
    continue: ['--continue'],
    skip: ['--skip'],
    restart_failed: ['--restart-failed'],
    restart: [],
  };

  const flags = modeFlags[mode];
  if (!flags) {
    return Promise.resolve({ ok: false, message: `Unknown nudge mode: ${mode}` });
  }

  return new Promise((resolve) => {
    execFile(
      'claude-automate',
      ['recover', '--slug', slug, ...flags],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          // The CLI sometimes prints its rejection message to stdout (e.g.
          // "No running or failed step to recover."), so fall back to stdout
          // before the generic execFile error.message.
          const msg = stderr?.trim() || stdout?.trim() || error.message;
          resolve({ ok: false, message: msg });
        } else {
          resolve({ ok: true, message: stdout.trim() || 'Nudge sent.' });
        }
      },
    );
  });
}

// `claude-automate finalize` runs the actual review subprocess in-process and
// can take many minutes — far too long for an HTTP request. Mirror the Python
// CLI's `_spawn_finalize` pattern: fire detached, log to the campaign dir,
// return immediately.
export async function rerunAutomateFinalize(filePath) {
  const slug = path.basename(filePath, '.md');
  const baseDir = path.join(AUTOMATE_BASE, slug);

  try {
    await readFile(path.join(baseDir, 'state.json'), 'utf8');
  } catch {
    return { ok: false, message: `No campaign state found for "${slug}".` };
  }

  const logPath = path.join(baseDir, 'logs', 'finalize.log');
  let logFd;
  try {
    logFd = await open(logPath, 'a');
  } catch (err) {
    return { ok: false, message: `Could not open finalize log: ${err.message}` };
  }

  try {
    await logFd.write(
      `\n=== finalize re-run requested from Campaigns UI at ${new Date().toISOString()} ===\n`,
    );

    const child = spawn(
      'claude-automate',
      ['finalize', '--slug', slug, '--force'],
      {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
      },
    );
    child.unref();
  } catch (err) {
    await logFd.close();
    return { ok: false, message: `Could not spawn finalize: ${err.message}` };
  } finally {
    await logFd.close();
  }

  return {
    ok: true,
    message: 'Finalize started. This can take a few minutes — refresh to see results.',
  };
}

export async function abandonAutomateCampaign(filePath) {
  const slug = path.basename(filePath, '.md');
  const statePath = path.join(AUTOMATE_BASE, slug, 'state.json');

  let stateData;
  try {
    const raw = await readFile(statePath, 'utf8');
    stateData = JSON.parse(raw);
  } catch {
    return { ok: false, message: `No campaign state found for "${slug}".` };
  }

  // The CLI uses 'halted' as a terminal-state sentinel everywhere. Adding the
  // `abandoned_at` marker lets the provider surface "abandoned" to the UI
  // without minting a new status value the CLI doesn't understand.
  stateData.abandoned_at = new Date().toISOString();
  if (stateData.status !== 'completed') {
    stateData.status = 'halted';
  }

  try {
    await writeFile(statePath, `${JSON.stringify(stateData, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, message: `Could not update campaign state: ${err.message}` };
  }

  return { ok: true, message: 'Campaign marked abandoned.' };
}

function engineProvider() {
  return {
    name: 'engine',
    detect: hasEngineState,
    nudge: async () => ({
      ok: false,
      message: 'Use the new-engine recovery action for this campaign.',
    }),
    async getState(filePath, { summary = false, registryId = null } = {}) {
      const located = await findEngineState(filePath, registryId);
      if (!located) return null;
      const stateData = await sweepExpiredExecutionWorktree(
        located.stateData,
        located.statePath,
      );
      const runDir = stateData.artifacts.run_dir;
      const lock = await readEngineLock(path.join(runDir, 'run.lock'));
      const runtime = deriveEngineRuntime(stateData, lock);
      const markdown = await readAutomationMarkdown(filePath, stateData);
      const campaignMap = parseCodexCampaignMarkdown(markdown);
      const progress = countAutomationProgress(markdown);
      const execution = automationExecutionContext(filePath, stateData);
      const currentStepIds = stateData.run.current_step_ids?.length
        ? stateData.run.current_step_ids
        : stateData.run.current_step_id
          ? [stateData.run.current_step_id]
          : [];
      const currentSteps = currentStepIds.map((stepId) => (
        stateData.steps.find((step) => step.id === stepId) ?? null
      )).filter(Boolean).map((step) => ({
        id: step.id,
        name: step.name,
        phase: step.phase,
        phase_name: step.phase ? `Phase ${step.phase}` : null,
        started_at: step.started_at,
      }));
      const currentStep = currentSteps[0] ?? null;
      const attention = summarizeAutomationAttention(stateData);

      if (summary) {
        return {
          backend: 'engine',
          run_id: stateData.run.id,
          is_active: runtime.isActive,
          status: runtime.status,
          run_status: stateData.run.status,
          attention,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
          current_step_started_at: currentStep?.started_at ?? null,
          current_step_ids: currentSteps.map((step) => step.id),
          progress,
          execution,
        };
      }

      const activeWorkers = stateData.workers?.length
        ? stateData.workers
        : stateData.worker && currentStep
          ? [{ step_id: currentStep.id, ...stateData.worker }]
          : [];
      const currentStepLogs = Object.fromEntries(await Promise.all(activeWorkers.map(async (worker) => (
        [worker.step_id, worker.log_path ? await readTextFile(worker.log_path) : null]
      ))));
      const currentStepLog = currentSteps.length > 1
        ? currentSteps.map((step) => (
            `Step ${step.id} — ${step.name}\n${currentStepLogs[step.id] ?? ''}`
          )).join('\n\n')
        : currentStep
          ? currentStepLogs[currentStep.id] ?? null
          : null;
      const liveOutputs = activeWorkers
        .filter((worker) => worker.live_output_path && registryId)
        .map((worker) => ({
          step_id: worker.step_id,
          invocation_id: worker.invocation_id,
          runner: worker.runner,
          url: `/api/run/live-output?id=${encodeURIComponent(registryId)}&step=${encodeURIComponent(worker.step_id)}&invocation=${encodeURIComponent(worker.invocation_id)}`,
        }));
      const steps = await enrichEngineSteps(
        stateData.steps,
        campaignMap,
        stateData.config.runner,
        registryId,
      );

      return {
        backend: 'engine',
        run_id: stateData.run.id,
        is_active: runtime.isActive,
        status: runtime.status,
        run_status: stateData.run.status,
        attention,
        started_at: stateData.run.started_at ?? stateData.run.created_at,
        current_step: currentStep,
        current_steps: currentSteps,
        max_step_minutes: Math.ceil(
          (stateData.config.watchdog.minimum_runtime_ms + stateData.config.watchdog.stall_window_ms)
          / 60_000,
        ),
        steps,
        review: {
          status: stateData.review.status,
          verdict: stateData.review.verdict,
          reasons: stateData.review.reasons,
          raw_tags: stateData.review.raw_tags,
          findings: stateData.review.findings ?? [],
        },
        timeline_events: stateData.history.map((entry) => ({
          ...entry,
          ts: entry.at,
          reason: entry.details?.reason ?? entry.details?.failure_code ?? null,
        })),
        current_step_log: currentStepLog,
        current_step_logs: currentStepLogs,
        live_outputs: liveOutputs,
        live_activity: stateData.config.runner === 'claude' && currentSteps.length === 1
          ? parseLiveActivity(currentStepLog)
          : null,
        live_activities: stateData.config.runner === 'claude'
          ? Object.fromEntries(Object.entries(currentStepLogs).map(([stepId, log]) => (
              [stepId, parseLiveActivity(log)]
            )))
          : null,
        progress,
        execution,
        nudge_modes: null,
        finalize: null,
        finalize_actions: null,
      };
    },
  };
}

async function hasEngineState(filePath, { registryId = null } = {}) {
  return Boolean(await findEngineState(filePath, registryId));
}

export async function findEngineStatePath(
  filePath,
  registryId = null,
  runsDir = defaultCampaignsRunsDir(),
) {
  return (await findEngineState(filePath, registryId, runsDir))?.statePath ?? null;
}

export async function getEngineRunLedger(
  filePath,
  registryId = null,
  runsDir = defaultCampaignsRunsDir(),
) {
  return (await findEngineState(filePath, registryId, runsDir))?.stateData ?? null;
}

export async function resolveEngineLiveOutput(
  filePath,
  { registryId, stepId, invocationId, runsDir = defaultCampaignsRunsDir() },
) {
  const located = await findEngineState(filePath, registryId, runsDir);
  const worker = located?.stateData.workers?.find((candidate) => (
    candidate.step_id === stepId && candidate.invocation_id === invocationId
  ));
  if (!worker?.live_output_path) return null;
  try {
    const allowedRoot = await realpath(path.join(located.stateData.artifacts.run_dir, 'live-output'));
    const transportPath = await realpath(worker.live_output_path);
    const relative = path.relative(allowedRoot, transportPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return {
      path: transportPath,
      run_id: located.stateData.run.id,
      step_id: worker.step_id,
      invocation_id: worker.invocation_id,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function findEngineState(filePath, registryId = null, runsDir = defaultCampaignsRunsDir()) {
  const markdownPath = path.resolve(filePath);
  const directPath = runPathsForCampaign(markdownPath, runsDir).statePath;
  const direct = await matchEngineStateCandidate(directPath, markdownPath, registryId);
  if (direct) return direct;

  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(runsDir, entry.name, 'state.json');
    if (statePath === directPath) continue;
    const candidate = await matchEngineStateCandidate(statePath, markdownPath, registryId);
    if (candidate) return candidate;
  }
  return null;
}

async function matchEngineStateCandidate(statePath, markdownPath, registryId) {
  try {
    const stateData = upgradeRunState(await readJsonFile(statePath));
    assertValidRunState(stateData);
    if (!(await campaignStateMatchesFile(markdownPath, stateData, { registryId }))) return null;
    return { statePath, stateData };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

async function readEngineLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function deriveEngineRuntime(stateData, lock) {
  const runStatus = stateData.run.status;
  const livePid = [
    ...(stateData.workers ?? []).map((worker) => worker?.pid),
    stateData.worker?.pid,
    lock?.pid,
  ]
    .find((pid) => Number.isInteger(pid) && pid > 0 && isLivePid(pid));
  const activeStatus = ['running', 'reviewing', 'reworking', 'recovering'].includes(runStatus);
  if (activeStatus) {
    return livePid
      ? { status: 'active', isActive: true }
      : { status: 'stalled', isActive: false };
  }
  if (runStatus === 'pending') return { status: 'queued', isActive: false };
  if (['awaiting_review', 'completed', 'merged', 'force_merged'].includes(runStatus)) {
    return { status: 'completed', isActive: false };
  }
  if (runStatus === 'blocked') return { status: 'blocked', isActive: false };
  if (runStatus === 'awaiting_human_review') {
    return { status: 'awaiting_human_review', isActive: false };
  }
  if (runStatus === 'cap_reached') return { status: 'cap_reached', isActive: false };
  if (runStatus === 'stopped_by_user') return { status: 'stopped_by_user', isActive: false };
  if (runStatus === 'failed') return { status: 'failed', isActive: false };
  if (runStatus === 'halted') return { status: 'halted', isActive: false };
  return { status: runStatus, isActive: false };
}

function isLivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function enrichEngineSteps(steps, campaignMap, runner, registryId) {
  return Promise.all(steps.map(async (step) => {
    const authored = campaignMap.steps.get(step.id);
    const receipt = step.receipt_path ? await readTextFile(step.receipt_path) : null;
    return {
      id: step.id,
      name: step.name,
      phase: step.phase,
      phase_name: step.phase ? `Phase ${step.phase}` : null,
      status: engineStepStatus(step.status),
      prompt: authored?.prompt ?? null,
      receipt,
      runner,
      parallel: step.parallel ?? null,
      commit_range: step.commit_range ?? null,
      parallel_group: step.parallel_group ?? null,
      diff_url: step.status === 'completed' && step.commit_range && registryId
        ? `/api/run/step-diff?id=${encodeURIComponent(registryId)}&step=${encodeURIComponent(step.id)}`
        : null,
    };
  }));
}

function engineStepStatus(status) {
  if (status === 'completed' || status === 'skipped') return 'done';
  if (status === 'stopped') return 'failed';
  return status;
}

async function readTextFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function codexProvider() {
  return {
    name: 'codex',
    detect: hasCodexState,
    nudge: nudgeCodexAutomateState,
    async getState(filePath, { summary = false, registryId = null } = {}) {
      const located = await findCodexState(filePath, registryId);
      if (!located) return null;
      const { statePath, stateData } = located;

      const runDir = path.resolve(stateData.campaign?.run_dir || path.dirname(statePath));
      const runDirMissing = !(await isDirectory(runDir));
      const lock = runDirMissing ? null : await readCodexLock(runDir);
      const maxMinutes = codexMaxStepMinutes(stateData);
      const activeRun = normalizeCodexActiveRun(stateData.active_run, maxMinutes);
      const pendingAutomation = normalizeCodexPendingAutomation(stateData.pending_automation);
      const latestAutomation = latestCodexAutomation(stateData);
      const runtimeAutomationId = activeRun?.automation_id ?? pendingAutomation?.id ?? latestAutomation?.id ?? null;
      const [registry, run] = await Promise.all([
        runtimeAutomationId ? readCodexAutomation(runtimeAutomationId) : null,
        runtimeAutomationId ? readCodexAutomationRun(runtimeAutomationId) : null,
      ]);
      let sessionPath = null;
      let sessionStat = null;
      if (activeRun?.session_path) {
        const candidateStat = await safeStat(activeRun.session_path);
        if (candidateStat?.isFile()) {
          sessionPath = activeRun.session_path;
          sessionStat = candidateStat;
        }
      }
      if (!sessionPath && run?.thread_id) {
        sessionPath = await findCodexSessionJsonl(run.thread_id, run.created_at);
        sessionStat = sessionPath ? await safeStat(sessionPath) : null;
      }
      const runtime = deriveCodexRuntime({
        stateData,
        activeRun,
        pendingAutomation,
        registry,
        run,
        lock,
        sessionStat,
        maxMinutes,
        runDirMissing,
      });
      const status = runtime.status;
      const attention = summarizeAutomationAttention(stateData);

      const markdown = await readAutomationMarkdown(filePath, stateData);
      const campaignMap = parseCodexCampaignMarkdown(markdown);
      const progress = countAutomationProgress(markdown);
      const execution = automationExecutionContext(filePath, stateData);
      const currentStepId = activeRun?.step_id ?? pendingAutomation?.step_id ?? lock?.step_id ?? stateData.cursor?.step_id ?? null;
      const currentStepData = currentStepId ? campaignMap.steps.get(currentStepId) ?? null : null;
      const startedAt = activeRun?.started_at ?? pendingAutomation?.created_at ?? lock?.started_at ?? msToIso(run?.created_at) ?? null;
      const currentStep = buildCodexCurrentUnit({
        currentStepId,
        currentStepData,
        activeRun,
        pendingAutomation,
        latestAutomation,
        lock,
        stateData,
        startedAt,
      });

      if (summary) {
        return {
          backend: 'codex',
          run_id: runtimeAutomationId,
          is_active: runtime.isActive,
          status,
          attention,
          has_active_run: Boolean(activeRun),
          active_run_last_seen_at: activeRun?.last_seen_at ?? null,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
          current_step_started_at: currentStep?.started_at ?? null,
          progress,
          execution,
        };
      }

      const [timelineEvents, sessionTail] = await Promise.all([
        runDirMissing ? [] : readTimelineEvents(stateData, runDir),
        sessionPath ? readFileTail(sessionPath, CODEX_SESSION_TAIL_BYTES) : '',
      ]);
      const sessionActivity = parseCodexSessionTail(sessionTail);
      const steps = await enrichCodexStepsWithReceipts(campaignMap.stepsList, stateData, runDir, {
        currentStepId,
        status,
      });

      return {
        backend: 'codex',
        run_id: runtimeAutomationId,
        is_active: runtime.isActive,
        status,
        attention,
        has_active_run: Boolean(activeRun),
        active_run_last_seen_at: activeRun?.last_seen_at ?? null,
        started_at: stateData.campaign?.created_at ?? null,
        current_step: currentStep,
        max_step_minutes: maxMinutes,
        steps,
        timeline_events: timelineEvents,
        current_step_log: sessionActivity.log,
        live_activity: sessionActivity.live_activity,
        progress,
        execution,
        nudge_modes: buildCodexNudgeModes(status, currentStep, { hasLock: Boolean(lock) }),
        finalize: null,
        finalize_actions: null,
      };
    },
  };
}

function claudeProvider() {
  return {
    name: 'claude',
    async detect(filePath, { registryId = null } = {}) {
      const slug = path.basename(filePath, '.md');
      try {
        const raw = await readFile(path.join(AUTOMATE_BASE, slug, 'state.json'), 'utf8');
        return campaignStateMatchesFile(filePath, JSON.parse(raw), { registryId });
      } catch {
        return false;
      }
    },
    nudge: nudgeClaudeAutomateState,
    async getState(filePath, { summary = false, registryId = null } = {}) {
      const slug = path.basename(filePath, '.md');
      const baseDir = path.join(AUTOMATE_BASE, slug);

      let stateData;
      try {
        const raw = await readFile(path.join(baseDir, 'state.json'), 'utf8');
        stateData = JSON.parse(raw);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`automate-providers: bad state.json for ${slug}:`, err.message);
        }
        return null;
      }
      if (!(await campaignStateMatchesFile(filePath, stateData, { registryId }))) return null;

      const currentStepData = stateData.current_step_id
        ? stateData.steps?.find((s) => s.id === stateData.current_step_id) ?? null
        : null;

      const maxMinutes = stateData.config?.max_step_minutes ?? 60;
      const finalizeRunning = await isClaudeFinalizeRunning(baseDir);
      const status = deriveStatus(stateData, currentStepData, maxMinutes, finalizeRunning);

      const currentStep = currentStepData
        ? {
            id: currentStepData.id,
            name: currentStepData.name,
            phase: currentStepData.phase,
            phase_name: currentStepData.phase_name,
            started_at: currentStepData.started_at,
          }
        : null;
      const attention = summarizeAutomationAttention(stateData);
      const markdown = await readAutomationMarkdown(filePath, stateData);
      const progress = countAutomationProgress(markdown);
      const execution = automationExecutionContext(filePath, stateData);

      if (summary) {
        return {
          backend: 'claude',
          run_id: stringOrNull(stateData.run_id ?? stateData.id),
          is_active: status === 'active' || status === 'stalled',
          status,
          attention,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
          current_step_started_at: currentStep?.started_at ?? null,
          progress,
          execution,
        };
      }

      const allSteps = stateData.steps ?? [];
      const [timelineEvents, currentStepLog, steps, finalize] = await Promise.all([
        readTimelineEvents(stateData, baseDir),
        readCurrentStepLog(currentStepData, baseDir),
        enrichStepsWithReceipts(allSteps, baseDir),
        buildFinalizeBlock(stateData.finalize),
      ]);

      return {
        backend: 'claude',
        run_id: stringOrNull(stateData.run_id ?? stateData.id),
        is_active: status === 'active' || status === 'stalled',
        status,
        attention,
        started_at: stateData.created_at,
        current_step: currentStep,
        max_step_minutes: maxMinutes,
        steps,
        timeline_events: timelineEvents,
        current_step_log: currentStepLog,
        live_activity: parseLiveActivity(currentStepLog),
        progress,
        execution,
        nudge_modes: buildNudgeModes(status, currentStepData, allSteps),
        finalize,
        finalize_actions: buildFinalizeActions(status, currentStepData, allSteps, finalize),
      };
    },
  };
}

async function hasCodexState(filePath, { registryId = null } = {}) {
  return Boolean(await findCodexState(filePath, registryId));
}

export async function findCodexStatePath(filePath, registryId = null) {
  return (await findCodexState(filePath, registryId))?.statePath ?? null;
}

async function findCodexState(filePath, registryId = null) {
  const markdownPath = path.resolve(filePath);
  const slug = path.basename(markdownPath, '.md');
  const repoDir = path.resolve(path.dirname(markdownPath), '..');

  const statePath = path.join(repoDir, 'reports', 'campaign-automation', slug, 'state.json');
  const direct = await matchCodexStateCandidate(statePath, markdownPath, registryId, true);
  if (direct) return direct;

  // Explicit --slug values and renamed campaign files can put state under a
  // directory that does not match the markdown basename. The registry id makes
  // a bounded repo-local fallback scan unambiguous. Cache the parsed index very
  // briefly so a library containing many campaigns does not reread it N times.
  const runRoot = path.join(repoDir, 'reports', 'campaign-automation');
  for (const candidate of await readCodexStateIndex(runRoot)) {
    if (candidate.statePath === statePath) continue;
    const campaign = stateCampaignRecord(candidate.stateData);
    const candidateRegistryId = stringOrNull(
      campaign.registry_id ?? candidate.stateData?.registry_id,
    );
    if (registryId && candidateRegistryId === registryId) return candidate;

    // Legacy custom-slug state has no registry id. Only compare records whose
    // stored markdown basename can actually be this campaign; this keeps the
    // fallback cheap even in repos with many historical automation states.
    const sourcePath = stringOrNull(
      campaign.source_campaign_path ?? candidate.stateData?.source_campaign_path,
    );
    const executionPath = stringOrNull(
      campaign.campaign_path ?? candidate.stateData?.campaign_path,
    );
    const plausiblePath = sourcePath ?? executionPath;
    if (
      plausiblePath &&
      path.basename(plausiblePath) === path.basename(markdownPath) &&
      (await sameResolvedPath(markdownPath, plausiblePath))
    ) {
      return candidate;
    }
  }
  return null;
}

async function matchCodexStateCandidate(statePath, markdownPath, registryId, logErrors = false) {
  try {
    const stateData = await readJsonFile(statePath);
    if (await campaignStateMatchesFile(markdownPath, stateData, { registryId })) {
      return { statePath, stateData };
    }
  } catch (err) {
    if (logErrors && err.code !== 'ENOENT') {
      console.error(`automate-providers: bad Codex state candidate ${statePath}:`, err.message);
    }
  }
  return null;
}

async function readCodexStateIndex(runRoot) {
  let directoryMtimeMs;
  try {
    directoryMtimeMs = (await stat(runRoot)).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const cached = codexStateIndexCache.get(runRoot);
  if (
    cached &&
    cached.directoryMtimeMs === directoryMtimeMs &&
    cached.expiresAt > Date.now()
  ) {
    return cached.promise;
  }

  const promise = (async () => {
    let entries;
    try {
      entries = await readdir(runRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const statePath = path.join(runRoot, entry.name, 'state.json');
          try {
            return { statePath, stateData: await readJsonFile(statePath) };
          } catch {
            return null;
          }
        }),
    );
    return records.filter(Boolean);
  })();
  codexStateIndexCache.set(runRoot, {
    directoryMtimeMs,
    expiresAt: Date.now() + CODEX_STATE_INDEX_TTL_MS,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    codexStateIndexCache.delete(runRoot);
    throw error;
  }
}

async function nudgeCodexAutomateState(filePath, mode) {
  const statePath = await findCodexStatePath(filePath);
  if (!statePath) {
    return { ok: false, message: 'No Codex automation state found for this campaign.' };
  }

  if (!(await fileExists(CODEX_RECOVER_SCRIPT))) {
    return { ok: false, message: 'Update the campaign-automate skill to enable nudge.' };
  }

  const modeArg = {
    continue: 'continue',
    restart: 'restart',
    skip: 'skip',
    restart_failed: 'restart-failed',
  }[mode];
  if (!modeArg) {
    return { ok: false, message: `Unknown nudge mode: ${mode}` };
  }

  try {
    const { stdout } = await execFileText(
      'python3',
      [
        CODEX_RECOVER_SCRIPT,
        '--state',
        statePath,
        '--mode',
        modeArg,
        '--delay-minutes',
        '1',
        '--json',
      ],
      { timeout: 60_000 },
    );
    const line = stdout
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.startsWith('{'));
    const parsed = line ? JSON.parse(line) : null;
    return {
      ok: Boolean(parsed?.ok),
      message: parsed?.message || 'Nudge sent.',
    };
  } catch (err) {
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
    return { ok: false, message: detail || 'Could not nudge Codex automation.' };
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function sameResolvedPath(left, right) {
  return (await comparablePath(left)) === (await comparablePath(right));
}

async function comparablePath(value) {
  try {
    return (await realpath(value)).normalize('NFC');
  } catch {
    return path.resolve(value).normalize('NFC');
  }
}

// A campaign has one logical identity even when its execution copy lives on a
// different branch/worktree path. New launcher states carry the source path;
// legacy states fall back to their stored worktree mapping or Git's shared
// common directory plus the repo-relative markdown path.
export async function campaignStateMatchesFile(filePath, stateData, { registryId = null } = {}) {
  const registeredPath = path.resolve(filePath);
  const campaign = stateCampaignRecord(stateData);
  const stateRegistryId = stringOrNull(campaign.registry_id ?? stateData?.registry_id);
  if (registryId && stateRegistryId && registryId === stateRegistryId) return true;
  const sourcePath = stringOrNull(campaign.source_campaign_path ?? stateData?.source_campaign_path);
  const executionPath = stringOrNull(campaign.campaign_path ?? stateData?.campaign_path);

  if (sourcePath && (await sameResolvedPath(registeredPath, sourcePath))) return true;
  if (executionPath && (await sameResolvedPath(registeredPath, executionPath))) return true;

  const worktree = campaign.worktree && typeof campaign.worktree === 'object' ? campaign.worktree : {};
  const baseRepo = stringOrNull(
    campaign.base_repo_path ?? stateData?.base_repo_path ?? worktree.base_repo_path,
  );
  const executionRepo = stringOrNull(
    campaign.repo_path ?? stateData?.repo_path ?? worktree.path,
  );
  if (
    baseRepo &&
    executionRepo &&
    executionPath &&
    sameRepoRelativePath(baseRepo, registeredPath, executionRepo, executionPath)
  ) {
    return true;
  }

  if (!executionPath) return false;
  const executionRelative = executionRepo
    ? relativePathWithin(executionRepo, executionPath)
    : null;
  const [registeredIdentity, executionIdentity, baseIdentity] = await Promise.all([
    gitFileIdentity(registeredPath),
    gitFileIdentity(executionPath),
    baseRepo ? gitRepoIdentity(baseRepo) : null,
  ]);
  if (
    registeredIdentity &&
    baseIdentity &&
    executionRelative &&
    registeredIdentity.commonDir === baseIdentity.commonDir &&
    registeredIdentity.relativePath === executionRelative
  ) {
    return true;
  }
  return Boolean(
    registeredIdentity &&
      executionIdentity &&
      registeredIdentity.commonDir === executionIdentity.commonDir &&
      registeredIdentity.relativePath === executionIdentity.relativePath,
  );
}

function stateCampaignRecord(stateData) {
  const identity = stateData?.run?.identity;
  if (identity?.source && identity?.execution) {
    return {
      registry_id: identity.registry_id ?? null,
      source_campaign_path: identity.source.campaign_path,
      base_repo_path: identity.source.repo_root,
      campaign_path: identity.execution.campaign_path,
      repo_path: identity.execution.repo_root,
      branch: identity.execution.branch,
    };
  }
  if (stateData?.campaign && typeof stateData.campaign === 'object') return stateData.campaign;
  return stateData && typeof stateData === 'object' ? stateData : {};
}

function sameRepoRelativePath(leftRoot, leftPath, rightRoot, rightPath) {
  const left = relativePathWithin(leftRoot, leftPath);
  const right = relativePathWithin(rightRoot, rightPath);
  return Boolean(left && right && left === right);
}

function relativePathWithin(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.normalize('NFC');
}

async function gitFileIdentity(filePath) {
  const details = await safeStat(filePath);
  if (!details?.isFile()) return null;
  const cwd = path.dirname(path.resolve(filePath));
  const repo = await gitRepoIdentity(cwd);
  if (!repo) return null;
  try {
    const canonicalFile = await comparablePath(filePath);
    const relativePath = relativePathWithin(repo.root, canonicalFile);
    if (!relativePath) return null;
    return {
      commonDir: repo.commonDir,
      relativePath,
    };
  } catch {
    return null;
  }
}

async function gitRepoIdentity(repoPath) {
  const cacheKey = path.resolve(repoPath).normalize('NFC');
  const cached = gitRepoIdentityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = loadGitRepoIdentity(cacheKey);
  gitRepoIdentityCache.set(cacheKey, {
    expiresAt: Date.now() + GIT_IDENTITY_CACHE_TTL_MS,
    promise,
  });
  const result = await promise;
  if (!result) {
    const entry = gitRepoIdentityCache.get(cacheKey);
    if (entry?.promise === promise) {
      entry.expiresAt = Date.now() + GIT_IDENTITY_NEGATIVE_TTL_MS;
    }
  }
  return result;
}

async function loadGitRepoIdentity(repoPath) {
  try {
    const [rootResult, commonResult] = await Promise.all([
      execFileText('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { timeout: 1_000 }),
      execFileText(
        'git',
        ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { timeout: 1_000 },
      ),
    ]);
    const root = rootResult.stdout.trim();
    const commonDir = commonResult.stdout.trim();
    if (!root || !commonDir) return null;
    return {
      root: await comparablePath(root),
      commonDir: await comparablePath(commonDir),
    };
  } catch {
    return null;
  }
}

async function readAutomationMarkdown(filePath, stateData) {
  const campaign = stateCampaignRecord(stateData);
  const executionPath = stringOrNull(campaign.campaign_path ?? stateData?.campaign_path);
  const candidates = [executionPath, filePath].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // A completed worktree may already be removed; main is the safe fallback.
    }
  }
  return '';
}

function automationExecutionContext(filePath, stateData) {
  const campaign = stateCampaignRecord(stateData);
  const worktree = campaign.worktree && typeof campaign.worktree === 'object' ? campaign.worktree : {};
  const sourcePath = stringOrNull(campaign.source_campaign_path ?? stateData?.source_campaign_path ?? filePath);
  const executionPath = stringOrNull(campaign.campaign_path ?? stateData?.campaign_path ?? filePath);
  const sourceRepo = stringOrNull(
    campaign.base_repo_path ?? stateData?.base_repo_path ?? worktree.base_repo_path,
  );
  const executionRepo = stringOrNull(
    campaign.repo_path ?? stateData?.repo_path ?? worktree.path,
  );
  const branch = stringOrNull(worktree.branch ?? campaign.branch ?? stateData?.branch);
  const explicitlyWorktree = Boolean(
    worktree.path ||
    worktree.base_repo_path ||
    (sourceRepo && executionRepo && path.resolve(sourceRepo) !== path.resolve(executionRepo)),
  );
  const pathsDiffer = Boolean(
    sourcePath && executionPath && path.resolve(sourcePath).normalize('NFC') !== path.resolve(executionPath).normalize('NFC'),
  );
  return {
    kind: explicitlyWorktree || pathsDiffer ? 'worktree' : branch && branch !== 'main' ? 'branch' : 'main',
    branch,
    path: executionRepo ? path.resolve(executionRepo) : null,
  };
}

export function countAutomationProgress(markdown) {
  let total = 0;
  let done = 0;
  const lines = String(markdown || '').split('\n');
  const hasChecklist = lines.some((line) => /^\s*##(?!#)\s+.*progress checklist/i.test(line));
  let inChecklist = !hasChecklist;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*##(?!#)\s+/.test(line)) {
      inChecklist = /^\s*##(?!#)\s+.*progress checklist/i.test(line);
      continue;
    }
    if (!inChecklist) continue;

    const check = line.match(/^\s*[-*]\s+\[([ xX])\]/);
    if (check) {
      total += 1;
      if (check[1].toLowerCase() === 'x') done += 1;
      continue;
    }
    if (!/^\s*\|.+\|\s*$/.test(line)) continue;
    for (const cell of line.split('|').slice(1, -1)) {
      const content = cell.trim();
      if (content === '☐') total += 1;
      if (content === '☑') {
        total += 1;
        done += 1;
      }
    }
  }
  return { done, total };
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath) {
  try {
    const info = await stat(filePath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function latestCodexAutomation(stateData) {
  const records = Array.isArray(stateData.automations) ? stateData.automations : [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.id) return records[index];
  }
  return null;
}

function normalizeCodexActiveRun(value, maxMinutes) {
  if (!value || typeof value !== 'object') return null;
  const automationId = stringOrNull(value.automation_id ?? value.id);
  if (!automationId) return null;

  const now = Date.now();
  const startedMs = Date.parse(value.started_at ?? '');
  const lastSeenMs = Date.parse(value.last_seen_at ?? value.started_at ?? '');
  const expiresMs = Date.parse(value.expires_at ?? '');
  const fallbackTtlMs = Math.max(1, Number(maxMinutes) || 60) * 60_000;
  const expired = Number.isFinite(expiresMs)
    ? now > expiresMs
    : Number.isFinite(lastSeenMs)
      ? now - lastSeenMs > fallbackTtlMs
      : false;

  return {
    status: stringOrNull(value.status) ?? 'running',
    automation_id: automationId,
    thread_id: stringOrNull(value.thread_id),
    session_path: stringOrNull(value.session_path),
    unit_type: stringOrNull(value.unit_type),
    step_id: stringOrNull(value.step_id),
    title: stringOrNull(value.title),
    started_at: stringOrNull(value.started_at),
    last_seen_at: stringOrNull(value.last_seen_at),
    expires_at: stringOrNull(value.expires_at),
    expired,
  };
}

function normalizeCodexPendingAutomation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = stringOrNull(value.id ?? value.automation_id);
  if (!id) return null;

  const status = stringOrNull(value.status)?.toUpperCase() ?? null;
  if (['PAUSED', 'FAILED', 'HALTED', 'COMPLETED', 'CANCELLED', 'ABANDONED'].includes(status)) return null;

  const expectedNext = stringOrNull(value.expected_next);
  return {
    id,
    status: status ?? 'ACTIVE',
    expected_next: expectedNext,
    step_id: stringOrNull(value.step_id) ?? parseStepIdFromExpectedNext(expectedNext),
    unit_type: stringOrNull(value.unit_type) ?? parseCodexExpectedNextType(expectedNext),
    created_at: stringOrNull(value.created_at ?? value.scheduled_at ?? value.next_run_at),
  };
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function buildCodexCurrentUnit({
  currentStepId,
  currentStepData,
  activeRun,
  pendingAutomation,
  latestAutomation,
  lock,
  stateData,
  startedAt,
}) {
  if (currentStepId) {
    return {
      id: currentStepId,
      name: currentStepData?.name ?? activeRun?.title ?? pendingAutomation?.expected_next ?? latestAutomation?.expected_next ?? currentStepId,
      phase: currentStepData?.phase ?? lock?.phase ?? stateData.cursor?.phase ?? null,
      phase_name:
        currentStepData?.phase_name ??
        (lock?.phase || stateData.cursor?.phase
          ? `Phase ${lock?.phase ?? stateData.cursor?.phase}`
          : null),
      started_at: startedAt,
    };
  }

  const unitType = inferCodexUnitType({ activeRun, pendingAutomation, lock, stateData, latestAutomation });
  if (!unitType) return null;

  return {
    id: unitType,
    name: activeRun?.title ?? pendingAutomation?.expected_next ?? codexUnitName(unitType, latestAutomation, stateData),
    phase: lock?.phase ?? stateData.cursor?.phase ?? null,
    phase_name:
      lock?.phase || stateData.cursor?.phase
        ? `Phase ${lock?.phase ?? stateData.cursor?.phase}`
        : null,
    started_at: startedAt,
  };
}

function inferCodexUnitType({ activeRun, pendingAutomation, lock, stateData, latestAutomation }) {
  const candidates = [
    activeRun?.unit_type,
    pendingAutomation?.unit_type,
    lock?.next_type,
    stateData.phase,
    parseCodexExpectedNextType(latestAutomation?.expected_next),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeCodexUnitType(candidate);
    if (normalized && normalized !== 'step' && normalized !== 'active') return normalized;
  }
  return null;
}

function parseCodexExpectedNextType(expectedNext) {
  return typeof expectedNext === 'string' ? expectedNext.trim().split(/\s+/, 1)[0] : null;
}

function parseStepIdFromExpectedNext(expectedNext) {
  if (typeof expectedNext !== 'string') return null;
  const match = expectedNext.match(/\bstep\s+([^\s—-]+)/i);
  return match ? match[1] : null;
}

function normalizeCodexUnitType(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase().replace(/-/g, '_');
  return CODEX_NON_STEP_UNIT_TYPES.has(normalized) ? normalized : null;
}

function codexUnitName(unitType, latestAutomation, stateData) {
  const expectedNext = latestAutomation?.expected_next;
  if (typeof expectedNext === 'string') {
    const [first, ...rest] = expectedNext.trim().split(/\s+/);
    if (normalizeCodexUnitType(first) === unitType && rest.length) {
      return rest.join(' ');
    }
  }
  return stateData.campaign?.title ?? humanizeUnitId(unitType);
}

function humanizeUnitId(value) {
  return String(value)
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

async function readCodexAutomation(automationId) {
  const id = sqlString(automationId);
  return sqliteOne(
    `SELECT id, status, model, reasoning_effort, next_run_at, last_run_at, cwds, rrule, created_at, updated_at FROM automations WHERE id = ${id} LIMIT 1`,
  );
}

async function readCodexAutomationRun(automationId) {
  const id = sqlString(automationId);
  return sqliteOne(
    `SELECT thread_id, automation_id, status, source_cwd, inbox_title, inbox_summary, created_at, updated_at FROM automation_runs WHERE automation_id = ${id} ORDER BY created_at DESC LIMIT 1`,
  );
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function sqliteOne(query) {
  const rows = await sqliteRows(query);
  return rows[0] ?? null;
}

async function sqliteRows(query) {
  if (!(await fileExists(CODEX_DB))) return [];

  const cached = codexSqliteCache.get(query);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  try {
    const { stdout } = await execFileText('sqlite3', ['-json', CODEX_DB, query], {
      timeout: 10_000,
    });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    codexSqliteCache.set(query, {
      rows,
      expiresAt: Date.now() + CODEX_SQLITE_CACHE_TTL_MS,
    });
    return rows;
  } catch (err) {
    console.error('automate-providers: Codex SQLite query failed:', err.message);
    return [];
  }
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function readCodexLock(runDir) {
  const lockPath = path.join(runDir, 'lock');
  let raw;
  let info;
  try {
    [raw, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
  } catch {
    return null;
  }

  let parsed = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    parsed = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) parsed[match[1].trim()] = match[2].trim();
    }
  }

  const startedAt = parsed.started_at || parsed.start_time || null;
  return {
    path: lockPath,
    automation_id: parsed.automation_id ?? null,
    started_at: startedAt,
    step_id: parsed.step_id ? String(parsed.step_id) : null,
    phase: parsed.phase ? String(parsed.phase) : null,
    next_type: parsed.next_type || parsed.parser_next_type || null,
    mtime_ms: info.mtimeMs,
  };
}

function codexMaxStepMinutes(stateData) {
  return (
    stateData.policy?.max_step_minutes ??
    stateData.config?.max_step_minutes ??
    stateData.campaign?.max_step_minutes ??
    60
  );
}

export function deriveCodexRuntime({ stateData, activeRun, pendingAutomation, registry, run, lock, sessionStat, maxMinutes, runDirMissing }) {
  const campaignStatus = stateData.campaign?.status ?? stateData.status ?? null;

  const result = (status, isActive = false) => ({ status, isActive });

  const activeRunLive = activeRun && !activeRun.expired;
  const activeRunStale = activeRun && activeRun.expired;
  const lockStale = isCodexLockStale(lock, maxMinutes);
  const lockFresh = isCodexLockFresh(lock, maxMinutes);
  const sessionIdle = sessionStat ? Date.now() - sessionStat.mtimeMs > CODEX_SESSION_IDLE_MS : false;
  const sessionRecent = sessionStat ? !sessionIdle : false;
  const runInProgress = run?.status === 'IN_PROGRESS';
  const runCreatedMs = Number(run?.created_at);
  const runFresh =
    Number.isFinite(runCreatedMs) && Date.now() - runCreatedMs <= maxMinutes * 60_000;
  const registryActive = registry?.status === 'ACTIVE';
  const registryNextRunMs = Number(registry?.next_run_at);
  const registryQueued =
    registryActive && !runInProgress && Number.isFinite(registryNextRunMs) && registryNextRunMs > Date.now();
  const phaseType = normalizeCodexUnitType(stateData.phase);
  const hasActiveIntent = registryActive || campaignStatus === 'active' || Boolean(phaseType);

  const liveRun = runInProgress && (sessionRecent || lockFresh || runFresh);
  const liveLock = lockFresh && (!sessionStat || sessionRecent);
  const liveActiveRunSession = activeRunStale && sessionRecent;

  if (campaignStatus === 'completed' || campaignStatus === 'complete' || stateData.phase === 'complete') {
    return result('completed');
  }
  if (stateData.abandoned_at) return result('abandoned');

  if (activeRunLive || liveActiveRunSession) {
    return result('active', true);
  }

  if (runDirMissing) return result('failed');
  if (pendingAutomation || registryQueued) {
    return result('queued');
  }
  if (campaignStatus === 'cooldown_deferred') {
    return result('paused');
  }
  if (campaignStatus === 'paused' || stateData.phase === 'paused') {
    return result('paused');
  }
  if (campaignStatus === 'blocked' || stateData.phase === 'blocked' || stateData.blockers?.length) {
    if (lock || runInProgress || hasActiveIntent || lockStale || activeRunStale) return result('stalled');
    return result('failed');
  }
  if (liveRun || liveLock) {
    return result('active', true);
  }
  if (registryQueued) {
    return result('queued');
  }
  if (campaignStatus === 'initialized') {
    return result('idle');
  }
  if (campaignStatus && campaignStatus !== 'active') {
    if (lock || runInProgress || hasActiveIntent || lockStale || activeRunStale) return result('stalled');
    return result(campaignStatus);
  }

  if (lock || runInProgress || hasActiveIntent || lockStale || activeRunStale) {
    return result('stalled');
  }

  return result('idle');
}

function summarizeAutomationAttention(stateData) {
  if (stateData.last_error) {
    return { level: 'current', label: 'Error', title: String(stateData.last_error) };
  }

  const blockers = Array.isArray(stateData.blockers) ? stateData.blockers.filter(Boolean) : [];
  if (blockers.length) {
    return { level: 'current', label: 'Blocked', title: blockers.map(String).join('\n') };
  }

  const history = Array.isArray(stateData.history) ? stateData.history : [];
  const event = [...history].reverse().find(isAttentionHistoryEvent);
  if (!event) return null;

  return {
    level: 'history',
    label: historyAttentionLabel(event),
    title: historyAttentionTitle(event),
  };
}

function isAttentionHistoryEvent(event) {
  if (!event || event.event === 'unblocked') return false;
  return ATTENTION_EVENT_PATTERN.test(`${event.event || ''} ${event.reason_type || ''} ${event.message || ''}`);
}

function historyAttentionLabel(event) {
  if (String(event.event || '').includes('deferred')) return 'Prior deferral';
  if (String(event.reason_type || '').includes('cooldown')) return 'Prior cooldown';
  if (/failed|failure/i.test(event.event || event.message || '')) return 'Prior failure';
  return 'Warning history';
}

function historyAttentionTitle(event) {
  const parts = [event.event, event.reason_type, event.message].filter(Boolean).map(String);
  return parts.join(' · ');
}

function isCodexLockStale(lock, maxMinutes) {
  if (!lock?.started_at) return false;
  const startedMs = Date.parse(lock.started_at);
  if (!Number.isFinite(startedMs)) return false;
  return Date.now() - startedMs > maxMinutes * 60_000;
}

function isCodexLockFresh(lock, maxMinutes) {
  if (!lock?.started_at) return false;
  const startedMs = Date.parse(lock.started_at);
  if (!Number.isFinite(startedMs)) return false;
  return Date.now() - startedMs <= maxMinutes * 60_000;
}

function parseCodexCampaignMarkdown(markdown) {
  const lines = markdown.split('\n');
  const phaseTitles = new Map();
  const checklist = new Map();

  for (const line of lines) {
    const phaseMatch = line.match(/^### Phase\s+(\S+)\s+[—-]\s+(.+)$/);
    if (phaseMatch) {
      phaseTitles.set(phaseMatch[1], phaseMatch[2].trim());
      continue;
    }
    const checkMatch = line.match(/^\s*-\s+\[([ xX])\]\s+Step\s+([^\s]+)\s+[—-]\s+(.+)$/);
    if (checkMatch) {
      checklist.set(checkMatch[2], {
        checked: checkMatch[1].toLowerCase() === 'x',
        name: checkMatch[3].trim(),
      });
    }
  }

  const steps = new Map();
  const stepsList = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].match(/^## Step\s+([^\s]+)\s+[—-]\s+(.+)$/);
    if (!headingMatch) continue;

    const id = headingMatch[1];
    const sectionStart = index + 1;
    let sectionEnd = lines.length;
    for (let cursor = sectionStart; cursor < lines.length; cursor += 1) {
      if (/^## (Step\s+[^\s]+|Final review)\b/.test(lines[cursor])) {
        sectionEnd = cursor;
        break;
      }
    }

    const phase = id.includes('.') ? id.split('.')[0] : null;
    const check = checklist.get(id);
    const step = {
      id,
      name: headingMatch[2].trim() || check?.name || id,
      phase,
      phase_name: phase ? phaseTitles.get(phase) ?? `Phase ${phase}` : null,
      status: check?.checked ? 'done' : 'pending',
      prompt: extractFirstFence(lines.slice(sectionStart, sectionEnd)),
    };
    steps.set(id, step);
    stepsList.push(step);
  }

  return { steps, stepsList };
}

function extractFirstFence(lines) {
  let inFence = false;
  const body = [];
  for (const line of lines) {
    if (!inFence && line.startsWith('```')) {
      inFence = true;
      continue;
    }
    if (inFence && line.startsWith('```')) {
      break;
    }
    if (inFence) body.push(line);
  }
  return body.join('\n').trim() || null;
}

async function enrichCodexStepsWithReceipts(steps, stateData, runDir, { currentStepId, status }) {
  const receipts = Array.isArray(stateData.receipts) ? stateData.receipts : [];
  const receiptPathByStep = new Map(
    receipts
      .filter((receipt) => receipt?.step_id && receipt?.path)
      .map((receipt) => [String(receipt.step_id), receipt.path]),
  );

  return Promise.all(
    steps.map(async (step) => {
      let stepStatus = step.status;
      if (step.id === currentStepId && stepStatus !== 'done') {
        stepStatus = status === 'failed' ? 'failed' : 'running';
      }

      let receipt = null;
      if (stepStatus === 'done') {
        const candidates = [
          receiptPathByStep.get(step.id),
          path.join(runDir, `step-${step.id}-receipt.md`),
          path.join(runDir, 'receipts', `step-${step.id}.md`),
        ].filter(Boolean);
        for (const candidate of candidates) {
          try {
            receipt = await readFile(candidate, 'utf8');
            break;
          } catch {
            /* try the next likely receipt path */
          }
        }
      }

      return { ...step, status: stepStatus, receipt };
    }),
  );
}

async function findCodexSessionJsonl(threadId, createdAtMs) {
  const dirs = codexSessionSearchDirs(createdAtMs);
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const match = entries.find(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId),
    );
    if (match) return path.join(dir, match.name);
  }
  return null;
}

function codexSessionSearchDirs(createdAtMs) {
  const seeds = [];
  if (Number.isFinite(createdAtMs)) seeds.push(createdAtMs);
  seeds.push(Date.now());

  const dirs = new Set();
  for (const seed of seeds) {
    for (const offsetDays of [-1, 0, 1]) {
      const date = new Date(seed + offsetDays * 24 * 60 * 60 * 1000);
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      dirs.add(path.join(CODEX_SESSIONS, year, month, day));
    }
  }
  return [...dirs];
}

async function readFileTail(filePath, maxBytes) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

function parseCodexSessionTail(tailText) {
  if (!tailText) return { log: '', live_activity: null };

  const outputs = [];
  const actions = [];
  const filesTouched = new Set();
  const toolCounts = {};
  let latestText = null;
  let lastEventIso = null;

  for (const line of tailText.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'response_item') continue;

    const payload = event.payload || {};
    lastEventIso = event.timestamp || lastEventIso;
    if (payload.type === 'function_call_output' && typeof payload.output === 'string') {
      outputs.push(payload.output);
    } else if (payload.type === 'function_call') {
      const name = payload.name || '?';
      const input = parseJsonValue(payload.arguments) || {};
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      const summary = summarizeToolUse(name, input);
      if (summary.file) filesTouched.add(summary.file);
      actions.push({ tool: name, label: summary.label, detail: summary.detail });
    } else if (payload.type === 'message' && payload.role === 'assistant') {
      const text = assistantMessageText(payload);
      if (text) latestText = text;
    }
  }

  const log = outputs.slice(-120).join('\n');
  if (!latestText && actions.length === 0) {
    return { log, live_activity: null };
  }

  return {
    log,
    live_activity: {
      latest_text: latestText,
      recent_actions: actions.slice(-8).reverse(),
      effort: {
        tools_called: actions.length,
        files_touched: filesTouched.size,
        bash_commands: (toolCounts.exec_command ?? 0) + (toolCounts.Bash ?? 0),
        edits:
          (toolCounts.apply_patch ?? 0) +
          (toolCounts.Edit ?? 0) +
          (toolCounts.Write ?? 0) +
          (toolCounts.MultiEdit ?? 0),
        tokens_used: null,
        duration_ms: null,
        by_tool: toolCounts,
      },
      last_event_at: lastEventIso,
      is_complete: false,
    },
  };
}

function parseJsonValue(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assistantMessageText(payload) {
  const parts = [];
  for (const block of payload.content || []) {
    if (
      (block.type === 'output_text' || block.type === 'text') &&
      typeof block.text === 'string' &&
      block.text.trim()
    ) {
      parts.push(block.text.trim());
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function buildCodexNudgeModes(status, currentStep, { hasLock = false } = {}) {
  const hasUnit = Boolean(currentStep?.id);
  const isStep = isCodexStepUnitId(currentStep?.id);
  const canRecoverCurrent = hasUnit && (status === 'stalled' || status === 'failed');
  const canContinue = canRecoverCurrent && isStep && hasLock && status === 'stalled';
  const canRestart = canRecoverCurrent && status !== 'failed';
  const canSkip = canRecoverCurrent && isStep && status === 'stalled';
  const canRestartFailed = canRecoverCurrent && status === 'failed';
  const restartLabel = isStep ? 'Restart from scratch' : 'Kickstart this unit';
  return {
    continue: {
      available: canContinue,
      label: 'Continue this step',
      description:
        "Re-launch the step, telling the agent to check what already landed and finish what's left.",
    },
    restart: {
      available: canRestart,
      label: restartLabel,
      description: isStep
        ? 'Run this step again from the beginning.'
        : 'Schedule this automation unit to run again now.',
    },
    skip: {
      available: canSkip,
      label: 'Mark done and continue',
      description: 'Mark this step done and schedule the next automation.',
    },
    restart_failed: {
      available: canRestartFailed,
      label: isStep ? 'Restart failed step' : 'Restart failed unit',
      description: isStep
        ? 'Clear the failure and schedule this step again.'
        : 'Clear the failure and schedule this automation unit again.',
    },
  };
}

function isCodexStepUnitId(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value);
}

function msToIso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

// True if a `claude-automate finalize` is actively working this campaign right now
// (finalize.lock present + its pid alive). The CLI writes the lock for the duration
// of the review+fix loop and removes it on exit; a dead pid (hard-killed finalize)
// reads as not-running, so no stale flag pins the card to "running".
async function isClaudeFinalizeRunning(baseDir) {
  let pid;
  try {
    pid = Number.parseInt((await readFile(path.join(baseDir, 'finalize.lock'), 'utf8')).trim(), 10);
  } catch {
    return false; // no lock → not finalizing
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe; throws ESRCH if the pid is gone
    return true;
  } catch {
    return false;
  }
}

function deriveStatus(stateData, currentStepData, maxMinutes, finalizeRunning = false) {
  if (stateData.abandoned_at) return 'abandoned';
  // A `claude-automate finalize` (review + fix-agent) running RIGHT NOW is real
  // activity, even though the ledger status is still 'completed'/'halted' (it only
  // flips on a verdict). Surface it as active so the card shows running — the
  // claude analogue of Codex's live-lock evidence. `finalizeRunning` comes from a
  // pid-liveness probe of finalize.lock, so a dead/hard-killed finalize reads as
  // not-running and this self-heals.
  if (finalizeRunning) return 'active';
  if (stateData.status === 'completed') return 'completed';
  if (stateData.status !== 'active') return stateData.status;

  if (!currentStepData) return 'idle';
  if (currentStepData.status === 'failed') return 'failed';

  if (currentStepData.status === 'running' && currentStepData.started_at) {
    const elapsed = Date.now() - Date.parse(currentStepData.started_at);
    if (elapsed > maxMinutes * 60_000) return 'stalled';
  }

  return 'active';
}

async function buildFinalizeBlock(finalize) {
  if (!finalize || !finalize.verdict) return null;

  let reviewContent = null;
  if (finalize.review_path) {
    try {
      reviewContent = await readFile(finalize.review_path, 'utf8');
    } catch {
      /* review file may have been deleted — fall back to verdict + reason */
    }
  }

  return {
    verdict: finalize.verdict,
    ran_at: finalize.ran_at ?? null,
    review_path: finalize.review_path ?? null,
    review_content: reviewContent,
    halted_reason: finalize.halted_reason ?? null,
    attempts: Array.isArray(finalize.attempts) ? finalize.attempts.length : 0,
  };
}

function buildFinalizeActions(status, currentStepData, allSteps, finalize) {
  // Three preconditions, all required:
  //   1. The campaign is halted (auto-finalize gave up).
  //   2. There is no current step AND no failed step — meaning step-level
  //      recovery isn't applicable; the halt happened at the finalize stage.
  //   3. The finalize verdict is NEEDS WORK specifically. Other verdicts
  //      (AMBIGUOUS, TIMEOUT, ERROR) halt for different reasons; this UX is
  //      tuned for the "ran out of fix retries" path.
  const lastStep = allSteps.length ? allSteps[allSteps.length - 1] : null;
  const noStepToRecover = !currentStepData && lastStep?.status !== 'failed';
  const finalizeNeedsWork = finalize?.verdict === 'NEEDS WORK';
  const eligible = status === 'halted' && noStepToRecover && finalizeNeedsWork;

  return {
    rerun_finalize: {
      available: eligible,
      label: 'Re-run finalize review',
      description:
        'Spawn another auto-finalize pass. Useful after you’ve manually closed the gaps the last review flagged.',
    },
    view_review: {
      available: eligible && !!finalize?.review_path,
      label: 'View full review',
      description: 'Open the last review’s findings in a modal.',
    },
    mark_abandoned: {
      available: eligible,
      label: 'Mark campaign abandoned',
      description: 'Close this campaign out without running finalize again. The status pill turns neutral.',
    },
  };
}

function buildNudgeModes(status, currentStepData, allSteps) {
  const nudgeRelevant = status === 'stalled' || status === 'halted' || status === 'failed';
  const hasRunningStep = currentStepData?.status === 'running';
  const hasFailedCurrent = currentStepData?.status === 'failed';
  const lastStep = allSteps.length ? allSteps[allSteps.length - 1] : null;
  const lastIsFailedNoRunning = !currentStepData && lastStep?.status === 'failed';

  // Gate availability on (a) the campaign being in a state worth nudging AND
  // (b) the CLI actually having a step it can act on. Without (b), the button
  // shells out to claude-automate which exits with "No running or failed step
  // to recover" — fires a useless toast and confuses the user.
  const allow = (cond) => nudgeRelevant && cond;

  return {
    continue: {
      available: allow(hasRunningStep || hasFailedCurrent),
      label: 'Continue this step',
      description:
        'Re-launch the step, telling the agent to check what already landed and finish what’s left.',
    },
    restart: {
      available: allow(hasRunningStep),
      label: 'Restart from scratch',
      description: 'Wipe this step’s progress and run it again from the beginning.',
    },
    skip: {
      available: allow(hasRunningStep),
      label: 'Mark done and continue',
      description: 'Skip this step and advance to the next one.',
    },
    restart_failed: {
      available: allow(lastIsFailedNoRunning),
      label: 'Restart failed step',
      description: 'Re-run the failed step from scratch.',
    },
  };
}

async function readTimelineEvents(stateData, baseDir) {
  if (stateData.history?.length) {
    return stateData.history;
  }

  try {
    const raw = await readFile(path.join(baseDir, 'timeline.md'), 'utf8');
    return raw
      .split('\n')
      .map((line) => {
        const match =
          line.match(/^- `(.+?)`(?:\s+—)?\s+(.+)$/) ||
          line.match(/^- (\d{4}-\d{2}-\d{2}T\S+)\s+—\s+(.+)$/);
        return match ? { ts: match[1], event: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readCurrentStepLog(currentStepData, baseDir) {
  if (!currentStepData?.id) return null;
  try {
    return await readFile(path.join(baseDir, 'logs', `step-${currentStepData.id}.log`), 'utf8');
  } catch {
    return null;
  }
}

// Parses the stream-json log emitted by `claude --print --output-format stream-json`
// into a compact "what's happening right now" shape for the drawer. Returns
// null when the log is missing or uses the legacy text format (drawer falls
// back to the raw log section in that case).
function parseLiveActivity(logText) {
  if (!logText) return null;

  const events = [];
  for (const line of logText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e === 'object' && e.type) events.push(e);
    } catch {
      /* malformed line — skip silently */
    }
  }

  if (events.length === 0) return null;

  const actions = [];
  const filesTouched = new Set();
  const toolCounts = {};
  let latestText = null;
  let lastEventIso = null;
  let tokensUsed = 0;
  let durationMs = null;
  let isComplete = false;

  for (const e of events) {
    if (e.type === 'assistant') {
      const blocks = e.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) {
          latestText = block.text.trim();
        } else if (block.type === 'tool_use') {
          const name = block.name || '?';
          toolCounts[name] = (toolCounts[name] ?? 0) + 1;
          const summary = summarizeToolUse(name, block.input || {});
          if (summary.file) filesTouched.add(summary.file);
          actions.push({ tool: name, label: summary.label, detail: summary.detail });
        }
      }
    } else if (e.type === 'result') {
      isComplete = true;
      durationMs = e.duration_ms ?? null;
      // modelUsage shape: { "<model>": { inputTokens, outputTokens,
      // cacheReadInputTokens, cacheCreationInputTokens, ... } } — camelCase
      // keys. We count input + output as the "live" number; cache reads dwarf
      // both and would mislead the user about how much actual generation
      // happened.
      const usage = e.modelUsage || {};
      for (const v of Object.values(usage)) {
        tokensUsed += (v?.inputTokens ?? 0) + (v?.outputTokens ?? 0);
      }
    }
    // Track most recent event ISO via uuid timestamps if present; otherwise
    // we rely on log file mtime which the caller already has.
    if (e.timestamp) lastEventIso = e.timestamp;
  }

  // Keep the most recent ~8 actions for the activity chip strip.
  const recentActions = actions.slice(-8).reverse();

  return {
    latest_text: latestText,
    recent_actions: recentActions,
    effort: {
      tools_called: actions.length,
      files_touched: filesTouched.size,
      bash_commands: toolCounts.Bash ?? 0,
      edits: (toolCounts.Edit ?? 0) + (toolCounts.Write ?? 0) + (toolCounts.MultiEdit ?? 0),
      tokens_used: tokensUsed || null,
      duration_ms: durationMs,
      by_tool: toolCounts,
    },
    last_event_at: lastEventIso,
    is_complete: isComplete,
  };
}

function summarizeToolUse(name, input) {
  // Returns { label, detail, file? } — label is the chip text, detail is the
  // hover tooltip, file (if present) feeds the files-touched counter.
  const basename = (p) => (typeof p === 'string' ? p.split('/').pop() : null);
  const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

  switch (name) {
    case 'Read':
      return { label: `Read ${basename(input.file_path) ?? '?'}`, detail: input.file_path, file: input.file_path };
    case 'Edit':
    case 'MultiEdit':
      return { label: `Edit ${basename(input.file_path) ?? '?'}`, detail: input.file_path, file: input.file_path };
    case 'Write':
      return { label: `Write ${basename(input.file_path) ?? '?'}`, detail: input.file_path, file: input.file_path };
    case 'Bash': {
      const cmd = truncate(input.command, 60);
      return { label: `Bash: ${cmd ?? '?'}`, detail: input.description ?? input.command };
    }
    case 'exec_command': {
      const cmd = truncate(input.cmd, 60);
      return { label: `Shell: ${cmd ?? '?'}`, detail: input.cmd };
    }
    case 'apply_patch':
      return { label: 'Edit patch', detail: 'Applied source patch' };
    case 'Glob':
      return { label: `Glob: ${truncate(input.pattern, 40) ?? '?'}`, detail: input.pattern };
    case 'Grep':
      return { label: `Grep: ${truncate(input.pattern, 40) ?? '?'}`, detail: `${input.pattern} in ${input.path ?? '.'}` };
    case 'Task': {
      const sub = input.subagent_type ?? 'agent';
      return { label: `Spawn ${sub}`, detail: input.description };
    }
    case 'TodoWrite':
      return { label: 'Update tasks', detail: `${(input.todos || []).length} items` };
    case 'WebFetch':
      return { label: `WebFetch ${truncate(input.url, 40) ?? '?'}`, detail: input.url };
    case 'WebSearch':
      return { label: `Search: ${truncate(input.query, 40) ?? '?'}`, detail: input.query };
    case 'AskUserQuestion':
      return { label: 'Ask user…', detail: input.questions?.[0]?.question };
    default: {
      // MCP tools like mcp__ghost__ghost_sql — strip the prefix for readability.
      const shortName = name.startsWith('mcp__') ? name.split('__').pop() : name;
      // Pick the first scalar value as the detail.
      const firstVal = Object.values(input).find((v) => typeof v === 'string');
      return { label: shortName, detail: truncate(firstVal ?? '', 80) };
    }
  }
}

async function enrichStepsWithReceipts(steps, baseDir) {
  return Promise.all(
    steps.map(async (step) => {
      const { receipt_path, log_path, ...rest } = step;
      let receipt = null;
      if (step.status === 'done') {
        try {
          receipt = await readFile(
            path.join(baseDir, 'receipts', `step-${step.id}.md`),
            'utf8',
          );
        } catch {
          /* receipt not written yet */
        }
      }
      return { ...rest, receipt };
    }),
  );
}

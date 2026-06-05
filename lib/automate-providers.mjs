import { execFile, spawn } from 'node:child_process';
import { open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const AUTOMATE_BASE = path.join(homedir(), '.claude-automate', 'campaigns');
const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), '.codex');
const CODEX_DB = path.join(CODEX_HOME, 'sqlite', 'codex-dev.db');
const CODEX_SESSIONS = path.join(CODEX_HOME, 'sessions');
const CODEX_RECOVER_SCRIPT = path.join(
  homedir(),
  'Dev',
  'skills',
  'campaign-automate',
  'scripts',
  'campaign_recover.py',
);
const CODEX_STATE_CACHE_TTL_MS = 60_000;
const CODEX_SQLITE_CACHE_TTL_MS = 5_000;
const CODEX_SESSION_TAIL_BYTES = 200_000;
const CODEX_SESSION_IDLE_MS = 15 * 60_000;
const CODEX_NON_STEP_UNIT_TYPES = new Set([
  'final_review',
  'final_rework',
  'step_review',
  'step_rework',
  'phase_review',
]);

// Order matters: Claude is the older and more common backend. If both systems
// point at the same campaign markdown, Claude wins and we log a one-line hint.
const providers = [claudeProvider(), codexProvider()];
const providerOverlapWarnings = new Set();
const codexStatePathCache = new Map();
const codexSqliteCache = new Map();

export async function getAutomateState(filePath, { summary = false } = {}) {
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const state = await provider.getState(filePath, { summary });
    if (state) {
      if (!summary) {
        await warnIfProviderOverlap(provider, providers.slice(index + 1), filePath);
      }
      return state;
    }
  }
  return null;
}

export async function nudgeAutomateState(filePath, mode) {
  for (const provider of providers) {
    if (await provider.detect(filePath)) {
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

function codexProvider() {
  return {
    name: 'codex',
    detect: hasCodexState,
    nudge: nudgeCodexAutomateState,
    async getState(filePath, { summary = false } = {}) {
      const statePath = await findCodexStatePath(filePath);
      if (!statePath) return null;

      let stateData;
      try {
        stateData = await readJsonFile(statePath);
      } catch (err) {
        console.error(`automate-providers: bad Codex state.json for ${filePath}:`, err.message);
        return null;
      }

      const runDir = path.resolve(stateData.campaign?.run_dir || path.dirname(statePath));
      const runDirMissing = !(await isDirectory(runDir));
      const lock = runDirMissing ? null : await readCodexLock(runDir);
      const latestAutomation = latestCodexAutomation(stateData);
      const [registry, run] = await Promise.all([
        latestAutomation?.id ? readCodexAutomation(latestAutomation.id) : null,
        latestAutomation?.id ? readCodexAutomationRun(latestAutomation.id) : null,
      ]);
      const sessionPath = run?.thread_id
        ? await findCodexSessionJsonl(run.thread_id, run.created_at)
        : null;
      const sessionStat = sessionPath ? await safeStat(sessionPath) : null;
      const maxMinutes = codexMaxStepMinutes(stateData);
      const runtime = deriveCodexRuntime({
        stateData,
        registry,
        run,
        lock,
        sessionStat,
        maxMinutes,
        runDirMissing,
      });
      const status = runtime.status;

      const markdown = await readFile(filePath, 'utf8').catch(() => '');
      const campaignMap = parseCodexCampaignMarkdown(markdown);
      const currentStepId = lock?.step_id ?? stateData.cursor?.step_id ?? null;
      const currentStepData = currentStepId ? campaignMap.steps.get(currentStepId) ?? null : null;
      const startedAt = lock?.started_at ?? msToIso(run?.created_at) ?? null;
      const currentStep = buildCodexCurrentUnit({
        currentStepId,
        currentStepData,
        latestAutomation,
        lock,
        stateData,
        startedAt,
      });

      if (summary) {
        return {
          backend: 'codex',
          is_active: runtime.isActive,
          status,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
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
        is_active: runtime.isActive,
        status,
        started_at: stateData.campaign?.created_at ?? null,
        current_step: currentStep,
        max_step_minutes: maxMinutes,
        steps,
        timeline_events: timelineEvents,
        current_step_log: sessionActivity.log,
        live_activity: sessionActivity.live_activity,
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
    async detect(filePath) {
      const slug = path.basename(filePath, '.md');
      try {
        await readFile(path.join(AUTOMATE_BASE, slug, 'state.json'), 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    nudge: nudgeClaudeAutomateState,
    async getState(filePath, { summary = false } = {}) {
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

      const currentStepData = stateData.current_step_id
        ? stateData.steps?.find((s) => s.id === stateData.current_step_id) ?? null
        : null;

      const maxMinutes = stateData.config?.max_step_minutes ?? 60;
      const status = deriveStatus(stateData, currentStepData, maxMinutes);

      const currentStep = currentStepData
        ? {
            id: currentStepData.id,
            name: currentStepData.name,
            phase: currentStepData.phase,
            phase_name: currentStepData.phase_name,
            started_at: currentStepData.started_at,
          }
        : null;

      if (summary) {
        return {
          backend: 'claude',
          status,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
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
        is_active: status === 'active' || status === 'stalled',
        status,
        started_at: stateData.created_at,
        current_step: currentStep,
        max_step_minutes: maxMinutes,
        steps,
        timeline_events: timelineEvents,
        current_step_log: currentStepLog,
        live_activity: parseLiveActivity(currentStepLog),
        nudge_modes: buildNudgeModes(status, currentStepData, allSteps),
        finalize,
        finalize_actions: buildFinalizeActions(status, currentStepData, allSteps, finalize),
      };
    },
  };
}

async function hasCodexState(filePath) {
  return Boolean(await findCodexStatePath(filePath));
}

async function findCodexStatePath(filePath) {
  const markdownPath = path.resolve(filePath);
  const slug = path.basename(markdownPath, '.md');
  const repoDir = path.resolve(path.dirname(markdownPath), '..');
  const cacheKey = `${repoDir}:${slug}:${markdownPath}`;
  const cached = codexStatePathCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.statePath;
  }

  const statePath = path.join(repoDir, 'reports', 'campaign-automation', slug, 'state.json');
  let match = null;
  try {
    const stateData = await readJsonFile(statePath);
    const campaignPath = stateData.campaign?.campaign_path;
    if (campaignPath && (await sameResolvedPath(markdownPath, campaignPath))) {
      match = statePath;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`automate-providers: bad Codex state candidate ${statePath}:`, err.message);
    }
  }

  codexStatePathCache.set(cacheKey, {
    statePath: match,
    expiresAt: Date.now() + CODEX_STATE_CACHE_TTL_MS,
  });
  return match;
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
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
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

function buildCodexCurrentUnit({
  currentStepId,
  currentStepData,
  latestAutomation,
  lock,
  stateData,
  startedAt,
}) {
  if (currentStepId) {
    return {
      id: currentStepId,
      name: currentStepData?.name ?? latestAutomation?.expected_next ?? currentStepId,
      phase: currentStepData?.phase ?? lock?.phase ?? stateData.cursor?.phase ?? null,
      phase_name:
        currentStepData?.phase_name ??
        (lock?.phase || stateData.cursor?.phase
          ? `Phase ${lock?.phase ?? stateData.cursor?.phase}`
          : null),
      started_at: startedAt,
    };
  }

  const unitType = inferCodexUnitType({ lock, stateData, latestAutomation });
  if (!unitType) return null;

  return {
    id: unitType,
    name: codexUnitName(unitType, latestAutomation, stateData),
    phase: lock?.phase ?? stateData.cursor?.phase ?? null,
    phase_name:
      lock?.phase || stateData.cursor?.phase
        ? `Phase ${lock?.phase ?? stateData.cursor?.phase}`
        : null,
    started_at: startedAt,
  };
}

function inferCodexUnitType({ lock, stateData, latestAutomation }) {
  const candidates = [
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

function deriveCodexRuntime({ stateData, registry, run, lock, sessionStat, maxMinutes, runDirMissing }) {
  const campaignStatus = stateData.campaign?.status ?? stateData.status ?? null;

  const result = (status, isActive = false) => ({ status, isActive });

  const lockStale = isCodexLockStale(lock, maxMinutes);
  const lockFresh = isCodexLockFresh(lock, maxMinutes);
  const sessionIdle = sessionStat ? Date.now() - sessionStat.mtimeMs > CODEX_SESSION_IDLE_MS : false;
  const sessionRecent = sessionStat ? !sessionIdle : false;
  const runInProgress = run?.status === 'IN_PROGRESS';
  const runCreatedMs = Number(run?.created_at);
  const runFresh =
    Number.isFinite(runCreatedMs) && Date.now() - runCreatedMs <= maxMinutes * 60_000;
  const registryActive = registry?.status === 'ACTIVE';
  const phaseType = normalizeCodexUnitType(stateData.phase);
  const hasActiveIntent = registryActive || campaignStatus === 'active' || stateData.phase === 'step' || Boolean(phaseType);

  const liveRun = runInProgress && (sessionRecent || lockFresh || runFresh);
  const liveLock = lockFresh && (!sessionStat || sessionRecent);

  if (campaignStatus === 'completed' || campaignStatus === 'complete' || stateData.phase === 'complete') {
    return result('completed');
  }
  if (stateData.abandoned_at) return result('abandoned');

  // Scheduler/session evidence answers "is anything running right now?" better
  // than the state ledger. A launch-proof helper can mark a campaign blocked
  // while the spawned Codex worker is still active; keep that visible instead of
  // hiding the spinner behind stale bookkeeping.
  if (liveRun || liveLock) {
    return result('active', true);
  }

  if (runDirMissing) return result('failed');
  if (campaignStatus === 'blocked' || stateData.phase === 'blocked' || stateData.blockers?.length) {
    if (lock || runInProgress || hasActiveIntent || lockStale) return result('stalled');
    return result('failed');
  }
  if (campaignStatus && campaignStatus !== 'active') {
    if (lock || runInProgress || hasActiveIntent || lockStale) return result('stalled');
    return result(campaignStatus);
  }

  if (lock || runInProgress || hasActiveIntent || lockStale) {
    return result('stalled');
  }

  return result('idle');
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

function deriveStatus(stateData, currentStepData, maxMinutes) {
  if (stateData.abandoned_at) return 'abandoned';
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

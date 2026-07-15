import { execFile } from 'node:child_process';
import { readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { getAutomateStates, getEngineRunLedger } from './automate-providers.mjs';
import { CampaignStopError, requestCampaignStop } from './pump.mjs';
import { readRunState } from './run-state-store.mjs';

const execFileAsync = promisify(execFile);
const SIZE_CACHE_TTL_MS = 30_000;
const STOP_EXIT_TIMEOUT_MS = 12_000;
const HELD_STATUSES = new Set([
  'queued',
  'scheduled',
  'paused',
  'blocked',
  'awaiting_human_review',
  'cap_reached',
]);

const sizeCache = new Map();

export class WorktreeOperationError extends Error {
  constructor(message, { statusCode = 409, code = 'worktree_refused', confirmationRequired = false } = {}) {
    super(message);
    this.name = 'WorktreeOperationError';
    this.statusCode = statusCode;
    this.code = code;
    this.confirmationRequired = confirmationRequired;
  }
}

export async function discoverWorktrees(registryCampaigns, options = {}) {
  const campaigns = Array.isArray(registryCampaigns) ? registryCampaigns : [];
  const [repositories, owners, activeCwds] = await Promise.all([
    discoverRepositories(campaigns),
    discoverOwners(campaigns),
    listActiveProcessCwds(),
  ]);
  const serverCwd = await canonicalPath(options.cwd ?? process.cwd());
  const rows = [];
  const seenPaths = new Set();

  for (const repository of repositories) {
    const listed = await git(repository.root, ['worktree', 'list', '--porcelain']);
    const records = parseWorktreePorcelain(listed.stdout);
    const primaryPath = records[0]?.path ?? repository.root;

    for (const record of records) {
      const worktreePath = await canonicalPath(record.path);
      const key = pathKey(worktreePath);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);

      const primary = pathKey(primaryPath) === key;
      const owner = owners.get(key) ?? externalOwner();
      const liveExternalCwd = isSameOrInside(serverCwd, worktreePath) || activeCwds.some(
        (cwd) => isSameOrInside(cwd, worktreePath),
      );
      const status = worktreeStatus({ primary, locked: record.locked, owner, liveExternalCwd });
      const [size, touched] = await Promise.all([
        primary ? Promise.resolve({ sizeBytes: null, cached: false }) : worktreeSize(worktreePath),
        stat(worktreePath).catch(() => null),
      ]);
      const liveEngine = status === 'live' && owner.backend === 'engine';

      rows.push({
        path: worktreePath,
        branch: record.branch,
        head: record.head,
        detached: record.detached,
        locked: record.locked,
        lock_reason: record.lockReason,
        primary,
        repo_root: await canonicalPath(primaryPath),
        repo_name: path.basename(primaryPath),
        owner,
        status,
        size_bytes: size.sizeBytes,
        size_cached: size.cached,
        last_touched_at: touched ? touched.mtime.toISOString() : null,
        deletable: status === 'orphan' || status === 'external' || liveEngine,
        confirmation_required: liveEngine,
      });
    }
  }

  return rows.sort((left, right) =>
    left.repo_name.localeCompare(right.repo_name) || left.path.localeCompare(right.path));
}

export async function removeWorktree(registryCampaigns, worktreePath, { confirm = false } = {}) {
  const target = await canonicalPath(worktreePath);
  let row = (await discoverWorktrees(registryCampaigns)).find(
    (candidate) => pathKey(candidate.path) === pathKey(target),
  );
  if (!row) {
    throw new WorktreeOperationError('Worktree not found.', { statusCode: 404, code: 'not_found' });
  }

  assertSingleRemovalAllowed(row, confirm);

  if (row.status === 'live') {
    try {
      await requestCampaignStop(row.owner.campaign_path, { waitTimeoutMs: STOP_EXIT_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof CampaignStopError) || !/not active/.test(error.message)) throw error;
    }
    await waitForEngineExit(row.owner, STOP_EXIT_TIMEOUT_MS);

    const refreshed = await listRepositoryWorktrees(row.repo_root);
    row = refreshed.find((candidate) => pathKey(candidate.path) === pathKey(target)) ?? null;
    if (!row) {
      sizeCache.delete(pathKey(target));
      return { ok: true, removed: target, stopped: true };
    }
    if (row.locked) {
      throw new WorktreeOperationError('The stopped run still holds a Git worktree lock.', {
        code: 'locked',
      });
    }
  }

  await removeGitWorktree(row.repo_root, target);
  sizeCache.delete(pathKey(target));
  return { ok: true, removed: target, stopped: row.owner.backend === 'engine' };
}

export async function cleanupOrphanWorktrees(registryCampaigns, { paths = null } = {}) {
  const rows = await discoverWorktrees(registryCampaigns);
  const requested = Array.isArray(paths) && paths.length > 0
    ? new Set(await Promise.all(paths.map(async (value) => pathKey(await canonicalPath(value)))))
    : null;
  const candidates = requested
    ? rows.filter((row) => requested.has(pathKey(row.path)))
    : rows.filter((row) => row.status === 'orphan');
  const found = new Set(candidates.map((row) => pathKey(row.path)));
  const removed = [];
  const skipped = [];
  const pruneRoots = new Set();

  if (requested) {
    for (const requestedPath of requested) {
      if (!found.has(requestedPath)) skipped.push({ path: requestedPath, reason: 'not found' });
    }
  }

  for (const row of candidates) {
    if (row.primary) {
      skipped.push({ path: row.path, reason: 'primary worktree' });
      continue;
    }
    if (row.locked || row.status === 'live') {
      skipped.push({ path: row.path, reason: row.locked ? 'locked worktree' : 'live worktree' });
      continue;
    }
    if (row.status !== 'orphan') {
      skipped.push({ path: row.path, reason: `${row.status} worktree` });
      continue;
    }
    if (await worktreeHasActiveCwd(row.path)) {
      skipped.push({ path: row.path, reason: 'live worktree' });
      continue;
    }
    try {
      await git(row.repo_root, ['worktree', 'remove', row.path]);
      removed.push(row.path);
      pruneRoots.add(row.repo_root);
      sizeCache.delete(pathKey(row.path));
    } catch (error) {
      skipped.push({ path: row.path, reason: error.message });
    }
  }

  await Promise.all([...pruneRoots].map((repoRoot) =>
    git(repoRoot, ['worktree', 'prune']).catch(() => null)));
  return { ok: true, removed, skipped };
}

export function parseWorktreePorcelain(output) {
  return String(output || '')
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((record) => {
      const lines = record.split('\n');
      const branchRef = valueAfter(lines, 'branch ');
      const lockedLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
      return {
        path: valueAfter(lines, 'worktree '),
        head: valueAfter(lines, 'HEAD ') || null,
        branch: branchRef?.replace(/^refs\/heads\//, '') || null,
        detached: lines.includes('detached'),
        locked: Boolean(lockedLine),
        lockReason: lockedLine?.slice('locked'.length).trim() || null,
      };
    })
    .filter((record) => record.path);
}

async function discoverRepositories(campaigns) {
  const repositories = new Map();
  for (const campaign of campaigns) {
    if (typeof campaign?.filePath !== 'string') continue;
    const cwd = path.dirname(path.resolve(campaign.filePath));
    try {
      const [rootResult, commonResult] = await Promise.all([
        git(cwd, ['rev-parse', '--show-toplevel']),
        git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ]);
      const root = await canonicalPath(rootResult.stdout.trim());
      const common = await canonicalPath(commonResult.stdout.trim());
      if (!repositories.has(pathKey(common))) repositories.set(pathKey(common), { root, common });
    } catch {
      // A missing campaign checkout or non-Git folder is outside this panel's v1 scope.
    }
  }
  return [...repositories.values()];
}

async function discoverOwners(campaigns) {
  const owners = new Map();
  await Promise.all(campaigns.map(async (campaign) => {
    if (typeof campaign?.filePath !== 'string') return;
    let states;
    try {
      states = await getAutomateStates(campaign.filePath, {
        summary: true,
        registryId: campaign.id ?? null,
      });
    } catch {
      return;
    }
    await Promise.all(states.map(async (state) => {
      if (state.execution?.kind !== 'worktree' || !state.execution.path) return;
      const executionPath = await canonicalPath(state.execution.path);
      const owner = {
        backend: state.backend,
        run_id: state.run_id ?? null,
        campaign_id: campaign.id ?? null,
        campaign_path: campaign.filePath,
        campaign_name: path.basename(campaign.filePath, path.extname(campaign.filePath)),
        status: state.status ?? 'unknown',
        live: state.is_active === true,
        run_dir: null,
        worker_pid: null,
      };
      if (state.backend === 'engine') {
        const ledger = await getEngineRunLedger(campaign.filePath, campaign.id ?? null).catch(() => null);
        owner.run_dir = ledger?.artifacts?.run_dir ?? null;
        owner.worker_pid = ledger?.worker?.pid ?? null;
      }
      const key = pathKey(executionPath);
      const existing = owners.get(key);
      if (!existing || ownerRank(owner) > ownerRank(existing)) owners.set(key, owner);
    }));
  }));
  return owners;
}

function ownerRank(owner) {
  return (owner.live ? 10 : 0) + ({ engine: 3, claude: 2, codex: 1 }[owner.backend] ?? 0);
}

function externalOwner() {
  return {
    backend: 'external',
    run_id: null,
    campaign_id: null,
    campaign_path: null,
    campaign_name: null,
    status: 'unknown',
    live: false,
    run_dir: null,
    worker_pid: null,
  };
}

function worktreeStatus({ primary, locked, owner, liveExternalCwd }) {
  if (primary) return 'primary';
  if (liveExternalCwd || owner.live) return 'live';
  if (locked) return 'locked';
  if (owner.backend === 'external') return 'external';
  if (HELD_STATUSES.has(owner.status)) return 'held';
  return 'orphan';
}

function assertSingleRemovalAllowed(row, confirm) {
  if (row.primary) {
    throw new WorktreeOperationError('The primary worktree cannot be removed.', { code: 'primary' });
  }
  if (row.locked || row.status === 'locked') {
    throw new WorktreeOperationError('Locked worktrees cannot be removed.', { code: 'locked' });
  }
  if (row.status === 'held') {
    throw new WorktreeOperationError('This worktree belongs to a paused or recoverable run.', { code: 'held' });
  }
  if (row.status !== 'live') return;
  if (row.owner.backend !== 'engine') {
    throw new WorktreeOperationError('This worktree is live outside the Campaigns engine and has no safe stop owner.', {
      code: 'external_live',
    });
  }
  if (!confirm) {
    throw new WorktreeOperationError('Stop the live Campaigns run before removing its worktree?', {
      code: 'confirmation_required',
      confirmationRequired: true,
    });
  }
}

async function waitForEngineExit(owner, timeoutMs) {
  if (!owner.run_dir) {
    throw new WorktreeOperationError('The engine run has no persisted run directory.', { code: 'missing_run_state' });
  }
  const statePath = path.join(owner.run_dir, 'state.json');
  const lockPath = path.join(owner.run_dir, 'run.lock');
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const [state, lock] = await Promise.all([
      readRunState(statePath).catch(() => null),
      readJson(lockPath),
    ]);
    const workerPid = state?.worker?.pid ?? owner.worker_pid;
    const lockExists = lock !== null;
    if (!lockExists && !isProcessAlive(workerPid)) return;
    await delay(40);
  }
  throw new WorktreeOperationError('The engine worker or run lock did not exit before the removal timeout.', {
    code: 'stop_timeout',
  });
}

async function listRepositoryWorktrees(repoRoot) {
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(listed.stdout);
}

async function removeGitWorktree(repoRoot, worktreePath) {
  if (await worktreeHasActiveCwd(worktreePath)) {
    throw new WorktreeOperationError('This worktree is the current directory of a live process.', {
      code: 'external_live',
    });
  }
  try {
    await git(repoRoot, ['worktree', 'remove', worktreePath]);
    await git(repoRoot, ['worktree', 'prune']);
  } catch (error) {
    throw new WorktreeOperationError(error.message, { code: 'git_refused' });
  }
}

async function worktreeHasActiveCwd(worktreePath) {
  const activeCwds = await listActiveProcessCwds();
  return activeCwds.some((cwd) => isSameOrInside(cwd, worktreePath));
}

async function listActiveProcessCwds() {
  if (process.platform === 'linux') {
    try {
      const entries = await readdir('/proc', { withFileTypes: true });
      const values = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => readlink(path.join('/proc', entry.name, 'cwd')).catch(() => null)));
      return values.filter(Boolean).map((value) => path.resolve(value.replace(/ \(deleted\)$/, '')));
    } catch {
      return [path.resolve(process.cwd())];
    }
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-Fn', '-a', '-d', 'cwd'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout)
      .split('\n')
      .filter((line) => line.startsWith('n/'))
      .map((line) => path.resolve(line.slice(1)));
  } catch {
    return [path.resolve(process.cwd())];
  }
}

async function worktreeSize(worktreePath) {
  const key = pathKey(worktreePath);
  const cached = sizeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { sizeBytes: await cached.promise, cached: true };
  }

  const promise = execFileAsync('du', ['-sk', worktreePath], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  }).then(({ stdout }) => {
    const kilobytes = Number.parseInt(String(stdout).trim().split(/\s+/)[0], 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  }).catch(() => null);
  sizeCache.set(key, { expiresAt: Date.now() + SIZE_CACHE_TTL_MS, promise });
  return { sizeBytes: await promise, cached: false };
}

async function git(cwd, args) {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || 'Git command failed.');
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
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

async function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function pathKey(value) {
  return path.resolve(value).normalize('NFC');
}

function isSameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function valueAfter(lines, prefix) {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

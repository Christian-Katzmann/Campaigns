import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  approveCampaignHumanReview,
  runCampaign,
  runPathsForCampaign,
  sweepExpiredExecutionWorktree,
} from '../lib/pump.mjs';
import { recoverCampaign } from '../lib/recovery.mjs';
import { foldRunJournal, readRunJournal } from '../lib/run-journal.mjs';
import {
  createRunState,
  transitionRunState,
  validateRunState,
} from '../lib/run-state.mjs';

const execFileAsync = promisify(execFile);
const silent = { write() {} };
const deadPid = 2_000_000_000;

test('campaigns recover releases a stale lock and leaves a resumable ledger', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture);
  await writeDeadLock(paths.lockPath, fixture.campaignPath);

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('bin/campaigns.mjs'),
    'recover',
    fixture.campaignPath,
    '--state-dir',
    fixture.runsDir,
  ]);

  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.match(stdout, /Recovered campaign; run is running/);
  assert.equal(state.run.status, 'running');
  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.deepEqual(state.history.slice(-3).map((entry) => entry.event), [
    'recovery_started',
    'stale_lock_released',
    'recovery_completed',
  ]);
  assert.deepEqual(foldRunJournal(await readRunJournal(paths.journalPath)).state, state);
  await assert.rejects(access(paths.lockPath), { code: 'ENOENT' });
});

test('recovery refuses to touch a lock owned by a live process', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture);
  await writeFile(paths.lockPath, `${JSON.stringify({
    version: 1,
    token: 'live-token',
    pid: process.pid,
    campaign_path: fixture.campaignPath,
  })}\n`, 'utf8');

  await assert.rejects(
    recoverCampaign(fixture.campaignPath, { runsDir: fixture.runsDir }),
    /Run is still active.*recovery made no changes/,
  );
  await access(paths.lockPath);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(state.history.at(-1).event, 'run_started');
});

test('a dead running worker is failed with salvaged output, reset, and resumes on next run', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture, { runningStep: true });
  const logPath = path.join(paths.logsDir, '1.1-1.log');
  await writeFile(
    logPath,
    'useful worker output before the process disappeared AUTH_SECRET=recovery-secret\n',
    'utf8',
  );
  const original = JSON.parse(await readFile(paths.statePath, 'utf8'));
  original.worker.log_path = logPath;
  await writeFile(paths.statePath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
  await writeDeadLock(paths.lockPath, fixture.campaignPath);

  const recovered = await recoverCampaign(fixture.campaignPath, { runsDir: fixture.runsDir });
  const repaired = JSON.parse(await readFile(paths.statePath, 'utf8'));
  const failedEvent = repaired.history.find((entry) => entry.event === 'step_failed');

  assert.deepEqual(recovered.actions, [
    'failed_dead_worker_with_salvage',
    'released_stale_lock',
    'reset_step',
  ]);
  assert.equal(repaired.run.status, 'running');
  assert.equal(repaired.steps[0].status, 'pending');
  assert.equal(repaired.steps[0].attempt, 1);
  assert.match(failedEvent.details.failure.output_tail, /useful worker output/);
  assert.doesNotMatch(JSON.stringify(repaired), /recovery-secret/);
  assert.doesNotMatch(await readFile(logPath, 'utf8'), /recovery-secret/);
  assert.deepEqual(repaired.history.slice(-5).map((entry) => entry.event), [
    'step_failed',
    'recovery_started',
    'stale_lock_released',
    'step_reset_by_recover',
    'recovery_completed',
  ]);

  const resumed = await runCampaign(fixture.campaignPath, fixture.runOptions);
  assert.equal(resumed.state.run.status, 'completed');
  assert.equal(resumed.state.steps[0].status, 'completed');
  assert.equal(resumed.state.steps[0].attempt, 2);
});

test('campaigns stop records stopped_by_user through the CLI', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture);

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('bin/campaigns.mjs'),
    'stop',
    fixture.campaignPath,
    '--state-dir',
    fixture.runsDir,
  ]);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));

  assert.match(stdout, /Campaign stopped/);
  assert.equal(state.run.status, 'stopped_by_user');
  assert.equal(state.history.at(-1).event, 'stopped_by_user');
});

test('POST /api/run/recover applies the same recovery over the loopback server', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture);
  await writeDeadLock(paths.lockPath, fixture.campaignPath);
  const registryDir = path.join(fixture.root, 'registry');
  await mkdir(registryDir, { recursive: true });
  await writeFile(path.join(registryDir, 'registry.json'), `${JSON.stringify({
    campaigns: [{ id: 'fixture-campaign', filePath: fixture.campaignPath }],
  }, null, 2)}\n`, 'utf8');

  const child = fixture.trackChild(spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: fixture.runsDir,
      CAMPAIGNS_PORT_FILE: path.join(fixture.root, 'server.port'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const port = await waitForServerPort(child);

  const response = await fetch(`http://127.0.0.1:${port}/api/run/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture-campaign' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'running');
  assert.ok(payload.actions.includes('released_stale_lock'));
  await assert.rejects(access(paths.lockPath), { code: 'ENOENT' });
});

test('POST /api/run/stop records the explicit user-stop status', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeRunningState(fixture);
  const registryDir = path.join(fixture.root, 'registry');
  await mkdir(registryDir, { recursive: true });
  await writeFile(path.join(registryDir, 'registry.json'), `${JSON.stringify({
    campaigns: [{ id: 'fixture-campaign', filePath: fixture.campaignPath }],
  }, null, 2)}\n`, 'utf8');

  const child = fixture.trackChild(spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: fixture.runsDir,
      CAMPAIGNS_PORT_FILE: path.join(fixture.root, 'server.port'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const port = await waitForServerPort(child);

  const response = await fetch(`http://127.0.0.1:${port}/api/run/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture-campaign' }),
  });
  const payload = await response.json();
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'stopped_by_user');
  assert.equal(state.run.status, 'stopped_by_user');
  assert.equal(state.history.at(-1).event, 'stopped_by_user');
});

test('human review approval is single-use and limited to reviewer_unavailable', async (t) => {
  const allowed = await makeFixture(t);
  const allowedPaths = await writeAwaitingHumanReviewState(allowed, 'reviewer_unavailable');
  const approved = await approveCampaignHumanReview(allowed.campaignPath, {
    runsDir: allowed.runsDir,
    runId: 'recovery-fixture-run',
  });

  assert.equal(approved.state.run.status, 'completed');
  assert.equal(approved.state.history.at(-1).event, 'human_review_approved');
  assert.deepEqual(approved.state.history.at(-1).details, {
    approved_by: 'human',
    approved_via: 'api',
    cause: 'reviewer_unavailable',
    verdict: 'APPROVED',
    reasons: [],
    raw_tags: [],
    findings: [],
    review_path: null,
  });
  await assert.rejects(
    approveCampaignHumanReview(allowed.campaignPath, {
      runsDir: allowed.runsDir,
      runId: 'recovery-fixture-run',
    }),
    /not awaiting human review/,
  );
  assert.equal(JSON.parse(await readFile(allowedPaths.statePath, 'utf8')).run.status, 'completed');

  for (const cause of ['review_unparseable', 'review_fix_attempts_exhausted', 'review_merge_failed']) {
    const rejected = await makeFixture(t);
    await writeAwaitingHumanReviewState(rejected, cause);
    await assert.rejects(
      approveCampaignHumanReview(rejected.campaignPath, {
        runsDir: rejected.runsDir,
        runId: 'recovery-fixture-run',
      }),
      new RegExp(cause),
    );
  }
});

test('human approval reuses the normal worktree finalize and merge path', async (t) => {
  const fixture = await makeFixture(t);
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  config.review.reviewer = 'missing-reviewer';
  await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const mainBefore = await git(fixture.repo, ['rev-parse', 'main']);
  const waiting = await runCampaign(fixture.campaignPath, {
    ...fixture.runOptions,
    noWorktree: false,
  });

  assert.equal(waiting.state.run.status, 'awaiting_human_review');
  assert.equal(waiting.state.history.at(-1).event, 'reviewer_unavailable');
  const approved = await approveCampaignHumanReview(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    runId: waiting.state.run.id,
  });

  assert.equal(approved.state.run.status, 'completed');
  assert.equal(approved.merge.reason, 'source_is_target');
  assert.ok(approved.merge.execution_branch);
  assert.notEqual(await git(fixture.repo, ['rev-parse', 'main']), mainBefore);
  assert.match(await readFile(fixture.campaignPath, 'utf8'), /- \[x\] Step 1\.1/);
  assert.ok(approved.state.artifacts.worktree.pruned_at);
});

test('POST /api/run/approve-review records approval and rejects a second tap', async (t) => {
  const fixture = await makeFixture(t);
  const paths = await writeAwaitingHumanReviewState(fixture, 'reviewer_unavailable');
  const registryDir = path.join(fixture.root, 'registry');
  await mkdir(registryDir, { recursive: true });
  await writeFile(path.join(registryDir, 'registry.json'), `${JSON.stringify({
    campaigns: [{ id: 'fixture-campaign', filePath: fixture.campaignPath }],
  }, null, 2)}\n`, 'utf8');

  const child = fixture.trackChild(spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: fixture.runsDir,
      CAMPAIGNS_PORT_FILE: path.join(fixture.root, 'server.port'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const port = await waitForServerPort(child);
  const request = () => fetch(`http://127.0.0.1:${port}/api/run/approve-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture-campaign', runId: 'recovery-fixture-run' }),
  });

  const approved = await request();
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), {
    ok: true,
    status: 'completed',
    event: 'human_review_approved',
  });
  const repeated = await request();
  assert.equal(repeated.status, 409);
  assert.match((await repeated.json()).error, /not awaiting human review/);
  assert.equal(JSON.parse(await readFile(paths.statePath, 'utf8')).history.at(-1).event, 'human_review_approved');
});

test('awaiting-human cleanup holds until its deadline, then prunes and retains the branch', async (t) => {
  const now = Date.parse('2026-07-15T12:00:00.000Z');
  const fixture = await makeFixture(t, { reviewOutput: 'missing verdict' });
  const result = await runCampaign(fixture.campaignPath, {
    ...fixture.runOptions,
    noWorktree: false,
    now,
    awaitingHumanCleanupMs: 1_000,
  });
  const branch = result.state.artifacts.worktree.branch;
  const worktreePath = result.state.artifacts.worktree.path;

  assert.equal(result.state.run.status, 'awaiting_human_review');
  assert.equal(result.state.artifacts.worktree.cleanup_deadline, '2026-07-15T12:00:01.000Z');
  await sweepExpiredExecutionWorktree(result.state, result.statePath, { now: now + 999 });
  assert.match(await git(fixture.repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(worktreePath)));

  await sweepExpiredExecutionWorktree(result.state, result.statePath, { now: now + 1_001 });
  assert.doesNotMatch(await git(fixture.repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(worktreePath)));
  await git(fixture.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  assert.ok(result.state.artifacts.worktree.pruned_at);
});

test('killed-run recovery adopts a clean worktree or prunes it while retaining its branch', async (t) => {
  const clean = await makeFixture(t);
  const cleanPaths = await writeRunningState(clean, { runningStep: true, worktree: true });
  const cleanResult = await recoverCampaign(clean.campaignPath, { runsDir: clean.runsDir });
  assert.ok(cleanResult.actions.includes('adopted_execution_worktree'));
  assert.match(await git(clean.repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(cleanPaths.executionPath)));

  const dirty = await makeFixture(t);
  const dirtyPaths = await writeRunningState(dirty, { runningStep: true, worktree: true });
  await writeFile(path.join(dirtyPaths.executionPath, 'partial.txt'), 'preserved\n', 'utf8');
  const dirtyResult = await recoverCampaign(dirty.campaignPath, { runsDir: dirty.runsDir });
  assert.ok(dirtyResult.actions.includes('pruned_execution_worktree_retained_branch'));
  assert.doesNotMatch(await git(dirty.repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(dirtyPaths.executionPath)));
  assert.equal(await git(dirty.repo, ['show', `${dirtyPaths.executionBranch}:partial.txt`]), 'preserved');
});

async function makeFixture(t, { reviewOutput = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-recovery-'));
  const children = new Set();
  t.after(async () => {
    for (const child of children) await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  const runsDir = path.join(root, 'runs');
  const campaignPath = path.join(repo, 'campaign.md');
  const configPath = path.join(root, 'campaigns.config.json');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, `# Recovery fixture

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Recoverable task
- [ ] Final review

## Step 1.1 — Recoverable task

\`\`\`text
Complete the recovery fixture.
\`\`\`

## Final review

\`\`\`text
Review the fixture.
\`\`\`
`, 'utf8');
  await writeFile(configPath, `${JSON.stringify(fakeRunnerConfig(reviewOutput), null, 2)}\n`, 'utf8');
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add recovery fixture']);
  return {
    root,
    repo,
    runsDir,
    campaignPath,
    configPath,
    trackChild(child) {
      children.add(child);
      child.once('close', () => children.delete(child));
      return child;
    },
    runOptions: {
      configPath,
      runsDir,
      noWorktree: true,
      stdout: silent,
      stderr: silent,
      env: { ...process.env, CAMPAIGNS_CONFIG_DIR: path.join(root, 'user-config') },
    },
  };
}

async function writeRunningState(fixture, { runningStep = false, worktree = false } = {}) {
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await mkdir(paths.receiptsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  let executionPath = fixture.repo;
  let executionBranch = 'main';
  let worktreeArtifact = null;
  if (worktree) {
    executionPath = path.join(paths.runDir, 'execution worktree');
    executionBranch = `campaigns/recovery-${path.basename(fixture.root)}`;
    await git(fixture.repo, ['worktree', 'add', '-b', executionBranch, executionPath, 'main']);
    executionPath = await realpath(executionPath);
    worktreeArtifact = {
      path: executionPath,
      branch: executionBranch,
      base_branch: 'main',
      created_at: '2026-07-15T12:00:00.000Z',
      cleanup_deadline: null,
      pruned_at: null,
    };
    paths.executionPath = executionPath;
    paths.executionBranch = executionBranch;
  }
  let state = createRunState({
    id: 'recovery-fixture-run',
    identity: {
      registry_id: 'fixture-campaign',
      source: { campaign_path: fixture.campaignPath, repo_root: fixture.repo },
      execution: {
        campaign_path: path.join(executionPath, 'campaign.md'),
        repo_root: executionPath,
        branch: executionBranch,
      },
    },
    steps: [{ id: '1.1', name: 'Recoverable task', phase: '1' }],
    config: {
      runner: 'fake',
      reviewer: 'fake',
      model: 'fake-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
      worktree_enabled: worktree,
    },
    artifacts: {
      run_dir: paths.runDir,
      receipts_dir: paths.receiptsDir,
      final_review_path: paths.finalReviewPath,
      worktree: worktreeArtifact,
    },
  });
  state = transitionRunState(state, { event: 'run_started' });
  if (runningStep) {
    state = transitionRunState(state, {
      event: 'step_started',
      step_id: '1.1',
      worker: {
        runner: 'fake',
        invocation_id: 'dead-worker',
        pid: deadPid,
        log_path: path.join(paths.logsDir, '1.1-1.log'),
      },
    });
  }
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return paths;
}

async function writeAwaitingHumanReviewState(fixture, cause) {
  const paths = await writeRunningState(fixture);
  let state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  const receiptPath = path.join(paths.receiptsDir, '1.1.md');
  const reviewPath = paths.finalReviewPath;
  await writeFile(receiptPath, '# Completed\n', 'utf8');
  await writeFile(reviewPath, 'Verdict: NEEDS WORK\nReasons: fixture\n', 'utf8');
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    worker: {
      runner: 'fake',
      invocation_id: 'review-fixture-worker',
      pid: deadPid,
      log_path: path.join(paths.logsDir, 'review-fixture.log'),
    },
  });
  state = transitionRunState(state, {
    event: 'step_completed',
    step_id: '1.1',
    receipt_path: receiptPath,
    commit_range: { base_oid: '1'.repeat(40), head_oid: '2'.repeat(40) },
  });
  state = transitionRunState(state, { event: 'run_reached_final_review' });

  if (cause === 'reviewer_unavailable') {
    state = transitionRunState(state, {
      event: cause,
      reviewer_runner: 'missing-reviewer',
      reviewer_family: 'missing-family',
      reviewer_ladder_tier: 'human',
    });
  } else {
    state = transitionRunState(state, {
      event: 'final_review_started',
      reviewer_runner: 'fake',
      reviewer_family: 'fake-family',
      reviewer_ladder_tier: 'cross_family',
    });
    if (cause === 'review_unparseable') {
      state = transitionRunState(state, { event: cause, review_path: reviewPath });
    } else {
      state = transitionRunState(state, {
        event: 'final_review_needs_work',
        reasons: ['fixture'],
        review_path: reviewPath,
      });
      if (cause === 'review_fix_attempts_exhausted') {
        state = transitionRunState(state, { event: cause, attempts: 1 });
      } else {
        state = transitionRunState(state, {
          event: cause,
          error: 'fixture merge failed',
          review_path: reviewPath,
        });
      }
    }
  }
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return paths;
}

async function writeDeadLock(lockPath, campaignPath) {
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    token: 'stale-token',
    pid: deadPid,
    campaign_path: campaignPath,
    started_at: '2026-07-14T12:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
}

function fakeRunnerConfig(reviewOutput = null) {
  const finalOutput = reviewOutput ?? 'Verdict: APPROVED\nReasons:\n\nRecovery is complete.';
  return {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: { repoRoot: null, branch: null },
    review: { reviewer: 'fake' },
    runners: {
      fake: {
        binary: process.execPath,
        args: [
          '-e',
          `process.stdout.write(
            process.argv[1].includes('campaigns.step_completed')
              ? process.argv[1]
              : ${JSON.stringify(finalOutput)}
          )`,
          '{prompt}',
        ],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fake-model', effort: 'none' },
        effortMap: { none: 'none' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForServerPort(child) {
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. ${errors}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Campaigns: http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}. ${errors}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', () => resolve(true)));
  child.kill('SIGTERM');
  if (await Promise.race([closed, closeTimeout()])) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    if (!await Promise.race([closed, closeTimeout()])) {
      throw new Error(`Server child ${child.pid ?? 'unknown'} did not close after SIGKILL.`);
    }
  }
}

function closeTimeout() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    timer.unref?.();
  });
}

function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
}

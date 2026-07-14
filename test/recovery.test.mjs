import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runCampaign, runPathsForCampaign } from '../lib/pump.mjs';
import { recoverCampaign } from '../lib/recovery.mjs';
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
  await writeFile(logPath, 'useful worker output before the process disappeared\n', 'utf8');
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
  assert.deepEqual(repaired.history.slice(-5).map((entry) => entry.event), [
    'step_failed',
    'recovery_started',
    'stale_lock_released',
    'step_reset_by_recover',
    'recovery_completed',
  ]);

  const resumed = await runCampaign(fixture.campaignPath, fixture.runOptions);
  assert.equal(resumed.state.run.status, 'merged');
  assert.equal(resumed.state.steps[0].status, 'completed');
  assert.equal(resumed.state.steps[0].attempt, 2);
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

  const child = spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: fixture.runsDir,
      CAMPAIGNS_PORT_FILE: path.join(fixture.root, 'server.port'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));
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

async function makeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await writeFile(configPath, `${JSON.stringify(fakeRunnerConfig(), null, 2)}\n`, 'utf8');
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add recovery fixture']);
  return {
    root,
    repo,
    runsDir,
    campaignPath,
    configPath,
    runOptions: { configPath, runsDir, stdout: silent, stderr: silent },
  };
}

async function writeRunningState(fixture, { runningStep = false } = {}) {
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await mkdir(paths.receiptsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  let state = createRunState({
    id: 'recovery-fixture-run',
    identity: {
      registry_id: 'fixture-campaign',
      source: { campaign_path: fixture.campaignPath, repo_root: fixture.repo },
      execution: {
        campaign_path: fixture.campaignPath,
        repo_root: fixture.repo,
        branch: 'main',
      },
    },
    steps: [{ id: '1.1', name: 'Recoverable task', phase: '1' }],
    config: {
      runner: 'fake',
      model: 'fake-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    },
    artifacts: {
      run_dir: paths.runDir,
      receipts_dir: paths.receiptsDir,
      final_review_path: paths.finalReviewPath,
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

async function writeDeadLock(lockPath, campaignPath) {
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    token: 'stale-token',
    pid: deadPid,
    campaign_path: campaignPath,
    started_at: '2026-07-14T12:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
}

function fakeRunnerConfig() {
  return {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: { repoRoot: null, branch: null },
    runners: {
      fake: {
        binary: process.execPath,
        args: [
          '-e',
          `process.stdout.write(
            process.argv[1].includes('campaigns.step_completed')
              ? process.argv[1]
              : 'Verdict: APPROVED\\nReasons:\\n\\nRecovery is complete.'
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
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'close'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
}

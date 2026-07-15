import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { runPathsForCampaign } from '../lib/pump.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'campaigns-launch-'));
const registryDir = path.join(root, 'registry');
const runsDir = path.join(root, 'runs');
const previousEnv = new Map();

for (const [name, value] of Object.entries({
  CAMPAIGNS_CONFIG_DIR: path.join(root, 'user-config'),
  CAMPAIGNS_PORT_FILE: path.join(root, 'server.port'),
  CAMPAIGNS_REGISTRY_DIR: registryDir,
  CAMPAIGNS_RUNS_DIR: runsDir,
})) {
  previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

const { startServer } = await import('../server.mjs');

after(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('launch commits only the campaign, rejects a duplicate, and reaches completed', async () => {
  const fixture = await createFixture('complete', { delayMs: 400, trackedCampaign: false });
  const worktreesBefore = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
  const server = await startServer({
    campaignFile: fixture.campaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  const baseUrl = serverUrl(server);
  try {
    const document = await fetch(`${baseUrl}/api/document`).then((response) => response.json());
    const estimate = await fetch(`${baseUrl}/api/estimate?id=${document.id}`).then((response) => response.json());
    assert.equal(estimate.remainingSteps, 1);

    const startedResponse = await post(baseUrl, '/api/run/start', { id: document.id });
    const started = await startedResponse.json();
    assert.equal(startedResponse.status, 202);
    assert.equal(started.committed, true);

    const duplicate = await post(baseUrl, '/api/run/start', { id: document.id });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'This campaign already has an active run.' });

    const committedPaths = await git(fixture.repo, ['show', '--pretty=', '--name-only', started.commitSha]);
    assert.equal(committedPaths, 'campaigns/launch.md');

    const completed = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/automate-state?id=${document.id}`);
      const state = await response.json();
      return state?.status === 'completed' ? state : null;
    }, 8_000);
    assert.equal(completed.status, 'completed');

    const paths = runPathsForCampaign(fixture.campaignPath, runsDir);
    const ledger = await waitFor(async () => {
      const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
      return state.artifacts.worktree?.pruned_at ? state : null;
    }, 2_000);
    const receipt = await readFile(path.join(paths.receiptsDir, '1.1-1.md'), 'utf8');
    const worktreesAfter = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
    assert.notEqual(ledger.run.identity.execution.repo_root, ledger.run.identity.source.repo_root);
    assert.match(receipt, new RegExp(`RUNNER_CWD=${escapeRegex(ledger.run.identity.execution.repo_root)}`));
    assert.ok(ledger.artifacts.worktree.pruned_at);
    assert.deepEqual(worktreesAfter, worktreesBefore);

    const finalEstimate = await fetch(`${baseUrl}/api/estimate?id=${document.id}`).then((response) => response.json());
    assert.equal(finalEstimate.remainingSteps, 0);
    assert.equal(await git(fixture.repo, ['status', '--short']), '');
  } finally {
    await closeServer(server);
  }
});

test('launch blocks unrelated dirty work without changing or committing it', async () => {
  const fixture = await createFixture('dirty', { delayMs: 10, trackedCampaign: true });
  const unrelated = 'Unrelated local work must survive byte-for-byte.\n';
  await writeFile(path.join(fixture.repo, 'README.md'), unrelated, 'utf8');
  await writeFile(fixture.campaignPath, `${campaignFixture()}\n<!-- browser edit -->\n`, 'utf8');
  const beforeHead = await git(fixture.repo, ['rev-parse', 'HEAD']);
  const server = await startServer({
    campaignFile: fixture.campaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  const baseUrl = serverUrl(server);
  try {
    const document = await fetch(`${baseUrl}/api/document`).then((response) => response.json());
    const response = await post(baseUrl, '/api/run/start', { id: document.id });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.match(payload.error, /README\.md/);
    assert.equal(await readFile(path.join(fixture.repo, 'README.md'), 'utf8'), unrelated);
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), beforeHead);
  } finally {
    await closeServer(server);
  }
});

test('stop and server shutdown terminate an active runner process', async () => {
  const stopFixture = await createFixture('stop', { delayMs: 20_000, trackedCampaign: false });
  let server = await startServer({
    campaignFile: stopFixture.campaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  let baseUrl = serverUrl(server);
  let document = await fetch(`${baseUrl}/api/document`).then((response) => response.json());
  await post(baseUrl, '/api/run/start', { id: document.id });
  let workerPid = await waitForWorkerPid(stopFixture.campaignPath);
  assert.equal(processAlive(workerPid), true);
  const stopped = await post(baseUrl, '/api/run/stop', { id: document.id });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, 'stopped_by_user');
  await waitFor(() => !processAlive(workerPid), 3_000);
  await closeServer(server);

  const closeFixture = await createFixture('shutdown', { delayMs: 20_000, trackedCampaign: false });
  server = await startServer({
    campaignFile: closeFixture.campaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  baseUrl = serverUrl(server);
  document = await fetch(`${baseUrl}/api/document`).then((response) => response.json());
  await post(baseUrl, '/api/run/start', { id: document.id });
  workerPid = await waitForWorkerPid(closeFixture.campaignPath);
  assert.equal(processAlive(workerPid), true);
  await closeServer(server);
  await waitFor(() => !processAlive(workerPid), 3_000);
});

async function createFixture(name, { delayMs, trackedCampaign }) {
  const repo = path.join(root, name);
  const campaignPath = path.join(repo, 'campaigns', 'launch.md');
  await mkdir(path.dirname(campaignPath), { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(path.join(repo, 'README.md'), '# Launch fixture\n', 'utf8');
  await writeFile(path.join(repo, '.campaigns.json'), `${JSON.stringify(fakeRunnerConfig(delayMs), null, 2)}\n`, 'utf8');
  await writeFile(campaignPath, campaignFixture(), 'utf8');
  await git(repo, ['add', 'README.md', '.campaigns.json', ...(trackedCampaign ? ['campaigns/launch.md'] : [])]);
  await git(repo, ['commit', '-m', 'Create launch fixture']);
  return { repo, campaignPath };
}

function campaignFixture() {
  return `# Launch fixture

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Complete the launch
- [ ] Final review

## Step 1.1 — Complete the launch

Model: Fake · None
Parallel: NO

\`\`\`text
Complete the fixture and report the Campaigns completion marker.
\`\`\`

## Final review

\`\`\`text
Review the fixture and return APPROVED.
\`\`\`
`;
}

function fakeRunnerConfig(delayMs) {
  const script = `
    const prompt = process.argv[1];
    if (prompt.includes('campaigns.step_completed') && !prompt.includes('Commit the verified step changes')) {
      process.stderr.write('missing commit instruction');
      process.exit(2);
    }
    const output = prompt.includes('campaigns.step_completed')
      ? 'RUNNER_CWD=' + process.cwd() + '\\n' + prompt
      : 'Verdict: APPROVED\\nReasons:\\n\\nLaunch fixture passed.';
    setTimeout(() => process.stdout.write(output), ${delayMs});
  `;
  return {
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 30_000, stall_window_ms: 30_000 },
    run: {
      max_steps_per_run: 5,
      max_run_minutes: 1,
      stop_grace_ms: 100,
    },
    review: { reviewer: 'fake', maxFixAttempts: 1, forceMergeUnreviewed: false },
    runners: {
      fake: {
        label: 'Fake',
        binary: process.execPath,
        args: ['-e', script, '{prompt}'],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fake-model', effort: 'none' },
        models: [{ id: 'fake-model', label: 'Fake' }],
        efforts: [{ id: 'none', label: 'None' }],
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

async function waitForWorkerPid(campaignPath) {
  const statePath = runPathsForCampaign(campaignPath, runsDir).statePath;
  return waitFor(async () => {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return Number.isInteger(state.worker?.pid) && state.worker.pid > 0 ? state.worker.pid : null;
    } catch {
      return null;
    }
  }, 4_000);
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function post(baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
}

function worktreePaths(porcelain) {
  return String(porcelain).split('\n').filter((line) => line.startsWith('worktree '));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

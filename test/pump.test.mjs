import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PumpLockError,
  runCampaign,
  runPathsForCampaign,
} from '../lib/pump.mjs';
import { validateRunState } from '../lib/run-state.mjs';

const silent = { write() {} };

test('fake success runner ticks every step, commits on the configured branch, and awaits review', async (t) => {
  const fixture = await makeFixture(t, { branch: 'campaign/fixture' });
  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const markdown = await readFile(fixture.campaignPath, 'utf8');
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.match(markdown, /- \[x\] Step 1\.1/);
  assert.match(markdown, /- \[x\] Step 1\.2/);
  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.equal(state.run.status, 'awaiting_review');
  assert.equal(state.history.at(-1).event, 'run_reached_final_review');
  assert.equal(await git(fixture.repo, ['branch', '--show-current']), 'campaign/fixture');
  const status = await git(fixture.repo, ['status', '--short']);
  assert.equal(status, '');
  assert.equal(await git(fixture.repo, ['log', '-1', '--pretty=%s']), 'Complete campaign step 1.2', status);
});

test('a concurrent invocation is refused by the per-campaign PID lock', async (t) => {
  const fixture = await makeFixture(t, { delayMs: 350 });
  const first = runCampaign(fixture.campaignPath, fixture.options);
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await waitFor(async () => Boolean(await readOptional(paths.lockPath)));

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    (error) => error instanceof PumpLockError && /already active/.test(error.message),
  );
  await first;
});

test('an interrupted worker is reset and the next invocation resumes the first unchecked step', async (t) => {
  const fixture = await makeFixture(t, { delayMs: 5_000 });
  const controller = new AbortController();
  const interrupted = runCampaign(fixture.campaignPath, {
    ...fixture.options,
    signal: controller.signal,
  });
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await waitFor(async () => {
    const state = await readOptional(paths.statePath);
    return state?.run?.current_step_id === '1.1';
  });
  controller.abort();
  await assert.rejects(interrupted, /Step 1\.1 failed/);

  await writeConfig(fixture.configPath, { delayMs: 0 });
  const resumed = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(resumed.statePath, 'utf8'));
  assert.equal(state.run.status, 'awaiting_review');
  assert.equal(state.steps[0].attempt, 2);
  assert.ok(state.history.some((entry) => entry.event === 'step_reset_by_recover'));
});

test('a hand-ticked checkbox is source of truth and is not rerun', async (t) => {
  const fixture = await makeFixture(t, { firstChecked: true });
  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.steps[0].status, 'skipped');
  assert.equal(state.steps[0].attempt, 0);
  assert.equal(state.steps[1].status, 'completed');
  assert.equal(state.run.status, 'awaiting_review');
});

test('dirty run-start preflight blocks without consuming an attempt and succeeds after cleanup', async (t) => {
  const fixture = await makeFixture(t);
  const dirtyPath = path.join(fixture.repo, 'unfinished.txt');
  await writeFile(dirtyPath, 'unfinished\n', 'utf8');

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    /worktree has uncommitted changes.*Remedy:/,
  );

  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  const blocked = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(blocked.run.status, 'blocked');
  assert.equal(blocked.steps[0].attempt, 0);
  assert.equal(blocked.history.at(-1).event, 'preflight_dirty_worktree');
  assert.match(blocked.history.at(-1).message, /Remedy:/);

  await rm(dirtyPath);
  const resumed = await runCampaign(fixture.campaignPath, fixture.options);
  assert.equal(resumed.state.run.status, 'awaiting_review');
});

test('invalid campaign preflight records its taxonomy event and can restart after repair', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.campaignPath, '# Broken campaign\n', 'utf8');

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    /campaign markdown is invalid.*Remedy:/,
  );

  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  const blocked = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(blocked.run.status, 'blocked');
  assert.equal(blocked.history.at(-1).event, 'preflight_campaign_invalid');

  await writeFile(fixture.campaignPath, campaignMarkdown(false), 'utf8');
  const resumed = await runCampaign(fixture.campaignPath, fixture.options);
  assert.equal(resumed.state.run.status, 'awaiting_review');
});

test('unavailable branch preflight records its taxonomy event without starting a step', async (t) => {
  const fixture = await makeFixture(t, { branch: 'not a valid branch' });

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    /cannot be checked out or created.*Remedy:/,
  );

  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  const blocked = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(blocked.run.status, 'blocked');
  assert.equal(blocked.steps[0].attempt, 0);
  assert.equal(blocked.history.at(-1).event, 'preflight_branch_unavailable');
});

test('watchdog keeps an active runner alive after the runtime floor', async (t) => {
  const fixture = await makeFixture(t, {
    watchdog: { minimum_runtime_ms: 100, stall_window_ms: 60 },
    runnerScript: `
      const prompt = process.argv[1];
      let count = 0;
      const timer = setInterval(() => {
        process.stdout.write('activity-' + count + '\\n');
        count += 1;
        if (count === 7) {
          clearInterval(timer);
          process.stdout.write(prompt);
        }
      }, 25);
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  assert.equal(result.state.run.status, 'awaiting_review');
  assert.equal(result.state.steps[0].status, 'completed');
  assert.equal(result.state.steps[1].status, 'completed');
});

test('watchdog kills a silent runner and salvages its output tail in the receipt', async (t) => {
  const fixture = await makeFixture(t, {
    watchdog: { minimum_runtime_ms: 100, stall_window_ms: 70 },
    runnerScript: `
      process.stdout.write('last useful output before silence\\n');
      setTimeout(() => process.stdout.write(process.argv[1]), 5_000);
    `,
  });
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    /failed: Runner stalled/,
  );

  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  const receipt = await readFile(path.join(paths.receiptsDir, '1.1-1.md'), 'utf8');
  assert.equal(state.run.status, 'failed');
  assert.equal(state.steps[0].failure.code, 'watchdog_stalled');
  assert.match(state.steps[0].failure.output_tail, /last useful output before silence/);
  assert.match(receipt, /## Salvaged output tail/);
  assert.match(receipt, /last useful output before silence/);
});

async function makeFixture(t, {
  branch = null,
  delayMs = 0,
  firstChecked = false,
  runnerScript = null,
  watchdog = null,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-pump-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const runsDir = path.join(root, 'runs');
  const configPath = path.join(root, 'campaigns.config.json');
  const campaignPath = path.join(repo, 'campaign.md');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, campaignMarkdown(firstChecked), 'utf8');
  await writeConfig(configPath, { branch, delayMs, runnerScript, watchdog });
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add fixture campaign']);
  return {
    repo,
    runsDir,
    campaignPath,
    configPath,
    options: { configPath, runsDir, stdout: silent, stderr: silent },
  };
}

function campaignMarkdown(firstChecked) {
  return `# Fixture campaign

## Progress checklist

### Phase 1 — Build

- [${firstChecked ? 'x' : ' '}] Step 1.1 — First
- [ ] Step 1.2 — Second
- [ ] Final review

## Step 1.1 — First

\`\`\`text
Create the first fixture result.
\`\`\`

## Step 1.2 — Second

\`\`\`text
Create the second fixture result.
\`\`\`

## Final review

\`\`\`text
Review the fixture.
\`\`\`
`;
}

async function writeConfig(configPath, {
  branch = null,
  delayMs = 0,
  runnerScript = null,
  watchdog = null,
} = {}) {
  const script = runnerScript ?? (delayMs > 0
    ? `setTimeout(() => process.stdout.write(process.argv[1]), ${delayMs})`
    : 'process.stdout.write(process.argv[1])');
  const config = {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: watchdog ?? { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: { repoRoot: null, branch },
    runners: {
      fake: {
        binary: process.execPath,
        args: ['-e', script, '{prompt}'],
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
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function readOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitFor(check) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for fixture state.');
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited ${exitCode}`));
    });
  });
}

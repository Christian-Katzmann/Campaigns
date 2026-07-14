import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PumpLockError,
  requestCampaignStop,
  runCampaign,
  runPathsForCampaign,
} from '../lib/pump.mjs';
import { validateRunState } from '../lib/run-state.mjs';

const silent = { write() {} };

test('fake success runner ticks every step, runs final review, and merges', async (t) => {
  const fixture = await makeFixture(t, { branch: 'campaign/fixture' });
  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const markdown = await readFile(fixture.campaignPath, 'utf8');
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.match(markdown, /- \[x\] Step 1\.1/);
  assert.match(markdown, /- \[x\] Step 1\.2/);
  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.equal(state.run.status, 'merged');
  assert.equal(state.history.at(-1).event, 'campaign_merged');
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
  assert.equal(state.run.status, 'completed');
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
  assert.equal(state.run.status, 'completed');
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
  assert.equal(resumed.state.run.status, 'completed');
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
  assert.equal(resumed.state.run.status, 'completed');
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
    watchdog: { minimum_runtime_ms: 250, stall_window_ms: 120 },
    runnerScript: `
      const prompt = process.argv[1];
      let count = 0;
      const timer = setInterval(() => {
        process.stdout.write('activity-' + count + '\\n');
        count += 1;
        if (count === 14) {
          clearInterval(timer);
          process.stdout.write(prompt);
        }
      }, 25);
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  assert.equal(result.state.run.status, 'completed');
  assert.equal(result.state.steps[0].status, 'completed');
  assert.equal(result.state.steps[1].status, 'completed');
});

test('watchdog kills a silent runner and salvages its output tail in the receipt', async (t) => {
  const fixture = await makeFixture(t, {
    watchdog: { minimum_runtime_ms: 500, stall_window_ms: 120 },
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

test('every persisted worker and review artifact is redacted at write time', async (t) => {
  const fixture = await makeFixture(t, {
    runnerOutputFile: true,
    runnerScript: `
      const fs = require('node:fs');
      const leaked = [
        'AUTH_SECRET=audit-auth-value',
        'TURSO_DATABASE_URL=libsql://audit.invalid?authToken=audit-db-value',
        'postgres://user:db-password@db.invalid/app',
        'Bearer bearer.audit.token-123',
      ].join('\\n');
      fs.writeFileSync(process.argv[2], leaked + '\\n' + process.argv[1]);
      process.stdout.write('AUTH_SEC');
      process.stdout.write('RET=split-secret\\n' + leaked + '\\n' + process.argv[1]);
      process.stderr.write('Bearer stderr.bearer.token-456\\n');
    `,
    reviewScript: `
      const fs = require('node:fs');
      const review = 'Verdict: APPROVED\\nReasons:\\n\\nAUTH_SECRET=review-secret';
      fs.writeFileSync(process.argv[2], review);
      process.stdout.write(review);
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const artifacts = await readFilesRecursively(result.runDir);
  const persisted = artifacts.map((entry) => entry.contents).join('\n');

  assert.equal(result.state.run.status, 'completed');
  for (const secret of [
    'audit-auth-value',
    'audit-db-value',
    'db-password',
    'bearer.audit.token-123',
    'stderr.bearer.token-456',
    'split-secret',
    'review-secret',
  ]) {
    assert.doesNotMatch(persisted, new RegExp(secret), secret);
  }
  assert.match(persisted, /\[REDACTED\]/);
  assert.ok(artifacts.some((entry) => entry.path.endsWith('1.1-1-last-message.md')));
  assert.ok(artifacts.some((entry) => entry.path.endsWith('review-1-1-last-message.md')));
  assert.ok(artifacts.some((entry) => entry.path.endsWith('final-review.md')));
});

test('max_steps_per_run stops at the boundary with a visible cap event', async (t) => {
  const fixture = await makeFixture(t, { maxStepsPerRun: 1 });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'cap_reached');
  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[1].status, 'pending');
  assert.equal(state.history.at(-1).event, 'cap_reached');
  assert.match(state.history.at(-1).message, /Step cap reached after 1 completed step/);
  assert.equal(state.history.at(-1).details.cap, 'max_steps_per_run');
});

test('max_run_minutes terminates an active worker and salvages its output', async (t) => {
  const fixture = await makeFixture(t, {
    maxRunMinutes: 0.02,
    watchdog: { minimum_runtime_ms: 10_000, stall_window_ms: 10_000 },
    runnerScript: `
      process.stdout.write('useful output before run-time cap\\n');
      setTimeout(() => process.stdout.write(process.argv[1]), 5_000);
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));
  const receipt = await readFile(path.join(result.receiptsDir, '1.1-1.md'), 'utf8');

  assert.equal(state.run.status, 'cap_reached');
  assert.equal(state.steps[0].status, 'stopped');
  assert.equal(state.history.at(-1).details.cap, 'max_run_minutes');
  assert.match(state.history.at(-1).message, /Run-time cap reached during Step 1\.1/);
  assert.match(receipt, /useful output before run-time cap/);
});

test('user stop gives grace, kills the active process group, and records salvage', async (t) => {
  const fixture = await makeFixture(t, {
    stopGraceMs: 50,
    watchdog: { minimum_runtime_ms: 10_000, stall_window_ms: 10_000 },
    runnerScript: `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync('grandchild.pid', String(grandchild.pid));
      process.stdout.write('salvage this user-stopped work AUTH_SECRET=stop-secret\\n');
      setInterval(() => {}, 1_000);
    `,
  });
  const running = runCampaign(fixture.campaignPath, fixture.options);
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await waitFor(async () => {
    const state = await readOptional(paths.statePath);
    return Boolean(state?.worker?.pid && await readTextOptional(path.join(fixture.repo, 'grandchild.pid')));
  });
  const active = JSON.parse(await readFile(paths.statePath, 'utf8'));
  const workerPid = active.worker.pid;
  const grandchildPid = Number(await readFile(path.join(fixture.repo, 'grandchild.pid'), 'utf8'));
  t.after(() => {
    for (const pid of [workerPid, grandchildPid]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });

  await requestCampaignStop(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    stopGraceMs: 50,
    waitTimeoutMs: 3_000,
  });
  const result = await running;
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));
  const receipt = await readFile(path.join(result.receiptsDir, '1.1-1.md'), 'utf8');
  await waitFor(async () => !isPidAlive(workerPid) && !isPidAlive(grandchildPid));

  assert.equal(state.run.status, 'stopped_by_user');
  assert.equal(state.steps[0].status, 'stopped');
  assert.equal(state.history.at(-1).event, 'stopped_by_user');
  assert.equal(state.history.at(-1).details.forced, true);
  assert.match(receipt, /salvage this user-stopped work/);
  assert.doesNotMatch(receipt, /stop-secret/);
  assert.doesNotMatch(JSON.stringify(state), /stop-secret/);
});

test('a worker finishing inside stop grace is completed before the stop boundary', async (t) => {
  const fixture = await makeFixture(t, {
    delayMs: 120,
    stopGraceMs: 1_000,
    watchdog: { minimum_runtime_ms: 10_000, stall_window_ms: 10_000 },
  });
  const running = runCampaign(fixture.campaignPath, fixture.options);
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await waitFor(async () => Boolean((await readOptional(paths.statePath))?.worker?.pid));

  await requestCampaignStop(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    stopGraceMs: 1_000,
    waitTimeoutMs: 3_000,
  });
  const result = await running;
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'stopped_by_user');
  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[1].status, 'pending');
  assert.deepEqual(state.history.slice(-2).map((entry) => entry.event), [
    'step_completed',
    'stopped_by_user',
  ]);
  assert.equal(state.history.at(-1).details.boundary, true);
});

test('containment refuses a campaign resolving outside the declared repository root', async (t) => {
  const fixture = await makeFixture(t);
  const outsideCampaign = path.join(fixture.root, 'outside-campaign.md');
  await writeFile(outsideCampaign, campaignMarkdown(false), 'utf8');

  await assert.rejects(
    runCampaign(outsideCampaign, { ...fixture.options, repoRoot: fixture.repo }),
    /Campaign file resolves outside repository root/,
  );
});

test('an unparseable review is re-asked exactly once before awaiting human review', async (t) => {
  const fixture = await makeFixture(t, {
    reviewScript: "process.stdout.write('I reviewed it, but omitted the required header.')",
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.review.attempts, 2);
  assert.equal(state.history.filter((entry) => entry.event === 'final_review_reasked').length, 1);
  assert.equal(state.history.at(-1).event, 'review_unparseable');
  assert.equal(state.history.some((entry) => entry.event === 'final_review_halted'), false);
  assert.equal(state.history.some((entry) => entry.event === 'campaign_merged'), false);
});

test('a repeated prose reason is preserved whole through fix-cap exhaustion', async (t) => {
  const fixture = await makeFixture(t, {
    reviewScript: "process.stdout.write('Verdict: NEEDS WORK\\nReasons: Read the cumulative diff before approving')",
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.review.attempts, 2);
  assert.deepEqual(state.review.reasons, []);
  assert.deepEqual(state.review.raw_tags, ['Read the cumulative diff before approving']);
  assert.equal(state.history.filter((entry) => entry.event === 'final_fix_failed').length, 2);
});

test('a fix worker with no commit consumes the cap and never merges', async (t) => {
  const fixture = await makeFixture(t, {
    branch: 'campaign/no-commit',
    reviewScript: "process.stdout.write('Verdict: NEEDS WORK\\nReasons: acceptance-miss')",
    fixScript: "process.stdout.write('AUTH_SECRET=fix-secret')",
  });
  const targetBefore = await git(fixture.repo, ['rev-parse', 'main']);

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.history.filter((entry) => entry.event === 'final_fix_failed').length, 2);
  assert.equal(state.history.at(-1).event, 'review_fix_attempts_exhausted');
  assert.equal(state.history.some((entry) => entry.event === 'campaign_merged'), false);
  assert.equal(state.history.some((entry) => entry.event === 'force_merged_unreviewed'), false);
  assert.equal(await git(fixture.repo, ['rev-parse', 'main']), targetBefore);
  assert.equal(await git(fixture.repo, ['branch', '--show-current']), 'campaign/no-commit');
  assert.equal(await git(fixture.repo, ['status', '--short']), '');
  assert.doesNotMatch(await readFile(path.join(result.logsDir, 'fix-1.log'), 'utf8'), /fix-secret/);
  assert.doesNotMatch(await readFile(path.join(result.logsDir, 'fix-2.log'), 'utf8'), /fix-secret/);
});

test('a committed fix is re-reviewed and merged into a non-main default branch', async (t) => {
  const fixture = await makeFixture(t, {
    branch: 'campaign/fixed',
    defaultBranch: 'trunk',
    reviewScript: `
      const fs = require('node:fs');
      process.stdout.write(fs.existsSync('fixed.txt')
        ? 'Verdict: APPROVED\\nReasons:'
        : 'Verdict: NEEDS WORK\\nReasons: acceptance-miss');
    `,
    fixScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      fs.writeFileSync('fixed.txt', 'fixed\\n');
      execFileSync('git', ['add', 'fixed.txt']);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Fix review gap']);
      process.stdout.write('Committed the review fix.');
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'merged');
  assert.equal(state.run.identity.execution.branch, 'campaign/fixed');
  assert.equal(state.run.identity.execution.merge_target_branch, 'trunk');
  assert.equal(state.history.filter((entry) => entry.event === 'final_rework_completed').length, 1);
  assert.equal(state.history.at(-1).event, 'campaign_merged');
  assert.equal(await git(fixture.repo, ['show', 'trunk:fixed.txt']), 'fixed');
});

test('a diverged merge target awaits human review without a partial merge', async (t) => {
  const fixture = await makeFixture(t, {
    branch: 'campaign/diverged',
    divergeTarget: true,
  });
  const targetBefore = await git(fixture.repo, ['rev-parse', 'main']);

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.history.at(-1).event, 'review_merge_failed');
  assert.match(state.history.at(-1).details.error, /diverged/);
  assert.equal(await git(fixture.repo, ['rev-parse', 'main']), targetBefore);
  assert.equal(state.history.some((entry) => entry.event === 'campaign_merged'), false);
});

test('a dirty default-branch worktree blocks merge without touching the target', async (t) => {
  const fixture = await makeFixture(t, { branch: 'campaign/dirty-target' });
  await git(fixture.repo, ['branch', 'campaign/dirty-target']);
  await git(fixture.repo, ['switch', 'campaign/dirty-target']);
  const targetWorktree = path.join(fixture.root, 'target-worktree');
  await git(fixture.repo, ['worktree', 'add', targetWorktree, 'main']);
  const targetBefore = await git(targetWorktree, ['rev-parse', 'HEAD']);
  await writeFile(path.join(targetWorktree, 'unfinished.txt'), 'local target work\n', 'utf8');

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'awaiting_human_review');
  assert.equal(state.history.at(-1).event, 'review_merge_failed');
  assert.match(state.history.at(-1).details.error, /is dirty/);
  assert.equal(await git(targetWorktree, ['rev-parse', 'HEAD']), targetBefore);
  assert.equal(await readFile(path.join(targetWorktree, 'unfinished.txt'), 'utf8'), 'local target work\n');
});

test('awaiting human review sends the configured push notification', async (t) => {
  const fixture = await makeFixture(t, {
    reviewScript: "process.stdout.write('missing verdict')",
  });
  const registryDir = path.join(fixture.root, 'registry');
  await mkdir(registryDir, { recursive: true });
  await writeFile(path.join(registryDir, 'notification-settings.json'), JSON.stringify({
    webhookUrl: 'https://hooks.slack.com/services/T/B/mock',
  }), 'utf8');
  const requests = [];

  const result = await runCampaign(fixture.campaignPath, {
    ...fixture.options,
    env: { ...process.env, CAMPAIGNS_REGISTRY_DIR: registryDir },
    notificationFetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.state.run.status, 'awaiting_human_review');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://hooks.slack.com/services/T/B/mock');
  assert.match(requests[0].options.body, /awaiting human review/);
});

test('force_merged_unreviewed occurs only with the explicit config escape hatch', async (t) => {
  const fixture = await makeFixture(t, {
    branch: 'campaign/forced',
    maxFixAttempts: 1,
    forceMergeUnreviewed: true,
    reviewScript: "process.stdout.write('Verdict: NEEDS WORK\\nReasons: acceptance-miss')",
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'force_merged');
  assert.equal(state.history.at(-1).event, 'force_merged_unreviewed');
  assert.equal(state.history.at(-1).details.explicit, true);
  assert.equal(await git(fixture.repo, ['rev-parse', 'main']), await git(fixture.repo, ['rev-parse', 'campaign/forced']));
});

async function makeFixture(t, {
  branch = null,
  defaultBranch = 'main',
  delayMs = 0,
  firstChecked = false,
  runnerScript = null,
  reviewScript = null,
  fixScript = null,
  watchdog = null,
  maxFixAttempts = 2,
  forceMergeUnreviewed = false,
  maxStepsPerRun = 50,
  maxRunMinutes = 360,
  stopGraceMs = 3_000,
  divergeTarget = false,
  runnerOutputFile = false,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-pump-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const runsDir = path.join(root, 'runs');
  const configPath = path.join(root, 'campaigns.config.json');
  const campaignPath = path.join(repo, 'campaign.md');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', defaultBranch]);
  await git(repo, ['config', 'init.defaultBranch', defaultBranch]);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, campaignMarkdown(firstChecked), 'utf8');
  await writeConfig(configPath, {
    branch,
    delayMs,
    runnerScript,
    reviewScript,
    fixScript,
    watchdog,
    maxFixAttempts,
    forceMergeUnreviewed,
    maxStepsPerRun,
    maxRunMinutes,
    stopGraceMs,
    runnerOutputFile,
  });
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add fixture campaign']);
  if (divergeTarget) {
    if (!branch) throw new Error('divergeTarget requires a campaign branch');
    await git(repo, ['branch', branch]);
    await writeFile(path.join(repo, 'target-only.txt'), 'target moved\n', 'utf8');
    await git(repo, ['add', 'target-only.txt']);
    await git(repo, ['commit', '-m', 'Advance merge target']);
  }
  return {
    root,
    repo,
    runsDir,
    campaignPath,
    configPath,
    options: {
      configPath,
      runsDir,
      stdout: silent,
      stderr: silent,
      env: { ...process.env, CAMPAIGNS_CONFIG_DIR: path.join(root, 'user-config') },
    },
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
  reviewScript = null,
  fixScript = null,
  watchdog = null,
  maxFixAttempts = 2,
  forceMergeUnreviewed = false,
  maxStepsPerRun = 50,
  maxRunMinutes = 360,
  stopGraceMs = 3_000,
  runnerOutputFile = false,
} = {}) {
  const stepScript = runnerScript ?? (delayMs > 0
    ? `setTimeout(() => process.stdout.write(process.argv[1]), ${delayMs})`
    : 'process.stdout.write(process.argv[1])');
  const finalReviewScript = reviewScript
    ?? "process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nEverything landed.')";
  const finalFixScript = fixScript ?? "process.stdout.write('No fix commit produced.')";
  const script = `
    if (process.argv[1].includes('campaigns.step_completed')) {
      ${stepScript}
    } else if (process.argv[1].startsWith('Fix the final-review gaps')) {
      ${finalFixScript}
    } else {
      ${finalReviewScript}
    }
  `;
  const config = {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: watchdog ?? { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: {
      repoRoot: null,
      branch,
      max_steps_per_run: maxStepsPerRun,
      max_run_minutes: maxRunMinutes,
      stop_grace_ms: stopGraceMs,
    },
    review: { maxFixAttempts, forceMergeUnreviewed },
    runners: {
      fake: {
        binary: process.execPath,
        args: runnerOutputFile
          ? ['-e', script, '{prompt}', '{output}']
          : ['-e', script, '{prompt}'],
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

async function readFilesRecursively(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await readFilesRecursively(entryPath));
    else files.push({ path: entryPath, contents: await readFile(entryPath, 'utf8') });
  }
  return files;
}

async function readOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTextOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
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

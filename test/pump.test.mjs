import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildStepRunnerInvocation,
  globPrefix,
  laneGlobsOverlap,
  parseCampaignPlan,
  PumpLockError,
  requestCampaignStop,
  resolveParallelLaneSafety,
  resolveParallelStepGroup,
  runCampaign,
  runExecutableChecks,
  runPathsForCampaign,
} from '../lib/pump.mjs';
import { validateRunState } from '../lib/run-state.mjs';
import { loadRunnerRegistry } from '../lib/runners.mjs';

const silent = { write() {} };

test('parseCampaignPlan preserves old steps with no executable checks', () => {
  const plan = parseCampaignPlan(campaignMarkdown(false));
  assert.deepEqual(plan.steps[0], {
    id: '1.1',
    name: 'First',
    phase: '1',
    checked: false,
    checklistLine: 6,
    prompt: 'Create the first fixture result.',
  });
  assert.equal('checks' in plan.steps[1], false);
});

test('parseCampaignPlan attaches one and several executable checks', () => {
  const oneCheckMarkdown = campaignMarkdown(false).replace(
    'Create the first fixture result.',
    `Create the first fixture result.\nCHECK: ${JSON.stringify({ command: 'npm test' })}`,
  );
  assert.deepEqual(parseCampaignPlan(oneCheckMarkdown).steps[0].checks, [{
    command: 'npm test',
    expectedExit: 0,
    expectedOutput: null,
    timeoutMs: 120_000,
  }]);

  const severalChecks = [
    { command: 'npm test', expectedExit: 0, timeoutMs: 30_000 },
    { command: 'npm run check', expectedOutput: 'clean' },
    { command: 'git diff --check', expectedExit: 0, timeoutMs: 5_000 },
  ].map((check) => `CHECK: ${JSON.stringify(check)}`).join('\n');
  const severalChecksMarkdown = campaignMarkdown(false).replace(
    'Create the second fixture result.',
    `Create the second fixture result.\n${severalChecks}`,
  );
  assert.equal(parseCampaignPlan(severalChecksMarkdown).steps[1].checks.length, 3);
});

test('parallel metadata reaches the engine plan and only reciprocal same-phase links group', () => {
  const markdown = parallelCampaignMarkdown();
  const plan = parseCampaignPlan(markdown);
  assert.deepEqual(plan.steps[0].parallel, { isParallel: true, siblingSteps: ['1.2'] });
  assert.deepEqual(plan.steps[0].lane, { globs: ['result-1.1.txt'] });
  assert.deepEqual(resolveParallelStepGroup(plan, '1.1').steps.map((step) => step.id), ['1.1', '1.2']);
  assert.deepEqual(resolveParallelLaneSafety(resolveParallelStepGroup(plan, '1.1').steps), {
    safe: true,
    reason: null,
  });

  const malformed = parseCampaignPlan(markdown.replace(
    'Parallel: YES — with Step 1.1',
    'Parallel: NO',
  ));
  assert.match(resolveParallelStepGroup(malformed, '1.1').reason, /reciprocal/);

  const crossPhase = parseCampaignPlan(markdown.replace(
    'Parallel: YES — with Step 1.2',
    'Parallel: YES — with Step 2.1',
  ));
  assert.match(resolveParallelStepGroup(crossPhase, '1.1').reason, /across phases/);

  const overlapping = parseCampaignPlan(markdown.replace(
    'Lane: `result-1.2.txt`',
    'Lane: `result-1.1.txt`',
  ));
  assert.match(
    resolveParallelLaneSafety(resolveParallelStepGroup(overlapping, '1.1').steps).reason,
    /overlapping lanes/,
  );

  const missing = parseCampaignPlan(markdown.replace('Lane: `result-1.2.txt`\n', ''));
  assert.match(
    resolveParallelLaneSafety(resolveParallelStepGroup(missing, '1.1').steps).reason,
    /missing or has an unparseable Lane/,
  );
});

test('lane overlap uses campaign-wt glob-prefix semantics', () => {
  assert.equal(globPrefix('src/components/**/*.tsx'), 'src/components/');
  assert.equal(laneGlobsOverlap('src/left/**', 'src/right/**'), false);
  assert.equal(laneGlobsOverlap('src/**', 'src/api/**'), true);
  assert.equal(laneGlobsOverlap('**', 'docs/**'), true);
  assert.equal(laneGlobsOverlap('src/a*.js', 'src/ab*.js'), false);
});

test('primary chip segment selects the runner, model, and effort at the invocation seam', async () => {
  const registry = await loadRunnerRegistry();
  const invocationFor = (modelLine) => {
    const markdown = campaignMarkdown(false).replace(
      '## Step 1.1 — First\n\n',
      `## Step 1.1 — First\n\nModel: ${modelLine}\nParallel: NO\n\n`,
    );
    return buildStepRunnerInvocation(registry, parseCampaignPlan(markdown).steps[0], {
      prompt: 'work',
      repoRoot: '/repo',
      outputPath: '/tmp/out',
      env: {},
      fallbackRunner: 'claude',
    });
  };
  const codex = invocationFor('GPT-5.6-Sol · High / Fable 5 · High');
  assert.deepEqual(
    (({ runner, model, effort }) => ({ runner, model, effort }))(codex),
    { runner: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
  );
  const claude = invocationFor('Fable 5 · High / GPT-5.6-Sol · High');
  assert.deepEqual(
    (({ runner, model, effort }) => ({ runner, model, effort }))(claude),
    { runner: 'claude', model: 'claude-opus-4-8', effort: 'high' },
  );
});

test('runnerPaths plugin drives a fixture campaign without core runner configuration', async (t) => {
  const fixture = await makeFixture(t, { campaignText: runnerPluginCampaignMarkdown() });
  await writeFile(fixture.configPath, `${JSON.stringify({
    defaultRunner: 'gemini',
    runnerPaths: [path.resolve('test/fixtures/runner-plugins/gemini')],
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    review: { reviewer: 'gemini' },
  }, null, 2)}\n`, 'utf8');

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const markdown = await readFile(fixture.campaignPath, 'utf8');
  const events = (await readFile(result.eventsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const completed = events.find((event) => event.event === 'step_completed');

  assert.equal(result.state.config.runner, 'gemini');
  assert.equal(result.state.run.status, 'completed');
  assert.match(markdown, /- \[x\] Step 1\.1/);
  assert.equal(await readFile(path.join(fixture.repo, 'gemini-plugin-1.1.txt'), 'utf8'), '1.1\n');
  assert.deepEqual(completed.details.usage, {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    cost_usd: 0.0042,
  });
});

test('reported runner spend reaches the dollar cap before a later invocation starts', async (t) => {
  const fixture = await makeFixture(t, { maxCostUsd: 1, costUsd: 0.6 });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const starts = result.state.history.filter((entry) => entry.event === 'step_started');
  const cap = result.state.history.at(-1);

  assert.equal(result.state.run.status, 'cap_reached');
  assert.deepEqual(starts.map((entry) => entry.step_id), ['1.1', '1.2']);
  assert.equal(result.state.history.some((entry) => entry.event === 'final_review_started'), false);
  assert.equal(cap.event, 'cap_reached');
  assert.equal(cap.details.cap, 'max_cost_usd');
  assert.equal(cap.details.total_cost_usd, 1.2);
  assert.equal(result.state.steps.find((step) => step.id === '1.2').status, 'completed');
});

test('a mandatory dollar cap refuses runners without a cost mapping before launch', async (t) => {
  const fixture = await makeFixture(t, { maxCostUsd: 1 });

  await assert.rejects(
    runCampaign(fixture.campaignPath, fixture.options),
    /has no cost_usd usage mapping/,
  );
  assert.equal(
    await readTextOptional(runPathsForCampaign(fixture.campaignPath, fixture.runsDir).statePath),
    null,
  );
});

test('action-style capped harness completes and persists only redacted upload surfaces', async (t) => {
  const sentinel = 'sentinel-action-secret';
  const fixture = await makeFixture(t, {
    maxStepsPerRun: 3,
    maxRunMinutes: 20,
    maxCostUsd: 1,
    costUsd: 0.1,
    runnerScript: `process.stdout.write('AUTH_SECRET=${sentinel}\\n'+process.argv[1])`,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const surfaces = [
    result.statePath,
    result.eventsPath,
    result.receiptsDir,
    result.finalReviewPath,
  ];
  for (const surface of surfaces) assert.equal(await pathExistsForTest(surface), true);
  const persisted = (await readFilesRecursively(result.runDir))
    .map((file) => file.contents)
    .join('\n');

  assert.equal(result.state.run.status, 'completed');
  assert.doesNotMatch(persisted, new RegExp(sentinel));
  assert.match(persisted, /\[REDACTED\]/);
});

test('final review defaults to another available family and uses that runner defaults', async (t) => {
  const fixture = await makeFixture(t, {
    reviewer: 'auto',
    additionalRunners: {
      claude: missingRunner('anthropic'),
      codex: missingRunner('openai'),
      critic: {
        family: 'critic-family',
        binary: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs');fs.writeFileSync('review-defaults.json',JSON.stringify({model:process.argv[1],effort:process.argv[2]}));process.stdout.write('Verdict: APPROVED\\nReasons:')`,
          '{model}',
          '{effort}',
        ],
        prompt: { delivery: 'stdin' },
        defaults: { model: 'critic-default-model', effort: 'critic-default-effort' },
        effortMap: { 'critic-default-effort': 'critic-default-effort' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);

  assert.equal(result.state.review.reviewer_runner, 'critic');
  assert.equal(result.state.review.reviewer_family, 'critic-family');
  assert.equal(result.state.review.reviewer_ladder_tier, 'cross_family');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.repo, 'review-defaults.json'), 'utf8')),
    { model: 'critic-default-model', effort: 'critic-default-effort' },
  );
});

test('an unavailable explicit reviewer waits for a human without spawning review', async (t) => {
  const fixture = await makeFixture(t, {
    reviewer: 'missing-reviewer',
    additionalRunners: {
      'missing-reviewer': {
        family: 'missing-family',
        binary: path.join(tmpdir(), 'campaigns-missing-reviewer'),
        args: [],
        prompt: { delivery: 'stdin' },
        defaults: { model: 'missing-model', effort: 'none' },
        effortMap: { none: 'none' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  });
  const notifications = [];

  const result = await runCampaign(fixture.campaignPath, {
    ...fixture.options,
    notifyAwaitingHumanReview: async (state) => notifications.push(state.run.status),
  });
  const logNames = await readdir(result.logsDir);

  assert.equal(result.state.run.status, 'awaiting_human_review');
  assert.equal(result.state.review.attempts, 0);
  assert.equal(result.state.review.reviewer_runner, 'missing-reviewer');
  assert.equal(result.state.review.reviewer_family, 'missing-family');
  assert.equal(result.state.review.reviewer_ladder_tier, 'human');
  assert.equal(result.state.history.at(-1).event, 'reviewer_unavailable');
  assert.deepEqual(notifications, ['awaiting_human_review']);
  assert.equal(logNames.some((name) => name.startsWith('review-')), false);
});

test('executable checks enforce their own timeout', async () => {
  const startedAt = Date.now();
  const [result] = await runExecutableChecks([{
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
    expectedExit: 0,
    expectedOutput: null,
    timeoutMs: 50,
  }], { cwd: process.cwd() });

  assert.equal(result.passed, false);
  assert.equal(result.timed_out, true);
  assert.match(result.failure, /timed out after 50ms/);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('passing executable checks are captured in the receipt before the step ticks', async (t) => {
  const checks = [
    { command: `node -e "process.stdout.write('ready')"`, expectedOutput: 'ready' },
    { command: `node -e "process.stderr.write('clean')"`, expectedOutput: 'clean' },
  ].map((check) => `CHECK: ${JSON.stringify(check)}`).join('\n');
  const fixture = await makeFixture(t, {
    campaignText: campaignMarkdown(false).replace(
      'Create the first fixture result.',
      `Create the first fixture result.\n${checks}`,
    ),
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const markdown = await readFile(fixture.campaignPath, 'utf8');
  const receipt = await readFile(path.join(result.receiptsDir, '1.1-1.md'), 'utf8');

  assert.match(markdown, /- \[x\] Step 1\.1/);
  assert.match(receipt, /## Executable checks/);
  assert.match(receipt, /process\.stdout\.write\('ready'\)/);
  assert.match(receipt, /process\.stderr\.write\('clean'\)/);
  assert.equal((receipt.match(/- Outcome: `pass`/g) ?? []).length, 2);
  assert.equal(result.state.history.some((entry) => entry.event === 'check_failed'), false);
});

test('a failing step check stays unticked, feeds redacted capped output to a fix, and reruns', async (t) => {
  const command = `node -e "const fs=require('node:fs'); if(!fs.existsSync('fixed.txt')){process.stdout.write('x'.repeat(6000)+' AUTH_SECRET=check-secret');process.exit(1)} process.stdout.write('fixed')"`;
  const fixture = await makeFixture(t, {
    campaignText: campaignMarkdown(false).replace(
      'Create the first fixture result.',
      `Create the first fixture result.\nCHECK: ${JSON.stringify({ command, expectedOutput: 'fixed' })}`,
    ),
    checkFixScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const campaign = fs.readFileSync('campaign.md', 'utf8');
      if (campaign.includes('- [x] Step 1.1')) throw new Error('step ticked before checks passed');
      fs.writeFileSync('check-fix-prompt.txt', process.argv[1]);
      fs.writeFileSync('fixed.txt', 'fixed\\n');
      execFileSync('git', ['add', 'check-fix-prompt.txt', 'fixed.txt']);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Fix executable check']);
      process.stdout.write('fixed');
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));
  const receipt = await readFile(path.join(result.receiptsDir, '1.1-1.md'), 'utf8');
  const fixPrompt = await readFile(path.join(fixture.repo, 'check-fix-prompt.txt'), 'utf8');
  const event = state.history.find((entry) => entry.event === 'check_failed');

  assert.equal(state.run.status, 'completed');
  assert.equal(event.from_status, 'running');
  assert.equal(event.to_status, 'running');
  assert.equal(event.details.failures[0].output.length, 4_096);
  assert.match(event.details.failures[0].output, /^\[TRUNCATED: output capped at 4096 characters\]/);
  assert.match(event.details.failures[0].output, /AUTH_SECRET=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(state), /check-secret/);
  assert.match(fixPrompt, /^Fix the executable-check failures for Step 1\.1\./);
  assert.match(fixPrompt, /\[TRUNCATED: output capped at 4096 characters\]/);
  assert.match(fixPrompt, /AUTH_SECRET=\[REDACTED\]/);
  assert.doesNotMatch(fixPrompt, /check-secret/);
  assert.match(receipt, /### Run 1[\s\S]*- Outcome: `fail`/);
  assert.match(receipt, /### Run 2[\s\S]*- Outcome: `pass`/);
});

test('campaign-wide checks catch a later step regression before final review', async (t) => {
  const command = `node -e "const fs=require('node:fs');process.exit(fs.existsSync('contract.txt')?0:1)"`;
  const fixture = await makeFixture(t, {
    campaignText: campaignMarkdown(false).replace(
      'Create the first fixture result.',
      `Create the first fixture result.\nCHECK: ${JSON.stringify({ command })}`,
    ),
    runnerScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const prompt = process.argv[1];
      if (prompt.includes('Step: 1.1')) {
        fs.writeFileSync('contract.txt', 'intact\\n');
        execFileSync('git', ['add', 'contract.txt']);
        execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Create checked contract']);
      } else if (prompt.includes('Step: 1.2')) {
        fs.rmSync('contract.txt');
        execFileSync('git', ['add', '-u', 'contract.txt']);
        execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Regress earlier contract']);
      }
      process.stdout.write(prompt);
    `,
    checkFixScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      fs.writeFileSync('contract.txt', 'restored\\n');
      execFileSync('git', ['add', 'contract.txt']);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Restore checked contract']);
      process.stdout.write('restored');
    `,
    reviewScript: `
      const fs = require('node:fs');
      if (!fs.existsSync('contract.txt')) process.exit(9);
      process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nChecks passed before review.');
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const campaignFailure = result.state.history.find((entry) => (
    entry.event === 'check_failed' && entry.details.scope === 'campaign'
  ));

  assert.equal(result.state.run.status, 'completed');
  assert.ok(campaignFailure);
  assert.equal(campaignFailure.from_status, 'awaiting_review');
  assert.equal(campaignFailure.to_status, 'awaiting_review');
  assert.equal(await readFile(path.join(fixture.repo, 'contract.txt'), 'utf8'), 'restored\n');
  assert.equal(result.state.review.verdict, 'APPROVED');
});

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
  assert.equal(state.review.reviewer_runner, 'fake');
  assert.equal(state.review.reviewer_family, 'fake');
  assert.equal(state.review.reviewer_ladder_tier, 'explicit');
  assert.equal(await git(fixture.repo, ['branch', '--show-current']), 'campaign/fixture');
  const status = await git(fixture.repo, ['status', '--short']);
  assert.equal(status, '');
  assert.equal(await git(fixture.repo, ['log', '-1', '--pretty=%s']), 'Complete campaign step 1.2', status);
});

test('sequential step ranges span every worker commit and exclude the later checkbox commit', async (t) => {
  const fixture = await makeFixture(t, {
    runnerScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const prompt = process.argv[1];
      const step = prompt.match(/^Step: ([^ ]+)/m)[1];
      const files = step === '1.1' ? ['first-a.txt', 'first-b.txt'] : ['second.txt'];
      for (const file of files) {
        fs.writeFileSync(file, file + '\\n');
        execFileSync('git', ['add', file]);
        execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Add ' + file]);
      }
      process.stdout.write(prompt);
    `,
  });

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const first = result.state.steps.find((step) => step.id === '1.1').commit_range;
  const second = result.state.steps.find((step) => step.id === '1.2').commit_range;

  assert.equal(await git(fixture.repo, ['rev-list', '--count', `${first.base_oid}..${first.head_oid}`]), '2');
  assert.equal(await git(fixture.repo, ['rev-list', '--count', `${second.base_oid}..${second.head_oid}`]), '1');
  assert.deepEqual(
    (await git(fixture.repo, ['diff', '--name-only', first.base_oid, first.head_oid])).split('\n'),
    ['first-a.txt', 'first-b.txt'],
  );
  assert.doesNotMatch(await git(fixture.repo, ['diff', '--name-only', first.base_oid, first.head_oid]), /campaign\.md/);
});

test('default runs isolate an ignored campaign, use its canonical source, and prune after finalize', async (t) => {
  const fixture = await makeFixture(t, {
    worktree: true,
    gitignoredCampaign: true,
    runnerScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const prompt = process.argv[1];
      const source = prompt.match(/^Campaign: (.+)$/m)?.[1];
      const step = prompt.match(/^Step: ([^ ]+)/m)?.[1];
      if (!source || !step || !fs.readFileSync(source, 'utf8').includes('# Fixture campaign')) process.exit(7);
      const output = 'runner-cwd-' + step + '.txt';
      fs.writeFileSync(output, process.cwd() + '\\n');
      execFileSync('git', ['add', output]);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Record isolated runner cwd']);
      process.stdout.write(prompt);
    `,
    reviewScript: `
      const fs = require('node:fs');
      const prompt = process.argv[1];
      const source = prompt.match(/^Campaign source: (.+)$/m)?.[1];
      if (!source || !fs.existsSync(source)) process.exit(8);
      process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nReview cwd: ' + process.cwd() + '\\nCampaign source: ' + source);
    `,
  });
  const before = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const after = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
  const markdown = await readFile(fixture.campaignPath, 'utf8');
  const runnerCwd = (await readFile(path.join(fixture.repo, 'runner-cwd-1.1.txt'), 'utf8')).trim();
  const review = await readFile(result.finalReviewPath, 'utf8');
  const tracked = await git(fixture.repo, ['ls-tree', '-r', '--name-only', 'HEAD']);

  assert.notEqual(runnerCwd, fixture.repo);
  assert.equal(path.basename(result.state.run.identity.execution.repo_root), path.basename(runnerCwd));
  assert.equal(result.state.run.identity.source.campaign_path, await realpath(fixture.campaignPath));
  assert.match(markdown, /- \[x\] Step 1\.1/);
  assert.match(review, new RegExp(`Campaign source: ${escapeRegex(result.state.run.identity.source.campaign_path)}`));
  assert.doesNotMatch(tracked, /(^|\n)campaign\.md$/);
  assert.deepEqual(after, before);
  assert.ok(result.state.artifacts.worktree.pruned_at);
});

test('reciprocal siblings run concurrently to the configured cap, join, and prune', async (t) => {
  const checkCommand = `node -e "const fs=require('node:fs');const cp=require('node:child_process');const path=require('node:path');for(const id of ['1.1','1.2','1.3'])if(!fs.existsSync('result-'+id+'.txt'))process.exit(8);const gitDir=cp.execFileSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8'}).trim();fs.appendFileSync(path.resolve(gitDir,'parallel-check-count'),'1\\n');process.stdout.write('joined')"`;
  const fixture = await makeFixture(t, {
    worktree: true,
    maxParallelSteps: 2,
    campaignText: parallelCampaignMarkdown({
      threeSteps: true,
      check: { command: checkCommand, expectedOutput: 'joined' },
    }),
    runnerScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const prompt = process.argv[1];
      const step = prompt.match(/^Step: ([^ ]+)/m)[1];
      const trackerPath = process.env.PARALLEL_TRACKER;
      const lockPath = trackerPath + '.lock';
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const update = (fn) => {
        while (true) { try { fs.mkdirSync(lockPath); break; } catch { pause(3); } }
        try {
          const value = fs.existsSync(trackerPath)
            ? JSON.parse(fs.readFileSync(trackerPath, 'utf8'))
            : { active: 0, max: 0, events: [], counts: {} };
          fn(value);
          fs.writeFileSync(trackerPath, JSON.stringify(value));
          return value;
        } finally { fs.rmdirSync(lockPath); }
      };
      const started = update((value) => {
        value.counts[step] = (value.counts[step] || 0) + 1;
        if (step === '2.1' && !['1.1','1.2','1.3'].every((id) => value.events.includes('end:' + id))) {
          value.joinViolation = true;
        }
        if (step === '2.1') {
          const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
          const checkCountPath = require('node:path').resolve(common, 'parallel-check-count');
          const checks = fs.existsSync(checkCountPath)
            ? fs.readFileSync(checkCountPath, 'utf8').trim().split('\\n').filter(Boolean).length
            : 0;
          if (checks !== 1) value.joinViolation = true;
        }
        value.active += 1;
        value.max = Math.max(value.max, value.active);
        value.events.push('start:' + step);
      });
      if (started.joinViolation) process.exit(9);
      pause(step === '2.1' ? 20 : 180);
      fs.writeFileSync('result-' + step + '.txt', step + '\\n');
      execFileSync('git', ['add', 'result-' + step + '.txt']);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Complete ' + step]);
      update((value) => { value.active -= 1; value.events.push('end:' + step); });
      process.stdout.write(prompt);
    `,
  });
  const trackerPath = path.join(fixture.root, 'parallel-tracker.json');
  fixture.options.env.PARALLEL_TRACKER = trackerPath;
  const before = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));

  const result = await runCampaign(fixture.campaignPath, fixture.options);

  const tracker = JSON.parse(await readFile(trackerPath, 'utf8'));
  const after = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
  assert.equal(tracker.max, 2);
  assert.equal(tracker.joinViolation, undefined);
  assert.deepEqual(tracker.counts, { '1.1': 1, '1.2': 1, '1.3': 1, '2.1': 1 });
  assert.deepEqual(after, before);
  assert.equal(result.state.config.max_parallel_steps, 2);
  assert.equal(result.state.steps[0].parallel.is_parallel, true);
  assert.deepEqual(result.state.steps[0].lane, { globs: ['result-1.1.txt'] });
  assert.equal(result.state.artifacts.parallel_worktrees.length, 3);
  assert.ok(result.state.artifacts.parallel_worktrees.every((worktree) => worktree.pruned_at));
  const parallelSteps = result.state.steps.filter((step) => ['1.1', '1.2', '1.3'].includes(step.id));
  assert.equal(new Set(parallelSteps.map((step) => step.parallel_group.id)).size, 1);
  assert.deepEqual(parallelSteps[0].parallel_group.step_ids, ['1.1', '1.2', '1.3']);
  for (const step of parallelSteps) {
    assert.equal(
      await git(fixture.repo, ['diff', '--name-only', step.commit_range.base_oid, step.commit_range.head_oid]),
      `result-${step.id}.txt`,
    );
  }
  assert.deepEqual(
    result.state.history.filter((entry) => entry.event === 'parallel_step_merged').map((entry) => entry.step_id),
    ['1.1', '1.2', '1.3'],
  );
  const checkCount = await readFile(path.join(fixture.repo, '.git', 'parallel-check-count'), 'utf8');
  assert.equal(checkCount, '1\n1\n');
});

test('a failed parallel member preserves its clean sibling and retries alone', async (t) => {
  const fixture = await makeFixture(t, {
    worktree: true,
    campaignText: parallelCampaignMarkdown(),
    runnerScript: `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const prompt = process.argv[1];
      const step = prompt.match(/^Step: ([^ ]+)/m)[1];
      const countsPath = process.env.PARALLEL_COUNTS;
      const lockPath = countsPath + '.lock';
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (true) { try { fs.mkdirSync(lockPath); break; } catch { pause(3); } }
      const counts = fs.existsSync(countsPath) ? JSON.parse(fs.readFileSync(countsPath, 'utf8')) : {};
      counts[step] = (counts[step] || 0) + 1;
      fs.writeFileSync(countsPath, JSON.stringify(counts));
      fs.rmdirSync(lockPath);
      if (step === '1.2' && !fs.existsSync(process.env.PARALLEL_FAILURE_ONCE)) {
        fs.writeFileSync(process.env.PARALLEL_FAILURE_ONCE, 'failed once');
        process.exit(7);
      }
      fs.writeFileSync('result-' + step + '.txt', step + '\\n');
      execFileSync('git', ['add', 'result-' + step + '.txt']);
      execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Complete ' + step]);
      process.stdout.write(prompt);
    `,
  });
  const countsPath = path.join(fixture.root, 'parallel-counts.json');
  fixture.options.env.PARALLEL_COUNTS = countsPath;
  fixture.options.env.PARALLEL_FAILURE_ONCE = path.join(fixture.root, 'failure-once');

  await assert.rejects(runCampaign(fixture.campaignPath, fixture.options), /Runner exited with code 7/);
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  const failed = JSON.parse(await readFile(paths.statePath, 'utf8'));
  const markdownAfterFailure = await readFile(fixture.campaignPath, 'utf8');
  const registeredAfterFailure = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
  assert.match(markdownAfterFailure, /- \[x\] Step 1\.1/);
  assert.match(markdownAfterFailure, /- \[ \] Step 1\.2/);
  assert.equal(failed.steps.find((step) => step.id === '1.1').status, 'completed');
  assert.equal(failed.steps.find((step) => step.id === '1.2').status, 'failed');
  assert.ok(failed.artifacts.parallel_worktrees.every((worktree) => worktree.pruned_at));
  assert.equal(registeredAfterFailure.some((line) => line.includes('/parallel-')), false);
  assert.ok(failed.artifacts.worktree.pruned_at);
  assert.equal(
    `${await git(fixture.repo, ['show', `${failed.artifacts.worktree.branch}:result-1.1.txt`])}\n`,
    '1.1\n',
  );

  const result = await runCampaign(fixture.campaignPath, fixture.options);
  const counts = JSON.parse(await readFile(countsPath, 'utf8'));
  assert.ok(['completed', 'merged'].includes(result.state.run.status));
  assert.deepEqual(counts, { '1.1': 1, '1.2': 2, '2.1': 1 });
  assert.ok(result.state.history.some((entry) => (
    entry.event === 'parallel_group_demoted' && /already-completed Step 1\.1/.test(entry.message)
  )));
});

test('overlapping and missing lanes demote parallel groups visibly and still complete', async (t) => {
  for (const [name, campaignText, reason] of [
    [
      'overlap',
      parallelCampaignMarkdown().replace('Lane: `result-1.2.txt`', 'Lane: `result-1.1.txt`'),
      /overlapping lanes/,
    ],
    [
      'missing',
      parallelCampaignMarkdown().replace('Lane: `result-1.2.txt`\n', ''),
      /missing or has an unparseable Lane/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t, { worktree: true, campaignText });
      const before = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
      const result = await runCampaign(fixture.campaignPath, fixture.options);
      const after = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
      const demotion = result.state.history.find((entry) => entry.event === 'parallel_group_demoted');

      assert.ok(['completed', 'merged'].includes(result.state.run.status));
      assert.match(demotion?.message || '', reason);
      assert.deepEqual(after, before);
    });
  }
});

test('stopping a parallel group terminates every worker group and prunes every child worktree', async (t) => {
  const fixture = await makeFixture(t, {
    worktree: true,
    stopGraceMs: 50,
    campaignText: parallelCampaignMarkdown(),
    watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
    runnerScript: `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const step = process.argv[1].match(/^Step: ([^ ]+)/m)[1];
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.PARALLEL_PID_DIR + '/' + step + '.json', JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
    `,
  });
  const pidDir = path.join(fixture.root, 'pids');
  await mkdir(pidDir);
  fixture.options.env.PARALLEL_PID_DIR = pidDir;
  const before = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));
  const running = runCampaign(fixture.campaignPath, fixture.options);
  const paths = runPathsForCampaign(fixture.campaignPath, fixture.runsDir);
  await waitFor(async () => {
    const active = await readOptional(paths.statePath);
    return active?.workers?.length === 2
      && await readTextOptional(path.join(pidDir, '1.1.json'))
      && await readTextOptional(path.join(pidDir, '1.2.json'));
  });
  const active = await readOptional(paths.statePath);
  const workerPids = active.workers.map((worker) => worker.pid);
  const processPids = [];
  for (const stepId of ['1.1', '1.2']) {
    const value = JSON.parse(await readFile(path.join(pidDir, `${stepId}.json`), 'utf8'));
    processPids.push(value.parent, value.child);
  }

  await requestCampaignStop(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    stopGraceMs: 50,
    waitTimeoutMs: 4_000,
  });
  const result = await running;
  await waitFor(() => [...workerPids, ...processPids].every((pid) => !isPidAlive(pid)));
  const after = worktreePaths(await git(fixture.repo, ['worktree', 'list', '--porcelain']));

  assert.equal(result.state.run.status, 'stopped_by_user');
  assert.deepEqual(result.state.workers, []);
  assert.ok(result.state.artifacts.parallel_worktrees.every((worktree) => worktree.pruned_at));
  assert.deepEqual(after, before);
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
  checkFixScript = null,
  campaignText = null,
  watchdog = null,
  maxFixAttempts = 2,
  forceMergeUnreviewed = false,
  maxStepsPerRun = 50,
  maxRunMinutes = 360,
  maxCostUsd = null,
  costUsd = null,
  stopGraceMs = 3_000,
  maxParallelSteps = 2,
  reviewer = 'fake',
  additionalRunners = {},
  divergeTarget = false,
  runnerOutputFile = false,
  worktree = false,
  gitignoredCampaign = false,
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
  await writeFile(campaignPath, campaignText ?? campaignMarkdown(firstChecked), 'utf8');
  if (gitignoredCampaign) await writeFile(path.join(repo, '.gitignore'), 'campaign.md\n', 'utf8');
  await writeConfig(configPath, {
    branch,
    delayMs,
    runnerScript,
    reviewScript,
    fixScript,
    checkFixScript,
    watchdog,
    maxFixAttempts,
    forceMergeUnreviewed,
    maxStepsPerRun,
    maxRunMinutes,
    maxCostUsd,
    costUsd,
    stopGraceMs,
    maxParallelSteps,
    reviewer,
    additionalRunners,
    runnerOutputFile,
  });
  await git(repo, ['add', gitignoredCampaign ? '.gitignore' : 'campaign.md']);
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
      noWorktree: !worktree,
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

function runnerPluginCampaignMarkdown() {
  return `# Runner plugin fixture

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Plugin step
- [ ] Final review

## Step 1.1 — Plugin step

\`\`\`text
Complete the plugin fixture.
\`\`\`

## Final review

\`\`\`text
Review the plugin fixture.
\`\`\`
`;
}

function parallelCampaignMarkdown({ check = null, threeSteps = false } = {}) {
  const sibling = threeSteps ? 'Steps 1.2 and 1.3' : 'Step 1.2';
  const reverse = threeSteps ? 'Steps 1.1 and 1.3' : 'Step 1.1';
  const third = threeSteps ? `- [ ] Step 1.3 — Third\n` : '';
  const thirdSection = threeSteps ? `
## Step 1.3 — Third

Model: Fake · None
Parallel: YES — with Steps 1.1 and 1.2
Lane: \`result-1.3.txt\`

\`\`\`text
Create the third fixture result.
\`\`\`
` : '';
  return `# Parallel fixture campaign

## Progress checklist

### Phase 1 — Parallel build

- [ ] Step 1.1 — First
- [ ] Step 1.2 — Second
${third}- [ ] Step 2.1 — Join proof
- [ ] Final review

## Step 1.1 — First

Model: Fake · None
Parallel: YES — with ${sibling}
Lane: \`result-1.1.txt\`

\`\`\`text
Create the first fixture result.${check ? `\nCHECK: ${JSON.stringify(check)}` : ''}
\`\`\`

## Step 1.2 — Second

Model: Fake · None
Parallel: YES — with ${reverse}
Lane: \`result-1.2.txt\`

\`\`\`text
Create the second fixture result.
\`\`\`
${thirdSection}
## Step 2.1 — Join proof

Model: Fake · None
Parallel: NO
Lane: \`result-2.1.txt\`

\`\`\`text
Verify the phase joined before this step starts.
\`\`\`

## Final review

\`\`\`text
Review the fixture.
\`\`\`
`;
}

function missingRunner(family) {
  return {
    family,
    binary: path.join(tmpdir(), `campaigns-unavailable-${family}-runner`),
    args: [],
    prompt: { delivery: 'stdin' },
    defaults: { model: `${family}-model`, effort: 'none' },
    effortMap: { none: 'none' },
    environment: { remove: [] },
    completion: {
      marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
      sources: [{ kind: 'text' }],
    },
  };
}

async function writeConfig(configPath, {
  branch = null,
  delayMs = 0,
  runnerScript = null,
  reviewScript = null,
  fixScript = null,
  checkFixScript = null,
  watchdog = null,
  maxFixAttempts = 2,
  forceMergeUnreviewed = false,
  maxStepsPerRun = 50,
  maxRunMinutes = 360,
  maxCostUsd = null,
  costUsd = null,
  stopGraceMs = 3_000,
  maxParallelSteps = 2,
  reviewer = 'fake',
  additionalRunners = {},
  runnerOutputFile = false,
} = {}) {
  const stepScript = runnerScript ?? (delayMs > 0
    ? `setTimeout(() => process.stdout.write(process.argv[1]), ${delayMs})`
    : 'process.stdout.write(process.argv[1])');
  const finalReviewScript = reviewScript
    ?? "process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nEverything landed.')";
  const finalFixScript = fixScript ?? "process.stdout.write('No fix commit produced.')";
  const executableCheckFixScript = checkFixScript
    ?? "process.stdout.write('No executable-check fix commit produced.')";
  const script = `
    ${costUsd == null ? '' : `process.stdout.write(JSON.stringify({type:'usage',cost_usd:${costUsd}})+'\\n');`}
    if (process.argv[1].includes('campaigns.step_completed')) {
      ${stepScript}
    } else if (process.argv[1].startsWith('Fix the executable-check failures')) {
      ${executableCheckFixScript}
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
      max_cost_usd: maxCostUsd,
      stop_grace_ms: stopGraceMs,
      max_parallel_steps: maxParallelSteps,
    },
    review: { reviewer, maxFixAttempts, forceMergeUnreviewed },
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
        ...(costUsd == null ? {} : {
          usage: {
            sources: [{
              kind: 'jsonl',
              match: { type: 'usage' },
              fields: { cost_usd: 'cost_usd' },
            }],
          },
        }),
      },
      ...additionalRunners,
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

async function pathExistsForTest(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function worktreePaths(porcelain) {
  return String(porcelain).split('\n').filter((line) => line.startsWith('worktree '));
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

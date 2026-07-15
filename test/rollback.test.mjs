import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runCampaign, runPathsForCampaign } from '../lib/pump.mjs';
import { RollbackConflictError, RollbackError, rollbackCampaign } from '../lib/rollback.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('bin/campaigns.mjs');

test('rollback rewinds later ranges, unchecks markdown, restores a pruned execution worktree, and writes one receipt', async (t) => {
  const fixture = await makeSequentialFixture(t, { pruned: true });
  const result = await rollbackCampaign(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    to: '2.1',
  });
  const state = JSON.parse(await readFile(fixture.paths.statePath, 'utf8'));
  const markdown = await readFile(fixture.campaignPath, 'utf8');

  assert.equal(result.boundary, '2.1');
  assert.deepEqual(result.resetSteps, ['2.2', '2.3']);
  assert.equal(state.run.status, 'running');
  assert.equal(state.steps.find((step) => step.id === '2.1').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === '2.2').status, 'pending');
  assert.equal(state.steps.find((step) => step.id === '2.3').status, 'pending');
  assert.equal(state.artifacts.worktree.pruned_at, null);
  assert.doesNotMatch(markdown, /- \[x\] Step 2\.2/);
  assert.doesNotMatch(markdown, /- \[x\] Step 2\.3/);
  await assert.rejects(readFile(path.join(fixture.executionPath, 'result-2.2.txt'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(fixture.executionPath, 'result-2.3.txt'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(fixture.executionPath, 'result-2.1.txt'), 'utf8'), '2.1\n');
  const receipt = await readFile(result.receiptPath, 'utf8');
  assert.match(receipt, /Step 2\.2/);
  assert.match(receipt, /Created rollback commits/);
  assert.match(receipt, /git revert --no-edit/);
  assert.equal(state.rollbacks.length, 1);
  assert.equal(state.rollbacks[0].receipt_path, result.receiptPath);

  const configPath = await writeRunnerConfig(fixture.root);
  const resumed = await runCampaign(fixture.campaignPath, {
    runsDir: fixture.runsDir,
    configPath,
    env: { ...process.env, CAMPAIGNS_CONFIG_DIR: path.join(fixture.root, 'user-config') },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.ok(['completed', 'merged'].includes(resumed.state.run.status));
  assert.equal(resumed.state.steps.find((step) => step.id === '2.2').attempt, 2);
  assert.equal(resumed.state.steps.find((step) => step.id === '2.3').attempt, 2);
  assert.equal(await readFile(path.join(fixture.repo, 'resumed-2.2.txt'), 'utf8'), '2.2\n');
});

test('rollback retries converge after intent, Git, and markdown interruptions without duplicate reverts', async (t) => {
  for (const failAfter of ['intent', 'git', 'markdown']) {
    const fixture = await makeSequentialFixture(t);
    await assert.rejects(
      rollbackCampaign(fixture.campaignPath, {
        runsDir: fixture.runsDir,
        to: '2.1',
        failAfter,
      }),
      (error) => error instanceof RollbackError && error.injected === failAfter,
    );

    const result = await rollbackCampaign(fixture.campaignPath, {
      runsDir: fixture.runsDir,
      to: '2.1',
    });
    const subjects = (await git(fixture.repo, [
      'log', result.state.run.identity.execution.branch, '--format=%s', '--grep=Campaigns rollback',
    ])).split('\n').filter((line) => /: revert /.test(line));
    assert.equal(subjects.length, 2, failAfter);
    assert.equal(new Set(subjects).size, 2, failAfter);
    assert.equal(result.state.run.status, 'running', failAfter);
  }
});

test('campaigns rollback CLI executes the same transaction and prints its receipt', async (t) => {
  const fixture = await makeSequentialFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'rollback',
    fixture.campaignPath,
    '--to',
    '2.1',
    '--state-dir',
    fixture.runsDir,
  ], { encoding: 'utf8' });
  const state = JSON.parse(await readFile(fixture.paths.statePath, 'utf8'));
  assert.match(stdout, /Rolled back to Step 2\.1/);
  assert.match(stdout, /Receipt:/);
  assert.equal(state.steps.find((step) => step.id === '2.2').status, 'pending');
});

test('parallel merge topology rolls back as one unit and a parallel target retains its whole group', async (t) => {
  const groupFixture = await makeParallelFixture(t);
  const groupResult = await rollbackCampaign(groupFixture.campaignPath, {
    runsDir: groupFixture.runsDir,
    to: '0.1',
  });
  assert.deepEqual(groupResult.resetSteps, ['1.1', '1.2', '2.1']);
  for (const file of ['parallel-1.1.txt', 'parallel-1.2.txt', 'result-2.1.txt']) {
    await assert.rejects(readFile(path.join(groupFixture.executionPath, file), 'utf8'), { code: 'ENOENT' });
  }
  assert.equal(await readFile(path.join(groupFixture.executionPath, 'result-0.1.txt'), 'utf8'), '0.1\n');

  const boundaryFixture = await makeParallelFixture(t);
  const boundaryResult = await rollbackCampaign(boundaryFixture.campaignPath, {
    runsDir: boundaryFixture.runsDir,
    to: '1.1',
  });
  assert.equal(boundaryResult.boundary, '1.2');
  assert.deepEqual(boundaryResult.resetSteps, ['2.1']);
  assert.equal(await readFile(path.join(boundaryFixture.executionPath, 'parallel-1.2.txt'), 'utf8'), '1.2\n');
});

test('a revert conflict leaves execution Git and markdown unchanged in a retryable state', async (t) => {
  const fixture = await makeSequentialFixture(t, { conflict: true });
  const beforeHead = await git(fixture.repo, ['rev-parse', fixture.branch]);
  const beforeMarkdown = await readFile(fixture.campaignPath, 'utf8');

  await assert.rejects(
    rollbackCampaign(fixture.campaignPath, { runsDir: fixture.runsDir, to: '2.2' }),
    RollbackConflictError,
  );

  const state = JSON.parse(await readFile(fixture.paths.statePath, 'utf8'));
  assert.equal(state.run.status, 'rollback_conflict');
  assert.equal(state.rollback.status, 'conflict');
  assert.equal(await git(fixture.repo, ['rev-parse', fixture.branch]), beforeHead);
  assert.equal(await readFile(fixture.campaignPath, 'utf8'), beforeMarkdown);
  assert.match(state.rollback.conflict.message, /conflict/i);
});

test('rollback refuses live locks and merged campaign results with direct remedies', async (t) => {
  const live = await makeSequentialFixture(t);
  await writeFile(live.paths.lockPath, `${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
  await assert.rejects(
    rollbackCampaign(live.campaignPath, { runsDir: live.runsDir, to: '2.1' }),
    /Stop it before rolling back/,
  );
  await rm(live.paths.lockPath, { force: true });

  const merged = await makeSequentialFixture(t);
  let state = JSON.parse(await readFile(merged.paths.statePath, 'utf8'));
  state = transitionRunState(state, { event: 'final_review_started' });
  await writeFile(merged.paths.finalReviewPath, 'Verdict: APPROVED\nReasons:\n', 'utf8');
  state = transitionRunState(state, {
    event: 'final_review_approved',
    review_path: merged.paths.finalReviewPath,
  });
  state = transitionRunState(state, { event: 'campaign_merged' });
  await writeFile(merged.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await assert.rejects(
    rollbackCampaign(merged.campaignPath, { runsDir: merged.runsDir, to: '2.1' }),
    /already merged.*Start a new campaign/i,
  );
});

async function makeSequentialFixture(t, { pruned = false, conflict = false } = {}) {
  const ids = ['1.1', '2.1', '2.2', '2.3'];
  const fixture = await makeBaseFixture(t, ids);
  const records = [];
  for (const id of ids) {
    const base_oid = await git(fixture.executionPath, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.executionPath, `result-${id}.txt`), `${id}\n`, 'utf8');
    await git(fixture.executionPath, ['add', `result-${id}.txt`]);
    await git(fixture.executionPath, ['commit', '-m', `Complete Step ${id}`]);
    records.push({ id, base_oid, head_oid: await git(fixture.executionPath, ['rev-parse', 'HEAD']) });
  }
  if (conflict) {
    await writeFile(path.join(fixture.executionPath, 'result-2.3.txt'), 'changed after the step\n', 'utf8');
    await git(fixture.executionPath, ['add', 'result-2.3.txt']);
    await git(fixture.executionPath, ['commit', '-m', 'Advance conflicting result']);
  }
  await writeLedger(fixture, records);
  if (pruned) {
    await git(fixture.repo, ['worktree', 'remove', fixture.executionPath]);
    await git(fixture.repo, ['worktree', 'prune']);
    const state = JSON.parse(await readFile(fixture.paths.statePath, 'utf8'));
    state.artifacts.worktree.pruned_at = new Date().toISOString();
    await writeFile(fixture.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
  return fixture;
}

async function makeParallelFixture(t) {
  const ids = ['0.1', '1.1', '1.2', '2.1'];
  const fixture = await makeBaseFixture(t, ids);
  const base0 = await git(fixture.executionPath, ['rev-parse', 'HEAD']);
  await writeFile(path.join(fixture.executionPath, 'result-0.1.txt'), '0.1\n', 'utf8');
  await git(fixture.executionPath, ['add', 'result-0.1.txt']);
  await git(fixture.executionPath, ['commit', '-m', 'Complete Step 0.1']);
  const head0 = await git(fixture.executionPath, ['rev-parse', 'HEAD']);

  const childRecords = [];
  for (const id of ['1.1', '1.2']) {
    const branch = `parallel-${id}-${path.basename(fixture.root)}`;
    const childPath = path.join(fixture.root, `child-${id}`);
    await git(fixture.repo, ['worktree', 'add', '-b', branch, childPath, head0]);
    await writeFile(path.join(childPath, `parallel-${id}.txt`), `${id}\n`, 'utf8');
    await git(childPath, ['add', `parallel-${id}.txt`]);
    await git(childPath, ['commit', '-m', `Complete parallel Step ${id}`]);
    childRecords.push({
      id,
      branch,
      childPath,
      base_oid: head0,
      head_oid: await git(childPath, ['rev-parse', 'HEAD']),
    });
  }
  for (const child of childRecords) await git(fixture.executionPath, ['merge', '--no-edit', child.branch]);
  for (const child of childRecords) {
    await git(fixture.repo, ['worktree', 'remove', child.childPath]);
    await git(fixture.repo, ['branch', '-D', child.branch]);
  }

  const base2 = await git(fixture.executionPath, ['rev-parse', 'HEAD']);
  await writeFile(path.join(fixture.executionPath, 'result-2.1.txt'), '2.1\n', 'utf8');
  await git(fixture.executionPath, ['add', 'result-2.1.txt']);
  await git(fixture.executionPath, ['commit', '-m', 'Complete Step 2.1']);
  const head2 = await git(fixture.executionPath, ['rev-parse', 'HEAD']);
  const group = { id: 'group-1', step_ids: ['1.1', '1.2'] };
  await writeLedger(fixture, [
    { id: '0.1', base_oid: base0, head_oid: head0 },
    { ...childRecords[0], parallel_group: group },
    { ...childRecords[1], parallel_group: group },
    { id: '2.1', base_oid: base2, head_oid: head2 },
  ]);
  return fixture;
}

async function makeBaseFixture(t, ids) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const runsDir = path.join(root, 'runs');
  const campaignPath = path.join(repo, 'campaign.md');
  const executionPath = path.join(root, 'execution');
  const branch = `campaigns/run-${path.basename(root)}`;
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, campaignMarkdown(ids), 'utf8');
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add campaign']);
  await git(repo, ['worktree', 'add', '-b', branch, executionPath, 'main']);
  const paths = runPathsForCampaign(campaignPath, runsDir);
  await mkdir(paths.receiptsDir, { recursive: true });
  return { root, repo, runsDir, campaignPath, executionPath, branch, paths, ids };
}

async function writeLedger(fixture, records) {
  let state = createRunState({
    id: `run-${path.basename(fixture.root)}`,
    identity: {
      registry_id: 'rollback-fixture',
      source: { campaign_path: fixture.campaignPath, repo_root: fixture.repo },
      execution: {
        campaign_path: path.join(fixture.executionPath, 'campaign.md'),
        repo_root: fixture.executionPath,
        branch: fixture.branch,
        merge_target_branch: 'main',
        merge_target_repo_root: fixture.repo,
      },
    },
    steps: fixture.ids.map((id) => ({ id, name: `Step ${id}`, phase: id.split('.')[0] })),
    config: {
      runner: 'fake',
      model: 'fake',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
      worktree_enabled: true,
    },
    artifacts: {
      run_dir: fixture.paths.runDir,
      receipts_dir: fixture.paths.receiptsDir,
      final_review_path: fixture.paths.finalReviewPath,
      worktree: {
        path: fixture.executionPath,
        branch: fixture.branch,
        base_branch: 'main',
        created_at: new Date().toISOString(),
        cleanup_deadline: null,
        pruned_at: null,
      },
      parallel_worktrees: [],
    },
  });
  state = transitionRunState(state, { event: 'run_started' });
  for (const record of records) {
    const receiptPath = path.join(fixture.paths.receiptsDir, `${record.id}.md`);
    await writeFile(receiptPath, `# Step ${record.id} receipt\n`, 'utf8');
    state = transitionRunState(state, {
      event: 'step_started',
      step_id: record.id,
      worker: { runner: 'fake', invocation_id: `worker-${record.id}`, pid: null, log_path: null },
    });
    state = transitionRunState(state, {
      event: 'step_completed',
      step_id: record.id,
      receipt_path: receiptPath,
      commit_range: { base_oid: record.base_oid, head_oid: record.head_oid },
      parallel_group: record.parallel_group ?? null,
    });
  }
  state = transitionRunState(state, { event: 'run_reached_final_review' });
  await writeFile(fixture.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function campaignMarkdown(ids) {
  return `# Rollback fixture

## Progress checklist

${ids.map((id) => `- [x] Step ${id} — Step ${id}`).join('\n')}
- [ ] Final review

${ids.map((id) => `## Step ${id} — Step ${id}\n\n\`\`\`text\nImplement Step ${id}.\n\`\`\``).join('\n\n')}

## Final review

\`\`\`text
Review the fixture.
\`\`\`
`;
}

async function writeRunnerConfig(root) {
  const configPath = path.join(root, 'campaigns.config.json');
  const script = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const prompt = process.argv[1];
    if (prompt.includes('campaigns.step_completed')) {
      const id = prompt.match(/Step: ([0-9.]+)/)?.[1];
      fs.writeFileSync('resumed-' + id + '.txt', id + '\\n');
      cp.execFileSync('git', ['add', 'resumed-' + id + '.txt']);
      cp.execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Resume Step ' + id]);
      process.stdout.write(prompt);
    } else {
      process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nRollback resume verified.');
    }
  `;
  const config = {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    runners: {
      fake: {
        binary: process.execPath,
        args: ['-e', script, '{prompt}'],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fake', effort: 'none' },
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
  return configPath;
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  campaignStateMatchesFile,
  chooseAutomateState,
  countAutomationProgress,
  deriveEngineRuntime,
  deriveCodexRuntime,
  findEngineStatePath,
  findCodexStatePath,
  getAutomateState,
  resolveEngineLiveOutput,
} from '../lib/automate-providers.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';

function runtime(overrides = {}) {
  return deriveCodexRuntime({
    stateData: { campaign: { status: 'active' } },
    activeRun: null,
    pendingAutomation: null,
    registry: null,
    run: null,
    lock: null,
    sessionStat: null,
    maxMinutes: 60,
    runDirMissing: false,
    ...overrides,
  });
}

test('fresh session activity keeps an expired active_run visually running', () => {
  const result = runtime({
    activeRun: { automation_id: 'run-1', expired: true },
    sessionStat: { mtimeMs: Date.now() - 1_000 },
  });

  assert.deepEqual(result, { status: 'active', isActive: true });
});

test('stale active_run without fresh session proof becomes stalled', () => {
  const result = runtime({
    activeRun: { automation_id: 'run-1', expired: true },
    sessionStat: { mtimeMs: Date.now() - 20 * 60_000 },
  });

  assert.deepEqual(result, { status: 'stalled', isActive: false });
});

test('failed campaign without live worker proof stays a failure state', () => {
  const result = runtime({
    stateData: { campaign: { status: 'failed' } },
  });

  assert.deepEqual(result, { status: 'failed', isActive: false });
});

test('awaiting human review stays a visible engine attention status', () => {
  assert.deepEqual(
    deriveEngineRuntime({ run: { status: 'awaiting_human_review' } }, null),
    { status: 'awaiting_human_review', isActive: false },
  );
});

test('run caps and user stops stay distinct engine attention statuses', () => {
  assert.deepEqual(
    deriveEngineRuntime({ run: { status: 'cap_reached' } }, null),
    { status: 'cap_reached', isActive: false },
  );
  assert.deepEqual(
    deriveEngineRuntime({ run: { status: 'stopped_by_user' } }, null),
    { status: 'stopped_by_user', isActive: false },
  );
});

test('provider arbitration lets a live worker beat a stale warning', () => {
  const winner = chooseAutomateState([
    {
      provider: { name: 'claude' },
      index: 0,
      state: { backend: 'claude', status: 'failed', is_active: false },
    },
    {
      provider: { name: 'codex' },
      index: 1,
      state: { backend: 'codex', status: 'active', is_active: true },
    },
  ]);

  assert.equal(winner.state.backend, 'codex');
});

test('active_run beats old warning state', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'active' },
      cursor: { step_id: '4.1' },
      history: [{ event: 'step_failed', step_id: '0.1', message: 'old failure' }],
    },
    activeRun: { automation_id: 'run-4-1', step_id: '4.1', expired: false },
  });

  assert.deepEqual(result, { status: 'active', isActive: true });
});

test('pending automation beats old warning state', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'active' },
      cursor: { step_id: '4.1' },
      history: [{ event: 'step_failed', step_id: '0.1', message: 'old failure' }],
    },
    pendingAutomation: {
      id: 'run-4-1',
      status: 'ACTIVE',
      expected_next: 'step 4.1 - Next implementation',
      step_id: '4.1',
    },
  });

  assert.deepEqual(result, { status: 'queued', isActive: false });
});

test('current unresolved issue still needs attention without active or pending work', () => {
  const result = runtime({
    stateData: {
      campaign: { status: 'blocked' },
      phase: 'blocked',
      cursor: { step_id: '4.1' },
      blockers: [{ message: 'Current step failed' }],
    },
  });

  assert.deepEqual(result, { status: 'failed', isActive: false });
});

test('stored worktree mapping identifies a campaign after the worktree is removed', async () => {
  const registered = '/tmp/project/campaigns/example.md';
  const state = {
    campaign: {
      campaign_path: '/tmp/project-worktrees/example/campaigns/example.md',
      repo_path: '/tmp/project-worktrees/example',
      worktree: {
        base_repo_path: '/tmp/project',
        path: '/tmp/project-worktrees/example',
        branch: 'campaign/example',
      },
    },
  };

  assert.equal(await campaignStateMatchesFile(registered, state), true);
  assert.equal(
    await campaignStateMatchesFile('/tmp/another-project/campaigns/example.md', state),
    false,
  );
});

test('registry identity wins while canonical paths survive re-registration', async () => {
  const filePath = '/tmp/project/campaigns/example.md';
  const state = {
    registry_id: 'campaign-a',
    source_campaign_path: filePath,
    campaign_path: filePath,
  };

  assert.equal(
    await campaignStateMatchesFile(filePath, state, { registryId: 'campaign-a' }),
    true,
  );
  assert.equal(
    await campaignStateMatchesFile(filePath, state, { registryId: 'campaign-b' }),
    true,
  );
  assert.equal(
    await campaignStateMatchesFile('/tmp/another-project/campaigns/example.md', state, {
      registryId: 'campaign-b',
    }),
    false,
  );
});

test('a newly created Codex state is discovered immediately after an initial miss', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-state-discovery-'));
  const campaignPath = path.join(sandbox, 'campaigns', 'example.md');
  const statePath = path.join(
    sandbox,
    'reports',
    'campaign-automation',
    'example',
    'state.json',
  );
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  await mkdir(path.dirname(campaignPath), { recursive: true });
  await writeFile(campaignPath, '# Example\n', 'utf8');

  assert.equal(await findCodexStatePath(campaignPath, 'campaign-a'), null);

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      campaign: {
        registry_id: 'campaign-a',
        source_campaign_path: campaignPath,
        campaign_path: campaignPath,
      },
    }),
    'utf8',
  );
  assert.equal(await findCodexStatePath(campaignPath, 'campaign-a'), statePath);
});

test('a registry id finds Codex state stored under an explicit custom slug', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-custom-slug-'));
  const campaignPath = path.join(sandbox, 'campaigns', 'example.md');
  const statePath = path.join(
    sandbox,
    'reports',
    'campaign-automation',
    'custom-automation-name',
    'state.json',
  );
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  await mkdir(path.dirname(campaignPath), { recursive: true });
  await writeFile(campaignPath, '# Example\n', 'utf8');

  assert.equal(await findCodexStatePath(campaignPath, 'campaign-custom'), null);

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      campaign: {
        registry_id: 'campaign-custom',
        source_campaign_path: campaignPath,
        campaign_path: campaignPath,
      },
    }),
    'utf8',
  );

  assert.equal(await findCodexStatePath(campaignPath, 'campaign-custom'), statePath);
});

test('Git worktrees match by shared repository and repo-relative campaign path', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-worktree-'));
  const repo = path.join(sandbox, 'repo');
  const worktree = path.join(sandbox, 'worktree');
  const alternate = path.join(sandbox, 'alternate');
  t.after(async () => rm(sandbox, { recursive: true, force: true }));

  await mkdir(path.join(repo, 'campaigns'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Campaigns Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'campaigns@example.invalid']);
  await writeFile(path.join(repo, 'campaigns', 'example.md'), '# Example\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'campaigns/example.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'campaign/example', worktree]);

  assert.equal(
    await campaignStateMatchesFile(path.join(repo, 'campaigns', 'example.md'), {
      campaign_path: path.join(worktree, 'campaigns', 'example.md'),
      repo_path: worktree,
      branch: 'campaign/example',
    }),
    true,
  );

  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'review/example', alternate]);
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
  assert.equal(
    await campaignStateMatchesFile(path.join(alternate, 'campaigns', 'example.md'), {
      campaign_path: path.join(worktree, 'campaigns', 'example.md'),
      repo_path: worktree,
      worktree: {
        base_repo_path: repo,
        path: worktree,
        branch: 'campaign/example',
      },
    }),
    true,
  );
});

test('campaign paths compare Unicode spellings canonically', async () => {
  const composed = '/tmp/m\u00f6ney/campaigns/example.md';
  const decomposed = '/tmp/mo\u0308ney/campaigns/example.md';
  assert.equal(
    await campaignStateMatchesFile(composed, { source_campaign_path: decomposed }),
    true,
  );
});

test('live progress counts only the authored progress checklist', () => {
  const markdown = `# Example

## Progress checklist

- [x] Step 1.1 — Done
- [ ] Step 1.2 — Next
- [ ] Final review

## Step 1.1 — Done

\`\`\`text
- [x] This prompt checkbox is not progress
\`\`\`
`;
  assert.deepEqual(countAutomationProgress(markdown), { done: 1, total: 3 });
});

test('new-engine provider discovers by run identity and maps awaiting review for the drawer', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-engine-provider-'));
  const repo = path.join(sandbox, 'repo');
  const campaignPath = path.join(repo, 'campaigns', 'hello.md');
  const runsDir = path.join(sandbox, 'state', 'runs');
  const runDir = path.join(runsDir, 'custom-run-name');
  const receiptsDir = path.join(runDir, 'receipts');
  const receiptOne = path.join(receiptsDir, '1.1-1.md');
  const receiptTwo = path.join(receiptsDir, '1.2-1.md');
  const previousRunsDir = process.env.CAMPAIGNS_RUNS_DIR;
  t.after(async () => {
    if (previousRunsDir === undefined) delete process.env.CAMPAIGNS_RUNS_DIR;
    else process.env.CAMPAIGNS_RUNS_DIR = previousRunsDir;
    await rm(sandbox, { recursive: true, force: true });
  });
  process.env.CAMPAIGNS_RUNS_DIR = runsDir;

  await mkdir(path.dirname(campaignPath), { recursive: true });
  await mkdir(receiptsDir, { recursive: true });
  await writeFile(campaignPath, `# Hello

## Progress checklist

- [x] Step 1.1 — First
- [x] Step 1.2 — Second
- [ ] Final review

## Step 1.1 — First

\`\`\`text
First prompt.
\`\`\`

## Step 1.2 — Second

\`\`\`text
Second prompt.
\`\`\`
`, 'utf8');
  await writeFile(receiptOne, '# First receipt\n', 'utf8');
  await writeFile(receiptTwo, '# Second receipt\n', 'utf8');

  let state = createRunState({
    id: 'run-1',
    identity: {
      registry_id: 'hello-registry',
      source: { campaign_path: campaignPath, repo_root: repo },
      execution: { campaign_path: campaignPath, repo_root: repo, branch: 'main' },
    },
    steps: [
      { id: '1.1', name: 'First', phase: '1' },
      { id: '1.2', name: 'Second', phase: '1' },
    ],
    config: {
      runner: 'claude',
      model: 'fixture',
      effort: 'high',
      watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
    },
    artifacts: { run_dir: runDir, receipts_dir: receiptsDir, final_review_path: null },
  });
  state = transitionRunState(state, { event: 'run_started' });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    worker: { runner: 'claude', invocation_id: 'worker-1', pid: null, log_path: null },
  });
  state = transitionRunState(state, {
    event: 'step_completed',
    step_id: '1.1',
    receipt_path: receiptOne,
    commit_range: { base_oid: '1'.repeat(40), head_oid: '2'.repeat(40) },
  });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.2',
    worker: { runner: 'claude', invocation_id: 'worker-2', pid: null, log_path: null },
  });
  state = transitionRunState(state, {
    event: 'step_completed',
    step_id: '1.2',
    receipt_path: receiptTwo,
    commit_range: { base_oid: '2'.repeat(40), head_oid: '3'.repeat(40) },
  });
  state = transitionRunState(state, { event: 'run_reached_final_review' });
  await writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  assert.equal(
    await findEngineStatePath(campaignPath, 'hello-registry', runsDir),
    path.join(runDir, 'state.json'),
  );
  const providerState = await getAutomateState(campaignPath, { registryId: 'hello-registry' });
  assert.equal(providerState.backend, 'engine');
  assert.equal(providerState.status, 'completed');
  assert.equal(providerState.run_status, 'awaiting_review');
  assert.deepEqual(providerState.progress, { done: 2, total: 3 });
  assert.deepEqual(providerState.steps.map((step) => step.status), ['done', 'done']);
  assert.match(providerState.steps[0].receipt, /First receipt/);
  assert.equal(providerState.steps[0].diff_url, '/api/run/step-diff?id=hello-registry&step=1.1');
  assert.deepEqual(providerState.steps[0].commit_range, {
    base_oid: '1'.repeat(40),
    head_oid: '2'.repeat(40),
  });
  assert.deepEqual(providerState.review.findings, []);
  assert.equal(providerState.rollback.available, true);
  assert.deepEqual(providerState.rollback.targets, [{
    step_id: '1.1',
    boundary_step_id: '1.1',
    reset_steps: ['1.2'],
    includes_parallel_group: false,
  }]);
  assert.equal(providerState.timeline_events.at(-1).event, 'run_reached_final_review');
});

test('engine provider exposes every concurrent step and log', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-engine-parallel-provider-'));
  const repo = path.join(sandbox, 'repo');
  const campaignPath = path.join(repo, 'campaign.md');
  const runsDir = path.join(sandbox, 'runs');
  const runDir = path.join(runsDir, 'parallel-run');
  const receiptsDir = path.join(runDir, 'receipts');
  const previousRunsDir = process.env.CAMPAIGNS_RUNS_DIR;
  t.after(async () => {
    if (previousRunsDir === undefined) delete process.env.CAMPAIGNS_RUNS_DIR;
    else process.env.CAMPAIGNS_RUNS_DIR = previousRunsDir;
    await rm(sandbox, { recursive: true, force: true });
  });
  process.env.CAMPAIGNS_RUNS_DIR = runsDir;
  await mkdir(repo, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });
  await writeFile(campaignPath, `# Parallel

## Progress checklist

- [ ] Step 1.1 — First
- [ ] Step 1.2 — Second
- [ ] Final review

## Step 1.1 — First

\`\`\`text
First prompt.
\`\`\`

## Step 1.2 — Second

\`\`\`text
Second prompt.
\`\`\`
`, 'utf8');
  const logOne = path.join(runDir, '1.1.log');
  const logTwo = path.join(runDir, '1.2.log');
  const liveDir = path.join(runDir, 'live-output');
  const liveOne = path.join(liveDir, 'parallel-1.json');
  const liveTwo = path.join(liveDir, 'parallel-2.json');
  await mkdir(liveDir, { recursive: true });
  await writeFile(logOne, 'first worker log\n', 'utf8');
  await writeFile(logTwo, 'second worker log\n', 'utf8');
  await writeFile(liveOne, '{}\n', 'utf8');
  await writeFile(liveTwo, '{}\n', 'utf8');

  let state = createRunState({
    id: 'parallel-run',
    identity: {
      registry_id: 'parallel-registry',
      source: { campaign_path: campaignPath, repo_root: repo },
      execution: { campaign_path: campaignPath, repo_root: repo, branch: 'main' },
    },
    steps: [
      { id: '1.1', name: 'First', phase: '1' },
      { id: '1.2', name: 'Second', phase: '1' },
    ],
    config: {
      runner: 'claude',
      model: 'fixture',
      effort: 'high',
      watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
    },
    artifacts: { run_dir: runDir, receipts_dir: receiptsDir, final_review_path: null },
  });
  state = transitionRunState(state, { event: 'run_started' });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    worker: {
      runner: 'claude',
      invocation_id: 'parallel-1',
      pid: null,
      log_path: logOne,
      live_output_path: liveOne,
    },
  });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.2',
    worker: {
      runner: 'claude',
      invocation_id: 'parallel-2',
      pid: null,
      log_path: logTwo,
      live_output_path: liveTwo,
    },
  });
  await writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'run.lock'), `${JSON.stringify({ pid: process.pid })}\n`, 'utf8');

  const providerState = await getAutomateState(campaignPath, { registryId: 'parallel-registry' });
  assert.deepEqual(providerState.current_steps.map((step) => step.id), ['1.1', '1.2']);
  assert.equal(providerState.current_step.id, '1.1');
  assert.match(providerState.current_step_logs['1.1'], /first worker log/);
  assert.match(providerState.current_step_logs['1.2'], /second worker log/);
  assert.match(providerState.current_step_log, /Step 1\.1 — First[\s\S]*Step 1\.2 — Second/);
  assert.deepEqual(providerState.live_outputs.map((output) => output.step_id), ['1.1', '1.2']);
  assert.notEqual(providerState.live_outputs[0].url, providerState.live_outputs[1].url);
  assert.doesNotMatch(JSON.stringify(providerState), /live-output\/parallel/);
  assert.equal(
    (await resolveEngineLiveOutput(campaignPath, {
      registryId: 'parallel-registry',
      stepId: '1.2',
      invocationId: 'parallel-2',
      runsDir,
    })).path,
    await realpath(liveTwo),
  );
});

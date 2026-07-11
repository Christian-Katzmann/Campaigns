import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  campaignStateMatchesFile,
  chooseAutomateState,
  countAutomationProgress,
  deriveCodexRuntime,
  findCodexStatePath,
} from '../lib/automate-providers.mjs';

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

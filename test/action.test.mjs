import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runnerPackageSpec } from '../action/install-runner.mjs';
import {
  runPreflight,
  validateInputs,
  validateTrustContext,
} from '../action/preflight.mjs';

test('action inputs require positive caps, a pinned CLI, and the cost-reporting runner', () => {
  const valid = validateInputs({
    campaign: 'campaigns/release.md',
    runner: 'claude',
    runnerCliVersion: '2.1.3',
    maxSteps: '3',
    maxMinutes: '20',
    maxCostUsd: '1.25',
  });
  assert.deepEqual(
    { maxSteps: valid.maxSteps, maxMinutes: valid.maxMinutes, maxCostUsd: valid.maxCostUsd },
    { maxSteps: 3, maxMinutes: 20, maxCostUsd: 1.25 },
  );
  assert.equal(runnerPackageSpec('claude', '2.1.3'), '@anthropic-ai/claude-code@2.1.3');

  for (const [field, value] of [
    ['maxSteps', '0'],
    ['maxMinutes', 'NaN'],
    ['maxCostUsd', '-1'],
  ]) {
    assert.throws(() => validateInputs({ ...validInput(), [field]: value }), /positive/);
  }
  assert.throws(() => validateInputs({ ...validInput(), runner: 'codex' }), /cost-reporting/);
  assert.throws(() => validateInputs({ ...validInput(), runnerCliVersion: 'latest' }), /exact semver/);
});

test('trust preflight accepts same-repo PRs and refuses forks and pull_request_target', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-action-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'event.json');
  const base = {
    repository: { full_name: 'owner/repo' },
    pull_request: { head: { repo: { full_name: 'owner/repo', fork: false } } },
  };
  await writeFile(eventPath, JSON.stringify(base));
  await validateTrustContext({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath });

  await writeFile(eventPath, JSON.stringify({
    ...base,
    pull_request: { head: { repo: { full_name: 'fork/repo', fork: true } } },
  }));
  await assert.rejects(
    validateTrustContext({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath }),
    /fork pull requests are refused/,
  );
  await assert.rejects(
    validateTrustContext({ GITHUB_EVENT_NAME: 'pull_request_target' }),
    /pull_request_target is refused/,
  );
});

test('preflight masks inherited secrets before reporting success and writes deterministic outputs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-action-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const runnerTemp = path.join(root, 'temp');
  const campaignPath = path.join(workspace, 'campaigns', 'release.md');
  const outputPath = path.join(root, 'outputs');
  await mkdir(path.dirname(campaignPath), { recursive: true });
  await writeFile(campaignPath, '# Release\n');

  let rawLog = '';
  const sentinel = 'sentinel-action-secret';
  const result = await runPreflight({
    env: {
      ...actionEnv(workspace, runnerTemp, outputPath),
      ANTHROPIC_API_KEY: sentinel,
    },
    stdout: { write: (value) => { rawLog += value; } },
  });
  const visibleLog = rawLog
    .split('\n')
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');
  const outputs = await readFile(outputPath, 'utf8');

  assert.match(rawLog, /^::add-mask::/);
  assert.match(visibleLog, /Registered GitHub masking for 1 inherited secret/);
  assert.doesNotMatch(visibleLog, new RegExp(sentinel));
  assert.doesNotMatch(outputs, new RegExp(sentinel));
  assert.match(outputs, /state-dir=.*campaigns-123-2/);
  assert.match(outputs, new RegExp(`campaign-path=${escapeRegex(result.campaignPath)}`));
});

test('composite metadata gates trust, uploads evidence, then publishes the PR report', async () => {
  const metadata = await readFile(path.resolve('action/action.yml'), 'utf8');
  const preflight = metadata.indexOf('Mask secrets and enforce PR trust');
  const install = metadata.indexOf('Install pinned runner CLI');
  const launch = metadata.indexOf('node "$GITHUB_ACTION_PATH/../bin/campaigns.mjs"');
  const report = metadata.indexOf('node "$GITHUB_ACTION_PATH/report-pr.mjs"');

  assert.ok(preflight >= 0 && preflight < install && install < launch && launch < report);
  assert.match(metadata, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(metadata, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(metadata, /if: \$\{\{ always\(\) \}\}/);
  for (const surface of ['state.json', 'events.jsonl', 'receipts/', 'final-review.md']) {
    assert.match(metadata, new RegExp(surface.replace('.', '\\.')));
  }
  for (const cap of ['max_steps', 'max_minutes', 'max_cost_usd']) {
    assert.match(metadata, new RegExp(`${cap}:[\\s\\S]{0,120}required: true`));
  }
  assert.match(metadata, /github\.event_name == 'pull_request'/);
  assert.match(metadata, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(metadata, /\/statuses\//);
  assert.doesNotMatch(metadata, /timeline\.(?:jsonl|md)/);
});

test('action guide documents the minimal PR permissions and safe event', async () => {
  const guide = await readFile(path.resolve('action/README.md'), 'utf8');
  for (const permission of ['contents: read', 'checks: write', 'pull-requests: write']) {
    assert.match(guide, new RegExp(permission));
  }
  assert.match(guide, /`pull_request` event only/);
  assert.match(guide, /`pull_request_target`.*refused/);
});

test('public CI guide documents replay, caps, evidence, cost honesty, and limitations', async () => {
  const guide = await readFile(path.resolve('docs/campaigns-in-ci.md'), 'utf8');
  for (const expected of [
    'full-40-character-campaigns-commit-sha',
    'same-repository PRs only',
    'contents: read',
    'checks: write',
    'pull-requests: write',
    'max_steps',
    'max_minutes',
    'max_cost_usd',
    'state.json',
    'events.jsonl',
    'receipts/',
    'final-review.md',
    'npm run action:e2e',
    'not provider spend',
    'did not perform a live provider-key run',
  ]) {
    assert.match(guide, new RegExp(expected.replaceAll('.', '\\.'), 'i'));
  }
});

function validInput() {
  return {
    campaign: 'campaign.md',
    runner: 'claude',
    runnerCliVersion: '2.1.3',
    maxSteps: '1',
    maxMinutes: '1',
    maxCostUsd: '1',
  };
}

function actionEnv(workspace, runnerTemp, outputPath) {
  return {
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outputPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    INPUT_CAMPAIGN: 'campaigns/release.md',
    INPUT_RUNNER: 'claude',
    INPUT_RUNNER_CLI_VERSION: '2.1.3',
    INPUT_MAX_STEPS: '3',
    INPUT_MAX_MINUTES: '20',
    INPUT_MAX_COST_USD: '1.25',
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

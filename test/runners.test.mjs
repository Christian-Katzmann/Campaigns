import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_RUNNER_CONFIG_PATH,
  buildRunnerInvocation,
  classifyRunnerResult,
  createRunnerCompletionMarker,
  createRunnerRegistry,
  loadConfiguredRunnerRegistry,
  loadRunnerRegistry,
  runnerReportsCost,
  runnerCapabilities,
} from '../lib/runners.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';

const shippedConfig = JSON.parse(await readFile(DEFAULT_RUNNER_CONFIG_PATH, 'utf8'));
const expected = {
  run_id: 'run-1',
  step_id: '1.2',
  invocation_id: 'worker-1',
};
const receiptPath = '/tmp/campaigns-runner-receipt.md';

test('shipped Claude and Codex templates preserve their required CLI flags', async () => {
  const registry = await loadRunnerRegistry();
  assert.equal(runnerReportsCost(registry, 'claude'), true);
  assert.equal(runnerReportsCost(registry, 'codex'), false);
  const claude = buildRunnerInvocation(registry, 'claude', {
    prompt: 'do the step',
    env: {},
  });
  assert.deepEqual(claude.args, [
    '--effort',
    shippedConfig.runners.claude.defaults.effort,
    '--print',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    shippedConfig.runners.claude.defaults.model,
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.equal(claude.stdin, 'do the step');

  const codex = buildRunnerInvocation(registry, 'codex', {
    prompt: 'do the step',
    repoRoot: '/repo',
    outputPath: '/tmp/last-message.md',
    env: {},
  });
  assert.deepEqual(codex.args, [
    'exec',
    '--ignore-user-config',
    '--json',
    '-C',
    '/repo',
    '-m',
    shippedConfig.runners.codex.defaults.model,
    '-c',
    `model_reasoning_effort="${shippedConfig.runners.codex.defaults.effort}"`,
    '-c',
    'approval_policy="never"',
    '-s',
    'danger-full-access',
    '-o',
    '/tmp/last-message.md',
    '-',
  ]);
  assert.equal(codex.stdin, 'do the step');
});

test('effort aliases normalize per runner from config', async () => {
  const registry = await loadRunnerRegistry();
  const claude = buildRunnerInvocation(registry, 'claude', {
    prompt: 'work',
    effort: 'extra-high',
    env: {},
  });
  const codex = buildRunnerInvocation(registry, 'codex', {
    prompt: 'work',
    effort: 'extra-high',
    repoRoot: '/repo',
    outputPath: '/tmp/out',
    env: {},
  });

  assert.equal(claude.effort, shippedConfig.runners.claude.effortMap['extra-high']);
  assert.equal(codex.effort, shippedConfig.runners.codex.effortMap['extra-high']);
});

test('capabilities keep unavailable runners visible with normalized catalogs', async () => {
  const config = structuredClone(shippedConfig);
  config.runners.claude.binary = process.execPath;
  config.runners.codex.binary = 'campaigns-definitely-missing-runner';
  const capabilities = await runnerCapabilities(createRunnerRegistry(config), {
    env: { PATH: '' },
  });
  const claude = capabilities.find((runner) => runner.id === 'claude');
  const codex = capabilities.find((runner) => runner.id === 'codex');
  assert.equal(claude.available, true);
  assert.equal(claude.models[0].label, 'Fable 5');
  assert.deepEqual(claude.defaults, { model: 'claude-opus-4-8', effort: 'high' });
  assert.equal(codex.available, false);
  assert.match(codex.availabilityHint, /not found on PATH/);
});

test('an explicit runner plugin is validated, family-tagged, and capability-ready', async () => {
  const config = structuredClone(shippedConfig);
  config.runnerPaths = [path.resolve('test/fixtures/runner-plugins/gemini')];
  const registry = await loadConfiguredRunnerRegistry(config);
  const gemini = registry.get('gemini');
  const capabilities = await runnerCapabilities(registry, { env: { PATH: '' } });

  assert.equal(gemini.family, 'google');
  assert.equal(gemini.binary, path.resolve('test/fixtures/runner-plugins/gemini/fake-gemini.mjs'));
  assert.deepEqual(registry.warnings, []);
  assert.deepEqual(
    (({ id, family, available }) => ({ id, family, available }))(
      capabilities.find((runner) => runner.id === 'gemini'),
    ),
    { id: 'gemini', family: 'google', available: true },
  );
});

test('runner usage normalizes plugin spend and keeps missing metrics explicit', async () => {
  const config = structuredClone(shippedConfig);
  config.runnerPaths = [path.resolve('test/fixtures/runner-plugins/gemini')];
  const registry = await loadConfiguredRunnerRegistry(config);
  const marker = createRunnerCompletionMarker(registry, 'gemini', expected);
  const spend = classifyRunnerResult(registry, 'gemini', {
    exitCode: 0,
    stdout: `${JSON.stringify({
      type: 'usage',
      metrics: { prompt: 120, completion: 30, cost: 0.0042 },
    })}\n${marker}`,
    expected,
    receiptPath,
  });
  assert.deepEqual(spend.usage, {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    cost_usd: 0.0042,
  });
  assert.deepEqual(spend.transition.details.usage, spend.usage);

  const noSpendRegistry = createRunnerRegistry(fakeRunnerConfig());
  const noSpendMarker = createRunnerCompletionMarker(noSpendRegistry, 'echo', expected);
  const noSpend = classifyRunnerResult(noSpendRegistry, 'echo', {
    exitCode: 0,
    stdout: noSpendMarker,
    expected,
    receiptPath,
  });
  assert.deepEqual(noSpend.usage, {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_usd: null,
  });
});

test('malformed and colliding runner plugins warn, skip, and leave valid runners usable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-runner-plugins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malformed = path.join(root, 'malformed');
  const collision = path.join(root, 'collision');
  await Promise.all([mkdir(malformed), mkdir(collision)]);
  await writeFile(path.join(malformed, 'campaigns-runner.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'broken',
  }), 'utf8');
  await writeFile(path.join(collision, 'campaigns-runner.json'), JSON.stringify({
    ...shippedConfig.runners.claude,
    schemaVersion: 1,
    id: 'claude',
    family: 'other',
  }), 'utf8');

  const config = structuredClone(shippedConfig);
  config.runnerPaths = [
    malformed,
    collision,
    path.resolve('test/fixtures/runner-plugins/gemini'),
  ];
  const registry = await loadConfiguredRunnerRegistry(config);

  assert.ok(registry.names.includes('gemini'));
  assert.equal(registry.names.filter((id) => id === 'claude').length, 1);
  assert.match(registry.warnings[0], /manifest field "family" must be a non-empty string/);
  assert.match(registry.warnings[1], /duplicate id "claude"/);
});

test('runner invocation preserves Windows paths as literal arguments', async () => {
  const registry = await loadRunnerRegistry();
  const repoRoot = String.raw`C:\Users\Ada Lovelace\Campaigns\repo`;
  const outputPath = String.raw`C:\Users\Ada Lovelace\Campaigns\run\last message.md`;
  const codex = buildRunnerInvocation(registry, 'codex', {
    prompt: 'work',
    repoRoot,
    outputPath,
    env: {},
  });

  assert.equal(codex.command, 'codex');
  assert.equal(codex.args[codex.args.indexOf('-C') + 1], repoRoot);
  assert.equal(codex.args[codex.args.indexOf('-o') + 1], outputPath);
  assert.equal(codex.stdin, 'work');
});

test('Claude strips only nested-session variables and otherwise inherits the environment', async () => {
  const registry = await loadRunnerRegistry();
  const inherited = {
    PATH: '/bin',
    CLAUDECODE: 'nested',
    CLAUDE_CODE_ENTRYPOINT: 'nested-entry',
    CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token',
    ANTHROPIC_API_KEY: 'inherited-key',
    OPENAI_API_KEY: 'also-inherited',
  };
  const claude = buildRunnerInvocation(registry, 'claude', {
    prompt: 'work',
    env: inherited,
  });
  assert.equal(claude.env.CLAUDECODE, undefined);
  assert.equal(claude.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, 'inherited-token');
  assert.equal(claude.env.ANTHROPIC_API_KEY, 'inherited-key');
  assert.equal(claude.env.OPENAI_API_KEY, 'also-inherited');

  const codex = buildRunnerInvocation(registry, 'codex', {
    prompt: 'work',
    repoRoot: '/repo',
    outputPath: '/tmp/out',
    env: inherited,
  });
  assert.deepEqual(codex.env, inherited);
});

test('shipped stream formats expose only a matching structured final marker', async () => {
  const registry = await loadRunnerRegistry();
  const marker = createRunnerCompletionMarker(registry, 'claude', expected);
  const claudeStdout = `${JSON.stringify({ type: 'assistant', message: 'working' })}\n${JSON.stringify({
    type: 'result',
    result: `done\n${marker}`,
  })}\n`;
  const claudeResult = classifyRunnerResult(registry, 'claude', {
    exitCode: 0,
    stdout: claudeStdout,
    expected,
    receiptPath,
  });
  assert.equal(claudeResult.completed, true);

  const codexMarker = createRunnerCompletionMarker(registry, 'codex', expected);
  const codexStdout = `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: `done\n${codexMarker}` },
  })}\n`;
  const codexResult = classifyRunnerResult(registry, 'codex', {
    exitCode: 0,
    stdout: codexStdout,
    expected,
    receiptPath,
  });
  assert.equal(codexResult.completed, true);
});

test('a third echo-style runner is added with config only and completes through the contract', async () => {
  const config = fakeRunnerConfig();
  const registry = createRunnerRegistry(config);
  assert.ok(registry.names.includes('echo'));

  const marker = createRunnerCompletionMarker(registry, 'echo', expected);
  const invocation = buildRunnerInvocation(registry, 'echo', {
    prompt: marker,
    env: process.env,
  });
  const processResult = await runInvocation(invocation);
  const classified = classifyRunnerResult(registry, 'echo', {
    ...processResult,
    expected,
    receiptPath,
  });

  let state = runningStepState();
  state = transitionRunState(state, {
    ...classified.transition,
    commit_range: { base_oid: '1'.repeat(40), head_oid: '2'.repeat(40) },
  });
  assert.equal(processResult.exitCode, 0);
  assert.equal(classified.completed, true);
  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[0].receipt_path, receiptPath);
});

test('exit zero without a marker records step_failed and never completes the step', async () => {
  const registry = createRunnerRegistry(fakeRunnerConfig());
  const invocation = buildRunnerInvocation(registry, 'echo', {
    prompt: 'work finished but no marker',
    env: process.env,
  });
  const processResult = await runInvocation(invocation);
  const classified = classifyRunnerResult(registry, 'echo', {
    ...processResult,
    expected,
    receiptPath,
  });

  let state = runningStepState();
  state = transitionRunState(state, classified.transition);
  assert.equal(processResult.exitCode, 0);
  assert.equal(classified.completed, false);
  assert.equal(classified.transition.event, 'step_failed');
  assert.equal(classified.transition.failure.code, 'completion_signal_missing');
  assert.equal(state.steps[0].status, 'failed');
  assert.equal(state.steps[0].receipt_path, null);
  assert.equal(state.history.at(-1).event, 'step_failed');
});

function fakeRunnerConfig() {
  const config = structuredClone(shippedConfig);
  config.runners.echo = {
    binary: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'],
    prompt: { delivery: 'arg' },
    defaults: { model: 'fake-model', effort: 'none' },
    effortMap: { none: 'none' },
    environment: { remove: [] },
    completion: {
      marker: structuredClone(config.runners.codex.completion.marker),
      sources: [{ kind: 'text' }],
    },
  };
  return config;
}

function runningStepState() {
  let state = createRunState({
    id: expected.run_id,
    created_at: '2026-07-14T12:00:00.000Z',
    identity: {
      registry_id: null,
      source: { campaign_path: '/repo/campaign.md', repo_root: '/repo' },
      execution: {
        campaign_path: '/repo/campaign.md',
        repo_root: '/repo',
        branch: 'campaign/test',
      },
    },
    steps: [{ id: expected.step_id, name: 'Runner contract', phase: '1' }],
    config: {
      runner: 'echo',
      model: 'fake-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    },
    artifacts: {
      run_dir: '/tmp/campaign-run',
      receipts_dir: '/tmp/campaign-run/receipts',
      final_review_path: '/tmp/campaign-run/final-review.md',
    },
  });
  state = transitionRunState(state, {
    event: 'run_started',
    at: '2026-07-14T12:00:01.000Z',
  });
  return transitionRunState(state, {
    event: 'step_started',
    at: '2026-07-14T12:00:02.000Z',
    step_id: expected.step_id,
    worker: {
      runner: 'echo',
      invocation_id: expected.invocation_id,
      pid: 123,
      log_path: '/tmp/campaign-run/worker.log',
    },
  });
}

function runInvocation(invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(invocation.stdin ?? '');
  });
}

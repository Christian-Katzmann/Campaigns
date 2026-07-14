import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  DEFAULT_RUNNER_CONFIG_PATH,
  buildRunnerInvocation,
  classifyRunnerResult,
  createRunnerCompletionMarker,
  createRunnerRegistry,
  loadRunnerRegistry,
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
  state = transitionRunState(state, classified.transition);
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

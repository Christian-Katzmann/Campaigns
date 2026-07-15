import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runRunnerInvocation } from '../lib/runner-process.mjs';

const execFileAsync = promisify(execFile);

test('runner execution aborts and reaps its process group', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'campaigns-runner-process-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', repo, 'init', '-b', 'main']);
  const controller = new AbortController();
  let pid = null;
  const startedAt = Date.now();
  const result = await runRunnerInvocation({
    args: ['-e', 'setInterval(() => {}, 1000)'],
    command: process.execPath,
    env: process.env,
    outputPath: null,
    stdin: null,
  }, {
    containmentRoot: repo,
    cwd: repo,
    logPath: path.join(repo, 'runner.log'),
    onSpawn: async (childPid) => {
      pid = childPid;
      setTimeout(() => controller.abort(), 50);
    },
    signal: controller.signal,
    watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
  });
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

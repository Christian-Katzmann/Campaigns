import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runRunnerInvocation } from '../lib/runner-process.mjs';
import {
  LIVE_OUTPUT_FILE_MAX_BYTES,
  LIVE_OUTPUT_MAX_BYTES,
  readLiveOutputSnapshot,
} from '../lib/live-output.mjs';

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

test('runner tolerates EPIPE when the child closes stdin before prompt delivery', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'campaigns-runner-stdin-race-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', repo, 'init', '-b', 'main']);

  const result = await runRunnerInvocation({
    args: ['-e', "require('node:fs').closeSync(0); setTimeout(() => {}, 100)"],
    command: process.execPath,
    env: process.env,
    outputPath: null,
    stdin: 'x'.repeat(128 * 1024),
  }, {
    containmentRoot: repo,
    cwd: repo,
    logPath: path.join(repo, 'runner.log'),
    onSpawn: async () => new Promise((resolve) => setTimeout(resolve, 50)),
    watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
  });

  assert.equal(result.exitCode, 0);
});

test('live output stays bounded and is deleted after completion, failure, and stop', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'campaigns-live-output-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', repo, 'init', '-b', 'main']);

  for (const outcome of ['completion', 'failure', 'stop']) {
    const livePath = path.join(repo, 'live-output', `${outcome}.json`);
    const logPath = path.join(repo, `${outcome}.log`);
    const releasePath = path.join(repo, `${outcome}.release`);
    const stopPath = path.join(repo, `${outcome}.stop`);
    const ending = outcome === 'stop'
      ? 'setInterval(() => {}, 1000);'
      : `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(${outcome === 'failure' ? 2 : 0}); }, 10);`;
    const run = runRunnerInvocation({
      args: ['-e', `process.stdout.write('AUTH_SECRET=raw-secret\\n' + Array.from({ length: 200 }, () => 'x'.repeat(1024)).join('\\n')); ${ending}`],
      command: process.execPath,
      env: process.env,
      outputPath: null,
      stdin: null,
    }, {
      containmentRoot: repo,
      cwd: repo,
      logPath,
      stopRequestPath: outcome === 'stop' ? stopPath : null,
      stopGraceMs: 20,
      watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
      liveOutput: {
        filePath: livePath,
        runId: 'bounded-run',
        stepId: `1.${outcome.length}`,
        invocationId: outcome,
      },
    });

    let snapshot = null;
    let liveFileSize = null;
    let observationError = null;
    try {
      snapshot = await waitFor(async () => {
        try {
          const value = await readLiveOutputSnapshot(livePath, {
            runId: 'bounded-run',
            stepId: `1.${outcome.length}`,
            invocationId: outcome,
          });
          return value.end_cursor > LIVE_OUTPUT_MAX_BYTES ? value : null;
        } catch {
          return null;
        }
      });
      liveFileSize = (await stat(livePath)).size;
    } catch (error) {
      observationError = error;
    }
    await writeFile(outcome === 'stop' ? stopPath : releasePath, '{}\n', 'utf8');
    const result = await run;
    if (observationError) {
      throw new Error(`${outcome}: ${observationError.message}`, { cause: observationError });
    }
    assert.equal(snapshot.data.length, LIVE_OUTPUT_MAX_BYTES);
    assert.ok(liveFileSize <= LIVE_OUTPUT_FILE_MAX_BYTES);
    assert.equal(result.stop?.requested ?? false, outcome === 'stop');
    assert.equal(result.exitCode === 0, outcome === 'completion');
    await assert.rejects(access(livePath), { code: 'ENOENT' });
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /raw-secret/);
  }
});

async function waitFor(check, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

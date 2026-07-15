import { spawn } from 'node:child_process';
import { createWriteStream, watch as watchFileSystem } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStreamingRedactor, writeRedactedFile } from './redaction.mjs';

export async function runRunnerInvocation(invocation, options) {
  const canonicalCwd = await canonicalExistingPath(options.cwd, 'Runner cwd');
  const containmentRoot = await canonicalExistingPath(
    options.containmentRoot ?? options.cwd,
    'Runner containment root',
  );
  assertPathContained(containmentRoot, canonicalCwd, 'Runner cwd');
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: 'a' });
  const logRedactor = createStreamingRedactor();
  const stagedOutput = await stageRunnerOutput(invocation);
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let watchdogResult = null;
  let stopResult = null;
  let capResult = null;
  let killTimer = null;
  let stopping = false;
  let polling = false;
  const markActivity = () => { lastActivityAt = Date.now(); };
  const activityMonitor = await watchRepoActivity(
    canonicalCwd,
    options.ignoredActivityPaths ?? [],
    markActivity,
  );
  const child = spawn(stagedOutput.invocation.command, stagedOutput.invocation.args, {
    cwd: canonicalCwd,
    env: stagedOutput.invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    markActivity();
    stdout += chunk;
    const safe = logRedactor.push(chunk);
    if (safe) log.write(safe);
    options.stdout?.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    markActivity();
    stderr += chunk;
    const safe = logRedactor.push(chunk);
    if (safe) log.write(safe);
    options.stderr?.write(chunk);
  });

  const closed = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (exitCode, signal) => {
      const signalExitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
      resolve({
        exitCode: spawnError ? 127 : (exitCode ?? signalExitCode),
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? '\n' : ''}${spawnError.message}` : stderr,
      });
    });
  });
  const abort = () => {
    stopping = true;
    signalChildProcessGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
    killTimer.unref?.();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const watchdog = options.watchdog;
  const watchdogPollInterval = Math.max(10, Math.min(250, Math.floor(watchdog.stall_window_ms / 4)));
  const pollInterval = options.stopRequestPath ? Math.min(25, watchdogPollInterval) : watchdogPollInterval;
  const pollRunner = async () => {
    if (polling) return;
    polling = true;
    try {
      const now = Date.now();
      const runtimeMs = now - startedAt;
      const inactiveMs = now - lastActivityAt;
      const childAlive = child.exitCode == null && child.signalCode == null;

      if (stopResult == null && options.stopRequestPath && await hasStopRequest(options.stopRequestPath)) {
        stopResult = {
          requested: true,
          forced: false,
          requested_at_ms: now,
          grace_ms: options.stopGraceMs ?? 3_000,
        };
        stopping = true;
      }

      if (
        stopResult?.requested
        && !stopResult.forced
        && childAlive
        && now - stopResult.requested_at_ms >= stopResult.grace_ms
      ) {
        stopResult.forced = true;
        signalChildProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
        killTimer.unref?.();
      }

      if (capResult == null && options.deadlineMs && now >= options.deadlineMs && childAlive) {
        capResult = { kind: 'max_run_minutes', deadline_ms: options.deadlineMs };
        stopping = true;
        signalChildProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
        killTimer.unref?.();
      }

      if (
        watchdogResult == null
        && !stopping
        && childAlive
        && runtimeMs >= watchdog.minimum_runtime_ms
        && inactiveMs >= watchdog.stall_window_ms
      ) {
        watchdogResult = {
          stalled: true,
          runtime_ms: runtimeMs,
          inactive_ms: inactiveMs,
          message: `Runner stalled after ${runtimeMs}ms with no stdout, stderr, repository file, or Git index activity for ${inactiveMs}ms (minimum runtime ${watchdog.minimum_runtime_ms}ms; stall window ${watchdog.stall_window_ms}ms).`,
        };
        stopping = true;
        signalChildProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 500);
        killTimer.unref?.();
      }
    } finally {
      polling = false;
    }
  };
  const watchdogTimer = setInterval(() => { void pollRunner(); }, pollInterval);
  watchdogTimer.unref?.();

  let result;
  try {
    await options.onSpawn?.(child.pid ?? null);
    if (options.signal?.aborted) abort();
    child.stdin.end(stagedOutput.invocation.stdin ?? '');
    await pollRunner();
    result = await closed;
  } catch (error) {
    signalChildProcessGroup(child, 'SIGTERM');
    await closed;
    throw error;
  } finally {
    clearInterval(watchdogTimer);
    if (killTimer) clearTimeout(killTimer);
    activityMonitor.close();
    options.signal?.removeEventListener('abort', abort);
    const safeTail = logRedactor.flush();
    if (safeTail) log.write(safeTail);
    await new Promise((resolve) => log.end(resolve));
    await stagedOutput.persist();
  }

  let outputTail = null;
  if (watchdogResult || stopResult || capResult) {
    try {
      outputTail = tailText(await readFile(options.logPath, 'utf8'));
    } catch {
      outputTail = tailText(`${stdout}${stderr ? `\n${stderr}` : ''}`);
    }
  }
  return {
    ...result,
    watchdog: watchdogResult,
    stop: stopResult,
    cap: capResult,
    outputTail,
  };
}

export function signalProcessGroupPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (['ESRCH', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

async function stageRunnerOutput(invocation) {
  if (!invocation.outputPath) return { invocation, persist: async () => {} };
  const rawDir = await mkdtemp(path.join(tmpdir(), 'campaigns-runner-output-'));
  const rawPath = path.join(rawDir, path.basename(invocation.outputPath));
  const args = invocation.args.map((argument) => (
    argument === invocation.outputPath ? rawPath : argument
  ));
  if (args.every((argument, index) => argument === invocation.args[index])) {
    await rm(rawDir, { recursive: true, force: true });
    throw new Error('Runner output path was not present as a standalone argument.');
  }
  return {
    invocation: { ...invocation, args },
    async persist() {
      try {
        const raw = await readFile(rawPath, 'utf8');
        await writeRedactedFile(invocation.outputPath, raw);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        await rm(rawDir, { recursive: true, force: true });
      }
    },
  };
}

async function watchRepoActivity(repoRoot, ignoredPaths, onActivity) {
  const watchers = [];
  const ignored = ignoredPaths.map((candidate) => path.resolve(candidate));
  const addWatcher = (watchPath, recursive, resolveEventPath) => {
    try {
      const watcher = watchFileSystem(
        watchPath,
        { recursive, persistent: false },
        (_event, filename) => {
          const eventPath = resolveEventPath(filename);
          if (ignored.some((candidate) => isSameOrInside(eventPath, candidate))) return;
          onActivity();
        },
      );
      watcher.on('error', () => {});
      watchers.push(watcher);
      return true;
    } catch {
      return false;
    }
  };

  if (!addWatcher(repoRoot, true, (filename) => path.resolve(repoRoot, String(filename ?? '')))) {
    addWatcher(repoRoot, false, (filename) => path.resolve(repoRoot, String(filename ?? '')));
  }

  const gitIndex = await runGit(repoRoot, ['rev-parse', '--git-path', 'index']);
  if (gitIndex.exitCode === 0 && gitIndex.stdout.trim()) {
    const indexPath = path.resolve(repoRoot, gitIndex.stdout.trim());
    addWatcher(indexPath, false, () => indexPath);
  }

  return { close: () => watchers.forEach((watcher) => watcher.close()) };
}

function signalChildProcessGroup(child, signal) {
  if (signalProcessGroupPid(child.pid, signal)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function canonicalExistingPath(value, label) {
  try {
    return await realpath(path.resolve(value));
  } catch (error) {
    throw new Error(`${label} does not exist: ${path.resolve(value)}`, { cause: error });
  }
}

function assertPathContained(parent, candidate, label) {
  if (!isSameOrInside(candidate, parent)) {
    throw new Error(`${label} resolves outside containment root ${parent}: ${candidate}`);
  }
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hasStopRequest(stopRequestPath) {
  try {
    await readFile(stopRequestPath, 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: error.message }));
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function tailText(value, maxCharacters = 4_096) {
  const text = String(value ?? '');
  return text.length <= maxCharacters ? text : text.slice(-maxCharacters);
}

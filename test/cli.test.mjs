import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('bin/campaigns.mjs');

test('campaigns --help keeps the engine commands and documents sample launch', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help']);

  assert.match(stdout, /campaigns \[--no-open\] \[--port <number>\]/);
  assert.match(stdout, /campaigns run <campaign\.md>/);
  assert.match(stdout, /campaigns recover <campaign\.md>/);
  assert.match(stdout, /campaigns stop <campaign\.md>/);
});

test('campaigns --no-open launches the bundled sample on loopback', async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'campaigns-cli-'));
  const child = spawn(process.execPath, [cliPath, '--no-open', '--port', '0'], {
    env: {
      ...process.env,
      CAMPAIGNS_PORT_FILE: path.join(tempRoot, 'server.port'),
      CAMPAIGNS_REGISTRY_DIR: path.join(tempRoot, 'registry'),
      CAMPAIGNS_RUNS_DIR: path.join(tempRoot, 'runs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const url = await waitForUrl(child);
  assert.match(url, /^http:\/\/localhost:\d+$/);
  const response = await fetch(`${url}/api/document`);
  const document = await response.json();

  assert.equal(response.status, 200);
  assert.match(document.markdown, /^# Sample launch campaign/m);
  assert.equal(new URL(url).hostname, 'localhost');
});

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for CLI output:\n${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/Campaigns: (http:\/\/localhost:\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before launch (${code}):\n${output}`));
    });
  });
}

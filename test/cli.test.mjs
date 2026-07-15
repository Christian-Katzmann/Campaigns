import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.match(stdout, /campaigns rollback <campaign\.md> --to <step>/);
  assert.match(stdout, /campaigns stop <campaign\.md>/);
  assert.match(stdout, /campaigns lint <campaign\.md>/);
  assert.match(stdout, /campaigns config doctor \[campaign\.md\]/);
  assert.match(stdout, /--no-worktree/);
  assert.match(stdout, /--to <step>/);
});

test('campaigns lint is clean on the dogfood campaign', async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'campaigns-lint-clean-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    process.execPath,
    [cliPath, 'lint', 'examples/hello-run.md'],
    { env: { ...process.env, CAMPAIGNS_RUNS_DIR: path.join(tempRoot, 'runs') } },
  );

  assert.match(stdout, /hello-run\.md: clean/);
});

test('campaigns lint exits zero for info and one for errors', async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'campaigns-lint-severity-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const infoPath = path.join(tempRoot, 'info.md');
  const errorPath = path.join(tempRoot, 'error.md');
  const env = { ...process.env, CAMPAIGNS_RUNS_DIR: path.join(tempRoot, 'runs') };
  await writeFile(infoPath, `# Info only

## Progress checklist

### Phase 1 — Work

- [ ] Step 1.1 — Work
- [ ] Final review

## Step 1.1 — Work

Model: Fable 5 · High / GPT-5.6-Sol · High
Parallel: NO

\`\`\`text
ACCEPTANCE:
- Work is done.
\`\`\`

## Final review

\`\`\`text
Review the work.
\`\`\`
`, 'utf8');
  await writeFile(errorPath, `# Errors

## Progress checklist

### Phase 1 — Work

- [ ] Step 1.1 — Work

## Step 1.1 — Work

Parallel: NO

\`\`\`text
Do the work.
\`\`\`
`, 'utf8');

  const info = await execFileAsync(process.execPath, [cliPath, 'lint', infoPath], { env });
  assert.match(info.stdout, /info \[missing-check\]/);

  let failure;
  try {
    await execFileAsync(process.execPath, [cliPath, 'lint', errorPath], { env });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 1);
  assert.match(failure.stdout, /error \[missing-model\]/);
  assert.match(failure.stdout, /error \[missing-acceptance\]/);
  assert.match(failure.stdout, /error \[missing-final-review\]/);
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

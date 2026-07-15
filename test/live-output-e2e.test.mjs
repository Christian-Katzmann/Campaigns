import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runPathsForCampaign } from '../lib/pump.mjs';

const projectRoot = path.resolve('.');

test('CLI worker output crosses into a separate server SSE stream and cleans up raw data', async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'campaigns-live-e2e-'));
  const repo = path.join(sandbox, 'repo');
  const runsDir = path.join(sandbox, 'runs');
  const registryDir = path.join(sandbox, 'registry');
  const configDir = path.join(sandbox, 'config');
  const campaignPath = path.join(repo, 'campaign.md');
  const configPath = path.join(sandbox, 'campaigns.config.json');
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    }
    await Promise.allSettled([...children].map(waitForExit));
    await rm(sandbox, { recursive: true, force: true });
  });

  await mkdir(repo, { recursive: true });
  await runProcess('git', ['-C', repo, 'init', '-b', 'main']);
  await runProcess('git', ['-C', repo, 'config', 'user.name', 'Campaigns Test']);
  await runProcess('git', ['-C', repo, 'config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, campaignFixture(), 'utf8');
  await writeFile(configPath, `${JSON.stringify(fakeRunnerConfig(), null, 2)}\n`, 'utf8');
  await runProcess('git', ['-C', repo, 'add', 'campaign.md']);
  await runProcess('git', ['-C', repo, 'commit', '-m', 'Add live output fixture']);

  const env = {
    ...process.env,
    CAMPAIGNS_CONFIG_DIR: configDir,
    CAMPAIGNS_PORT_FILE: path.join(sandbox, 'server.port'),
    CAMPAIGNS_REGISTRY_DIR: registryDir,
    CAMPAIGNS_RUNS_DIR: runsDir,
  };
  const server = spawn(process.execPath, [
    path.join(projectRoot, 'server.mjs'),
    '--port', '0',
    '--file', campaignPath,
  ], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(server);
  const baseUrl = await waitForServer(server);
  const registry = await fetch(`${baseUrl}/api/registry`).then((response) => response.json());
  const campaignId = registry.campaigns.find((campaign) => campaign.filePath === campaignPath)?.id;
  assert.ok(campaignId);

  const cli = spawn(process.execPath, [
    path.join(projectRoot, 'bin', 'campaigns.mjs'),
    'run', campaignPath,
    '--config', configPath,
    '--state-dir', runsDir,
    '--no-worktree',
    '--registry-id', campaignId,
  ], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(cli);

  const active = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/automate-state?id=${encodeURIComponent(campaignId)}`);
    if (!response.ok) return null;
    const state = await response.json();
    return state?.live_outputs?.[0] ? state : null;
  });
  const descriptor = active.live_outputs[0];
  const connectedAt = Date.now();
  const streamed = process.env.CAMPAIGNS_BROWSER_VERIFY === '1'
    ? await collectBrowserSamples(baseUrl, descriptor.url)
    : await collectSamples(`${baseUrl}${descriptor.url}`, ['sample-one@', 'sample-two@']);
  if (streamed.contentType) assert.equal(streamed.contentType, 'text/event-stream; charset=utf-8');
  assert.ok(
    (streamed.firstSampleAt ?? connectedAt + streamed.firstLatencyMs) - connectedAt < 1_000,
    'first live sample should arrive within a second',
  );
  assert.match(streamed.text, /sample-one@\d{4}-\d{2}-\d{2}T/);
  assert.match(streamed.text, /sample-two@\d{4}-\d{2}-\d{2}T/);
  assert.match(streamed.text, /AUTH_SECRET=e2e-raw-secret/);
  if (process.env.CAMPAIGNS_BROWSER_VERIFY === '1') {
    const samples = streamed.text.match(/sample-(?:one|two)@[^\n]+/g) ?? [];
    t.diagnostic(`Browser EventSource samples (${Math.round(streamed.firstLatencyMs)}ms first byte): ${samples.join(', ')}`);
    assert.match(streamed.ui_text, /sample-one@[\s\S]*sample-two@/);
    assert.equal(streamed.tab_count, 1);
  }

  const cliResult = await waitForExit(cli);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const paths = runPathsForCampaign(campaignPath, runsDir);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(state.run.status, 'completed');
  assert.deepEqual(state.workers, []);
  const liveFiles = await readdir(paths.liveOutputDir).catch((error) => (
    error.code === 'ENOENT' ? [] : Promise.reject(error)
  ));
  assert.deepEqual(liveFiles, []);
  const persisted = await readPersistedArtifacts(paths);
  assert.match(persisted, /sample-one@/);
  assert.doesNotMatch(persisted, /e2e-raw-secret/);
});

async function collectSamples(url, samples) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let text = '';
    let firstSampleAt = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (!data) continue;
        const payload = JSON.parse(data);
        if (typeof payload.text === 'string') {
          text += payload.text;
          if (firstSampleAt == null && samples.some((sample) => text.includes(sample))) {
            firstSampleAt = Date.now();
          }
          if (samples.every((sample) => text.includes(sample))) {
            await reader.cancel();
            return { contentType, firstSampleAt, text };
          }
        }
      }
    }
    throw new Error('Live output ended before every sample arrived.');
  } finally {
    clearTimeout(timeout);
  }
}

async function collectBrowserSamples(baseUrl, streamPath) {
  const python = process.env.PLAYWRIGHT_PYTHON || '/opt/homebrew/opt/python@3.11/bin/python3.11';
  const script = `
import asyncio, json, sys
from playwright.async_api import async_playwright

async def main():
    base_url, stream_path, browser_path = sys.argv[1:]
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, executable_path=browser_path)
        page = await browser.new_page()
        await page.goto(base_url)
        result = await page.evaluate("""streamPath => new Promise((resolve, reject) => {
          const started = performance.now();
          const source = new EventSource(streamPath);
          let text = '';
          let firstLatencyMs = null;
          const timer = setTimeout(() => {
            source.close();
            reject(new Error('Browser EventSource timed out.'));
          }, 5000);
          const receive = (event) => {
            const payload = JSON.parse(event.data);
            text += payload.text || '';
            if (firstLatencyMs == null && text.includes('sample-one@')) {
              firstLatencyMs = performance.now() - started;
            }
            if (text.includes('sample-one@') && text.includes('sample-two@')) {
              clearTimeout(timer);
              source.close();
              resolve({ text, firstLatencyMs, transport: 'browser EventSource' });
            }
          };
          source.addEventListener('chunk', receive);
          source.addEventListener('reset', receive);
          source.addEventListener('end', () => reject(new Error('Browser EventSource ended early.')));
        })""", stream_path)
        await page.locator('#automate-drawer-toggle').click()
        await page.wait_for_function("""() => {
          const output = document.querySelector('.drawer-live-output-pre')?.textContent || '';
          return output.includes('sample-one@') && output.includes('sample-two@');
        }""", timeout=3000)
        result['ui_text'] = await page.locator('.drawer-live-output-pre').text_content()
        result['tab_count'] = await page.locator('.drawer-live-output-tab').count()
        print(json.dumps(result))
        await browser.close()

asyncio.run(main())
  `;
  const browser = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const result = await runProcessCapture(python, ['-c', script, baseUrl, streamPath, browser]);
  return JSON.parse(result.stdout.trim());
}

async function readPersistedArtifacts(paths) {
  const files = [
    ...(await readdir(paths.logsDir)).map((name) => path.join(paths.logsDir, name)),
    ...(await readdir(paths.receiptsDir)).map((name) => path.join(paths.receiptsDir, name)),
  ];
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

async function waitForServer(child) {
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. ${errors}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const port = output.match(/Campaigns: http:\/\/localhost:(\d+)/)?.[1];
      if (!port) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${port}`);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}. ${errors}`));
    });
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stderr: '' });
  }
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function runProcess(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return waitForExit(child).then((result) => {
    if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${result.stderr}`);
  });
}

function runProcessCapture(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

function campaignFixture() {
  return `# Live output fixture

## Progress checklist

### Phase 1 — Stream

- [ ] Step 1.1 — Stream slow output
- [ ] Final review

## Step 1.1 — Stream slow output

Model: fake-model · none
Parallel: NO

\`\`\`text
Complete the live-output fixture.
\`\`\`

## Final review

\`\`\`text
Review the live-output fixture.
\`\`\`
`;
}

function fakeRunnerConfig() {
  const terminalHoldMs = process.env.CAMPAIGNS_BROWSER_VERIFY === '1' ? 8_000 : 1_000;
  const script = `
    const prompt = process.argv[1];
    if (prompt.includes('campaigns.step_completed')) {
      process.stdout.write('sample-one@' + new Date().toISOString() + '\\n');
      process.stdout.write('AUTH_SECRET=e2e-raw-secret\\n');
      setTimeout(() => {
        process.stdout.write('sample-two@' + new Date().toISOString() + '\\n');
        const heartbeat = setInterval(() => process.stdout.write('stream-heartbeat\\n'), 1_000);
        setTimeout(() => {
          clearInterval(heartbeat);
          process.stdout.write(prompt);
        }, ${terminalHoldMs});
      }, 700);
    } else {
      process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nLive output fixture passed.');
    }
  `;
  return {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 3_000 },
    run: { max_run_minutes: 1, stop_grace_ms: 1_000 },
    review: { maxFixAttempts: 1, forceMergeUnreviewed: false },
    runners: {
      fake: {
        binary: process.execPath,
        args: ['-e', script, '{prompt}'],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fake-model', effort: 'none' },
        effortMap: { none: 'none' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  };
}

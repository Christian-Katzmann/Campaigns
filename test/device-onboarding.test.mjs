import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  buildDeviceOnboardingPrompt,
  createDeviceOnboardingManager,
  parseDeviceOnboardingResult,
  resolveDeviceItSkill,
  resolveDeviceOnboardingContext,
  verifyPhoneUrl,
} from '../lib/device-onboarding.mjs';
import { createRunnerRegistry } from '../lib/runners.mjs';
import { deviceOnboardingPresentation } from '../public/lib/device-onboarding.mjs';

const execFileAsync = promisify(execFile);

test('scratch homes independently gate the button on skill, runner, and stable private URL', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-device-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readyHome = path.join(root, 'ready-home');
  const missingHome = path.join(root, 'missing-home');
  const skillRoot = await writeDeviceItFixture(readyHome);
  const registry = { defaultRunner: 'fake' };
  const runnerCatalog = [{
    available: true,
    defaults: { effort: 'high', model: 'fake-model' },
    id: 'fake',
    label: 'Fake runner',
  }];
  const tailscaleReady = fakeTailscaleExec();

  const discovered = await resolveDeviceItSkill({ env: { HOME: readyHome } });
  assert.equal(discovered.path, skillRoot);
  assert.equal(discovered.available, true);

  const ready = await resolveDeviceOnboardingContext({
    env: { HOME: readyHome },
    exec: tailscaleReady,
    home: readyHome,
    runnerCatalog,
    runnerRegistry: registry,
    targetPort: 4178,
  });
  assert.equal(ready.capability.available, true);
  assert.deepEqual(deviceOnboardingPresentation(ready.capability), {
    buttonHidden: false,
    hint: '',
    hintHidden: true,
  });

  const missingSkill = await resolveDeviceOnboardingContext({
    env: { HOME: missingHome },
    exec: tailscaleReady,
    home: missingHome,
    runnerCatalog,
    runnerRegistry: registry,
    targetPort: 4178,
  });
  const missingRunner = await resolveDeviceOnboardingContext({
    env: { HOME: readyHome },
    exec: tailscaleReady,
    home: readyHome,
    runnerCatalog: [],
    runnerRegistry: registry,
    targetPort: 4178,
  });
  const missingStableUrl = await resolveDeviceOnboardingContext({
    env: { HOME: readyHome },
    exec: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    home: readyHome,
    runnerCatalog,
    runnerRegistry: registry,
    targetPort: 4178,
  });

  for (const context of [missingSkill, missingRunner, missingStableUrl]) {
    const presentation = deviceOnboardingPresentation(context.capability);
    assert.equal(context.capability.available, false);
    assert.equal(presentation.buttonHidden, true);
    assert.equal(presentation.hintHidden, false);
    assert.ok(presentation.hint.length > 0);
  }

  const [indexHtml, settingsModule] = await Promise.all([
    readFile(path.resolve('public/index.html'), 'utf8'),
    readFile(path.resolve('public/modules/settings.mjs'), 'utf8'),
  ]);
  assert.match(indexHtml, /id="device-onboarding-button"[^>]*hidden/);
  assert.match(indexHtml, /id="device-onboarding-hint"/);
  assert.match(settingsModule, /deviceOnboardingButton\.hidden = onboardingPresentation\.buttonHidden/);
});

test('the agent prompt pins device-it wrap mode and returns a structured phone checkpoint', () => {
  const prompt = buildDeviceOnboardingPrompt({
    projectRoot: '/tmp/campaigns',
    skill: {
      runScript: '/tmp/device-it/scripts/run.sh',
      skillPath: '/tmp/device-it/SKILL.md',
    },
    stableUrl: 'https://campaigns.example.ts.net/',
  });
  assert.match(prompt, /run\.sh' --url 'https:\/\/campaigns\.example\.ts\.net\/'/);
  assert.match(prompt, /FRAMEWORK=node-other and BUILD_CMD is empty/);
  assert.match(prompt, /Do not run device-it's build\/deploy pipeline/);
  assert.doesNotMatch(prompt, /dist\//);

  const result = parseDeviceOnboardingResult(
    'progress\nDEVICE_ONBOARDING_RESULT {"status":"manual_checkpoint","url":"https://campaigns.example.ts.net/","qr":"/tmp/qr.png","checkpoint":"Scan, then Add to Home Screen."}',
    'https://campaigns.example.ts.net/',
  );
  assert.equal(result.status, 'manual_checkpoint');
  assert.match(result.checkpoint, /Add to Home Screen/);
});

test('phone verification exercises registry plus a guarded baseHash action and removes its fixture', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'campaigns-device-verify-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  let fixturePath = '';
  let fixtureMarkdown = '';
  const fixtureHash = 'fixture-hash';
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(urlValue);
    const method = init.method || 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (method === 'GET' && url.pathname === '/api/registry') {
      return jsonResponse(200, { campaigns: [] });
    }
    if (method === 'POST' && url.pathname === '/api/registry') {
      fixturePath = JSON.parse(init.body).filePath;
      fixtureMarkdown = await readFile(fixturePath, 'utf8');
      return jsonResponse(200, { id: 'phone-fixture' });
    }
    if (method === 'GET' && url.pathname === '/api/document') {
      assert.equal(url.searchParams.get('id'), 'phone-fixture');
      return jsonResponse(200, { markdown: fixtureMarkdown, hash: fixtureHash });
    }
    if (method === 'PUT' && url.pathname === '/api/document') {
      const payload = JSON.parse(init.body);
      assert.equal(payload.baseHash, fixtureHash);
      assert.equal(payload.markdown, fixtureMarkdown);
      return jsonResponse(200, { ok: true, hash: fixtureHash });
    }
    if (method === 'DELETE' && url.pathname === '/api/registry') {
      await assert.rejects(access(fixturePath), { code: 'ENOENT' });
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: 'unexpected request' });
  };

  const verified = await verifyPhoneUrl('https://campaigns.example.ts.net/', { fetchImpl, stateDir });
  assert.deepEqual(verified, { guardedAction: 'baseHash_document_save', registry: true });
  assert.deepEqual(calls, [
    'GET /api/registry',
    'POST /api/registry',
    'GET /api/document',
    'PUT /api/document',
    'DELETE /api/registry',
  ]);
  assert.deepEqual(await readdir(path.dirname(fixturePath)), []);
});

test('a bounded onboarding job persists a redacted transcript and honest scan-lane checkpoint', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-device-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  const home = path.join(root, 'home');
  const skillRoot = await writeDeviceItFixture(home);
  const outputDir = path.join(home, '.device-it', 'out');
  const qrPath = path.join(outputDir, 'campaigns-qr.png');
  await mkdir(outputDir, { recursive: true });
  await writeFile(qrPath, 'png fixture', 'utf8');
  const completion = `DEVICE_ONBOARDING_RESULT ${JSON.stringify({
    status: 'manual_checkpoint',
    url: 'https://campaigns.example.ts.net/',
    qr: qrPath,
    checkpoint: 'Scan the QR, then Share → Add to Home Screen.',
  })}`;
  const runnerRegistry = fakeRunnerRegistry(`
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { prompt += chunk; });
    process.stdin.on('end', () => {
      if (!prompt.includes('--url')) process.exit(3);
      process.stdout.write('API_TOKEN=raw-secret\\n');
      process.stdout.write(${JSON.stringify(completion)} + '\\n');
    });
  `);
  const context = fakeContext({ home, runnerRegistry, skillRoot });
  let persistedUrl = '';
  const manager = createDeviceOnboardingManager({
    getContext: async () => context,
    onVerifiedUrl: async (url) => { persistedUrl = url; },
    projectRoot: root,
    stateDir: path.join(root, 'state'),
    verifyPhoneUrlImpl: async () => ({ guardedAction: 'baseHash_document_save', registry: true }),
  });

  const started = await manager.start({ runnerId: 'fake' });
  const finished = await waitFor(async () => {
    const job = await manager.get(started.id);
    return job.status === 'manual_checkpoint' ? job : null;
  });
  assert.equal(finished.url, 'https://campaigns.example.ts.net/');
  assert.equal(persistedUrl, finished.url);
  assert.equal(finished.qrAvailable, true);
  assert.match(finished.checkpoint, /Add to Home Screen/);
  assert.doesNotMatch(finished.transcript, /raw-secret/);
  assert.match(finished.transcript, /API_TOKEN=\[REDACTED\]/);
  assert.match(finished.transcript, /guarded baseHash save passed/);
  assert.equal((await manager.getQrPath(started.id)).path, qrPath);
});

test('cancel reaps the runner and resets a bridge created by the job', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-device-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  const home = path.join(root, 'home');
  const skillRoot = await writeDeviceItFixture(home);
  const runnerRegistry = fakeRunnerRegistry('setInterval(() => {}, 1000);');
  const context = fakeContext({ home, runnerRegistry, skillRoot });
  context.stable = {
    available: true,
    bridgeState: 'empty',
    kind: 'tailscale-serve',
    tool: 'Tailscale Serve',
    url: 'https://campaigns.example.ts.net/',
  };
  context.targetPort = 4178;
  const commands = [];
  const manager = createDeviceOnboardingManager({
    exec: async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    getContext: async () => context,
    projectRoot: root,
    stateDir: path.join(root, 'state'),
    timeoutMs: 60_000,
  });

  const started = await manager.start({ runnerId: 'fake' });
  await waitFor(async () => (await manager.get(started.id)).status === 'running');
  const cancelled = await manager.cancel(started.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(commands, [
    ['tailscale', 'serve', '--bg', '--yes', 'http://127.0.0.1:4178'],
    ['bash', path.join(skillRoot, 'scripts', 'mdm', 'mdm-down.sh')],
    ['tailscale', 'serve', 'reset'],
  ]);
  assert.match(cancelled.transcript, /Phone onboarding cancelled/);
});

test('runner failure also cleans device-it runtime and its private bridge', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-device-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  const home = path.join(root, 'home');
  const skillRoot = await writeDeviceItFixture(home);
  const runnerRegistry = fakeRunnerRegistry('process.exit(2);');
  const context = fakeContext({ home, runnerRegistry, skillRoot });
  context.stable = {
    available: true,
    bridgeState: 'empty',
    kind: 'tailscale-serve',
    tool: 'Tailscale Serve',
    url: 'https://campaigns.example.ts.net/',
  };
  context.targetPort = 4178;
  const commands = [];
  const manager = createDeviceOnboardingManager({
    exec: async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    getContext: async () => context,
    projectRoot: root,
    stateDir: path.join(root, 'state'),
  });

  const started = await manager.start({ runnerId: 'fake' });
  const failed = await waitFor(async () => {
    const job = await manager.get(started.id);
    return job.status === 'failed' ? job : null;
  });
  assert.match(failed.error, /exited with code 2/);
  assert.deepEqual(commands, [
    ['tailscale', 'serve', '--bg', '--yes', 'http://127.0.0.1:4178'],
    ['bash', path.join(skillRoot, 'scripts', 'mdm', 'mdm-down.sh')],
    ['tailscale', 'serve', 'reset'],
  ]);
});

async function writeDeviceItFixture(home) {
  const skillRoot = path.join(home, '.codex', 'skills', 'device-it');
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(skillRoot, 'scripts', 'mdm'), { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# fixture\n', 'utf8');
  await writeFile(path.join(skillRoot, 'scripts', 'run.sh'), '#!/bin/sh\n', 'utf8');
  await writeFile(path.join(skillRoot, 'scripts', 'mdm', 'mdm-down.sh'), '#!/bin/sh\n', 'utf8');
  return skillRoot;
}

function fakeTailscaleExec() {
  return async (_command, args) => {
    if (args[0] === 'status') {
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'campaigns.example.ts.net.', Online: true },
        }),
        stderr: '',
      };
    }
    return { stdout: '{}', stderr: '' };
  };
}

function fakeRunnerRegistry(script) {
  return createRunnerRegistry({
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
    runners: {
      fake: {
        label: 'Fake runner',
        binary: process.execPath,
        args: ['-e', script],
        prompt: { delivery: 'stdin' },
        defaults: { model: 'fake-model', effort: 'high' },
        models: [{ id: 'fake-model', label: 'Fake model' }],
        efforts: [{ id: 'high', label: 'High' }],
        effortMap: { high: 'high' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'fixture.completed', version: 1 },
          sources: [{ kind: 'text' }],
        },
      },
    },
  });
}

function fakeContext({ home, runnerRegistry, skillRoot }) {
  return {
    capability: {
      available: true,
      hint: '',
      runner: { ready: true, id: 'fake', label: 'Fake runner' },
      skill: { ready: true, path: skillRoot },
      stablePrivateUrl: {
        ready: true,
        kind: 'verified-url',
        tool: 'verified URL',
          url: 'https://campaigns.example.ts.net/',
      },
    },
    runner: {
      available: true,
      defaults: { effort: 'high', model: 'fake-model' },
      id: 'fake',
      label: 'Fake runner',
    },
    runnerRegistry,
    skill: {
      available: true,
      outputDir: path.join(home, '.device-it', 'out'),
      path: skillRoot,
      runScript: path.join(skillRoot, 'scripts', 'run.sh'),
      skillPath: path.join(skillRoot, 'SKILL.md'),
    },
    stable: {
      available: true,
      bridgeState: 'verified',
      kind: 'verified-url',
      tool: 'verified URL',
      url: 'https://campaigns.example.ts.net/',
    },
    targetPort: 4178,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { parseCampaignPlan, runPathsForCampaign } from '../lib/pump.mjs';
import { validateRunState } from '../lib/run-state.mjs';
import {
  parseMarkdown,
  replaceFencedBlockContent,
  replaceStepModelValue,
} from '../public/lib/parser.mjs';
import { sortWorktrees } from '../public/lib/worktrees.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve('.');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'campaigns-http-'));
const registryDir = path.join(root, 'registry');
const previousEnv = new Map();

for (const [name, value] of Object.entries({
  CAMPAIGNS_PORT_FILE: path.join(root, 'server.port'),
  CAMPAIGNS_CONFIG_DIR: path.join(root, 'user-config'),
  CAMPAIGNS_REGISTRY_DIR: registryDir,
  CAMPAIGNS_RUNS_DIR: path.join(root, 'runs'),
})) {
  previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

const {
  campaignFileDeletionMode,
  deleteCampaignFile,
  startServer,
} = await import('../server.mjs');

after(async () => {
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root), { code: 'ENOENT' });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('campaign file deletion is recoverable on macOS and explicit permanent removal elsewhere', async () => {
  const fixtureRoot = path.join(root, 'delete-fixture');
  const fakeHome = path.join(fixtureRoot, 'home');
  const trashDir = path.join(fakeHome, '.Trash');
  const trashSource = path.join(fixtureRoot, 'trash-campaign.md');
  const permanentSource = path.join(fixtureRoot, 'permanent-campaign.md');
  await mkdir(trashDir, { recursive: true });
  await writeFile(trashSource, '# Trash fixture\n', 'utf8');
  await writeFile(permanentSource, '# Permanent fixture\n', 'utf8');

  assert.equal(campaignFileDeletionMode('darwin'), 'trash');
  assert.equal(campaignFileDeletionMode('linux'), 'permanent');
  assert.equal(campaignFileDeletionMode('win32'), 'permanent');

  const trashed = await deleteCampaignFile(trashSource, { platform: 'darwin', home: fakeHome });
  assert.equal(trashed.deletionMode, 'trash');
  assert.equal(trashed.trashed, true);
  assert.equal(await readFile(path.join(trashDir, 'trash-campaign.md'), 'utf8'), '# Trash fixture\n');
  await assert.rejects(access(trashSource), { code: 'ENOENT' });

  const deleted = await deleteCampaignFile(permanentSource, { platform: 'win32' });
  assert.deepEqual(deleted, { deletionMode: 'permanent', trashed: false });
  await assert.rejects(access(permanentSource), { code: 'ENOENT' });
});

test('document and registry HTTP contracts hold against a real ephemeral server', async (t) => {
  const fixtureDir = path.join(root, 'http-fixture');
  const campaignPath = path.join(fixtureDir, 'campaign.md');
  const registeredPath = path.join(fixtureDir, 'registered.md');
  const originalMarkdown = '# HTTP fixture\n\nOriginal.\n';
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(campaignPath, originalMarkdown, 'utf8');
  await writeFile(registeredPath, '# Registered fixture\n', 'utf8');

  const server = await startServer({
    campaignFile: campaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
  const capabilities = await capabilitiesResponse.json();
  const deletionMode = campaignFileDeletionMode();
  assert.equal(capabilitiesResponse.status, 200);
  assert.deepEqual(capabilities.fileDeletion, {
    mode: deletionMode,
    requiresExplicitConfirmation: deletionMode === 'permanent',
  });
  assert.equal(typeof capabilities.defaultRunner, 'string');
  assert.ok(Array.isArray(capabilities.runners));
  assert.ok(capabilities.runners.every((runner) => typeof runner.available === 'boolean'));
  assert.ok(Object.hasOwn(capabilities, 'personalLayer'));
  assert.ok(Object.hasOwn(capabilities, 'providers'));

  const documentResponse = await fetch(`${baseUrl}/api/document`);
  const document = await documentResponse.json();
  assert.equal(documentResponse.status, 200);
  assert.equal(document.markdown, originalMarkdown);
  assert.equal(document.hash, hash(originalMarkdown));
  assert.equal(document.filePath, campaignPath);
  assert.deepEqual(document.app, {
    version: packageJson.version,
    platform: process.platform,
  });

  const editableMarkdown = replaceStepModelValue(
    fixtureCampaign(),
    '1.1',
    'GPT-5.6-Sol · High / Fable 5 · High',
  );
  const promptBlock = parseMarkdown(editableMarkdown).find((block) => block.type === 'code');
  const editedPrompt = [
    'Complete the smoke-test step.',
    `CHECK: ${JSON.stringify({
      command: `node -e "console.log('ready|set')"`,
      expectedOutput: 'ready|set',
      timeoutMs: 5_000,
    })}`,
    `CHECK: ${JSON.stringify({
      command: "printf '%s\\n' '$HOME'",
      expectedExit: 0,
      timeoutMs: 1_000,
    })}`,
  ].join('\n');
  const savedMarkdown = replaceFencedBlockContent(editableMarkdown, promptBlock, editedPrompt);
  const checksBeforeSave = parseCampaignPlan(savedMarkdown).steps[0].checks;
  const saveResponse = await fetch(`${baseUrl}/api/document`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: savedMarkdown, baseHash: document.hash }),
  });
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.equal(saved.ok, true);
  assert.equal(saved.hash, hash(savedMarkdown));
  assert.equal(await readFile(campaignPath, 'utf8'), savedMarkdown);

  const reloadedResponse = await fetch(`${baseUrl}/api/document`);
  const reloaded = await reloadedResponse.json();
  assert.equal(reloadedResponse.status, 200);
  assert.equal(reloaded.markdown, savedMarkdown);
  assert.deepEqual(parseCampaignPlan(reloaded.markdown).steps[0].checks, checksBeforeSave);
  assert.equal(parseCampaignPlan(reloaded.markdown).steps[0].model.primary, 'GPT-5.6-Sol · High');

  const onDiskMarkdown = '# HTTP fixture\n\nChanged outside Campaigns.\n';
  await writeFile(campaignPath, onDiskMarkdown, 'utf8');
  const conflictResponse = await fetch(`${baseUrl}/api/document`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '# Browser edit\n', baseHash: saved.hash }),
  });
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    error: 'The markdown file changed on disk after this page loaded. Reload before saving so no work is overwritten.',
    currentHash: hash(onDiskMarkdown),
  });
  assert.equal(await readFile(campaignPath, 'utf8'), onDiskMarkdown);

  const malformedResponse = await fetch(`${baseUrl}/api/registry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath: 42 }),
  });
  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), { error: 'Expected a filePath string.' });

  const registerResponse = await fetch(`${baseUrl}/api/registry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath: registeredPath }),
  });
  const registered = await registerResponse.json();
  assert.equal(registerResponse.status, 200);
  assert.equal(registered.filePath, registeredPath);

  const registryResponse = await fetch(`${baseUrl}/api/registry`);
  const registry = await registryResponse.json();
  assert.equal(registryResponse.status, 200);
  assert.ok(registry.campaigns.some((campaign) => campaign.id === registered.id));
  assert.equal(registry.defaultCampaignId, document.id);

  const deleteExistingResponse = await fetch(`${baseUrl}/api/registry`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: registered.id }),
  });
  assert.equal(deleteExistingResponse.status, 409);
  assert.deepEqual(await deleteExistingResponse.json(), {
    error: 'Campaign file still exists. Only missing campaigns can be removed from the library.',
  });

  await rm(registeredPath);
  const deleteMissingResponse = await fetch(`${baseUrl}/api/registry`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: registered.id }),
  });
  assert.equal(deleteMissingResponse.status, 200);
  assert.deepEqual(await deleteMissingResponse.json(), { ok: true });

  if (process.platform !== 'darwin') {
    const permanentPath = path.join(fixtureDir, 'permanent-delete.md');
    await writeFile(permanentPath, '# Permanent delete fixture\n', 'utf8');
    const permanentRegistration = await fetch(`${baseUrl}/api/registry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: permanentPath }),
    }).then((response) => response.json());

    const unconfirmedDelete = await fetch(`${baseUrl}/api/registry`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: permanentRegistration.id, deleteFile: true }),
    });
    assert.equal(unconfirmedDelete.status, 400);
    assert.deepEqual(await unconfirmedDelete.json(), {
      error: 'Permanent deletion requires confirmPermanentDelete: true.',
    });
    assert.equal(await readFile(permanentPath, 'utf8'), '# Permanent delete fixture\n');

    const confirmedDelete = await fetch(`${baseUrl}/api/registry`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: permanentRegistration.id,
        deleteFile: true,
        confirmPermanentDelete: true,
      }),
    });
    assert.equal(confirmedDelete.status, 200);
    assert.deepEqual(await confirmedDelete.json(), {
      ok: true,
      deletionMode: 'permanent',
      trashed: false,
    });
    await assert.rejects(access(permanentPath), { code: 'ENOENT' });
  }

  const finalRegistry = await fetch(`${baseUrl}/api/registry`).then((response) => response.json());
  assert.ok(!finalRegistry.campaigns.some((campaign) => campaign.id === registered.id));

  await closeServer(server);
  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${baseUrl}/api/document`));
});

test('plan campaign endpoint drafts, validates, registers, salvages failures, and keeps blank creation intact', async (t) => {
  const repo = path.join(root, 'planner-http-fixture');
  const nestedProjectPath = path.join(repo, 'src');
  const runnerScriptPath = path.join(repo, 'fake-planner.mjs');
  await mkdir(nestedProjectPath, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await writeFile(runnerScriptPath, fakePlannerScript(), 'utf8');
  await writeFile(
    path.join(repo, '.campaigns.json'),
    `${JSON.stringify(fakePlannerConfig(runnerScriptPath), null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(repo, 'README.md'), '# Planner fixture\n', 'utf8');

  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  t.after(() => closeServer(server));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const cancelController = new AbortController();
  const cancelledRequest = fetch(`${baseUrl}/api/campaigns/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      effort: 'maximum',
      intent: 'SLOW INTENT so request cancellation is exercised.',
      model: 'fake-model',
      projectPath: nestedProjectPath,
      runnerId: 'fake',
    }),
    signal: cancelController.signal,
  });
  setTimeout(() => cancelController.abort(), 100);
  await assert.rejects(cancelledRequest, (error) => error.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(access(path.join(repo, 'campaigns')), { code: 'ENOENT' });

  const failedResponse = await fetch(`${baseUrl}/api/campaigns/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      effort: 'maximum',
      intent: 'FAIL INTENT so raw salvage is exercised.',
      model: 'fake-model',
      projectPath: nestedProjectPath,
      runnerId: 'fake',
    }),
  });
  const failed = await failedResponse.json();
  assert.equal(failedResponse.status, 422);
  assert.match(failed.error, /invalid campaign/i);
  assert.match(failed.rawOutput, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(failed.rawOutput, /super-secret-value/);

  const plannedResponse = await fetch(`${baseUrl}/api/campaigns/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      effort: 'maximum',
      intent: 'Create a two-phase release campaign. Keep it small and verifiable.',
      model: 'fake-model',
      projectPath: nestedProjectPath,
      runnerId: 'fake',
    }),
  });
  const planned = await plannedResponse.json();
  assert.equal(plannedResponse.status, 201);
  assert.equal(path.dirname(planned.filePath), path.join(await realpath(repo), 'campaigns'));
  assert.equal(planned.boardUrl, `?id=${encodeURIComponent(planned.id)}`);
  assert.deepEqual(planned.selection, { runnerId: 'fake', model: 'fake-model', effort: 'maximum' });
  assert.equal(planned.findings.filter((finding) => finding.severity === 'error').length, 0);
  const draftedMarkdown = await readFile(planned.filePath, 'utf8');
  assert.match(draftedMarkdown, /Model: Fake Planner · Maximum/);
  assert.equal(parseCampaignPlan(draftedMarkdown).steps.length, 2);

  const blankResponse = await fetch(`${baseUrl}/api/campaigns/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Still Blank', projectPath: nestedProjectPath }),
  });
  const blank = await blankResponse.json();
  assert.equal(blankResponse.status, 201);
  assert.equal(blank.filePath, path.join(nestedProjectPath, 'campaigns', 'still-blank.md'));

  for (const created of [planned, blank]) {
    await rm(created.filePath, { force: true });
    const removed = await fetch(`${baseUrl}/api/registry`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    assert.equal(removed.status, 200);
  }

  await closeServer(server);
  assert.equal(server.listening, false);
});

test('worktrees API lists owners, caches sizes, and safely removes orphans and live engine runs', async (t) => {
  const fixtureRoot = path.join(root, 'worktrees-http-fixture');
  const repo = path.join(fixtureRoot, 'repo');
  const campaignsDir = path.join(repo, 'campaigns');
  const liveCampaignPath = path.join(campaignsDir, 'live-worktrees-fixture.md');
  const orphanCampaignPath = path.join(campaignsDir, 'orphan-worktrees-fixture.md');
  const orphanPath = path.join(fixtureRoot, 'codex-orphan');
  const externalPath = path.join(fixtureRoot, 'external');
  const lockedPath = path.join(fixtureRoot, 'locked');
  const config = fakeRunnerConfig();
  config.run.stop_grace_ms = 100;
  config.watchdog = { minimum_runtime_ms: 0, stall_window_ms: 60_000 };
  config.runners.fake.args = [
    '-e',
    'setTimeout(() => process.stdout.write(process.argv[1]), 20000)',
    '{prompt}',
  ];

  await mkdir(campaignsDir, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(liveCampaignPath, fixtureCampaign(), 'utf8');
  await writeFile(orphanCampaignPath, fixtureCampaign(), 'utf8');
  await writeFile(path.join(repo, '.campaigns.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Add worktrees HTTP fixture']);

  const server = await startServer({
    campaignFile: liveCampaignPath,
    port: 0,
    host: '127.0.0.1',
    watchStops: false,
    writePortFile: false,
  });
  t.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const liveCampaign = await fetch(`${baseUrl}/api/document`).then((response) => response.json());
  const orphanCampaign = await fetch(`${baseUrl}/api/registry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath: orphanCampaignPath }),
  }).then((response) => response.json());

  const started = await fetch(`${baseUrl}/api/run/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: liveCampaign.id }),
  });
  assert.equal(started.status, 202);
  await waitFor(async () => {
    const payload = await fetch(`${baseUrl}/api/worktrees`).then((response) => response.json());
    return payload.worktrees?.find((row) => row.owner.backend === 'engine' && row.status === 'live') ?? null;
  }, 8_000);

  await git(repo, ['worktree', 'add', '-b', 'codex/orphan-fixture', orphanPath, 'main']);
  await git(repo, ['worktree', 'add', '-b', 'external/fixture', externalPath, 'main']);
  await git(repo, ['worktree', 'add', '-b', 'locked/fixture', lockedPath, 'main']);
  await git(repo, ['worktree', 'lock', '--reason', 'fixture lock', lockedPath]);
  const externalWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: externalPath,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    externalWorker.once('spawn', resolve);
    externalWorker.once('error', reject);
  });
  t.after(async () => {
    if (externalWorker.exitCode !== null) return;
    externalWorker.kill('SIGTERM');
    await new Promise((resolve) => externalWorker.once('exit', resolve));
  });
  const [orphanCanonical, externalCanonical, lockedCanonical] = await Promise.all([
    realpath(orphanPath),
    realpath(externalPath),
    realpath(lockedPath),
  ]);
  const codexRunDir = path.join(repo, 'reports', 'campaign-automation', 'orphan-worktrees-fixture');
  await mkdir(codexRunDir, { recursive: true });
  await writeFile(path.join(codexRunDir, 'state.json'), `${JSON.stringify({
    campaign: {
      registry_id: orphanCampaign.id,
      status: 'completed',
      source_campaign_path: orphanCampaignPath,
      campaign_path: path.join(orphanPath, 'campaigns', path.basename(orphanCampaignPath)),
      repo_path: orphanPath,
      run_dir: codexRunDir,
      created_at: new Date().toISOString(),
      worktree: {
        base_repo_path: repo,
        path: orphanPath,
        branch: 'codex/orphan-fixture',
      },
    },
    phase: 'complete',
    status: 'completed',
    history: [],
    receipts: [],
  }, null, 2)}\n`, 'utf8');

  const firstResponse = await fetch(`${baseUrl}/api/worktrees`);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.scope, 'registered-campaign-repositories');
  const engineLive = first.worktrees.find((row) => row.owner.backend === 'engine' && row.status === 'live');
  const orphan = first.worktrees.find((row) => row.path === orphanCanonical);
  const external = first.worktrees.find((row) => row.path === externalCanonical);
  const locked = first.worktrees.find((row) => row.path === lockedCanonical);
  const primary = first.worktrees.find((row) => row.primary);
  assert.ok(engineLive);
  assert.equal(engineLive.repo_name, path.basename(repo));
  assert.equal(typeof engineLive.owner.run_id, 'string');
  assert.equal(engineLive.owner.campaign_id, liveCampaign.id);
  assert.equal(orphan.branch, 'codex/orphan-fixture');
  assert.equal(orphan.owner.backend, 'codex');
  assert.equal(orphan.status, 'orphan');
  assert.equal(orphan.size_cached, false);
  assert.ok(orphan.size_bytes > 0);
  assert.ok(orphan.last_touched_at);
  assert.equal(external.owner.backend, 'external');
  assert.equal(external.status, 'live');
  assert.equal(locked.status, 'locked');
  assert.equal(primary.status, 'primary');
  assert.equal(primary.deletable, false);

  const second = await fetch(`${baseUrl}/api/worktrees`).then((response) => response.json());
  assert.equal(second.worktrees.find((row) => row.path === orphanCanonical).size_cached, true);

  const unconfirmedLive = await fetch(`${baseUrl}/api/worktrees`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: engineLive.path }),
  });
  assert.equal(unconfirmedLive.status, 409);
  assert.equal((await unconfirmedLive.json()).confirmationRequired, true);

  const externalLiveDelete = await fetch(`${baseUrl}/api/worktrees`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: externalPath, confirm: true }),
  });
  assert.equal(externalLiveDelete.status, 409);
  assert.equal((await externalLiveDelete.json()).code, 'external_live');

  const bulk = await fetch(`${baseUrl}/api/worktrees`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [primary.path, engineLive.path, externalPath, lockedPath] }),
  }).then((response) => response.json());
  assert.deepEqual(bulk.removed, []);
  assert.equal(bulk.skipped.length, 4);

  const orphanDelete = await fetch(`${baseUrl}/api/worktrees`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: orphanPath }),
  });
  assert.equal(orphanDelete.status, 200);
  assert.equal((await orphanDelete.json()).removed, orphanCanonical);
  assert.doesNotMatch(await git(repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(orphanPath)));

  const confirmedLive = await fetch(`${baseUrl}/api/worktrees`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: engineLive.path, confirm: true }),
  });
  assert.equal(confirmedLive.status, 200);
  assert.equal((await confirmedLive.json()).stopped, true);
  assert.doesNotMatch(await git(repo, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegex(engineLive.path)));

  const indexHtml = await readFile(path.join(projectRoot, 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /id="worktrees-panel"/);
  assert.match(indexHtml, /data-worktree-sort="size"/);
  assert.match(indexHtml, /data-worktree-sort="age"/);
  assert.deepEqual(
    sortWorktrees([
      { path: 'small', size_bytes: 1, last_touched_at: '2026-01-01T00:00:00Z' },
      { path: 'large', size_bytes: 2, last_touched_at: '2026-01-02T00:00:00Z' },
    ], 'size').map((row) => row.path),
    ['large', 'small'],
  );

  await closeServer(server);
});

test('campaigns run completes through the CLI with a fake runner and valid state', async () => {
  const fixtureRoot = path.join(root, 'cli-fixture');
  const repo = path.join(fixtureRoot, 'repo');
  const runsDir = path.join(fixtureRoot, 'runs');
  const campaignPath = path.join(repo, 'campaign.md');
  const configPath = path.join(fixtureRoot, 'campaigns.config.json');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, fixtureCampaign(), 'utf8');
  await writeFile(configPath, `${JSON.stringify(fakeRunnerConfig(), null, 2)}\n`, 'utf8');
  await git(repo, ['add', 'campaign.md']);
  await git(repo, ['commit', '-m', 'Add CLI smoke fixture']);

  const { stderr } = await execFileAsync(process.execPath, [
    path.join(projectRoot, 'bin', 'campaigns.mjs'),
    'run',
    campaignPath,
    '--config',
    configPath,
    '--state-dir',
    runsDir,
    '--no-worktree',
  ], {
    cwd: repo,
    timeout: 20_000,
    env: { ...process.env, CAMPAIGNS_CONFIG_DIR: path.join(fixtureRoot, 'user-config') },
  });
  assert.equal(stderr, '');

  const paths = runPathsForCampaign(campaignPath, runsDir);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.equal(state.run.status, 'completed');
  assert.deepEqual(
    (({ runner, model, effort }) => ({ runner, model, effort }))(state.steps[0]),
    { runner: 'fake', model: 'fake-model', effort: 'none' },
  );
  assert.equal(state.history.at(-1).event, 'final_review_approved');
  assert.equal(state.config.worktree_enabled, false);
  assert.equal(state.artifacts.worktree, null);
  assert.match(await readFile(campaignPath, 'utf8'), /- \[x\] Step 1\.1/);
  assert.equal(await git(repo, ['status', '--short']), '');
});

function hash(markdown) {
  return createHash('sha256').update(markdown).digest('hex');
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fixtureCampaign() {
  return `# CLI smoke campaign

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Exercise the fake runner
- [ ] Final review

## Step 1.1 — Exercise the fake runner

Model: fake-model · none
Parallel: NO

\`\`\`text
Complete the smoke-test step.
\`\`\`

## Final review

\`\`\`text
Review the smoke-test campaign.
\`\`\`
`;
}

function fakeRunnerConfig() {
  const script = `
    const prompt = process.argv[1];
    if (prompt.includes('campaigns.step_completed')) {
      process.stdout.write(prompt);
    } else {
      process.stdout.write('Verdict: APPROVED\\nReasons:\\n\\nCLI smoke passed.');
    }
  `;
  return {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: {
      repoRoot: null,
      branch: null,
      max_steps_per_run: 5,
      max_run_minutes: 1,
      stop_grace_ms: 1_000,
    },
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

function fakePlannerConfig(scriptPath) {
  return {
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 10_000, stall_window_ms: 10_000 },
    run: { max_run_minutes: 1 },
    runners: {
      fake: {
        label: 'Fake planner',
        binary: process.execPath,
        args: [scriptPath],
        prompt: { delivery: 'stdin' },
        defaults: { model: 'fake-model', effort: 'maximum' },
        models: [{ id: 'fake-model', label: 'Fake Planner' }],
        efforts: [{ id: 'maximum', label: 'Maximum' }],
        effortMap: { maximum: 'maximum' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  };
}

function fakePlannerScript() {
  const fixture = plannerFixture('__MODEL_VALUE__');
  return `let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('SLOW INTENT')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('FAIL INTENT')) {
    process.stdout.write('API_TOKEN=super-secret-value\\nnot markdown');
    return;
  }
  const match = prompt.match(/Write this exact line below every step heading: Model: (.+)/);
  process.stdout.write(${JSON.stringify(fixture)}.replaceAll('__MODEL_VALUE__', match?.[1] ?? 'missing'));
});
`;
}

function plannerFixture(modelValue) {
  const stepPrompt = (scope) => `\`\`\`text
SCOPE: ${scope}
REQUIRED READING:
1. README.md
OUTPUT: A checked result.
ACCEPTANCE:
- The result is present.
OPEN QUESTIONS:
- None.
FORWARD SWEEP: before checking this step off, do a quick pass over the campaign's remaining step prompts. If your work moved a path, changed a contract or shape, or invalidated an assumption a later step leans on, make a surgical edit there. A quick sweep, not a rewrite — skip it if nothing downstream changed.
\`\`\``;
  return `# Drafted fake campaign

> A fake runner produces a parser-complete campaign for the HTTP contract.

## Progress checklist

### Phase 1 — Prepare

- [ ] Step 1.1 — Prepare

### Phase 2 — Ship

- [ ] Step 2.1 — Ship
- [ ] Final review

## Step 1.1 — Prepare

Model: ${modelValue}
Parallel: NO

${stepPrompt('Prepare the release.')}

## Step 2.1 — Ship

Model: ${modelValue}
Parallel: NO

${stepPrompt('Ship the release.')}

## Final review

\`\`\`text
Review every acceptance criterion and return APPROVED or NEEDS WORK.
\`\`\`
`;
}

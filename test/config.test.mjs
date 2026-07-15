import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  defaultCampaignsConfigDir,
  formatConfigDoctor,
  resolveCampaignConfig,
} from '../lib/config.mjs';

const execFileAsync = promisify(execFile);

test('config precedence is bundled, project, user, explicit, env, then CLI', async (t) => {
  const fixture = await makeFixture(t);
  const explicitPath = path.join(fixture.root, 'extra.json');
  await writeJson(path.join(fixture.repo, '.campaigns.json'), {
    run: { max_run_minutes: 10, max_parallel_steps: 1 },
  });
  await writeJson(path.join(fixture.userConfigDir, 'config.json'), {
    run: { max_run_minutes: 20 },
  });
  await writeJson(explicitPath, {
    run: { max_run_minutes: 30 },
  });

  const resolved = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    cwd: fixture.outside,
    explicitConfigPath: explicitPath,
    env: {
      CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir,
      CAMPAIGNS_MAX_RUN_MINUTES: '40',
      CAMPAIGNS_MAX_PARALLEL_STEPS: '3',
    },
    cli: { maxRunMinutes: '50', maxParallelSteps: '4' },
  });

  assert.equal(resolved.config.run.max_run_minutes, 50);
  assert.equal(resolved.effective.maxRunMinutes, 50);
  assert.equal(resolved.effective.maxParallelSteps, 4);
  assert.equal(resolved.sources['run.max_parallel_steps'], 'cli:--max-parallel-steps');
  assert.equal(resolved.sources['run.max_run_minutes'], 'cli:--max-run-minutes');
  assert.deepEqual(resolved.files.map(({ kind, loaded }) => [kind, loaded]), [
    ['bundled', true],
    ['project', true],
    ['user', true],
    ['explicit', true],
  ]);
});

test('campaign config comes from the campaign Git root, not process cwd', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.repo, '.campaigns.json'), {
    defaultRunner: 'codex',
  });

  const resolved = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    cwd: fixture.outside,
    env: { CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });

  assert.equal(resolved.projectRoot, fixture.repo);
  assert.equal(resolved.effective.runner, 'codex');
  assert.match(resolved.sources.defaultRunner, /^project:/);
});

test('a higher config layer replaces a same-named runner wholesale', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.repo, '.campaigns.json'), {
    runners: { claude: { binary: '/custom/claude' } },
  });

  const resolved = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    env: { CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });

  assert.deepEqual(resolved.config.runners.claude, { binary: '/custom/claude' });
  assert.equal(resolved.sources['runners.claude.defaults.model'], undefined);
});

test('the winning runnerPaths layer replaces earlier arrays and resolves from its config file', async (t) => {
  const fixture = await makeFixture(t);
  const explicitPath = path.join(fixture.root, 'configs', 'extra.json');
  await mkdir(path.dirname(explicitPath), { recursive: true });
  await writeJson(path.join(fixture.repo, '.campaigns.json'), {
    runnerPaths: ['./project-plugin'],
  });
  await writeJson(path.join(fixture.userConfigDir, 'config.json'), {
    runnerPaths: ['./user-plugin'],
  });
  await writeJson(explicitPath, {
    runnerPaths: ['./explicit-plugin'],
  });

  const withoutExplicit = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    env: { CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });
  const resolved = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    explicitConfigPath: explicitPath,
    env: { CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });

  assert.deepEqual(withoutExplicit.config.runnerPaths, [
    path.join(fixture.userConfigDir, 'user-plugin'),
  ]);
  assert.match(withoutExplicit.sources.runnerPaths, /^user:/);
  assert.deepEqual(resolved.config.runnerPaths, [
    path.join(path.dirname(explicitPath), 'explicit-plugin'),
  ]);
  assert.match(resolved.sources.runnerPaths, /^explicit:/);
  assert.ok(resolved.warnings.some((warning) => (
    warning.includes('runnerPaths[0]') && warning.includes('explicit-plugin')
  )));
  assert.match(formatConfigDoctor(resolved), /runnerPaths:/);
});

test('doctor attributes sources, warns on unknown and dead paths, and masks secrets', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.repo, '.campaigns.json'), {
    run: { repoRoot: './missing-repo' },
    review: { reviewer: 'codex' },
    mystery: { authToken: 'doctor-secret' },
  });

  const resolved = await resolveCampaignConfig({
    campaignPath: fixture.campaignPath,
    env: { CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
    cli: { runner: 'codex' },
  });
  const output = formatConfigDoctor(resolved);

  assert.match(output, new RegExp(`Project root: ${escapeRegex(fixture.repo)}`));
  assert.match(output, /runner: "codex" \[cli:--runner\]/);
  assert.match(output, /reviewer: "codex" \[project:/);
  assert.match(output, /Unknown key "mystery"/);
  assert.match(output, /Path "run\.repoRoot" does not exist/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /doctor-secret/);
});

test('config doctor uses campaign discovery or cwd fallback through the CLI', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.repo, '.campaigns.json'), { defaultRunner: 'codex' });
  const cliPath = path.resolve('bin/campaigns.mjs');

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    'config',
    'doctor',
    fixture.campaignPath,
  ], {
    cwd: fixture.outside,
    env: { ...process.env, CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });

  assert.equal(stderr, '');
  assert.match(stdout, new RegExp(`Project root: ${escapeRegex(fixture.repo)}`));
  assert.match(stdout, /runner: "codex" \[project:/);

  const fromCwd = await execFileAsync(process.execPath, [cliPath, 'config', 'doctor'], {
    cwd: fixture.repo,
    env: { ...process.env, CAMPAIGNS_CONFIG_DIR: fixture.userConfigDir },
  });
  assert.equal(fromCwd.stderr, '');
  assert.match(fromCwd.stdout, new RegExp(`Project root: ${escapeRegex(fixture.repo)}`));
});

test('user config directories follow each platform convention', () => {
  assert.equal(
    defaultCampaignsConfigDir({}, 'darwin', '/home/ada'),
    '/home/ada/Library/Application Support/Campaigns',
  );
  assert.equal(
    defaultCampaignsConfigDir({}, 'linux', '/home/ada'),
    '/home/ada/.config/campaigns',
  );
  assert.equal(
    defaultCampaignsConfigDir({ APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }, 'win32', 'C:\\Users\\Ada'),
    path.join('C:\\Users\\Ada\\AppData\\Roaming', 'Campaigns'),
  );
});

async function makeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'outside');
  const userConfigDir = path.join(root, 'user-config');
  const campaignPath = path.join(repo, 'campaign.md');
  await Promise.all([
    mkdir(repo, { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(userConfigDir, { recursive: true }),
  ]);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(campaignPath, '# Config fixture\n', 'utf8');
  const canonicalRepo = await realpath(repo);
  return {
    root,
    repo: canonicalRepo,
    outside,
    userConfigDir,
    campaignPath: path.join(canonicalRepo, 'campaign.md'),
  };
}

function writeJson(filePath, value) {
  return writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

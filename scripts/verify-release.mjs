#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historical020 = 'f11eb5ca513849a451071d185a8ef6d3d311a5b9';
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const tag = `v${version}`;

assert.match(version, /^\d+\.\d+\.\d+$/, 'package version must be stable semver');
assert.equal(packageJson.private, undefined, 'publishable package must not be private');
assert.equal(packageJson.publishConfig?.access, 'public', 'package must publish publicly');
assert.equal(packageJson.bin?.campaigns, 'bin/campaigns.mjs', 'campaigns bin entry changed');

const [changelog, notes, readme] = await Promise.all([
  readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
  readFile(path.join(root, `docs/releases/${tag}.md`), 'utf8'),
  readFile(path.join(root, 'README.md'), 'utf8'),
]);
assert.match(changelog, new RegExp(`^# Changelog\\n\\n## ${escapeRegex(version)}(?: | —)`), 'current version must lead CHANGELOG');
assert.ok(notes.startsWith(`# Campaigns ${version}\n`), 'release notes title must match package version');
assert.match(readme, /npm view campaigns-app version/, 'README must gate registry install on availability');

await access(path.join(root, packageJson.bin.campaigns));
const historicalPackage = JSON.parse((await execFileAsync(
  'git', ['show', `${historical020}:package.json`], { cwd: root },
)).stdout);
assert.equal(historicalPackage.version, '0.2.0', 'historical 0.2.0 boundary moved');

const pack = JSON.parse((await execFileAsync(
  'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 20 * 1024 * 1024 },
)).stdout)[0];
assert.equal(pack.name, packageJson.name);
assert.equal(pack.version, version);
const packed = new Set(pack.files.map((file) => file.path));
const tracked = new Set((await execFileAsync(
  'git', ['ls-files', '-z'], { cwd: root, maxBuffer: 20 * 1024 * 1024 },
)).stdout.split('\0').filter(Boolean));
const untrackedPacked = [...packed].filter((file) => !tracked.has(file)).sort();
assert.deepEqual(
  untrackedPacked,
  [],
  `package contains untracked files: ${untrackedPacked.join(', ')}`,
);

const changedPacked = (await execFileAsync(
  'git', ['diff', '--name-only', 'HEAD', '--', ...packed], { cwd: root, maxBuffer: 20 * 1024 * 1024 },
)).stdout.trim().split('\n').filter(Boolean).sort();
assert.deepEqual(
  changedPacked,
  [],
  `package contains files changed since HEAD: ${changedPacked.join(', ')}`,
);
for (const required of [
  'README.md',
  'LICENSE',
  'package.json',
  'bin/campaigns.mjs',
  'server.mjs',
  'campaigns.config.json',
  'public/index.html',
  'examples/sample-campaign.md',
  'schema/run-state.schema.json',
  `docs/releases/${tag}.md`,
]) {
  assert.ok(packed.has(required), `package is missing ${required}`);
}
for (const file of packed) {
  assert.doesNotMatch(file, /^(?:campaigns|plans|reports|test|design)\//, `private/development path packed: ${file}`);
  assert.doesNotMatch(file, /(?:^|\/)\.env(?:\.|$)/, `environment file packed: ${file}`);
}

process.stdout.write(`Campaigns ${version} release metadata and ${pack.files.length} packed files verified.\n`);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

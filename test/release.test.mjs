import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('release check rejects an untracked file selected for the npm package', async () => {
  const fixture = path.join(root, 'docs/releases/release-check-untracked-fixture.md');
  await writeFile(fixture, '# Must not ship\n', { flag: 'wx' });

  try {
    const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /package contains untracked files: docs\/releases\/release-check-untracked-fixture\.md/,
    );
  } finally {
    await unlink(fixture);
  }
});

test('release check rejects a packed file that differs from HEAD', async () => {
  const readme = path.join(root, 'README.md');
  const original = await readFile(readme, 'utf8');
  await writeFile(readme, `${original}\n`);

  try {
    const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /package contains files changed since HEAD: .*README\.md/,
    );
  } finally {
    await writeFile(readme, original);
  }
});

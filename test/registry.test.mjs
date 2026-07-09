// Tests for the registry store (lib/registry.mjs): atomic write, JSON
// read/write round-trip, collection normalization, and missing-campaign pruning.
// Everything runs against a throwaway temp dir — never the real registry.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  normalizeRegistryCollections,
  pruneMissingCampaigns,
  readRegistry,
  writeFileAtomic,
  writeRegistry,
} from '../lib/registry.mjs';

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'campaigns-registry-')); });
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test('writeFileAtomic writes contents and leaves no temp file behind', async () => {
  const target = path.join(dir, 'atomic.txt');
  await writeFileAtomic(target, 'hello\n');
  assert.equal(await readFile(target, 'utf8'), 'hello\n');
  const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('readRegistry returns an empty registry for a missing or malformed file', async () => {
  assert.deepEqual(await readRegistry(path.join(dir, 'does-not-exist.json')), { campaigns: [] });
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{ not json', 'utf8');
  await assert.rejects(readRegistry(bad)); // invalid JSON surfaces as a parse error
  const wrongShape = path.join(dir, 'wrong.json');
  await writeFile(wrongShape, JSON.stringify({ campaigns: 'nope' }), 'utf8');
  assert.deepEqual(await readRegistry(wrongShape), { campaigns: [] });
});

test('writeRegistry + readRegistry round-trips and creates the dir', async () => {
  const subDir = path.join(dir, 'nested');
  const registryPath = path.join(subDir, 'registry.json');
  const registry = { campaigns: [{ id: 'a', filePath: '/x/a.md' }] };
  await writeRegistry(subDir, registryPath, registry);
  assert.deepEqual(await readRegistry(registryPath), registry);
});

test('normalizeRegistryCollections trims, drops blanks, and dissolves collections of one', () => {
  const registry = {
    campaigns: [
      { id: '1', collectionId: '  shared  ' }, // trimmed to "shared"
      { id: '2', collectionId: 'shared' }, // pairs with #1 -> kept
      { id: '3', collectionId: 'lonely' }, // only one -> dropped
      { id: '4', collectionId: '   ' }, // blank -> dropped
      { id: '5' }, // no collection -> untouched
    ],
  };
  const changed = normalizeRegistryCollections(registry);
  assert.equal(changed, true);
  assert.equal(registry.campaigns[0].collectionId, 'shared');
  assert.equal(registry.campaigns[1].collectionId, 'shared');
  assert.ok(!('collectionId' in registry.campaigns[2]));
  assert.ok(!('collectionId' in registry.campaigns[3]));
  assert.ok(!('collectionId' in registry.campaigns[4]));

  // A second pass over the normalized registry changes nothing.
  assert.equal(normalizeRegistryCollections(registry), false);
});

test('normalizeRegistryCollections keeps valid stack names and prunes orphaned/blank ones', () => {
  const registry = {
    campaigns: [
      { id: '1', collectionId: 'shared' },
      { id: '2', collectionId: 'shared' },
      { id: '3', collectionId: 'lonely' }, // dissolves -> its name must go too
    ],
    collections: {
      shared: { name: '  Auth Overhaul  ' }, // kept, trimmed
      lonely: { name: 'Orphan' }, // collection dissolves -> dropped
      ghost: { name: 'No such stack' }, // no members at all -> dropped
      blank: { name: '   ' }, // blank name -> dropped
    },
  };
  const changed = normalizeRegistryCollections(registry);
  assert.equal(changed, true);
  assert.deepEqual(registry.collections, { shared: { name: 'Auth Overhaul' } });

  // A second pass changes nothing.
  assert.equal(normalizeRegistryCollections(registry), false);
});

test('normalizeRegistryCollections drops a malformed or emptied collections map', () => {
  const malformed = { campaigns: [], collections: 'nope' };
  assert.equal(normalizeRegistryCollections(malformed), true);
  assert.ok(!('collections' in malformed));

  const emptied = {
    campaigns: [{ id: '1', collectionId: 'a' }, { id: '2', collectionId: 'a' }],
    collections: {},
  };
  assert.equal(normalizeRegistryCollections(emptied), true);
  assert.ok(!('collections' in emptied));
});

test('pruneMissingCampaigns drops long-missing campaigns and keeps the rest', () => {
  const now = Date.parse('2026-07-06T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const registry = {
    campaigns: [
      { id: 'present' }, // no missingSince -> kept
      { id: 'recently-missing', missingSince: new Date(now - day / 2).toISOString() }, // kept
      { id: 'long-missing', missingSince: new Date(now - 2 * day).toISOString() }, // pruned
      { id: 'bad-timestamp', missingSince: 'not-a-date' }, // unparseable -> kept
    ],
  };
  const changed = pruneMissingCampaigns(registry, now, day);
  assert.equal(changed, true);
  assert.deepEqual(
    registry.campaigns.map((c) => c.id),
    ['present', 'recently-missing', 'bad-timestamp'],
  );

  // Nothing left to prune -> no change.
  assert.equal(pruneMissingCampaigns(registry, now, day), false);
});

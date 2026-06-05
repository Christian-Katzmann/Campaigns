import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  isValidPetId,
  listPetIds,
  petDir,
  readPetManifest,
  resolvePetsDir,
  selectPet,
} from '../lib/companion-pets.mjs';

// Build a throwaway pets directory shaped like ${CODEX_HOME}/pets so the tests
// never touch Christian's real ~/.codex.
let petsDir;

async function writePet(id, manifest, { spritesheet = 'spritesheet.webp' } = {}) {
  const dir = path.join(petsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pet.json'), JSON.stringify(manifest));
  if (spritesheet) {
    await writeFile(path.join(dir, spritesheet), Buffer.from('RIFFfakewebp'));
  }
}

before(async () => {
  petsDir = await mkdtemp(path.join(tmpdir(), 'companion-pets-'));

  await writePet('kro', {
    id: 'kro',
    displayName: 'Kro',
    description: 'A tiny black bird.',
    spritesheetPath: 'spritesheet.webp',
  });
  await writePet('momo', {
    id: 'momo',
    displayName: 'Momó',
    description: 'A minimalist octopus.',
    spritesheetPath: 'spritesheet.webp',
  });
  // Manifest with no spritesheet file on disk.
  await writePet(
    'ghost',
    { id: 'ghost', displayName: 'Ghost', description: '', spritesheetPath: 'spritesheet.webp' },
    { spritesheet: null },
  );
  // Hostile manifest that tries to point the spritesheet outside its package.
  await writePet('escape', {
    id: 'escape',
    displayName: 'Escape',
    description: '',
    spritesheetPath: '../../../../etc/passwd',
  });
});

after(async () => {
  if (petsDir) await rm(petsDir, { recursive: true, force: true });
});

test('isValidPetId accepts slugs and rejects traversal', () => {
  assert.ok(isValidPetId('kro'));
  assert.ok(isValidPetId('my-pet_2'));
  assert.ok(!isValidPetId('..'));
  assert.ok(!isValidPetId('a/b'));
  assert.ok(!isValidPetId('../escape'));
  assert.ok(!isValidPetId(''));
  assert.ok(!isValidPetId(null));
  assert.ok(!isValidPetId('pet.json'));
});

test('petDir returns null for invalid ids and stays inside petsDir', () => {
  assert.equal(petDir(petsDir, '../secrets'), null);
  assert.equal(petDir(petsDir, 'a/b'), null);
  assert.equal(petDir(petsDir, 'kro'), path.join(petsDir, 'kro'));
});

test('listPetIds returns valid packages sorted alphabetically', async () => {
  const ids = await listPetIds(petsDir);
  assert.deepEqual(ids, ['escape', 'ghost', 'kro', 'momo']);
});

test('listPetIds returns [] for a missing directory', async () => {
  const ids = await listPetIds(path.join(petsDir, 'does-not-exist'));
  assert.deepEqual(ids, []);
});

test('readPetManifest returns a normalized record for a valid package', async () => {
  const pet = await readPetManifest(petsDir, 'kro');
  assert.equal(pet.id, 'kro');
  assert.equal(pet.displayName, 'Kro');
  assert.equal(pet.spritesheetPath, 'spritesheet.webp');
  assert.equal(pet.spritesheetFile, path.join(petsDir, 'kro', 'spritesheet.webp'));
});

test('readPetManifest rejects a path-traversal spritesheetPath', async () => {
  // The package exists and its manifest parses, but the spritesheet escapes the
  // package directory — it must be treated as unusable, not served.
  const pet = await readPetManifest(petsDir, 'escape');
  assert.equal(pet, null);
});

test('readPetManifest returns null for invalid ids and missing manifests', async () => {
  assert.equal(await readPetManifest(petsDir, '../escape'), null);
  assert.equal(await readPetManifest(petsDir, 'nope'), null);
});

test('selectPet picks the first usable package alphabetically by default', async () => {
  // No env override. Alphabetical order is escape, ghost, kro, momo — but
  // escape's spritesheet escapes its package (rejected) and ghost has no
  // spritesheet on disk (rejected), so the first *usable* package is kro.
  const pet = await selectPet(petsDir, {});
  assert.equal(pet.id, 'kro');
});

test('selectPet honors CAMPAIGNS_COMPANION_PET when valid', async () => {
  const pet = await selectPet(petsDir, { CAMPAIGNS_COMPANION_PET: 'momo' });
  assert.equal(pet.id, 'momo');
});

test('selectPet falls back when the env override is missing/broken', async () => {
  const pet = await selectPet(petsDir, { CAMPAIGNS_COMPANION_PET: 'nope' });
  assert.ok(pet);
  assert.notEqual(pet.id, 'nope');
});

test('selectPet returns null when no usable package exists', async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'companion-pets-empty-'));
  try {
    assert.equal(await selectPet(empty, {}), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('resolvePetsDir defaults to CODEX_HOME/pets and honors overrides', () => {
  assert.equal(resolvePetsDir({ CODEX_HOME: '/tmp/codex' }), path.join('/tmp/codex', 'pets'));
  assert.equal(
    resolvePetsDir({ CAMPAIGNS_PETS_DIR: '/tmp/custom-pets' }),
    path.resolve('/tmp/custom-pets'),
  );
});

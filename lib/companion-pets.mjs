import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Read-only discovery + validation for Codex custom pet packages, used by the
// Campaign Companion. Pets live on disk under ${CODEX_HOME:-$HOME/.codex}/pets
// and are never copied into the repo. Everything here is a pure function over a
// pets directory so the HTTP layer in server.mjs stays thin and the logic is
// testable without starting a server.
//
// Package contract (see ~/.codex/skills/hatch-pet/references/codex-pet-contract.md):
//   <petsDir>/<pet-id>/pet.json          { id, displayName, description, spritesheetPath }
//   <petsDir>/<pet-id>/spritesheet.webp  fixed 1536x1872, 8x9 grid

// Codex sprite atlas contract — fixed grid. The webview animates by stepping
// CSS background positions across these fixed row/column counts.
export const PET_SPRITE = Object.freeze({
  width: 1536,
  height: 1872,
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
});

// Image types the contract allows for a spritesheet.
export const PET_SPRITE_MIME = new Map([
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
]);

// A pet id is the package folder name. Restricting it to a simple slug is the
// first line of defense against path traversal: no slashes, no dots, so it can
// never climb out of the pets directory.
const PET_ID_REGEX = /^[A-Za-z0-9_-]+$/;

// Resolve the pets directory. Defaults to ${CODEX_HOME:-$HOME/.codex}/pets and
// never hardcodes an absolute home. CAMPAIGNS_PETS_DIR is a Campaigns-specific
// override for tests and unusual setups.
export function resolvePetsDir(env = process.env) {
  if (env.CAMPAIGNS_PETS_DIR) return path.resolve(env.CAMPAIGNS_PETS_DIR);
  const codexHome = env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(codexHome, 'pets');
}

export function isValidPetId(id) {
  return typeof id === 'string' && PET_ID_REGEX.test(id);
}

// Resolve a path that must stay inside `baseDir`. Returns the absolute path on
// success, or null if it would escape (traversal, absolute override, symlink-y
// relative paths). Defense in depth — callers also slug-validate ids first.
function resolveWithin(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export function petDir(petsDir, id) {
  if (!isValidPetId(id)) return null;
  return resolveWithin(petsDir, id);
}

// List every directory under petsDir whose name is a valid pet id, sorted
// alphabetically. Returns [] when the directory is missing or unreadable.
export async function listPetIds(petsDir) {
  let entries;
  try {
    entries = await readdir(petsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidPetId(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

// Read and validate one pet package. Returns a normalized record (id is the
// canonical folder name used in URLs) or null if the package is unusable:
// invalid id, missing or corrupt manifest, missing spritesheetPath, or a
// spritesheet that resolves outside the package directory.
export async function readPetManifest(petsDir, id) {
  const dir = petDir(petsDir, id);
  if (!dir) return null;

  let raw;
  try {
    raw = await readFile(path.join(dir, 'pet.json'), 'utf8');
  } catch {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;

  const { displayName, description, spritesheetPath } = manifest;
  if (typeof spritesheetPath !== 'string' || !spritesheetPath) return null;

  // Re-confine the manifest-declared spritesheet to the package directory so a
  // hostile manifest can't point the server at an arbitrary file.
  const spritesheetFile = resolveWithin(dir, spritesheetPath);
  if (!spritesheetFile) return null;

  return {
    id,
    displayName: typeof displayName === 'string' && displayName ? displayName : id,
    description: typeof description === 'string' ? description : '',
    spritesheetPath,
    spritesheetFile,
  };
}

// A package is usable only if its manifest is valid AND its spritesheet is
// actually present on disk — otherwise the companion would select a pet whose
// image 404s.
async function loadUsablePet(petsDir, id) {
  const manifest = await readPetManifest(petsDir, id);
  if (!manifest) return null;
  const details = await statSpritesheet(manifest.spritesheetFile);
  return details ? manifest : null;
}

// Pick the companion pet. Order of preference:
//   1. CAMPAIGNS_COMPANION_PET, when it names a valid, usable package.
//   2. The first usable package alphabetically.
// Alphabetical-first means `kro` is chosen ahead of `momo` without hardcoding a
// pet name in product code. If the env override names a missing/broken package
// we fall through to the alphabetical pick so a usable pet still appears.
// Returns null when no usable package exists, so the companion can render empty
// rather than inventing a built-in asset.
export async function selectPet(petsDir, env = process.env) {
  const preferred = env.CAMPAIGNS_COMPANION_PET;
  if (preferred && isValidPetId(preferred)) {
    const pet = await loadUsablePet(petsDir, preferred);
    if (pet) return pet;
  }
  for (const id of await listPetIds(petsDir)) {
    const pet = await loadUsablePet(petsDir, id);
    if (pet) return pet;
  }
  return null;
}

// Confirm the spritesheet is still present and a regular file before streaming.
// Returns the stat details, or null if it's gone or not a file.
export async function statSpritesheet(spritesheetFile) {
  try {
    const details = await stat(spritesheetFile);
    return details.isFile() ? details : null;
  } catch {
    return null;
  }
}

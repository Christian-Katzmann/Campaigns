// Campaign registry storage: read/write the registry JSON, the atomic file
// writer everything else reuses, collection normalization, and missing-campaign
// pruning. The paths live in server.mjs; these take them as arguments so the
// module stays testable against a throwaway directory.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

// Write via temp file + rename so a crash mid-write can never leave a
// truncated registry or campaign file behind.
export async function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents, 'utf8');
  await rename(tempPath, filePath);
}

export async function readRegistry(registryPath) {
  try {
    const raw = await readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.campaigns)) {
      return { campaigns: [] };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { campaigns: [] };
    throw error;
  }
}

export async function writeRegistry(registryDir, registryPath, registry) {
  await mkdir(registryDir, { recursive: true });
  await writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

// Trim a collectionId to a non-empty string, and drop it entirely when fewer
// than two campaigns share it (a collection of one is just a campaign).
// Also keeps `registry.collections` (the optional per-stack metadata map,
// currently `{ [collectionId]: { name } }`) in sync: trims names, drops
// malformed entries, and drops entries whose collection no longer exists.
// Mutates `registry`; returns whether anything changed.
export function normalizeRegistryCollections(registry) {
  let changed = false;
  const counts = new Map();

  for (const entry of registry.campaigns) {
    if (typeof entry.collectionId !== 'string' || entry.collectionId.trim() === '') {
      if ('collectionId' in entry) {
        delete entry.collectionId;
        changed = true;
      }
      continue;
    }

    const normalized = entry.collectionId.trim();
    if (normalized !== entry.collectionId) {
      entry.collectionId = normalized;
      changed = true;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const entry of registry.campaigns) {
    if (entry.collectionId && (counts.get(entry.collectionId) ?? 0) < 2) {
      delete entry.collectionId;
      changed = true;
    }
  }

  if ('collections' in registry) {
    if (!registry.collections || typeof registry.collections !== 'object' || Array.isArray(registry.collections)) {
      delete registry.collections;
      return true;
    }
    for (const [collectionId, meta] of Object.entries(registry.collections)) {
      const name = typeof meta?.name === 'string' ? meta.name.trim() : '';
      if (name === '' || (counts.get(collectionId) ?? 0) < 2) {
        delete registry.collections[collectionId];
        changed = true;
      } else if (name !== meta.name) {
        meta.name = name;
        changed = true;
      }
    }
    if (Object.keys(registry.collections).length === 0) {
      delete registry.collections;
      changed = true;
    }
  }

  return changed;
}

// Drop campaigns whose file has been gone (`missingSince` set) for longer than
// maxAgeMs. A campaign whose file is present has its missingSince cleared before
// this runs, so a set missingSince means "currently missing". Mutates
// `registry`; returns whether anything was pruned.
export function pruneMissingCampaigns(registry, now, maxAgeMs) {
  const before = registry.campaigns.length;
  registry.campaigns = registry.campaigns.filter((entry) => {
    if (!entry.missingSince) return true;
    const since = Date.parse(entry.missingSince);
    if (!Number.isFinite(since)) return true;
    return now - since < maxAgeMs;
  });
  return registry.campaigns.length !== before;
}

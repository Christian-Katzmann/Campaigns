import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  abandonAutomateCampaign,
  getAutomateState,
  nudgeAutomateState,
  rerunAutomateFinalize,
} from './lib/automate-providers.mjs';
import {
  PET_SPRITE,
  PET_SPRITE_MIME,
  isValidPetId,
  listPetIds,
  readPetManifest,
  resolvePetsDir,
  selectPet,
  statSpritesheet,
} from './lib/companion-pets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const APP_NAME = 'Campaigns';
const APP_SLUG = 'campaigns';
const registryDir = process.env.CAMPAIGNS_REGISTRY_DIR || defaultRegistryDir();
const registryPath = path.join(registryDir, 'registry.json');
const portFilePath = process.env.CAMPAIGNS_PORT_FILE || defaultPortFilePath();
const lessonsHelperPath = process.env.CAMPAIGNS_LESSONS_HELPER || defaultLessonsHelperPath();
// Codex custom pet packages for the Campaign Companion. Resolves to
// ${CODEX_HOME:-$HOME/.codex}/pets (override with CAMPAIGNS_PETS_DIR). Read-only.
const petsDir = resolvePetsDir();
const MISSING_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
// How long a registered campaign can sit with no active automation before the
// companion calls it "stale". Conservative first pass — long enough that a
// normal pause between work sessions doesn't trip it. Tune this one constant.
const COMPANION_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
// Companion-facing status vocabulary. Provider/registry states collapse into
// exactly these values so the companion UI only ever renders a known set.
const COMPANION_STATUSES = [
  'running',
  'queued',
  'stalled',
  'paused',
  'stale',
  'halted',
  'failed',
  'completed',
  'idle',
];
// Maps every status the provider layer (Claude/Codex) or registry can emit onto
// the companion vocabulary above. Anything unmapped falls back to `idle`.
const COMPANION_STATUS_BY_SOURCE = {
  active: 'running',
  running: 'running',
  queued: 'queued',
  scheduled: 'queued',
  stalled: 'stalled',
  blocked: 'stalled',
  paused: 'paused',
  parked: 'paused',
  stale: 'stale',
  halted: 'halted',
  abandoned: 'halted',
  failed: 'failed',
  completed: 'completed',
  complete: 'completed',
  idle: 'idle',
};
const COMPANION_STATUS_LABELS = {
  running: 'Running',
  queued: 'Queued',
  stalled: 'Stalled',
  paused: 'Paused',
  stale: 'Stale',
  halted: 'Halted',
  failed: 'Failed',
  completed: 'Completed',
  idle: 'Idle',
};
const NOTIFICATION_TITLE_MAX = 80;
const NOTIFICATION_MESSAGE_MAX = 500;
const LESSONS_HELPER_TIMEOUT_MS = 8_000;
const LESSONS_TOP_LIMIT = 5;
const NTFY_TOPIC_REGEX = /^[A-Za-z0-9_-]{3,64}$/;

const args = process.argv.slice(2);
const options = parseArgs(args);
const fileArg = options.file ?? process.env.CAMPAIGN_FILE;
const port = Number(options.port ?? process.env.PORT ?? 4178);
// Bind loopback by default: Campaigns is a local-first single-user app, so the
// dev server has no business accepting LAN connections. A non-loopback listener
// also trips the macOS firewall "accept incoming connections?" dialog, which
// would stall an unattended launch. CAMPAIGNS_HOST/HOST override it only for the
// rare setup that genuinely needs a different interface.
const host = process.env.CAMPAIGNS_HOST || process.env.HOST || '127.0.0.1';

let defaultCampaignId = null;

if (fileArg) {
  const absolute = path.resolve(fileArg);
  try {
    await stat(absolute);
  } catch {
    console.error(`File not found: ${absolute}`);
    process.exit(1);
  }
  defaultCampaignId = await ensureRegistered(absolute);
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

const LOGO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (url.pathname === '/api/registry' && request.method === 'GET') {
      await sendRegistry(response);
      return;
    }

    if (url.pathname === '/api/registry' && request.method === 'POST') {
      await registerEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/registry' && request.method === 'DELETE') {
      await deleteMissingRegistryEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/registry/park' && request.method === 'POST') {
      await parkEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/registry/collection' && request.method === 'POST') {
      await collectionEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/registry/icon' && request.method === 'GET') {
      await sendCampaignIcon(url, response);
      return;
    }

    if (url.pathname === '/api/lessons' && request.method === 'GET') {
      await sendLessons(response);
      return;
    }

    if (url.pathname === '/api/document' && request.method === 'GET') {
      await sendDocument(url, response);
      return;
    }

    if (url.pathname === '/api/document' && request.method === 'PUT') {
      await saveDocument(url, request, response);
      return;
    }

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      await sendNotification(request, response);
      return;
    }

    if (url.pathname === '/api/push' && request.method === 'POST') {
      await sendRemoteNotification(request, response);
      return;
    }

    if (url.pathname === '/api/automate-state' && request.method === 'GET') {
      await sendAutomateState(url, response);
      return;
    }

    if (url.pathname === '/api/companion-state' && request.method === 'GET') {
      await sendCompanionState(response);
      return;
    }

    if (url.pathname === '/api/companion-pet' && request.method === 'GET') {
      await sendCompanionPet(response);
      return;
    }

    if (url.pathname === '/api/companion-pet/spritesheet' && request.method === 'GET') {
      await sendCompanionPetSpritesheet(url, response);
      return;
    }

    // Extensionless route for the companion page. Both the browser-popup
    // fallback and the native desktop panel point at `/companion`; serve the
    // real file so neither lands on a 404.
    if (url.pathname === '/companion' && (request.method === 'GET' || request.method === 'HEAD')) {
      await sendStatic('/companion.html', response, request.method === 'HEAD');
      return;
    }

    if (url.pathname === '/api/automate-nudge' && request.method === 'POST') {
      await handleAutomateNudge(request, response);
      return;
    }

    if (url.pathname === '/api/automate-finalize' && request.method === 'POST') {
      await handleAutomateFinalize(request, response);
      return;
    }

    if (url.pathname === '/api/automate-abandon' && request.method === 'POST') {
      await handleAutomateAbandon(request, response);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    await sendStatic(url.pathname, response, request.method === 'HEAD');
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Something went wrong in the Campaigns server.' });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Campaigns: http://localhost:${actualPort}`);
  console.log(`Registry: ${registryPath}`);
  console.log(`Port file: ${portFilePath}`);
  if (fileArg) console.log(`Default file: ${path.resolve(fileArg)}`);
  writeRuntimePort(actualPort).catch((error) => {
    console.error(`Could not write port file: ${error.message}`);
  });
});

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];

    if (value === '--file' || value === '-f') {
      parsed.file = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (value === '--port' || value === '-p') {
      parsed.port = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (!value.startsWith('-') && !parsed.file) {
      parsed.file = value;
    }
  }

  return parsed;
}

function defaultRegistryDir() {
  const home = homedir();

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }

  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_SLUG);
}

function defaultPortFilePath() {
  const home = homedir();

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Logs', APP_NAME, 'server.port');
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME, 'server.port');
  }

  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), APP_SLUG, 'server.port');
}

function defaultLessonsHelperPath() {
  return path.join(homedir(), '.claude', 'skills', 'campaign-planner', 'bin', 'read-past-campaigns.py');
}

async function writeRuntimePort(actualPort) {
  await mkdir(path.dirname(portFilePath), { recursive: true });
  await writeFile(portFilePath, `${actualPort}\n`, 'utf8');
}

/* ------------------------------ Registry ------------------------------------ */

async function readRegistry() {
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

async function writeRegistry(registry) {
  await mkdir(registryDir, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function normalizeRegistryCollections(registry) {
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

  return changed;
}

async function ensureRegistered(absolutePath) {
  const registry = await readRegistry();
  const existing = registry.campaigns.find((entry) => entry.filePath === absolutePath);
  const now = new Date().toISOString();

  if (existing) {
    existing.lastOpenedAt = now;
    await writeRegistry(registry);
    return existing.id;
  }

  const entry = {
    id: randomUUID(),
    filePath: absolutePath,
    createdAt: now,
    lastOpenedAt: now,
    lastActivityAt: now,
  };
  registry.campaigns.push(entry);
  await writeRegistry(registry);
  return entry.id;
}

async function touchCampaign(id) {
  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === id);
  if (!entry) return;
  entry.lastOpenedAt = new Date().toISOString();
  await writeRegistry(registry);
}

async function touchActivity(id) {
  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === id);
  if (!entry) return;
  entry.lastActivityAt = new Date().toISOString();
  await writeRegistry(registry);
}

async function setCampaignParked(id, parked) {
  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === id);
  if (!entry) return { found: false, parkedAt: null };
  if (parked) {
    entry.parkedAt = new Date().toISOString();
  } else {
    delete entry.parkedAt;
  }
  await writeRegistry(registry);
  return { found: true, parkedAt: entry.parkedAt ?? null };
}

async function stackCampaign(sourceId, target) {
  const registry = await readRegistry();
  const source = registry.campaigns.find((entry) => entry.id === sourceId);
  if (!source) return { found: false };

  let collectionId = '';
  if (target.targetCollectionId) {
    collectionId = target.targetCollectionId;
    const collectionExists = registry.campaigns.some((entry) => entry.collectionId === collectionId);
    if (!collectionExists) return { found: false };
  } else if (target.targetId) {
    const targetEntry = registry.campaigns.find((entry) => entry.id === target.targetId);
    if (!targetEntry) return { found: false };
    if (targetEntry.id === source.id) {
      return { found: true, changed: false, collectionId: source.collectionId ?? '', count: 0 };
    }
    collectionId = targetEntry.collectionId || randomUUID();
    targetEntry.collectionId = collectionId;
  }

  if (!collectionId) return { found: false };

  const changed = source.collectionId !== collectionId;
  source.collectionId = collectionId;
  const normalized = normalizeRegistryCollections(registry);
  await writeRegistry(registry);

  const count = registry.campaigns.filter((entry) => entry.collectionId === collectionId).length;
  return { found: true, changed: changed || normalized, collectionId, count };
}

async function removeCampaignFromCollection(id) {
  const registry = await readRegistry();
  const entry = registry.campaigns.find((campaign) => campaign.id === id);
  if (!entry) return { found: false };
  if (!entry.collectionId) return { found: true, changed: false };

  delete entry.collectionId;
  normalizeRegistryCollections(registry);
  await writeRegistry(registry);
  return { found: true, changed: true };
}

async function deleteMissingCampaign(id) {
  const registry = await readRegistry();
  const index = registry.campaigns.findIndex((c) => c.id === id);
  if (index === -1) return { found: false, removed: false };

  const entry = registry.campaigns[index];
  try {
    await stat(entry.filePath);
    return { found: true, removed: false };
  } catch {
    registry.campaigns.splice(index, 1);
    if (defaultCampaignId === id) defaultCampaignId = null;
    normalizeRegistryCollections(registry);
    await writeRegistry(registry);
    return { found: true, removed: true };
  }
}

// Full delete: move the campaign markdown to the macOS Trash, then unregister.
// Using mv to ~/.Trash (collision-safe with a timestamp suffix) instead of
// fs.unlink — the user explicitly asked for a delete option, but losing a
// hand-written campaign markdown permanently is the wrong default. Trash
// gives them Finder-level "Put Back" recovery.
async function fullDeleteCampaign(id) {
  const registry = await readRegistry();
  const index = registry.campaigns.findIndex((c) => c.id === id);
  if (index === -1) return { found: false, removed: false, trashed: false };

  const entry = registry.campaigns[index];
  let trashed = false;
  let trashError = null;
  try {
    await trashCampaignFile(entry.filePath);
    trashed = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      trashed = false; // file was already gone — proceed to unregister anyway
    } else {
      trashError = err.message;
    }
  }

  if (trashError) {
    return { found: true, removed: false, trashed: false, error: trashError };
  }

  registry.campaigns.splice(index, 1);
  if (defaultCampaignId === id) defaultCampaignId = null;
  normalizeRegistryCollections(registry);
  await writeRegistry(registry);
  return { found: true, removed: true, trashed };
}

async function trashCampaignFile(filePath) {
  const trashDir = path.join(homedir(), '.Trash');
  const base = path.basename(filePath);
  let dest = path.join(trashDir, base);
  try {
    await stat(dest);
    // Collision — append a timestamp to keep both files.
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    dest = path.join(trashDir, `${stem} (${ts})${ext}`);
  } catch {
    /* no collision — original dest is fine */
  }
  await rename(filePath, dest);
}

async function setCampaignLogo(id, logoPath) {
  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === id);
  if (!entry) return;
  if (logoPath) entry.logoPath = logoPath;
  else delete entry.logoPath;
  await writeRegistry(registry);
}

async function validateLogoPath(input) {
  if (typeof input !== 'string' || !input) return null;
  const absolute = path.resolve(input);
  const ext = path.extname(absolute).toLowerCase();
  if (!LOGO_MIME.has(ext)) return null;
  try {
    const details = await stat(absolute);
    if (!details.isFile()) return null;
  } catch {
    return null;
  }
  return absolute;
}

async function resolveCampaign(url) {
  const idParam = url.searchParams.get('id');
  const fileParam = url.searchParams.get('file');

  if (idParam) {
    const registry = await readRegistry();
    return registry.campaigns.find((c) => c.id === idParam) ?? null;
  }

  if (fileParam) {
    const absolute = path.resolve(fileParam);
    try {
      await stat(absolute);
    } catch {
      return null;
    }
    const id = await ensureRegistered(absolute);
    const registry = await readRegistry();
    return registry.campaigns.find((c) => c.id === id) ?? null;
  }

  if (defaultCampaignId) {
    const registry = await readRegistry();
    return registry.campaigns.find((c) => c.id === defaultCampaignId) ?? null;
  }

  return null;
}

/* ------------------------------ API: registry ------------------------------- */

async function sendRegistry(response) {
  const registry = await readRegistry();
  const now = Date.now();
  let registryChanged = normalizeRegistryCollections(registry);

  const enriched = await Promise.all(
    registry.campaigns.map(async (entry) => {
      const { logoPath, ...rest } = entry;
      const hasLogo = Boolean(logoPath);
      try {
        const markdown = await readFile(entry.filePath, 'utf8');
        if (entry.missingSince) {
          delete entry.missingSince;
          registryChanged = true;
        }
        const title = extractTitle(markdown) ?? path.basename(entry.filePath, path.extname(entry.filePath));
        const progress = countProgress(markdown);
        return {
          ...rest,
          title,
          progress,
          missing: false,
          hasLogo,
          lastActivityAt: entry.lastActivityAt ?? entry.lastOpenedAt ?? entry.createdAt,
          parkedAt: entry.parkedAt ?? null,
        };
      } catch {
        if (!entry.missingSince) {
          entry.missingSince = new Date(now).toISOString();
          registryChanged = true;
        }
        return {
          ...rest,
          title: path.basename(entry.filePath),
          progress: { done: 0, total: 0 },
          missing: true,
          hasLogo,
          lastActivityAt: entry.lastActivityAt ?? entry.lastOpenedAt ?? entry.createdAt,
          parkedAt: entry.parkedAt ?? null,
        };
      }
    }),
  );

  const visible = enriched.filter((entry) => {
    if (!entry.missing) return true;
    const since = Date.parse(entry.missingSince ?? '');
    if (!Number.isFinite(since)) return true;
    return now - since < MISSING_PRUNE_AFTER_MS;
  });

  if (visible.length !== enriched.length) {
    const keepIds = new Set(visible.map((entry) => entry.id));
    registry.campaigns = registry.campaigns.filter((entry) => keepIds.has(entry.id));
    registryChanged = true;
  }

  registryChanged = normalizeRegistryCollections(registry) || registryChanged;

  if (registryChanged) {
    await writeRegistry(registry);
  }

  sendJson(response, 200, { campaigns: visible, defaultCampaignId, homeDir: homedir() });
}

async function registerEndpoint(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.filePath !== 'string') {
    sendJson(response, 400, { error: 'Expected a filePath string.' });
    return;
  }
  const absolute = path.resolve(payload.filePath);
  try {
    await stat(absolute);
  } catch {
    sendJson(response, 404, { error: 'File does not exist.' });
    return;
  }
  const id = await ensureRegistered(absolute);

  if (payload.logoPath !== undefined) {
    const validated = await validateLogoPath(payload.logoPath);
    await setCampaignLogo(id, validated);
  }

  sendJson(response, 200, { id, filePath: absolute });
}

async function sendCampaignIcon(url, response) {
  const id = url.searchParams.get('id');
  if (!id) {
    sendJson(response, 400, { error: 'id is required.' });
    return;
  }
  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === id);
  if (!entry || !entry.logoPath) {
    sendJson(response, 404, { error: 'No logo for this campaign.' });
    return;
  }
  const ext = path.extname(entry.logoPath).toLowerCase();
  const mime = LOGO_MIME.get(ext);
  if (!mime) {
    sendJson(response, 404, { error: 'Logo path has an unsupported extension.' });
    return;
  }
  try {
    const details = await stat(entry.logoPath);
    response.writeHead(200, {
      'content-type': mime,
      'content-length': details.size,
      'cache-control': 'private, max-age=300',
    });
    createReadStream(entry.logoPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: 'Logo file is no longer present.' });
  }
}

/* ------------------------------ API: lessons -------------------------------- */

async function sendLessons(response) {
  try {
    await stat(lessonsHelperPath);
    const analysis = await readLessonsAnalysis();
    sendJson(response, 200, summarizeLessons(analysis));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    sendJson(response, missing ? 200 : 502, {
      available: false,
      generatedAt: new Date().toISOString(),
      error: missing ? 'Campaign lessons helper is not available.' : 'Campaign lessons could not be loaded.',
    });
  }
}

function readLessonsAnalysis() {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [lessonsHelperPath, '--include-raw'],
      { maxBuffer: 8 * 1024 * 1024, timeout: LESSONS_HELPER_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function summarizeLessons(analysis) {
  const raw = Array.isArray(analysis?.raw) ? analysis.raw : [];
  const recoveredCampaigns = raw.filter((row) => positiveNumber(row.recover_count) > 0).length;
  const warningTags = raw.flatMap((row) => stringArray(row.data_quality_warnings));
  const reasonTags = raw.flatMap((row) => stringArray(row.reasons));
  const legacyReasonTags = raw.flatMap((row) => stringArray(row.legacy_reasons));

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    scanned: {
      claude: positiveNumber(analysis?.scanned?.claude),
      codex: positiveNumber(analysis?.scanned?.codex),
      total: positiveNumber(analysis?.scanned?.total),
    },
    backends: Object.entries(analysis?.backends ?? {}).map(([id, backend]) => ({
      id,
      label: id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : titleCase(id),
      total: positiveNumber(backend?.n_total),
      withVerdict: positiveNumber(backend?.n_with_verdict),
      approvalRate: nullableNumber(backend?.approval_rate),
      firstTryRate: nullableNumber(backend?.first_try_rate),
      reworkRate: nullableNumber(backend?.rework_rate),
      needsWorkAttempts: positiveNumber(backend?.needs_work_attempt_n),
      dataQualityWarnings: positiveNumber(backend?.data_quality_warning_n),
      medianStepCount: nullableNumber(backend?.median_step_count),
    })),
    sizing: {
      medianSteps: nullableNumber(analysis?.sizing?.median_steps),
      p90Steps: nullableNumber(analysis?.sizing?.p90_steps),
      maxFirstTrySteps: nullableNumber(analysis?.sizing?.max_first_try),
      avoidAboveSteps: nullableNumber(analysis?.sizing?.avoid_above),
      sample: positiveNumber(analysis?.sizing?.sample),
    },
    halt: {
      highStepCountCorrelatesWithHalt: Boolean(analysis?.halt_signals?.high_step_count_correlates_with_halt),
      overallRate: nullableNumber(analysis?.halt_signals?.halt_rate_overall),
      highStepCountRate: nullableNumber(analysis?.halt_signals?.halt_rate_high_step_count),
      examples: stringArray(analysis?.halt_signals?.examples).slice(0, 3),
    },
    recovery: {
      campaigns: recoveredCampaigns,
      events: raw.reduce((total, row) => total + positiveNumber(row.recover_count), 0),
    },
    dataQuality: {
      warnings: warningTags.length,
      topWarnings: topCounts(warningTags, LESSONS_TOP_LIMIT),
    },
    reasons: {
      topTags: topCounts(reasonTags, LESSONS_TOP_LIMIT),
      legacyTopTags: topCounts(legacyReasonTags, LESSONS_TOP_LIMIT),
    },
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/* ------------------------------ API: document ------------------------------- */

async function sendDocument(url, response) {
  const campaign = await resolveCampaign(url);
  if (!campaign) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }
  try {
    const markdown = await readFile(campaign.filePath, 'utf8');
    const details = await stat(campaign.filePath);
    await touchCampaign(campaign.id);
    sendJson(response, 200, {
      id: campaign.id,
      filePath: campaign.filePath,
      lastModified: details.mtime.toISOString(),
      hash: hashMarkdown(markdown),
      markdown,
      hasLogo: Boolean(campaign.logoPath),
    });
  } catch {
    sendJson(response, 404, { error: 'File not found on disk.' });
  }
}

async function saveDocument(url, request, response) {
  const campaign = await resolveCampaign(url);
  if (!campaign) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }
  const payload = await readJsonBody(request);

  if (typeof payload.markdown !== 'string') {
    sendJson(response, 400, { error: 'Expected a markdown string.' });
    return;
  }

  if (typeof payload.baseHash === 'string') {
    const currentMarkdown = await readFile(campaign.filePath, 'utf8');
    const currentHash = hashMarkdown(currentMarkdown);

    if (currentHash !== payload.baseHash) {
      sendJson(response, 409, {
        error:
          'The markdown file changed on disk after this page loaded. Reload before saving so no work is overwritten.',
        currentHash,
      });
      return;
    }
  }

  await writeFile(campaign.filePath, payload.markdown, 'utf8');
  const details = await stat(campaign.filePath);
  await touchActivity(campaign.id);

  sendJson(response, 200, {
    ok: true,
    lastModified: details.mtime.toISOString(),
    hash: hashMarkdown(payload.markdown),
  });
}

async function parkEndpoint(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string' || typeof payload.parked !== 'boolean') {
    sendJson(response, 400, { error: 'Expected { id: string, parked: boolean }.' });
    return;
  }
  const result = await setCampaignParked(payload.id, payload.parked);
  if (!result.found) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }
  sendJson(response, 200, { ok: true, parkedAt: result.parkedAt });
}

async function collectionEndpoint(request, response) {
  const payload = await readJsonBody(request);

  if (payload.action === 'remove') {
    if (typeof payload.id !== 'string') {
      sendJson(response, 400, { error: 'Expected { action: "remove", id: string }.' });
      return;
    }
    const result = await removeCampaignFromCollection(payload.id);
    if (!result.found) {
      sendJson(response, 404, { error: 'Campaign not found.' });
      return;
    }
    sendJson(response, 200, { ok: true, changed: result.changed });
    return;
  }

  if (payload.action === 'stack') {
    const targetId = typeof payload.targetId === 'string' ? payload.targetId : '';
    const targetCollectionId =
      typeof payload.targetCollectionId === 'string' ? payload.targetCollectionId : '';
    if (
      typeof payload.sourceId !== 'string' ||
      (targetId === '' && targetCollectionId === '') ||
      (targetId !== '' && targetCollectionId !== '')
    ) {
      sendJson(response, 400, {
        error:
          'Expected { action: "stack", sourceId: string, targetId: string } or { action: "stack", sourceId: string, targetCollectionId: string }.',
      });
      return;
    }

    const result = await stackCampaign(payload.sourceId, { targetId, targetCollectionId });
    if (!result.found) {
      sendJson(response, 404, { error: 'Campaign or collection not found.' });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      changed: result.changed,
      collectionId: result.collectionId,
      count: result.count,
    });
    return;
  }

  sendJson(response, 400, { error: 'Expected action to be "stack" or "remove".' });
}

async function deleteMissingRegistryEndpoint(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  // Two modes:
  //   - { id }                       → legacy: unregister only if file already missing
  //   - { id, deleteFile: true }     → full delete: move file to Trash + unregister
  if (payload.deleteFile === true) {
    const result = await fullDeleteCampaign(payload.id);
    if (!result.found) {
      sendJson(response, 404, { error: 'Campaign not found.' });
      return;
    }
    if (result.error) {
      sendJson(response, 500, { error: `Could not move file to Trash: ${result.error}` });
      return;
    }
    sendJson(response, 200, { ok: true, trashed: result.trashed });
    return;
  }

  const result = await deleteMissingCampaign(payload.id);
  if (!result.found) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }
  if (!result.removed) {
    sendJson(response, 409, {
      error: 'Campaign file still exists. Only missing campaigns can be removed from the library.',
    });
    return;
  }

  sendJson(response, 200, { ok: true });
}

async function sendNotification(request, response) {
  const payload = await readJsonBody(request);
  const title = notificationText(payload.title, 'Campaigns', NOTIFICATION_TITLE_MAX);
  const message = notificationText(payload.message, '', NOTIFICATION_MESSAGE_MAX);

  if (!message) {
    sendJson(response, 400, { error: 'Message is required.' });
    return;
  }

  if (process.platform !== 'darwin') {
    sendJson(response, 501, { error: 'Native notifications are only available on macOS.' });
    return;
  }

  execFile(
    'osascript',
    [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      '-e',
      'end run',
      title,
      message,
    ],
    { timeout: 5000 },
    (error) => {
      if (error) {
        console.error('Failed to display native notification:', error);
        sendJson(response, 500, { error: 'Failed to trigger notification.' });
        return;
      }
      sendJson(response, 200, { ok: true });
    },
  );
}

async function sendRemoteNotification(request, response) {
  const payload = await readJsonBody(request);
  const title = notificationText(payload.title, 'Campaigns', NOTIFICATION_TITLE_MAX);
  const message = notificationText(payload.message, '', NOTIFICATION_MESSAGE_MAX);
  const ntfyTopic = typeof payload.ntfyTopic === 'string' ? payload.ntfyTopic.trim() : '';
  const webhookUrl = typeof payload.webhookUrl === 'string' ? payload.webhookUrl.trim() : '';

  if (!message) {
    sendJson(response, 400, { error: 'Message is required.' });
    return;
  }

  const deliveries = [];

  if (ntfyTopic) {
    if (!NTFY_TOPIC_REGEX.test(ntfyTopic)) {
      sendJson(response, 400, {
        error: 'ntfy topic must be 3-64 letters, numbers, dashes, or underscores.',
      });
      return;
    }

    deliveries.push({
      channel: 'ntfy',
      promise: fetchWithTimeout(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`, {
        method: 'POST',
        body: message,
        headers: { Title: title },
      }),
    });
  }

  if (webhookUrl) {
    const webhook = parseWebhookUrl(webhookUrl);
    if (!webhook) {
      sendJson(response, 400, {
        error: 'Webhook must be a Slack or Discord HTTPS webhook URL.',
      });
      return;
    }

    const body = webhook.kind === 'discord'
      ? { content: `**${title}**: ${message}` }
      : { text: `${title}: ${message}` };

    deliveries.push({
      channel: webhook.kind,
      promise: fetchWithTimeout(webhook.url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    });
  }

  if (deliveries.length === 0) {
    sendJson(response, 400, { error: 'No remote notification channel is configured.' });
    return;
  }

  const settled = await Promise.allSettled(deliveries.map((delivery) => delivery.promise));
  const failures = [];

  settled.forEach((result, index) => {
    const channel = deliveries[index].channel;
    if (result.status === 'rejected') {
      failures.push({ channel, error: result.reason?.message ?? 'Request failed.' });
      return;
    }
    if (!result.value.ok) {
      failures.push({ channel, error: `HTTP ${result.value.status}` });
    }
  });

  if (failures.length > 0) {
    sendJson(response, 502, { ok: false, failures });
    return;
  }

  sendJson(response, 200, { ok: true });
}

function notificationText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function parseWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();

  if (host === 'hooks.slack.com' && url.pathname.startsWith('/services/')) {
    return { kind: 'slack', url: url.toString() };
  }

  if (
    (host === 'discord.com' || host === 'discordapp.com') &&
    url.pathname.startsWith('/api/webhooks/')
  ) {
    return { kind: 'discord', url: url.toString() };
  }

  return null;
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ Markdown helpers ---------------------------- */

function extractTitle(markdown) {
  const match = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function countProgress(markdown) {
  let total = 0;
  let done = 0;
  const lines = markdown.split('\n');
  const hasProgressChecklist = lines.some((line) => isProgressChecklistHeadingLine(line));
  let inProgressChecklist = !hasProgressChecklist;
  let inCodeFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (isH2HeadingLine(line)) {
      inProgressChecklist = isProgressChecklistHeadingLine(line);
      continue;
    }
    if (!inProgressChecklist) continue;

    const checkMatch = line.match(/^\s*[-*]\s+\[([ xX])\]/);
    if (checkMatch) {
      total += 1;
      if (checkMatch[1].toLowerCase() === 'x') done += 1;
      continue;
    }
    if (!/^\s*\|.+\|\s*$/.test(line)) continue;
    for (const cell of line.split('|').slice(1, -1)) {
      const content = cell.trim();
      if (content === '☐') total += 1;
      else if (content === '☑') {
        total += 1;
        done += 1;
      }
    }
  }
  return { done, total };
}

function isH2HeadingLine(line) {
  return /^\s*##(?!#)\s+/.test(line);
}

function isProgressChecklistHeadingLine(line) {
  const match = line.match(/^\s*##(?!#)\s+(.+?)\s*#*\s*$/);
  return Boolean(match && match[1].toLowerCase().includes('progress checklist'));
}

/* ------------------------------ API: automate state ------------------------- */

async function sendAutomateState(url, response) {
  const id = url.searchParams.get('id');

  if (id) {
    const registry = await readRegistry();
    const entry = registry.campaigns.find((c) => c.id === id);
    if (!entry) {
      sendJson(response, 404, { error: 'Campaign not found.' });
      return;
    }
    const state = await getAutomateState(entry.filePath);
    sendJson(response, 200, state);
    return;
  }

  const registry = await readRegistry();
  const states = {};
  await Promise.all(
    registry.campaigns.map(async (entry) => {
      states[entry.id] = await getAutomateState(entry.filePath, { summary: true });
    }),
  );
  sendJson(response, 200, states);
}

/* ------------------------------ API: companion state ------------------------ */

// Read-only aggregate for the Campaign Companion. Turns the registry + the
// automation provider summaries into one compact payload: no file paths, no
// prompt/log bodies, just enough to show what each campaign is doing. This
// endpoint must not mutate the registry, markdown, or automation state — unlike
// sendRegistry it never writes back.
async function sendCompanionState(response) {
  const registry = await readRegistry();
  const now = Date.now();

  const campaigns = await Promise.all(
    registry.campaigns.map((entry) => buildCompanionCampaign(entry, now)),
  );

  sendJson(response, 200, {
    generatedAt: new Date(now).toISOString(),
    counts: tallyCompanionCounts(campaigns),
    campaigns,
  });
}

async function buildCompanionCampaign(entry, now) {
  const parked = Boolean(entry.parkedAt);
  const lastActivityAt = entry.lastActivityAt ?? entry.lastOpenedAt ?? entry.createdAt ?? null;

  let title;
  let progress;
  let missing;
  try {
    const markdown = await readFile(entry.filePath, 'utf8');
    title = extractTitle(markdown) ?? path.basename(entry.filePath, path.extname(entry.filePath));
    progress = countProgress(markdown);
    missing = false;
  } catch {
    // Markdown gone from disk — represent it clearly, never crash aggregation.
    title = path.basename(entry.filePath);
    progress = { done: 0, total: 0 };
    missing = true;
  }

  let summary = null;
  try {
    summary = await getAutomateState(entry.filePath, { summary: true });
  } catch (error) {
    // A single bad provider state must not take down the whole companion feed.
    console.error(`companion-state: automation summary failed for ${entry.id}:`, error.message);
  }

  const backend = summary?.backend ?? null;
  const status = deriveCompanionStatus({ summary, parked, lastActivityAt, now });
  const currentStep =
    summary?.current_step_id || summary?.current_step_name
      ? { id: summary.current_step_id ?? null, name: summary.current_step_name ?? null }
      : null;

  return {
    id: entry.id,
    title,
    backend,
    status,
    label: COMPANION_STATUS_LABELS[status] ?? COMPANION_STATUS_LABELS.idle,
    is_active: status === 'running',
    current_step: currentStep,
    progress,
    lastActivityAt,
    parked,
    missing,
  };
}

// Collapses provider + registry signals into one companion status. Mirrors the
// frontend's automateDisplayStatus (an 'active' summary with is_active === false
// is really stalled), then layers on stale detection and the parked → paused
// rule.
function deriveCompanionStatus({ summary, parked, lastActivityAt, now }) {
  let providerStatus = summary?.status ?? null;
  if (providerStatus === 'active' && summary?.is_active === false) {
    providerStatus = 'stalled';
  }

  let status = providerStatus ? COMPANION_STATUS_BY_SOURCE[providerStatus] ?? 'idle' : 'idle';

  // A registered campaign with nothing running that hasn't moved in a long time
  // reads as stale rather than merely idle.
  if (status === 'idle' && isCompanionStale(lastActivityAt, now)) {
    status = 'stale';
  }

  // Parked is a deliberate user action — it wins over idle/stale, but real
  // automation evidence (running, an attention state, a terminal result) still
  // shows through so a parked-but-active campaign isn't hidden.
  if (parked && (status === 'idle' || status === 'stale')) {
    status = 'paused';
  }

  return status;
}

function isCompanionStale(lastActivityAt, now) {
  if (!lastActivityAt) return false;
  const ms = Date.parse(lastActivityAt);
  if (!Number.isFinite(ms)) return false;
  return now - ms > COMPANION_STALE_AFTER_MS;
}

function tallyCompanionCounts(campaigns) {
  const counts = { total: campaigns.length };
  for (const status of COMPANION_STATUSES) counts[status] = 0;
  for (const campaign of campaigns) {
    counts[campaign.status] = (counts[campaign.status] ?? 0) + 1;
  }
  return counts;
}

/* ------------------------------ API: companion pet -------------------------- */

// Read-only discovery + serving for the Campaign Companion's visual pet. Pets
// are Codex custom-pet packages under ${CODEX_HOME:-$HOME/.codex}/pets; nothing
// is copied into the repo. Returns the selected pet's metadata with a served
// spritesheet URL plus the fixed sprite-atlas grid, or { pet: null } when no
// usable package exists so the UI can render empty. `available` lists every
// usable package id (handy for a future picker).
async function sendCompanionPet(response) {
  const [pet, available] = await Promise.all([selectPet(petsDir), listPetIds(petsDir)]);

  if (!pet) {
    sendJson(response, 200, { pet: null, available });
    return;
  }

  sendJson(response, 200, {
    pet: {
      id: pet.id,
      displayName: pet.displayName,
      description: pet.description,
      spritesheetPath: pet.spritesheetPath,
      spritesheetUrl: `/api/companion-pet/spritesheet?id=${encodeURIComponent(pet.id)}`,
      sprite: PET_SPRITE,
    },
    available,
  });
}

// Serve a pet spritesheet. Guards at every step: the id must be a simple slug,
// the manifest must resolve a spritesheet inside the package directory, and the
// extension must be a contract-allowed image type. Path traversal cannot escape
// the pets directory — the id is slug-validated and the manifest's spritesheet
// path is re-confined to the package dir inside readPetManifest.
async function sendCompanionPetSpritesheet(url, response) {
  const id = url.searchParams.get('id');
  if (!isValidPetId(id)) {
    sendJson(response, 400, { error: 'Invalid pet id.' });
    return;
  }

  const pet = await readPetManifest(petsDir, id);
  if (!pet) {
    sendJson(response, 404, { error: 'Pet package not found.' });
    return;
  }

  const ext = path.extname(pet.spritesheetFile).toLowerCase();
  const mime = PET_SPRITE_MIME.get(ext);
  if (!mime) {
    sendJson(response, 404, { error: 'Unsupported spritesheet type.' });
    return;
  }

  const details = await statSpritesheet(pet.spritesheetFile);
  if (!details) {
    sendJson(response, 404, { error: 'Spritesheet file is no longer present.' });
    return;
  }

  response.writeHead(200, {
    'content-type': mime,
    'content-length': details.size,
    'cache-control': 'private, max-age=300',
  });
  createReadStream(pet.spritesheetFile).pipe(response);
}

async function handleAutomateNudge(request, response) {
  const payload = await readJsonBody(request);

  if (typeof payload.id !== 'string' || typeof payload.mode !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string, mode: string }.' });
    return;
  }

  const validModes = ['continue', 'restart', 'skip', 'restart_failed'];
  if (!validModes.includes(payload.mode)) {
    sendJson(response, 400, {
      error: `Invalid mode. Expected one of: ${validModes.join(', ')}`,
    });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  const result = await nudgeAutomateState(entry.filePath, payload.mode);
  sendJson(response, result.ok ? 200 : 502, result);
}

async function handleAutomateFinalize(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  const result = await rerunAutomateFinalize(entry.filePath);
  sendJson(response, result.ok ? 200 : 502, result);
}

async function handleAutomateAbandon(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((c) => c.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  const result = await abandonAutomateCampaign(entry.filePath);
  sendJson(response, result.ok ? 200 : 502, result);
}

/* ------------------------------ Plumbing ------------------------------------ */

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;

  for await (const chunk of request) {
    byteLength += chunk.length;

    if (byteLength > 2_000_000) {
      throw new Error('Request body is too large.');
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : {};
}

async function sendStatic(urlPath, response, headOnly) {
  const normalizedPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const requestedPath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, '');
  const staticPath = path.join(publicDir, requestedPath);

  if (!staticPath.startsWith(publicDir)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const details = await stat(staticPath);
    const extension = path.extname(staticPath);

    response.writeHead(200, {
      'content-length': details.size,
      'content-type': mimeTypes.get(extension) ?? 'application/octet-stream',
    });

    if (headOnly) {
      response.end();
      return;
    }

    createReadStream(staticPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function hashMarkdown(markdown) {
  return createHash('sha256').update(markdown).digest('hex');
}

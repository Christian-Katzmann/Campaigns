import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createCampaignFromMarkdown, createCampaignScaffold } from './lib/campaign-scaffold.mjs';
import {
  abandonAutomateCampaign,
  getAutomateProviderAvailability,
  getAutomateState,
  getEngineRunLedger,
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
import { httpError, readJsonBody, sendJson, sendStatic } from './lib/http.mjs';
import { resolveCampaignConfig } from './lib/config.mjs';
import { estimateCampaign } from './lib/estimate.mjs';
import { hasUnifiedRunLedgers, loadUnifiedLessons, readUnifiedRunLedgers } from './lib/lessons.mjs';
import { PlannerDraftError, draftCampaign } from './lib/planner.mjs';
import {
  CampaignStopError,
  defaultCampaignsRunsDir,
  parseCampaignPlan,
  requestCampaignStop,
  resolveStepRunnerSelection,
  runCampaign,
} from './lib/pump.mjs';
import { RecoveryError, recoverCampaign } from './lib/recovery.mjs';
import { createRunnerRegistry, loadRunnerRegistry, runnerCapabilities } from './lib/runners.mjs';
import {
  normalizeRegistryCollections,
  pruneMissingCampaigns,
  readRegistry as readRegistryFrom,
  writeFileAtomic,
  writeRegistry as writeRegistryTo,
} from './lib/registry.mjs';
import {
  classifyStopWatcherAlerts,
  defaultNotificationSettings,
  deliverRemoteNotification,
  displayNativeNotification,
  hashString,
  nextStopWatcherRecord,
  normalizeStopWatcherStatus,
  notificationText,
  sanitizeNotificationSettings,
  stopWatcherFingerprint,
} from './lib/notifications.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const docsDir = path.join(__dirname, 'docs');
const { version: APP_VERSION } = JSON.parse(await readFile(path.join(__dirname, 'package.json'), 'utf8'));
const APP_NAME = 'Campaigns';
const APP_SLUG = 'campaigns';
const registryDir = process.env.CAMPAIGNS_REGISTRY_DIR || defaultRegistryDir();
const registryPath = path.join(registryDir, 'registry.json');
const notificationSettingsPath = path.join(registryDir, 'notification-settings.json');
const stopWatcherStatePath = path.join(registryDir, 'stop-watcher-state.json');
const portFilePath = process.env.CAMPAIGNS_PORT_FILE || defaultPortFilePath();
const lessonsHelperPath = process.env.CAMPAIGNS_LESSONS_HELPER || defaultLessonsHelperPath();
const lessonsRunsDir = defaultCampaignsRunsDir();
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
  cap_reached: 'stalled',
  awaiting_human_review: 'stalled',
  paused: 'paused',
  parked: 'paused',
  stale: 'stale',
  halted: 'halted',
  abandoned: 'halted',
  stopped_by_user: 'halted',
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
const STOP_WATCH_INTERVAL_MS = positiveDuration(process.env.CAMPAIGNS_STOP_WATCH_INTERVAL_MS, 30_000);
const STOP_WATCH_NO_MOVEMENT_MS = positiveDuration(process.env.CAMPAIGNS_STOP_WATCH_NO_MOVEMENT_MS, 15 * 60 * 1000);
const LESSONS_HELPER_TIMEOUT_MS = 8_000;
const LESSONS_TOP_LIMIT = 5;

const LOGO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
]);
const LOGO_EXTENSIONS = [...LOGO_MIME.keys()];

let defaultCampaignId = null;
const activeCampaignRuns = new Map();

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

    if (url.pathname === '/api/campaigns/new' && request.method === 'POST') {
      await newCampaignEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/campaigns/plan' && request.method === 'POST') {
      await planCampaignEndpoint(request, response);
      return;
    }

    if (url.pathname === '/api/workflows' && request.method === 'GET') {
      await sendWorkflows(response);
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

    if (url.pathname === '/api/capabilities' && request.method === 'GET') {
      await sendCapabilities(url, response);
      return;
    }

    if (url.pathname === '/api/lessons' && request.method === 'GET') {
      await sendLessons(response);
      return;
    }

    if (url.pathname === '/api/estimate' && request.method === 'GET') {
      await sendEstimate(url, response);
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

    if (url.pathname === '/api/notification-settings' && request.method === 'GET') {
      await sendNotificationSettings(response);
      return;
    }

    if (url.pathname === '/api/notification-settings' && request.method === 'PUT') {
      await saveNotificationSettingsEndpoint(request, response);
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
      await sendStatic(publicDir, '/companion.html', response, request.method === 'HEAD');
      return;
    }

    if (url.pathname === '/planner-prompt' && (request.method === 'GET' || request.method === 'HEAD')) {
      await sendStatic(docsDir, '/paste-anywhere-planner.md', response, request.method === 'HEAD');
      return;
    }

    if (url.pathname === '/api/automate-nudge' && request.method === 'POST') {
      await handleAutomateNudge(request, response);
      return;
    }

    if (url.pathname === '/api/run/recover' && request.method === 'POST') {
      await handleRunRecover(request, response);
      return;
    }

    if (url.pathname === '/api/run/start' && request.method === 'POST') {
      await handleRunStart(request, response);
      return;
    }

    if (url.pathname === '/api/run/stop' && request.method === 'POST') {
      await handleRunStop(request, response);
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

    await sendStatic(publicDir, url.pathname, response, request.method === 'HEAD');
  } catch (error) {
    console.error(error);
    if (error?.statusCode) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: 'Something went wrong in the Campaigns server.' });
  }
});

const closeHttpServer = server.close.bind(server);
server.close = function closeCampaignsServer(callback) {
  void stopActiveCampaignRuns()
    .catch(() => abortActiveCampaignRuns())
    .finally(() => closeHttpServer(callback));
  return server;
};

server.on('close', stopStopWatcher);
server.on('close', abortActiveCampaignRuns);

export async function startServer({
  campaignFile = null,
  port = 4178,
  host = '127.0.0.1',
  watchStops = true,
  writePortFile = true,
} = {}) {
  if (server.listening) throw new Error('Campaigns server is already listening.');

  defaultCampaignId = null;
  const absoluteCampaignFile = campaignFile ? path.resolve(campaignFile) : null;
  if (absoluteCampaignFile) {
    try {
      await stat(absoluteCampaignFile);
    } catch {
      throw new Error(`File not found: ${absoluteCampaignFile}`);
    }
    defaultCampaignId = await ensureRegistered(absoluteCampaignFile);
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(Number(port), host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : Number(port);
  console.log(`Campaigns: http://localhost:${actualPort}`);
  console.log(`Registry: ${registryPath}`);
  console.log(`Port file: ${portFilePath}`);
  if (absoluteCampaignFile) console.log(`Default file: ${absoluteCampaignFile}`);
  if (writePortFile) {
    writeRuntimePort(actualPort).catch((error) => {
      console.error(`Could not write port file: ${error.message}`);
    });
  }
  if (watchStops) startStopWatcher();
  return server;
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const campaignFile = options.file ?? process.env.CAMPAIGN_FILE ?? null;
  const port = Number(options.port ?? process.env.PORT ?? 4178);
  // Bind loopback by default: Campaigns is a local-first single-user app, so the
  // dev server has no business accepting LAN connections. A non-loopback listener
  // also trips the macOS firewall "accept incoming connections?" dialog, which
  // would stall an unattended launch. CAMPAIGNS_HOST/HOST override it only for the
  // rare setup that genuinely needs a different interface.
  const host = process.env.CAMPAIGNS_HOST || process.env.HOST || '127.0.0.1';

  try {
    await startServer({ campaignFile, port, host });
    const shutdown = () => { void shutdownCliServer(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — another Campaigns server may be running.`);
      console.error('Stop it first, or start this one on a different port: node server.mjs --port <number>');
    } else {
      console.error(error.message ?? error);
    }
    process.exitCode = 1;
  }
}

let cliShutdownPromise = null;

function shutdownCliServer() {
  if (cliShutdownPromise) return cliShutdownPromise;
  cliShutdownPromise = (async () => {
    await stopActiveCampaignRuns();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  })();
  return cliShutdownPromise;
}

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

function positiveDuration(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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

async function sendCapabilities(url, response) {
  const campaign = await resolveCampaign(url);
  let runnerRegistry;
  let runnerCwd = __dirname;
  try {
    const resolved = await resolveCampaignConfig({
      campaignPath: campaign?.filePath ?? null,
      cwd: __dirname,
    });
    runnerRegistry = createRunnerRegistry(resolved.config);
    runnerCwd = resolved.projectRoot;
  } catch (error) {
    if (!/No Git project root found/.test(error.message)) throw error;
    runnerRegistry = await loadRunnerRegistry();
  }
  const [automation, nativeLessons, legacyLessons, runners] = await Promise.all([
    getAutomateProviderAvailability(),
    hasUnifiedRunLedgers(lessonsRunsDir).catch(() => false),
    stat(lessonsHelperPath).then((info) => info.isFile()).catch(() => false),
    runnerCapabilities(runnerRegistry, { cwd: runnerCwd }),
  ]);
  const fileDeletionMode = campaignFileDeletionMode();
  sendJson(response, 200, {
    fileDeletion: {
      mode: fileDeletionMode,
      requiresExplicitConfirmation: fileDeletionMode === 'permanent',
    },
    personalLayer: {
      automate: automation.available,
      away: automation.available,
      companion: automation.available,
      lessons: nativeLessons || legacyLessons,
    },
    providers: automation.providers,
    defaultRunner: runnerRegistry.defaultRunner,
    runners,
  });
}

async function sendEstimate(url, response) {
  const campaign = await resolveCampaign(url);
  if (!campaign) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  const markdown = await readFile(campaign.filePath, 'utf8');
  const plan = parseCampaignPlan(markdown);
  let runnerRegistry;
  try {
    const resolved = await resolveCampaignConfig({ campaignPath: campaign.filePath, cwd: __dirname });
    runnerRegistry = createRunnerRegistry(resolved.config);
  } catch (error) {
    if (!/No Git project root found/.test(error.message)) throw error;
    runnerRegistry = await loadRunnerRegistry();
  }
  const steps = plan.steps.map((step) => ({
    id: step.id,
    checked: step.checked,
    runner: resolveStepRunnerSelection(runnerRegistry, step).runner,
  }));
  const [allLedgers, locatedLedger] = await Promise.all([
    readUnifiedRunLedgers(lessonsRunsDir),
    getEngineRunLedger(campaign.filePath, campaign.id),
  ]);
  const liveLedger = locatedLedger && !['completed', 'merged', 'force_merged'].includes(locatedLedger.run.status)
    ? locatedLedger
    : null;
  const historicalLedgers = liveLedger
    ? allLedgers.filter((ledger) => ledger.run.id !== liveLedger.run.id)
    : allLedgers;
  sendJson(response, 200, estimateCampaign({
    steps,
    ledgers: historicalLedgers,
    liveLedger,
    seed: `${campaign.id}:${hashMarkdown(markdown)}`,
  }));
}

async function writeRuntimePort(actualPort) {
  await mkdir(path.dirname(portFilePath), { recursive: true });
  await writeFile(portFilePath, `${actualPort}\n`, 'utf8');
}

/* ------------------------------ Registry ------------------------------------ */

// Thin wrappers binding the registry store (lib/registry.mjs) to this process's
// configured paths, so the many call sites can stay `readRegistry()` /
// `writeRegistry(registry)`.
async function readRegistry() {
  return readRegistryFrom(registryPath);
}

async function writeRegistry(registry) {
  return writeRegistryTo(registryDir, registryPath, registry);
}

async function ensureRegistered(absolutePath) {
  const registry = await readRegistry();
  const existing = registry.campaigns.find((entry) => entry.filePath === absolutePath);
  const now = new Date().toISOString();

  if (existing) {
    existing.lastOpenedAt = now;
    if (!existing.logoPath) {
      const inferredLogo = await inferCampaignLogo(absolutePath);
      if (inferredLogo) existing.logoPath = inferredLogo;
    }
    await writeRegistry(registry);
    return existing.id;
  }

  const inferredLogo = await inferCampaignLogo(absolutePath);
  const entry = {
    id: randomUUID(),
    filePath: absolutePath,
    createdAt: now,
    lastOpenedAt: now,
    lastActivityAt: now,
  };
  if (inferredLogo) entry.logoPath = inferredLogo;
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

async function setCollectionParked(collectionId, parked) {
  const registry = await readRegistry();
  normalizeRegistryCollections(registry);
  const entries = registry.campaigns.filter((entry) => entry.collectionId === collectionId);
  if (entries.length === 0) return { found: false, parkedAt: null, count: 0 };

  const parkedAt = parked ? new Date().toISOString() : null;
  for (const entry of entries) {
    if (parkedAt) {
      entry.parkedAt = parkedAt;
    } else {
      delete entry.parkedAt;
    }
  }

  await writeRegistry(registry);
  return { found: true, parkedAt, count: entries.length };
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
  if (target.name) {
    registry.collections = registry.collections && typeof registry.collections === 'object' ? registry.collections : {};
    registry.collections[collectionId] = { ...registry.collections[collectionId], name: target.name };
  }
  const normalized = normalizeRegistryCollections(registry);
  await writeRegistry(registry);

  const count = registry.campaigns.filter((entry) => entry.collectionId === collectionId).length;
  return { found: true, changed: changed || normalized, collectionId, count };
}

// Set or clear a stack's human-editable headline. An empty name clears the
// stored one, falling the UI back to its derived title.
async function renameCollection(collectionId, name) {
  const registry = await readRegistry();
  normalizeRegistryCollections(registry);
  const exists = registry.campaigns.some((entry) => entry.collectionId === collectionId);
  if (!exists) return { found: false };

  if (name) {
    registry.collections = registry.collections && typeof registry.collections === 'object' ? registry.collections : {};
    registry.collections[collectionId] = { ...registry.collections[collectionId], name };
  } else if (registry.collections?.[collectionId]) {
    delete registry.collections[collectionId];
  }
  normalizeRegistryCollections(registry);
  await writeRegistry(registry);
  return { found: true, name: registry.collections?.[collectionId]?.name ?? '' };
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

async function fullDeleteCampaign(id) {
  const registry = await readRegistry();
  const index = registry.campaigns.findIndex((c) => c.id === id);
  const deletionMode = campaignFileDeletionMode();
  if (index === -1) return { found: false, removed: false, trashed: false, deletionMode };

  const entry = registry.campaigns[index];
  let trashed = false;
  let deletionError = null;
  try {
    const deletion = await deleteCampaignFile(entry.filePath);
    trashed = deletion.trashed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      trashed = false; // file was already gone — proceed to unregister anyway
    } else {
      deletionError = err.message;
    }
  }

  if (deletionError) {
    return { found: true, removed: false, trashed: false, deletionMode, error: deletionError };
  }

  registry.campaigns.splice(index, 1);
  if (defaultCampaignId === id) defaultCampaignId = null;
  normalizeRegistryCollections(registry);
  await writeRegistry(registry);
  return { found: true, removed: true, trashed, deletionMode };
}

export function campaignFileDeletionMode(platform = process.platform) {
  return platform === 'darwin' ? 'trash' : 'permanent';
}

export async function deleteCampaignFile(filePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (campaignFileDeletionMode(platform) === 'permanent') {
    await unlink(filePath);
    return { deletionMode: 'permanent', trashed: false };
  }

  const trashDir = path.join(options.home ?? homedir(), '.Trash');
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
  return { deletionMode: 'trash', trashed: true, destination: dest };
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

async function inferCampaignLogo(campaignPath) {
  const startDir = path.dirname(campaignPath);
  const repoRoot = await findRepoRoot(startDir);
  const dirs = ancestorDirs(startDir, repoRoot);
  const repoName = repoRoot ? path.basename(repoRoot) : '';
  const candidates = [];

  for (const dir of dirs) {
    const names = [...new Set([path.basename(dir), repoName].filter(Boolean))];
    for (const ext of LOGO_EXTENSIONS) {
      candidates.push(path.join(dir, 'assets', `app-icon${ext}`));
      candidates.push(path.join(dir, 'assets', `logo${ext}`));
      candidates.push(path.join(dir, 'public', `favicon${ext}`));
      candidates.push(path.join(dir, 'public', `logo-brand${ext}`));
      candidates.push(path.join(dir, 'dist', `favicon${ext}`));
      candidates.push(path.join(dir, 'dist', `logo-brand${ext}`));
      for (const name of names) {
        candidates.push(path.join(dir, 'assets', `${name}-icon${ext}`));
        candidates.push(path.join(dir, 'assets', 'icons', name, `icon_512${ext}`));
      }
    }
  }

  return firstExistingLogo(candidates);
}

function ancestorDirs(startDir, stopDir) {
  const dirs = [];
  let dir = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : null;
  for (;;) {
    dirs.push(dir);
    if (stop && dir === stop) return dirs;
    const parent = path.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

async function firstExistingLogo(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!LOGO_MIME.has(path.extname(candidate).toLowerCase())) continue;
    try {
      const details = await stat(candidate);
      if (details.isFile()) return candidate;
    } catch {
      /* try the next common logo path */
    }
  }
  return null;
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

  // The enriched pass above cleared missingSince on campaigns whose file is
  // present, so a still-set missingSince marks a currently-missing campaign.
  registryChanged = pruneMissingCampaigns(registry, now, MISSING_PRUNE_AFTER_MS) || registryChanged;
  const keepIds = new Set(registry.campaigns.map((entry) => entry.id));
  const visible = enriched.filter((entry) => keepIds.has(entry.id));

  registryChanged = normalizeRegistryCollections(registry) || registryChanged;

  if (registryChanged) {
    await writeRegistry(registry);
  }

  sendJson(response, 200, {
    campaigns: visible,
    collections: registry.collections ?? {},
    defaultCampaignId,
    homeDir: homedir(),
  });
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

async function newCampaignEndpoint(request, response) {
  const payload = await readJsonBody(request);
  const created = await createCampaignScaffold({
    name: payload?.name,
    projectPath: payload?.projectPath,
  });
  const id = await ensureRegistered(created.filePath);
  sendJson(response, 201, { ...created, id });
}

async function planCampaignEndpoint(request, response) {
  const payload = await readJsonBody(request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfClosed = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', abortIfClosed);
  let created = null;
  try {
    const draft = await draftCampaign({
      effort: payload?.effort,
      intent: payload?.intent,
      model: payload?.model,
      projectPath: payload?.projectPath,
      runnerId: payload?.runnerId,
      signal: controller.signal,
    });
    created = await createCampaignFromMarkdown({
      markdown: draft.markdown,
      name: draft.title,
      projectPath: draft.projectRoot,
    });
    const id = await ensureRegistered(created.filePath);
    sendJson(response, 201, {
      ...created,
      boardUrl: `?id=${encodeURIComponent(id)}`,
      findings: draft.findings,
      id,
      selection: draft.selection,
    });
  } catch (error) {
    if (created?.filePath) await unlink(created.filePath).catch(() => {});
    if (response.destroyed) return;
    if (error instanceof PlannerDraftError) {
      sendJson(response, error.statusCode, {
        error: error.message,
        findings: error.findings,
        rawOutput: error.rawOutput,
      });
      return;
    }
    throw error;
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', abortIfClosed);
  }
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

/* ------------------------------ API: workflows ------------------------------ */

// Workflow maps are discovered ON DEMAND and never written into the campaign
// registry — campaign enrichment (progress, stacks, parking) must never be able
// to touch a workflow record. We derive the repo roots to scan from the repos
// that already host a registered campaign, walk each repo's docs/workflows/**
// to ANY depth, and read the embedded JSON machine record (drawn maps carry
// nodes[]+score; undrawn stubs carry neither and render grey).
async function sendWorkflows(response) {
  const workflows = await discoverWorkflows();
  sendJson(response, 200, { workflows });
}

async function discoverWorkflows() {
  const registry = await readRegistry();

  // Derive distinct repo roots from registered campaign file paths. Several
  // campaigns can live in one repo, so dedupe by the resolved repo root.
  const repoRoots = new Map(); // canonical key -> { root, name }
  for (const entry of registry.campaigns) {
    if (typeof entry.filePath !== 'string') continue;
    const repoRoot = await findRepoRoot(path.dirname(entry.filePath));
    if (repoRoot) {
      const canonicalRoot = await canonicalPath(repoRoot);
      const key = canonicalRoot.normalize('NFC');
      if (!repoRoots.has(key)) {
        repoRoots.set(key, {
          root: canonicalRoot,
          name: path.basename(canonicalRoot).normalize('NFC'),
        });
      }
    }
  }

  const workflows = [];
  for (const { root: repoRoot, name: repoName } of repoRoots.values()) {
    for (const map of await findWorkflowMaps(repoRoot)) {
      let markdown;
      try {
        markdown = await readFile(map.filePath, 'utf8');
      } catch (error) {
        console.warn(`workflows: skipping ${map.filePath} — could not read (${error.message})`);
        continue;
      }
      const record = parseWorkflowRecord(markdown);
      if (!record) {
        // One malformed/absent record must never crash discovery — skip it loudly.
        console.warn(`workflows: skipping ${map.filePath} — no parseable JSON machine record`);
        continue;
      }
      // Render what's earned: a DRAWN map carries nodes[] → its declared score tints
      // the tree; an UNDRAWN stub carries none → score:null → the tree renders it grey.
      // A colour is NEVER inferred here — undrawn means undrawn.
      workflows.push({
        repoRoot,
        repoName,
        categories: map.categories, // ['data','sync'] — the folder hierarchy, any depth
        slug: map.slug,
        ref: map.ref, // 'data/sync/full-sync.md' — full relative path, the copy-ref base
        title: extractWorkflowTitle(markdown) ?? map.slug,
        filePath: map.filePath,
        status: record.drawn ? 'drawn' : 'undrawn',
        score: record.drawn ? deriveWorkflowScore(record.data) : null,
        markdown, // carried inline so the Step 3.1 leaf renders without a second fetch
      });
    }
  }

  // Stable order — repo, then full category path, then slug — so discovery returns
  // the same list every load (the client re-sorts by fragility for display).
  workflows.sort((a, b) =>
    a.repoName.localeCompare(b.repoName) ||
    a.categories.join('/').localeCompare(b.categories.join('/')) ||
    a.slug.localeCompare(b.slug));
  return workflows;
}

async function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

// Walk up from a starting directory to the nearest ancestor containing `.git`
// (a directory for a normal clone, a file for a worktree — stat() accepts both).
async function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      await stat(path.join(dir, '.git'));
      return dir;
    } catch {
      /* not a repo root — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// Walk docs/workflows/** to ANY depth, one record per .md map. `categories` is the
// full chain of folders between docs/workflows/ and the file (['data','sync']), so a
// map nested three deep is no longer silently dropped. `ref` is the full relative
// path — the copy-ref base the viewer hangs node anchors off (NOT <domain>/<slug>).
async function findWorkflowMaps(repoRoot) {
  const base = path.join(repoRoot, 'docs', 'workflows');
  const maps = [];
  async function walk(dir, categories) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // ENOENT at the root just means this repo has no maps — normal, not an error.
      if (error.code !== 'ENOENT') {
        console.warn(`workflows: cannot read ${dir} — ${error.message}`);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), [...categories, entry.name]); // descend, any depth
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        maps.push({
          categories, // ['data','sync'] — the hierarchy, however deep
          slug: entry.name.slice(0, -'.md'.length),
          filePath: path.join(dir, entry.name),
          ref: [...categories, entry.name].join('/'), // 'data/sync/full-sync.md'
        });
      }
    }
  }
  await walk(base, []);
  return maps;
}

// Pull the embedded ```json machine record out of a map. A map can in principle
// hold more than one ```json fence, so take the first that parses to a record-shaped
// object. Two shapes qualify, both "the same file at two maturity levels":
//   • DRAWN  — has nodes[]; its declared score{} tints the tree. { drawn: true }
//   • UNDRAWN stub — no nodes[], but an authored record (name/what/status). It earns
//     no colour, so the tree renders it grey. { drawn: false }
// Returns { data, drawn } or null if no fence qualifies — caller skips the map loudly.
function parseWorkflowRecord(markdown) {
  const fence = /```json\s+([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(markdown)) !== null) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue; // not JSON — try the next fence
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    if (Array.isArray(data.nodes)) return { data, drawn: true };
    // A stub is identified by the authored fields the template mandates — never by a
    // colour, which it must not carry. (`name`/`what`/`status` — any one is enough.)
    if (typeof data.status === 'string' || typeof data.name === 'string' || typeof data.what === 'string') {
      return { data, drawn: false };
    }
  }
  return null;
}

// The viewer renders what each map EARNED — never a computed colour. So prefer
// the sidecar's own score; only if it's missing/unusable do we tally the node
// colours (still the map's declared colours, not an inference).
function deriveWorkflowScore(sidecar) {
  const tally = { green: 0, amber: 0, red: 0, accepted: 0, neutral: 0 };
  const declared = sidecar.score;
  if (declared && typeof declared === 'object') {
    let any = false;
    for (const colour of Object.keys(tally)) {
      const value = Number(declared[colour]);
      if (Number.isFinite(value) && value >= 0) {
        tally[colour] = value;
        any = true;
      }
    }
    if (any) return tally;
  }
  for (const node of sidecar.nodes) {
    if (node && tally[node.color] !== undefined) tally[node.color] += 1;
  }
  return tally;
}

function extractWorkflowTitle(markdown) {
  const heading = extractTitle(markdown);
  if (!heading) return null;
  // Map H1s are "Workflow Map — <Human Title>"; strip the prefix for a clean label.
  return heading.replace(/^Workflow Map\s*[—–-]\s*/i, '').trim() || heading;
}

/* ------------------------------ API: lessons -------------------------------- */

async function sendLessons(response) {
  try {
    const nativeLessons = await loadUnifiedLessons(lessonsRunsDir);
    if (nativeLessons.scanned.total > 0) {
      sendJson(response, 200, nativeLessons);
      return;
    }

    await stat(lessonsHelperPath);
    const analysis = await readLessonsAnalysis();
    sendJson(response, 200, summarizeLessons(analysis));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    sendJson(response, missing ? 200 : 502, {
      available: false,
      generatedAt: new Date().toISOString(),
      error: missing ? 'No unified campaign runs are available yet.' : 'Campaign lessons could not be loaded.',
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
    source: 'legacy',
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
      app: {
        version: APP_VERSION,
        platform: process.platform,
      },
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
    let currentMarkdown = null;
    try {
      currentMarkdown = await readFile(campaign.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // File vanished from disk; the browser copy is the only surviving
      // version, so skip the conflict check and let the write recreate it.
    }

    const currentHash = currentMarkdown === null ? null : hashMarkdown(currentMarkdown);

    if (currentHash !== null && currentHash !== payload.baseHash) {
      sendJson(response, 409, {
        error:
          'The markdown file changed on disk after this page loaded. Reload before saving so no work is overwritten.',
        currentHash,
      });
      return;
    }
  }

  await writeFileAtomic(campaign.filePath, payload.markdown);
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
  const id = typeof payload.id === 'string' ? payload.id : '';
  const collectionId = typeof payload.collectionId === 'string' ? payload.collectionId.trim() : '';
  if (typeof payload.parked !== 'boolean' || (id === '' && collectionId === '') || (id !== '' && collectionId !== '')) {
    sendJson(response, 400, {
      error: 'Expected { id: string, parked: boolean } or { collectionId: string, parked: boolean }.',
    });
    return;
  }

  const result = collectionId
    ? await setCollectionParked(collectionId, payload.parked)
    : await setCampaignParked(id, payload.parked);
  if (!result.found) {
    sendJson(response, 404, { error: collectionId ? 'Stack not found.' : 'Campaign not found.' });
    return;
  }
  sendJson(response, 200, { ok: true, parkedAt: result.parkedAt, count: result.count ?? 1 });
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

    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const result = await stackCampaign(payload.sourceId, { targetId, targetCollectionId, name });
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

  if (payload.action === 'rename') {
    const collectionId = typeof payload.collectionId === 'string' ? payload.collectionId.trim() : '';
    if (collectionId === '' || typeof payload.name !== 'string') {
      sendJson(response, 400, { error: 'Expected { action: "rename", collectionId: string, name: string }.' });
      return;
    }
    const result = await renameCollection(collectionId, payload.name.trim());
    if (!result.found) {
      sendJson(response, 404, { error: 'Stack not found.' });
      return;
    }
    sendJson(response, 200, { ok: true, name: result.name });
    return;
  }

  sendJson(response, 400, { error: 'Expected action to be "stack", "rename" or "remove".' });
}

async function deleteMissingRegistryEndpoint(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  // Two modes:
  //   - { id }                       → legacy: unregister only if file already missing
  //   - { id, deleteFile: true }     → Trash on macOS; permanent delete elsewhere
  if (payload.deleteFile === true) {
    const deletionMode = campaignFileDeletionMode();
    if (deletionMode === 'permanent' && payload.confirmPermanentDelete !== true) {
      sendJson(response, 400, {
        error: 'Permanent deletion requires confirmPermanentDelete: true.',
      });
      return;
    }
    const result = await fullDeleteCampaign(payload.id);
    if (!result.found) {
      sendJson(response, 404, { error: 'Campaign not found.' });
      return;
    }
    if (result.error) {
      sendJson(response, 500, { error: `Could not delete campaign file: ${result.error}` });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      deletionMode: result.deletionMode,
      trashed: result.trashed,
    });
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

async function sendNotificationSettings(response) {
  const { settings, configured } = await readNotificationSettingsWithMeta();
  sendJson(response, 200, { ...settings, configured });
}

async function saveNotificationSettingsEndpoint(request, response) {
  const payload = await readJsonBody(request);
  const settings = sanitizeNotificationSettings(payload);
  await writeNotificationSettings(settings);
  sendJson(response, 200, { ok: true, ...settings, configured: true });
}

async function readNotificationSettingsWithMeta() {
  try {
    const raw = await readFile(notificationSettingsPath, 'utf8');
    return { settings: sanitizeNotificationSettings(JSON.parse(raw)), configured: true };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { settings: defaultNotificationSettings(), configured: false };
    }
    console.error(`Bad notification settings file: ${error.message}`);
    return { settings: defaultNotificationSettings(), configured: false };
  }
}

async function readNotificationSettings() {
  const { settings } = await readNotificationSettingsWithMeta();
  return settings;
}

async function writeNotificationSettings(settings) {
  await mkdir(path.dirname(notificationSettingsPath), { recursive: true });
  await writeFile(notificationSettingsPath, `${JSON.stringify(sanitizeNotificationSettings(settings), null, 2)}\n`, 'utf8');
}

async function sendNotification(request, response) {
  const payload = await readJsonBody(request);
  const title = notificationText(payload.title, 'Campaigns', NOTIFICATION_TITLE_MAX);
  const message = notificationText(payload.message, '', NOTIFICATION_MESSAGE_MAX);

  if (!message) {
    sendJson(response, 400, { error: 'Message is required.' });
    return;
  }

  try {
    await displayNativeNotification(title, message, payload.sound);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    if (error.statusCode) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    console.error('Failed to display native notification:', error);
    sendJson(response, 500, { error: 'Failed to trigger notification.' });
  }
}

async function sendRemoteNotification(request, response) {
  const payload = await readJsonBody(request);
  const title = notificationText(payload.title, 'Campaigns', NOTIFICATION_TITLE_MAX);
  const message = notificationText(payload.message, '', NOTIFICATION_MESSAGE_MAX);

  if (!message) {
    sendJson(response, 400, { error: 'Message is required.' });
    return;
  }

  const result = await deliverRemoteNotification({
    title,
    message,
    ntfyTopic: payload.ntfyTopic,
    webhookUrl: payload.webhookUrl,
    strict: true,
  });

  if (result.error) {
    sendJson(response, result.statusCode ?? 400, { error: result.error });
    return;
  }

  if (result.failures.length > 0) {
    sendJson(response, 502, {
      error: result.failures?.[0]?.error || 'Notification delivery failed.',
      ok: false,
      failures: result.failures,
    });
    return;
  }

  sendJson(response, 200, { ok: true });
}

async function sendConfiguredServerNotification(title, message, { kind = 'stopped' } = {}) {
  const cleanTitle = notificationText(title, 'Campaigns', NOTIFICATION_TITLE_MAX);
  const cleanMessage = notificationText(message, '', NOTIFICATION_MESSAGE_MAX);
  if (!cleanMessage) return false;

  const settings = await readNotificationSettings();
  const deliveries = [];
  const sound = kind === 'finished' ? 'Glass' : 'Basso';

  if (settings.macNotificationsEnabled) {
    deliveries.push(displayNativeNotification(cleanTitle, cleanMessage, sound));
  }

  if (settings.ntfyTopic || settings.webhookUrl) {
    deliveries.push(
      deliverRemoteNotification({
        title: cleanTitle,
        message: cleanMessage,
        ntfyTopic: settings.ntfyTopic,
        webhookUrl: settings.webhookUrl,
        strict: false,
      }).then((result) => {
        if (result.failures?.length) {
          throw new Error(result.failures.map((failure) => `${failure.channel}: ${failure.error}`).join('; '));
        }
      }),
    );
  }

  if (deliveries.length === 0) return false;

  const settled = await Promise.allSettled(deliveries);
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error('Stop watcher notification delivery failed:', result.reason?.message ?? result.reason);
    }
  }
  return settled.some((result) => result.status === 'fulfilled');
}

/* ------------------------------ Stop watcher -------------------------------- */

let stopWatcherTimer = null;
let stopWatcherRunning = false;
let stopWatcherState = null;

function startStopWatcher() {
  if (stopWatcherTimer) return;
  runStopWatcherPass().catch((error) => {
    console.error('Stop watcher failed:', error.message);
  });
  stopWatcherTimer = setInterval(() => {
    runStopWatcherPass().catch((error) => {
      console.error('Stop watcher failed:', error.message);
    });
  }, STOP_WATCH_INTERVAL_MS);
}

function stopStopWatcher() {
  if (stopWatcherTimer) clearInterval(stopWatcherTimer);
  stopWatcherTimer = null;
}

async function runStopWatcherPass() {
  if (stopWatcherRunning) return;
  stopWatcherRunning = true;

  try {
    const registry = await readRegistry();
    const state = await getStopWatcherState();
    const now = Date.now();
    const nextCampaigns = {};

    for (const entry of registry.campaigns) {
      const previous = state.campaigns?.[entry.id] ?? null;
      const snapshot = await buildStopWatcherSnapshot(entry);
      const alerts = classifyStopWatcherAlerts(previous, snapshot, now, STOP_WATCH_NO_MOVEMENT_MS);

      for (const alert of alerts) {
        if (alert.type === 'stop' && previous?.notifiedEventKey === alert.eventKey) continue;
        await sendConfiguredServerNotification(alert.title, alert.message, { kind: alert.kind });
      }

      nextCampaigns[entry.id] = nextStopWatcherRecord(previous, snapshot, now, alerts);
    }

    stopWatcherState = { version: 1, updatedAt: new Date(now).toISOString(), campaigns: nextCampaigns };
    await writeStopWatcherState(stopWatcherState);
  } finally {
    stopWatcherRunning = false;
  }
}

async function getStopWatcherState() {
  if (stopWatcherState) return stopWatcherState;
  stopWatcherState = await readStopWatcherState();
  return stopWatcherState;
}

async function readStopWatcherState() {
  try {
    const raw = await readFile(stopWatcherStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.campaigns || typeof parsed.campaigns !== 'object') {
      return { version: 1, campaigns: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, campaigns: {} };
    console.error(`Bad stop watcher state file: ${error.message}`);
    return { version: 1, campaigns: {} };
  }
}

async function writeStopWatcherState(state) {
  await mkdir(path.dirname(stopWatcherStatePath), { recursive: true });
  await writeFile(stopWatcherStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function buildStopWatcherSnapshot(entry) {
  let title = path.basename(entry.filePath, path.extname(entry.filePath));
  let missing = false;
  let fileMtimeMs = null;
  let progress = { done: 0, total: 0 };
  let phases = [];

  try {
    const [markdown, details] = await Promise.all([
      readFile(entry.filePath, 'utf8'),
      stat(entry.filePath),
    ]);
    title = extractTitle(markdown) ?? title;
    progress = countProgress(markdown);
    phases = extractProgressPhases(markdown);
    fileMtimeMs = details.mtimeMs;
  } catch {
    missing = true;
  }

  let automation = null;
  let automationError = null;
  try {
    automation = await getAutomateState(entry.filePath, { registryId: entry.id });
  } catch (error) {
    automationError = error.message;
  }

  const status = normalizeStopWatcherStatus(automation);
  const currentStep = automation?.current_step ?? null;
  const fingerprint = stopWatcherFingerprint({
    status,
    automation,
    progress,
    fileMtimeMs,
    missing,
    automationError,
  });

  return {
    id: entry.id,
    title,
    parked: Boolean(entry.parkedAt),
    missing,
    status,
    backend: automation?.backend ?? null,
    hasAutomationState: Boolean(automation),
    hasActiveRun: automation?.has_active_run === true,
    isActive: automation?.is_active === true,
    currentStepId: currentStep?.id ?? automation?.current_step_id ?? null,
    currentStepName: currentStep?.name ?? automation?.current_step_name ?? null,
    progress,
    phases,
    completedPhaseKeys: phases.filter((phase) => phase.total > 0 && phase.done === phase.total).map((phase) => phase.key),
    fingerprint,
    maxStepMinutes: Number.isFinite(Number(automation?.max_step_minutes))
      ? Number(automation.max_step_minutes)
      : null,
    automationError,
  };
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

function extractProgressPhases(markdown) {
  const phases = [];
  const lines = markdown.split('\n');
  const hasProgressChecklist = lines.some((line) => isProgressChecklistHeadingLine(line));
  let inProgressChecklist = !hasProgressChecklist;
  let inCodeFence = false;
  let currentPhase = null;

  const finishPhase = () => {
    if (currentPhase) phases.push(currentPhase);
    currentPhase = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (isH2HeadingLine(line)) {
      finishPhase();
      inProgressChecklist = !hasProgressChecklist || isProgressChecklistHeadingLine(line);
      continue;
    }

    if (!inProgressChecklist) continue;

    const h3Match = line.match(/^\s*###\s+(.+?)\s*#*\s*$/);
    if (h3Match) {
      finishPhase();
      const title = h3Match[1].trim();
      currentPhase = {
        key: phaseKey(title),
        title,
        done: 0,
        total: 0,
      };
      continue;
    }

    if (!currentPhase) continue;

    const checkMatch = line.match(/^\s*[-*]\s+\[([ xX])\]/);
    if (checkMatch) {
      currentPhase.total += 1;
      if (checkMatch[1].toLowerCase() === 'x') currentPhase.done += 1;
      continue;
    }

    if (!/^\s*\|.+\|\s*$/.test(line)) continue;
    for (const cell of line.split('|').slice(1, -1)) {
      const content = cell.trim();
      if (content === '☐') currentPhase.total += 1;
      else if (content === '☑') {
        currentPhase.total += 1;
        currentPhase.done += 1;
      }
    }
  }

  finishPhase();
  return phases;
}

function phaseKey(title) {
  const phaseNumber = title.match(/\bphase\s+(\d+(?:\.\d+)*)\b/i)?.[1];
  const stableTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return phaseNumber ? `phase-${phaseNumber}` : hashString(stableTitle);
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
    const state = await getAutomateState(entry.filePath, { registryId: entry.id });
    sendJson(response, 200, state);
    return;
  }

  const registry = await readRegistry();
  const states = {};
  await Promise.all(
    registry.campaigns.map(async (entry) => {
      // One unreadable automation state must not take down the whole
      // bulk endpoint — every library dot would vanish with it.
      try {
        states[entry.id] = await getAutomateState(entry.filePath, {
          summary: true,
          registryId: entry.id,
        });
      } catch {
        states[entry.id] = null;
      }
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

  const campaigns = (
    await Promise.all(
      registry.campaigns.map((entry) => buildCompanionCampaign(entry, now).catch(() => null)),
    )
  ).filter(Boolean);

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
  let markdown = '';
  try {
    markdown = await readFile(entry.filePath, 'utf8');
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
    summary = await getAutomateState(entry.filePath, {
      summary: true,
      registryId: entry.id,
    });
  } catch (error) {
    // A single bad provider state must not take down the whole companion feed.
    console.error(`companion-state: automation summary failed for ${entry.id}:`, error.message);
  }

  const backend = summary?.backend ?? null;
  const status = deriveCompanionStatus({ summary, parked, lastActivityAt, now });
  const currentStepBase =
    summary?.current_step_id || summary?.current_step_name
      ? { id: summary.current_step_id ?? null, name: summary.current_step_name ?? null }
      : null;
  const currentStepLine = currentStepBase ? findStepHeadingLine(markdown, currentStepBase) : null;
  const currentStep = currentStepBase
    ? {
        ...currentStepBase,
        line: currentStepLine,
        path: currentStepLine ? `${entry.filePath}:${currentStepLine}` : entry.filePath,
      }
    : null;

  return {
    id: entry.id,
    title,
    filePath: entry.filePath,
    referencePath: currentStep?.path ?? entry.filePath,
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

function findStepHeadingLine(markdown, step) {
  if (!markdown || (!step?.id && !step?.name)) return null;

  const needles = [step.id, step.name].filter(Boolean).map(normalizeStepNeedle);
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{2,}\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const heading = normalizeStepNeedle(match[1]);
    if (needles.some((needle) => needle && heading.includes(needle))) {
      return index + 1;
    }
  }
  return null;
}

function normalizeStepNeedle(value) {
  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const result = await nudgeAutomateState(entry.filePath, payload.mode, { registryId: entry.id });
  sendJson(response, result.ok ? 200 : 502, result);
}

async function handleRunStart(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((campaign) => campaign.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }
  if (activeCampaignRuns.has(entry.id)) {
    sendJson(response, 409, { error: 'This campaign already has an active run.' });
    return;
  }
  const existing = await getAutomateState(entry.filePath, {
    summary: true,
    registryId: entry.id,
  });
  if (existing?.is_active) {
    sendJson(response, 409, { error: 'This campaign already has an active run.' });
    return;
  }

  const active = { controller: null, promise: null };
  activeCampaignRuns.set(entry.id, active);
  try {
    const launch = await prepareCampaignLaunch(entry.filePath);
    const controller = new AbortController();
    active.controller = controller;
    active.promise = Promise.resolve()
      .then(() => runCampaign(entry.filePath, {
        registryId: entry.id,
        signal: controller.signal,
      }))
      .catch((error) => {
        console.error(`Campaign run failed for ${entry.id}:`, error.message);
      })
      .finally(() => {
        if (activeCampaignRuns.get(entry.id) === active) activeCampaignRuns.delete(entry.id);
      });

    sendJson(response, 202, {
      ok: true,
      status: 'starting',
      committed: launch.committed,
      commitSha: launch.commitSha,
    });
  } catch (error) {
    activeCampaignRuns.delete(entry.id);
    const status = error.statusCode ?? 500;
    sendJson(response, status, { error: error.message });
  }
}

export async function prepareCampaignLaunch(campaignFile) {
  const resolved = await resolveCampaignConfig({ campaignPath: campaignFile, cwd: __dirname });
  const repoRoot = await realpath(path.resolve(resolved.effective.repoRoot || resolved.projectRoot));
  const campaignPath = await realpath(path.resolve(campaignFile));
  const relativeCampaign = path.relative(repoRoot, campaignPath);
  if (!relativeCampaign || relativeCampaign.startsWith('..') || path.isAbsolute(relativeCampaign)) {
    throw launchError('The campaign markdown must live inside its configured Git repository.');
  }

  const status = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.exitCode !== 0) {
    throw launchError(`Git could not inspect the worktree: ${status.stderr.trim() || 'git status failed'}.`);
  }
  const dirtyPaths = parsePorcelainPaths(status.stdout);
  const unrelated = dirtyPaths.filter((candidate) => candidate !== relativeCampaign);
  if (unrelated.length > 0) {
    throw launchError(
      `Launch blocked by unrelated worktree changes: ${unrelated.join(', ')}. Commit or clear them first; Campaigns will not stash or include them.`,
    );
  }
  if (dirtyPaths.length === 0) return { committed: false, commitSha: null, repoRoot };

  const added = await runGit(repoRoot, ['add', '--', relativeCampaign]);
  if (added.exitCode !== 0) {
    throw launchError(`Could not stage ${relativeCampaign}: ${added.stderr.trim() || 'git add failed'}.`);
  }
  const committed = await runGit(repoRoot, [
    '-c', 'commit.gpgSign=false',
    'commit', '-m', 'Save campaign plan', '--', relativeCampaign,
  ]);
  if (committed.exitCode !== 0) {
    throw launchError(`Could not commit ${relativeCampaign}: ${committed.stderr.trim() || 'git commit failed'}.`);
  }
  const head = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (head.exitCode !== 0) throw launchError('Campaign plan committed, but Git could not read the commit id.');
  return { committed: true, commitSha: head.stdout.trim(), repoRoot };
}

function parsePorcelainPaths(output) {
  const entries = String(output).split('\0');
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(status)) {
      const renamedPath = entries[index + 1];
      if (renamedPath) paths.push(renamedPath);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function launchError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function runGit(repoRoot, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }, (error, stdout = '', stderr = '') => {
      resolve({ exitCode: error?.code ?? 0, stdout, stderr });
    });
  });
}

function abortActiveCampaignRuns() {
  for (const active of activeCampaignRuns.values()) active.controller?.abort();
}

async function stopActiveCampaignRuns() {
  const entries = [...activeCampaignRuns.entries()];
  await Promise.all(entries.map(async ([id, active]) => {
    const registry = await readRegistry();
    const entry = registry.campaigns.find((campaign) => campaign.id === id);
    if (!entry) {
      active.controller?.abort();
      return;
    }
    try {
      await requestCampaignStop(entry.filePath);
    } catch {
      active.controller?.abort();
    }
  }));
  await Promise.allSettled(entries.map(([, active]) => active.promise).filter(Boolean));
}

async function handleRunRecover(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((campaign) => campaign.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  try {
    const result = await recoverCampaign(entry.filePath);
    sendJson(response, 200, {
      ok: true,
      message: result.message,
      status: result.status,
      actions: result.actions,
    });
  } catch (error) {
    if (error instanceof RecoveryError) {
      sendJson(response, 409, { ok: false, error: error.message });
      return;
    }
    throw error;
  }
}

async function handleRunStop(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
    return;
  }

  const registry = await readRegistry();
  const entry = registry.campaigns.find((campaign) => campaign.id === payload.id);
  if (!entry) {
    sendJson(response, 404, { error: 'Campaign not found.' });
    return;
  }

  try {
    const result = await requestCampaignStop(entry.filePath);
    sendJson(response, 200, {
      ok: true,
      status: result.state.run.status,
      groupTerminated: result.groupTerminated,
    });
  } catch (error) {
    if (error instanceof CampaignStopError) {
      sendJson(response, 409, { ok: false, error: error.message });
      return;
    }
    throw error;
  }
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

function hashMarkdown(markdown) {
  return createHash('sha256').update(markdown).digest('hex');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runCli();
}

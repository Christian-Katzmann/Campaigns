import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getAutomateState, nudgeAutomateState } from './lib/automate-providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const APP_NAME = 'Campaigns';
const APP_SLUG = 'campaigns';
const registryDir = process.env.CAMPAIGNS_REGISTRY_DIR || defaultRegistryDir();
const registryPath = path.join(registryDir, 'registry.json');
const portFilePath = process.env.CAMPAIGNS_PORT_FILE || defaultPortFilePath();
const MISSING_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_TITLE_MAX = 80;
const NOTIFICATION_MESSAGE_MAX = 500;
const NTFY_TOPIC_REGEX = /^[A-Za-z0-9_-]{3,64}$/;

const args = process.argv.slice(2);
const options = parseArgs(args);
const fileArg = options.file ?? process.env.CAMPAIGN_FILE;
const port = Number(options.port ?? process.env.PORT ?? 4178);

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

    if (url.pathname === '/api/registry/icon' && request.method === 'GET') {
      await sendCampaignIcon(url, response);
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

    if (url.pathname === '/api/automate-nudge' && request.method === 'POST') {
      await handleAutomateNudge(request, response);
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

server.listen(port, () => {
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
    await writeRegistry(registry);
    return { found: true, removed: true };
  }
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
  let registryChanged = false;

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

async function deleteMissingRegistryEndpoint(request, response) {
  const payload = await readJsonBody(request);
  if (typeof payload.id !== 'string') {
    sendJson(response, 400, { error: 'Expected { id: string }.' });
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
  for (const line of markdown.split('\n')) {
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

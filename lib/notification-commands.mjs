import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from './registry.mjs';

export const NTFY_COMMAND_TTL_MS = 15 * 60 * 1000;
export const NTFY_COMMAND_ACTIONS = new Set(['stop', 'approve']);

export class NotificationCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NotificationCommandError';
    this.code = code;
  }
}

export function notificationCommandPaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    secretPath: path.join(root, 'notification-command-secret'),
    statePath: path.join(root, 'notification-command-state.json'),
    settingsPath: path.join(root, 'notification-settings.json'),
  };
}

export async function ensureNotificationCommandInfrastructure(dataDir, settings) {
  if (!settings?.ntfyTopic) return null;
  const paths = notificationCommandPaths(dataDir);
  await mkdir(path.resolve(dataDir), { recursive: true });

  let nextSettings = settings;
  if (!settings.ntfyCommandTopic || settings.ntfyCommandTopic === settings.ntfyTopic) {
    nextSettings = {
      ...settings,
      ntfyCommandTopic: `campaigns-cmd-${randomBytes(18).toString('hex')}`,
    };
    await writeFileAtomic(paths.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  }

  let secret;
  try {
    secret = (await readFile(paths.secretPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const candidate = randomBytes(32).toString('hex');
    try {
      await writeFile(paths.secretPath, `${candidate}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      secret = candidate;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      secret = (await readFile(paths.secretPath, 'utf8')).trim();
    }
  }

  if (!secret) throw new Error('Notification command secret is empty.');
  return { paths, secret, settings: nextSettings };
}

export function createNotificationCommand({
  action,
  runId,
  secret,
  now = Date.now(),
  ttlMs = NTFY_COMMAND_TTL_MS,
  nonce = randomUUID(),
}) {
  if (!NTFY_COMMAND_ACTIONS.has(action)) throw new TypeError(`Unsupported notification command: ${action}`);
  if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('runId is required.');
  if (typeof secret !== 'string' || !secret) throw new TypeError('secret is required.');
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > NTFY_COMMAND_TTL_MS) {
    throw new TypeError('Notification command expiry is invalid.');
  }

  const payload = {
    version: 1,
    action,
    runId: runId.trim(),
    issuedAt: Math.floor(now),
    expiresAt: Math.floor(now + ttlMs),
    nonce: String(nonce),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyNotificationCommand(token, { secret, now = Date.now(), usedNonces = {} } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new NotificationCommandError('malformed', 'Notification command is malformed.');
  }
  const [encoded, signature, ...extra] = token.split('.');
  if (!encoded || !signature || extra.length) {
    throw new NotificationCommandError('malformed', 'Notification command is malformed.');
  }

  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new NotificationCommandError('forged', 'Notification command signature is invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new NotificationCommandError('malformed', 'Notification command payload is invalid.');
  }
  if (
    payload?.version !== 1
    || !NTFY_COMMAND_ACTIONS.has(payload.action)
    || typeof payload.runId !== 'string'
    || !payload.runId
    || typeof payload.nonce !== 'string'
    || !payload.nonce
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > NTFY_COMMAND_TTL_MS
  ) {
    throw new NotificationCommandError('malformed', 'Notification command payload is invalid.');
  }
  if (payload.expiresAt <= now) {
    throw new NotificationCommandError('expired', 'Notification command has expired.');
  }
  if (Object.hasOwn(usedNonces, payload.nonce)) {
    throw new NotificationCommandError('replayed', 'Notification command was already used.');
  }
  return payload;
}

export async function consumeNotificationCommand(token, {
  dataDir,
  dispatch,
  messageId = null,
  now = Date.now(),
} = {}) {
  const paths = notificationCommandPaths(dataDir);
  const secret = (await readFile(paths.secretPath, 'utf8')).trim();
  const state = await readNotificationCommandState(paths.statePath, now);
  const payload = verifyNotificationCommand(token, { secret, now, usedNonces: state.usedNonces });

  state.usedNonces[payload.nonce] = payload.expiresAt;
  if (messageId) state.lastMessageId = messageId;
  await writeNotificationCommandState(paths.statePath, state);
  const result = await dispatch(payload);
  return { payload, result };
}

export async function advanceNotificationCommandCursor(dataDir, messageId, now = Date.now()) {
  if (!messageId) return;
  const paths = notificationCommandPaths(dataDir);
  const state = await readNotificationCommandState(paths.statePath, now);
  state.lastMessageId = messageId;
  await writeNotificationCommandState(paths.statePath, state);
}

export async function readNotificationCommandState(statePath, now = Date.now()) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    const used = parsed?.usedNonces && typeof parsed.usedNonces === 'object'
      ? Object.fromEntries(Object.entries(parsed.usedNonces).filter(([, expiry]) => (
        Number.isFinite(expiry) && expiry > now
      )))
      : {};
    return {
      version: 1,
      lastMessageId: typeof parsed?.lastMessageId === 'string' ? parsed.lastMessageId : null,
      usedNonces: used,
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return { version: 1, lastMessageId: null, usedNonces: {} };
    }
    throw error;
  }
}

async function writeNotificationCommandState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function sign(encoded, secret) {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

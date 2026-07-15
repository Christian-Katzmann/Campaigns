import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  NotificationCommandError,
  consumeNotificationCommand,
  createNotificationCommand,
  ensureNotificationCommandInfrastructure,
} from '../lib/notification-commands.mjs';
import {
  buildNotificationDigest,
  buildNtfyRunActions,
  defaultNotificationSettings,
  deliverRemoteNotification,
  enqueueNotificationDigest,
  isWithinQuietHours,
  notificationPolicyDecision,
  sanitizeNotificationDigestState,
  sanitizeNotificationSettings,
} from '../lib/notifications.mjs';

test('signed ntfy commands reject forgery, expiry, and replay while a valid command executes once', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'campaigns-notification-command-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const infrastructure = await ensureNotificationCommandInfrastructure(dataDir, {
    ...defaultNotificationSettings(),
    ntfyTopic: 'attention-fixture',
  });
  const now = 1_000_000;
  const token = createNotificationCommand({
    action: 'stop',
    runId: 'run-1',
    secret: infrastructure.secret,
    now,
    nonce: 'single-use',
  });
  let executions = 0;

  await consumeNotificationCommand(token, {
    dataDir,
    messageId: 'message-1',
    now: now + 1,
    dispatch: async (command) => {
      executions += 1;
      assert.equal(command.action, 'stop');
    },
  });
  await assert.rejects(
    consumeNotificationCommand(token, {
      dataDir,
      messageId: 'message-2',
      now: now + 2,
      dispatch: async () => { executions += 1; },
    }),
    (error) => error instanceof NotificationCommandError && error.code === 'replayed',
  );

  const forged = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(
    consumeNotificationCommand(forged, {
      dataDir,
      now: now + 2,
      dispatch: async () => { executions += 1; },
    }),
    (error) => error instanceof NotificationCommandError && error.code === 'forged',
  );

  const expired = createNotificationCommand({
    action: 'approve',
    runId: 'run-1',
    secret: infrastructure.secret,
    now,
    ttlMs: 100,
    nonce: 'expired',
  });
  await assert.rejects(
    consumeNotificationCommand(expired, {
      dataDir,
      now: now + 101,
      dispatch: async () => { executions += 1; },
    }),
    (error) => error instanceof NotificationCommandError && error.code === 'expired',
  );

  assert.equal(executions, 1);
  assert.match(infrastructure.settings.ntfyCommandTopic, /^campaigns-cmd-/);
  assert.notEqual(infrastructure.settings.ntfyCommandTopic, infrastructure.settings.ntfyTopic);
  await access(path.join(dataDir, 'notification-command-state.json'));
  assert.doesNotMatch(await readFile(path.join(dataDir, 'notification-command-state.json'), 'utf8'), /run-1/);
});

test('ntfy publishes HTTP actions as JSON and never emits Open for loopback', async () => {
  const actions = buildNtfyRunActions({
    commandTopic: 'command-topic',
    stopToken: 'stop-token',
    approveToken: 'approve-token',
    openUrl: 'http://127.0.0.1:4178',
  });
  const requests = [];
  const result = await deliverRemoteNotification({
    title: 'Needs review',
    message: 'Attention required.',
    ntfyTopic: 'attention-topic',
    ntfyActions: actions,
    strict: true,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(result.failures, []);
  assert.equal(requests[0].url, 'https://ntfy.sh');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.actions.map((action) => action.label), ['Stop', 'Approve']);
  assert.equal(body.actions[0].url, 'https://ntfy.sh/command-topic');
  assert.equal(body.actions[0].method, 'POST');
});

test('quiet-hour digests survive restart and flush on wake while human review still pages', () => {
  const settings = sanitizeNotificationSettings({
    digestMode: 'quiet-hours',
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    pageAlways: ['awaiting_human_review'],
  });
  const late = new Date(2026, 6, 15, 23, 0);
  const overnight = new Date(2026, 6, 16, 7, 0);
  const morning = new Date(2026, 6, 16, 9, 0);

  assert.equal(notificationPolicyDecision(settings, 'failed', late), 'digest');
  assert.equal(notificationPolicyDecision(settings, 'awaiting_human_review', late), 'page');
  let state = enqueueNotificationDigest(null, {
    title: 'Campaign stopped',
    message: 'Fixture failed during quiet hours.',
    category: 'failed',
    eventKey: 'failed:fixture',
  }, late.getTime());

  state = sanitizeNotificationDigestState(JSON.parse(JSON.stringify(state)));
  assert.equal(isWithinQuietHours(settings, overnight), true);
  assert.equal(state.pending.length, 1);
  assert.equal(isWithinQuietHours(settings, morning), false);
  assert.deepEqual(buildNotificationDigest(state), {
    title: 'Campaigns digest · 1',
    message: 'Fixture failed during quiet hours.',
    count: 1,
  });
});

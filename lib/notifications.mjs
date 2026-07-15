// Notification delivery and the pure helpers around it: the macOS banner
// (osascript), the ntfy / webhook push, notification-settings shaping, and the
// stop-watcher's snapshot fingerprinting + alert classification. Pure Node with
// no server config or timers — the running stop-watcher loop and the settings/
// state file IO stay in server.mjs and call in here.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const NTFY_TOPIC_REGEX = /^[A-Za-z0-9_-]{3,64}$/;
export const NOTIFICATION_DIGEST_MODES = new Set(['immediate', 'quiet-hours']);
export const NOTIFICATION_PAGE_ALWAYS_VALUES = new Set([
  'awaiting_human_review',
  'blocked',
  'failed',
  'cap_reached',
  'stopped_by_user',
]);
export const DEFAULT_NOTIFICATION_PAGE_ALWAYS = Object.freeze(['awaiting_human_review']);

// Automation status vocabulary the stop-watcher classifies snapshots against.
const FINISHED_AUTOMATE_STATUSES = new Set(['completed', 'complete']);
const STOPPED_AUTOMATE_STATUSES = new Set([
  'stalled',
  'blocked',
  'failed',
  'halted',
  'awaiting_human_review',
  'cap_reached',
  'stopped_by_user',
  'abandoned',
  'cancelled',
  'canceled',
]);
const MOVING_AUTOMATE_STATUSES = new Set(['active', 'running']);
const EXPECTED_AUTOMATE_STATUSES = new Set(['active', 'running', 'queued', 'scheduled']);

export function defaultNotificationSettings() {
  return {
    macNotificationsEnabled: false,
    ntfyTopic: '',
    ntfyCommandTopic: '',
    webhookUrl: '',
    digestMode: 'immediate',
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    pageAlways: [...DEFAULT_NOTIFICATION_PAGE_ALWAYS],
    verifiedPhoneUrl: '',
  };
}

export function sanitizeNotificationSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  return {
    macNotificationsEnabled: settings.macNotificationsEnabled === true,
    ntfyTopic: typeof settings.ntfyTopic === 'string' ? settings.ntfyTopic.trim() : '',
    ntfyCommandTopic: typeof settings.ntfyCommandTopic === 'string'
      && NTFY_TOPIC_REGEX.test(settings.ntfyCommandTopic.trim())
      ? settings.ntfyCommandTopic.trim()
      : '',
    webhookUrl: typeof settings.webhookUrl === 'string' ? settings.webhookUrl.trim() : '',
    digestMode: NOTIFICATION_DIGEST_MODES.has(settings.digestMode)
      ? settings.digestMode
      : 'immediate',
    quietHoursStart: normalizeClockTime(settings.quietHoursStart, '22:00'),
    quietHoursEnd: normalizeClockTime(settings.quietHoursEnd, '08:00'),
    pageAlways: sanitizePageAlways(settings.pageAlways),
    verifiedPhoneUrl: isPhoneReachableHttpsUrl(settings.verifiedPhoneUrl)
      ? new URL(settings.verifiedPhoneUrl).toString()
      : '',
  };
}

export async function displayNativeNotification(title, message, sound = 'Glass') {
  if (process.platform !== 'darwin') {
    const error = new Error('Native notifications are only available on macOS.');
    error.statusCode = 501;
    throw error;
  }

  await new Promise((resolve, reject) => {
    execFile(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)',
        '-e',
        'end run',
        title,
        message,
        notificationSoundName(sound),
      ],
      { timeout: 5000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

export function notificationSoundName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : 'Glass';
}

export async function deliverRemoteNotification({
  title,
  message,
  ntfyTopic,
  ntfyActions = [],
  webhookUrl,
  strict = false,
  fetchImpl = globalThis.fetch,
}) {
  const topic = typeof ntfyTopic === 'string' ? ntfyTopic.trim() : '';
  const hook = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
  const deliveries = [];

  if (topic) {
    if (!NTFY_TOPIC_REGEX.test(topic)) {
      if (!strict) {
        // Settings are persisted while the user types; ignore an incomplete topic.
      } else {
        return {
          statusCode: 400,
          error: 'ntfy topic must be 3-64 letters, numbers, dashes, or underscores.',
        };
      }
    } else {
      const actions = Array.isArray(ntfyActions) ? ntfyActions.slice(0, 3) : [];
      deliveries.push({
        channel: 'ntfy',
        promise: fetchWithTimeout('https://ntfy.sh', {
          method: 'POST',
          body: JSON.stringify({ topic, title, message, ...(actions.length ? { actions } : {}) }),
          headers: { 'Content-Type': 'application/json' },
        }, 8000, fetchImpl),
      });
    }
  }

  if (hook) {
    const webhook = parseWebhookUrl(hook);
    if (!webhook) {
      if (!strict) {
        // Settings are persisted while the user types; ignore an incomplete webhook.
      } else {
        return {
          statusCode: 400,
          error: 'Webhook must be a Slack or Discord HTTPS webhook URL.',
        };
      }
    } else {
      const body = webhook.kind === 'discord'
        ? { content: `**${title}**: ${message}` }
        : { text: `${title}: ${message}` };

      deliveries.push({
        channel: webhook.kind,
        promise: fetchWithTimeout(webhook.url, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }, 8000, fetchImpl),
      });
    }
  }

  if (deliveries.length === 0) {
    if (!strict) return { failures: [], skipped: true };
    return { statusCode: 400, error: 'No remote notification channel is configured.' };
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

  return { failures };
}

export function buildNtfyRunActions({ commandTopic, stopToken, approveToken = '', openUrl = '' }) {
  if (!NTFY_TOPIC_REGEX.test(commandTopic || '')) return [];
  const commandUrl = `https://ntfy.sh/${encodeURIComponent(commandTopic)}`;
  const actions = [];
  if (stopToken) {
    actions.push({
      action: 'http',
      label: 'Stop',
      url: commandUrl,
      method: 'POST',
      body: stopToken,
      clear: true,
    });
  }
  if (approveToken) {
    actions.push({
      action: 'http',
      label: 'Approve',
      url: commandUrl,
      method: 'POST',
      body: approveToken,
      clear: true,
    });
  }
  if (isPhoneReachableHttpsUrl(openUrl)) {
    actions.push({ action: 'view', label: 'Open', url: new URL(openUrl).toString(), clear: true });
  }
  return actions.slice(0, 3);
}

export function notificationPolicyDecision(settingsValue, category, now = new Date()) {
  const settings = sanitizeNotificationSettings(settingsValue);
  if (settings.pageAlways.includes(category)) return 'page';
  if (settings.digestMode === 'quiet-hours' && isWithinQuietHours(settings, now)) return 'digest';
  return 'page';
}

export function isWithinQuietHours(settingsValue, now = new Date()) {
  const settings = sanitizeNotificationSettings(settingsValue);
  const start = clockMinutes(settings.quietHoursStart);
  const end = clockMinutes(settings.quietHoursEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function sanitizeNotificationDigestState(value) {
  const pending = Array.isArray(value?.pending)
    ? value.pending.filter((item) => (
      item && typeof item.title === 'string' && typeof item.message === 'string'
    )).slice(-100).map((item) => ({
      title: notificationText(item.title, 'Campaigns', 80),
      message: notificationText(item.message, '', 500),
      category: typeof item.category === 'string' ? item.category : 'other',
      eventKey: typeof item.eventKey === 'string' ? item.eventKey : null,
      createdAt: Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date(0).toISOString(),
    }))
    : [];
  return { version: 1, pending };
}

export function enqueueNotificationDigest(stateValue, item, now = Date.now()) {
  const state = sanitizeNotificationDigestState(stateValue);
  if (item.eventKey && state.pending.some((pending) => pending.eventKey === item.eventKey)) return state;
  state.pending.push({
    title: notificationText(item.title, 'Campaigns', 80),
    message: notificationText(item.message, '', 500),
    category: typeof item.category === 'string' ? item.category : 'other',
    eventKey: typeof item.eventKey === 'string' ? item.eventKey : null,
    createdAt: new Date(now).toISOString(),
  });
  state.pending = state.pending.slice(-100);
  return state;
}

export function buildNotificationDigest(stateValue) {
  const state = sanitizeNotificationDigestState(stateValue);
  if (!state.pending.length) return null;
  const summary = state.pending.slice(-5).map((item) => item.message).join(' ');
  const omitted = state.pending.length - Math.min(5, state.pending.length);
  return {
    title: `Campaigns digest · ${state.pending.length}`,
    message: notificationText(`${summary}${omitted ? ` +${omitted} earlier.` : ''}`, '', 500),
    count: state.pending.length,
  };
}

export function isPhoneReachableHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return !(
    host === 'localhost'
    || host === '::1'
    || host === '0.0.0.0'
    || /^127(?:\.|$)/.test(host)
  );
}

export function normalizeStopWatcherStatus(automation) {
  if (!automation || typeof automation !== 'object') return 'idle';
  const rawStatus = typeof automation.status === 'string' ? automation.status : 'idle';
  if (rawStatus === 'active' && automation.is_active === false) return 'stalled';
  return rawStatus.toLowerCase();
}

export function stopWatcherFingerprint({ status, automation, progress, fileMtimeMs, missing, automationError }) {
  const stepStatuses = Array.isArray(automation?.steps)
    ? automation.steps.map((step) => [step.id, step.status, Boolean(step.receipt)])
    : [];
  const timeline = Array.isArray(automation?.timeline_events) ? automation.timeline_events : [];
  const lastTimeline = timeline.length ? timeline[timeline.length - 1] : null;
  const log = typeof automation?.current_step_log === 'string' ? automation.current_step_log : '';
  const live = automation?.live_activity && typeof automation.live_activity === 'object'
    ? automation.live_activity
    : null;

  return hashString(JSON.stringify({
    status,
    backend: automation?.backend ?? null,
    is_active: automation?.is_active ?? null,
    has_active_run: automation?.has_active_run ?? null,
    active_run_last_seen_at: automation?.active_run_last_seen_at ?? null,
    current_step: automation?.current_step ?? null,
    progress,
    fileMtimeMs,
    missing,
    automationError,
    stepStatuses,
    timelineLength: timeline.length,
    lastTimeline,
    logLength: log.length,
    logHash: hashString(log),
    liveLastEventAt: live?.last_event_at ?? null,
    liveEffort: live?.effort ?? null,
  }));
}

export function hashString(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function classifyStopWatcherAlerts(previous, snapshot, now, noMovementMs) {
  if (!previous || snapshot.parked) return [];

  const wasExpected = previous.expectedActive === true || EXPECTED_AUTOMATE_STATUSES.has(previous.status);
  if (!wasExpected) return [];

  const alerts = phaseCompletionAlerts(previous, snapshot);

  if (snapshot.missing) {
    alerts.push(stopWatcherAlert('stopped', 'Campaign stopped', snapshot, 'markdown file disappeared'));
    return alerts;
  }

  if (FINISHED_AUTOMATE_STATUSES.has(snapshot.status)) {
    alerts.push(stopWatcherAlert('finished', 'Campaign finished', snapshot, 'completed normally'));
    return alerts;
  }

  if (STOPPED_AUTOMATE_STATUSES.has(snapshot.status)) {
    alerts.push(stopWatcherAlert('stopped', 'Campaign stopped', snapshot, stopWatcherStatusLabel(snapshot.status)));
    return alerts;
  }

  if (previous.hasActiveRun && !snapshot.hasActiveRun && !EXPECTED_AUTOMATE_STATUSES.has(snapshot.status)) {
    alerts.push(stopWatcherAlert('stopped', 'Campaign stopped', snapshot, 'active run disappeared'));
    return alerts;
  }

  if (previous.expectedActive && snapshot.status === 'idle') {
    const reason = snapshot.hasAutomationState ? 'automation went idle' : 'automation state disappeared';
    alerts.push(stopWatcherAlert('stopped', 'Campaign stopped', snapshot, reason));
    return alerts;
  }

  if (MOVING_AUTOMATE_STATUSES.has(snapshot.status)) {
    const lastMovementAt = Number(previous.lastMovementAt ?? now);
    if (Number.isFinite(lastMovementAt) && now - lastMovementAt >= noMovementMs) {
      const minutes = Math.max(1, Math.round((now - lastMovementAt) / 60_000));
      alerts.push(stopWatcherAlert('stopped', 'Campaign stopped', snapshot, `no movement for ${minutes} min`, 'no movement'));
      return alerts;
    }
  }

  return alerts;
}

export function phaseCompletionAlerts(previous, snapshot) {
  if (previous.phaseTrackingReady !== true) return [];

  const previousKeys = new Set(Array.isArray(previous.completedPhaseKeys) ? previous.completedPhaseKeys : []);
  const completed = snapshot.phases.filter((phase) => (
    phase.total > 0 &&
    phase.done === phase.total &&
    !previousKeys.has(phase.key)
  ));
  if (completed.length === 0) return [];

  if (completed.length === 1) {
    const phase = completed[0];
    return [{
      type: 'phase',
      kind: 'finished',
      category: 'phase_completed',
      title: 'Campaign phase finished',
      message: `${snapshot.title}: ${phase.title} finished (${phase.done}/${phase.total}).`,
      eventKey: `phase:${snapshot.id}:${phase.key}:${phase.done}/${phase.total}`,
    }];
  }

  const names = completed.slice(0, 3).map((phase) => phase.title).join(', ');
  const suffix = completed.length > 3 ? `, +${completed.length - 3} more` : '';
  return [{
    type: 'phase',
    kind: 'finished',
    category: 'phase_completed',
    title: 'Campaign phases finished',
    message: `${snapshot.title}: ${completed.length} phases finished: ${names}${suffix}.`,
    eventKey: `phase:${snapshot.id}:${completed.map((phase) => phase.key).join('|')}`,
  }];
}

export function stopWatcherAlert(kind, title, snapshot, reason, keyReason = reason) {
  const step = [snapshot.currentStepId, snapshot.currentStepName].filter(Boolean).join(' - ');
  const messageParts = [`${snapshot.title}: ${reason}.`];
  if (step) messageParts.push(`Current step: ${step}.`);
  const eventKey = `${kind}:${snapshot.id}:${snapshot.status}:${keyReason}:${snapshot.currentStepId ?? ''}:${snapshot.fingerprint}`;
  return {
    type: 'stop',
    kind,
    category: snapshot.status,
    title,
    message: messageParts.join(' '),
    eventKey,
  };
}

export function stopWatcherStatusLabel(status) {
  if (status === 'stalled') return 'stalled';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'halted') return 'halted';
  if (status === 'awaiting_human_review') return 'awaiting human review';
  if (status === 'cap_reached') return 'run cap reached';
  if (status === 'stopped_by_user') return 'stopped by user';
  if (status === 'abandoned') return 'abandoned';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return status;
}

export function nextStopWatcherRecord(previous, snapshot, now, alerts) {
  const fingerprintChanged = previous?.fingerprint !== snapshot.fingerprint;
  const expectedActive = !snapshot.parked && EXPECTED_AUTOMATE_STATUSES.has(snapshot.status);
  const lastMovementAt = fingerprintChanged || !previous?.lastMovementAt
    ? now
    : previous.lastMovementAt;
  const stopAlert = alerts.find((alert) => alert.type === 'stop');
  let notifiedEventKey = stopAlert?.eventKey ?? previous?.notifiedEventKey ?? null;

  if (!stopAlert && fingerprintChanged && expectedActive) {
    notifiedEventKey = null;
  }
  if (!stopAlert && !expectedActive && !FINISHED_AUTOMATE_STATUSES.has(snapshot.status) && !STOPPED_AUTOMATE_STATUSES.has(snapshot.status)) {
    notifiedEventKey = null;
  }

  return {
    status: snapshot.status,
    fingerprint: snapshot.fingerprint,
    expectedActive,
    hasActiveRun: snapshot.hasActiveRun,
    currentStepId: snapshot.currentStepId,
    completedPhaseKeys: snapshot.completedPhaseKeys,
    phaseTrackingReady: true,
    lastMovementAt,
    lastSeenAt: new Date(now).toISOString(),
    notifiedEventKey,
  };
}

export function notificationText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function parseWebhookUrl(value) {
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

function normalizeClockTime(value, fallback) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

function clockMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function sanitizePageAlways(value) {
  if (!Array.isArray(value)) return [...DEFAULT_NOTIFICATION_PAGE_ALWAYS];
  return [...new Set(value.filter((item) => NOTIFICATION_PAGE_ALWAYS_VALUES.has(item)))];
}

export async function fetchWithTimeout(url, options, timeoutMs = 8000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

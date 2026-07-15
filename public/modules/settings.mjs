// Settings drawer: appearance/theme, sound + celebration toggles, and the
// notification preferences (mac / ntfy / webhook) with their test buttons and
// server sync. Reads shared state, writes prefs via prefs-store, and reaches
// effects for theme application and notification delivery.

import { state } from './state.mjs';
import { showToast, trapDialogFocus } from './dom.mjs';
import { applyTheme, NTFY_TOPIC_REGEX, postRemoteNotification } from './effects.mjs';
import { buildFeatureRequestUrl } from '../lib/feature-request.mjs';
import { normalizeTheme } from '../lib/prefs.mjs';
import { savePrefs } from './prefs-store.mjs';

let notificationSettingsSaveTimer = null;

export function notificationSettingsPayload() {
  return {
    macNotificationsEnabled: !!state.prefs.macNotificationsEnabled,
    ntfyTopic: state.prefs.ntfyTopic || '',
    webhookUrl: state.prefs.webhookUrl || '',
    digestMode: state.prefs.digestMode || 'immediate',
    quietHoursStart: state.prefs.quietHoursStart || '22:00',
    quietHoursEnd: state.prefs.quietHoursEnd || '08:00',
    pageAlways: Array.isArray(state.prefs.pageAlways) ? state.prefs.pageAlways : ['awaiting_human_review'],
    verifiedPhoneUrl: state.prefs.verifiedPhoneUrl || '',
  };
}

export function hasNotificationSettingsConfigured(settings = notificationSettingsPayload()) {
  return !!settings.macNotificationsEnabled || !!settings.ntfyTopic || !!settings.webhookUrl;
}

export function applyNotificationSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  let changed = false;
  const next = {
    macNotificationsEnabled: settings.macNotificationsEnabled === true,
    ntfyTopic: typeof settings.ntfyTopic === 'string' ? settings.ntfyTopic : '',
    webhookUrl: typeof settings.webhookUrl === 'string' ? settings.webhookUrl : '',
    digestMode: settings.digestMode === 'quiet-hours' ? 'quiet-hours' : 'immediate',
    quietHoursStart: typeof settings.quietHoursStart === 'string' ? settings.quietHoursStart : '22:00',
    quietHoursEnd: typeof settings.quietHoursEnd === 'string' ? settings.quietHoursEnd : '08:00',
    pageAlways: Array.isArray(settings.pageAlways) ? settings.pageAlways : ['awaiting_human_review'],
    verifiedPhoneUrl: typeof settings.verifiedPhoneUrl === 'string' ? settings.verifiedPhoneUrl : '',
  };

  for (const [key, value] of Object.entries(next)) {
    const unchanged = Array.isArray(value)
      ? JSON.stringify(state.prefs[key]) === JSON.stringify(value)
      : state.prefs[key] === value;
    if (!unchanged) {
      state.prefs[key] = value;
      changed = true;
    }
  }

  if (changed) savePrefs();
  return changed;
}

export async function syncNotificationSettingsFromServer(onApplied) {
  try {
    const response = await fetch('/api/notification-settings');
    if (!response.ok) return;
    const settings = await response.json();

    if (settings.configured) {
      if (applyNotificationSettings(settings)) onApplied?.();
      return;
    }

    if (hasNotificationSettingsConfigured()) {
      persistNotificationSettings();
    }
  } catch {
    /* notification settings are optional */
  }
}

export function saveNotificationPrefs() {
  savePrefs();
  clearTimeout(notificationSettingsSaveTimer);
  notificationSettingsSaveTimer = window.setTimeout(persistNotificationSettings, 250);
}

export async function persistNotificationSettings() {
  try {
    await fetch('/api/notification-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notificationSettingsPayload()),
    });
  } catch {
    /* notification settings are optional */
  }
}

/* ---------- Custom Vibe Coder Extensions ---------- */

export function initSettings(appInfo) {
  const settingsBtn = document.querySelector('#settings-button');
  const drawer = document.querySelector('#settings-drawer');
  const drawerContent = drawer?.querySelector('.settings-drawer-content');
  const themeSelect = document.querySelector('#theme-select');
  const soundToggle = document.querySelector('#sound-toggle');
  const celebrationToggle = document.querySelector('#celebration-toggle');
  const macToggle = document.querySelector('#mac-notify-toggle');
  const ntfyInput = document.querySelector('#ntfy-topic-input');
  const testNtfyBtn = document.querySelector('#test-ntfy-button');
  const webhookInput = document.querySelector('#webhook-url-input');
  const testWebhookBtn = document.querySelector('#test-webhook-button');
  const digestModeSelect = document.querySelector('#digest-mode-select');
  const quietHoursStart = document.querySelector('#quiet-hours-start');
  const quietHoursEnd = document.querySelector('#quiet-hours-end');
  const pageAlwaysInputs = [...document.querySelectorAll('[data-page-always]')];
  const featureRequestLink = document.querySelector('#feature-request-link');

  if (!settingsBtn || !drawer) return;

  if (featureRequestLink && appInfo?.version && appInfo?.platform) {
    featureRequestLink.href = buildFeatureRequestUrl(appInfo);
    featureRequestLink.hidden = false;
  }

  let previouslyFocused = null;

  const syncSettingsControls = () => {
    if (themeSelect) themeSelect.value = normalizeTheme(state.prefs.theme);
    if (soundToggle) soundToggle.checked = !!state.prefs.soundEffectsEnabled;
    if (celebrationToggle) celebrationToggle.checked = !!state.prefs.celebrationsEnabled;
    if (macToggle) macToggle.checked = !!state.prefs.macNotificationsEnabled;
    if (ntfyInput) ntfyInput.value = state.prefs.ntfyTopic || '';
    if (webhookInput) webhookInput.value = state.prefs.webhookUrl || '';
    if (digestModeSelect) digestModeSelect.value = state.prefs.digestMode || 'immediate';
    if (quietHoursStart) quietHoursStart.value = state.prefs.quietHoursStart || '22:00';
    if (quietHoursEnd) quietHoursEnd.value = state.prefs.quietHoursEnd || '08:00';
    const pageAlways = new Set(state.prefs.pageAlways || ['awaiting_human_review']);
    pageAlwaysInputs.forEach((input) => { input.checked = pageAlways.has(input.value); });
  };

  const openDrawer = () => {
    syncSettingsControls();
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.removeAttribute('hidden');
    settingsBtn.setAttribute('aria-expanded', 'true');
    drawerContent?.querySelector('[data-action="close-settings"]')?.focus();
  };

  const closeDrawer = () => {
    drawer.setAttribute('hidden', '');
    settingsBtn.setAttribute('aria-expanded', 'false');
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    } else {
      settingsBtn.focus();
    }
  };

  settingsBtn.addEventListener('click', openDrawer);

  drawer.querySelectorAll('[data-action="close-settings"]').forEach(btn => {
    btn.addEventListener('click', closeDrawer);
  });

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key === 'Tab') {
      trapDialogFocus(event, drawer);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || drawer.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    closeDrawer();
  });

  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      state.prefs.theme = normalizeTheme(themeSelect.value);
      savePrefs();
      applyTheme(state.prefs.theme);
    });
  }

  if (soundToggle) {
    soundToggle.addEventListener('change', () => {
      state.prefs.soundEffectsEnabled = soundToggle.checked;
      savePrefs();
    });
  }

  if (celebrationToggle) {
    celebrationToggle.addEventListener('change', () => {
      state.prefs.celebrationsEnabled = celebrationToggle.checked;
      savePrefs();
    });
  }

  if (macToggle) {
    macToggle.addEventListener('change', () => {
      state.prefs.macNotificationsEnabled = macToggle.checked;
      saveNotificationPrefs();
    });
  }

  if (ntfyInput) {
    ntfyInput.addEventListener('input', () => {
      state.prefs.ntfyTopic = ntfyInput.value.trim();
      saveNotificationPrefs();
    });
  }

  if (webhookInput) {
    webhookInput.addEventListener('input', () => {
      state.prefs.webhookUrl = webhookInput.value.trim();
      saveNotificationPrefs();
    });
  }

  if (digestModeSelect) {
    digestModeSelect.addEventListener('change', () => {
      state.prefs.digestMode = digestModeSelect.value === 'quiet-hours' ? 'quiet-hours' : 'immediate';
      saveNotificationPrefs();
    });
  }

  for (const input of [quietHoursStart, quietHoursEnd]) {
    input?.addEventListener('change', () => {
      state.prefs.quietHoursStart = quietHoursStart?.value || '22:00';
      state.prefs.quietHoursEnd = quietHoursEnd?.value || '08:00';
      saveNotificationPrefs();
    });
  }

  pageAlwaysInputs.forEach((input) => {
    input.addEventListener('change', () => {
      state.prefs.pageAlways = pageAlwaysInputs.filter((row) => row.checked).map((row) => row.value);
      saveNotificationPrefs();
    });
  });

  if (testNtfyBtn) {
    testNtfyBtn.addEventListener('click', async () => {
      const topic = ntfyInput.value.trim();
      if (!topic) {
        showToast('Please enter a topic name first.');
        return;
      }
      if (!NTFY_TOPIC_REGEX.test(topic)) {
        showToast('Use 3-64 letters, numbers, dashes, or underscores.');
        return;
      }
      testNtfyBtn.disabled = true;
      try {
        await postRemoteNotification({
          title: 'Campaigns',
          message: 'iPhone push is connected.',
          ntfyTopic: topic,
        });
        showToast('Test push sent.');
      } catch (err) {
        showToast(err.message);
      } finally {
        testNtfyBtn.disabled = false;
      }
    });
  }

  if (testWebhookBtn) {
    testWebhookBtn.addEventListener('click', async () => {
      const url = webhookInput.value.trim();
      if (!url) {
        showToast('Please enter a webhook URL first.');
        return;
      }
      testWebhookBtn.disabled = true;
      try {
        await postRemoteNotification({
          title: 'Campaigns',
          message: 'Team webhook is connected.',
          webhookUrl: url,
        });
        showToast('Test webhook sent.');
      } catch (err) {
        showToast(err.message);
      } finally {
        testWebhookBtn.disabled = false;
      }
    });
  }

  syncNotificationSettingsFromServer(syncSettingsControls);
}

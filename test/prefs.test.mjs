// Characterization tests for preference shaping (public/lib/prefs.mjs).
// Pins the defaults, the type-coercion in sanitizePrefs, the legacy-theme
// migration, and the standard-settings convergence.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyStandardCampaignSettings,
  defaultPrefs,
  LEGACY_THEME_MAP,
  NOTIFICATION_DIGEST_MODES,
  normalizeTheme,
  sanitizePrefs,
  STANDARD_CAMPAIGN_SETTINGS,
  THEME_KEYS,
} from '../public/lib/prefs.mjs';

test('defaultPrefs matches the standard campaign settings baseline', () => {
  const d = defaultPrefs();
  assert.equal(d.theme, STANDARD_CAMPAIGN_SETTINGS.theme);
  assert.equal(d.soundEffectsEnabled, STANDARD_CAMPAIGN_SETTINGS.soundEffectsEnabled);
  assert.equal(d.celebrationsEnabled, STANDARD_CAMPAIGN_SETTINGS.celebrationsEnabled);
  assert.equal(d.macNotificationsEnabled, STANDARD_CAMPAIGN_SETTINGS.macNotificationsEnabled);
  assert.equal(d.ntfyTopic, STANDARD_CAMPAIGN_SETTINGS.ntfyTopic);
  assert.equal(d.webhookUrl, '');
  assert.equal(d.digestMode, 'immediate');
  assert.equal(d.quietHoursStart, '22:00');
  assert.equal(d.quietHoursEnd, '08:00');
  assert.deepEqual(d.pageAlways, ['awaiting_human_review']);
  assert.equal(d.fleetAsDefault, false);
  assert.deepEqual(d.filters, { todo: true, flight: true, done: true });
});

test('normalizeTheme migrates legacy names, keeps valid ones, and defaults the rest', () => {
  for (const [legacy, mapped] of Object.entries(LEGACY_THEME_MAP)) {
    assert.equal(normalizeTheme(legacy), mapped);
  }
  for (const key of THEME_KEYS) {
    assert.equal(normalizeTheme(key), key);
  }
  assert.equal(normalizeTheme('does-not-exist'), 'default');
  assert.equal(normalizeTheme(undefined), 'default');
  assert.equal(normalizeTheme(42), 'default');
});

test('sanitizePrefs coerces bad types back to defaults and normalizes theme', () => {
  const cleaned = sanitizePrefs({
    theme: 'obsidian', // legacy -> graphite
    focusMode: 'yes', // not a boolean -> default false
    filters: { todo: false }, // partial -> merged over defaults
    ntfyTopic: 123, // not a string -> default ''
    digestMode: 'later',
    quietHoursStart: '25:00',
    pageAlways: ['failed', 'unknown', 'failed'],
    fleetAsDefault: 'yes',
    docSections: null, // -> {}
    extra: 'kept-by-spread',
  });
  assert.equal(cleaned.theme, 'graphite');
  assert.equal(cleaned.focusMode, false);
  assert.deepEqual(cleaned.filters, { todo: false, flight: true, done: true });
  assert.equal(cleaned.ntfyTopic, '');
  assert.equal(cleaned.digestMode, 'immediate');
  assert.equal(cleaned.quietHoursStart, '22:00');
  assert.deepEqual(cleaned.pageAlways, ['failed']);
  assert.equal(cleaned.fleetAsDefault, false);
  assert.deepEqual(cleaned.docSections, {});
  assert.equal(cleaned.extra, 'kept-by-spread');
});

test('notification digest modes are intentionally small', () => {
  assert.deepEqual([...NOTIFICATION_DIGEST_MODES], ['immediate', 'quiet-hours']);
});

test('applyStandardCampaignSettings converges values and reports whether it changed', () => {
  const drifted = { theme: 'blueprint', soundEffectsEnabled: false, webhookUrl: 'https://hook' };
  const changed = applyStandardCampaignSettings(drifted);
  assert.equal(changed, true);
  assert.equal(drifted.theme, 'default');
  assert.equal(drifted.soundEffectsEnabled, true);
  // An existing webhook is preserved (the standard defines no default webhook).
  assert.equal(drifted.webhookUrl, 'https://hook');

  // Already-standard prefs report no change.
  const standard = { ...STANDARD_CAMPAIGN_SETTINGS, webhookUrl: '' };
  assert.equal(applyStandardCampaignSettings(standard), false);
});

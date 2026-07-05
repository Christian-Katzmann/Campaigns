// Preference defaults, sanitization, and normalization — pure functions.
//
// No `localStorage`, no `document`, no module-level mutable state: given a
// parsed-JSON object, these return a clean prefs object. app.js owns the
// storage side (loadPrefs/savePrefs read and write localStorage) and calls
// into these to shape what it stores. Keeping them pure lets tests exercise
// the sanitize/normalize rules without a browser.

// The theme keys the picker actually offers, and the migration map from the
// retired theme names to their closest surviving equivalent. A prefs blob that
// still names an old theme ('cyberpunk', 'forest', 'obsidian', 'sunset') is
// mapped forward on load rather than dropped.
export const THEME_KEYS = new Set(['default', 'graphite', 'blueprint', 'signal']);
export const LEGACY_THEME_MAP = {
  cyberpunk: 'blueprint',
  forest: 'signal',
  obsidian: 'graphite',
  sunset: 'signal',
};

// The baseline every campaign starts from. Migrations converge stored prefs on
// these values (see applyStandardCampaignSettings).
export const STANDARD_CAMPAIGN_SETTINGS = Object.freeze({
  theme: 'default',
  soundEffectsEnabled: true,
  celebrationsEnabled: true,
  macNotificationsEnabled: false,
  ntfyTopic: '',
});

export function defaultPrefs() {
  return {
    docSections: {},
    filters: { todo: true, flight: true, done: true },
    focusMode: false,
    lastSession: { time: '', ticked: [] },
    phaseInverted: [],
    placeholders: {},
    today: { date: '', startCount: 0, lastActivity: '' },
    soundEffectsEnabled: STANDARD_CAMPAIGN_SETTINGS.soundEffectsEnabled,
    celebrationsEnabled: STANDARD_CAMPAIGN_SETTINGS.celebrationsEnabled,
    macNotificationsEnabled: STANDARD_CAMPAIGN_SETTINGS.macNotificationsEnabled,
    ntfyTopic: STANDARD_CAMPAIGN_SETTINGS.ntfyTopic,
    webhookUrl: '',
    theme: STANDARD_CAMPAIGN_SETTINGS.theme,
  };
}

export function sanitizePrefs(parsed) {
  const defaults = defaultPrefs();
  const parsedSession = parsed.lastSession && typeof parsed.lastSession === 'object'
    ? parsed.lastSession
    : null;
  return {
    ...defaults,
    ...parsed,
    docSections: parsed.docSections && typeof parsed.docSections === 'object'
      ? parsed.docSections
      : {},
    filters: { ...defaults.filters, ...(parsed.filters || {}) },
    focusMode: typeof parsed.focusMode === 'boolean' ? parsed.focusMode : defaults.focusMode,
    lastSession: parsedSession
      ? {
          time: typeof parsedSession.time === 'string' ? parsedSession.time : '',
          ticked: Array.isArray(parsedSession.ticked) ? parsedSession.ticked : [],
        }
      : defaults.lastSession,
    phaseInverted: Array.isArray(parsed.phaseInverted) ? parsed.phaseInverted : [],
    placeholders: parsed.placeholders && typeof parsed.placeholders === 'object'
      ? parsed.placeholders
      : {},
    today: { ...defaults.today, ...(parsed.today || {}) },
    soundEffectsEnabled: typeof parsed.soundEffectsEnabled === 'boolean' ? parsed.soundEffectsEnabled : defaults.soundEffectsEnabled,
    celebrationsEnabled: typeof parsed.celebrationsEnabled === 'boolean' ? parsed.celebrationsEnabled : defaults.celebrationsEnabled,
    macNotificationsEnabled: typeof parsed.macNotificationsEnabled === 'boolean' ? parsed.macNotificationsEnabled : defaults.macNotificationsEnabled,
    ntfyTopic: typeof parsed.ntfyTopic === 'string' ? parsed.ntfyTopic : defaults.ntfyTopic,
    webhookUrl: typeof parsed.webhookUrl === 'string' ? parsed.webhookUrl : defaults.webhookUrl,
    theme: normalizeTheme(parsed.theme),
  };
}

export function normalizeTheme(theme) {
  if (typeof theme !== 'string') return 'default';
  const normalized = LEGACY_THEME_MAP[theme] ?? theme;
  return THEME_KEYS.has(normalized) ? normalized : 'default';
}

export function applyStandardCampaignSettings(prefs) {
  if (!prefs || typeof prefs !== 'object') return false;
  let changed = false;

  for (const [key, value] of Object.entries(STANDARD_CAMPAIGN_SETTINGS)) {
    if (prefs[key] !== value) {
      prefs[key] = value;
      changed = true;
    }
  }

  // Keep any existing team webhook intact; the standard only defines no
  // default webhook for campaigns that do not already have one.
  if (typeof prefs.webhookUrl !== 'string') {
    prefs.webhookUrl = '';
    changed = true;
  }

  return changed;
}

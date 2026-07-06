// Preference storage: read/write the per-file prefs blob in localStorage, run the
// one-time migrations, and track today's / this-session's progress. The pure
// shaping lives in lib/prefs.mjs; this is the side-effecting layer around it that
// the board, settings, and startup all lean on. Sits just above state + prefs.

import { state } from './state.mjs';
import { applyStandardCampaignSettings, defaultPrefs, sanitizePrefs } from '../lib/prefs.mjs';

const PREFS_KEY = 'campaigns-prefs:v1';
const LEGACY_PREFS_KEY = 'campaign-guide-prefs:v1';
const MIGRATION_FLAG_KEY = 'campaigns-migrated:v1';
const DOC_SECTIONS_RESET_FLAG_KEY = 'campaigns-doc-sections-reset:v1';
const STANDARD_SETTINGS_MIGRATION_FLAG_KEY = 'campaigns-standard-settings-2026-05-24:v1';
const TODAY_INACTIVITY_MS = 12 * 60 * 60 * 1000;

export function migrateStandardCampaignSettings(allPrefs) {
  if (localStorage.getItem(STANDARD_SETTINGS_MIGRATION_FLAG_KEY) === 'done') {
    return false;
  }

  let mutated = false;
  for (const key of Object.keys(allPrefs)) {
    if (applyStandardCampaignSettings(allPrefs[key])) {
      mutated = true;
    }
  }

  if (mutated) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(allPrefs));
  }
  localStorage.setItem(STANDARD_SETTINGS_MIGRATION_FLAG_KEY, 'done');
  return mutated;
}

export function loadPrefs(filePath) {
  const defaults = defaultPrefs();
  if (!filePath) return defaults;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    let all;
    try {
      all = raw ? JSON.parse(raw) : {};
    } catch {
      all = {};
    }
    if (!all || typeof all !== 'object') all = {};

    // Orientation sections (Scope, Context, How prompts work) now default to
    // closed. Clear stored open-state once so the new default is visible on
    // files the user already touched; subsequent toggles re-populate normally.
    if (localStorage.getItem(DOC_SECTIONS_RESET_FLAG_KEY) !== 'done') {
      let mutated = false;
      for (const key of Object.keys(all)) {
        const entry = all[key];
        if (entry && typeof entry === 'object' && entry.docSections) {
          entry.docSections = {};
          mutated = true;
        }
      }
      if (mutated) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
      }
      localStorage.setItem(DOC_SECTIONS_RESET_FLAG_KEY, 'done');
    }

    migrateStandardCampaignSettings(all);

    const parsed = all[filePath];
    if (parsed && typeof parsed === 'object') {
      return sanitizePrefs(parsed);
    }

    // First file-load on the new app: migrate legacy single-key prefs once.
    if (localStorage.getItem(MIGRATION_FLAG_KEY) !== 'done') {
      const legacyRaw = localStorage.getItem(LEGACY_PREFS_KEY);
      if (legacyRaw) {
        try {
          const legacy = JSON.parse(legacyRaw);
          if (legacy && typeof legacy === 'object') {
            const migrated = sanitizePrefs(legacy);
            applyStandardCampaignSettings(migrated);
            all[filePath] = migrated;
            localStorage.setItem(PREFS_KEY, JSON.stringify(all));
            localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
            return migrated;
          }
        } catch {
          /* ignore */
        }
      }
      localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
    }

    return defaults;
  } catch {
    return defaults;
  }
}

export function todayDateString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function recordTodayActivity(currentDoneCount) {
  const today = todayDateString();
  const now = new Date().toISOString();
  const last = state.prefs.today;
  const lastTime = last.lastActivity ? new Date(last.lastActivity).getTime() : 0;
  const stale = !lastTime || Date.now() - lastTime > TODAY_INACTIVITY_MS || last.date !== today;

  if (stale) {
    state.prefs.today = { date: today, startCount: currentDoneCount, lastActivity: now };
  } else {
    state.prefs.today = { ...last, lastActivity: now };
  }
  savePrefs();
}

export function todayDelta(currentDoneCount) {
  if (state.prefs.today.date !== todayDateString()) return 0;
  return Math.max(0, currentDoneCount - state.prefs.today.startCount);
}

export function extractCheckRef(line) {
  const match = line.match(/^\s*[-*]\s+\[[\sxX]\]\s+([\d.]+(?:\s*[–-]\s*[\d.]+)?)/);
  return match ? match[1].replace(/\s+/g, '') : '';
}

export function recordSessionTick(checkRef) {
  const last = state.prefs.lastSession;
  const lastTime = last?.time ? new Date(last.time).getTime() : 0;
  const stale = !lastTime || Date.now() - lastTime > TODAY_INACTIVITY_MS;
  const previousTicked = last?.ticked && Array.isArray(last.ticked) ? last.ticked : [];
  const baseTicked = stale ? [] : previousTicked;
  state.prefs.lastSession = {
    time: new Date().toISOString(),
    ticked: checkRef ? [...baseTicked, checkRef] : baseTicked,
  };
  savePrefs();
}

export function savePrefs() {
  if (!state.filePath) return;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    let all;
    try {
      all = raw ? JSON.parse(raw) : {};
    } catch {
      all = {};
    }
    if (!all || typeof all !== 'object') all = {};
    all[state.filePath] = state.prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

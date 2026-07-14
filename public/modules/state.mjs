// Shared mutable app state and cached DOM element references.
//
// This is the one module every UI module imports for the live `state` object
// and the `elements` handle cache. Keeping it at the bottom of the import graph
// (it imports only the pure prefs defaults) is what lets the feature modules
// stay a clean DAG — nobody has to import back into app.js to reach shared
// state.
//
// Browser-only: `elements` runs document.querySelector at module-eval time, so
// this is never imported by the Node test runner. app.js is loaded as a
// deferred ES module at the end of <body>, so the DOM is parsed by the time
// these queries run.

import { defaultPrefs } from '../lib/prefs.mjs';
import { DEFAULT_AVOID_ABOVE_STEPS } from '../lib/plan-health.mjs';

export const state = {
  activeStepId: null,
  baseHash: '',
  capabilities: {
    automate: false,
    away: false,
    companion: false,
    defaultRunner: '',
    fileDeletionMode: 'permanent',
    lessons: false,
    runners: [],
  },
  dirty: false,
  editingCodeKey: null,
  editingValue: '',
  expandedCodeKeys: new Set(),
  filePath: '',
  lastModified: '',
  lastPhaseSnapshot: null,
  lastSaveError: '',
  markdown: '',
  planHealthAvoidAboveSteps: DEFAULT_AVOID_ABOVE_STEPS,
  phaseBannerTimer: null,
  prefs: defaultPrefs(),
  resumeCardTimer: null,
  reviewTemplates: { step: null, phase: null },
  saveStatus: 'idle',
  serverBacked: true,
  stepCheckMap: new Map(),
  stepSections: [],
  libraryParkedExpanded: false,
  libraryCompleteExpanded: false,
  // Hydrated from localStorage in app.js initialize() (kept out of here so this
  // module stays free of storage access).
  libraryExpandedCollections: new Set(),
  libraryDragCampaignId: '',
  libraryCampaigns: [],
  // Per-stack metadata from the registry: { [collectionId]: { name } }.
  libraryCollections: {},
  libraryFilter: '',
  id: '',
  homeDir: '',
};

export const elements = {
  conflictModal: document.querySelector('#conflict-modal'),
  document: document.querySelector('#document'),
  documentPath: document.querySelector('#document-path'),
  documentTitle: document.querySelector('#document-title'),
  companionButton: document.querySelector('#companion-button'),
  exportButton: document.querySelector('#export-button'),
  fileInput: document.querySelector('#file-input'),
  focusButton: document.querySelector('#focus-button'),
  homeButton: document.querySelector('#home-button'),
  mobileBottombar: document.querySelector('#mobile-bottombar'),
  openFileButton: document.querySelector('#open-file-button'),
  overviewActiveIndicator: document.querySelector('#overview-active-indicator'),
  phaseBanner: document.querySelector('#phase-banner'),
  progressFill: document.querySelector('#progress-fill'),
  progressLabel: document.querySelector('#progress-label'),
  resumeButton: document.querySelector('#resume-button'),
  resumeCard: document.querySelector('#resume-card'),
  resumePreview: document.querySelector('#resume-preview'),
  saveButton: document.querySelector('#save-button'),
  saveStatus: document.querySelector('#save-status'),
  saveStatusInline: document.querySelector('#save-status-inline'),
  switchButton: document.querySelector('#switch-button'),
  switchMenu: document.querySelector('#switch-menu'),
  library: document.querySelector('#library'),
  libraryLessons: document.querySelector('#library-lessons'),
  libraryGrid: document.querySelector('#library-grid'),
  libraryEmpty: document.querySelector('#library-empty'),
  libraryFilter: document.querySelector('#library-filter'),
  libraryFilterCount: document.querySelector('#library-filter-count'),
  toast: document.querySelector('#toast'),
};

/* ------------------------------ Automation runtime state --------------------------- */
// The live automation snapshot the polling loop writes and the library, drawer,
// and completion effects all read, plus the pure predicates that classify a
// per-campaign automation payload. Kept here (below every feature module) so
// none of those readers has to import from another feature module.

export const automateState = {
  bulk: {},
  current: null,
  libraryTimer: null,
  campaignTimer: null,
  elapsedTimer: null,
};

export const AUTOMATE_ATTENTION_STATUSES = new Set([
  'stalled',
  'halted',
  'failed',
  'blocked',
  'awaiting_human_review',
  'cap_reached',
  'stopped_by_user',
]);
export const AUTOMATE_SCHEDULED_STATUSES = new Set(['queued', 'scheduled']);

export function automateDisplayStatus(data) {
  if (!data?.status) return null;
  if (data.status === 'active' && data.is_active === false) return 'stalled';
  return data.status;
}

export function isAutomateRunning(data) {
  return automateDisplayStatus(data) === 'active';
}

export function isAutomateAttention(data) {
  const status = automateDisplayStatus(data);
  return AUTOMATE_ATTENTION_STATUSES.has(status);
}

export function isAutomateScheduled(data) {
  const status = automateDisplayStatus(data);
  return AUTOMATE_SCHEDULED_STATUSES.has(status);
}

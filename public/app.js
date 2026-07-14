import { ensureFinalReviewLines, normalizeNewlines } from './lib/parser.mjs';
import { resolveAvoidAboveSteps } from './lib/plan-health.mjs';
import { elements, state } from './modules/state.mjs';
import { applyCampaignLogo, showToast } from './modules/dom.mjs';
import { syncThemeColorMeta } from './modules/effects.mjs';
import {
  fetchCampaignLessons,
  initLibraryFilter,
  initNewCampaign,
  loadLibraryExpandedCollections,
  renderLibrary,
} from './modules/library.mjs';
import { initSwitcher } from './modules/switcher.mjs';
import { loadPrefs } from './modules/prefs-store.mjs';
import { initSettings } from './modules/settings.mjs';
import {
  fetchCampaignAutomateState,
  initAutomateDrawer,
  openAutomateDrawer,
  startAutomatePolling,
  toggleAutomateDrawer,
} from './modules/automate-drawer.mjs';
import { jumpToAnchor, neighbouringSteps, render, toggleFocusMode } from './modules/render.mjs';
import {
  exportMarkdown,
  handleDocumentClick,
  handleDocumentInput,
  jumpToResume,
  openLocalFile,
  saveToServer,
  scheduleAutoSave,
  showResumeCardIfNeeded,
} from './modules/board.mjs';
import { fetchCampaignEstimate, initCampaignEstimate } from './modules/estimate-ui.mjs';

const WORKFLOWS_V2_ASSET_VERSION = '2026-06-22-dedupe';

initialize();

async function initialize() {
  await updatePersonalLayerAvailability();
  bindGlobalActions();
  initNewCampaign();
  state.libraryExpandedCollections = loadLibraryExpandedCollections();

  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'workflows' || view === 'workflows-v2') {
    const hasWorkflows = await updateWorkflowsAvailability();
    if (!hasWorkflows) {
      document.body.classList.add('view-workflows-v2');
      const host = document.querySelector('#workflows-v2');
      const empty = document.querySelector('#workflows-empty');
      if (host) host.hidden = false;
      if (empty) empty.hidden = false;
      return;
    }
    // The Workflows view is a full-bleed, self-contained module with its own render;
    // the campaign app renders nothing behind it. Wired to GET /api/workflows and
    // draws each map in the DëvSec flowchart style (Mermaid converted live by
    // workflow-chart.js). Lazy-loaded so its bundle never costs the other views.
    // `workflows-v2` stays as an alias so existing links/bookmarks still resolve.
    document.body.classList.add('view-workflows-v2');
    const host = document.querySelector('#workflows-v2');
    if (host) {
      host.hidden = false;
      try {
        const { renderWorkflowsV2 } = await import(`/workflows-v2.js?v=${WORKFLOWS_V2_ASSET_VERSION}`);
        renderWorkflowsV2(host);
      } catch (error) {
        host.textContent = 'Could not load Workflows.';
        console.error('workflows: failed to load', error);
      }
    }
    return;
  }
  if (params.has('library')) {
    await updateWorkflowsAvailability();
    initLibraryFilter();
    await renderLibrary();
    startAutomatePolling();
    return;
  }

  const id = params.get('id');
  const url = id ? `/api/document?id=${encodeURIComponent(id)}` : '/api/document';

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    showLoadError(error.message);
    return;
  }

  if (!id && response.status === 404) {
    await updateWorkflowsAvailability();
    initLibraryFilter();
    await renderLibrary();
    startAutomatePolling();
    return;
  }

  if (!response.ok) {
    showLoadError('The Campaigns server could not read the markdown file.');
    return;
  }

  const [payload, lessons] = await Promise.all([
    response.json(),
    fetchCampaignLessons(),
  ]);
  state.id = payload.id ?? '';
  state.baseHash = payload.hash;
  state.filePath = payload.filePath;
  state.lastModified = payload.lastModified;
  state.markdown = normalizeNewlines(payload.markdown);
  state.planHealthAvoidAboveSteps = resolveAvoidAboveSteps(lessons);
  state.serverBacked = true;
  state.dirty = false;
  state.saveStatus = 'idle';
  state.prefs = loadPrefs(state.filePath);
  if (state.prefs.focusMode) document.body.classList.add('focus-mode');
  applyCampaignLogo(state.id, Boolean(payload.hasLogo));

  const migrated = ensureFinalReviewLines(state.markdown);
  if (migrated !== state.markdown) {
    state.markdown = migrated;
    state.dirty = true;
    showToast('Added FINAL REVIEW checkboxes to each phase.', 4000);
    scheduleAutoSave();
  }

  render();
  initCampaignEstimate({ save: saveToServer });
  await fetchCampaignEstimate();
  showResumeCardIfNeeded();
  initSwitcher();
  initSettings(payload.app);
  initAutomateDrawer();
  if (params.get('drawer') === 'activity') {
    await fetchCampaignAutomateState();
    openAutomateDrawer();
  }
  startAutomatePolling();
}

async function updateWorkflowsAvailability() {
  let available = false;
  try {
    const response = await fetch('/api/workflows');
    if (response.ok) {
      const payload = await response.json();
      available = Array.isArray(payload.workflows) && payload.workflows.length > 0;
    }
  } catch {
    // Discovery unavailable is equivalent to no maps: keep the optional view gated.
  }

  const tab = document.querySelector('#workflows-tab');
  if (tab) {
    if (available) tab.hidden = false;
    else tab.remove();
  }
  return available;
}

async function updatePersonalLayerAvailability() {
  let personalLayer = {};
  let fileDeletion = {};
  let runnerCatalog = [];
  let defaultRunner = '';
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const capabilitiesUrl = id
      ? `/api/capabilities?id=${encodeURIComponent(id)}`
      : '/api/capabilities';
    const response = await fetch(capabilitiesUrl);
    if (response.ok) {
      const payload = await response.json();
      personalLayer = payload.personalLayer ?? {};
      fileDeletion = payload.fileDeletion ?? {};
      runnerCatalog = Array.isArray(payload.runners) ? payload.runners : [];
      defaultRunner = typeof payload.defaultRunner === 'string' ? payload.defaultRunner : '';
    }
  } catch {
    // Optional integrations stay hidden when capability discovery is unavailable.
  }

  state.capabilities = {
    automate: personalLayer.automate === true,
    away: personalLayer.away === true,
    companion: personalLayer.companion === true,
    defaultRunner,
    fileDeletionMode: fileDeletion.mode === 'trash' ? 'trash' : 'permanent',
    lessons: personalLayer.lessons === true,
    runners: runnerCatalog,
  };

  if (elements.companionButton) {
    elements.companionButton.hidden = !state.capabilities.companion;
  }
  const automateToggle = document.querySelector('#automate-drawer-toggle');
  if (automateToggle) automateToggle.hidden = !state.capabilities.automate;
  const awayAll = document.querySelector('#away-all-button');
  if (awayAll) awayAll.hidden = !state.capabilities.away;
  if (elements.libraryLessons && !state.capabilities.lessons) {
    elements.libraryLessons.hidden = true;
  }
}

function showLoadError(message) {
  state.serverBacked = false;
  state.markdown = '# Could not load file\n\nCheck the path and restart with `--file <path>`.';
  state.filePath = '';
  state.dirty = false;
  render();
  showToast(message);
}

function bindGlobalActions() {
  elements.saveButton.addEventListener('click', () => saveToServer({ manual: true }));
  elements.exportButton.addEventListener('click', exportMarkdown);
  if (elements.companionButton) elements.companionButton.addEventListener('click', launchCompanion);
  elements.openFileButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', openLocalFile);
  elements.focusButton.addEventListener('click', toggleFocusMode);
  elements.resumeButton.addEventListener('click', jumpToResume);
  elements.document.addEventListener('click', handleDocumentClick);
  elements.document.addEventListener('input', handleDocumentInput);

  window.addEventListener('keydown', handleGlobalKeydown);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColorMeta);
}

function handleGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    saveToServer({ manual: true });
    return;
  }

  if (
    state.capabilities.automate &&
    (event.metaKey || event.ctrlKey) &&
    (event.key === '\\' || event.key === '/')
  ) {
    const target = event.target;
    const isTyping =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (isTyping) return;
    const isLibrary = document.body.classList.contains('view-library');
    if (isLibrary) return;
    event.preventDefault();
    toggleAutomateDrawer();
    return;
  }

  // Skip step-nav shortcuts when the user is typing in inputs / textareas / contenteditable.
  const target = event.target;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  if (isTyping) return;

  // Don't interfere when modifier keys are held.
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (
    event.key === '/' &&
    document.body.classList.contains('view-library') &&
    elements.libraryFilter &&
    !elements.libraryFilter.hidden
  ) {
    event.preventDefault();
    elements.libraryFilter.focus();
    elements.libraryFilter.select();
    return;
  }

  if (event.key === 'Escape' && state.prefs.focusMode) {
    event.preventDefault();
    toggleFocusMode();
    return;
  }

  const goPrev = event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A';
  const goNext = event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D';

  if (goPrev || goNext) {
    const { prev, next } = neighbouringSteps();
    const stepTarget = goPrev ? prev : next;
    if (stepTarget) {
      event.preventDefault();
      jumpToAnchor(stepTarget.anchorId);
    }
  }
}

function launchCompanion() {
  // Step 3.1 native bridge hook: if a native wrapper exposes campaignCompanion.open(),
  // delegate to it so it can present a sticky NSPanel instead of a browser popup.
  if (typeof window.campaignCompanion?.open === 'function') {
    window.campaignCompanion.open();
    return;
  }
  const popup = window.open(
    '/companion',
    'campaign-companion',
    'width=360,height=520,menubar=no,toolbar=no,location=no,status=no,resizable=yes',
  );
  if (!popup) {
    showToast('Popup blocked — allow popups for this site or open /companion in a new tab.');
  }
}

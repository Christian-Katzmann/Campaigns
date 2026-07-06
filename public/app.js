import {
  classifyPhases,
  ensureFinalReviewLines,
  extractFinalReview,
  extractPhases,
  extractStepSections,
  findCampaignFinalReviewCheck,
  findCheckLinkTarget,
  findResumeTarget,
  getLines,
  getProgressStats,
  groupChecklistByPhase,
  isNewShapeCampaign,
  linkChecksToPhaseReviews,
  linkChecksToSteps,
  normalizeNewlines,
  parseMarkdown,
  phaseDescriptiveTitle,
  stripFinalReviewBlocks,
  stripStepMetaBlocks,
  wrapDocSections,
  wrapSteps,
} from './lib/parser.mjs';
import {
  applyStandardCampaignSettings,
  defaultPrefs,
  normalizeTheme,
  sanitizePrefs,
} from './lib/prefs.mjs';
import {
  AUTOMATE_ATTENTION_STATUSES,
  AUTOMATE_SCHEDULED_STATUSES,
  automateDisplayStatus,
  automateState,
  elements,
  isAutomateAttention,
  isAutomateRunning,
  isAutomateScheduled,
  state,
} from './modules/state.mjs';
import {
  applyCampaignLogo,
  copyCampaignPath,
  copyIconTemplate,
  cssEscape,
  element,
  fileNameFromPath,
  formatTime,
  inlineMarkdown,
  showToast,
  splitParagraphs,
  trapDialogFocus,
} from './modules/dom.mjs';
import {
  applyTheme,
  detectPhaseCompletions,
  handleCompletionEffects,
  NTFY_TOPIC_REGEX,
  playAudioFeedback,
  postRemoteNotification,
  syncThemeColorMeta,
} from './modules/effects.mjs';
import {
  awayActiveIdsIn,
  awayBestFitHint,
  awayCurrentCampaignTitle,
  awayEntryButton,
  awayHumanizeId,
  estimateAutomateWait,
  openAwayMode,
  updateAwayAllButton,
} from './modules/away.mjs';
import {
  automateIndicator,
  formatAutomateUnitLabel,
  initLibraryFilter,
  isComplete,
  loadLibraryExpandedCollections,
  relativeHomePath,
  renderLibrary,
  sortCampaigns,
  updateLibraryDots,
} from './modules/library.mjs';
import { initSwitcher } from './modules/switcher.mjs';
import {
  extractCheckRef,
  loadPrefs,
  recordSessionTick,
  recordTodayActivity,
  savePrefs,
  todayDelta,
} from './modules/prefs-store.mjs';
import { initSettings } from './modules/settings.mjs';
import {
  initAutomateDrawer,
  startAutomatePolling,
  toggleAutomateDrawer,
} from './modules/automate-drawer.mjs';
import {
  applyFilterClasses,
  buildReviewPromptText,
  codeKey,
  jumpToAnchor,
  neighbouringSteps,
  nextUncheckedStep,
  render,
  substitutePlaceholders,
  toggleFocusMode,
  togglePhase,
  updateSaveStatus,
} from './modules/render.mjs';

const AUTOSAVE_DELAY_MS = 700;
const WORKFLOWS_V2_ASSET_VERSION = '2026-06-22-dedupe';


let autoSaveTimer = null;

initialize();

async function initialize() {
  bindGlobalActions();
  state.libraryExpandedCollections = loadLibraryExpandedCollections();

  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'workflows' || view === 'workflows-v2') {
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
    initLibraryFilter();
    await renderLibrary();
    startAutomatePolling();
    return;
  }

  if (!response.ok) {
    showLoadError('The Campaigns server could not read the markdown file.');
    return;
  }

  const payload = await response.json();
  state.id = payload.id ?? '';
  state.baseHash = payload.hash;
  state.filePath = payload.filePath;
  state.lastModified = payload.lastModified;
  state.markdown = normalizeNewlines(payload.markdown);
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
  showResumeCardIfNeeded();
  initSwitcher();
  initSettings();
  initAutomateDrawer();
  startAutomatePolling();
}

function showLoadError(message) {
  state.serverBacked = false;
  state.markdown = '# Could not load file\n\nCheck the path and restart with `--file <path>`.';
  state.filePath = '';
  state.dirty = false;
  render();
  showToast(message);
}

function documentUrl() {
  return state.id ? `/api/document?id=${encodeURIComponent(state.id)}` : '/api/document';
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

  if ((event.metaKey || event.ctrlKey) && (event.key === '\\' || event.key === '/')) {
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

function handleDocumentClick(event) {
  const chip = event.target.closest('.filter-chip');
  if (chip) {
    const key = chip.dataset.filterKey;
    state.prefs.filters[key] = !state.prefs.filters[key];
    savePrefs();
    chip.setAttribute('aria-pressed', String(state.prefs.filters[key]));
    applyFilterClasses();
    return;
  }

  const control = event.target.closest('[data-action]');

  if (!control) {
    return;
  }

  const { action } = control.dataset;

  if (action === 'jump-to-step') {
    event.preventDefault();
    document.getElementById(control.dataset.stepId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    return;
  }

  if (action === 'toggle-phase') {
    togglePhase(control.dataset.phaseId);
    return;
  }

  if (action === 'toggle-line-check') {
    toggleLineCheck(Number(control.dataset.line));
  }

  if (action === 'toggle-glyph-check') {
    toggleGlyphCheck(Number(control.dataset.line), Number(control.dataset.char));
  }

  if (action === 'copy-code') {
    copyCode(control.dataset.key);
  }

  if (action === 'copy-document-path') {
    event.preventDefault();
    copyDocumentPath();
    return;
  }

  if (action === 'copy-review-card') {
    const card = control.closest('.prompt-review');
    if (!card) return;
    copyReviewPrompt(card);
    return;
  }

  if (action === 'edit-review-template') {
    const mode = control.dataset.templateMode;
    const tpl = mode === 'phase' ? state.reviewTemplates.phase : state.reviewTemplates.step;
    if (!tpl?.key) {
      showToast('No review template found in this campaign.');
      return;
    }
    startCodeEdit(tpl.key);
    requestAnimationFrame(() => {
      document.querySelector('.prompt-card-editing')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    return;
  }

  if (action === 'complete-and-next') {
    toggleLineCheck(Number(control.dataset.line));
    const next = nextUncheckedStep(control.dataset.stepId);
    if (next) {
      jumpToAnchor(next.anchorId);
    } else {
      showToast('All later steps are complete.');
    }
  }

  if (action === 'complete-phase') {
    const phaseNumber = control.dataset.phaseNumber;
    toggleLineCheck(Number(control.dataset.line));
    const nextPhaseNumber = String(Number(phaseNumber) + 1);
    requestAnimationFrame(() => {
      const nextHeader = document.querySelector(
        `.phase-header[data-phase-number="${cssEscape(nextPhaseNumber)}"]`,
      );
      if (nextHeader) {
        nextHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        showToast('Campaign complete.');
      }
    });
  }

  if (action === 'close-campaign') {
    toggleLineCheck(Number(control.dataset.line));
    showToast('Campaign complete.');
  }

  if (action === 'edit-code') {
    startCodeEdit(control.dataset.key);
  }

  if (action === 'save-code-edit') {
    saveCodeEdit(control.dataset.key);
  }

  if (action === 'cancel-code-edit') {
    state.editingCodeKey = null;
    state.editingValue = '';
    render();
  }
}

function handleDocumentInput(event) {
  const control = event.target.closest("[data-action='edit-code-input']");

  if (control) {
    state.editingValue = control.value;
  }
}

function toggleLineCheck(lineIndex) {
  const lines = getLines(state.markdown);
  const line = lines[lineIndex];
  const wasChecked = /^\s*[-*]\s+\[\s*[xX]\s*\]/.test(line);
  const nextLine = line.replace(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)/, (_, before, marker, after) => {
    return `${before}${marker.toLowerCase() === 'x' ? ' ' : 'x'}${after}`;
  });

  if (nextLine !== line) {
    if (!wasChecked) {
      playAudioFeedback('tick');
    }

    const prevBlocks = parseMarkdown(state.markdown);
    const prevPhases = classifyPhases(extractPhases(prevBlocks));
    const prevStats = getProgressStats(prevBlocks);

    lines[lineIndex] = nextLine;
    recordSessionTick(!wasChecked ? extractCheckRef(nextLine) : '');
    setMarkdown(lines.join('\n'));

    const nextBlocks = parseMarkdown(state.markdown);
    const nextPhases = classifyPhases(extractPhases(nextBlocks));
    const nextStats = getProgressStats(nextBlocks);

    handleCompletionEffects(prevPhases, nextPhases, prevStats, nextStats);
  }
}

function toggleGlyphCheck(lineIndex, charIndex) {
  const lines = getLines(state.markdown);
  const line = lines[lineIndex] ?? '';
  const current = line[charIndex];

  if (current !== '☐' && current !== '☑') {
    return;
  }

  const isChecking = current === '☐';
  if (isChecking) {
    playAudioFeedback('tick');
  }

  const prevBlocks = parseMarkdown(state.markdown);
  const prevPhases = classifyPhases(extractPhases(prevBlocks));
  const prevStats = getProgressStats(prevBlocks);

  lines[lineIndex] =
    `${line.slice(0, charIndex)}${current === '☑' ? '☐' : '☑'}${line.slice(charIndex + 1)}`;
  recordSessionTick('');
  setMarkdown(lines.join('\n'));

  const nextBlocks = parseMarkdown(state.markdown);
  const nextPhases = classifyPhases(extractPhases(nextBlocks));
  const nextStats = getProgressStats(nextBlocks);

  handleCompletionEffects(prevPhases, nextPhases, prevStats, nextStats);
}

async function copyCode(key) {
  const block = findCodeBlock(key);

  if (!block) {
    return;
  }

  const text = substitutePlaceholders(block.content);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Prompt copied.');
  } catch {
    showToast('Copy failed. Select the prompt text manually.');
  }
}

async function copyDocumentPath() {
  await copyCampaignPath(state.filePath);
}

async function copyReviewPrompt(card) {
  const mode = card.dataset.reviewMode;
  const text = buildReviewPromptText(
    mode,
    card.dataset.stepNumber,
    card.dataset.phaseNumber,
  );
  if (!text) {
    showToast('No review template found in this campaign.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const label = mode === 'phase'
      ? `Phase ${card.dataset.phaseNumber} review copied.`
      : `Step ${card.dataset.stepNumber} review copied.`;
    showToast(label);
  } catch {
    showToast('Copy failed. Select the prompt text manually.');
  }
}

function startCodeEdit(key) {
  const block = findCodeBlock(key);

  if (!block) {
    return;
  }

  state.editingCodeKey = key;
  state.editingValue = block.content;
  render();
  document.querySelector(`[data-action="edit-code-input"][data-key="${cssEscape(key)}"]`)?.focus();
}

function saveCodeEdit(key) {
  const block = findCodeBlock(key);

  if (!block) {
    return;
  }

  const lines = getLines(state.markdown);
  const replacement = normalizeNewlines(state.editingValue).split('\n');
  lines.splice(block.lineStart + 1, block.lineEnd - block.lineStart - 1, ...replacement);
  state.editingCodeKey = null;
  state.editingValue = '';
  setMarkdown(lines.join('\n'));
}

function findCodeBlock(key) {
  return parseMarkdown(state.markdown).find(
    (block) => block.type === 'code' && codeKey(block) === key,
  );
}

function setMarkdown(nextMarkdown) {
  state.markdown = nextMarkdown;
  state.dirty = true;
  state.saveStatus = 'idle';
  render();
  scheduleAutoSave();
}

function scheduleAutoSave() {
  if (!state.serverBacked) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    saveToServer({ silent: true });
  }, AUTOSAVE_DELAY_MS);
}

async function saveToServer(options = {}) {
  if (!state.serverBacked) {
    if (options.manual) {
      showToast('This document was opened from your browser. Use Export instead.');
    }
    return;
  }
  if (!state.dirty && !options.manual && !options.force) return;

  state.saveStatus = 'saving';
  updateSaveStatus();

  try {
    const body = { markdown: state.markdown };
    if (!options.force) body.baseHash = state.baseHash;

    const response = await fetch(documentUrl(), {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    const payload = await response.json();

    if (response.status === 409) {
      // Fetch the current on-disk version and present a merge UI.
      const fresh = await fetch(documentUrl());
      const freshPayload = await fresh.json().catch(() => ({}));
      state.saveStatus = 'idle';
      updateSaveStatus();
      showConflictModal({
        localMarkdown: state.markdown,
        serverMarkdown: typeof freshPayload.markdown === 'string' ? freshPayload.markdown : '',
      });
      return;
    }

    if (!response.ok) {
      throw new Error(payload.error ?? 'Could not save markdown.');
    }

    state.baseHash = payload.hash;
    state.lastModified = payload.lastModified;
    state.dirty = false;
    state.saveStatus = 'idle';
    state.lastSaveError = '';
    updateSaveStatus();
    if (options.manual) showToast('Saved.');
  } catch (error) {
    state.saveStatus = 'error';
    state.lastSaveError = error.message;
    updateSaveStatus();
    if (options.manual || !options.silent) {
      showToast(error.message);
    }
  }
}

function exportMarkdown() {
  const blob = new Blob([state.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = element('a', {
    download: fileNameFromPath(state.filePath) || 'plan.md',
    href: url,
  });

  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function openLocalFile(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.addEventListener('load', () => {
    state.baseHash = '';
    state.filePath = file.name;
    state.lastModified = '';
    state.markdown = normalizeNewlines(String(reader.result ?? ''));
    state.serverBacked = false;
    state.dirty = false;
    state.editingCodeKey = null;
    state.prefs = loadPrefs(state.filePath);
    render();
  });
  reader.readAsText(file);
  event.target.value = '';
}


/* ------------------------------ Conflict (merge) modal ------------------------------ */

function showConflictModal({ localMarkdown, serverMarkdown }) {
  if (!elements.conflictModal) return;

  const card = element('div', { className: 'conflict-card' });
  card.append(
    element('h2', { text: 'The file changed on disk' }),
    element('p', {
      text: 'The markdown file changed since this page loaded. Choose which version to keep, or merge by hand.',
    }),
  );

  const diff = element('div', { className: 'conflict-diff' });

  const yoursLabel = element('label', { text: 'YOURS (in this tab)' });
  const yoursTextarea = document.createElement('textarea');
  yoursTextarea.value = localMarkdown;
  yoursLabel.append(yoursTextarea);

  const theirsLabel = element('label', { text: 'ON DISK' });
  const theirsTextarea = document.createElement('textarea');
  theirsTextarea.value = serverMarkdown;
  theirsTextarea.readOnly = true;
  theirsLabel.append(theirsTextarea);

  diff.append(yoursLabel, theirsLabel);
  card.append(diff);

  const actions = element('div', { className: 'conflict-actions' });

  const cancel = element('button', {
    className: 'button button-quiet',
    text: 'Cancel',
    type: 'button',
  });
  cancel.addEventListener('click', hideConflictModal);

  const keepTheirs = element('button', {
    className: 'button button-quiet',
    text: 'Keep on-disk version',
    type: 'button',
  });
  keepTheirs.addEventListener('click', () => {
    state.markdown = normalizeNewlines(serverMarkdown);
    state.dirty = false;
    state.baseHash = '';
    hideConflictModal();
    render();
    // Re-fetch hash so subsequent saves work cleanly.
    refreshBaseline();
  });

  const keepMine = element('button', {
    className: 'button button-primary',
    text: 'Keep my version',
    type: 'button',
  });
  keepMine.addEventListener('click', async () => {
    const merged = yoursTextarea.value;
    state.markdown = normalizeNewlines(merged);
    state.baseHash = '';
    hideConflictModal();
    await saveToServer({ manual: true, force: true });
    render();
  });

  actions.append(cancel, keepTheirs, keepMine);
  card.append(actions);

  elements.conflictModal.replaceChildren(card);
  elements.conflictModal.hidden = false;
}

function hideConflictModal() {
  if (!elements.conflictModal) return;
  elements.conflictModal.hidden = true;
  elements.conflictModal.replaceChildren();
}

async function refreshBaseline() {
  try {
    const response = await fetch(documentUrl());
    if (!response.ok) return;
    const payload = await response.json();
    state.baseHash = payload.hash;
    state.lastModified = payload.lastModified;
    updateSaveStatus();
  } catch {
    /* ignore */
  }
}

function jumpToResume() {
  const targetId = elements.resumeButton.dataset.targetId;
  if (targetId) {
    document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const first = elements.document.querySelector('.check-row:not(.done), .glyph-check:not(.done)');
  if (!first) {
    showToast('Everything visible is checked off.');
    return;
  }
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ------------------------------ Resume card on cold load ---------------------------- */

const RESUME_CARD_GAP_MS = 30 * 60 * 1000;
const RESUME_CARD_AUTODISMISS_MS = 8000;

function showResumeCardIfNeeded() {
  if (!elements.resumeCard) return;
  const session = state.prefs.lastSession;
  if (!session?.time || !session.ticked?.length) return;

  const ageMs = Date.now() - new Date(session.time).getTime();
  if (Number.isNaN(ageMs) || ageMs < RESUME_CARD_GAP_MS) return;

  const ticked = session.ticked;
  const tickedRange =
    ticked.length === 1
      ? `ticked ${ticked[0]}`
      : `ticked ${ticked[0]} → ${ticked[ticked.length - 1]}`;

  const blocks = parseMarkdown(state.markdown);
  const resume = findResumeTarget(blocks, state.stepSections);
  const nextUp = resume ? (resume.step ? resume.step.title : resume.checkText) : '';

  const text = element('span', { className: 'resume-card-text' });
  text.append(element('strong', { text: `Last session: ${tickedRange}.` }));
  if (nextUp) text.append(document.createTextNode(` Next up: ${nextUp}.`));

  const children = [text];
  if (resume?.targetId) {
    const button = element('button', {
      className: 'button button-primary',
      text: 'Resume',
      type: 'button',
    });
    button.addEventListener('click', () => {
      hideResumeCard();
      jumpToAnchor(resume.targetId);
    });
    children.push(button);
  }

  elements.resumeCard.replaceChildren(...children);
  elements.resumeCard.hidden = false;

  const dismiss = () => {
    hideResumeCard();
    window.removeEventListener('scroll', dismiss);
  };
  state.resumeCardTimer = window.setTimeout(dismiss, RESUME_CARD_AUTODISMISS_MS);
  window.addEventListener('scroll', dismiss, { once: true, passive: true });
}

function hideResumeCard() {
  if (!elements.resumeCard) return;
  elements.resumeCard.hidden = true;
  elements.resumeCard.replaceChildren();
  if (state.resumeCardTimer) {
    clearTimeout(state.resumeCardTimer);
    state.resumeCardTimer = null;
  }
}

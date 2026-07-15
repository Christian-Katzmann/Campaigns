// Board interactions and document IO: the click/input dispatch, the check and
// glyph toggles, prompt/code copy + inline edit, autosave and the manual save to
// disk (with the baseHash conflict flow and its merge modal), export, open-a-file,
// and the resume card. It drives re-renders and reads/writes prefs through the
// lower modules, but nothing imports it except app.js, which wires its handlers.

import { elements, state } from './state.mjs';
import {
  applyFilterClasses,
  buildReviewPromptText,
  codeKey,
  jumpToAnchor,
  nextUncheckedStep,
  render,
  substitutePlaceholders,
  togglePhase,
  updateSaveStatus,
} from './render.mjs';
import {
  copyCampaignPath,
  cssEscape,
  element,
  fileNameFromPath,
  manageDialogFocus,
  showToast,
} from './dom.mjs';
import {
  classifyPhases,
  extractPhases,
  findResumeTarget,
  formatModelValue,
  getLines,
  getProgressStats,
  parseMarkdown,
  parseModelSegment,
  replaceFencedBlockContent,
  replaceStepModelValue,
} from '../lib/parser.mjs';
import { extractCheckRef, loadPrefs, recordSessionTick, savePrefs } from './prefs-store.mjs';
import { handleCompletionEffects, playAudioFeedback } from './effects.mjs';

const AUTOSAVE_DELAY_MS = 700;
let autoSaveTimer = null;
let conflictDialogClose = null;

function documentUrl() {
  return state.id ? `/api/document?id=${encodeURIComponent(state.id)}` : '/api/document';
}

export function handleDocumentClick(event) {
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

  if (action === 'edit-step-model') {
    openStepModelPicker(control.dataset.stepNumber);
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

export function handleDocumentInput(event) {
  const control = event.target.closest("[data-action='edit-code-input']");

  if (control) {
    state.editingValue = control.value;
  }
}

export function openStepModelPicker(stepNumber) {
  document.querySelector('#step-model-picker')?.remove();
  const section = state.stepSections.find((candidate) => candidate.number === stepNumber);
  const runners = state.capabilities.runners;
  if (!section?.model || runners.length === 0) {
    showToast('Runner options are unavailable.');
    return;
  }

  const currentPrimary = section.model.primary ?? section.model.claudeCode ?? '';
  const currentAlternate = section.model.alternate ?? section.model.codex ?? '';
  const primaryMatch = matchCatalogSegment(currentPrimary, runners);
  let runnerId = primaryMatch?.runner.id
    ?? state.capabilities.defaultRunner
    ?? runners[0]?.id;

  const overlay = element('div', { className: 'model-picker-modal', id: 'step-model-picker' });
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'step-model-picker-title');
  const card = element('div', { className: 'model-picker-card' });
  const title = element('h3', {
    className: 'model-picker-title',
    id: 'step-model-picker-title',
    text: `Step ${stepNumber} model`,
  });
  const form = element('div', { className: 'model-picker-fields' });
  const runnerSelect = document.createElement('select');
  const modelSelect = document.createElement('select');
  const effortSelect = document.createElement('select');
  const availability = element('p', { className: 'model-picker-hint' });
  const save = element('button', {
    className: 'button button-primary',
    text: 'Use this model',
    type: 'button',
  });
  const cancel = element('button', {
    className: 'button button-quiet',
    text: 'Cancel',
    type: 'button',
  });

  for (const runner of runners) {
    const option = document.createElement('option');
    option.value = runner.id;
    option.textContent = runner.available ? runner.label : `${runner.label} — unavailable`;
    option.disabled = !runner.available;
    option.title = runner.availabilityHint || '';
    runnerSelect.append(option);
  }

  function selectedRunner() {
    return runners.find((runner) => runner.id === runnerId) ?? runners[0];
  }

  function fillDependentSelects(preserveCurrent = false) {
    const runner = selectedRunner();
    modelSelect.replaceChildren();
    effortSelect.replaceChildren();
    for (const model of runner.models ?? []) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      modelSelect.append(option);
    }
    for (const effort of runner.efforts ?? []) {
      const option = document.createElement('option');
      option.value = effort.id;
      option.textContent = effort.label;
      effortSelect.append(option);
    }
    const matched = preserveCurrent && primaryMatch?.runner.id === runner.id ? primaryMatch : null;
    modelSelect.value = matched?.model.id ?? runner.defaults?.model ?? runner.models?.[0]?.id ?? '';
    effortSelect.value = matched?.effort?.id ?? runner.defaults?.effort ?? runner.efforts?.[0]?.id ?? '';
    availability.textContent = runner.available ? '' : runner.availabilityHint;
    save.disabled = !runner.available;
  }

  runnerSelect.value = runnerId;
  if (!runnerSelect.value) {
    runnerId = runners.find((runner) => runner.available)?.id ?? runners[0]?.id;
    runnerSelect.value = runnerId;
  }
  fillDependentSelects(true);
  runnerSelect.addEventListener('change', () => {
    runnerId = runnerSelect.value;
    fillDependentSelects(false);
  });

  let close = () => overlay.remove();
  cancel.addEventListener('click', () => close());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  save.addEventListener('click', async () => {
    const runner = selectedRunner();
    const model = runner.models.find((candidate) => candidate.id === modelSelect.value);
    const effort = runner.efforts.find((candidate) => candidate.id === effortSelect.value);
    if (!runner.available || !model || !effort) return;
    const primary = `${model.label} · ${effort.label}`;
    const alternate = runner.id === primaryMatch?.runner.id ? currentAlternate : currentPrimary;
    const nextValue = formatModelValue(primary, alternate === primary ? '' : alternate);
    setMarkdown(replaceStepModelValue(state.markdown, stepNumber, nextValue));
    close();
    await saveToServer();
  });

  form.append(
    pickerField('Runner', runnerSelect),
    pickerField('Model', modelSelect),
    pickerField('Effort', effortSelect),
  );
  const actions = element('div', { className: 'model-picker-actions' });
  actions.append(cancel, save);
  card.append(title, form, availability, actions);
  overlay.append(card);
  document.body.append(overlay);
  close = manageDialogFocus(overlay, { initialFocus: runnerSelect });
}

function pickerField(label, select) {
  const field = element('label', { className: 'model-picker-field' });
  field.append(element('span', { text: label }), select);
  return field;
}

function matchCatalogSegment(segment, runners) {
  const parsed = parseModelSegment(segment);
  if (!parsed) return null;
  const modelKey = parsed.model.trim().toLowerCase();
  for (const runner of runners) {
    const model = runner.models?.find((candidate) => (
      candidate.id.trim().toLowerCase() === modelKey
      || candidate.label.trim().toLowerCase() === modelKey
    ));
    if (!model) continue;
    const effortKey = parsed.effort.trim().toLowerCase().replace(/\s+/g, '-');
    const effort = runner.efforts?.find((candidate) => (
      candidate.id.toLowerCase() === effortKey
      || candidate.label.toLowerCase().replace(/\s+/g, '-') === effortKey
    )) ?? null;
    return { runner, model, effort };
  }
  return null;
}

export function toggleLineCheck(lineIndex) {
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

export function toggleGlyphCheck(lineIndex, charIndex) {
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

export async function copyCode(key) {
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

export async function copyDocumentPath() {
  await copyCampaignPath(state.filePath);
}

export async function copyReviewPrompt(card) {
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

export function startCodeEdit(key) {
  const block = findCodeBlock(key);

  if (!block) {
    return;
  }

  state.editingCodeKey = key;
  state.editingValue = block.content;
  render();
  document.querySelector(`[data-action="edit-code-input"][data-key="${cssEscape(key)}"]`)?.focus();
}

export function saveCodeEdit(key) {
  const block = findCodeBlock(key);

  if (!block) {
    return;
  }

  const nextMarkdown = replaceFencedBlockContent(state.markdown, block, state.editingValue);
  state.editingCodeKey = null;
  state.editingValue = '';
  setMarkdown(nextMarkdown);
}

export function findCodeBlock(key) {
  return parseMarkdown(state.markdown).find(
    (block) => block.type === 'code' && codeKey(block) === key,
  );
}

export function setMarkdown(nextMarkdown) {
  state.markdown = nextMarkdown;
  state.dirty = true;
  state.saveStatus = 'idle';
  render();
  scheduleAutoSave();
}

export function scheduleAutoSave() {
  if (!state.serverBacked) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    saveToServer({ silent: true });
  }, AUTOSAVE_DELAY_MS);
}

export async function saveToServer(options = {}) {
  if (!state.serverBacked) {
    if (options.manual) {
      showToast('This document was opened from your browser. Use Export instead.');
    }
    return;
  }
  if (!state.dirty && !options.manual && !options.force) return;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }

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
    window.dispatchEvent(new CustomEvent('campaign:saved'));
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

export function exportMarkdown() {
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

export function openLocalFile(event) {
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

export function showConflictModal({ localMarkdown, serverMarkdown }) {
  if (!elements.conflictModal) return;

  const card = element('div', { className: 'conflict-card' });
  const heading = element('h2', { id: 'conflict-modal-title', text: 'The file changed on disk' });
  const description = element('p', {
    id: 'conflict-modal-description',
    text: 'The markdown file changed since this page loaded. Choose which version to keep, or merge by hand.',
  });
  card.append(
    heading,
    description,
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

  elements.conflictModal.setAttribute('aria-labelledby', heading.id);
  elements.conflictModal.setAttribute('aria-describedby', description.id);
  elements.conflictModal.replaceChildren(card);
  elements.conflictModal.hidden = false;
  conflictDialogClose = manageDialogFocus(elements.conflictModal, {
    initialFocus: yoursTextarea,
    onClose: () => {
      elements.conflictModal.hidden = true;
      elements.conflictModal.replaceChildren();
      conflictDialogClose = null;
    },
  });
}

export function hideConflictModal() {
  if (!elements.conflictModal) return;
  if (conflictDialogClose) {
    const close = conflictDialogClose;
    conflictDialogClose = null;
    close();
    return;
  }
  elements.conflictModal.hidden = true;
  elements.conflictModal.replaceChildren();
}

export async function refreshBaseline() {
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

export function jumpToResume() {
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

export function showResumeCardIfNeeded() {
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

export function hideResumeCard() {
  if (!elements.resumeCard) return;
  elements.resumeCard.hidden = true;
  elements.resumeCard.replaceChildren();
  if (state.resumeCardTimer) {
    clearTimeout(state.resumeCardTimer);
    state.resumeCardTimer = null;
  }
}

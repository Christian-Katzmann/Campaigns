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
  relativeTime,
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

const AUTOSAVE_DELAY_MS = 700;
const WORKFLOWS_V2_ASSET_VERSION = '2026-06-22-dedupe';

const PLACEHOLDER_REGEX = /<([A-Z][A-Z0-9_]+)>/g;
const RESERVED_TOKENS = new Set(['STEP', 'PHASE']);

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
    if (drawerState.open) closeAutomateDrawer();
    else openAutomateDrawer();
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

function render() {
  applyTheme(state.prefs.theme);
  const blocks = parseMarkdown(state.markdown);
  const phases = classifyPhases(extractPhases(blocks));
  const stepSections = extractStepSections(blocks, state.markdown);
  const stats = getProgressStats(blocks);
  const resume = findResumeTarget(blocks, stepSections);
  const stepCheckMap = linkChecksToSteps(blocks, stepSections);

  state.stepSections = stepSections;
  state.stepCheckMap = stepCheckMap;
  state.reviewTemplates = extractReviewTemplates(blocks);
  state.phaseReviewCheckMap = linkChecksToPhaseReviews(blocks);
  state.finalReview = extractFinalReview(blocks);
  state.campaignFinalReviewCheck = findCampaignFinalReviewCheck(blocks);
  state.isNewShape = isNewShapeCampaign(blocks);
  recordTodayActivity(stats.done);

  detectPhaseCompletions(phases);

  const firstHeading = blocks.find((block) => block.type === 'heading' && block.level === 1);
  const title = firstHeading
    ? firstHeading.text
    : (fileNameFromPath(state.filePath) || 'Campaigns').replace(/\.md$/i, '');
  elements.documentTitle.textContent = title;
  // Lead the tab title with progress so a narrow tab still shows where the
  // campaign stands at a glance.
  const progressPrefix = stats.total > 0 ? `${stats.done}/${stats.total} · ` : '';
  document.title = firstHeading ? `${progressPrefix}${firstHeading.text} · Campaigns` : 'Campaigns';
  elements.documentPath.textContent = state.filePath;
  renderProgressLabel(stats);
  elements.progressFill.style.width =
    stats.total === 0 ? '0%' : `${Math.round((stats.done / stats.total) * 100)}%`;
  elements.saveButton.disabled = !state.serverBacked;
  elements.saveButton.textContent = state.serverBacked ? 'Save file' : 'Save unavailable';

  updateSaveStatus();
  renderResumePreview(resume);
  applyFilterClasses();

  const phaseTitles = new Map();
  for (const phase of phases) {
    if (phase.number) phaseTitles.set(phase.number, phaseDescriptiveTitle(phase.title));
  }
  const stepIdSet = new Set(stepSections.map((section) => section.anchorId));
  // Strip the `## Final review` heading and its prompt code block from inline
  // rendering — the card we append at the end owns that content. Also strip
  // the per-step `Model:` / `Parallel:` source lines: the chips under each
  // step heading own that content (see renderStepGroup).
  const finalReviewStripped = state.isNewShape && state.finalReview
    ? stripFinalReviewBlocks(blocks, state.finalReview)
    : blocks;
  const sourceBlocks = stripStepMetaBlocks(finalReviewStripped, stepSections);
  const withButtons = injectStepButtons(sourceBlocks, stepSections, stepCheckMap, phaseTitles);
  const wrapped = wrapSteps(withButtons, stepIdSet, stepCheckMap);
  const grouped = groupChecklistByPhase(wrapped, phases);
  const sectioned = wrapDocSections(grouped);
  const withPath = injectDocumentPath(sectioned);
  const finalReviewCardBlock = buildFinalReviewCardBlock();
  if (finalReviewCardBlock) withPath.push(finalReviewCardBlock);
  elements.document.replaceChildren(...withPath.map((block) => renderBlock(block, stepSections)));

  applyFocusMode();
  renderMobileBottombar();
  attachStepObserver();
}

function renderProgressLabel(stats) {
  const delta = todayDelta(stats.done);
  elements.progressLabel.textContent = `${stats.done} of ${stats.total} done`;
  if (delta > 0) {
    const chip = element('span', { className: 'today-delta', text: `+${delta} today` });
    elements.progressLabel.append(chip);
  }
}

function renderBlock(block, stepSections) {
  switch (block.type) {
    case 'heading':
      return renderHeading(block);
    case 'paragraph':
      return element('p', { html: inlineMarkdown(block.text) });
    case 'quote':
      return renderQuote(block);
    case 'hr':
      return element('hr');
    case 'check':
      return renderCheckRow(block, stepSections);
    case 'list':
      return renderList(block);
    case 'table':
      return renderTable(block);
    case 'code':
      return renderCodeBlock(block);
    case 'phase-group':
      return renderPhaseGroup(block, stepSections);
    case 'filter-chips':
      return renderFilterChipsInline();
    case 'step-complete':
      return renderStepCompleteButton(block);
    case 'step-review':
      return renderReviewCard({ mode: 'step', stepNumber: block.stepNumber, stepId: block.stepId });
    case 'phase-review':
      return renderReviewCard({ mode: 'phase', phaseNumber: block.phaseNumber });
    case 'final-review-card':
      return renderFinalReviewCard(block);
    case 'phase-header':
      return renderPhaseHeader(block);
    case 'phase-complete':
      return renderPhaseCompleteButton(block);
    case 'step-group':
      return renderStepGroup(block, stepSections);
    case 'doc-section':
      return renderDocSection(block, stepSections);
    case 'work-divider':
      return renderWorkDivider();
    case 'document-path':
      return renderDocumentPath(block);
    default:
      return document.createTextNode('');
  }
}

function renderHeading(block) {
  const tag = `h${Math.min(block.level, 4)}`;
  const attrs = block.level <= 2 ? { id: block.id } : {};
  return element(tag, { ...attrs, html: inlineMarkdown(block.text) });
}

function renderQuote(block) {
  const wrapper = element('blockquote', { className: 'quote' });

  for (const paragraph of splitParagraphs(block.text)) {
    wrapper.append(element('p', { html: inlineMarkdown(paragraph) }));
  }

  return wrapper;
}

function renderCheckRow(block, stepSections) {
  const isFinalReview = /^final\s+review/i.test(block.text);
  const row = element('div', {
    className: `check-row${block.checked ? ' done' : ''}${isFinalReview ? ' check-row-final-review' : ''}`,
    id: block.id,
  });
  const button = element('button', {
    ariaLabel: block.checked ? 'Mark incomplete' : 'Mark complete',
    className: 'check-button',
    dataset: { action: 'toggle-line-check', line: block.lineStart },
    type: 'button',
  });

  const target = stepSections ? findCheckLinkTarget(block.text, stepSections) : null;
  const label = element('div', { className: 'check-label' });
  let labelText = block.text;
  if (isFinalReview) {
    const phaseMatch = block.text.match(/phase\s+(\d+(?:\.\d+)?)/i);
    labelText = phaseMatch ? `FINAL REVIEW — Phase ${phaseMatch[1]}` : 'FINAL REVIEW';
  }

  if (target) {
    const inner = element('a', {
      className: 'step-link',
      dataset: { action: 'jump-to-step', stepId: target.anchorId },
      href: `#${target.anchorId}`,
      html: inlineMarkdown(labelText),
    });
    label.append(inner);
  } else {
    label.innerHTML = inlineMarkdown(labelText);
  }

  row.append(button, label);
  return row;
}

function renderList(block) {
  const list = element(block.ordered ? 'ol' : 'ul', {
    className: block.ordered ? 'ordered-list' : 'plain-list',
  });

  for (const item of block.items) {
    list.append(element('li', { html: inlineMarkdown(item.text) }));
  }

  return list;
}

function renderTable(block) {
  const wrapper = element('div', { className: 'table-wrap' });
  const table = element('table');
  const thead = element('thead');
  const tbody = element('tbody');
  const header = element('tr');

  for (const cell of block.headers) {
    header.append(element('th', { html: inlineMarkdown(cell.content.trim()) }));
  }

  thead.append(header);

  for (const row of block.rows) {
    const tr = element('tr');

    for (const cell of row.cells) {
      const td = element('td');
      const trimmed = cell.content.trim();

      if (trimmed === '☐' || trimmed === '☑') {
        const checked = trimmed === '☑';
        const glyphIndex = cell.content.indexOf(trimmed);
        td.append(
          element('button', {
            ariaLabel: checked ? 'Mark incomplete' : 'Mark complete',
            className: `glyph-check${checked ? ' done' : ''}`,
            dataset: {
              action: 'toggle-glyph-check',
              char: cell.start + glyphIndex,
              line: row.lineIndex,
            },
            type: 'button',
          }),
        );
      } else {
        td.innerHTML = inlineMarkdown(trimmed);
      }

      tr.append(td);
    }

    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function renderCodeBlock(block) {
  const key = codeKey(block);
  const isEditing = state.editingCodeKey === key;
  const reviewMode = detectReviewMode(block.content);
  const isTemplate = reviewMode !== null;

  if (isEditing) {
    const card = element('section', {
      className: `prompt-card prompt-card-editing${isTemplate ? ' prompt-template' : ''}`,
      id: block.id,
    });
    const toolbar = element('div', { className: 'prompt-toolbar' });
    const copyButton = element('button', {
      ariaLabel: 'Copy prompt',
      className: 'icon-button',
      dataset: { action: 'copy-code', key },
      title: 'Copy prompt',
      type: 'button',
    });
    copyButton.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
    toolbar.append(
      copyButton,
      element('button', {
        className: 'text-button',
        dataset: { action: 'save-code-edit', key },
        text: 'Save edit',
        type: 'button',
      }),
      element('button', {
        className: 'text-button',
        dataset: { action: 'cancel-code-edit' },
        text: 'Cancel',
        type: 'button',
      }),
    );
    const editor = element('textarea', {
      className: 'prompt-editor',
      dataset: { action: 'edit-code-input', key },
    });
    editor.value = state.editingValue;
    card.append(toolbar, editor);
    return card;
  }

  const card = element('details', {
    className: `prompt-card${isTemplate ? ' prompt-template' : ''}`,
    id: block.id,
  });
  card.dataset.codeKey = key;
  if (state.expandedCodeKeys.has(key)) {
    card.open = true;
  }

  const summary = element('summary', { className: 'prompt-summary' });
  summary.append(element('span', { className: 'prompt-chevron', ariaHidden: 'true', text: '›' }));

  let label;
  if (isTemplate) {
    label = reviewMode === 'phase' ? 'Phase review template' : 'Step review template';
  } else {
    label = 'Prompt';
  }
  summary.append(element('span', { className: 'prompt-card-label', text: label }));

  if (!isTemplate) {
    const tokens = detectPlaceholders(block.content);
    if (tokens.length > 0) {
      summary.append(renderPlaceholderBar(tokens));
    }
  }

  const toolbar = element('div', { className: 'prompt-toolbar' });
  const copyButton = element('button', {
    ariaLabel: 'Copy prompt',
    className: 'icon-button',
    dataset: { action: 'copy-code', key },
    title: 'Copy prompt',
    type: 'button',
  });
  copyButton.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  toolbar.append(
    copyButton,
    element('button', {
      className: 'text-button',
      dataset: { action: 'edit-code', key },
      text: 'Edit',
      type: 'button',
    }),
  );
  summary.append(toolbar);

  card.append(summary, renderPromptBody(block.content));

  card.addEventListener('toggle', () => {
    if (card.open) state.expandedCodeKeys.add(key);
    else state.expandedCodeKeys.delete(key);
  });

  return card;
}

function renderReviewCard({ mode, stepNumber, phaseNumber, stepId }) {
  const templates = state.reviewTemplates;
  const tpl = mode === 'phase' ? templates.phase : templates.step;
  if (!tpl.content) return document.createTextNode('');

  const text = buildReviewPromptText(mode, stepNumber, phaseNumber);
  const cardKey = mode === 'phase' ? `phase-review-${phaseNumber}` : `step-review-${stepNumber}`;
  const label = mode === 'phase' ? `Phase ${phaseNumber} review` : 'Review';

  const card = element('details', {
    className: `prompt-card prompt-review prompt-${mode}-review`,
  });
  card.dataset.cardKey = cardKey;
  card.dataset.reviewMode = mode;
  if (stepNumber) card.dataset.stepNumber = stepNumber;
  if (phaseNumber) card.dataset.phaseNumber = phaseNumber;
  if (stepId) card.dataset.stepId = stepId;
  if (state.expandedCodeKeys.has(cardKey)) card.open = true;

  if (mode === 'phase' && phaseNumber) {
    card.id = `phase-review-${phaseNumber}`;
    const check = state.phaseReviewCheckMap.get(card.id);
    card.dataset.completed = String(!!(check && check.checked));
  }

  const summary = element('summary', { className: 'prompt-summary' });
  summary.append(
    element('span', { className: 'prompt-chevron', ariaHidden: 'true', text: '›' }),
    element('span', { className: 'prompt-card-label', text: label }),
  );

  const toolbar = element('div', { className: 'prompt-toolbar' });
  const copyButton = element('button', {
    ariaLabel: 'Copy review prompt',
    className: 'icon-button',
    dataset: { action: 'copy-review-card' },
    title: 'Copy review prompt',
    type: 'button',
  });
  copyButton.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  toolbar.append(
    copyButton,
    element('button', {
      className: 'text-button',
      dataset: { action: 'edit-review-template', templateMode: mode },
      text: 'Edit',
      title: `Edit the ${mode} review template`,
      type: 'button',
    }),
  );
  summary.append(toolbar);

  const pre = element('pre', { className: 'prompt-code' });
  pre.textContent = text;

  card.append(summary, pre);

  card.addEventListener('toggle', () => {
    if (card.open) state.expandedCodeKeys.add(cardKey);
    else state.expandedCodeKeys.delete(cardKey);
  });

  return card;
}

function detectPlaceholders(text) {
  const found = new Set();
  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    if (RESERVED_TOKENS.has(match[1])) continue;
    found.add(match[1]);
  }
  return [...found];
}

function detectReviewMode(content) {
  if (!content) return null;
  const tokens = new Set();
  for (const match of content.matchAll(PLACEHOLDER_REGEX)) {
    tokens.add(match[1]);
  }
  if (tokens.has('STEP') && !tokens.has('PHASE')) return 'step';
  if (tokens.has('PHASE') && !tokens.has('STEP')) return 'phase';
  return null;
}

function extractReviewTemplates(blocks) {
  const templates = {
    step: { content: null, key: null },
    phase: { content: null, key: null },
  };
  for (const block of blocks) {
    if (block.type !== 'code') continue;
    const mode = detectReviewMode(block.content);
    if (mode === 'step' && !templates.step.content) {
      templates.step.content = block.content;
      templates.step.key = codeKey(block);
    } else if (mode === 'phase' && !templates.phase.content) {
      templates.phase.content = block.content;
      templates.phase.key = codeKey(block);
    }
  }
  return templates;
}

function phaseForStep(stepNumber) {
  if (!stepNumber) return '';
  return String(stepNumber).split('.')[0];
}

function buildReviewPromptText(mode, stepNumber, phaseNumber) {
  const templates = state.reviewTemplates;
  if (mode === 'phase' && templates.phase.content) {
    return templates.phase.content.replace(/<PHASE>/g, phaseNumber || '');
  }
  if (mode === 'step' && templates.step.content) {
    return templates.step.content.replace(/<STEP>/g, stepNumber || '');
  }
  return '';
}

function renderPlaceholderBar(tokens) {
  const bar = element('div', { className: 'prompt-placeholders' });
  for (const token of tokens) {
    const field = element('label', { className: 'placeholder-field' });
    const labelText = element('span', { text: token });
    const input = document.createElement('input');
    input.type = 'text';
    input.value = state.prefs.placeholders[token] || '';
    input.placeholder = `<${token}>`;
    input.dataset.placeholderToken = token;
    input.addEventListener('input', () => {
      state.prefs.placeholders[token] = input.value;
      savePrefs();
      refreshPromptBodies();
    });
    field.append(labelText, input);
    bar.append(field);
  }
  return bar;
}

function refreshPromptBodies() {
  for (const pre of elements.document.querySelectorAll('.prompt-code')) {
    const raw = pre.dataset.rawContent ?? '';
    const fresh = renderPromptBody(raw);
    pre.replaceWith(fresh);
  }
}

function renderPromptBody(rawContent) {
  const pre = element('pre', { className: 'prompt-code' });
  pre.dataset.rawContent = rawContent;
  const fragments = splitOnPlaceholders(rawContent);
  for (const fragment of fragments) {
    if (fragment.kind === 'text') {
      pre.append(document.createTextNode(fragment.value));
    } else {
      const fill = state.prefs.placeholders[fragment.token];
      if (fill) {
        pre.append(element('span', { className: 'placeholder-fill', text: fill }));
      } else {
        pre.append(element('span', { className: 'placeholder-empty', text: `<${fragment.token}>` }));
      }
    }
  }
  return pre;
}

function splitOnPlaceholders(text) {
  const fragments = [];
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    if (match.index > cursor) {
      fragments.push({ kind: 'text', value: text.slice(cursor, match.index) });
    }
    fragments.push({ kind: 'token', token: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    fragments.push({ kind: 'text', value: text.slice(cursor) });
  }
  return fragments;
}

function substitutePlaceholders(text) {
  return text.replace(PLACEHOLDER_REGEX, (raw, token) => {
    const fill = state.prefs.placeholders[token];
    return fill ? fill : raw;
  });
}

function renderPhaseGroup(group, stepSections) {
  const isCollapsed = isPhaseCollapsed(group.phase);
  const wrapper = element('section', {
    className: 'phase-group',
    dataset: {
      collapsed: String(isCollapsed),
      phaseId: group.phase.anchorId,
      state: group.phase.state || 'todo',
    },
  });

  const summary = element('button', {
    className: 'phase-summary',
    dataset: { action: 'toggle-phase', phaseId: group.phase.anchorId },
    type: 'button',
  });
  summary.setAttribute('aria-expanded', String(!isCollapsed));

  summary.append(
    element('span', { className: 'phase-chevron', text: '›', ariaHidden: 'true' }),
    element('h3', { className: 'phase-title', html: inlineMarkdown(group.phase.title), id: group.phase.anchorId }),
    element('span', {
      className: 'phase-progress',
      text: group.phase.total > 0 ? `${group.phase.done} / ${group.phase.total}` : '',
    }),
  );

  const body = element('div', { className: 'phase-body' });
  for (const child of group.children) {
    body.append(renderBlock(child, stepSections));
  }

  wrapper.append(summary, body);
  return wrapper;
}

function renderResumePreview(resume) {
  if (!elements.resumePreview) return;

  if (!resume) {
    elements.resumePreview.replaceChildren();
    elements.resumeButton.disabled = false;
    elements.resumeButton.dataset.targetId = '';
    return;
  }

  const title = resume.step ? resume.step.title : resume.checkText;
  const meta = resume.step?.skill ?? '';

  elements.resumePreview.replaceChildren(
    document.createTextNode(title),
    element('span', { className: 'resume-meta', text: meta }),
  );
  elements.resumeButton.dataset.targetId = resume.targetId || '';
}

function renderFilterChipsInline() {
  const wrapper = element('div', {
    className: 'filter-chips',
    ariaLabel: 'Filter checklist',
  });
  wrapper.setAttribute('role', 'group');

  const filters = [
    { key: 'todo', label: 'Todo' },
    { key: 'flight', label: 'In flight' },
    { key: 'done', label: 'Done' },
  ];

  for (const filter of filters) {
    const pressed = state.prefs.filters[filter.key];
    wrapper.append(
      element('button', {
        ariaPressed: String(pressed),
        className: 'filter-chip',
        dataset: { filterKey: filter.key },
        text: filter.label,
        type: 'button',
      }),
    );
  }

  return wrapper;
}

function renderPhaseHeader(block) {
  const wrapper = element('section', {
    className: 'phase-header',
    dataset: { phaseNumber: block.phaseNumber || '' },
  });
  wrapper.append(
    element('span', { className: 'phase-header-circle', text: String(block.phaseNumber || '') }),
    element('span', { className: 'phase-header-eyebrow', text: `Phase ${block.phaseNumber}` }),
  );
  if (block.phaseTitle) {
    wrapper.append(element('span', { className: 'phase-header-title', text: block.phaseTitle }));
  }
  return wrapper;
}

function renderWorkDivider() {
  const wrapper = element('section', { className: 'work-divider' });
  wrapper.append(element('span', { className: 'work-divider-label', text: 'Begin execution' }));
  return wrapper;
}

function renderDocumentPath(block) {
  return element('p', {
    className: 'document-path-inline',
    text: block.filePath || '',
  });
}

function renderStepGroup(block, stepSections) {
  const heading = block.children.find((c) => c.type === 'heading' && c.level === 2);
  const stepAnchorId = heading?.id || '';
  const section = stepSections?.find((s) => s.anchorId === block.stepId);
  const metaRow = section ? renderStepMeta(section, stepSections) : null;

  if (block.completed) {
    const details = element('details', {
      className: 'step-group',
      dataset: { stepId: block.stepId || '', completed: 'true' },
    });
    if (stepAnchorId) details.id = stepAnchorId;

    const summary = element('summary', { className: 'step-group-summary' });
    summary.append(
      element('span', { className: 'step-group-checkmark', ariaHidden: 'true', text: '✓' }),
      element('span', { className: 'step-group-title', text: heading?.text || '' }),
      element('span', { className: 'step-group-chevron', ariaHidden: 'true', text: '›' }),
    );
    details.append(summary);
    if (metaRow) details.append(metaRow);

    for (const child of block.children) {
      if (child === heading) continue;
      details.append(renderBlock(child, stepSections));
    }
    return details;
  }

  const wrapper = element('section', {
    className: 'step-group',
    dataset: { stepId: block.stepId || '', completed: 'false' },
  });
  for (const child of block.children) {
    wrapper.append(renderBlock(child, stepSections));
    if (metaRow && child === heading) wrapper.append(metaRow);
  }
  return wrapper;
}

/**
 * Renders the `Model:` and `Parallel:` chips that sit directly under a step
 * heading. Returns null when the step has neither piece of metadata —
 * legacy campaigns without Model/Parallel lines render unchanged.
 */
function renderStepMeta(section, stepSections) {
  const modelChip = renderModelChip(section.model);
  const parallelChip = renderParallelChip(section.parallel, stepSections);
  if (!modelChip && !parallelChip) return null;

  const row = element('div', { className: 'step-meta' });
  if (modelChip) row.append(modelChip);
  if (parallelChip) row.append(parallelChip);
  return row;
}

function renderModelChip(model) {
  if (!model || (!model.claudeCode && !model.codex)) return null;

  const titleParts = [];
  if (model.claudeCode) titleParts.push(`Claude Code: ${model.claudeCode}`);
  if (model.codex) titleParts.push(`Codex: ${model.codex}`);
  const chip = element('div', {
    className: 'meta-chip meta-model',
    title: titleParts.join(' / '),
  });

  if (model.claudeCode) {
    chip.append(
      element('span', {
        className: 'agent-glyph agent-glyph-cc',
        ariaLabel: 'Claude Code',
        text: 'CC',
      }),
      element('span', { className: 'agent-spec', text: model.claudeCode }),
    );
  }
  if (model.claudeCode && model.codex) {
    chip.append(element('span', { className: 'agent-divider', ariaHidden: 'true' }));
  }
  if (model.codex) {
    chip.append(
      element('span', {
        className: 'agent-glyph agent-glyph-cx',
        ariaLabel: 'Codex',
        text: 'CX',
      }),
      element('span', { className: 'agent-spec', text: model.codex }),
    );
  }
  return chip;
}

function renderParallelChip(parallel, stepSections) {
  if (!parallel) return null;

  if (!parallel.isParallel) {
    return element('div', {
      className: 'meta-chip meta-parallel meta-sequential',
      text: 'Sequential',
      title: 'This step runs after the previous step finishes.',
    });
  }

  const chip = element('div', {
    className: 'meta-chip meta-parallel',
    title: parallel.siblingSteps.length
      ? `Can run alongside Step ${parallel.siblingSteps.join(', ')}.`
      : 'Can run alongside its sibling steps.',
  });
  chip.append(element('span', { className: 'meta-parallel-label', text: 'Parallel' }));

  if (parallel.siblingSteps.length > 0) {
    chip.append(element('span', { className: 'meta-parallel-sep', ariaHidden: 'true', text: '·' }));
    const linksWrap = element('span', { className: 'meta-parallel-steps' });
    parallel.siblingSteps.forEach((stepNumber, index) => {
      const target = stepSections?.find((s) => s.number === stepNumber);
      if (index > 0) linksWrap.append(document.createTextNode(', '));
      linksWrap.append(
        element('a', {
          className: 'step-link meta-step-link',
          dataset: target
            ? { action: 'jump-to-step', stepId: target.anchorId }
            : { stepRef: stepNumber },
          href: target ? `#${target.anchorId}` : '#',
          text: stepNumber,
        }),
      );
    });
    chip.append(linksWrap);
  }
  return chip;
}

function renderDocSection(block, stepSections) {
  const sectionId = block.sectionId || '';
  const override = state.prefs.docSections?.[sectionId];
  const open = override === undefined ? !!block.defaultOpen : override === true;

  const details = element('details', { className: 'doc-section' });
  if (sectionId) details.dataset.sectionId = sectionId;
  if (open) details.open = true;

  const summary = element('summary', { className: 'doc-section-summary' });
  summary.append(
    element('span', { className: 'doc-section-chevron', ariaHidden: 'true', text: '›' }),
    element('span', {
      className: 'doc-section-title',
      html: inlineMarkdown(block.heading?.text || ''),
    }),
  );

  const hostsDocumentPath = block.children?.some((child) => child.type === 'document-path');
  if (hostsDocumentPath) {
    const copyButton = element('button', {
      ariaLabel: 'Copy campaign path',
      className: 'icon-button doc-section-copy',
      dataset: { action: 'copy-document-path' },
      title: 'Copy campaign path',
      type: 'button',
    });
    copyButton.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
    summary.append(copyButton);
  }

  details.append(summary);

  const body = element('div', { className: 'doc-section-body' });
  for (const child of block.children) {
    body.append(renderBlock(child, stepSections));
  }
  details.append(body);

  details.addEventListener('toggle', () => {
    if (!sectionId) return;
    state.prefs.docSections = state.prefs.docSections || {};
    state.prefs.docSections[sectionId] = details.open;
    savePrefs();
  });

  return details;
}

function renderStepCompleteButton(block) {
  return element('button', {
    className: 'button button-primary step-complete-button',
    dataset: {
      action: 'complete-and-next',
      line: block.line,
      stepId: block.stepId,
    },
    text: 'Complete & next',
    type: 'button',
  });
}

function renderPhaseCompleteButton(block) {
  return element('button', {
    className: 'button button-primary phase-complete-button',
    dataset: {
      action: 'complete-phase',
      line: block.line,
      phaseNumber: block.phaseNumber,
    },
    text: `Close Phase ${block.phaseNumber}`,
    type: 'button',
  });
}

function renderFinalReviewCard(block) {
  // The campaign-level review card. Distinct from per-phase review cards:
  // wider visual weight, an explicit eyebrow, the prompt expanded by default,
  // and a single "Close campaign" button below. Anchored at #campaign-review
  // so the campaign-level checkbox can scroll-link to it.
  const wrapper = element('section', {
    className: `final-review-card${block.completed ? ' done' : ''}`,
    id: 'campaign-review',
  });
  if (block.completed) wrapper.dataset.completed = 'true';

  const header = element('div', { className: 'final-review-header' });
  header.append(
    element('span', { className: 'final-review-eyebrow', text: 'Final review' }),
    element('h2', {
      className: 'final-review-title',
      text: 'Close out the campaign',
    }),
    element('p', {
      className: 'final-review-blurb',
      text: 'Run this prompt in a fresh session to grade the whole plan. When the verdict is in, tick the box.',
    }),
  );
  wrapper.append(header);

  const hasPrompt = !!(block.content && block.content.trim());
  const promptText = hasPrompt
    ? block.content
    : 'Final review prompt not provided. Add a fenced code block under `## Final review` in the markdown.';

  const prompt = element('div', { className: 'final-review-prompt' });
  if (hasPrompt && block.codeKey) {
    const toolbar = element('div', { className: 'final-review-toolbar' });
    const copyButton = element('button', {
      ariaLabel: 'Copy final review prompt',
      className: 'icon-button',
      dataset: { action: 'copy-code', key: block.codeKey },
      title: 'Copy final review prompt',
      type: 'button',
    });
    copyButton.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
    toolbar.append(copyButton);
    prompt.append(toolbar);
  }

  const pre = element('pre', { className: 'prompt-code final-review-prompt-code' });
  if (!hasPrompt) pre.classList.add('final-review-prompt-empty');
  pre.textContent = promptText;
  prompt.append(pre);
  wrapper.append(prompt);

  if (block.line != null) {
    const button = element('button', {
      className: 'button button-primary close-campaign-button',
      dataset: {
        action: 'close-campaign',
        line: block.line,
      },
      text: block.completed ? 'Campaign closed' : 'Close campaign',
      type: 'button',
    });
    if (block.completed) button.disabled = true;
    wrapper.append(button);
  }

  return wrapper;
}

function applyFilterClasses() {
  document.body.classList.toggle('filter-hide-todo', !state.prefs.filters.todo);
  document.body.classList.toggle('filter-hide-flight', !state.prefs.filters.flight);
  document.body.classList.toggle('filter-hide-done', !state.prefs.filters.done);
}

function applyFocusMode() {
  if (state.prefs.focusMode && state.stepSections.length > 0) {
    const present = state.stepSections.some((section) => section.anchorId === state.activeStepId);
    if (!present) state.activeStepId = state.stepSections[0].anchorId;
  }
  document.body.classList.toggle('focus-mode', state.prefs.focusMode);
  if (elements.focusButton) {
    elements.focusButton.setAttribute('aria-pressed', String(state.prefs.focusMode));
  }
  for (const child of elements.document.children) {
    child.classList.toggle('step-active', child.dataset.stepId === state.activeStepId);
  }
}

function toggleFocusMode() {
  state.prefs.focusMode = !state.prefs.focusMode;
  savePrefs();
  applyFocusMode();
  if (state.prefs.focusMode && state.activeStepId) {
    document.getElementById(state.activeStepId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
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

function getSaveStatus() {
  if (!state.serverBacked) {
    return 'Opened from your browser. Use Export to keep changes.';
  }
  if (state.saveStatus === 'saving') return 'Saving…';
  if (state.saveStatus === 'error') return state.lastSaveError || 'Save failed — retry.';
  if (state.dirty) return 'Unsaved changes.';
  if (state.lastModified) return `Saved ${formatTime(state.lastModified)}.`;
  return 'No changes yet.';
}

function updateSaveStatus() {
  if (elements.saveStatus) {
    elements.saveStatus.textContent = getSaveStatus();
    elements.saveStatus.dataset.state = state.saveStatus;
  }
  if (elements.saveStatusInline) {
    const inline = getSaveStatusInline();
    elements.saveStatusInline.textContent = inline.text;
    elements.saveStatusInline.dataset.state = inline.state;
    elements.saveStatusInline.title =
      inline.state === 'saved' && state.lastModified ? formatTime(state.lastModified) : '';
  }
}

// Keep the relative "Saved Xm ago" label honest while the tab sits open.
setInterval(() => {
  if (state.saveStatus === 'idle' && !state.dirty && state.lastModified) {
    updateSaveStatus();
  }
}, 30_000);

function getSaveStatusInline() {
  if (!state.serverBacked) return { text: '', state: 'idle' };
  if (state.saveStatus === 'saving') return { text: 'Saving…', state: 'saving' };
  if (state.saveStatus === 'error') return { text: 'Save failed', state: 'error' };
  if (state.dirty) return { text: 'Unsaved', state: 'dirty' };
  if (state.lastModified) return { text: `Saved ${relativeTime(state.lastModified)}`, state: 'saved' };
  return { text: '', state: 'idle' };
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

function isPhaseCollapsed(phase) {
  const defaultCollapsed = phase.state === 'done';
  const inverted = state.prefs.phaseInverted.includes(phase.anchorId);
  return inverted ? !defaultCollapsed : defaultCollapsed;
}

function togglePhase(phaseId) {
  if (!phaseId) return;
  const set = new Set(state.prefs.phaseInverted);
  if (set.has(phaseId)) set.delete(phaseId);
  else set.add(phaseId);
  state.prefs.phaseInverted = [...set];
  savePrefs();

  const node = document.querySelector(`.phase-group[data-phase-id="${cssEscape(phaseId)}"]`);
  if (node) {
    const currentlyCollapsed = node.dataset.collapsed === 'true';
    node.dataset.collapsed = String(!currentlyCollapsed);
    node.querySelector('.phase-summary')?.setAttribute('aria-expanded', String(currentlyCollapsed));
  }
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

function codeKey(block) {
  return `code-${block.lineStart}-${block.lineEnd}`;
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


/* ------------------------------ Mobile bottom bar ----------------------------------- */

let stepObserver = null;

function attachStepObserver() {
  if (!('IntersectionObserver' in window)) return;
  if (stepObserver) stepObserver.disconnect();

  stepObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length > 0) {
        state.activeStepId = visible[0].target.id;
        renderMobileBottombar();
      }
    },
    { rootMargin: '-15% 0px -65% 0px', threshold: 0 },
  );

  for (const section of state.stepSections) {
    const node = document.getElementById(section.anchorId);
    if (node) stepObserver.observe(node);
  }
}

function renderMobileBottombar() {
  if (!elements.mobileBottombar) return;

  const sections = state.stepSections;
  if (sections.length === 0) {
    elements.mobileBottombar.replaceChildren();
    return;
  }

  const { prev, next } = neighbouringSteps();

  const prevButton = element('button', {
    ariaLabel: 'Previous step',
    className: 'bottom-button',
    text: '‹',
    type: 'button',
  });
  prevButton.disabled = !prev;
  if (prev) prevButton.addEventListener('click', () => jumpToAnchor(prev.anchorId));

  const nextButton = element('button', {
    ariaLabel: 'Next step',
    className: 'bottom-button',
    text: '›',
    type: 'button',
  });
  nextButton.disabled = !next;
  if (next) nextButton.addEventListener('click', () => jumpToAnchor(next.anchorId));

  elements.mobileBottombar.replaceChildren(prevButton, nextButton);
}

function neighbouringSteps() {
  const sections = state.stepSections;
  if (sections.length === 0) return { prev: null, next: null };
  let activeIndex = sections.findIndex((s) => s.anchorId === state.activeStepId);
  if (activeIndex === -1) activeIndex = 0;
  return {
    prev: sections[activeIndex - 1] || null,
    next: sections[activeIndex + 1] || null,
  };
}

function nextUncheckedStep(currentStepId) {
  const sections = state.stepSections;
  const map = state.stepCheckMap;
  if (!map || sections.length === 0) return null;
  const currentIdx = sections.findIndex((section) => section.anchorId === currentStepId);
  if (currentIdx === -1) return null;
  for (let index = currentIdx + 1; index < sections.length; index += 1) {
    const check = map.get(sections[index].anchorId);
    if (check && !check.checked) return sections[index];
  }
  return null;
}

function jumpToAnchor(id) {
  if (state.stepSections.some((section) => section.anchorId === id)) {
    // Set eagerly (not just via the scroll observer) so rapid arrow-key
    // navigation always steps from the target, not a stale position.
    state.activeStepId = id;
    if (state.prefs.focusMode) applyFocusMode();
    renderMobileBottombar();
  }
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function injectStepButtons(blocks, stepSections, stepCheckMap, phaseTitles) {
  if (stepSections.length === 0) return blocks;
  const stepIds = new Set(stepSections.map((section) => section.anchorId));
  const stepById = new Map(stepSections.map((section) => [section.anchorId, section]));
  const templates = state.reviewTemplates;
  const result = [];
  let openStepId = null;
  let lastPhaseSeen = null;

  const closeStep = () => {
    if (!openStepId) return;
    const section = stepById.get(openStepId);
    if (templates.step.content && section && section.number) {
      result.push({
        type: 'step-review',
        stepId: openStepId,
        stepNumber: section.number,
      });
    }
    const check = stepCheckMap.get(openStepId);
    if (check && !check.checked) {
      result.push({ type: 'step-complete', stepId: openStepId, line: check.lineStart });
    }
    openStepId = null;
  };

  const closePhase = () => {
    if (lastPhaseSeen && templates.phase.content) {
      result.push({ type: 'phase-review', phaseNumber: lastPhaseSeen });
      const phaseCheck = state.phaseReviewCheckMap.get(`phase-review-${lastPhaseSeen}`);
      if (phaseCheck && !phaseCheck.checked) {
        result.push({
          type: 'phase-complete',
          phaseNumber: lastPhaseSeen,
          line: phaseCheck.lineStart,
        });
      }
    }
    lastPhaseSeen = null;
  };

  let workDividerEmitted = false;
  const openPhase = (newPhase) => {
    if (!workDividerEmitted) {
      result.push({ type: 'work-divider' });
      workDividerEmitted = true;
    }
    result.push({
      type: 'phase-header',
      phaseNumber: newPhase,
      phaseTitle: phaseTitles?.get(newPhase) || '',
    });
    lastPhaseSeen = newPhase;
  };

  for (const block of blocks) {
    const isH2 = block.type === 'heading' && block.level === 2;
    const isStepH2 = isH2 && stepIds.has(block.id);

    if (isStepH2) {
      const newPhase = phaseForStep(stepById.get(block.id).number);
      if (lastPhaseSeen !== newPhase) {
        if (lastPhaseSeen) {
          closeStep();
          closePhase();
        } else {
          closeStep();
        }
        openPhase(newPhase);
      } else {
        closeStep();
      }
    } else if (isH2) {
      closeStep();
      closePhase();
    }

    result.push(block);
    if (isStepH2) openStepId = block.id;
  }

  closeStep();
  closePhase();

  return result;
}

function buildFinalReviewCardBlock() {
  if (!state.isNewShape) return null;
  const check = state.campaignFinalReviewCheck;
  const codeBlock = state.finalReview?.code;
  return {
    type: 'final-review-card',
    content: codeBlock?.content || '',
    codeKey: codeBlock ? codeKey(codeBlock) : null,
    line: check ? check.lineStart : null,
    completed: !!(check && check.checked),
  };
}

function injectDocumentPath(blocks) {
  if (!state.filePath) return blocks;
  const pathBlock = { type: 'document-path', filePath: state.filePath };

  // Prefer the "Scope" doc-section; fall back to the first doc-section.
  let scopeSection = null;
  let firstDocSection = null;
  for (const block of blocks) {
    if (block.type !== 'doc-section') continue;
    if (!firstDocSection) firstDocSection = block;
    if (/scope/i.test(block.heading?.text || '')) {
      scopeSection = block;
      break;
    }
  }
  const target = scopeSection || firstDocSection;
  if (target) {
    target.children = [pathBlock, ...target.children];
    return blocks;
  }

  // No doc-sections exist — fall back to placing the path right after the H1
  // so it remains visible regardless of campaign structure.
  const result = [];
  let injected = false;
  for (const block of blocks) {
    result.push(block);
    if (!injected && block.type === 'heading' && block.level === 1) {
      result.push(pathBlock);
      injected = true;
    }
  }
  return result;
}

let notificationSettingsSaveTimer = null;

function notificationSettingsPayload() {
  return {
    macNotificationsEnabled: !!state.prefs.macNotificationsEnabled,
    ntfyTopic: state.prefs.ntfyTopic || '',
    webhookUrl: state.prefs.webhookUrl || '',
  };
}

function hasNotificationSettingsConfigured(settings = notificationSettingsPayload()) {
  return !!settings.macNotificationsEnabled || !!settings.ntfyTopic || !!settings.webhookUrl;
}

function applyNotificationSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  let changed = false;
  const next = {
    macNotificationsEnabled: settings.macNotificationsEnabled === true,
    ntfyTopic: typeof settings.ntfyTopic === 'string' ? settings.ntfyTopic : '',
    webhookUrl: typeof settings.webhookUrl === 'string' ? settings.webhookUrl : '',
  };

  for (const [key, value] of Object.entries(next)) {
    if (state.prefs[key] !== value) {
      state.prefs[key] = value;
      changed = true;
    }
  }

  if (changed) savePrefs();
  return changed;
}

async function syncNotificationSettingsFromServer(onApplied) {
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

function saveNotificationPrefs() {
  savePrefs();
  clearTimeout(notificationSettingsSaveTimer);
  notificationSettingsSaveTimer = window.setTimeout(persistNotificationSettings, 250);
}

async function persistNotificationSettings() {
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

function initSettings() {
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

  if (!settingsBtn || !drawer) return;

  let previouslyFocused = null;

  const syncSettingsControls = () => {
    if (themeSelect) themeSelect.value = normalizeTheme(state.prefs.theme);
    if (soundToggle) soundToggle.checked = !!state.prefs.soundEffectsEnabled;
    if (celebrationToggle) celebrationToggle.checked = !!state.prefs.celebrationsEnabled;
    if (macToggle) macToggle.checked = !!state.prefs.macNotificationsEnabled;
    if (ntfyInput) ntfyInput.value = state.prefs.ntfyTopic || '';
    if (webhookInput) webhookInput.value = state.prefs.webhookUrl || '';
  };

  const openDrawer = () => {
    syncSettingsControls();
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.removeAttribute('hidden');
    settingsBtn.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(() => {
      drawerContent?.focus();
    });
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
    if (drawer.hidden || event.key !== 'Escape') return;
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

/* ------------------------------ Automate drawer ----------------------------- */

const DRAWER_WIDTH_KEY = 'campaigns-drawer-width:v1';

const drawerState = {
  open: false,
  width: 420,
};

function initAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const panel = drawer?.querySelector('.automate-drawer-panel');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  const resizeHandle = drawer?.querySelector('.automate-drawer-resize');
  if (!drawer || !panel || !toggleBtn) return;

  const savedWidth = localStorage.getItem(DRAWER_WIDTH_KEY);
  if (savedWidth) {
    const w = Number(savedWidth);
    if (w >= 320 && w <= 720) drawerState.width = w;
  }
  panel.style.setProperty('--drawer-width', `${drawerState.width}px`);

  toggleBtn.addEventListener('click', () => {
    if (drawerState.open) closeAutomateDrawer();
    else openAutomateDrawer();
  });

  drawer.querySelectorAll('[data-action="close-automate-drawer"]').forEach((btn) => {
    btn.addEventListener('click', closeAutomateDrawer);
  });

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAutomateDrawer();
    }
  });

  if (resizeHandle) initDrawerResize(resizeHandle, panel);
}

function openAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!drawer) return;

  drawerState.open = true;
  drawer.removeAttribute('hidden');
  toggleBtn?.setAttribute('aria-expanded', 'true');

  if (automateState.current) {
    renderDrawerBody(automateState.current);
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = setInterval(() => {
      tickDrawerElapsed();
      const statusEl = document.getElementById('automate-status');
      const data = automateState.current;
      if (statusEl && data && (isAutomateRunning(data) || isAutomateAttention(data))) {
        renderAutomateStatusContent(statusEl, data);
      }
    }, 60_000);
  }
  drawerLogScrolledByUser = false;
}

function closeAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!drawer) return;

  drawerState.open = false;
  drawer.setAttribute('hidden', '');
  toggleBtn?.setAttribute('aria-expanded', 'false');

  clearInterval(automateState.elapsedTimer);
  automateState.elapsedTimer = null;
}

function syncDrawerToggleVisibility(status) {
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!toggleBtn) return;

  toggleBtn.hidden = false;

  const existingDot = toggleBtn.querySelector('.drawer-indicator');
  if (!status) {
    if (existingDot) existingDot.remove();
    return;
  }

  const next = automateIndicator(status, 'drawer-indicator');
  if (existingDot) {
    existingDot.replaceWith(next);
  } else {
    toggleBtn.append(next);
  }
}

function initDrawerResize(handle, panel) {
  let startX = 0;
  let startWidth = 0;

  const onPointerMove = (event) => {
    const delta = startX - event.clientX;
    const next = Math.max(320, Math.min(720, startWidth + delta));
    drawerState.width = next;
    panel.style.setProperty('--drawer-width', `${next}px`);
  };

  const onPointerUp = () => {
    handle.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerState.width));
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = drawerState.width;
    handle.classList.add('is-dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });
}

/* ------------------------------ Automate state polling ---------------------- */

let automateVisibilityBound = false;

function syncOverviewActiveIndicator(active) {
  if (!elements.overviewActiveIndicator) return;
  elements.overviewActiveIndicator.hidden = !active;
}

function startAutomatePolling() {
  clearInterval(automateState.libraryTimer);
  clearInterval(automateState.campaignTimer);
  automateState.libraryTimer = null;
  automateState.campaignTimer = null;

  const isLibrary = document.body.classList.contains('view-library');

  if (isLibrary) {
    fetchBulkAutomateState();
    automateState.libraryTimer = setInterval(fetchBulkAutomateState, 15_000);
  } else if (state.id) {
    fetchCampaignAutomateState();
    automateState.campaignTimer = setInterval(fetchCampaignAutomateState, 15_000);
  }

  if (!automateVisibilityBound) {
    automateVisibilityBound = true;
    document.addEventListener('visibilitychange', handleAutomateVisibility);
  }
}

function handleAutomateVisibility() {
  if (document.hidden) {
    clearInterval(automateState.libraryTimer);
    clearInterval(automateState.campaignTimer);
    clearInterval(automateState.elapsedTimer);
    automateState.libraryTimer = null;
    automateState.campaignTimer = null;
    automateState.elapsedTimer = null;
  } else {
    startAutomatePolling();
  }
}

async function fetchBulkAutomateState() {
  try {
    const response = await fetch('/api/automate-state');
    if (!response.ok) return;
    automateState.bulk = await response.json();
    updateLibraryDots();
  } catch {
    /* silent — non-critical UI enhancement */
  }
}

async function fetchCampaignAutomateState() {
  if (!state.id) return;
  try {
    const response = await fetch(`/api/automate-state?id=${encodeURIComponent(state.id)}`);
    if (!response.ok) return;
    const prev = automateState.current;
    const next = await response.json();
    automateState.current = next;

    const prevStatus = automateDisplayStatus(prev);
    const nextStatus = automateDisplayStatus(next);
    const statusChanged = prevStatus !== nextStatus;
    const stepChanged = (prev?.current_step?.id || null) !== (next?.current_step?.id || null);
    const timelineChanged = (prev?.timeline_events?.length || 0) !== (next?.timeline_events?.length || 0);
    const logChanged = (prev?.current_step_log?.length || 0) !== (next?.current_step_log?.length || 0);

    if (statusChanged || stepChanged || timelineChanged || !prev) {
      updateAutomateStatusLine();
    } else if (logChanged && drawerState.open) {
      updateDrawerLog(next);
      // Parsed activity (latest text, action chips, effort row) lives in the
      // Now block and changes with every new tool call. Re-render the body so
      // it stays current. Cheap: replaceChildren on the drawer body only.
      renderDrawerBody(next);
    }
  } catch {
    /* silent */
  }
}

function updateAutomateStatusLine() {
  const statusEl = document.getElementById('automate-status');
  if (!statusEl) return;

  const data = automateState.current;
  if (!data || !data.status) {
    statusEl.hidden = true;
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = null;
    syncDrawerToggleVisibility(null);
    syncOverviewActiveIndicator(false);
    renderDrawerBody(null);
    return;
  }

  const displayStatus = automateDisplayStatus(data);
  const isCompleted = displayStatus === 'completed';
  const isAbandoned = displayStatus === 'abandoned';
  const isActive = isAutomateRunning(data);
  const isWarn = isAutomateAttention(data);
  const isScheduled = isAutomateScheduled(data);

  if (!isActive && !isWarn && !isScheduled && !isCompleted && !isAbandoned) {
    statusEl.hidden = true;
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = null;
    syncDrawerToggleVisibility(null);
    syncOverviewActiveIndicator(false);
    renderDrawerBody(null);
    return;
  }

  if (isActive || isWarn || isScheduled) {
    statusEl.hidden = false;
    renderAutomateStatusContent(statusEl, data);
  } else {
    statusEl.hidden = true;
  }

  clearInterval(automateState.elapsedTimer);
  if ((isActive || isCompleted) && drawerState.open) {
    automateState.elapsedTimer = setInterval(() => {
      if (isActive || isWarn) renderAutomateStatusContent(statusEl, data);
      tickDrawerElapsed();
    }, 60_000);
  }

  syncDrawerToggleVisibility(isActive || isWarn || isScheduled || isCompleted || isAbandoned ? displayStatus : null);
  syncOverviewActiveIndicator(isActive);
  statusEl.onclick = () => openAutomateDrawer();
  renderDrawerBody(data);
}

function renderAutomateStatusContent(el, data) {
  const unit = data.current_step || { id: data.current_step_id };
  const unitLabel = formatAutomateUnitLabel(unit);
  const elapsed = formatAutomateElapsed(data.current_step?.started_at);
  const displayStatus = automateDisplayStatus(data);
  const prefix = {
    queued: 'Scheduled',
    scheduled: 'Scheduled',
    stalled: 'Stalled',
    halted: 'Halted',
    failed: 'Failed',
  }[displayStatus];

  const text = prefix ? `${prefix} · ${unitLabel}` : elapsed ? `${unitLabel} · ${elapsed}` : unitLabel;

  el.replaceChildren(
    automateIndicator(displayStatus),
    element('span', { className: 'automate-status-text', text }),
  );
  el.title = data.current_step?.name || data.current_step_name || '';
}

function formatAutomateElapsed(startedAt) {
  if (!startedAt) return '';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

function renderDrawerEta(data) {
  const estimate = estimateAutomateWait(data);
  if (!estimate) return null;

  const block = element('section', { className: 'drawer-eta' });
  const header = element('div', { className: 'drawer-eta-header' });
  header.append(
    element('span', { className: 'drawer-eta-label', text: 'Away window' }),
    element('span', { className: 'drawer-eta-window', text: estimate.windowLabel }),
    element('span', { className: `drawer-eta-confidence drawer-eta-confidence--${estimate.confidence}`, text: estimate.confidence }),
  );
  block.append(header);

  // Best-fit hint from the user's task library — real suggestions, not canned copy.
  const hint = awayBestFitHint(estimate.overTypical ? 0 : estimate.safeAway);
  block.append(element('p', { className: 'drawer-eta-suggestion', text: hint }));

  const facts = element('div', { className: 'drawer-eta-facts' });
  facts.append(element('span', { text: `Step left ${estimate.stepRangeLabel}` }));
  if (estimate.phaseWindowLabel) {
    facts.append(element('span', { text: `Phase window ${estimate.phaseWindowLabel}` }));
  }
  facts.append(element('span', { text: `${estimate.baseline.label} history, n=${estimate.baseline.sample}` }));
  block.append(facts);

  const awayBtn = element('button', {
    className: 'button button-quiet drawer-eta-away',
    type: 'button',
    text: 'Plan away time',
  });
  awayBtn.addEventListener('click', () => openAwayMode({ mode: 'campaign', ids: [state.id], title: awayCurrentCampaignTitle() }));
  block.append(awayBtn);

  return block;
}

/* ------------------------------ Drawer content rendering ------------------- */

let drawerLogScrolledByUser = false;
let drawerLastLogLength = 0;
let nudgePendingPulse = false;

function renderDrawerBody(data) {
  const body = document.getElementById('automate-drawer-body');
  if (!body) return;

  if (!data || !data.status) {
    body.replaceChildren(element('p', { className: 'automate-drawer-empty', text: 'No active automation.' }));
    return;
  }

  const displayStatus = automateDisplayStatus(data);
  const isCompleted = displayStatus === 'completed';
  const isActive = isAutomateRunning(data);

  const children = [];

  children.push(renderDrawerStatusPill(data));

  const nudge = renderDrawerNudge(data);
  if (nudge) children.push(nudge);

  const finalizeHalt = renderDrawerFinalizeHalt(data);
  if (finalizeHalt) children.push(finalizeHalt);

  // "Now" block: subsumes the old current-step block AND replaces the raw log
  // as the primary "what's happening" surface. Only active campaigns get this.
  // Falls back to the legacy current-step block when live_activity is missing
  // (older campaigns with text-only logs).
  const now = renderDrawerNow(data);
  if (now) {
    children.push(now);
  } else if (isActive && data.current_step) {
    children.push(renderDrawerCurrentStep(data));
  }

  children.push(renderDrawerTimeline(data));
  children.push(renderDrawerReceipts(data, isCompleted));

  // Raw log: collapsed by default — debugging fallback, not primary signal.
  if (!isCompleted && isActive && data.current_step_log != null) {
    children.push(renderDrawerLogTail(data));
  }

  body.replaceChildren(...children);
}

function renderDrawerNow(data) {
  const isActive = isAutomateRunning(data);
  if (!isActive || !data.current_step) return null;

  const step = data.current_step;
  const live = data.live_activity;

  const block = element('section', { className: 'drawer-now' });

  const header = element('div', { className: 'drawer-now-header' });
  header.append(
    element('span', { className: 'drawer-now-step-id', text: formatAutomateUnitLabel(step) }),
    element('span', { className: 'drawer-now-step-name', text: step.name || '' }),
    element('span', {
      className: 'drawer-now-elapsed',
      text: formatAutomateElapsed(step.started_at) || '0m',
    }),
  );
  block.append(header);

  const eta = renderDrawerEta(data);
  if (eta) block.append(eta);

  if (live?.latest_text) {
    const voice = element('p', { className: 'drawer-now-voice' });
    const text = live.latest_text.length > 320
      ? `${live.latest_text.slice(0, 320)}…`
      : live.latest_text;
    voice.textContent = text;
    block.append(voice);
  } else if (!live) {
    // Legacy log format — no JSON events to parse.
    const note = element('p', {
      className: 'drawer-now-voice drawer-now-voice--legacy',
      text: 'Live activity will appear here once the next step launches. (Older steps used plain-text logs.)',
    });
    block.append(note);
  }

  if (live?.recent_actions?.length) {
    const stream = element('div', { className: 'drawer-now-actions' });
    for (const act of live.recent_actions) {
      const toolKey = (act.tool || '').toLowerCase().replace(/[^a-z]/g, '') || 'other';
      const chip = element('span', {
        className: `drawer-now-action drawer-now-action--${toolKey}`,
      });
      chip.title = act.detail || act.label || '';
      chip.textContent = act.label;
      stream.append(chip);
    }
    block.append(stream);
  }

  if (live?.effort) {
    const e = live.effort;
    const pluralize = (n, singular, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
    const parts = [];
    if (e.tools_called) parts.push(pluralize(e.tools_called, 'tool'));
    if (e.files_touched) parts.push(pluralize(e.files_touched, 'file'));
    if (e.edits) parts.push(pluralize(e.edits, 'edit'));
    if (e.bash_commands) parts.push(`${e.bash_commands} bash`);
    if (e.tokens_used) parts.push(`${formatTokenCount(e.tokens_used)} tokens`);
    if (parts.length) {
      block.append(element('div', { className: 'drawer-now-effort', text: parts.join(' · ') }));
    }
  }

  const stepData = data.steps?.find((s) => s.id === step.id);
  if (stepData?.prompt) {
    const details = element('details', { className: 'drawer-now-prompt-toggle' });
    details.append(element('summary', { text: 'Show step prompt' }));
    const pre = element('pre', { className: 'drawer-step-prompt-code' });
    pre.textContent = stepData.prompt.length > 2000
      ? `${stepData.prompt.slice(0, 2000)}…`
      : stepData.prompt;
    details.append(pre);
    block.append(details);
  }

  return block;
}

function formatTokenCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function renderDrawerStatusPill(data) {
  const status = automateDisplayStatus(data);
  const pill = element('div', { className: `drawer-status-pill drawer-status-pill--${status}` });
  pill.append(
    automateIndicator(status),
    element('span', { className: 'drawer-status-label', text: status }),
  );
  return pill;
}

function renderDrawerNudge(data) {
  if (!data.nudge_modes) return null;
  const modes = data.nudge_modes;
  const hasAny = Object.values(modes).some((m) => m.available);
  if (!hasAny) return null;

  const section = element('div', { className: 'drawer-nudge' });

  const stepId = data.current_step?.id || '?';
  const unitLabel = formatAutomateUnitLabel(data.current_step || { id: stepId });
  const stepElapsedMs = data.current_step?.started_at
    ? Date.now() - Date.parse(data.current_step.started_at)
    : 0;
  const elapsedMin = Math.floor(stepElapsedMs / 60_000);
  const cap = data.max_step_minutes || 60;
  const displayStatus = automateDisplayStatus(data);
  const statusLabel = displayStatus === 'failed'
    ? `${unitLabel} failed.`
    : displayStatus === 'stalled'
      ? `${unitLabel} is not currently running.`
      : `${unitLabel} has been running for ${elapsedMin} minutes (cap: ${cap}).`;

  section.append(element('p', { className: 'drawer-nudge-header', text: `${statusLabel} What would you like to do?` }));

  const actions = element('div', { className: 'drawer-nudge-actions' });

  const confirmDescriptions = {
    continue: modes.continue?.description || `This re-launches ${unitLabel} with a prompt telling the agent to check git state and finish what's left. Safe default — work that already landed won't be redone.`,
    restart: modes.restart?.description || `This wipes ${unitLabel}'s progress entirely and runs it again from scratch. Any work the previous attempt landed stays in git, but the agent starts fresh.`,
    skip: `This marks ${unitLabel} as done without verifying and advances to the next step. If the work isn't actually there, the chain will have a silent gap.`,
    restart_failed: modes.restart_failed?.description || `This re-runs the failed ${unitLabel} from scratch. The previous failure's log and state will be replaced.`,
  };

  if (modes.continue.available) {
    const btn = element('button', {
      className: 'button button-primary drawer-nudge-btn',
      text: modes.continue.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'continue', modes.continue.label, confirmDescriptions.continue));
    actions.append(btn);
  }

  if (modes.restart_failed.available) {
    const btn = element('button', {
      className: 'button button-primary drawer-nudge-btn',
      text: modes.restart_failed.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'restart_failed', modes.restart_failed.label, confirmDescriptions.restart_failed));
    actions.append(btn);
  }

  if (modes.restart.available) {
    const btn = element('button', {
      className: 'button drawer-nudge-btn drawer-nudge-btn--secondary',
      text: modes.restart.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'restart', modes.restart.label, confirmDescriptions.restart));
    actions.append(btn);
  }

  if (modes.skip.available) {
    const btn = element('button', {
      className: 'button drawer-nudge-btn drawer-nudge-btn--secondary',
      text: modes.skip.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'skip', modes.skip.label, confirmDescriptions.skip, true));
    actions.append(btn);
  }

  section.append(actions);
  return section;
}

function showNudgeConfirmModal(data, mode, label, description, requireCheckbox) {
  let existing = document.getElementById('nudge-confirm-modal');
  if (existing) existing.remove();

  const stepId = data.current_step?.id || '?';
  const unitLabel = formatAutomateUnitLabel(data.current_step || { id: stepId });
  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'nudge-confirm-modal' });

  const card = element('div', { className: 'nudge-confirm-card' });
  card.append(element('h3', { className: 'nudge-confirm-title', text: label }));
  card.append(element('p', { className: 'nudge-confirm-desc', text: description }));

  let checkbox = null;
  if (requireCheckbox) {
    const checkRow = element('label', { className: 'nudge-confirm-check-row' });
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'nudge-confirm-checkbox';
    checkRow.append(checkbox, element('span', { text: "I've checked git status and the work is there." }));
    card.append(checkRow);
  }

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-primary',
    text: label,
    type: 'button',
  });

  if (requireCheckbox) confirmBtn.disabled = true;

  cancelBtn.addEventListener('click', () => overlay.remove());

  if (checkbox) {
    checkbox.addEventListener('change', () => {
      confirmBtn.disabled = !checkbox.checked;
    });
  }

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Sending…';
    const result = await executeNudge(state.id, mode);
    overlay.remove();
    if (result.ok) {
      showToast(`${unitLabel} nudged — ${mode === 'continue' ? 'continuing' : mode === 'skip' ? 'skipping' : 'restarting'}.`);
      playAudioFeedback('tick');
      nudgePendingPulse = true;
      fetchCampaignAutomateState();
    } else {
      showToast(result.message || 'Nudge failed.');
    }
  });

  footer.append(cancelBtn, confirmBtn);
  card.append(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.append(card);
  document.body.append(overlay);
  (requireCheckbox ? checkbox : confirmBtn).focus();
}

async function executeNudge(id, mode) {
  try {
    const response = await fetch('/api/automate-nudge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function renderDrawerFinalizeHalt(data) {
  const actions = data.finalize_actions;
  if (!actions || !actions.rerun_finalize?.available) return null;

  const fin = data.finalize || {};
  const attempts = fin.attempts || 1;
  const haltedReason = fin.halted_reason || 'the fix-agent could not produce a commit';

  const section = element('div', { className: 'drawer-finalize-halt' });

  section.append(
    element('p', {
      className: 'drawer-finalize-halt-header',
      text: `Auto-finalize said NEEDS WORK on attempt ${attempts}.`,
    }),
    element('p', {
      className: 'drawer-finalize-halt-body',
      text: `The chain halted because ${haltedReason}.`,
    }),
  );

  const reviewPreview = extractReviewFailuresSnippet(fin.review_content);
  if (reviewPreview) {
    const preview = element('div', { className: 'drawer-finalize-halt-preview' });
    preview.innerHTML = renderSimpleMarkdown(reviewPreview);
    section.append(preview);
  }

  const actionsRow = element('div', { className: 'drawer-finalize-halt-actions' });

  const rerunBtn = element('button', {
    className: 'button button-primary drawer-finalize-halt-btn',
    text: actions.rerun_finalize.label,
    type: 'button',
  });
  rerunBtn.addEventListener('click', () => {
    showFinalizeRerunConfirm(data);
  });
  actionsRow.append(rerunBtn);

  if (actions.view_review?.available) {
    const viewBtn = element('button', {
      className: 'button drawer-finalize-halt-btn drawer-finalize-halt-btn--secondary',
      text: actions.view_review.label,
      type: 'button',
    });
    viewBtn.addEventListener('click', () => {
      showFinalizeReviewModal(data);
    });
    actionsRow.append(viewBtn);
  }

  if (actions.mark_abandoned?.available) {
    const abandonBtn = element('button', {
      className: 'button drawer-finalize-halt-btn drawer-finalize-halt-btn--tertiary',
      text: actions.mark_abandoned.label,
      type: 'button',
    });
    abandonBtn.addEventListener('click', () => {
      showFinalizeAbandonConfirm(data);
    });
    actionsRow.append(abandonBtn);
  }

  section.append(actionsRow);
  return section;
}

// The review markdown can be hundreds of lines. The drawer banner only has
// room for a teaser — the "Failures" section is what blocks the user, so
// surface that and let the modal handle the rest.
function extractReviewFailuresSnippet(content) {
  if (!content) return null;
  const headingRegex = /^#{2,3}\s+failures?/im;
  const match = headingRegex.exec(content);
  if (!match) return null;

  const start = match.index;
  const afterHeading = content.slice(start + match[0].length);
  const nextHeadingMatch = /^#{1,3}\s+/m.exec(afterHeading);
  const end = nextHeadingMatch ? start + match[0].length + nextHeadingMatch.index : content.length;
  return content.slice(start, end).trim();
}

function showFinalizeRerunConfirm(data) {
  showFinalizeConfirmModal({
    title: 'Re-run finalize review',
    body: 'Spawn another auto-finalize pass. Use this after you’ve manually closed the gaps the last review flagged. The review runs in the background — refresh to see results.',
    confirmLabel: 'Start finalize',
    busyLabel: 'Starting…',
    onConfirm: async () => {
      const result = await executeFinalizeRerun(state.id);
      if (result.ok) {
        showToast(result.message || 'Finalize started.');
        playAudioFeedback('tick');
        fetchCampaignAutomateState();
      } else {
        showToast(result.message || 'Could not start finalize.');
      }
    },
  });
}

function showFinalizeAbandonConfirm(data) {
  showFinalizeConfirmModal({
    title: 'Mark campaign abandoned',
    body: 'Close this campaign out without running finalize again. The status pill turns neutral; you can still re-open or revisit the markdown.',
    confirmLabel: 'Mark abandoned',
    busyLabel: 'Marking…',
    onConfirm: async () => {
      const result = await executeFinalizeAbandon(state.id);
      if (result.ok) {
        showToast(result.message || 'Marked abandoned.');
        fetchCampaignAutomateState();
      } else {
        showToast(result.message || 'Could not mark abandoned.');
      }
    },
  });
}

function showFinalizeConfirmModal({ title, body, confirmLabel, busyLabel, onConfirm }) {
  let existing = document.getElementById('nudge-confirm-modal');
  if (existing) existing.remove();

  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'nudge-confirm-modal' });
  const card = element('div', { className: 'nudge-confirm-card' });
  card.append(
    element('h3', { className: 'nudge-confirm-title', text: title }),
    element('p', { className: 'nudge-confirm-desc', text: body }),
  );

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-primary',
    text: confirmLabel,
    type: 'button',
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = busyLabel;
    try {
      await onConfirm();
    } finally {
      overlay.remove();
    }
  });

  footer.append(cancelBtn, confirmBtn);
  card.append(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.append(card);
  document.body.append(overlay);
  confirmBtn.focus();
}

function showFinalizeReviewModal(data) {
  let existing = document.getElementById('finalize-review-modal');
  if (existing) existing.remove();

  const fin = data.finalize || {};
  const content = fin.review_content || 'Review content unavailable.';
  const reviewPath = fin.review_path || '';

  const overlay = element('div', {
    className: 'finalize-review-modal',
    id: 'finalize-review-modal',
  });
  const card = element('div', { className: 'finalize-review-card' });

  const header = element('div', { className: 'finalize-review-header' });
  header.append(
    element('h3', { className: 'finalize-review-title', text: `Finalize review — verdict ${fin.verdict || 'unknown'}` }),
    element('button', {
      className: 'icon-button finalize-review-close',
      ariaLabel: 'Close review',
      text: '×',
      type: 'button',
    }),
  );

  if (reviewPath) {
    header.append(element('p', { className: 'finalize-review-path', text: reviewPath }));
  }

  const body = element('div', { className: 'finalize-review-body' });
  body.innerHTML = renderSimpleMarkdown(content);

  card.append(header, body);
  overlay.append(card);

  const closeModal = () => overlay.remove();
  header.querySelector('.finalize-review-close')?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.body.append(overlay);
  card.tabIndex = -1;
  card.focus();
}

async function executeFinalizeRerun(id) {
  try {
    const response = await fetch('/api/automate-finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function executeFinalizeAbandon(id) {
  try {
    const response = await fetch('/api/automate-abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function tickDrawerElapsed() {
  const data = automateState.current;
  if (!data?.current_step) return;
  const el = document.querySelector('.drawer-now-elapsed');
  if (el) el.textContent = formatAutomateElapsed(data.current_step.started_at) || '0m';
  const eta = document.querySelector('.drawer-eta');
  if (eta) {
    const next = renderDrawerEta(data);
    if (next) eta.replaceWith(next);
    else eta.remove();
  }
}

function renderDrawerCurrentStep(data) {
  const step = data.current_step;
  const block = element('div', { className: 'drawer-current-step' });

  const header = element('div', { className: 'drawer-current-step-header' });
  header.append(
    element('span', { className: 'drawer-current-step-id', text: formatAutomateUnitLabel(step) }),
    element('span', { className: 'drawer-current-step-name', text: step.name || '' }),
  );

  const elapsed = element('div', {
    className: 'drawer-current-step-elapsed',
    text: formatAutomateElapsed(step.started_at) || '0m',
  });

  block.append(header, elapsed);

  const stepData = data.steps?.find((s) => s.id === step.id);
  if (stepData?.prompt) {
    const details = element('details', { className: 'drawer-step-prompt-toggle' });
    details.append(
      element('summary', { text: 'Show step prompt' }),
    );
    const pre = element('pre', { className: 'drawer-step-prompt-code' });
    pre.textContent = stepData.prompt.length > 2000 ? stepData.prompt.slice(0, 2000) + '…' : stepData.prompt;
    details.append(pre);
    block.append(details);
  }

  return block;
}

function renderDrawerTimeline(data) {
  const events = data.timeline_events || [];
  if (events.length === 0) {
    return element('div', { className: 'drawer-timeline drawer-timeline-empty', text: 'No timeline events yet.' });
  }

  const wrapper = element('div', { className: 'drawer-timeline' });
  wrapper.append(element('h3', { className: 'drawer-section-title', text: 'Timeline' }));

  const limit = 20;
  const visible = events.slice(-limit).reverse();
  const hidden = events.length > limit ? events.slice(0, events.length - limit).reverse() : [];

  const shouldPulse = nudgePendingPulse;
  nudgePendingPulse = false;

  const list = element('div', { className: 'drawer-timeline-list' });
  for (let i = 0; i < visible.length; i++) {
    const chip = renderTimelineChip(visible[i]);
    if (shouldPulse && i === 0) chip.classList.add('drawer-timeline-chip--pulse');
    list.append(chip);
  }
  wrapper.append(list);

  if (hidden.length > 0) {
    const showAll = element('button', {
      className: 'drawer-show-all-btn',
      text: `Show all ${events.length} events`,
      type: 'button',
    });
    showAll.addEventListener('click', () => {
      for (const ev of hidden) {
        list.append(renderTimelineChip(ev));
      }
      showAll.remove();
    });
    wrapper.append(showAll);
  }

  return wrapper;
}

function renderTimelineChip(ev) {
  const chip = element('div', { className: 'drawer-timeline-chip' });
  const ts = ev.ts ? relativeTime(ev.ts) : '';
  const eventText = ev.event || '';
  const detail = ev.step_id ? ` ${ev.step_id}` : '';
  const reason = ev.reason ? ` — ${ev.reason}` : '';

  chip.append(
    element('span', { className: 'drawer-timeline-time', text: ts }),
    element('span', { className: 'drawer-timeline-event', text: `${eventText}${detail}${reason}` }),
  );
  return chip;
}

function renderDrawerReceipts(data, isCompleted) {
  const steps = (data.steps || []).filter((s) => s.status === 'done');
  if (steps.length === 0) {
    return element('div', { className: 'drawer-receipts drawer-receipts-empty' });
  }

  const wrapper = element('div', { className: 'drawer-receipts' });
  wrapper.append(element('h3', { className: 'drawer-section-title', text: 'Completed steps' }));

  for (const step of steps) {
    const details = document.createElement('details');
    details.className = 'drawer-receipt-item';
    if (isCompleted) details.open = true;

    const summary = element('summary', { className: 'drawer-receipt-summary' });
    summary.append(
      element('span', { className: 'drawer-receipt-id', text: step.id }),
      element('span', { className: 'drawer-receipt-name', text: step.name || '' }),
    );
    details.append(summary);

    if (step.receipt) {
      const content = element('div', { className: 'drawer-receipt-content' });
      content.innerHTML = renderSimpleMarkdown(step.receipt);
      details.append(content);
    } else {
      details.append(element('p', { className: 'drawer-receipt-empty', text: 'No receipt available.' }));
    }

    wrapper.append(details);
  }

  return wrapper;
}

function renderDrawerLogTail(data) {
  const wrapper = element('details', { className: 'drawer-log-tail' });
  wrapper.append(element('summary', { className: 'drawer-section-title', text: 'Step log' }));

  const logContainer = element('div', { className: 'drawer-log-container' });
  const pre = element('pre', { className: 'drawer-log-pre' });

  const logText = data.current_step_log || '';
  const lines = logText.split('\n');
  const capped = lines.length > 500 ? lines.slice(-500).join('\n') : logText;
  pre.textContent = capped;

  logContainer.append(pre);

  const rejoinChip = element('button', {
    className: 'drawer-log-rejoin',
    text: '↓ new',
    type: 'button',
    hidden: true,
  });
  rejoinChip.addEventListener('click', () => {
    logContainer.scrollTop = logContainer.scrollHeight;
    rejoinChip.hidden = true;
    drawerLogScrolledByUser = false;
  });
  logContainer.append(rejoinChip);

  logContainer.addEventListener('scroll', () => {
    const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 30;
    drawerLogScrolledByUser = !atBottom;
    if (atBottom) rejoinChip.hidden = true;
  });

  wrapper.append(logContainer);

  drawerLastLogLength = logText.length;
  requestAnimationFrame(() => {
    logContainer.scrollTop = logContainer.scrollHeight;
  });

  return wrapper;
}

function updateDrawerLog(data) {
  const pre = document.querySelector('.drawer-log-pre');
  const container = document.querySelector('.drawer-log-container');
  const rejoin = document.querySelector('.drawer-log-rejoin');
  if (!pre || !container || !data.current_step_log) return;

  const logText = data.current_step_log;
  if (logText.length === drawerLastLogLength) return;

  const lines = logText.split('\n');
  const capped = lines.length > 500 ? lines.slice(-500).join('\n') : logText;
  pre.textContent = capped;
  drawerLastLogLength = logText.length;

  if (!drawerLogScrolledByUser) {
    container.scrollTop = container.scrollHeight;
  } else if (rejoin) {
    rejoin.hidden = false;
  }
}

function renderSimpleMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

const PREFS_KEY = 'campaigns-prefs:v1';
const LEGACY_PREFS_KEY = 'campaign-guide-prefs:v1';
const MIGRATION_FLAG_KEY = 'campaigns-migrated:v1';
const DOC_SECTIONS_RESET_FLAG_KEY = 'campaigns-doc-sections-reset:v1';
const STANDARD_SETTINGS_MIGRATION_FLAG_KEY = 'campaigns-standard-settings-2026-05-24:v1';
const LIBRARY_COLLECTIONS_EXPANDED_KEY = 'campaigns-library-collections-expanded:v1';
const AUTOSAVE_DELAY_MS = 700;
const TODAY_INACTIVITY_MS = 12 * 60 * 60 * 1000;

const PLACEHOLDER_REGEX = /<([A-Z][A-Z0-9_]+)>/g;
const CHECK_LINE_REGEX = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/;
const RESERVED_TOKENS = new Set(['STEP', 'PHASE']);
const THEME_KEYS = new Set(['default', 'graphite', 'blueprint', 'signal']);
const LEGACY_THEME_MAP = {
  cyberpunk: 'blueprint',
  forest: 'signal',
  obsidian: 'graphite',
  sunset: 'signal',
};
const NTFY_TOPIC_REGEX = /^[A-Za-z0-9_-]{3,64}$/;
const STANDARD_CAMPAIGN_SETTINGS = Object.freeze({
  theme: 'default',
  soundEffectsEnabled: true,
  celebrationsEnabled: true,
  macNotificationsEnabled: false,
  ntfyTopic: '',
});

const state = {
  activeStepId: null,
  baseHash: '',
  dirty: false,
  editingCodeKey: null,
  editingValue: '',
  expandedCodeKeys: new Set(),
  filePath: '',
  lastModified: '',
  lastPhaseSnapshot: null,
  lastSaveError: '',
  markdown: '',
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
  libraryExpandedCollections: loadLibraryExpandedCollections(),
  libraryDragCampaignId: '',
  id: '',
  homeDir: '',
};

const elements = {
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
  workflows: document.querySelector('#workflows'),
  workflowsContent: document.querySelector('#workflows-content'),
  toast: document.querySelector('#toast'),
};

const copyIconTemplate = document.querySelector('#copy-icon-template');

let autoSaveTimer = null;

initialize();

async function initialize() {
  bindGlobalActions();

  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'workflows') {
    await renderWorkflows();
    startAutomatePolling();
    return;
  }
  if (params.has('library')) {
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

function applyCampaignLogo(id, hasLogo) {
  const logoEl = document.querySelector('#campaign-logo');
  const favicon = document.querySelector('link[rel="icon"]');

  if (hasLogo && id) {
    const src = `/api/registry/icon?id=${encodeURIComponent(id)}`;
    if (logoEl) {
      logoEl.hidden = false;
      logoEl.src = src;
      logoEl.addEventListener(
        'error',
        () => {
          logoEl.hidden = true;
          logoEl.removeAttribute('src');
        },
        { once: true },
      );
    }
    if (favicon) favicon.href = src;
    return;
  }

  if (logoEl) {
    logoEl.hidden = true;
    logoEl.removeAttribute('src');
  }
  if (favicon) favicon.href = '/favicon.svg';
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
  document.title = firstHeading ? `${firstHeading.text} · Campaigns` : 'Campaigns';
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

function detectPhaseCompletions(phases) {
  const previous = state.lastPhaseSnapshot;
  const snapshot = {};
  for (const phase of phases) {
    snapshot[phase.anchorId] = { done: phase.done, total: phase.total };
    if (!previous) continue;
    const before = previous[phase.anchorId];
    if (
      before &&
      phase.total > 0 &&
      before.done < before.total &&
      phase.done === phase.total
    ) {
      showPhaseBanner(phase);
    }
  }
  state.lastPhaseSnapshot = snapshot;
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
  }
}

function getSaveStatusInline() {
  if (!state.serverBacked) return { text: '', state: 'idle' };
  if (state.saveStatus === 'saving') return { text: 'Saving…', state: 'saving' };
  if (state.saveStatus === 'error') return { text: 'Save failed', state: 'error' };
  if (state.dirty) return { text: 'Unsaved', state: 'dirty' };
  if (state.lastModified) return { text: `Saved ${formatTime(state.lastModified)}`, state: 'saved' };
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
  const lines = getLines();
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
  const lines = getLines();
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

async function copyCampaignPath(filePath) {
  if (!filePath) {
    showToast('No campaign path to copy yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(filePath);
    showToast('Path copied.');
  } catch {
    showToast('Copy failed. Select the path manually.');
  }
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

  const lines = getLines();
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

/* ------------------------------ Phase completion banner ----------------------------- */

function showPhaseBanner(phase) {
  if (!elements.phaseBanner) return;
  if (state.phaseBannerTimer) clearTimeout(state.phaseBannerTimer);

  elements.phaseBanner.replaceChildren(
    element('strong', { text: phase.title }),
    element('span', { className: 'phase-banner-meta', text: `${phase.done} / ${phase.total} done` }),
    element('button', {
      ariaLabel: 'Dismiss',
      className: 'phase-banner-close',
      text: '×',
      type: 'button',
    }),
  );
  elements.phaseBanner.querySelector('.phase-banner-close').addEventListener('click', hidePhaseBanner);

  elements.phaseBanner.classList.add('visible');
  state.phaseBannerTimer = window.setTimeout(hidePhaseBanner, 6000);
}

function hidePhaseBanner() {
  if (!elements.phaseBanner) return;
  elements.phaseBanner.classList.remove('visible');
  if (state.phaseBannerTimer) {
    clearTimeout(state.phaseBannerTimer);
    state.phaseBannerTimer = null;
  }
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
  if (state.prefs.focusMode && state.stepSections.some((section) => section.anchorId === id)) {
    state.activeStepId = id;
    applyFocusMode();
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

/* ------------------------------ Library + switcher --------------------------------- */

// Workflows landing — a top-level view parallel to the Campaigns library,
// reached via ?view=workflows. Mirrors renderLibrary's view signal: the route
// AND a body.view-workflows class drive which screen shows. Step 1.2 fills the
// content from GET /api/workflows; Step 2.1 replaces it with the Repo → Domain
// → Workflow tree.
async function renderWorkflows() {
  document.body.classList.add('view-workflows');
  applyCampaignLogo(null, false);
  if (!elements.workflows) return;
  elements.workflows.hidden = false;
  if (!elements.workflowsContent) return;

  let workflows = [];
  try {
    const response = await fetch('/api/workflows');
    if (!response.ok) throw new Error('Could not load workflow maps.');
    const payload = await response.json();
    workflows = Array.isArray(payload.workflows) ? payload.workflows : [];
  } catch (error) {
    elements.workflowsContent.replaceChildren(
      element('p', { className: 'library-empty-body', text: error.message }),
    );
    return;
  }

  if (workflows.length === 0) {
    elements.workflowsContent.replaceChildren(
      element('p', {
        className: 'library-empty-body',
        text: 'No workflow maps found. Run /workflow-map in a repo to add one.',
      }),
    );
    return;
  }

  // Minimal flat list — purely to verify discovery end-to-end. Step 2.1 replaces
  // this with the Repo → Domain → Workflow tree.
  const list = element('ul', { className: 'workflows-list' });
  for (const wf of workflows) {
    const item = element('li', { className: 'workflows-list-item' });
    item.append(element('span', { className: 'workflows-list-title', text: wf.title }));
    item.append(element('span', {
      className: 'workflows-list-meta',
      text: `${wf.repoName} · ${wf.domain}`,
    }));
    item.append(buildWorkflowScore(wf.score));
    list.append(item);
  }
  elements.workflowsContent.replaceChildren(list);
}

// Colour-count chips straight from the map's sidecar score — render what each map
// earned, never compute a colour here.
function buildWorkflowScore(score) {
  const safe = score && typeof score === 'object' ? score : {};
  const wrap = element('span', { className: 'workflows-score' });
  for (const colour of ['green', 'amber', 'red', 'neutral']) {
    wrap.append(element('span', {
      className: `workflows-score-chip workflows-score-${colour}`,
      text: String(Number(safe[colour]) || 0),
    }));
  }
  return wrap;
}

async function renderLibrary() {
  document.body.classList.add('view-library');
  applyCampaignLogo(null, false);
  if (!elements.library) return;
  elements.library.hidden = false;

  let registry;
  try {
    const response = await fetch('/api/registry');
    if (!response.ok) throw new Error('Could not load campaign registry.');
    registry = await response.json();
  } catch (error) {
    if (elements.libraryEmpty) {
      const errorPara = document.createElement('p');
      errorPara.className = 'library-empty-body';
      errorPara.textContent = error.message;
      elements.libraryEmpty.replaceChildren(errorPara);
      elements.libraryEmpty.hidden = false;
    }
    return;
  }

  state.homeDir = typeof registry.homeDir === 'string' ? registry.homeDir : '';
  const campaigns = Array.isArray(registry.campaigns) ? registry.campaigns : [];
  renderLibraryLessons(await fetchCampaignLessons());

  if (campaigns.length === 0) {
    elements.libraryEmpty.hidden = false;
    elements.libraryGrid.hidden = true;
    return;
  }
  elements.libraryEmpty.hidden = true;
  elements.libraryGrid.hidden = false;

  const sorted = sortCampaigns(campaigns);
  elements.libraryGrid.replaceChildren(...buildLibraryItems(sorted));
}

async function fetchCampaignLessons() {
  try {
    const response = await fetch('/api/lessons');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load lessons.');
    return payload;
  } catch (error) {
    return {
      available: false,
      error: error.message || 'Could not load lessons.',
    };
  }
}

function renderLibraryLessons(lessons) {
  if (!elements.libraryLessons) return;

  if (!lessons?.available) {
    const header = element('div', { className: 'library-lessons-header' });
    header.append(
      element('span', { className: 'library-lessons-title', text: 'Lessons' }),
      element('span', { className: 'library-lessons-meta', text: 'Unavailable' }),
    );
    elements.libraryLessons.hidden = false;
    elements.libraryLessons.replaceChildren(
      header,
      element('p', {
        className: 'library-lessons-unavailable',
        text: lessons?.error || 'Campaign lessons are unavailable.',
      }),
    );
    return;
  }

  const backends = new Map((lessons.backends || []).map((backend) => [backend.id, backend]));
  const claude = backends.get('claude');
  const codex = backends.get('codex');
  const total = positiveWholeNumber(lessons.scanned?.total);
  const metricItems = [
    lessonMetric('First try', backendRates([claude, codex], 'firstTryRate')),
    lessonMetric('Rework', backendRates([claude, codex], 'reworkRate')),
    lessonMetric('Halts', haltSummary(lessons.halt)),
    lessonMetric('Recovery', recoverySummary(lessons.recovery)),
    lessonMetric('Warnings', dataQualitySummary(lessons.dataQuality)),
    lessonMetric('Step count', sizingSummary(lessons.sizing)),
  ];

  const header = element('div', { className: 'library-lessons-header' });
  header.append(
    element('span', { className: 'library-lessons-title', text: 'Lessons' }),
    element('span', {
      className: 'library-lessons-meta',
      text: total > 0 ? `${total} local runs scanned` : 'Local run history',
    }),
  );

  const metrics = element('div', { className: 'library-lessons-metrics' });
  metrics.replaceChildren(...metricItems);

  const tags = renderLessonTags(lessons.reasons);
  elements.libraryLessons.hidden = false;
  elements.libraryLessons.replaceChildren(header, metrics, tags);
}

function lessonMetric(label, value) {
  const item = element('div', { className: 'library-lessons-metric' });
  item.append(
    element('span', { className: 'library-lessons-metric-label', text: label }),
    element('span', { className: 'library-lessons-metric-value', text: value }),
  );
  return item;
}

function backendRates(backends, field) {
  const parts = backends
    .filter(Boolean)
    .map((backend) => `${backend.label} ${formatPercent(backend[field])}`);
  return parts.length ? parts.join(' / ') : 'No verdicts yet';
}

function haltSummary(halt) {
  const overall = formatPercent(halt?.overallRate);
  const highStep = formatPercent(halt?.highStepCountRate);
  if (overall === 'n/a' && highStep === 'n/a') return 'No halt signal yet';
  return `${overall} overall / ${highStep} above guidance`;
}

function recoverySummary(recovery) {
  const campaigns = positiveWholeNumber(recovery?.campaigns);
  const events = positiveWholeNumber(recovery?.events);
  if (campaigns === 0 && events === 0) return 'No recoveries logged';
  return `${campaigns} campaign${campaigns === 1 ? '' : 's'} / ${events} event${events === 1 ? '' : 's'}`;
}

function dataQualitySummary(dataQuality) {
  const warnings = positiveWholeNumber(dataQuality?.warnings);
  if (warnings === 0) return 'No warnings';
  return `${warnings} warning${warnings === 1 ? '' : 's'}`;
}

function sizingSummary(sizing) {
  const avoidAbove = positiveWholeNumber(sizing?.avoidAboveSteps);
  const median = formatCompactNumber(sizing?.medianSteps);
  if (avoidAbove > 0) return `Avoid above ${avoidAbove}; median ${median}`;
  return median === 'n/a' ? 'No sizing data' : `Median ${median}`;
}

function renderLessonTags(reasons) {
  const row = element('div', { className: 'library-lessons-tags' });
  const tags = Array.isArray(reasons?.topTags) ? reasons.topTags : [];

  row.append(element('span', { className: 'library-lessons-tags-label', text: 'Reason tags' }));

  if (tags.length > 0) {
    for (const tag of tags) {
      row.append(renderLessonTag(tag));
    }
    return row;
  }

  const legacy = Array.isArray(reasons?.legacyTopTags) ? reasons.legacyTopTags : [];
  if (legacy.length > 0) {
    row.append(element('span', { className: 'library-lessons-tags-empty', text: 'Legacy' }));
    for (const tag of legacy) {
      row.append(renderLessonTag(tag, { legacy: true }));
    }
    return row;
  }

  row.append(element('span', { className: 'library-lessons-tags-empty', text: 'No review tags yet.' }));
  return row;
}

function renderLessonTag(tag, options = {}) {
  return element('span', {
    className: `library-lessons-tag${options.legacy ? ' legacy' : ''}`,
    text: `${tag.tag} ${positiveWholeNumber(tag.count)}`,
  });
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${Math.round(number * 100)}%`;
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function sortCampaigns(campaigns) {
  return [...campaigns].sort((a, b) => {
    const bucketDiff = campaignBucket(a) - campaignBucket(b);
    if (bucketDiff !== 0) return bucketDiff;
    return campaignActivityMs(b) - campaignActivityMs(a);
  });
}

function campaignBucket(campaign) {
  if (isComplete(campaign)) return 2;
  if (campaign.parkedAt) return 1;
  return 0;
}

function campaignActivityMs(campaign) {
  const iso = campaign.lastActivityAt || campaign.lastOpenedAt || campaign.createdAt;
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isComplete(campaign) {
  return normalizeProgress(campaign.progress).complete;
}

function normalizeProgress(progress) {
  const total = positiveWholeNumber(progress?.total);
  const done = Math.min(positiveWholeNumber(progress?.done), total);
  return {
    complete: total > 0 && done === total,
    done,
    ratio: total > 0 ? done / total : 0,
    total,
  };
}

function positiveWholeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function buildLibraryItems(campaigns) {
  const entries = groupLibraryCampaigns(campaigns);
  const active = [];
  const parked = [];
  const complete = [];

  for (const entry of entries) {
    if (entry.bucket === 2) {
      complete.push(entry);
    } else if (entry.bucket === 1) {
      parked.push(entry);
    } else {
      active.push(entry);
    }
  }

  const children = active.flatMap((entry) => buildLibraryEntry(entry));

  if (parked.length > 0) {
    const parkedCampaignCount = parked.reduce(
      (count, entry) => count + libraryEntryCampaignCount(entry),
      0,
    );
    children.push(buildParkedCampaignDivider(parkedCampaignCount));
    if (state.libraryParkedExpanded) {
      children.push(...parked.flatMap((entry) => buildLibraryEntry(entry)));
    }
  }

  if (complete.length > 0) {
    const completeCampaignCount = complete.reduce(
      (count, entry) => count + libraryEntryCampaignCount(entry),
      0,
    );
    children.push(buildCompleteCampaignDivider(completeCampaignCount));
    if (state.libraryCompleteExpanded) {
      children.push(...complete.flatMap((entry) => buildLibraryEntry(entry)));
    }
  }

  return children;
}

function groupLibraryCampaigns(campaigns) {
  const groups = new Map();
  const entries = [];

  for (const campaign of campaigns) {
    const collectionId = campaignCollectionId(campaign);
    if (!collectionId) {
      entries.push({
        type: 'campaign',
        campaign,
        bucket: campaignBucket(campaign),
      });
      continue;
    }

    let group = groups.get(collectionId);
    if (!group) {
      group = {
        type: 'collection',
        id: collectionId,
        campaigns: [],
        bucket: 2,
      };
      groups.set(collectionId, group);
      entries.push(group);
    }

    group.campaigns.push(campaign);
    group.bucket = Math.min(group.bucket, campaignBucket(campaign));
  }

  return entries.flatMap((entry) => {
    if (entry.type !== 'collection' || entry.campaigns.length > 1) return [entry];
    return entry.campaigns.map((campaign) => ({
      type: 'campaign',
      campaign,
      bucket: campaignBucket(campaign),
    }));
  });
}

function buildLibraryEntry(entry) {
  if (entry.type === 'campaign') return [buildLibraryCard(entry.campaign)];
  if (state.libraryExpandedCollections.has(entry.id)) {
    return [buildLibraryCollectionSection(entry)];
  }
  return [buildLibraryCollectionCard(entry)];
}

function libraryEntryCampaignCount(entry) {
  return entry.type === 'collection' ? entry.campaigns.length : 1;
}

function buildParkedCampaignDivider(count) {
  const expanded = state.libraryParkedExpanded;
  const label = `${count} sleeping campaign${count === 1 ? '' : 's'}`;
  const divider = element('div', {
    className: 'library-parked-divider',
    dataset: { expanded: String(expanded) },
  });

  const button = element('button', {
    className: 'library-parked-toggle',
    type: 'button',
    title: expanded ? 'Hide sleeping campaigns' : `Show ${label}`,
    ariaLabel: expanded ? 'Hide sleeping campaigns' : `Show ${label}`,
  });
  button.setAttribute('aria-expanded', String(expanded));
  button.append(
    element('span', { className: 'library-parked-symbol', text: expanded ? '-' : '+', ariaHidden: 'true' }),
    element('span', { className: 'library-divider-label', text: 'Sleeping campaigns' }),
    element('span', { className: 'library-divider-count', text: String(count) }),
  );
  button.addEventListener('click', () => {
    state.libraryParkedExpanded = !state.libraryParkedExpanded;
    renderLibrary();
  });

  divider.append(button);
  return divider;
}

function buildCompleteCampaignDivider(count) {
  const expanded = state.libraryCompleteExpanded;
  const label = `${count} finished campaign${count === 1 ? '' : 's'}`;
  const divider = element('div', {
    className: 'library-parked-divider library-complete-divider',
    dataset: { expanded: String(expanded) },
  });

  const button = element('button', {
    className: 'library-parked-toggle library-complete-toggle',
    type: 'button',
    title: expanded ? 'Hide finished campaigns' : `Show ${label}`,
    ariaLabel: expanded ? 'Hide finished campaigns' : `Show ${label}`,
  });
  button.setAttribute('aria-expanded', String(expanded));
  button.append(
    element('span', { className: 'library-parked-symbol', text: expanded ? '-' : '+', ariaHidden: 'true' }),
    element('span', { className: 'library-divider-label', text: 'Finished campaigns' }),
    element('span', { className: 'library-divider-count', text: String(count) }),
  );
  button.addEventListener('click', () => {
    state.libraryCompleteExpanded = !state.libraryCompleteExpanded;
    renderLibrary();
  });

  divider.append(button);
  return divider;
}

function buildLibraryCollectionCard(group) {
  const stats = collectionStats(group.campaigns);
  const complete = collectionComplete(stats);
  const parked = collectionParked(group, complete);
  const title = collectionTitle(group.campaigns);
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const card = element('article', {
    className: `library-card library-collection-card${modifiers ? ` ${modifiers}` : ''}`,
    dataset: {
      collectionId: group.id,
      campaignIds: group.campaigns.map((campaign) => campaign.id).join(' '),
    },
  });
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', 'false');
  card.setAttribute('aria-label', `${title}. ${group.campaigns.length} campaigns. Press to expand.`);

  const toggle = () => toggleLibraryCollection(group.id);
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  });
  bindLibraryDropTarget(card, { targetCollectionId: group.id });

  card.append(
    element('span', { className: 'library-card-title', text: title }),
    element('span', {
      className: 'library-card-path',
      text: `${group.campaigns.length} campaign${group.campaigns.length === 1 ? '' : 's'} collected`,
    }),
  );

  appendCollectionProgress(card, stats);
  card.append(
    element('span', {
      className: 'library-card-time',
      text: stats.lastActivityMs ? `Active ${relativeTime(new Date(stats.lastActivityMs).toISOString())}` : '',
    }),
    element('span', {
      className: 'library-collection-count',
      text: String(group.campaigns.length),
      ariaHidden: 'true',
    }),
  );
  if (!complete) {
    card.append(buildCollectionParkButton(group, parked));
  }
  card.append(buildCollectionCopyButton(group));

  return card;
}

function buildLibraryCollectionSection(group) {
  const stats = collectionStats(group.campaigns);
  const complete = collectionComplete(stats);
  const parked = collectionParked(group, complete);
  const title = collectionTitle(group.campaigns);
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const section = element('section', {
    className: `library-collection-section${modifiers ? ` ${modifiers}` : ''}`,
    dataset: {
      collectionId: group.id,
      campaignIds: group.campaigns.map((campaign) => campaign.id).join(' '),
    },
  });
  section.setAttribute('aria-label', title);
  bindLibraryDropTarget(section, { targetCollectionId: group.id });

  const header = element('button', {
    className: 'library-collection-header',
    type: 'button',
    title: 'Collapse collection',
    ariaLabel: 'Collapse collection',
  });
  header.setAttribute('aria-expanded', 'true');
  header.append(
    element('span', { className: 'library-collection-title', text: title }),
    element('span', {
      className: 'library-collection-meta',
      text: `${group.campaigns.length} campaign${group.campaigns.length === 1 ? '' : 's'} collected`,
    }),
    element('span', { className: 'library-collection-collapse', text: '-', ariaHidden: 'true' }),
  );
  header.addEventListener('click', () => toggleLibraryCollection(group.id));

  const grid = element('div', { className: 'library-collection-grid' });
  grid.replaceChildren(
    ...group.campaigns.map((campaign) => buildLibraryCard(campaign, { collectionMember: true })),
  );

  if (stats.total > 0) {
    section.dataset.progress = `${stats.done}/${stats.total}`;
  }
  section.append(header);
  if (!complete) {
    section.append(buildCollectionParkButton(group, parked));
  }
  section.append(buildCollectionCopyButton(group), grid);
  return section;
}

function appendCollectionProgress(parent, stats) {
  if (stats.total <= 0) return;

  const progress = element('div', { className: 'library-card-progress' });
  const track = element('div', { className: 'library-card-progress-track' });
  const fill = element('div', { className: 'library-card-progress-fill' });
  fill.style.width = `${Math.round((stats.done / stats.total) * 100)}%`;
  track.append(fill);
  progress.append(
    track,
    element('span', {
      className: 'library-card-progress-label',
      text: stats.done === stats.total ? 'All done' : `${stats.done} / ${stats.total}`,
    }),
  );
  parent.append(progress);
}

function collectionStats(campaigns) {
  return campaigns.reduce(
    (stats, campaign) => {
      const progress = normalizeProgress(campaign.progress);
      stats.done += progress.done;
      stats.total += progress.total;
      stats.lastActivityMs = Math.max(stats.lastActivityMs, campaignActivityMs(campaign));
      return stats;
    },
    { done: 0, total: 0, lastActivityMs: 0 },
  );
}

function collectionComplete(stats) {
  return stats.total > 0 && stats.done === stats.total;
}

function collectionParked(group, complete) {
  return !complete && group.bucket === 1;
}

function collectionTitle(campaigns) {
  const titles = campaigns.map((campaign) => campaign.title || '').filter(Boolean);
  const numbers = titles
    .map((title) => title.match(/^Campaign\s+(\d+)\b/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => Number.isFinite(number));

  if (numbers.length === titles.length && numbers.length > 1) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const isContiguous = sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length;
    if (isContiguous) return `Campaigns ${sorted[0]}-${sorted[sorted.length - 1]}`;
    const visible = sorted.slice(0, 3).join(', ');
    return sorted.length > 3 ? `Campaigns ${visible} + ${sorted.length - 3}` : `Campaigns ${visible}`;
  }

  return titles[0] || 'Campaign collection';
}

function campaignCollectionId(campaign) {
  return typeof campaign.collectionId === 'string' ? campaign.collectionId.trim() : '';
}

function toggleLibraryCollection(collectionId) {
  if (state.libraryExpandedCollections.has(collectionId)) {
    state.libraryExpandedCollections.delete(collectionId);
  } else {
    state.libraryExpandedCollections.add(collectionId);
  }
  saveLibraryExpandedCollections();
  void renderLibrary().then(updateLibraryDots);
}

function buildCollectionParkButton(group, parked) {
  const button = element('button', {
    className: 'library-collection-park-button',
    type: 'button',
    title: parked ? 'Reactivate stack' : 'Park stack',
    ariaLabel: parked ? 'Reactivate stack' : 'Park stack',
    ariaPressed: parked ? 'true' : 'false',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await toggleCollectionPark(group.id, !parked);
      await renderLibrary();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update stack park state.');
    }
  });
  return button;
}

function buildCollectionCopyButton(group) {
  const button = element('button', {
    className: 'library-collection-copy-button',
    type: 'button',
    title: 'Copy automation link',
    ariaLabel: 'Copy automation link',
  });
  if (copyIconTemplate?.content?.firstElementChild) {
    button.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  } else {
    button.textContent = 'Copy';
  }
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyCollectionAutomationLink(group);
  });
  return button;
}

async function copyCollectionAutomationLink(group) {
  const text = collectionAutomationText(group);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Stack automation link copied.');
  } catch {
    showToast('Copy failed. Select the stack details manually.');
  }
}

function collectionAutomationText(group) {
  const title = collectionTitle(group.campaigns);
  const lines = [
    `Use $campaign-automate on campaigns-stack://${group.id}`,
    `Stack: ${title}`,
    'Campaign files:',
  ];

  for (const campaign of group.campaigns) {
    if (campaign.filePath) lines.push(`- ${campaign.filePath}`);
  }

  return lines.join('\n');
}

function buildLibraryCard(campaign, options = {}) {
  const complete = isComplete(campaign);
  const progressStats = normalizeProgress(campaign.progress);
  const parked = Boolean(campaign.parkedAt) && !complete;
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
    campaign.missing ? 'missing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const card = element('article', {
    className: `library-card${modifiers ? ` ${modifiers}` : ''}${campaign.hasLogo ? ' has-logo' : ''}`,
    dataset: { campaignId: campaign.id },
  });
  bindLibraryDragSource(card, campaign);
  bindLibraryDropTarget(card, { targetId: campaign.id });

  const link = element('a', {
    className: 'library-card-link',
    href: `?id=${encodeURIComponent(campaign.id)}`,
  });

  link.append(
    element('span', { className: 'library-card-title', text: campaign.title || 'Untitled' }),
    element('span', { className: 'library-card-path', text: relativeHomePath(campaign.filePath, state.homeDir) }),
  );

  if (progressStats.total > 0) {
    const progress = element('div', { className: 'library-card-progress' });
    const track = element('div', { className: 'library-card-progress-track' });
    const fill = element('div', { className: 'library-card-progress-fill' });
    fill.style.width = `${Math.round(progressStats.ratio * 100)}%`;
    track.append(fill);
    progress.append(
      track,
      element('span', {
        className: 'library-card-progress-label',
        text: complete ? 'All done' : `${progressStats.done} / ${progressStats.total}`,
      }),
    );
    link.append(progress);
  }

  const time = campaign.missing
    ? 'File missing'
    : `Active ${relativeTime(campaign.lastActivityAt || campaign.lastOpenedAt)}`;
  link.append(element('span', { className: 'library-card-time', text: time }));

  card.append(link);

  if (campaign.hasLogo) {
    const logo = element('img', { className: 'library-card-logo', alt: '' });
    logo.src = `/api/registry/icon?id=${encodeURIComponent(campaign.id)}`;
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.addEventListener('error', () => {
      logo.remove();
      card.classList.remove('has-logo');
    }, { once: true });
    card.append(logo);
  }

  if (!complete && !campaign.missing) {
    card.append(buildParkButton(campaign, parked));
  } else if (campaign.missing) {
    card.append(buildDeleteMissingButton(campaign));
  }

  if (campaign.filePath) {
    card.append(buildCampaignCopyButton(campaign));
  }

  // Delete button — always available alongside park. Moves the .md to Trash.
  if (!campaign.missing) {
    card.append(buildDeleteButton(campaign));
  }

  if (options.collectionMember && campaignCollectionId(campaign) && !campaign.missing) {
    card.append(buildCollectionRemoveButton(campaign));
  }

  return card;
}

function buildCampaignCopyButton(campaign) {
  const button = element('button', {
    className: 'library-card-copy-button',
    type: 'button',
    title: 'Copy campaign path',
    ariaLabel: 'Copy campaign path',
  });
  if (copyIconTemplate?.content?.firstElementChild) {
    button.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  } else {
    button.textContent = 'Copy';
  }
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyCampaignPath(campaign.filePath);
  });
  return button;
}

function bindLibraryDragSource(card, campaign) {
  if (campaign.missing) return;

  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) {
      event.preventDefault();
      return;
    }

    state.libraryDragCampaignId = campaign.id;
    card.classList.add('is-dragging');
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-campaign-id', campaign.id);
    event.dataTransfer.setData('text/plain', campaign.id);
  });
  card.addEventListener('dragend', () => {
    state.libraryDragCampaignId = '';
    card.classList.remove('is-dragging');
    clearLibraryDropTargets();
  });
}

function bindLibraryDropTarget(node, target) {
  node.addEventListener('dragover', (event) => {
    const sourceId = dragCampaignId(event);
    if (!sourceId || sourceId === target.targetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    node.classList.add('is-drop-target');
  });

  node.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
    node.classList.remove('is-drop-target');
  });

  node.addEventListener('drop', async (event) => {
    const sourceId = dragCampaignId(event);
    if (!sourceId || sourceId === target.targetId) return;
    event.preventDefault();
    event.stopPropagation();
    clearLibraryDropTargets();

    try {
      const result = await stackCampaignInLibrary(sourceId, target);
      if (result.collectionId) {
        state.libraryExpandedCollections.delete(result.collectionId);
        saveLibraryExpandedCollections();
      }
      await renderLibrary();
      showToast(result.changed ? 'Campaigns collected.' : 'Already in that collection.');
    } catch (error) {
      showToast(error.message || 'Could not collect campaigns.');
    } finally {
      state.libraryDragCampaignId = '';
    }
  });
}

function dragCampaignId(event) {
  return (
    state.libraryDragCampaignId ||
    event.dataTransfer?.getData('application/x-campaign-id') ||
    event.dataTransfer?.getData('text/plain') ||
    ''
  );
}

function clearLibraryDropTargets() {
  document
    .querySelectorAll('.is-drop-target')
    .forEach((node) => node.classList.remove('is-drop-target'));
}

function buildCollectionRemoveButton(campaign) {
  const button = element('button', {
    className: 'library-card-collection-remove',
    type: 'button',
    text: 'Remove',
    title: 'Remove from collection',
    ariaLabel: 'Remove from collection',
  });
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await removeCampaignFromCollection(campaign.id);
      await renderLibrary();
      showToast('Removed from collection.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update collection.');
    }
  });
  return button;
}

function buildParkButton(campaign, parked) {
  const button = element('button', {
    className: 'library-card-park-button',
    type: 'button',
    title: parked ? 'Reactivate campaign' : 'Park campaign',
    ariaLabel: parked ? 'Reactivate campaign' : 'Park campaign',
    ariaPressed: parked ? 'true' : 'false',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await togglePark(campaign.id, !parked);
      await renderLibrary();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update park state.');
    }
  });
  return button;
}

function buildDeleteMissingButton(campaign) {
  const button = element('button', {
    className: 'library-card-delete-button',
    type: 'button',
    title: 'Remove missing campaign',
    ariaLabel: 'Remove missing campaign from library',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await deleteMissingCampaign(campaign.id);
      await renderLibrary();
      showToast('Missing campaign removed.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not remove missing campaign.');
    }
  });
  return button;
}

function buildDeleteButton(campaign) {
  const button = element('button', {
    className: 'library-card-trash-button',
    type: 'button',
    title: 'Delete campaign',
    ariaLabel: 'Delete campaign',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showDeleteCampaignConfirm(campaign, button);
  });
  return button;
}

function showDeleteCampaignConfirm(campaign, sourceButton) {
  const existing = document.getElementById('delete-campaign-modal');
  if (existing) existing.remove();

  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'delete-campaign-modal' });
  const card = element('div', { className: 'nudge-confirm-card' });

  card.append(
    element('h3', {
      className: 'nudge-confirm-title',
      text: `Delete "${campaign.title || 'this campaign'}"?`,
    }),
    element('p', {
      className: 'nudge-confirm-desc',
      text: 'Moves the markdown file to your Trash and removes it from the library. You can put it back from Finder.',
    }),
  );

  const pathLine = element('p', { className: 'nudge-confirm-desc nudge-confirm-path' });
  pathLine.textContent = campaign.filePath || '';
  card.append(pathLine);

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-danger',
    text: 'Delete',
    type: 'button',
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    try {
      const res = await fetch('/api/registry', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: campaign.id, deleteFile: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`);
      overlay.remove();
      await renderLibrary();
      showToast(data.trashed ? 'Campaign moved to Trash.' : 'Campaign removed.');
    } catch (error) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = 'Delete';
      showToast(error.message || 'Could not delete campaign.');
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

async function togglePark(id, parked) {
  const response = await fetch('/api/registry/park', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, parked }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update park state.');
  }
}

async function toggleCollectionPark(collectionId, parked) {
  const response = await fetch('/api/registry/park', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectionId, parked }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update stack park state.');
  }
}

async function stackCampaignInLibrary(sourceId, target) {
  const body = target.targetCollectionId
    ? { action: 'stack', sourceId, targetCollectionId: target.targetCollectionId }
    : { action: 'stack', sourceId, targetId: target.targetId };
  const response = await fetch('/api/registry/collection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Could not collect campaigns.');
  }
  return payload;
}

async function removeCampaignFromCollection(id) {
  const response = await fetch('/api/registry/collection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update collection.');
  }
}

async function deleteMissingCampaign(id) {
  const response = await fetch('/api/registry', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not remove missing campaign.');
  }
}

function relativeHomePath(filePath, homeDir) {
  if (homeDir && filePath.startsWith(`${homeDir}/`)) {
    return `~${filePath.slice(homeDir.length)}`;
  }
  return filePath;
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
}

async function initSwitcher() {
  if (!elements.switchButton || !elements.switchMenu) return;

  let registry;
  try {
    const response = await fetch('/api/registry');
    if (!response.ok) return;
    registry = await response.json();
  } catch {
    return;
  }

  state.homeDir = typeof registry.homeDir === 'string' ? registry.homeDir : '';
  const campaigns = Array.isArray(registry.campaigns) ? registry.campaigns : [];

  // Always show the home + switcher on a campaign view.
  if (elements.homeButton) elements.homeButton.hidden = false;
  elements.switchButton.hidden = false;
  buildSwitchMenu(campaigns);

  elements.switchButton.addEventListener('click', (event) => {
    // event.detail === 0 for keyboard-activated clicks (Enter/Space on a focused button).
    toggleSwitchMenu({ focusFirst: event.detail === 0 });
  });
  elements.switchButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Down') {
      event.preventDefault();
      openSwitchMenu(0);
    } else if (event.key === 'ArrowUp' || event.key === 'Up') {
      event.preventDefault();
      openSwitchMenu(-1);
    }
  });
  elements.switchMenu.addEventListener('keydown', handleSwitchMenuKeydown);
  document.addEventListener('click', (event) => {
    if (
      !elements.switchMenu.contains(event.target) &&
      !elements.switchButton.contains(event.target)
    ) {
      closeSwitchMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSwitchMenu();
  });
}

function buildSwitchMenu(campaigns) {
  const sorted = sortCampaigns(campaigns);
  const children = [];

  const allLink = element('a', {
    className: 'switch-all',
    href: '?library',
    text: 'All campaigns',
  });
  allLink.setAttribute('role', 'menuitem');
  allLink.tabIndex = -1;
  children.push(allLink);
  children.push(element('div', { className: 'switch-divider', ariaHidden: 'true' }));

  for (const campaign of sorted) {
    const isCurrent = campaign.id === state.id;
    const item = isCurrent
      ? element('div', {
          className: `switch-current switch-item${isComplete(campaign) ? ' complete' : ''}`,
        })
      : element('a', {
          className: `switch-item${isComplete(campaign) ? ' complete' : ''}${campaign.missing ? ' missing' : ''}`,
          href: `?id=${encodeURIComponent(campaign.id)}`,
        });
    if (isCurrent) {
      // Keep the current campaign in the accessibility tree, but mark it
      // disabled so keyboard traversal skips it and screen readers announce
      // it as the active item.
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-disabled', 'true');
      item.setAttribute('aria-current', 'true');
    } else {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
    }

    const text = element('span', { className: 'switch-item-text' });
    text.append(
      element('span', { className: 'switch-title', text: campaign.title || 'Untitled' }),
      element('span', {
        className: 'switch-meta',
        text: switchMetaLine(campaign),
      }),
    );

    if (campaign.hasLogo) {
      item.classList.add('switch-item-with-logo');
      const logo = element('img', { className: 'switch-item-logo', alt: '' });
      logo.src = `/api/registry/icon?id=${encodeURIComponent(campaign.id)}`;
      logo.loading = 'lazy';
      logo.decoding = 'async';
      logo.addEventListener('error', () => {
        logo.remove();
        item.classList.remove('switch-item-with-logo');
      }, { once: true });
      item.append(logo, text);
    } else {
      item.append(text);
    }

    children.push(item);
  }

  elements.switchMenu.replaceChildren(...children);
}

function switchMetaLine(campaign) {
  if (campaign.missing) return 'File missing';
  if (campaign.progress?.total > 0) {
    return isComplete(campaign)
      ? 'All done'
      : `${campaign.progress.done} / ${campaign.progress.total}`;
  }
  return relativeHomePath(campaign.filePath, state.homeDir);
}

function toggleSwitchMenu(options = {}) {
  if (!elements.switchMenu) return;
  if (elements.switchMenu.hidden) {
    openSwitchMenu(options.focusFirst ? 0 : null);
  } else {
    closeSwitchMenu();
  }
}

function openSwitchMenu(focusIndex) {
  if (!elements.switchMenu) return;
  if (elements.switchMenu.hidden) {
    elements.switchMenu.hidden = false;
    elements.switchButton.setAttribute('aria-expanded', 'true');
  }
  if (typeof focusIndex === 'number') focusSwitchMenuItem(focusIndex);
}

function closeSwitchMenu() {
  if (!elements.switchMenu || elements.switchMenu.hidden) return;
  const hadFocusInside = elements.switchMenu.contains(document.activeElement);
  elements.switchMenu.hidden = true;
  elements.switchButton.setAttribute('aria-expanded', 'false');
  // Return focus to the trigger only if it was inside the menu — don't steal
  // focus from whatever the user clicked outside the menu.
  if (hadFocusInside) elements.switchButton.focus();
}

function getSwitchMenuItems() {
  if (!elements.switchMenu) return [];
  return Array.from(
    elements.switchMenu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

function focusSwitchMenuItem(index) {
  const items = getSwitchMenuItems();
  if (items.length === 0) return;
  const wrapped = ((index % items.length) + items.length) % items.length;
  items[wrapped].focus();
}

function handleSwitchMenuKeydown(event) {
  const items = getSwitchMenuItems();
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement);

  switch (event.key) {
    case 'ArrowDown':
    case 'Down':
      event.preventDefault();
      focusSwitchMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
      break;
    case 'ArrowUp':
    case 'Up':
      event.preventDefault();
      focusSwitchMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
      break;
    case 'Tab':
      // Trap Tab inside the open menu so it cycles through items rather than
      // jumping back out to the page tab order. macOS native menus do the same.
      event.preventDefault();
      if (event.shiftKey) {
        focusSwitchMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
      } else {
        focusSwitchMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
      }
      break;
    case 'Home':
      event.preventDefault();
      focusSwitchMenuItem(0);
      break;
    case 'End':
      event.preventDefault();
      focusSwitchMenuItem(items.length - 1);
      break;
    // Enter activates a focused <a> natively — no handler needed.
  }
}

/* ------------------------------ Phase + step extraction ----------------------------- */

function extractPhases(blocks) {
  const phases = [];
  let inChecklist = false;
  let currentPhase = null;

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      inChecklist = block.text.toLowerCase().includes('progress checklist');
      if (currentPhase) {
        phases.push(currentPhase);
        currentPhase = null;
      }
      continue;
    }

    if (!inChecklist) continue;

    if (block.type === 'heading' && block.level === 3) {
      if (currentPhase) phases.push(currentPhase);
      currentPhase = {
        anchorId: block.id,
        children: [],
        done: 0,
        number: extractPhaseNumber(block.text),
        title: stripPhaseTrailing(block.text),
        total: 0,
      };
      continue;
    }

    if (currentPhase) {
      currentPhase.children.push(block);
      if (block.type === 'check') {
        currentPhase.total += 1;
        if (block.checked) currentPhase.done += 1;
      }
      if (block.type === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            const value = cell.content.trim();
            if (value === '☐' || value === '☑') {
              currentPhase.total += 1;
              if (value === '☑') currentPhase.done += 1;
            }
          }
        }
      }
    }
  }

  if (currentPhase) phases.push(currentPhase);

  return phases;
}

function classifyPhases(phases) {
  let foundCurrent = false;
  return phases.map((phase) => {
    let phaseState = 'todo';
    if (phase.total > 0) {
      if (phase.done === phase.total) {
        phaseState = 'done';
      } else if (phase.done > 0) {
        phaseState = 'flight';
      } else if (!foundCurrent) {
        foundCurrent = true;
      }
    }
    return { ...phase, state: phaseState };
  });
}

function extractStepSections(blocks, markdown) {
  const sections = [];
  const lines = markdown != null ? getLines(markdown) : null;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== 'heading' || block.level !== 2) continue;
    const stepMatch = block.text.match(/^step(?:s)?\s+([\d.x–-]+(?:\s*[–-]\s*[\d.x]+)?)/i);
    if (!stepMatch) continue;

    const skill = findSkillNearby(blocks, index);
    const meta = lines ? parseStepMetadata(lines, block.lineStart + 1) : null;
    sections.push({
      anchorId: block.id,
      number: stepMatch[1].replace(/\s+/g, ''),
      skill,
      title: block.text,
      model: meta?.model || null,
      parallel: meta?.parallel || null,
      metaLineStart: meta?.metaLineStart ?? null,
      metaLineEnd: meta?.metaLineEnd ?? null,
    });
  }
  return sections;
}

/**
 * Scan up to the first 5 non-empty lines after a step heading for `Model:`
 * and `Parallel:` metadata lines. Stop as soon as a non-empty line matches
 * neither pattern. Tolerates blank lines between the heading and the
 * metadata, and tolerates the two lines being in reversed order.
 *
 * Returns `{ model, parallel, metaLineStart, metaLineEnd }` — line indices
 * are the first/last line consumed (inclusive), so callers can strip those
 * source lines from the rendered body. `model` / `parallel` are `null` when
 * the corresponding line was absent.
 */
function parseStepMetadata(lines, fromLine) {
  const matched = [];
  let model = null;
  let parallel = null;
  let nonEmptySeen = 0;

  for (let i = fromLine; i < lines.length && nonEmptySeen < 5; i += 1) {
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    nonEmptySeen += 1;

    const modelMatch = raw.match(/^\s*Model:\s*(.*)$/i);
    if (modelMatch) {
      // Strip the source line regardless — even a malformed `Model:` (empty
      // value) shouldn't leak as plain text. Only capture chip data when the
      // value actually parses; otherwise we'll just render no chip.
      matched.push(i);
      if (!model) {
        const parsed = parseModelValue(modelMatch[1]);
        if (parsed) model = parsed;
      }
      continue;
    }

    const parallelMatch = raw.match(/^\s*Parallel:\s*(.*)$/i);
    if (parallelMatch) {
      matched.push(i);
      if (!parallel) {
        const parsed = parseParallelValue(parallelMatch[1]);
        if (parsed) parallel = parsed;
      }
      continue;
    }

    // First non-empty line that matches neither label — stop scanning so the
    // step body never gets eaten.
    break;
  }

  if (matched.length === 0) {
    return { model: null, parallel: null, metaLineStart: null, metaLineEnd: null };
  }

  return {
    model,
    parallel,
    metaLineStart: Math.min(...matched),
    metaLineEnd: Math.max(...matched),
  };
}

function parseModelValue(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return null;
  const segments = value.split(/\s*\/\s*/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  return {
    claudeCode: segments[0] || '',
    codex: segments[1] || '',
  };
}

function parseParallelValue(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return null;
  const isParallel = /^yes\b/i.test(value);
  if (!isParallel) {
    return { isParallel: false, siblingSteps: [] };
  }
  // Strip an optional "YES" / "YES —" / "YES - with" lead-in, then pick up
  // any numeric step references like 2.3 / 2.10 / 12.4. Natural-language
  // separators (`,`, ` and `, ` & `) fall out naturally — we just scan for
  // step numbers and ignore everything else.
  const siblingSteps = [];
  const stepRegex = /(\d+(?:\.\d+)+)/g;
  let match;
  while ((match = stepRegex.exec(value)) !== null) {
    if (!siblingSteps.includes(match[1])) siblingSteps.push(match[1]);
  }
  return { isParallel: true, siblingSteps };
}

function findSkillNearby(blocks, fromIndex) {
  // Look for the first code block within a few siblings that starts with a /skill line.
  for (let index = fromIndex + 1; index < Math.min(blocks.length, fromIndex + 10); index += 1) {
    const block = blocks[index];
    if (block.type === 'heading' && block.level <= 2) break;
    if (block.type !== 'code') continue;
    const firstLine = (block.content || '').split('\n')[0].trim();
    if (firstLine.startsWith('/')) {
      return firstLine.split(/\s+/)[0];
    }
  }
  return '';
}

function findStepForCheck(checkText, stepSections) {
  if (!stepSections || stepSections.length === 0) return null;
  // Tolerate an optional "Step " prefix in the check text. Campaigns commonly
  // write `- [ ] Step 1.1 — Foo` (matching the section heading shape) instead
  // of `- [ ] 1.1 — Foo`, and previously that prefix made this matcher miss
  // every linked step.
  const match = checkText.match(/^(?:step\s+)?([\d.]+(?:\s*[–-]\s*[\d.]+)?)\b/i);
  if (!match) return null;
  const reference = match[1].split(/[–-]/)[0].trim();
  return (
    stepSections.find((section) => section.number === reference) ||
    stepSections.find((section) => section.number.startsWith(reference)) ||
    null
  );
}

function linkChecksToSteps(blocks, stepSections) {
  const map = new Map();
  if (stepSections.length === 0) return map;
  for (const block of blocks) {
    if (block.type !== 'check') continue;
    const linked = findStepForCheck(block.text, stepSections);
    if (linked && !map.has(linked.anchorId)) {
      map.set(linked.anchorId, block);
    }
  }
  return map;
}

function findResumeTarget(blocks, stepSections) {
  // First box that's unchecked.
  let firstCheck = null;
  for (const block of blocks) {
    if (block.type === 'check' && !block.checked) {
      firstCheck = block;
      break;
    }
  }
  if (!firstCheck) return null;

  const linkedStep = findStepForCheck(firstCheck.text, stepSections);
  return {
    checkId: firstCheck.id,
    checkText: firstCheck.text,
    step: linkedStep,
    targetId: linkedStep ? linkedStep.anchorId : firstCheck.id,
  };
}

function extractPhaseNumber(text) {
  const match = text.match(/phase\s+(\d+(?:\.\d+)?)/i);
  return match ? match[1] : '';
}

function stripPhaseTrailing(text) {
  return text.replace(/\s*✅\s*$/, '').trim();
}

/* ------------------------------ Phase grouping for render --------------------------- */

function groupChecklistByPhase(blocks, phases) {
  if (phases.length === 0) return blocks;

  const phaseById = new Map(phases.map((phase) => [phase.anchorId, phase]));
  const result = [];
  let inChecklist = false;
  let currentGroup = null;

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      inChecklist = block.text.toLowerCase().includes('progress checklist');
      result.push(block);
      if (inChecklist) {
        result.push({ type: 'filter-chips' });
      }
      continue;
    }

    if (inChecklist && block.type === 'heading' && block.level === 3) {
      if (currentGroup) result.push(currentGroup);
      const phase = phaseById.get(block.id);
      if (phase) {
        currentGroup = { type: 'phase-group', phase, children: [] };
        continue;
      }
    }

    if (inChecklist && currentGroup) {
      currentGroup.children.push(block);
      continue;
    }

    result.push(block);
  }

  if (currentGroup) result.push(currentGroup);
  return result;
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

function stripFinalReviewBlocks(blocks, finalReview) {
  if (!finalReview) return blocks;
  const drop = new Set();
  drop.add(finalReview.heading);
  if (finalReview.code) drop.add(finalReview.code);
  return blocks.filter((block) => !drop.has(block));
}

/**
 * Remove paragraph blocks whose source lines were consumed as step metadata
 * (`Model:` / `Parallel:`). The chips render the same info under the step
 * heading — we don't want the raw lines duplicating it in the body DOM.
 *
 * Only drop a paragraph if its entire line range is covered by a step's
 * metadata range; otherwise leave it alone (defensive — never eat real body
 * content).
 */
function stripStepMetaBlocks(blocks, stepSections) {
  const ranges = stepSections
    .filter((section) => section.metaLineStart != null && section.metaLineEnd != null)
    .map((section) => ({ start: section.metaLineStart, end: section.metaLineEnd }));
  if (ranges.length === 0) return blocks;

  return blocks.filter((block) => {
    if (block.type !== 'paragraph') return true;
    if (block.lineStart == null || block.lineEnd == null) return true;
    return !ranges.some(
      (range) => block.lineStart >= range.start && block.lineEnd <= range.end,
    );
  });
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

function wrapDocSections(blocks) {
  const result = [];
  let group = null;
  let pastChecklist = false;

  const closeGroup = () => {
    if (group) result.push(group);
    group = null;
  };

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      closeGroup();
      const text = block.text.toLowerCase();
      if (text.includes('progress checklist')) {
        result.push(block);
        pastChecklist = true;
        continue;
      }
      const isReviewProtocol = /review\s+protocol|codex\s+grades/i.test(block.text);
      group = {
        type: 'doc-section',
        sectionId: block.id,
        heading: block,
        children: [],
        defaultOpen: pastChecklist && !isReviewProtocol,
      };
      continue;
    }

    if (
      block.type === 'phase-group' ||
      block.type === 'step-group' ||
      block.type === 'phase-header' ||
      block.type === 'phase-review' ||
      block.type === 'phase-complete' ||
      block.type === 'final-review-card' ||
      block.type === 'work-divider' ||
      block.type === 'filter-chips'
    ) {
      closeGroup();
      result.push(block);
      continue;
    }

    if (group) {
      group.children.push(block);
    } else {
      result.push(block);
    }
  }

  closeGroup();
  return result;
}

function wrapSteps(blocks, stepIds, stepCheckMap) {
  if (stepIds.size === 0) return blocks;
  const result = [];
  let group = null;

  const closeGroup = () => {
    if (group) result.push(group);
    group = null;
  };

  for (const block of blocks) {
    const isStepH2 = block.type === 'heading' && block.level === 2 && stepIds.has(block.id);

    if (isStepH2) {
      closeGroup();
      const check = stepCheckMap.get(block.id);
      group = {
        type: 'step-group',
        stepId: block.id,
        completed: !!(check && check.checked),
        children: [block],
      };
      continue;
    }

    if (
      block.type === 'phase-header' ||
      block.type === 'phase-review' ||
      block.type === 'phase-complete' ||
      block.type === 'final-review-card' ||
      (block.type === 'heading' && block.level === 2)
    ) {
      closeGroup();
      result.push(block);
      continue;
    }

    if (group) {
      group.children.push(block);
    } else {
      result.push(block);
    }
  }

  closeGroup();
  return result;
}

function phaseDescriptiveTitle(title) {
  if (!title) return '';
  return title.replace(/^Phase\s+[\d.]+\s*[—–-]\s*/i, '').trim();
}

function hasCampaignLevelFinalReview(markdown) {
  // New-shape detection: either a `## Final review` H2, or a `- [ ] Final review`
  // checklist line with no `— Phase N` suffix. Either marks the campaign as v2.
  if (/^##\s+final\s+review\s*$/im.test(markdown)) return true;
  if (/^\s*-\s+\[[\sxX]\]\s+final\s+review\s*$/im.test(markdown)) return true;
  return false;
}

function isNewShapeCampaign(blocks) {
  for (const block of blocks) {
    if (
      block.type === 'heading' &&
      block.level === 2 &&
      /^final\s+review\s*$/i.test(block.text)
    ) {
      return true;
    }
    if (block.type === 'check' && /^final\s+review\s*$/i.test(block.text)) {
      return true;
    }
  }
  return false;
}

function ensureFinalReviewLines(markdown) {
  // New-shape campaigns own their Final review — don't auto-add per-phase lines.
  if (hasCampaignLevelFinalReview(markdown)) return markdown;

  const lines = markdown.split('\n');
  const result = [];
  let inChecklist = false;
  let activePhase = null;
  let activePhaseHasFinalReview = false;
  let activePhaseLastBulletInResult = -1;

  const closePhase = () => {
    if (activePhase && !activePhaseHasFinalReview && activePhaseLastBulletInResult >= 0) {
      result.splice(
        activePhaseLastBulletInResult + 1,
        0,
        `- [ ] Final review — Phase ${activePhase}`,
      );
    }
    activePhase = null;
    activePhaseHasFinalReview = false;
    activePhaseLastBulletInResult = -1;
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      const wasInChecklist = inChecklist;
      inChecklist = /^##\s+progress checklist/i.test(line);
      if (wasInChecklist && !inChecklist) closePhase();
      result.push(line);
      continue;
    }

    if (inChecklist) {
      const phaseMatch = line.match(/^###\s+Phase\s+(\d+(?:\.\d+)?)/i);
      if (phaseMatch) {
        closePhase();
        activePhase = phaseMatch[1];
        result.push(line);
        continue;
      }

      const bulletMatch = line.match(/^\s*-\s+\[[\sxX]\]\s+(.+)$/);
      if (bulletMatch) {
        if (/^final review/i.test(bulletMatch[1])) {
          activePhaseHasFinalReview = true;
        }
        result.push(line);
        activePhaseLastBulletInResult = result.length - 1;
        continue;
      }
    }

    result.push(line);
  }

  closePhase();
  return result.join('\n');
}

function linkChecksToPhaseReviews(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type !== 'check') continue;
    const m = block.text.match(/^final\s+review.*?phase\s+(\d+(?:\.\d+)?)/i);
    if (!m) continue;
    const anchorId = `phase-review-${m[1]}`;
    if (!map.has(anchorId)) map.set(anchorId, block);
  }
  return map;
}

function findCampaignFinalReviewCheck(blocks) {
  for (const block of blocks) {
    if (block.type === 'check' && /^final\s+review\s*$/i.test(block.text)) {
      return block;
    }
  }
  return null;
}

function extractFinalReview(blocks) {
  // Locate `## Final review` (level 2, case-insensitive) and the first fenced
  // code block that appears between it and the next H2 (or end of document).
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (
      block.type !== 'heading' ||
      block.level !== 2 ||
      !/^final\s+review\s*$/i.test(block.text)
    ) {
      continue;
    }
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j];
      if (next.type === 'heading' && next.level === 2) break;
      if (next.type === 'code') {
        return { heading: block, code: next };
      }
    }
    return { heading: block, code: null };
  }
  return null;
}

function findCheckLinkTarget(checkText, stepSections) {
  if (/^final\s+review\s*$/i.test(checkText)) {
    return { anchorId: 'campaign-review' };
  }
  if (/^final\s+review/i.test(checkText)) {
    const m = checkText.match(/phase\s+(\d+(?:\.\d+)?)/i);
    if (m) return { anchorId: `phase-review-${m[1]}` };
    return null;
  }
  const step = findStepForCheck(checkText, stepSections);
  return step ? { anchorId: step.anchorId } : null;
}

/* ------------------------------ Markdown parser ------------------------------------- */

function parseMarkdown(markdown) {
  const lines = getLines(markdown);
  const blocks = [];
  let index = 0;
  let codeCount = 0;
  let checkCount = 0;
  let headingCount = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      const start = index;
      const content = [];
      index += 1;

      while (index < lines.length && !lines[index].match(/^\s*```\s*$/)) {
        content.push(lines[index]);
        index += 1;
      }

      const end = index < lines.length ? index : lines.length - 1;
      blocks.push({
        content: content.join('\n'),
        id: `prompt-${codeCount}`,
        lang: fenceMatch[1].trim(),
        lineEnd: end,
        lineStart: start,
        type: 'code',
      });
      codeCount += 1;
      index = end + 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const text = stripTrailingHashes(headingMatch[2].trim());
      const level = headingMatch[1].length;
      blocks.push({
        id: `${slugify(text)}-${headingCount}`,
        level,
        lineEnd: index,
        lineStart: index,
        text,
        type: 'heading',
      });
      headingCount += 1;
      index += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push({ lineEnd: index, lineStart: index, type: 'hr' });
      index += 1;
      continue;
    }

    const checkMatch = line.match(CHECK_LINE_REGEX);
    if (checkMatch) {
      blocks.push({
        checked: checkMatch[2].toLowerCase() === 'x',
        id: `check-${checkCount}`,
        lineEnd: index,
        lineStart: index,
        text: checkMatch[4],
        type: 'check',
      });
      checkCount += 1;
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const start = index;
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;

      while (index < lines.length && isTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }

      blocks.push(parseTable(tableLines, start));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = index;
      const quoteLines = [];

      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }

      blocks.push({
        lineEnd: index - 1,
        lineStart: start,
        text: quoteLines.join('\n'),
        type: 'quote',
      });
      continue;
    }

    if (isListLine(line)) {
      const start = index;
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];

      while (index < lines.length && isListLine(lines[index]) && !isCheckLine(lines[index])) {
        const itemText = lines[index].replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
        items.push({ text: itemText });
        index += 1;
      }

      blocks.push({
        items,
        lineEnd: index - 1,
        lineStart: start,
        ordered,
        type: 'list',
      });
      continue;
    }

    const start = index;
    const paragraphLines = [];

    while (index < lines.length && lines[index].trim() !== '' && !isSpecialLine(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    blocks.push({
      lineEnd: index - 1,
      lineStart: start,
      text: paragraphLines.join(' '),
      type: 'paragraph',
    });
  }

  return blocks;
}

function isSpecialLine(lines, index) {
  const line = lines[index];
  return Boolean(
    line.match(/^\s*```/) ||
      line.match(/^(#{1,6})\s+(.+)$/) ||
      line.match(/^\s*---+\s*$/) ||
      isCheckLine(line) ||
      isTableStart(lines, index) ||
      /^\s*>/.test(line) ||
      isListLine(line),
  );
}

function isCheckLine(line) {
  return CHECK_LINE_REGEX.test(line);
}

function isListLine(line) {
  return /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

function isTableStart(lines, index) {
  return (
    isTableRow(lines[index]) &&
    Boolean(lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/))
  );
}

function isTableRow(line) {
  return /^\s*\|.+\|\s*$/.test(line);
}

function parseTable(tableLines, startLine) {
  const headers = parseTableCells(tableLines[0]);
  const rows = tableLines.slice(2).map((line, offset) => ({
    cells: parseTableCells(line),
    lineIndex: startLine + offset + 2,
  }));

  return {
    headers,
    lineEnd: startLine + tableLines.length - 1,
    lineStart: startLine,
    rows,
    type: 'table',
  };
}

function parseTableCells(line) {
  const cells = [];
  let start = line.startsWith('|') ? 1 : 0;

  for (let index = start; index <= line.length; index += 1) {
    if (line[index] === '|' || index === line.length) {
      cells.push({
        content: line.slice(start, index),
        end: index,
        start,
      });
      start = index + 1;
    }
  }

  if (cells.at(-1)?.content === '') {
    cells.pop();
  }

  return cells;
}

function getProgressStats(blocks) {
  let total = 0;
  let done = 0;

  for (const block of progressChecklistBlocks(blocks)) {
    if (block.type === 'check') {
      total += 1;
      done += block.checked ? 1 : 0;
    }

    if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          const value = cell.content.trim();

          if (value === '☐' || value === '☑') {
            total += 1;
            done += value === '☑' ? 1 : 0;
          }
        }
      }
    }
  }

  return { done, total };
}

function progressChecklistBlocks(blocks) {
  const start = blocks.findIndex((block) => (
    block.type === 'heading' &&
    block.level === 2 &&
    block.text.toLowerCase().includes('progress checklist')
  ));
  if (start === -1) return blocks;

  const scoped = [];
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'heading' && block.level === 2) break;
    scoped.push(block);
  }
  return scoped;
}

function inlineMarkdown(text) {
  const codeSpans = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  for (let index = 0; index < codeSpans.length; index += 1) {
    html = html.replace(`@@CODE_${index}@@`, codeSpans[index]);
  }

  return html;
}

function element(tagName, options = {}) {
  const node = document.createElement(tagName);

  if (options.className) {
    node.className = options.className;
  }

  if (options.id) {
    node.id = options.id;
  }

  if (options.type) {
    node.type = options.type;
  }

  if (options.text !== undefined) {
    node.textContent = options.text;
  }

  if (options.html !== undefined) {
    node.innerHTML = options.html;
  }

  if (options.href) {
    node.href = options.href;
  }

  if (options.download) {
    node.download = options.download;
  }

  if (options.title) {
    node.title = options.title;
  }

  if (options.ariaLabel) {
    node.setAttribute('aria-label', options.ariaLabel);
  }

  if (options.ariaPressed) {
    node.setAttribute('aria-pressed', options.ariaPressed);
  }

  if (options.ariaHidden) {
    node.setAttribute('aria-hidden', options.ariaHidden);
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = String(value);
    }
  }

  return node;
}

function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

function getLines(markdown = state.markdown) {
  return normalizeNewlines(markdown).split('\n');
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function stripTrailingHashes(value) {
  return value.replace(/\s+#+$/, '');
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return value.replace(/"/g, '\\"');
}

function fileNameFromPath(filePath) {
  return filePath.split(/[\\/]/).pop();
}

function formatTime(isoString) {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function showToast(message, duration = 2600) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, duration);
}

/* ------------------------------ Prefs ----------------------------------------------- */

function defaultPrefs() {
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

function sanitizePrefs(parsed) {
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

function normalizeTheme(theme) {
  if (typeof theme !== 'string') return 'default';
  const normalized = LEGACY_THEME_MAP[theme] ?? theme;
  return THEME_KEYS.has(normalized) ? normalized : 'default';
}

function applyStandardCampaignSettings(prefs) {
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

function migrateStandardCampaignSettings(allPrefs) {
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

function loadLibraryExpandedCollections() {
  try {
    const raw = localStorage.getItem(LIBRARY_COLLECTIONS_EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string' && id.trim() !== ''));
  } catch {
    return new Set();
  }
}

function saveLibraryExpandedCollections() {
  try {
    localStorage.setItem(
      LIBRARY_COLLECTIONS_EXPANDED_KEY,
      JSON.stringify([...state.libraryExpandedCollections]),
    );
  } catch {
    /* ignore */
  }
}

function loadPrefs(filePath) {
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

function todayDateString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function recordTodayActivity(currentDoneCount) {
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

function todayDelta(currentDoneCount) {
  if (state.prefs.today.date !== todayDateString()) return 0;
  return Math.max(0, currentDoneCount - state.prefs.today.startCount);
}

function extractCheckRef(line) {
  const match = line.match(/^\s*[-*]\s+\[[\sxX]\]\s+([\d.]+(?:\s*[–-]\s*[\d.]+)?)/);
  return match ? match[1].replace(/\s+/g, '') : '';
}

function recordSessionTick(checkRef) {
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

function savePrefs() {
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

function trapDialogFocus(event, container) {
  const focusable = Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((node) => node instanceof HTMLElement && node.offsetParent !== null);

  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function applyTheme(theme) {
  const themes = [
    'theme-blueprint',
    'theme-cyberpunk',
    'theme-forest',
    'theme-graphite',
    'theme-obsidian',
    'theme-signal',
    'theme-sunset',
  ];
  themes.forEach(cls => document.body.classList.remove(cls));
  const selectedTheme = normalizeTheme(theme);
  if (selectedTheme !== 'default') {
    document.body.classList.add(`theme-${selectedTheme}`);
  }
}

let audioCtx = null;

function playAudioFeedback(type) {
  if (!state.prefs.soundEffectsEnabled) return;

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'tick') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, audioCtx.currentTime + 0.05);

      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.05);
    } else if (type === 'success') {
      const now = audioCtx.currentTime;
      const notes = [261.63, 329.63, 392.00, 523.25];
      
      notes.forEach((freq, idx) => {
        const oscNode = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscNode.type = 'triangle';
        oscNode.frequency.setValueAtTime(freq, now + idx * 0.08);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.12, now + idx * 0.08 + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.4);
        
        oscNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscNode.start(now + idx * 0.08);
        oscNode.stop(now + idx * 0.08 + 0.45);
      });
    }
  } catch (error) {
    console.warn('Web Audio playback failed:', error);
  }
}

let confettiActive = false;
let confettiParticles = [];

function triggerConfetti(intensity = 'phase') {
  if (!state.prefs.celebrationsEnabled) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (confettiActive) return;

  const canvas = document.querySelector('#confetti-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const handleResize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', handleResize);

  confettiParticles = [];
  const particleCount = intensity === 'campaign' ? 110 : 44;
  const colors = confettiPalette();
  for (let i = 0; i < particleCount; i++) {
    confettiParticles.push({
      x: Math.random() * canvas.width,
      y: intensity === 'campaign'
        ? Math.random() * canvas.height - canvas.height
        : Math.random() * -160,
      r: Math.random() * 5 + 3,
      d: Math.random() * canvas.height,
      color: colors[Math.floor(Math.random() * colors.length)],
      tilt: Math.random() * 10 - 5,
      tiltAngleIncremental: Math.random() * 0.07 + 0.02,
      tiltAngle: 0
    });
  }

  confettiActive = true;

  let frameCount = 0;
  const maxFrames = intensity === 'campaign' ? 170 : 95;

  function draw() {
    if (!confettiActive) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let living = false;
    for (let i = 0; i < confettiParticles.length; i++) {
      const p = confettiParticles[i];
      p.tiltAngle += p.tiltAngleIncremental;
      p.y += (Math.cos(p.d) + 3 + p.r / 2) * 0.7;
      p.x += Math.sin(p.tiltAngle) * 0.5;
      p.tilt = Math.sin(p.tiltAngle - (i / 3)) * 15;

      if (p.y < canvas.height) {
        living = true;
      }

      ctx.beginPath();
      ctx.lineWidth = p.r;
      ctx.strokeStyle = p.color;
      ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
      ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
      ctx.stroke();
    }

    frameCount++;
    if (living && frameCount < maxFrames) {
      requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confettiActive = false;
      window.removeEventListener('resize', handleResize);
    }
  }

  requestAnimationFrame(draw);
}

function confettiPalette() {
  const styles = getComputedStyle(document.body);
  const fromVar = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return [
    fromVar('--accent', '#0b66d8'),
    fromVar('--ink', '#121212'),
    fromVar('--done', '#a9a49c'),
    '#f0c36a',
    '#7fb7a6',
  ];
}

async function sendConfiguredNotifications(title, message) {
  const deliveries = [];
  const ntfyTopic = NTFY_TOPIC_REGEX.test(state.prefs.ntfyTopic || '')
    ? state.prefs.ntfyTopic
    : '';

  if (state.prefs.macNotificationsEnabled) {
    deliveries.push(
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
      }).then((response) => {
        if (!response.ok) throw new Error(`Mac notification failed (${response.status}).`);
        return response;
      }),
    );
  }

  if (ntfyTopic || state.prefs.webhookUrl) {
    deliveries.push(
      postRemoteNotification({
        title,
        message,
        ntfyTopic,
        webhookUrl: state.prefs.webhookUrl,
      }),
    );
  }

  const results = await Promise.allSettled(deliveries);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('Notification delivery failed:', result.reason);
    }
  }
}

async function postRemoteNotification(payload) {
  const response = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.ok) return response.json().catch(() => ({ ok: true }));

  let errorMessage = 'Notification failed.';
  try {
    const errorPayload = await response.json();
    errorMessage = errorPayload.error || errorPayload.failures?.[0]?.error || errorMessage;
  } catch {
    /* keep generic message */
  }
  throw new Error(errorMessage);
}

function campaignDisplayTitle() {
  const heading = elements.documentTitle?.textContent?.trim();
  return heading || fileNameFromPath(state.filePath) || 'Campaign';
}

async function handleCompletionEffects(prevPhases, nextPhases, prevStats, nextStats) {
  let completedPhase = null;
  for (const nextP of nextPhases) {
    const prevP = prevPhases.find(p => p.anchorId === nextP.anchorId);
    if (nextP.total > 0 && nextP.done === nextP.total) {
      if (!prevP || prevP.done < prevP.total) {
        completedPhase = nextP;
      }
    }
  }

  const isCampaignCompleted = nextStats.total > 0 && nextStats.done === nextStats.total && (prevStats.done < prevStats.total);

  if (isCampaignCompleted) {
    playAudioFeedback('success');
    triggerConfetti('campaign');
    if (shouldSendBrowserCompletionNotification()) {
      const message = `${campaignDisplayTitle()} is 100% complete.`;
      sendConfiguredNotifications('Campaign complete', message);
    }
  } else if (completedPhase) {
    playAudioFeedback('success');
    triggerConfetti('phase');
    if (shouldSendBrowserCompletionNotification()) {
      const message = `Phase "${completedPhase.title}" is now complete (${completedPhase.done}/${completedPhase.total} tasks).`;
      sendConfiguredNotifications('Phase complete', message);
    }
  }
}

function shouldSendBrowserCompletionNotification() {
  return !isAutomateRunning(automateState.current) && !isAutomateScheduled(automateState.current);
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

const automateState = {
  bulk: {},
  current: null,
  libraryTimer: null,
  campaignTimer: null,
  elapsedTimer: null,
};

let automateVisibilityBound = false;
const AUTOMATE_ATTENTION_STATUSES = new Set(['stalled', 'halted', 'failed', 'blocked']);
const AUTOMATE_SCHEDULED_STATUSES = new Set(['queued', 'scheduled']);

function automateDisplayStatus(data) {
  if (!data?.status) return null;
  if (data.status === 'active' && data.is_active === false) return 'stalled';
  return data.status;
}

function isAutomateRunning(data) {
  return automateDisplayStatus(data) === 'active';
}

function isAutomateAttention(data) {
  const status = automateDisplayStatus(data);
  return AUTOMATE_ATTENTION_STATUSES.has(status);
}

function isAutomateScheduled(data) {
  const status = automateDisplayStatus(data);
  return AUTOMATE_SCHEDULED_STATUSES.has(status);
}

function automateIndicator(status, extraClass = '') {
  const indicatorType = status === 'active'
    ? 'running'
    : status === 'completed'
      ? 'complete'
      : AUTOMATE_ATTENTION_STATUSES.has(status)
        ? 'attention'
        : 'idle';
  const className = [
    'automate-indicator',
    `automate-indicator--${indicatorType}`,
    extraClass,
  ].filter(Boolean).join(' ');
  const node = element('span', { className, ariaHidden: 'true' });
  if (indicatorType === 'attention') node.textContent = '!';
  if (indicatorType === 'complete') node.textContent = '✓';
  return node;
}

function libraryAutomationIndicatorStatus(data) {
  const status = automateDisplayStatus(data);
  if (status === 'active') return 'active';
  if (AUTOMATE_SCHEDULED_STATUSES.has(status)) return status;
  if (AUTOMATE_ATTENTION_STATUSES.has(status)) return status;
  return null;
}

function libraryAutomationCardStatus(data) {
  const status = libraryAutomationIndicatorStatus(data);
  if (!status) return null;

  const unitLabel = formatAutomateUnitLabel({ id: data.current_step_id });
  const step = unitLabel === 'Automation' ? '' : ` · ${unitLabel}`;
  const isChecking = status === 'stalled' && data.has_active_run;
  const isScheduled = AUTOMATE_SCHEDULED_STATUSES.has(status);
  const text = status === 'active'
    ? `Running${step}`
    : isScheduled
      ? `Scheduled${step}`
    : isChecking
      ? `Checking${step}`
      : `Needs attention${step}`;

  return {
    status,
    text,
    title: [data.current_step_name, data.attention?.title].filter(Boolean).join('\n'),
    attention: status === 'active' && data.attention?.level === 'history' ? data.attention : null,
  };
}

function buildLibraryAutomationStatus(summary) {
  const node = element('span', { className: 'library-card-automate-status' });
  node.append(
    automateIndicator(summary.status),
    element('span', { className: 'library-card-automate-text', text: summary.text }),
  );
  if (summary.attention) {
    const warning = automateIndicator('failed', 'library-card-automate-warning');
    warning.title = summary.attention.title || summary.attention.label || 'Warning history';
    node.append(warning);
  }
  node.title = summary.title || summary.text;
  return node;
}

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

function updateLibraryDots() {
  const collectionNodes = document.querySelectorAll(
    '.library-collection-card[data-campaign-ids], .library-collection-section[data-campaign-ids]',
  );
  for (const node of collectionNodes) {
    updateLibraryCollectionIndicator(node);
  }

  const cards = document.querySelectorAll('.library-card[data-campaign-id]');
  for (const card of cards) {
    card.querySelector('.library-card-automate-dot')?.remove();
    card.querySelector('.library-card-automate-status')?.remove();
    card.querySelector('.library-card-away-button')?.remove();
    if (card.classList.contains('library-collection-card') || card.classList.contains('complete')) continue;
    const link = card.querySelector('.library-card-link');
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const match = href.match(/[?&]id=([^&]+)/);
    if (!match) continue;
    const id = decodeURIComponent(match[1]);
    const entry = automateState.bulk[id];

    const cardStatus = libraryAutomationCardStatus(entry);
    if (!cardStatus) continue;

    const status = buildLibraryAutomationStatus(cardStatus);
    const time = link.querySelector('.library-card-time');
    if (time) {
      link.insertBefore(status, time);
    } else {
      link.append(status);
    }

    // Away affordance only while this campaign is actively running.
    if (cardStatus.status === 'active') {
      const title = card.querySelector('.library-card-title')?.textContent?.trim() || awayHumanizeId(id);
      card.append(awayEntryButton('', () => openAwayMode({ mode: 'campaign', ids: [id], title }), 'library-card-away-button'));
    }
  }

  updateAwayAllButton();
}

function updateLibraryCollectionIndicator(node) {
  node
    .querySelectorAll('.library-collection-automate-status, .library-collection-away-button')
    .forEach((existing) => existing.remove());

  const ids = (node.dataset.campaignIds || '').split(/\s+/).filter(Boolean);
  const summary = collectionAutomationSummary(ids);
  if (!summary) return;

  const status = element('span', { className: 'library-collection-automate-status' });
  status.append(
    automateIndicator(summary.indicatorStatus),
    element('span', { text: summary.text }),
  );
  status.title = summary.title;

  // Away from the stack while any campaign in it is running. Pass all ids so
  // the overlay can split active windows from ignored attention campaigns.
  if (awayActiveIdsIn(ids).length) {
    const stackTitle = node.querySelector('.library-collection-title, .library-card-title')?.textContent?.trim() || 'Stack';
    status.append(awayEntryButton('', () => openAwayMode({ mode: 'stack', ids, title: stackTitle }), 'library-collection-away-button'));
  }

  if (node.classList.contains('library-collection-section')) {
    const header = node.querySelector('.library-collection-header');
    const collapse = header?.querySelector('.library-collection-collapse');
    if (header && collapse) {
      header.insertBefore(status, collapse);
      return;
    }
  }

  const time = node.querySelector('.library-card-time');
  if (time) {
    node.insertBefore(status, time);
  } else {
    node.append(status);
  }
}

function collectionAutomationSummary(campaignIds) {
  const counts = {
    active: 0,
    scheduled: 0,
    attention: 0,
  };
  const titles = [];

  for (const id of campaignIds) {
    const entry = automateState.bulk[id];
    const status = libraryAutomationIndicatorStatus(entry);
    if (!status) continue;

    if (status === 'active') {
      counts.active += 1;
    } else if (AUTOMATE_SCHEDULED_STATUSES.has(status)) {
      counts.scheduled += 1;
    } else {
      counts.attention += 1;
    }
    titles.push(entry?.current_step_name || status);
  }

  if (counts.active === 0 && counts.scheduled === 0 && counts.attention === 0) return null;

  const parts = [];
  if (counts.active > 0) {
    parts.push(`${counts.active} running`);
  }
  if (counts.scheduled > 0) {
    parts.push(`${counts.scheduled} scheduled`);
  }
  if (counts.attention > 0) {
    parts.push(`${counts.attention} attention`);
  }

  return {
    indicatorStatus: counts.active > 0 ? 'active' : counts.attention > 0 ? 'failed' : 'queued',
    text: parts.join(' · '),
    title: titles.join('\n'),
  };
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

function formatAutomateUnitLabel(unit) {
  const id = unit?.id ? String(unit.id) : '';
  if (!id) return 'Automation';
  if (/^\d+(?:\.\d+)*$/.test(id)) return `Step ${id}`;
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
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

const ETA_STEP_BASELINES = Object.freeze({
  claude: { label: 'Claude', sample: 662, median: 12.9, p75: 18.1, p90: 23.6, gapPerStep: 0 },
  codex: { label: 'Codex', sample: 100, median: 6.1, p75: 8.8, p90: 11, gapPerStep: 12 },
  default: { label: 'Campaign history', sample: 0, median: 10, p75: 16, p90: 24, gapPerStep: 0 },
});

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

// One-line readout of the closest-fitting task(s) for the drawer panel. Keeps
// the inline panel honest without rebuilding the whole matcher UI there.
function awayBestFitHint(windowMin) {
  if (!windowMin || windowMin <= 0) return 'Too tight for an away task — stay nearby.';
  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  const matches = awayMatchTasks(windowMin, tasks, logs);
  if (!matches.length) return 'Nothing in your task library fits yet — add a shorter task.';
  const best = matches[0];
  const names = best.tasks.map((t) => t.name).join(' + ');
  const fit = best.overage ? `${best.overage}m over` : `${best.leftover}m spare`;
  return `Best fit: ${names} (${best.total}m, ${fit}).`;
}

function estimateAutomateWait(data) {
  const window = awayStepWindow(data);
  if (!window) return null;

  const { baseline, elapsed, overTypical, minutes: safeAway, confidence } = window;
  const stepLow = Math.max(0, Math.round(baseline.median - elapsed));
  const stepHigh = Math.max(stepLow, Math.round(baseline.p90 - elapsed));
  const phase = estimateCurrentPhase(data, baseline, stepLow);

  return {
    baseline,
    confidence,
    safeAway,
    overTypical,
    windowLabel: overTypical ? 'Stay nearby' : formatAwayWindow(safeAway),
    stepRangeLabel: overTypical ? 'past usual range' : formatMinuteRange(stepLow, stepHigh),
    phaseWindowLabel: phase ? `~${formatWholeMinutes(phase.center)}` : '',
  };
}

// Confidence-driven safety buffer (minutes) subtracted from the p75 window.
// Tighter when we trust the sample, looser when we don't. Matches the ETA
// research: Claude pool is high-confidence (n=662), Codex medium (n=100).
const AWAY_SAFETY_BUFFER = Object.freeze({ high: 2, medium: 3, low: 5 });

// The one safe-window calculation, shared by the drawer readout and Away Mode.
// Accepts either a full automate state ({current_step:{started_at}}) or a bulk
// summary entry ({current_step_started_at}). safe_window = p75 - elapsed - buffer.
function awayStepWindow(stateLike) {
  if (!stateLike || !isAutomateRunning(stateLike)) return null;
  const startedAt = stateLike.current_step?.started_at ?? stateLike.current_step_started_at ?? null;
  const elapsed = startedAt == null ? null : minutesSince(startedAt);
  if (elapsed == null) return null;

  const backend = String(stateLike.backend || 'default').toLowerCase();
  const baseline = etaBaselineForBackend(backend);
  const confidence = etaConfidence(baseline);
  const buffer = AWAY_SAFETY_BUFFER[confidence] ?? 3;
  return {
    minutes: Math.max(0, Math.floor(baseline.p75 - elapsed - buffer)),
    confidence,
    baseline,
    backend,
    eta_cell_used: `backend:${backend}`,
    eta_predicted_low: baseline.median,
    eta_predicted_median: baseline.p75,
    eta_predicted_high: baseline.p90,
    elapsed,
    overTypical: elapsed >= baseline.p90,
  };
}

function etaBaselineForBackend(backend) {
  return ETA_STEP_BASELINES[String(backend || '').toLowerCase()] || ETA_STEP_BASELINES.default;
}

function etaConfidence(baseline) {
  if (baseline.sample >= 300) return 'high';
  if (baseline.sample >= 75) return 'medium';
  return 'low';
}

function minutesSince(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 60_000);
}

function formatAwayWindow(minutes) {
  if (minutes < 5) return 'Check soon';
  if (minutes < 10) return '5m reset';
  if (minutes < 20) return '10-15m task';
  if (minutes < 30) return '20m task';
  if (minutes < 45) return '30m task';
  if (minutes < 75) return '45m task';
  return 'Deep block';
}

function formatMinuteRange(low, high) {
  const a = Math.max(0, Math.round(low));
  const b = Math.max(a, Math.round(high));
  if (b === 0) return '<1m';
  if (a === 0) return `under ${b}m`;
  if (a === b) return `${a}m`;
  return `${a}-${b}m`;
}

function formatWholeMinutes(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const remain = rounded % 60;
  return remain ? `${hours}h ${remain}m` : `${hours}h`;
}

function estimateCurrentPhase(data, baseline, currentStepLow) {
  const step = data.current_step;
  const phase = step.phase ?? phaseFromStepId(step.id);
  if (!phase || !Array.isArray(data.steps)) return null;

  const phaseSteps = data.steps.filter((item) => {
    const itemPhase = item.phase ?? phaseFromStepId(item.id);
    return String(itemPhase) === String(phase) && item.status !== 'done';
  });
  if (phaseSteps.length <= 1) return null;

  const remainingAfterCurrent = Math.max(0, phaseSteps.length - 1);
  return {
    center: currentStepLow + remainingAfterCurrent * (baseline.median + baseline.gapPerStep),
  };
}

function phaseFromStepId(id) {
  const value = String(id || '');
  const match = value.match(/^(\d+)\./);
  return match ? match[1] : null;
}

/* ------------------------------ Away Mode --------------------------------- */
// "Can I leave the screen now, for how long, and what real-life task fits?"
// Local-first task library + deterministic matcher + a pause-aware timer.
// Reachable from the drawer, a campaign card, a stack, or all running
// campaigns. Windows are backend-only (ETA_STEP_BASELINES) — no AI, no tags.

const AWAY_TASKS_KEY = 'campaigns:awayTasks:v1';
const AWAY_LOGS_KEY = 'campaigns:awayLogs:v1';
// Transition buffer between tasks in a combo. Kept 0: the safe window already
// subtracts a confidence-based safety buffer from p75, so adding switch-time
// slack on top would double-count it. (Spec allows 0m or 2m.)
const AWAY_TRANSITION_BUFFER = 0;
const AWAY_OVERAGE_TOLERANCE_MIN = 5;
const AWAY_MAX_SUGGESTIONS = 6;
const AWAY_COMBO_TASK_CAP = 12;   // bound combinatorics for the matcher
const AWAY_DEFAULT_TASKS = [
  { name: 'Laundry', estimated_min: 15 },
  { name: 'Dishes', estimated_min: 12 },
  { name: 'Tidy desk', estimated_min: 8 },
];

/* --- storage --- */

function awayStorageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function awayStorageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — Away Mode still works in-session */
  }
}

function loadAwayTasks() {
  const stored = awayStorageGet(AWAY_TASKS_KEY);
  if (Array.isArray(stored)) return stored.filter((t) => t && t.id && t.name);
  // First run only: seed a few starters so matching isn't empty. Once the key
  // exists (even as []), we respect the user's list and never reseed.
  const seeded = AWAY_DEFAULT_TASKS.map((t) => ({ id: awayId(), name: t.name, estimated_min: t.estimated_min }));
  saveAwayTasks(seeded);
  return seeded;
}

function saveAwayTasks(tasks) {
  awayStorageSet(AWAY_TASKS_KEY, tasks);
}

function loadAwayLogs() {
  const stored = awayStorageGet(AWAY_LOGS_KEY);
  return Array.isArray(stored) ? stored : [];
}

function appendAwayLog(log) {
  const logs = loadAwayLogs();
  logs.push(log);
  awayStorageSet(AWAY_LOGS_KEY, logs);
}

function awayId() {
  return `t_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function awayAddTask(name, minutes) {
  const trimmed = String(name || '').trim();
  const est = Math.round(Number(minutes));
  if (!trimmed || !Number.isFinite(est) || est <= 0) return null;
  const tasks = loadAwayTasks();
  const task = { id: awayId(), name: trimmed.slice(0, 60), estimated_min: est };
  tasks.push(task);
  saveAwayTasks(tasks);
  return task;
}

function awayDeleteTask(id) {
  saveAwayTasks(loadAwayTasks().filter((t) => t.id !== id));
}

/* --- estimates + matching (deterministic, no AI) --- */

function awayMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function awayTaskLogCount(task, logs) {
  return logs.filter(
    (l) => l.status === 'completed' && Array.isArray(l.task_ids) && l.task_ids.length === 1 && l.task_ids[0] === task.id,
  ).length;
}

// >= 3 completed single-task logs → median actual; otherwise the user estimate.
function awayEffectiveEstimate(task, logs) {
  const actuals = logs
    .filter((l) => l.status === 'completed' && Array.isArray(l.task_ids) && l.task_ids.length === 1 && l.task_ids[0] === task.id)
    .map((l) => Number(l.actual_min))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (actuals.length >= 3) return Math.max(1, Math.round(awayMedian(actuals)));
  return task.estimated_min;
}

function awayTaskIsAdaptive(task, logs) {
  return awayTaskLogCount(task, logs) >= 3;
}

// Singles + 2/3-task combos that fit the window, plus near-fits within a small
// tolerance. Sorted by closest fit; exact/under-window choices win ties.
function awayMatchTasks(windowMin, tasks, logs) {
  if (!Number.isFinite(windowMin) || windowMin <= 0) return [];
  const items = tasks
    .map((t) => ({ task: t, est: awayEffectiveEstimate(t, logs) }))
    .filter((it) => Number.isFinite(it.est) && it.est > 0)
    .slice(0, AWAY_COMBO_TASK_CAP);

  const out = [];
  const consider = (combo) => {
    const total = combo.reduce((s, it) => s + it.est, 0) + AWAY_TRANSITION_BUFFER * (combo.length - 1);
    if (total > windowMin + AWAY_OVERAGE_TOLERANCE_MIN) return;
    const overage = Math.max(0, total - windowMin);
    out.push({
      tasks: combo.map((it) => it.task),
      ids: combo.map((it) => it.task.id),
      total,
      leftover: windowMin - total,
      overage,
    });
  };

  for (let i = 0; i < items.length; i += 1) {
    consider([items[i]]);
    for (let j = i + 1; j < items.length; j += 1) {
      consider([items[i], items[j]]);
      for (let k = j + 1; k < items.length; k += 1) {
        consider([items[i], items[j], items[k]]);
      }
    }
  }

  out.sort(
    (a, b) =>
      Math.abs(a.leftover) - Math.abs(b.leftover) ||
      a.overage - b.overage ||
      a.tasks.length - b.tasks.length,
  );
  return out.slice(0, AWAY_MAX_SUGGESTIONS);
}

/* --- window resolution (single + multi campaign) --- */

function awayCurrentCampaignTitle() {
  return document.getElementById('document-title')?.textContent?.trim() || 'This campaign';
}

function awayStateForId(id) {
  if (id && id === state.id && automateState.current) return automateState.current;
  return automateState.bulk?.[id] ?? null;
}

function awayTitleMap() {
  const map = {};
  document.querySelectorAll('.library-card[data-campaign-id]').forEach((card) => {
    const id = card.dataset.campaignId;
    const title = card.querySelector('.library-card-title')?.textContent?.trim();
    if (id && title) map[id] = title;
  });
  return map;
}

function awayHumanizeId(id) {
  return String(id || 'Campaign').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function awayIsMulti(source) {
  return Boolean(source) && (source.mode === 'stack' || source.mode === 'all');
}

// Available window for a set of campaign ids. Open campaign uses its full
// state; the rest use the polled bulk summary — so stack/all-running need no
// extra requests. Window = the limiting (active) campaign; attention campaigns
// are reported separately and never counted (min over active windows).
function awayResolveWindow(source) {
  const titles = awayTitleMap();
  const active = [];
  const attention = [];

  for (const id of source?.ids || []) {
    const stateLike = awayStateForId(id);
    if (!stateLike) continue;
    const title = (id === state.id ? awayCurrentCampaignTitle() : null) || titles[id] || awayHumanizeId(id);
    if (isAutomateAttention(stateLike)) {
      attention.push({ id, title, status: automateDisplayStatus(stateLike) });
      continue;
    }
    const window = awayStepWindow(stateLike);
    if (window) active.push({ id, title, ...window });
  }

  if (!active.length) {
    return { available: null, confidence: null, limiting: null, active, attention };
  }
  const limiting = active.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  return {
    available: limiting.minutes,
    confidence: limiting.confidence,
    overTypical: active.every((a) => a.overTypical),
    limiting,
    active,
    attention,
  };
}

/* --- timer (pause-aware; paused time never counts) --- */

const awayTimer = {
  running: false,
  taskIds: [],
  taskNames: [],
  estimatedMin: 0,
  startedAt: null,    // ISO of first start
  accumulatedMs: 0,   // active ms banked before the current running segment
  segmentStart: null, // epoch ms of current running segment, or null when paused
  source: null,       // {mode, campaign_ids, scope, eta_window_min, confidence}
  intervalId: null,
};

function awayTimerActiveMs() {
  const live = awayTimer.running && awayTimer.segmentStart ? Date.now() - awayTimer.segmentStart : 0;
  return awayTimer.accumulatedMs + live;
}

function awayTimerArmed() {
  return awayTimer.running || awayTimer.accumulatedMs > 0;
}

function awayStartTimer(combo, windowInfo, source) {
  awayStopTicker();
  awayTimer.running = true;
  awayTimer.taskIds = combo.ids;
  awayTimer.taskNames = combo.tasks.map((t) => t.name);
  awayTimer.estimatedMin = combo.total;
  awayTimer.startedAt = new Date().toISOString();
  awayTimer.accumulatedMs = 0;
  awayTimer.segmentStart = Date.now();
  awayTimer.source = {
    mode: source.mode,
    campaign_ids: windowInfo.active.map((a) => a.id),
    scope: 'step',
    eta_window_min: windowInfo.available,
    confidence: windowInfo.confidence,
    eta_cell_used: windowInfo.limiting?.eta_cell_used ?? null,
    eta_predicted_low: windowInfo.limiting?.eta_predicted_low ?? null,
    eta_predicted_median: windowInfo.limiting?.eta_predicted_median ?? null,
    eta_predicted_high: windowInfo.limiting?.eta_predicted_high ?? null,
  };
  awayStartTicker();
  renderAwayOverlay();
}

function awayPauseTimer() {
  if (!awayTimer.running) return;
  awayTimer.accumulatedMs = awayTimerActiveMs();
  awayTimer.running = false;
  awayTimer.segmentStart = null;
  awayStopTicker();
  renderAwayOverlay();
}

function awayResumeTimer() {
  if (awayTimer.running || !awayTimerArmed()) return;
  awayTimer.running = true;
  awayTimer.segmentStart = Date.now();
  awayStartTicker();
  renderAwayOverlay();
}

function awayStopTimer() {
  if (!awayTimerArmed()) return;
  const log = {
    id: awayId(),
    status: 'completed',
    task_ids: awayTimer.taskIds,
    task_names: awayTimer.taskNames,
    estimated_min: awayTimer.estimatedMin,
    started_at: awayTimer.startedAt,
    stopped_at: new Date().toISOString(),
    actual_min: Math.max(0, Math.round(awayTimerActiveMs() / 60_000)),
    source: awayTimer.source,
  };
  appendAwayLog(log);
  awayResetTimer();
  showToast(`Logged ${log.task_names.join(' + ')} — ${log.actual_min}m active`);
  renderAwayOverlay();
}

function awayDiscardTimer() {
  awayResetTimer();
  showToast('Away session discarded — not logged.');
  renderAwayOverlay();
}

function awayResetTimer() {
  awayStopTicker();
  awayTimer.running = false;
  awayTimer.taskIds = [];
  awayTimer.taskNames = [];
  awayTimer.estimatedMin = 0;
  awayTimer.startedAt = null;
  awayTimer.accumulatedMs = 0;
  awayTimer.segmentStart = null;
  awayTimer.source = null;
}

function awayStartTicker() {
  awayStopTicker();
  awayTimer.intervalId = window.setInterval(awayTickTimer, 1000);
}

function awayStopTicker() {
  if (awayTimer.intervalId) {
    window.clearInterval(awayTimer.intervalId);
    awayTimer.intervalId = null;
  }
}

function awayTickTimer() {
  const readout = document.querySelector('#away-timer-readout');
  if (readout) readout.textContent = awayFormatClock(awayTimerActiveMs());
  const delta = document.querySelector('#away-timer-delta');
  if (delta) delta.textContent = awayTimerDeltaLabel();
  const fill = document.querySelector('#away-timer-fill');
  if (fill) fill.style.width = `${awayTimerProgress()}%`;
  const elapsed = document.querySelector('#away-timer-elapsed');
  if (elapsed) elapsed.textContent = `${awayFormatClock(awayTimerActiveMs())} elapsed`;
}

function awayFormatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function awayTimerDeltaLabel() {
  const est = awayTimer.estimatedMin;
  if (!est) return '';
  const activeMin = awayTimerActiveMs() / 60_000;
  const diff = activeMin - est;
  if (Math.abs(diff) < 0.5) return `on estimate (${est}m)`;
  return diff > 0 ? `${Math.round(diff)}m over ${est}m est` : `${Math.round(-diff)}m under ${est}m est`;
}

function awayTimerProgress() {
  const total = awayTimer.estimatedMin * 60_000;
  if (!total) return 0;
  return Math.min(100, Math.round((awayTimerActiveMs() / total) * 100));
}

/* --- overlay UI --- */

let awayOverlayEl = null;
let awayPreviouslyFocused = null;
let awayAllButtonBound = false;
const awayUi = { open: false, source: null, selectedIds: [] };

function ensureAwayOverlay() {
  if (awayOverlayEl) return awayOverlayEl;
  const overlay = element('div', { id: 'away-overlay', className: 'away-overlay' });
  overlay.hidden = true;
  const backdrop = element('div', { className: 'away-backdrop' });
  backdrop.addEventListener('click', closeAwayMode);
  const panel = element('div', { className: 'away-panel' });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Away Mode');
  panel.setAttribute('tabindex', '-1');
  overlay.append(backdrop, panel);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAwayMode();
      return;
    }
    if (event.key === 'Tab') trapDialogFocus(event, panel);
  });
  document.body.append(overlay);
  awayOverlayEl = overlay;
  return overlay;
}

function openAwayMode(source) {
  if (!source || !Array.isArray(source.ids) || !source.ids.length) return;
  ensureAwayOverlay();
  awayUi.open = true;
  awayUi.source = source;
  awayUi.selectedIds = [];
  awayPreviouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  awayOverlayEl.hidden = false;
  document.body.classList.add('away-open');
  renderAwayOverlay();
  window.requestAnimationFrame(() => awayOverlayEl.querySelector('.away-panel')?.focus());
}

function closeAwayMode() {
  if (!awayOverlayEl) return;
  awayUi.open = false;
  awayOverlayEl.hidden = true;
  document.body.classList.remove('away-open');
  if (awayPreviouslyFocused && document.contains(awayPreviouslyFocused)) awayPreviouslyFocused.focus();
}

function renderAwayOverlay() {
  if (!awayOverlayEl || !awayUi.open) return;
  const panel = awayOverlayEl.querySelector('.away-panel');
  const source = awayUi.source;
  const windowInfo = awayResolveWindow(source);
  panel.replaceChildren();

  // Header: title + close, then a source subline.
  const header = element('div', { className: 'away-header' });
  const topRow = element('div', { className: 'away-header-row' });
  const title = element('h2', { className: 'away-title' });
  title.append(awayClockIcon(), element('span', { text: 'Away Mode' }));
  topRow.append(title);
  const close = element('button', { className: 'away-close', type: 'button', ariaLabel: 'Close Away Mode', text: '×' });
  close.addEventListener('click', closeAwayMode);
  topRow.append(close);
  header.append(topRow, element('p', { className: 'away-source', text: awaySourceLabel(source, windowInfo) }));
  panel.append(header);

  panel.append(awayRenderWindowBlock(windowInfo));

  if (!awayTimerArmed() && windowInfo.available > 0) {
    panel.append(awayRenderSuggestions(windowInfo));
  }

  // Only show the timer (incl. the big "Select a task to start" button) when a
  // session is already running/paused, or there's a real window to start
  // against. With nothing running, the window block is the neutral empty state
  // and only the task library follows.
  if (awayTimerArmed() || windowInfo.available > 0) {
    panel.append(awayRenderTimer(windowInfo));
  }
  panel.append(awayRenderTaskManager());
}

function awaySourceLabel(source, windowInfo) {
  if (!source) return '';
  if (source.mode === 'stack') return `${source.title || 'Stack'} · ${windowInfo.active.length} running`;
  if (source.mode === 'all') return `All running · ${windowInfo.active.length} active`;
  return source.title || windowInfo.active[0]?.title || windowInfo.attention[0]?.title || 'Campaign';
}

function awayWindowMetric(label, value, valueClass = '') {
  const item = element('div', { className: 'away-window-metric' });
  item.append(
    element('span', { className: 'away-window-metric-label', text: label }),
    element('span', { className: `away-window-metric-value${valueClass ? ` ${valueClass}` : ''}`, text: value }),
  );
  return item;
}

function awayEndsAt(minutes) {
  const date = new Date(Date.now() + Math.max(0, minutes) * 60_000);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function awayConfidenceText(confidence) {
  if (confidence === 'high') return 'High';
  if (confidence === 'medium') return 'Medium';
  return 'Low';
}

function awayFitText(match) {
  if (match.overage) return `${match.overage}m over`;
  return `${match.leftover}m spare`;
}

function awayClockIcon() {
  return element('span', {
    className: 'away-title-icon',
    ariaHidden: 'true',
    html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>',
  });
}

function awayTaskIcon(name) {
  const key = String(name || '').toLowerCase();
  let path;
  if (key.includes('laundry') || key.includes('clothes')) {
    path = '<path d="M8 4l2 3h4l2-3 4 3-3 4-2-1v10H9V10l-2 1-3-4 4-3z"/>';
  } else if (key.includes('dish') || key.includes('cup') || key.includes('coffee')) {
    path = '<path d="M6 5h10v9a4 4 0 0 1-4 4H9a3 3 0 0 1-3-3V5z"/><path d="M16 8h2a3 3 0 0 1 0 6h-2"/><path d="M6 10h10"/>';
  } else if (key.includes('clean') || key.includes('tidy')) {
    path = '<path d="M15 4l5 5"/><path d="M14 5l-8 8 5 5 8-8"/><path d="M6 13l-3 6h6l2-2"/>';
  } else {
    path = '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/>';
  }
  return element('span', {
    className: 'away-task-icon',
    ariaHidden: 'true',
    html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`,
  });
}

function awayRenderWindowBlock(windowInfo) {
  const block = element('section', { className: 'away-window' });

  if (windowInfo.available == null) {
    if (windowInfo.attention.length) {
      // Attention is a real problem → keep the alert (red) treatment.
      block.classList.add('away-window--blocked');
      block.append(element('p', { className: 'away-window-headline', text: 'Needs attention before Away Mode' }));
      block.append(element('p', { className: 'away-window-sub', text: 'Resolve these before leaving the screen:' }));
      block.append(awayAttentionList(windowInfo.attention));
    } else {
      // Nothing running is benign → neutral empty state, not an alert.
      block.classList.add('away-window--idle');
      block.append(element('p', { className: 'away-window-headline', text: 'Nothing running' }));
      block.append(element('p', { className: 'away-window-sub', text: 'An away window appears while a campaign is automating.' }));
    }
    return block;
  }

  const summary = element('div', { className: 'away-window-summary' });
  summary.append(
    awayWindowMetric('Available', windowInfo.available > 0 ? formatWholeMinutes(windowInfo.available) : 'Nearby'),
    awayWindowMetric('Ends at', windowInfo.available > 0 ? awayEndsAt(windowInfo.available) : 'soon'),
    awayWindowMetric('Confidence', awayConfidenceText(windowInfo.confidence), `away-confidence away-confidence--${windowInfo.confidence || 'low'}`),
  );
  block.append(summary);

  const sub = [];
  if (awayIsMulti(awayUi.source) && windowInfo.limiting) sub.push(`limited by ${windowInfo.limiting.title}`);
  sub.push('current step · safe window');
  block.append(element('p', { className: 'away-window-sub', text: sub.join(' · ') }));

  if (windowInfo.attention.length) {
    block.append(element('p', { className: 'away-window-ignored-label', text: 'Ignored — needs attention:' }));
    block.append(awayAttentionList(windowInfo.attention));
  }
  return block;
}

function awayAttentionList(list) {
  const wrap = element('ul', { className: 'away-attention' });
  for (const item of list) {
    const li = element('li', {});
    li.append(
      element('span', { className: 'away-attention-name', text: item.title }),
      element('span', { className: 'away-attention-status', text: item.status }),
    );
    wrap.append(li);
  }
  return wrap;
}

function awayRenderSuggestions(windowInfo) {
  const section = element('section', { className: 'away-suggestions' });
  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  const matches = awayMatchTasks(windowInfo.available, tasks, logs);

  if (!matches.length) {
    section.append(element('p', { className: 'away-empty', text: 'Nothing fits — add a shorter task below, or stay nearby.' }));
    return section;
  }

  const singles = matches.filter((match) => match.tasks.length === 1);
  const combos = matches.filter((match) => match.tasks.length > 1);

  if (singles.length) {
    section.append(element('h3', { className: 'away-h3', text: 'Suggested tasks' }));
    const cards = element('div', { className: 'away-task-cards' });
    for (const match of singles.slice(0, 3)) {
      cards.append(awaySuggestionButton(match, 'card'));
    }
    section.append(cards);
  }

  if (combos.length) {
    section.append(element('h3', { className: 'away-h3 away-h3-combos', text: 'Combinations' }));
    const list = element('div', { className: 'away-combo-list' });
    for (const match of combos) {
      list.append(awaySuggestionButton(match, 'combo'));
    }
    section.append(list);
    section.append(element('p', { className: 'away-combo-note', text: `Near fits up to ${AWAY_OVERAGE_TOLERANCE_MIN}m over are included.` }));
  }

  return section;
}

function awaySuggestionButton(match, variant) {
  const selected = awaySameIds(match.ids, awayUi.selectedIds);
  const button = element('button', {
    className: `away-suggestion away-suggestion--${variant}${selected ? ' is-selected' : ''}${match.overage ? ' is-over' : ''}`,
    type: 'button',
    ariaPressed: String(selected),
  });

  if (variant === 'card') {
    const task = match.tasks[0];
    button.append(
      awayTaskIcon(task.name),
      element('span', { className: 'away-suggestion-name', text: task.name }),
      element('span', { className: 'away-suggestion-time', text: `${match.total}m` }),
      element('span', { className: 'away-suggestion-plus', ariaHidden: 'true', text: '+' }),
    );
  } else {
    const names = element('span', { className: 'away-combo-name' });
    match.tasks.forEach((task, index) => {
      if (index > 0) names.append(element('span', { className: 'away-combo-plus', text: '+' }));
      names.append(awayTaskIcon(task.name), element('span', { text: task.name }));
    });
    button.append(
      names,
      element('span', { className: 'away-suggestion-fit', text: `${match.total}m · ${awayFitText(match)}` }),
      element('span', { className: 'away-suggestion-plus away-suggestion-plus--small', ariaHidden: 'true', text: '+' }),
    );
  }

  button.addEventListener('click', () => {
    awayUi.selectedIds = selected ? [] : match.ids;
    renderAwayOverlay();
  });
  return button;
}

function awaySameIds(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function awayRenderTimer(windowInfo) {
  const section = element('section', { className: 'away-timer' });

  if (!awayTimerArmed()) {
    const tasks = loadAwayTasks();
    const logs = loadAwayLogs();
    const selectedTasks = awayUi.selectedIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
    const canStart = selectedTasks.length > 0 && windowInfo.available > 0;
    const start = element('button', {
      className: 'button button-primary button-wide',
      type: 'button',
      text: selectedTasks.length ? `Start: ${selectedTasks.map((t) => t.name).join(' + ')}` : 'Select a task to start',
    });
    start.disabled = !canStart;
    start.addEventListener('click', () => {
      const total = selectedTasks.reduce((s, t) => s + awayEffectiveEstimate(t, logs), 0)
        + AWAY_TRANSITION_BUFFER * Math.max(0, selectedTasks.length - 1);
      awayStartTimer({ ids: awayUi.selectedIds.slice(), tasks: selectedTasks, total }, windowInfo, awayUi.source);
    });
    section.append(start);
    return section;
  }

  section.classList.add('is-active');
  const timerHead = element('div', { className: 'away-timer-head' });
  timerHead.append(
    element('span', { className: `away-timer-state${awayTimer.running ? ' is-running' : ''}`, text: awayTimer.running ? 'ACTIVE' : 'PAUSED' }),
    element('span', { className: 'away-timer-task', text: awayTimer.taskNames.join(' + ') || 'Away session' }),
  );
  section.append(timerHead);
  const readout = element('div', { id: 'away-timer-readout', className: 'away-timer-readout', text: awayFormatClock(awayTimerActiveMs()) });
  if (!awayTimer.running) readout.classList.add('is-paused');
  section.append(readout);
  section.append(element('p', { id: 'away-timer-delta', className: 'away-timer-delta', text: awayTimerDeltaLabel() }));

  const progress = element('div', { className: 'away-timer-progress' });
  const fill = element('div', { id: 'away-timer-fill', className: 'away-timer-fill' });
  fill.style.width = `${awayTimerProgress()}%`;
  progress.append(fill);
  section.append(progress);

  const meta = element('div', { className: 'away-timer-meta' });
  meta.append(
    element('span', { id: 'away-timer-elapsed', text: `${awayFormatClock(awayTimerActiveMs())} elapsed` }),
    element('span', { text: `${awayFormatClock(awayTimer.estimatedMin * 60_000)} total` }),
  );
  section.append(meta);

  const controls = element('div', { className: 'away-timer-controls' });
  if (awayTimer.running) {
    const pause = element('button', { className: 'button', type: 'button', text: 'Pause' });
    pause.addEventListener('click', awayPauseTimer);
    controls.append(pause);
  } else {
    const resume = element('button', { className: 'button button-primary', type: 'button', text: 'Start' });
    resume.addEventListener('click', awayResumeTimer);
    controls.append(resume);
  }
  const stop = element('button', { className: 'button', type: 'button', text: 'Stop & log' });
  stop.addEventListener('click', awayStopTimer);
  const discard = element('button', { className: 'button button-danger', type: 'button', text: 'Discard' });
  discard.addEventListener('click', awayDiscardTimer);
  controls.append(stop, discard);
  section.append(controls);
  section.append(element('p', { className: 'away-timer-note', text: awayTimer.running ? 'Pause if you step back to the screen — paused time is not counted.' : 'Stop to log, or discard to throw this run away.' }));
  return section;
}

function awayRenderTaskManager() {
  const section = element('section', { className: 'away-tasks' });
  section.append(element('h3', { className: 'away-h3', text: 'Task library' }));

  const form = element('form', { className: 'away-add-form' });
  const nameInput = element('input', { className: 'away-input away-input-name', type: 'text' });
  nameInput.placeholder = 'Task name';
  nameInput.maxLength = 60;
  nameInput.setAttribute('aria-label', 'Task name');
  const minInput = element('input', { className: 'away-input away-input-min', type: 'number' });
  minInput.placeholder = 'min';
  minInput.min = '1';
  minInput.setAttribute('aria-label', 'Estimated minutes');
  const save = element('button', { className: 'button', type: 'submit', text: 'Save' });
  form.append(nameInput, minInput, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!awayAddTask(nameInput.value, minInput.value)) {
      showToast('Enter a task name and minutes.');
      return;
    }
    nameInput.value = '';
    minInput.value = '';
    renderAwayOverlay();
    window.requestAnimationFrame(() => awayOverlayEl?.querySelector('.away-input-name')?.focus());
  });
  section.append(form);

  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  if (!tasks.length) {
    section.append(element('p', { className: 'away-empty', text: 'No tasks yet — add one above.' }));
    return section;
  }

  const list = element('ul', { className: 'away-task-list' });
  for (const task of tasks) {
    const li = element('li', { className: 'away-task-item' });
    li.append(element('span', { className: 'away-task-name', text: task.name }));
    const est = awayEffectiveEstimate(task, logs);
    const estLabel = element('span', { className: 'away-task-est', text: `${est}m` });
    if (awayTaskIsAdaptive(task, logs)) {
      estLabel.classList.add('is-adaptive');
      estLabel.title = `Median of ${awayTaskLogCount(task, logs)} logged times`;
    }
    li.append(estLabel);
    const del = element('button', { className: 'away-task-delete', type: 'button', ariaLabel: `Delete ${task.name}`, text: '×' });
    del.addEventListener('click', () => {
      awayDeleteTask(task.id);
      awayUi.selectedIds = awayUi.selectedIds.filter((id) => id !== task.id);
      renderAwayOverlay();
    });
    li.append(del);
    list.append(li);
  }
  section.append(list);
  return section;
}

/* --- entry points (card / stack / all-running) --- */

function awayMoonIcon() {
  return element('span', {
    className: 'away-icon',
    ariaHidden: 'true',
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  });
}

function awayEntryButton(label, onActivate, extraClass = '') {
  const btn = element('button', {
    className: `away-entry-button${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    title: 'Away Mode — what fits while this runs?',
    ariaLabel: 'Open Away Mode',
  });
  btn.append(awayMoonIcon());
  if (label) btn.append(element('span', { className: 'away-entry-label', text: label }));
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return btn;
}

function awayActiveIdsIn(ids) {
  return ids.filter((id) => isAutomateRunning(automateState.bulk?.[id]));
}

function updateAwayAllButton() {
  const btn = document.querySelector('#away-all-button');
  if (!btn) return;
  if (!awayAllButtonBound) {
    awayAllButtonBound = true;
    btn.addEventListener('click', () => {
      const ids = awayActiveIdsIn(Object.keys(automateState.bulk || {}));
      if (ids.length) openAwayMode({ mode: 'all', ids, title: 'All running' });
    });
  }
  const activeCount = awayActiveIdsIn(Object.keys(automateState.bulk || {})).length;
  btn.hidden = activeCount < 1;
  if (activeCount >= 1) btn.textContent = `Away · ${activeCount} running`;
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

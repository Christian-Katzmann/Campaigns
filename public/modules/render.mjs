// Board rendering: turns parsed blocks into the execution-board DOM — the step,
// phase, prompt, review-card, doc-section, table, and check-row renderers plus
// the render() entry that drives them, the progress/save-status readouts, focus
// and filter application, the phase-review injection pipeline, the mobile step
// bar, and the step observer. A lower layer than the board's event handlers: it
// builds markup and reads shared state, but never calls the click/save handlers,
// so board.mjs imports from here and not the other way around.

import { elements, state } from './state.mjs';
import {
  copyIconTemplate,
  cssEscape,
  element,
  fileNameFromPath,
  formatTime,
  inlineMarkdown,
  relativeTime,
  splitParagraphs,
} from './dom.mjs';
import {
  classifyPhases,
  extractFinalReview,
  extractPhases,
  extractStepSections,
  findCampaignFinalReviewCheck,
  findCheckLinkTarget,
  findResumeTarget,
  getProgressStats,
  groupChecklistByPhase,
  isNewShapeCampaign,
  linkChecksToPhaseReviews,
  linkChecksToSteps,
  parseMarkdown,
  parseModelSegment,
  phaseDescriptiveTitle,
  stripFinalReviewBlocks,
  stripStepMetaBlocks,
  wrapDocSections,
  wrapSteps,
} from '../lib/parser.mjs';
import { recordTodayActivity, savePrefs, todayDelta } from './prefs-store.mjs';
import { applyTheme, detectPhaseCompletions } from './effects.mjs';
import { analyzePlanHealth } from '../lib/plan-health.mjs';
import { renderPlanHealthStrip } from './plan-health-view.mjs';

// Placeholder tokens like <FEATURE> that a campaign fills in per step; STEP and
// PHASE are reserved for the review-card templates and never rendered as fields.
const PLACEHOLDER_REGEX = /<([A-Z][A-Z0-9_]+)>/g;
const RESERVED_TOKENS = new Set(['STEP', 'PHASE']);

export function render() {
  applyTheme(state.prefs.theme);
  const blocks = parseMarkdown(state.markdown);
  const phases = classifyPhases(extractPhases(blocks));
  const stepSections = extractStepSections(blocks, state.markdown);
  const stats = getProgressStats(blocks);
  const resume = findResumeTarget(blocks, stepSections);
  const stepCheckMap = linkChecksToSteps(blocks, stepSections);
  const planHealthFindings = analyzePlanHealth(
    state.markdown,
    state.planHealthAvoidAboveSteps,
  );

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
  // the per-step `Model:` / `Parallel:` / `Lane:` source lines: the chips under each
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
  const planHealthStrip = renderPlanHealthStrip(planHealthFindings);
  const renderedBlocks = withPath.map((block) => renderBlock(block, stepSections));
  if (planHealthStrip) renderedBlocks.unshift(planHealthStrip);
  elements.document.replaceChildren(...renderedBlocks);

  applyFocusMode();
  renderMobileBottombar();
  attachStepObserver();
}

export function renderProgressLabel(stats) {
  const delta = todayDelta(stats.done);
  elements.progressLabel.textContent = `${stats.done} of ${stats.total} done`;
  if (delta > 0) {
    const chip = element('span', { className: 'today-delta', text: `+${delta} today` });
    elements.progressLabel.append(chip);
  }
}

export function renderBlock(block, stepSections) {
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

export function renderHeading(block) {
  const tag = `h${Math.min(block.level, 4)}`;
  const attrs = block.level <= 2 ? { id: block.id } : {};
  return element(tag, { ...attrs, html: inlineMarkdown(block.text) });
}

export function renderQuote(block) {
  const wrapper = element('blockquote', { className: 'quote' });

  for (const paragraph of splitParagraphs(block.text)) {
    wrapper.append(element('p', { html: inlineMarkdown(paragraph) }));
  }

  return wrapper;
}

export function renderCheckRow(block, stepSections) {
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

export function renderList(block) {
  const list = element(block.ordered ? 'ol' : 'ul', {
    className: block.ordered ? 'ordered-list' : 'plain-list',
  });

  for (const item of block.items) {
    list.append(element('li', { html: inlineMarkdown(item.text) }));
  }

  return list;
}

export function renderTable(block) {
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

export function renderCodeBlock(block) {
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

export function renderReviewCard({ mode, stepNumber, phaseNumber, stepId }) {
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

export function detectPlaceholders(text) {
  const found = new Set();
  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    if (RESERVED_TOKENS.has(match[1])) continue;
    found.add(match[1]);
  }
  return [...found];
}

export function detectReviewMode(content) {
  if (!content) return null;
  const tokens = new Set();
  for (const match of content.matchAll(PLACEHOLDER_REGEX)) {
    tokens.add(match[1]);
  }
  if (tokens.has('STEP') && !tokens.has('PHASE')) return 'step';
  if (tokens.has('PHASE') && !tokens.has('STEP')) return 'phase';
  return null;
}

export function extractReviewTemplates(blocks) {
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

export function phaseForStep(stepNumber) {
  if (!stepNumber) return '';
  return String(stepNumber).split('.')[0];
}

export function buildReviewPromptText(mode, stepNumber, phaseNumber) {
  const templates = state.reviewTemplates;
  if (mode === 'phase' && templates.phase.content) {
    return templates.phase.content.replace(/<PHASE>/g, phaseNumber || '');
  }
  if (mode === 'step' && templates.step.content) {
    return templates.step.content.replace(/<STEP>/g, stepNumber || '');
  }
  return '';
}

export function renderPlaceholderBar(tokens) {
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

export function refreshPromptBodies() {
  for (const pre of elements.document.querySelectorAll('.prompt-code')) {
    const raw = pre.dataset.rawContent ?? '';
    const fresh = renderPromptBody(raw);
    pre.replaceWith(fresh);
  }
}

export function renderPromptBody(rawContent) {
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

export function splitOnPlaceholders(text) {
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

export function substitutePlaceholders(text) {
  return text.replace(PLACEHOLDER_REGEX, (raw, token) => {
    const fill = state.prefs.placeholders[token];
    return fill ? fill : raw;
  });
}

export function renderPhaseGroup(group, stepSections) {
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

export function renderResumePreview(resume) {
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

export function renderFilterChipsInline() {
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

export function renderPhaseHeader(block) {
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

export function renderWorkDivider() {
  const wrapper = element('section', { className: 'work-divider' });
  wrapper.append(element('span', { className: 'work-divider-label', text: 'Begin execution' }));
  return wrapper;
}

export function renderDocumentPath(block) {
  return element('p', {
    className: 'document-path-inline',
    text: block.filePath || '',
  });
}

export function renderStepGroup(block, stepSections) {
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
 * Renders the `Model:`, `Parallel:`, and `Lane:` chips under a step heading.
 * Legacy campaigns without metadata render unchanged.
 */
export function renderStepMeta(section, stepSections) {
  const modelChip = renderModelChip(section.model, section.number);
  const parallelChip = renderParallelChip(section.parallel, stepSections);
  const laneChip = renderLaneChip(section.lane);
  if (!modelChip && !parallelChip && !laneChip) return null;

  const row = element('div', { className: 'step-meta' });
  if (modelChip) row.append(modelChip);
  if (parallelChip) row.append(parallelChip);
  if (laneChip) row.append(laneChip);
  return row;
}

export function renderModelChip(model, stepNumber = '') {
  const primary = model?.primary ?? model?.claudeCode ?? '';
  const alternate = model?.alternate ?? model?.codex ?? '';
  if (!primary && !alternate) return null;

  const titleParts = [];
  if (primary) titleParts.push(`Primary: ${primary}`);
  if (alternate) titleParts.push(`Alternate: ${alternate}`);
  const chip = element('button', {
    className: 'meta-chip meta-model',
    dataset: { action: 'edit-step-model', stepNumber },
    title: titleParts.join(' / '),
    type: 'button',
  });
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-label', `Edit model for Step ${stepNumber}`);

  [primary, alternate].filter(Boolean).forEach((segment, index) => {
    if (index > 0) chip.append(element('span', { className: 'agent-divider', ariaHidden: 'true' }));
    const runner = runnerForModelSegment(segment);
    chip.append(
      element('span', {
        className: `agent-glyph agent-glyph-${runner?.id === 'claude' ? 'cc' : 'cx'}`,
        ariaLabel: runner?.label ?? 'Runner',
        text: runner?.id === 'claude' ? 'CC' : runner?.id === 'codex' ? 'CX' : 'AI',
      }),
      element('span', { className: 'agent-spec', text: segment }),
    );
  });
  return chip;
}

function runnerForModelSegment(segment) {
  const parsed = parseModelSegment(segment);
  if (!parsed) return null;
  const wanted = parsed.model.trim().toLowerCase();
  return state.capabilities.runners.find((runner) => runner.models?.some((model) => (
    model.id?.trim().toLowerCase() === wanted || model.label?.trim().toLowerCase() === wanted
  ))) ?? null;
}

export function renderParallelChip(parallel, stepSections) {
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

export function renderLaneChip(lane) {
  if (!lane?.globs?.length) return null;
  const chip = element('div', {
    className: 'meta-chip meta-lane',
    title: `Writes are declared inside ${lane.globs.join(', ')}.`,
  });
  chip.append(
    element('span', { className: 'meta-lane-label', text: 'Lane' }),
    element('span', { className: 'meta-parallel-sep', ariaHidden: 'true', text: '·' }),
    element('span', { className: 'meta-lane-globs', text: lane.globs.join(', ') }),
  );
  return chip;
}

export function renderDocSection(block, stepSections) {
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

export function renderStepCompleteButton(block) {
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

export function renderPhaseCompleteButton(block) {
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

export function renderFinalReviewCard(block) {
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

export function applyFilterClasses() {
  document.body.classList.toggle('filter-hide-todo', !state.prefs.filters.todo);
  document.body.classList.toggle('filter-hide-flight', !state.prefs.filters.flight);
  document.body.classList.toggle('filter-hide-done', !state.prefs.filters.done);
}

export function applyFocusMode() {
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

export function toggleFocusMode() {
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

export function getSaveStatus() {
  if (!state.serverBacked) {
    return 'Opened from your browser. Use Export to keep changes.';
  }
  if (state.saveStatus === 'saving') return 'Saving…';
  if (state.saveStatus === 'error') return state.lastSaveError || 'Save failed — retry.';
  if (state.dirty) return 'Unsaved changes.';
  if (state.lastModified) return `Saved ${formatTime(state.lastModified)}.`;
  return 'No changes yet.';
}

export function updateSaveStatus() {
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
const saveStatusRefreshTimer = setInterval(() => {
  if (state.saveStatus === 'idle' && !state.dirty && state.lastModified) {
    updateSaveStatus();
  }
}, 30_000);
saveStatusRefreshTimer.unref?.();

export function getSaveStatusInline() {
  if (!state.serverBacked) return { text: '', state: 'idle' };
  if (state.saveStatus === 'saving') return { text: 'Saving…', state: 'saving' };
  if (state.saveStatus === 'error') return { text: 'Save failed', state: 'error' };
  if (state.dirty) return { text: 'Unsaved', state: 'dirty' };
  if (state.lastModified) return { text: `Saved ${relativeTime(state.lastModified)}`, state: 'saved' };
  return { text: '', state: 'idle' };
}

export function isPhaseCollapsed(phase) {
  const defaultCollapsed = phase.state === 'done';
  const inverted = state.prefs.phaseInverted.includes(phase.anchorId);
  return inverted ? !defaultCollapsed : defaultCollapsed;
}

export function togglePhase(phaseId) {
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

export function codeKey(block) {
  return `code-${block.lineStart}-${block.lineEnd}`;
}

/* ------------------------------ Mobile bottom bar ----------------------------------- */

let stepObserver = null;

export function attachStepObserver() {
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

export function renderMobileBottombar() {
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

export function neighbouringSteps() {
  const sections = state.stepSections;
  if (sections.length === 0) return { prev: null, next: null };
  let activeIndex = sections.findIndex((s) => s.anchorId === state.activeStepId);
  if (activeIndex === -1) activeIndex = 0;
  return {
    prev: sections[activeIndex - 1] || null,
    next: sections[activeIndex + 1] || null,
  };
}

export function nextUncheckedStep(currentStepId) {
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

export function jumpToAnchor(id) {
  if (state.stepSections.some((section) => section.anchorId === id)) {
    // Set eagerly (not just via the scroll observer) so rapid arrow-key
    // navigation always steps from the target, not a stale position.
    state.activeStepId = id;
    if (state.prefs.focusMode) applyFocusMode();
    renderMobileBottombar();
  }
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function injectStepButtons(blocks, stepSections, stepCheckMap, phaseTitles) {
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

export function buildFinalReviewCardBlock() {
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

export function injectDocumentPath(blocks) {
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

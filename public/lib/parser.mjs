// Markdown parsing pipeline — the product's data model.
//
// Everything here is pure: markdown string in, plain data (blocks, phases, step
// sections, maps, stats) out. No `document`, no `fetch`, no `localStorage`, no
// module-level mutable state. That's what lets the browser app (public/app.js)
// and Node's test runner (test/parser.test.mjs) both import it directly — the
// tests need no DOM precisely because this file touches none.
//
// `getLines(markdown)` requires its argument here (the app keeps the
// `state.markdown` default on its own side); everything downstream threads the
// markdown or the parsed blocks through explicitly.

export const CHECK_LINE_REGEX = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/;
export const EXECUTABLE_CHECK_LINE_REGEX = /^\s*CHECK:\s*(.*)$/;
export const DEFAULT_EXECUTABLE_CHECK_TIMEOUT_MS = 120_000;

/* ------------------------------ Line utilities -------------------------------------- */

export function getLines(markdown) {
  return normalizeNewlines(markdown).split('\n');
}

export function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

export function replaceFencedBlockContent(markdown, block, nextContent) {
  const lines = getLines(markdown);
  const replacement = normalizeNewlines(nextContent).split('\n');
  lines.splice(block.lineStart + 1, block.lineEnd - block.lineStart - 1, ...replacement);
  return lines.join('\n');
}

export function parseExecutableChecks(prompt) {
  const checks = [];

  for (const [index, line] of getLines(prompt).entries()) {
    const match = line.match(EXECUTABLE_CHECK_LINE_REGEX);
    if (!match) continue;

    const lineNumber = index + 1;
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch {
      throw new TypeError(`Invalid CHECK on prompt line ${lineNumber}: expected one JSON object.`);
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`Invalid CHECK on prompt line ${lineNumber}: expected one JSON object.`);
    }

    const allowedKeys = new Set(['command', 'expectedExit', 'expectedOutput', 'timeoutMs']);
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `Invalid CHECK on prompt line ${lineNumber}: unknown field ${unknownKeys[0]}.`,
      );
    }

    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new TypeError(`Invalid CHECK on prompt line ${lineNumber}: command must be a non-empty string.`);
    }

    const hasExpectedExit = Object.prototype.hasOwnProperty.call(value, 'expectedExit');
    if (hasExpectedExit && (!Number.isInteger(value.expectedExit) || value.expectedExit < 0)) {
      throw new TypeError(
        `Invalid CHECK on prompt line ${lineNumber}: expectedExit must be a non-negative integer.`,
      );
    }

    const hasExpectedOutput = Object.prototype.hasOwnProperty.call(value, 'expectedOutput');
    if (hasExpectedOutput && typeof value.expectedOutput !== 'string') {
      throw new TypeError(
        `Invalid CHECK on prompt line ${lineNumber}: expectedOutput must be a string.`,
      );
    }

    const hasTimeout = Object.prototype.hasOwnProperty.call(value, 'timeoutMs');
    if (hasTimeout && (!Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0)) {
      throw new TypeError(
        `Invalid CHECK on prompt line ${lineNumber}: timeoutMs must be a positive integer.`,
      );
    }

    checks.push({
      command: value.command,
      expectedExit: hasExpectedExit ? value.expectedExit : 0,
      expectedOutput: hasExpectedOutput ? value.expectedOutput : null,
      timeoutMs: hasTimeout ? value.timeoutMs : DEFAULT_EXECUTABLE_CHECK_TIMEOUT_MS,
    });
  }

  return checks;
}

export function stripTrailingHashes(value) {
  return value.replace(/\s+#+$/, '');
}

export function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48);
}

/* ------------------------------ Markdown parser ------------------------------------- */

export function parseMarkdown(markdown) {
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

export function isSpecialLine(lines, index) {
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

export function isCheckLine(line) {
  return CHECK_LINE_REGEX.test(line);
}

export function isListLine(line) {
  return /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

export function isTableStart(lines, index) {
  return (
    isTableRow(lines[index]) &&
    Boolean(lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/))
  );
}

export function isTableRow(line) {
  return /^\s*\|.+\|\s*$/.test(line);
}

export function parseTable(tableLines, startLine) {
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

export function parseTableCells(line) {
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

/* ------------------------------ Phases & steps -------------------------------------- */

export function extractPhases(blocks) {
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

export function classifyPhases(phases) {
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

export function extractStepSections(blocks, markdown) {
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
export function parseStepMetadata(lines, fromLine) {
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

export function parseModelValue(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return null;
  const segments = value.split(/\s*\/\s*/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  return {
    primary: segments[0] || '',
    alternate: segments[1] || '',
    // Compatibility aliases for older browser consumers. These are positions,
    // not provider identities; new code should use primary/alternate.
    claudeCode: segments[0] || '',
    codex: segments[1] || '',
  };
}

export function parseModelSegment(rawSegment) {
  const value = (rawSegment || '').trim();
  if (!value) return null;
  const dotParts = value.split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
  if (dotParts.length > 1) {
    return {
      model: dotParts.slice(0, -1).join(' · '),
      effort: dotParts.at(-1),
    };
  }
  const legacy = value.match(/^(.*)\s+-\s+([^\s].*)$/);
  return legacy
    ? { model: legacy[1].trim(), effort: legacy[2].trim() }
    : { model: value, effort: '' };
}

export function formatModelValue(primary, alternate = '') {
  const segments = [primary, alternate].map((segment) => String(segment || '').trim()).filter(Boolean);
  if (segments.length === 0) throw new TypeError('Model value requires a primary segment.');
  return segments.join(' / ');
}

export function replaceStepModelValue(markdown, stepNumber, nextValue) {
  const lines = getLines(markdown);
  const sections = extractStepSections(parseMarkdown(markdown), markdown);
  const section = sections.find((candidate) => candidate.number === String(stepNumber));
  if (!section) throw new TypeError(`Unknown step: ${stepNumber}`);
  if (section.metaLineStart == null || section.metaLineEnd == null) {
    throw new TypeError(`Step ${stepNumber} has no Model metadata line.`);
  }
  const modelLine = lines.findIndex((line, index) => (
    index >= section.metaLineStart
    && index <= section.metaLineEnd
    && /^\s*Model:/i.test(line)
  ));
  if (modelLine < 0) throw new TypeError(`Step ${stepNumber} has no Model metadata line.`);
  lines[modelLine] = `Model: ${formatModelValue(nextValue)}`;
  return lines.join('\n');
}

export function parseParallelValue(rawValue) {
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

export function findSkillNearby(blocks, fromIndex) {
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

export function findStepForCheck(checkText, stepSections) {
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

export function linkChecksToSteps(blocks, stepSections) {
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

export function findResumeTarget(blocks, stepSections) {
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

export function extractPhaseNumber(text) {
  const match = text.match(/phase\s+(\d+(?:\.\d+)?)/i);
  return match ? match[1] : '';
}

export function stripPhaseTrailing(text) {
  return text.replace(/\s*✅\s*$/, '').trim();
}

/* ------------------------------ Phase grouping for render --------------------------- */

export function groupChecklistByPhase(blocks, phases) {
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

export function stripFinalReviewBlocks(blocks, finalReview) {
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
export function stripStepMetaBlocks(blocks, stepSections) {
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

export function wrapDocSections(blocks) {
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

export function wrapSteps(blocks, stepIds, stepCheckMap) {
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

export function phaseDescriptiveTitle(title) {
  if (!title) return '';
  return title.replace(/^Phase\s+[\d.]+\s*[—–-]\s*/i, '').trim();
}

/* ------------------------------ Final review ---------------------------------------- */

export function hasCampaignLevelFinalReview(markdown) {
  // New-shape detection: either a `## Final review` H2, or a `- [ ] Final review`
  // checklist line with no `— Phase N` suffix. Either marks the campaign as v2.
  if (/^##\s+final\s+review\s*$/im.test(markdown)) return true;
  if (/^\s*-\s+\[[\sxX]\]\s+final\s+review\s*$/im.test(markdown)) return true;
  return false;
}

export function isNewShapeCampaign(blocks) {
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

export function ensureFinalReviewLines(markdown) {
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

export function linkChecksToPhaseReviews(blocks) {
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

export function findCampaignFinalReviewCheck(blocks) {
  for (const block of blocks) {
    if (block.type === 'check' && /^final\s+review\s*$/i.test(block.text)) {
      return block;
    }
  }
  return null;
}

export function extractFinalReview(blocks) {
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

export function findCheckLinkTarget(checkText, stepSections) {
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

/* ------------------------------ Progress -------------------------------------------- */

export function getProgressStats(blocks) {
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

export function progressChecklistBlocks(blocks) {
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

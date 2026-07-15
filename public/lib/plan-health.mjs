import {
  EXECUTABLE_CHECK_LINE_REGEX,
  extractFinalReview,
  extractPhases,
  extractStepSections,
  findStepForCheck,
  parseExecutableChecks,
  parseMarkdown,
  progressChecklistBlocks,
} from './parser.mjs';

export const DEFAULT_AVOID_ABOVE_STEPS = 10;
export const MAX_REQUIRED_READING_ITEMS = 5;

export const PLAN_HEALTH_RULES = [
  {
    id: 'missing-title',
    severity: 'error',
    find: ({ title }) => title
      ? []
      : [{
          ...campaignTarget(1),
          message: 'This plan has no H1 title.',
          fixHint: 'Add one # Campaign title heading.',
        }],
  },
  {
    id: 'missing-phase',
    severity: 'error',
    find: ({ phases }) => phases.length > 0
      ? []
      : [{
          ...campaignTarget(1),
          message: 'This plan has no checklist phase.',
          fixHint: 'Add a ### Phase N — Title heading under ## Progress checklist.',
        }],
  },
  {
    id: 'missing-steps',
    severity: 'error',
    find: ({ steps }) => steps.length > 0
      ? []
      : [{
          ...campaignTarget(1),
          message: 'This plan has no Step N.M sections.',
          fixHint: 'Add at least one ## Step N.M — Name section.',
        }],
  },
  {
    id: 'missing-model',
    severity: 'error',
    find: ({ steps }) => steps
      .filter((step) => !step.model)
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has no valid Model chip.`,
        fixHint: 'Add a valid Model: line directly below the step heading.',
      })),
  },
  {
    id: 'missing-parallel',
    severity: 'error',
    find: ({ steps }) => steps
      .filter((step) => !step.parallel)
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has no valid Parallel chip.`,
        fixHint: 'Add Parallel: NO or a reciprocal YES — with Step N.M declaration.',
      })),
  },
  {
    id: 'invalid-step-id',
    severity: 'error',
    find: ({ steps }) => steps
      .filter((step) => !/^\d+\.\d+$/.test(step.number))
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} does not use a numeric N.M id.`,
        fixHint: 'Use a heading such as ## Step 1.1 — Name.',
      })),
  },
  {
    id: 'duplicate-step-id',
    severity: 'error',
    find: ({ steps }) => {
      const seen = new Set();
      return steps.flatMap((step) => {
        if (!seen.has(step.number)) {
          seen.add(step.number);
          return [];
        }
        return [{
          ...stepTarget(step),
          message: `${stepLabel(step)} repeats an existing step id.`,
          fixHint: 'Give every step section one unique numeric N.M id.',
        }];
      });
    },
  },
  {
    id: 'missing-prompt',
    severity: 'error',
    find: ({ steps }) => steps
      .filter((step) => !step.prompt.trim())
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has no fenced prompt.`,
        fixHint: 'Add one non-empty fenced prompt inside the step section.',
      })),
  },
  {
    id: 'missing-acceptance',
    severity: 'error',
    find: ({ steps }) => steps
      .filter((step) => !/^\s*ACCEPTANCE\s*:/im.test(step.prompt))
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has no ACCEPTANCE section.`,
        fixHint: 'Add observable acceptance criteria to the fenced step prompt.',
      })),
  },
  {
    id: 'invalid-check',
    severity: 'error',
    find: ({ steps }) => steps.flatMap((step) => {
      try {
        parseExecutableChecks(step.prompt);
        return [];
      } catch (error) {
        return [{
          ...stepTarget(step),
          message: `${stepLabel(step)} has an invalid executable CHECK: ${error.message}`,
          fixHint: 'Use CHECK: followed by one JSON object with command and supported fields.',
        }];
      }
    }),
  },
  {
    id: 'checklist-mismatch',
    severity: 'error',
    find: findChecklistMismatches,
  },
  {
    id: 'step-count',
    severity: 'warning',
    find: ({ avoidAboveSteps, steps }) => steps.length > avoidAboveSteps
      ? [{
          ...campaignTarget(steps[0]?.line ?? 1),
          message: `This plan has ${steps.length} steps; lessons advise avoiding more than ${avoidAboveSteps}.`,
          fixHint: 'Bundle steps that share files, context, and verification.',
        }]
      : [],
  },
  {
    id: 'required-reading-size',
    severity: 'warning',
    find: ({ steps }) => steps
      .filter((step) => countRequiredReadingItems(step.prompt) > MAX_REQUIRED_READING_ITEMS)
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has more than ${MAX_REQUIRED_READING_ITEMS} required-reading items.`,
        fixHint: 'Keep only the files and symbols needed to start this step.',
      })),
  },
  {
    id: 'missing-final-review',
    severity: 'error',
    find: ({ finalReview, finalReviewHeadings }) => (
      finalReviewHeadings.length === 1 && finalReview?.code?.content?.trim()
    )
      ? []
      : [{
          ...campaignTarget(1, 'campaign-review'),
          message: finalReviewHeadings.length > 1
            ? `This plan has ${finalReviewHeadings.length} campaign-level Final review sections.`
            : 'This plan has no campaign-level final review prompt.',
          fixHint: 'Keep one ## Final review section with a fenced review prompt.',
        }],
  },
  {
    id: 'final-review-check',
    severity: 'error',
    find: ({ checklistChecks }) => {
      const matches = checklistChecks.filter((check) => /^final\s+review\s*$/i.test(check.text));
      return matches.length === 1
        ? []
        : [{
            ...campaignTarget(matches[0]?.lineStart + 1 || 1, 'campaign-review'),
            message: `This plan has ${matches.length} campaign-level Final review checklist items.`,
            fixHint: 'Keep exactly one - [ ] Final review item in the progress checklist.',
          }];
    },
  },
  {
    id: 'missing-check',
    severity: 'info',
    find: ({ steps }) => steps
      .filter((step) => !step.prompt.split('\n').some((line) => EXECUTABLE_CHECK_LINE_REGEX.test(line)))
      .map((step) => ({
        ...stepTarget(step),
        message: `${stepLabel(step)} has no executable CHECK.`,
        fixHint: 'Add a CHECK line when acceptance can be verified by a command.',
      })),
  },
];

export function resolveAvoidAboveSteps(lessons) {
  const learned = lessons?.sizing?.avoidAboveSteps;
  return positiveWholeNumber(learned) ? learned : DEFAULT_AVOID_ABOVE_STEPS;
}

export function analyzePlanHealth(markdown, avoidAboveSteps = DEFAULT_AVOID_ABOVE_STEPS) {
  const blocks = parseMarkdown(markdown);
  const steps = stepContexts(blocks, markdown);
  const context = {
    avoidAboveSteps: positiveWholeNumber(avoidAboveSteps)
      ? avoidAboveSteps
      : DEFAULT_AVOID_ABOVE_STEPS,
    checklistChecks: progressChecklistBlocks(blocks).filter((block) => block.type === 'check'),
    finalReview: extractFinalReview(blocks),
    finalReviewHeadings: blocks.filter((block) => (
      block.type === 'heading' && block.level === 2 && /^final\s+review\s*$/i.test(block.text)
    )),
    phases: extractPhases(blocks),
    steps,
    title: blocks.find((block) => block.type === 'heading' && block.level === 1) ?? null,
  };

  return PLAN_HEALTH_RULES.flatMap((rule) => rule.find(context).map((finding) => ({
    ruleId: rule.id,
    severity: rule.severity,
    ...finding,
  })));
}

function findChecklistMismatches({ checklistChecks, steps }) {
  const counts = new Map(steps.map((step) => [step.number, 0]));
  const findings = [];

  for (const check of checklistChecks) {
    if (/^final\s+review\b/i.test(check.text)) continue;
    const step = findStepForCheck(check.text, steps);
    if (step) {
      counts.set(step.number, counts.get(step.number) + 1);
    } else if (/^(?:step\s+)?\d/i.test(check.text)) {
      findings.push({
        ...campaignTarget(check.lineStart + 1),
        message: `Checklist item "${check.text}" has no matching step section.`,
        fixHint: 'Match the checklist id to one ## Step N.M — Name section.',
      });
    }
  }

  for (const step of steps) {
    const count = counts.get(step.number);
    if (count === 1) continue;
    findings.push({
      ...stepTarget(step),
      message: `${stepLabel(step)} has ${count} matching progress checklist items.`,
      fixHint: 'Keep exactly one matching checklist item for this step.',
    });
  }
  return findings;
}

function stepContexts(blocks, markdown) {
  return extractStepSections(blocks, markdown).map((section) => {
    const headingIndex = blocks.findIndex((block) => block.id === section.anchorId);
    const heading = blocks[headingIndex];
    let prompt = '';

    for (let index = headingIndex + 1; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'heading' && block.level <= 2) break;
      if (block.type === 'code') {
        prompt = block.content;
        break;
      }
    }

    return {
      ...section,
      line: (heading?.lineStart ?? 0) + 1,
      prompt,
    };
  });
}

function countRequiredReadingItems(prompt) {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => /^\s*REQUIRED READING\s*:/i.test(line));
  if (start < 0) return 0;

  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*[A-Z][A-Z ]+\s*:/.test(line)) break;
    if (/^\s*(?:\d+[.)]|[-*])\s+/.test(line)) count += 1;
  }
  return count;
}

function stepTarget(step) {
  return {
    anchorId: step.anchorId,
    line: step.line,
    stepId: step.number,
  };
}

function campaignTarget(line, anchorId = null) {
  return { anchorId, line, stepId: null };
}

function stepLabel(step) {
  return `Step ${step.number}`;
}

function positiveWholeNumber(value) {
  return Number.isInteger(value) && value > 0;
}

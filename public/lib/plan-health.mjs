import {
  EXECUTABLE_CHECK_LINE_REGEX,
  extractFinalReview,
  extractStepSections,
  parseMarkdown,
} from './parser.mjs';

export const DEFAULT_AVOID_ABOVE_STEPS = 10;
export const MAX_REQUIRED_READING_ITEMS = 5;

export const PLAN_HEALTH_RULES = [
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
    find: ({ finalReview }) => finalReview?.code
      ? []
      : [{
          ...campaignTarget(1, 'campaign-review'),
          message: 'This plan has no campaign-level final review prompt.',
          fixHint: 'Add one ## Final review section with a fenced review prompt.',
        }],
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
  const context = {
    avoidAboveSteps: positiveWholeNumber(avoidAboveSteps)
      ? avoidAboveSteps
      : DEFAULT_AVOID_ABOVE_STEPS,
    finalReview: extractFinalReview(blocks),
    steps: stepContexts(blocks, markdown),
  };

  return PLAN_HEALTH_RULES.flatMap((rule) => rule.find(context).map((finding) => ({
    ruleId: rule.id,
    severity: rule.severity,
    ...finding,
  })));
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

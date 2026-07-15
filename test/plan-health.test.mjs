import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_AVOID_ABOVE_STEPS,
  PLAN_HEALTH_RULES,
  analyzePlanHealth,
  resolveAvoidAboveSteps,
} from '../public/lib/plan-health.mjs';
import {
  parseMarkdown,
  replaceFencedBlockContent,
} from '../public/lib/parser.mjs';

const RULE_CASES = [
  {
    name: 'missing H1 title',
    ruleId: 'missing-title',
    severity: 'error',
    markdown: fixtureCampaign({ title: false }),
  },
  {
    name: 'missing checklist phase',
    ruleId: 'missing-phase',
    severity: 'error',
    markdown: fixtureCampaign({ phase: false }),
  },
  {
    name: 'missing step sections',
    ruleId: 'missing-steps',
    severity: 'error',
    markdown: fixtureCampaign({ stepCount: 0 }),
  },
  {
    name: 'missing Model chip',
    ruleId: 'missing-model',
    severity: 'error',
    markdown: fixtureCampaign({ model: false }),
  },
  {
    name: 'missing Parallel chip',
    ruleId: 'missing-parallel',
    severity: 'error',
    markdown: fixtureCampaign({ parallel: false }),
  },
  {
    name: 'non-numeric step id',
    ruleId: 'invalid-step-id',
    severity: 'error',
    markdown: fixtureCampaign({ stepId: '1' }),
  },
  {
    name: 'duplicate step id',
    ruleId: 'duplicate-step-id',
    severity: 'error',
    markdown: fixtureCampaign({ stepCount: 2, stepId: '1.1' }),
  },
  {
    name: 'missing fenced prompt',
    ruleId: 'missing-prompt',
    severity: 'error',
    markdown: fixtureCampaign({ prompt: false }),
  },
  {
    name: 'missing ACCEPTANCE',
    ruleId: 'missing-acceptance',
    severity: 'error',
    markdown: fixtureCampaign({ acceptance: false }),
  },
  {
    name: 'invalid executable CHECK',
    ruleId: 'invalid-check',
    severity: 'error',
    markdown: fixtureCampaign({ invalidCheck: true }),
  },
  {
    name: 'unlinked checklist',
    ruleId: 'checklist-mismatch',
    severity: 'error',
    markdown: fixtureCampaign({ checklistItems: false }),
  },
  {
    name: 'step count above lessons threshold',
    ruleId: 'step-count',
    severity: 'warning',
    markdown: fixtureCampaign({ stepCount: 2 }),
    avoidAboveSteps: 1,
  },
  {
    name: 'bloated REQUIRED READING',
    ruleId: 'required-reading-size',
    severity: 'warning',
    markdown: fixtureCampaign({ readingCount: 6 }),
  },
  {
    name: 'missing final review',
    ruleId: 'missing-final-review',
    severity: 'error',
    markdown: fixtureCampaign({ finalReview: false }),
  },
  {
    name: 'missing final review checklist item',
    ruleId: 'final-review-check',
    severity: 'error',
    markdown: fixtureCampaign({ finalReviewCheck: false }),
  },
  {
    name: 'missing executable CHECK',
    ruleId: 'missing-check',
    severity: 'info',
    markdown: fixtureCampaign({ checks: false }),
  },
];

for (const fixture of RULE_CASES) {
  test(`plan-health rule fires exactly once for ${fixture.name}`, () => {
    const findings = analyzePlanHealth(fixture.markdown, fixture.avoidAboveSteps);

    const matching = findings.filter((finding) => finding.ruleId === fixture.ruleId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].severity, fixture.severity);
    assert.equal(Number.isInteger(matching[0].line), true);
    assert.equal(typeof matching[0].fixHint, 'string');
  });
}

test('plan-health rules are registered in one shared table', () => {
  assert.deepEqual(
    PLAN_HEALTH_RULES.map(({ id, severity }) => ({ id, severity })),
    RULE_CASES.map(({ ruleId: id, severity }) => ({ id, severity })),
  );
});

test('lessons threshold resolver shares the API shape and one fallback', () => {
  const lessons = { available: true, sizing: { avoidAboveSteps: 7 } };

  assert.equal(resolveAvoidAboveSteps(lessons), 7);
  assert.equal(resolveAvoidAboveSteps({ available: false }), DEFAULT_AVOID_ABOVE_STEPS);
  assert.equal(resolveAvoidAboveSteps({ sizing: { avoidAboveSteps: null } }), DEFAULT_AVOID_ABOVE_STEPS);
});

test('fenced prompt Save edit adds and clears the inline finding state', () => {
  const clean = fixtureCampaign();
  const prompt = parseMarkdown(clean).find((block) => block.type === 'code');
  const withoutAcceptance = prompt.content.replace(
    /ACCEPTANCE:\n- The result is observable\.\n/,
    '',
  );
  const edited = replaceFencedBlockContent(clean, prompt, withoutAcceptance);

  assert.deepEqual(analyzePlanHealth(clean), []);
  assert.deepEqual(
    analyzePlanHealth(edited).map(({ ruleId, severity, stepId }) => ({ ruleId, severity, stepId })),
    [{ ruleId: 'missing-acceptance', severity: 'error', stepId: '1.1' }],
  );

  const editedPrompt = parseMarkdown(edited).find((block) => block.type === 'code');
  const restored = replaceFencedBlockContent(
    edited,
    editedPrompt,
    `${editedPrompt.content}\nACCEPTANCE:\n- The result is observable.`,
  );
  assert.deepEqual(analyzePlanHealth(restored), []);
});

function fixtureCampaign({
  acceptance = true,
  checks = true,
  checklistItems = true,
  finalReview = true,
  finalReviewCheck = true,
  invalidCheck = false,
  model = true,
  parallel = true,
  phase = true,
  prompt = true,
  readingCount = 2,
  stepId = null,
  stepCount = 1,
  title = true,
} = {}) {
  const checklist = Array.from(
    { length: stepCount },
    (_, index) => checklistItems
      ? `- [ ] Step ${stepId ?? `1.${index + 1}`} — Work ${index + 1}`
      : '',
  ).filter(Boolean).join('\n');
  const steps = Array.from({ length: stepCount }, (_, index) => {
    const step = index + 1;
    const id = stepId ?? `1.${step}`;
    const reading = Array.from(
      { length: readingCount },
      (_, item) => `${item + 1}. lib/file-${item + 1}.mjs`,
    ).join('\n');
    const promptBlock = prompt ? `

\`\`\`text
SCOPE: Do focused work.
REQUIRED READING:
${reading}
OUTPUT: Produce the result.
${acceptance ? 'ACCEPTANCE:\n- The result is observable.\n' : ''}OPEN QUESTIONS:
- None.
${checks ? `CHECK: ${invalidCheck ? '{"command":"true","timeout":1}' : '{"command":"true"}'}\n` : ''}\`\`\`` : '';
    return `## Step ${id} — Work ${step}

${model ? 'Model: Fable 5 · High / GPT-5.6-Sol · High\n' : ''}${parallel ? 'Parallel: NO\n' : ''}

Why this step exists.${promptBlock}`;
  }).join('\n\n');

  return `${title ? '# Fixture campaign\n' : ''}

## Progress checklist

${phase ? '### Phase 1 — Work\n' : ''}

${checklist}
${finalReviewCheck ? '- [ ] Final review' : ''}

${steps}

${finalReview ? '## Final review\n\n```text\nReview the complete campaign.\n```\n' : ''}`;
}

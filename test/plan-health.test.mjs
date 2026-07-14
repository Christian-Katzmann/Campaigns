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
    name: 'missing Model chip',
    ruleId: 'missing-model',
    severity: 'error',
    markdown: fixtureCampaign({ model: false }),
  },
  {
    name: 'missing ACCEPTANCE',
    ruleId: 'missing-acceptance',
    severity: 'error',
    markdown: fixtureCampaign({ acceptance: false }),
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
    name: 'missing executable CHECK',
    ruleId: 'missing-check',
    severity: 'info',
    markdown: fixtureCampaign({ checks: false }),
  },
];

for (const fixture of RULE_CASES) {
  test(`plan-health rule fires exactly once for ${fixture.name}`, () => {
    const findings = analyzePlanHealth(fixture.markdown, fixture.avoidAboveSteps);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, fixture.ruleId);
    assert.equal(findings[0].severity, fixture.severity);
    assert.equal(Number.isInteger(findings[0].line), true);
    assert.equal(typeof findings[0].fixHint, 'string');
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
  finalReview = true,
  model = true,
  readingCount = 2,
  stepCount = 1,
} = {}) {
  const checklist = Array.from(
    { length: stepCount },
    (_, index) => `- [ ] Step 1.${index + 1} — Work ${index + 1}`,
  ).join('\n');
  const steps = Array.from({ length: stepCount }, (_, index) => {
    const step = index + 1;
    const reading = Array.from(
      { length: readingCount },
      (_, item) => `${item + 1}. lib/file-${item + 1}.mjs`,
    ).join('\n');
    return `## Step 1.${step} — Work ${step}

${model ? 'Model: Fable 5 · High / GPT-5.6-Sol · High\n' : ''}Parallel: NO

Why this step exists.

\`\`\`text
SCOPE: Do focused work.
REQUIRED READING:
${reading}
OUTPUT: Produce the result.
${acceptance ? 'ACCEPTANCE:\n- The result is observable.\n' : ''}OPEN QUESTIONS:
- None.
${checks ? 'CHECK: {"command":"true"}\n' : ''}\`\`\``;
  }).join('\n\n');

  return `# Fixture campaign

## Progress checklist

### Phase 1 — Work

${checklist}
- [ ] Final review

${steps}

${finalReview ? '## Final review\n\n```text\nReview the complete campaign.\n```\n' : ''}`;
}

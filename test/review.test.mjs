import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REVIEW_REASON_ALIASES,
  REVIEW_REASON_TAGS,
  buildFixPrompt,
  isValidReviewPath,
  parseReviewOutput,
} from '../lib/review.mjs';

const EXPECTED_TAGS = [
  'verification-gap',
  'scope-drift',
  'acceptance-miss',
  'cross-step-contract',
  'visual-regression',
  'tooling-failure',
  'scheduler-failure',
  'branch-prep-failure',
  'data-quality-gap',
  'documentation-gap',
];

const EXPECTED_ALIASES = {
  'missing-verification': 'verification-gap',
  verification: 'verification-gap',
  'no-proof': 'verification-gap',
  scope: 'scope-drift',
  'missed-acceptance': 'acceptance-miss',
  'acceptance-gap': 'acceptance-miss',
  'contract-gap': 'cross-step-contract',
  'cross-phase-shortcut': 'cross-step-contract',
  'tool-failure': 'tooling-failure',
  'registry-failure': 'scheduler-failure',
  'handoff-failure': 'scheduler-failure',
  'branch-failure': 'branch-prep-failure',
  'worktree-failure': 'branch-prep-failure',
  'data-gap': 'data-quality-gap',
  'doc-gap': 'documentation-gap',
};

test('clean APPROVED and NEEDS WORK verdicts parse into structured results', () => {
  assert.deepEqual(parseReviewOutput('Verdict: APPROVED\nReasons:\n\nEverything landed.'), {
    valid: true,
    verdict: 'APPROVED',
    reasons: [],
    raw_tags: [],
    findings: [],
    issue: null,
  });
  assert.deepEqual(
    parseReviewOutput('Verdict: NEEDS WORK\nReasons: verification-gap, scope-drift'),
    {
      valid: true,
      verdict: 'NEEDS WORK',
      reasons: ['verification-gap', 'scope-drift'],
      raw_tags: [],
      findings: [],
      issue: null,
    },
  );
});

test('structured findings keep canonical reasons and canonical repo-relative paths', () => {
  const parsed = parseReviewOutput([
    'Verdict: NEEDS WORK',
    'Reasons: acceptance-miss',
    'Findings: [{"reason":"acceptance-miss","paths":["lib/review.mjs","test/review.test.mjs"]}]',
  ].join('\n'));
  assert.deepEqual(parsed.findings, [{
    reason: 'acceptance-miss',
    paths: ['lib/review.mjs', 'test/review.test.mjs'],
  }]);

  for (const invalid of ['/tmp/file', '../file', 'lib/../file', 'C:/file', 'lib\\file']) {
    assert.equal(isValidReviewPath(invalid), false, invalid);
    assert.equal(parseReviewOutput([
      'Verdict: NEEDS WORK',
      'Reasons: acceptance-miss',
      `Findings: [{"reason":"acceptance-miss","paths":[${JSON.stringify(invalid)}]}]`,
    ].join('\n')).issue, 'invalid-findings');
  }
});

test('the canonical 10-tag set and every maintained alias normalize exactly', () => {
  assert.deepEqual(REVIEW_REASON_TAGS, EXPECTED_TAGS);
  assert.deepEqual(REVIEW_REASON_ALIASES, EXPECTED_ALIASES);

  for (const [alias, canonical] of Object.entries(EXPECTED_ALIASES)) {
    const parsed = parseReviewOutput(`Verdict: NEEDS WORK\nReasons: ${alias}`);
    assert.deepEqual(parsed.reasons, [canonical], alias);
    assert.deepEqual(parsed.raw_tags, [], alias);
  }
});

test('prose and invented reasons survive whole in raw_tags without word splitting', () => {
  const prose = parseReviewOutput(
    'Verdict: NEEDS WORK\nReasons: Read the cumulative diff before approving',
  );
  assert.deepEqual(prose.raw_tags, ['Read the cumulative diff before approving']);
  assert.notDeepEqual(prose.raw_tags, ['read', 'the', 'cumulative']);

  const invented = parseReviewOutput(
    'Verdict: NEEDS WORK\nReasons: safety-plane-unwired, documentation-gap',
  );
  assert.deepEqual(invented.reasons, ['documentation-gap']);
  assert.deepEqual(invented.raw_tags, ['safety-plane-unwired']);
});

test('verdict extraction tolerates leading noise and a header buried mid-text', () => {
  const parsed = parseReviewOutput(
    'I checked the cumulative diff.\n\nVerdict: NEEDS WORK\nReasons: acceptance-gap\n\nOne miss.',
  );
  assert.equal(parsed.valid, true);
  assert.equal(parsed.verdict, 'NEEDS WORK');
  assert.deepEqual(parsed.reasons, ['acceptance-miss']);
});

test('missing or conflicting verdict headers remain structurally invalid', () => {
  assert.equal(parseReviewOutput('Reasons: verification-gap').issue, 'missing-verdict');
  assert.equal(
    parseReviewOutput('Verdict: APPROVED\nVerdict: NEEDS WORK\nReasons: scope-drift').issue,
    'ambiguous-verdict',
  );
});

test('fix prompts accept executable-check context without pretending it is a review', () => {
  const prompt = buildFixPrompt({
    state: {
      run: {
        identity: {
          execution: {
            campaign_path: '/repo/campaign.md',
            branch: 'campaign/checks',
            merge_target_branch: 'main',
          },
        },
      },
    },
    context: {
      instruction: 'Fix executable checks for Step 1.2.',
      evidenceHeading: 'Failing checks',
      evidence: 'Command: npm test\nOutput: failed',
      acceptanceCriteria: 'Tests pass.',
    },
  });

  assert.match(prompt, /^Fix executable checks for Step 1\.2\./);
  assert.match(prompt, /## Failing checks\n\nCommand: npm test/);
  assert.match(prompt, /## Acceptance criteria\n\nTests pass\./);
  assert.match(prompt, /git diff main\.\.\.campaign\/checks/);
  assert.doesNotMatch(prompt, /## Review/);
});

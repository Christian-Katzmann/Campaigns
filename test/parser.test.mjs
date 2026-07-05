// Characterization tests for the markdown pipeline (public/lib/parser.mjs).
//
// These pin *current* behavior against the two public-safe campaigns. They are
// not aspirational — if an assertion looks like it encodes a bug, that bug is
// being characterized on purpose so the refactor can't silently change it.
// Change these numbers only when you intend to change what the parser does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  classifyPhases,
  ensureFinalReviewLines,
  extractPhases,
  extractStepSections,
  findCheckLinkTarget,
  findResumeTarget,
  findStepForCheck,
  getProgressStats,
  isNewShapeCampaign,
  linkChecksToSteps,
  parseMarkdown,
  progressChecklistBlocks,
} from '../public/lib/parser.mjs';

function read(relativeFromRepoRoot) {
  return readFileSync(new URL(`../${relativeFromRepoRoot}`, import.meta.url), 'utf8');
}

const SAMPLE = read('examples/sample-campaign.md');
const PUBLICATION = read('design/demo-data/publication-campaign.md');

function countByType(blocks) {
  return blocks.reduce((acc, block) => {
    acc[block.type] = (acc[block.type] || 0) + 1;
    return acc;
  }, {});
}

/* --------------------------- examples/sample-campaign.md ---------------------------- */

test('sample: block counts and types', () => {
  const blocks = parseMarkdown(SAMPLE);
  assert.equal(blocks.length, 29);
  assert.deepEqual(countByType(blocks), {
    heading: 10,
    quote: 1,
    paragraph: 9,
    list: 1,
    check: 4,
    code: 4,
  });
});

test('sample: phase structure', () => {
  const blocks = parseMarkdown(SAMPLE);
  const phases = classifyPhases(extractPhases(blocks));
  assert.equal(phases.length, 1);
  const [p] = phases;
  assert.equal(p.number, '1');
  assert.equal(p.title, 'Phase 1 - Draft and publish');
  assert.equal(p.anchorId, 'phase-1---draft-and-publish-5');
  assert.equal(p.done, 0);
  assert.equal(p.total, 4);
  assert.equal(p.state, 'todo');
});

test('sample: step sections carry numbers, anchor ids, and metadata', () => {
  const blocks = parseMarkdown(SAMPLE);
  const steps = extractStepSections(blocks, SAMPLE);
  assert.deepEqual(
    steps.map((s) => [s.number, s.anchorId]),
    [
      ['1.1', 'step-11---draft-the-note-6'],
      ['1.2', 'step-12---tighten-the-note-7'],
      ['1.3', 'step-13---publish-the-note-8'],
    ],
  );
  // Every step declares `Model: GPT-5.5 - High` / `Parallel: NO`.
  for (const s of steps) {
    assert.deepEqual(s.model, { claudeCode: 'GPT-5.5 - High', codex: '' });
    assert.deepEqual(s.parallel, { isParallel: false, siblingSteps: [] });
  }
});

test('sample: checks link to their step sections', () => {
  const blocks = parseMarkdown(SAMPLE);
  const steps = extractStepSections(blocks, SAMPLE);
  const map = linkChecksToSteps(blocks, steps);
  assert.equal(map.size, 3);
  assert.equal(map.get('step-11---draft-the-note-6')?.text, 'Step 1.1 - Draft the note');
  assert.equal(map.get('step-12---tighten-the-note-7')?.text, 'Step 1.2 - Tighten the note');
  assert.equal(map.get('step-13---publish-the-note-8')?.text, 'Step 1.3 - Publish the note');

  // The campaign-level "Final review" check resolves to the campaign-review anchor.
  assert.deepEqual(findCheckLinkTarget('Final review', steps), { anchorId: 'campaign-review' });
});

test('sample: progress totals count only the checklist section', () => {
  const blocks = parseMarkdown(SAMPLE);
  assert.deepEqual(getProgressStats(blocks), { done: 0, total: 4 });
  // Scoping: the 4 counted checks all live under "Progress checklist".
  const scoped = progressChecklistBlocks(blocks);
  assert.equal(scoped.filter((b) => b.type === 'check').length, 4);
});

test('sample: resume points at the first unchecked step, and is new-shape', () => {
  const blocks = parseMarkdown(SAMPLE);
  const steps = extractStepSections(blocks, SAMPLE);
  const resume = findResumeTarget(blocks, steps);
  assert.equal(resume.targetId, 'step-11---draft-the-note-6');
  assert.equal(resume.checkText, 'Step 1.1 - Draft the note');
  assert.equal(isNewShapeCampaign(blocks), true);
});

/* ---------------------- design/demo-data/publication-campaign.md -------------------- */

test('publication: block counts and types', () => {
  const blocks = parseMarkdown(PUBLICATION);
  assert.equal(blocks.length, 29);
  assert.deepEqual(countByType(blocks), {
    heading: 10,
    quote: 1,
    paragraph: 9,
    list: 1,
    check: 4,
    code: 4,
  });
});

test('publication: phase is in flight (1 of 4 done)', () => {
  const blocks = parseMarkdown(PUBLICATION);
  const phases = classifyPhases(extractPhases(blocks));
  assert.equal(phases.length, 1);
  const [p] = phases;
  assert.equal(p.number, '1');
  assert.equal(p.done, 1);
  assert.equal(p.total, 4);
  assert.equal(p.state, 'flight');
});

test('publication: step anchor ids', () => {
  const blocks = parseMarkdown(PUBLICATION);
  const steps = extractStepSections(blocks, PUBLICATION);
  assert.deepEqual(
    steps.map((s) => [s.number, s.anchorId]),
    [
      ['1.1', 'step-11---draft-the-installation-path-6'],
      ['1.2', 'step-12---capture-the-product-proof-7'],
      ['1.3', 'step-13---tighten-the-release-notes-8'],
    ],
  );
});

test('publication: progress totals and resume (step 1.1 is done)', () => {
  const blocks = parseMarkdown(PUBLICATION);
  const steps = extractStepSections(blocks, PUBLICATION);
  assert.deepEqual(getProgressStats(blocks), { done: 1, total: 4 });
  // First unchecked box is 1.2, so resume jumps there.
  assert.equal(findResumeTarget(blocks, steps).targetId, 'step-12---capture-the-product-proof-7');
});

/* ------------------------- findStepForCheck matching rules -------------------------- */

test('findStepForCheck tolerates an optional "Step " prefix and dash ranges', () => {
  const steps = [
    { number: '1.1', anchorId: 'a' },
    { number: '1.2', anchorId: 'b' },
    { number: '2.10', anchorId: 'c' },
  ];
  assert.equal(findStepForCheck('Step 1.1 — Draft', steps)?.anchorId, 'a');
  assert.equal(findStepForCheck('1.2 Tighten', steps)?.anchorId, 'b');
  assert.equal(findStepForCheck('2.10 something', steps)?.anchorId, 'c');
  assert.equal(findStepForCheck('No number here', steps), null);
});

/* ------------------------------ ensureFinalReviewLines ------------------------------ */

test('ensureFinalReviewLines: idempotent and a no-op on new-shape campaigns', () => {
  for (const md of [SAMPLE, PUBLICATION]) {
    const once = ensureFinalReviewLines(md);
    const twice = ensureFinalReviewLines(once);
    // Running it twice equals running it once.
    assert.equal(twice, once);
    // New-shape campaigns already own a campaign-level Final review, so nothing
    // is injected.
    assert.equal(once, md);
  }
});

test('ensureFinalReviewLines: injects one per-phase Final review on legacy shape, then idempotent', () => {
  // Legacy shape: per-phase checklists, no campaign-level `## Final review`.
  const legacy = [
    '# Legacy campaign',
    '',
    '## Progress checklist',
    '',
    '### Phase 1 — Build',
    '',
    '- [ ] Step 1.1 — Do a thing',
    '- [ ] Step 1.2 — Do another thing',
    '',
    '### Phase 2 — Ship',
    '',
    '- [ ] Step 2.1 — Ship it',
    '',
    '## Step 1.1 — Do a thing',
    '',
    'Body.',
    '',
  ].join('\n');

  const once = ensureFinalReviewLines(legacy);
  const twice = ensureFinalReviewLines(once);
  assert.equal(twice, once, 'second pass must equal the first');

  // Exactly one Final review line was added per phase.
  const added = once.split('\n').filter((l) => /^- \[ \] Final review — Phase \d/.test(l));
  assert.deepEqual(added, ['- [ ] Final review — Phase 1', '- [ ] Final review — Phase 2']);

  // Each line lands directly after that phase's last bullet.
  const lines = once.split('\n');
  assert.equal(lines[lines.indexOf('- [ ] Step 1.2 — Do another thing') + 1], '- [ ] Final review — Phase 1');
  assert.equal(lines[lines.indexOf('- [ ] Step 2.1 — Ship it') + 1], '- [ ] Final review — Phase 2');
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  PROJECT_TREE_MAX_CHARACTERS,
  PlannerDraftError,
  buildPlannerPrompt,
  buildProjectTree,
  normalizePlannerMarkdown,
  validateDraftedCampaign,
} from '../lib/planner.mjs';

const execFileAsync = promisify(execFile);

test('project tree is depth-2, ignores node_modules, and honors its serialized cap', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'campaigns-planner-tree-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', repo, 'init', '-b', 'main']);
  await mkdir(path.join(repo, 'src', 'feature'), { recursive: true });
  await mkdir(path.join(repo, 'node_modules', 'hidden'), { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
  await writeFile(path.join(repo, 'README.md'), '# Fixture\n', 'utf8');
  await writeFile(path.join(repo, 'src', 'feature', 'index.mjs'), 'export {};\n', 'utf8');
  await writeFile(path.join(repo, 'node_modules', 'hidden', 'index.js'), 'nope\n', 'utf8');

  const tree = await buildProjectTree(repo);
  assert.match(tree, /- README\.md/);
  assert.match(tree, /- src\/feature\//);
  assert.doesNotMatch(tree, /index\.mjs|node_modules/);
  assert.ok(tree.length <= PROJECT_TREE_MAX_CHARACTERS);
});

test('planner prompt injects intent, bounded tree, and one exact default chip', () => {
  const prompt = buildPlannerPrompt({
    intent: 'Ship a compact planning flow.',
    modelValue: 'Fable 5 · High / GPT-5.6-Sol · Extra High',
    projectRoot: '/tmp/project',
    projectTree: '- lib/planner.mjs',
    template: 'Rules\nPROJECT DESCRIPTION:\n{{PASTE THE PROJECT DESCRIPTION HERE}}',
  });
  assert.match(prompt, /Write this exact line below every step heading: Model: Fable 5 · High \/ GPT-5\.6-Sol · Extra High/);
  assert.match(prompt, /Do not tune individual steps/);
  assert.match(prompt, /Ship a compact planning flow/);
  assert.match(prompt, /- lib\/planner\.mjs/);
});

test('draft validation requires parser-complete structure and the selected chip on every step', () => {
  const modelValue = 'Fake Planner · Maximum';
  const markdown = fixtureDraft(modelValue);
  const validated = validateDraftedCampaign(markdown, { modelValue });
  assert.equal(validated.title, 'Drafted fixture');
  assert.equal(validated.findings.filter((finding) => finding.severity === 'error').length, 0);

  assert.throws(
    () => validateDraftedCampaign(markdown.replace(modelValue, 'Wrong Model · Low'), { modelValue }),
    (error) => error instanceof PlannerDraftError
      && error.statusCode === 422
      && /selected default Model chip/.test(error.message),
  );
  assert.equal(normalizePlannerMarkdown(`\`\`\`markdown\n${markdown}\n\`\`\``), markdown.trim());
});

function fixtureDraft(modelValue) {
  const prompt = (scope) => `\`\`\`text
SCOPE: ${scope}
REQUIRED READING:
1. README.md
OUTPUT: A verified result.
ACCEPTANCE:
- The result exists.
OPEN QUESTIONS:
- None.
FORWARD SWEEP: before checking this step off, do a quick pass over the campaign's remaining step prompts. If your work moved a path, changed a contract or shape, or invalidated an assumption a later step leans on, make a surgical edit there. A quick sweep, not a rewrite — skip it if nothing downstream changed.
\`\`\``;
  return `# Drafted fixture

> A clear fixture campaign.

## Progress checklist

### Phase 1 — Prepare

- [ ] Step 1.1 — Prepare

### Phase 2 — Ship

- [ ] Step 2.1 — Ship
- [ ] Final review

## Step 1.1 — Prepare

Model: ${modelValue}
Parallel: NO

${prompt('Prepare the result.')}

## Step 2.1 — Ship

Model: ${modelValue}
Parallel: NO

${prompt('Ship the result.')}

## Final review

\`\`\`text
Review the complete result and return APPROVED or NEEDS WORK.
\`\`\`
`;
}

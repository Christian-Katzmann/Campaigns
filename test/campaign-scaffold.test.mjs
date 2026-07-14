import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createCampaignFromMarkdown,
  createCampaignScaffold,
  normalizeCampaignName,
} from '../lib/campaign-scaffold.mjs';
import {
  classifyPhases,
  extractPhases,
  extractStepSections,
  getProgressStats,
  isNewShapeCampaign,
  parseMarkdown,
} from '../public/lib/parser.mjs';

test('campaign names reject path separators and traversal', () => {
  for (const name of ['../escape', 'nested/name', 'nested\\name']) {
    assert.throws(
      () => normalizeCampaignName(name),
      (error) => error.statusCode === 400 && /path separators or traversal/.test(error.message),
    );
  }
});

test('campaign creation is exclusive and reports an existing file as 409', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'campaign-scaffold-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));

  const first = await createCampaignScaffold({ name: 'Launch Notes', projectPath });
  const original = await readFile(first.filePath, 'utf8');

  await assert.rejects(
    createCampaignScaffold({ name: 'Launch Notes', projectPath }),
    (error) => error.statusCode === 409,
  );
  assert.equal(await readFile(first.filePath, 'utf8'), original);
});

test('drafted markdown uses the same safe slug and exclusive create contract', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'campaign-draft-scaffold-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const created = await createCampaignFromMarkdown({
    markdown: '# Planned Launch\n\nDrafted content.\n',
    name: 'Planned Launch',
    projectPath,
  });
  assert.equal(path.basename(created.filePath), 'planned-launch.md');
  assert.equal(await readFile(created.filePath, 'utf8'), '# Planned Launch\n\nDrafted content.\n');
  await assert.rejects(
    createCampaignFromMarkdown({
      markdown: '# Planned Launch\n',
      name: 'Planned Launch',
      projectPath,
    }),
    (error) => error.statusCode === 409,
  );
});

test('scaffolded markdown follows the normal campaign parser path', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'campaign-scaffold-parser-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));

  const created = await createCampaignScaffold({ name: 'First Campaign', projectPath });
  const markdown = await readFile(created.filePath, 'utf8');
  const blocks = parseMarkdown(markdown);
  const phases = classifyPhases(extractPhases(blocks));
  const steps = extractStepSections(blocks, markdown);

  assert.equal(phases.length, 1);
  assert.deepEqual(steps.map((step) => step.number), ['1.1', '1.2']);
  assert.deepEqual(getProgressStats(blocks), { done: 0, total: 3 });
  assert.equal(isNewShapeCampaign(blocks), true);
});

test('empty state links the bundled paste-anywhere planner prompt', async () => {
  const [index, prompt] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../docs/paste-anywhere-planner.md', import.meta.url), 'utf8'),
  ]);

  assert.match(index, /href="\/planner-prompt"/);
  assert.match(prompt, /^Turn the project description/);
  assert.match(prompt, /^## Progress checklist$/m);
  assert.match(prompt, /^## Final review$/m);
});

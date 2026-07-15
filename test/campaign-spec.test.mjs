import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { parseCampaignPlan, runPathsForCampaign } from '../lib/pump.mjs';
import { campaignFileName, campaignFileStem } from '../public/lib/campaign-file.mjs';
import { analyzePlanHealth } from '../public/lib/plan-health.mjs';
import {
  extractFinalReview,
  extractPhases,
  extractStepSections,
  parseMarkdown,
} from '../public/lib/parser.mjs';

const execFileAsync = promisify(execFile);
const fixtureDir = new URL('./fixtures/campaign-spec/v1/', import.meta.url);

async function fixture(name) {
  return readFile(new URL(name, fixtureDir), 'utf8');
}

test('v1 valid fixtures conform through parser output and plan health', async () => {
  for (const name of ['valid-minimal.campaign.md', 'valid-full.campaign.md']) {
    const markdown = await fixture(name);
    const blocks = parseMarkdown(markdown);
    const steps = extractStepSections(blocks, markdown);
    assert.ok(extractPhases(blocks).length > 0, name);
    assert.ok(steps.length > 0, name);
    assert.ok(extractFinalReview(blocks)?.code, name);
    assert.deepEqual(
      analyzePlanHealth(markdown).filter((finding) => finding.severity === 'error'),
      [],
      name,
    );
  }
});

test('the full fixture pins metadata and CHECK output shapes', async () => {
  const markdown = await fixture('valid-full.campaign.md');
  const steps = extractStepSections(parseMarkdown(markdown), markdown);
  assert.deepEqual(steps.map((step) => step.number), ['1.1', '1.2']);
  assert.deepEqual(steps[0].model, {
    primary: 'Fable 5 · Max',
    alternate: 'GPT-5.6-Sol · Extra High',
    claudeCode: 'Fable 5 · Max',
    codex: 'GPT-5.6-Sol · Extra High',
  });
  assert.deepEqual(steps[0].parallel, { isParallel: true, siblingSteps: ['1.2'] });
  assert.deepEqual(steps[0].lane, { globs: ['output/write.txt'] });
  assert.deepEqual(parseCampaignPlan(markdown).steps[0].checks, [{
    command: 'test -f output/write.txt',
    expectedExit: 0,
    expectedOutput: null,
    timeoutMs: 5_000,
  }]);
});

test('v1 invalid fixtures stay parseable and are rejected by plan health', async () => {
  const expected = new Map([
    ['invalid-missing-model.campaign.md', 'missing-model'],
    ['invalid-malformed-check.campaign.md', 'invalid-check'],
    ['invalid-unlinked-checklist.campaign.md', 'checklist-mismatch'],
  ]);
  const names = (await readdir(fixtureDir)).filter((name) => name.startsWith('invalid-'));
  assert.deepEqual(names.sort(), [...expected.keys()].sort());

  for (const name of names) {
    const markdown = await fixture(name);
    assert.ok(parseMarkdown(markdown).length > 0, name);
    const errors = analyzePlanHealth(markdown).filter((finding) => finding.severity === 'error');
    assert.ok(errors.some((finding) => finding.ruleId === expected.get(name)), name);
  }
});

test('ordinary Markdown remains parser input even when it is not a campaign plan', () => {
  const markdown = '# Notes\n\nThis is ordinary prose.\n';
  assert.deepEqual(parseMarkdown(markdown).map((block) => block.type), ['heading', 'paragraph']);
  assert.ok(analyzePlanHealth(markdown).some((finding) => finding.severity === 'error'));
});

test('compound and legacy filenames share one semantic stem', () => {
  assert.equal(campaignFileName('/repo/campaigns/launch.campaign.md'), 'launch.campaign.md');
  assert.equal(campaignFileName('C:\\repo\\campaigns\\launch.md'), 'launch.md');
  assert.equal(campaignFileStem('/repo/campaigns/launch.campaign.md'), 'launch');
  assert.equal(campaignFileStem('/repo/campaigns/launch.md'), 'launch');
  assert.equal(campaignFileStem('/repo/campaigns/LAUNCH.CAMPAIGN.MD'), 'LAUNCH');

  const compound = path.basename(runPathsForCampaign('/repo/launch.campaign.md', '/runs').runDir);
  const legacy = path.basename(runPathsForCampaign('/repo/launch.md', '/runs').runDir);
  assert.match(compound, /^launch-[a-f0-9]{12}$/);
  assert.match(legacy, /^launch-[a-f0-9]{12}$/);
});

test('all semantic filename consumers use the shared helper', async () => {
  const consumers = new Map([
    ['lib/campaign-scaffold.mjs', 'CAMPAIGN_FILE_EXTENSION'],
    ['lib/automate-providers.mjs', 'campaignFileStem'],
    ['lib/pump.mjs', 'campaignFileStem'],
    ['lib/worktrees.mjs', 'campaignFileStem'],
    ['server.mjs', 'campaignFileStem'],
    ['public/modules/render.mjs', 'campaignFileStem'],
  ]);
  for (const [relativePath, helper] of consumers) {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`import \\{[^}]*${helper}[^}]*\\}`), relativePath);
    assert.ok(source.split(helper).length > 2, relativePath);
  }
});

test('the v1 compound fixture passes the public lint command', async () => {
  const fixturePath = fileURLToPath(new URL('valid-full.campaign.md', fixtureDir));
  const cli = fileURLToPath(new URL('../bin/campaigns.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, 'lint', fixturePath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  assert.match(stdout, /valid-full\.campaign\.md: clean/);
});

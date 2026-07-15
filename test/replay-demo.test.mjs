import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { foldRunJournal, readRunJournal } from '../lib/run-journal.mjs';
import { buildReplayDemo, buildReplayTimeline } from '../scripts/build-replay-demo.mjs';

const journalPath = path.resolve('replay/hello-run.journal.jsonl');

test('recorded hello run replays exact board documents through final review', async () => {
  const events = await readRunJournal(journalPath, { repairTornTail: false });
  const points = buildReplayTimeline(events);
  const sourceMarkdown = await readFile('examples/hello-run.md', 'utf8');

  assert.equal(foldRunJournal(events).exact_replay, true);
  assert.equal(points[0].markdown, sourceMarkdown);
  for (const [index, point] of points.entries()) {
    assert.equal(point.markdown, foldRunJournal(events.slice(0, index + 1)).current_document.markdown);
  }

  const firstCompleted = points.find((point) => point.kind === 'step_checked' && point.step_id === '1.1');
  const secondCompleted = points.find((point) => point.kind === 'step_checked' && point.step_id === '1.2');
  assert.match(firstCompleted.markdown, /- \[x\] Step 1\.1/);
  assert.match(firstCompleted.markdown, /- \[ \] Step 1\.2/);
  assert.match(secondCompleted.markdown, /- \[x\] Step 1\.1/);
  assert.match(secondCompleted.markdown, /- \[x\] Step 1\.2/);
  assert.equal(points.at(-1).run_status, 'completed');
  assert.equal(points.at(-1).review_status, 'approved');

  const raw = await readFile(journalPath, 'utf8');
  assert.doesNotMatch(raw, /\/Users\/|christiankatzmann|campaigns-replay-recording-/i);
});

test('replay build emits one file-only page below the landing-page weight target', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-replay-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await buildReplayDemo({ outputDir: root });
  const files = await readdir(root);
  const html = await readFile(result.indexPath, 'utf8');

  assert.deepEqual(files, ['index.html']);
  assert.ok(result.bytes < 1_000_000, `${result.bytes} bytes exceeds the 1 MB target`);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'unsafe-inline' blob:/);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["']/i);
  assert.doesNotMatch(html, /\b(?:href|src)=["'](?:https?:)?\/\//i);
  assert.match(html, /globalThis\.__CAMPAIGNS_REPLAY__/);
  assert.match(html, /renderReadOnlyBoard/);
});

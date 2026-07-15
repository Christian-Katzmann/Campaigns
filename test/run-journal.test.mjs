import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  foldRunJournal,
  hashRunDocument,
  readRunJournal,
  runJournalPath,
} from '../lib/run-journal.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';
import {
  persistRunState,
  readRunState,
  writeRunDocumentTransition,
} from '../lib/run-state-store.mjs';

test('native journal folds to state.json at every boundary and replays exact board documents', async (t) => {
  const fixture = await fixtureRun(t);
  const states = [];
  let state = fixture.state;
  state = transitionRunState(state, { event: 'run_started', at: at(1) });
  states.push(structuredClone(state));
  await persistRunState(fixture.statePath, state);

  let journal = await readRunJournal(fixture.journalPath);
  assert.deepEqual(foldRunJournal(journal).state, state);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')), state);

  state = transitionRunState(state, {
    event: 'step_started',
    at: at(2),
    step_id: '1.1',
    worker: {
      runner: 'fixture',
      invocation_id: 'worker-1',
      pid: 123,
      log_path: path.join(fixture.root, 'worker.log'),
    },
  });
  states.push(structuredClone(state));
  await persistRunState(fixture.statePath, state);

  const workerEdited = `${fixture.markdown}\n<!-- worker updated the campaign -->\n`;
  await writeFile(fixture.campaignPath, workerEdited, 'utf8');
  const checked = workerEdited.replace('[ ]', '[x]');
  await writeRunDocumentTransition({
    statePath: fixture.statePath,
    campaignPath: fixture.campaignPath,
    beforeMarkdown: workerEdited,
    afterMarkdown: checked,
    kind: 'step_checked',
    stepId: '1.1',
  });

  state = transitionRunState(state, {
    event: 'step_completed',
    at: at(3),
    step_id: '1.1',
    receipt_path: path.join(fixture.root, 'receipt.md'),
    commit_range: { base_oid: '1'.repeat(40), head_oid: '2'.repeat(40) },
    details: { usage: nullUsage() },
  });
  states.push(structuredClone(state));
  await persistRunState(fixture.statePath, state);

  journal = await readRunJournal(fixture.journalPath);
  const stateEvents = journal.filter((event) => event.state != null);
  assert.equal(stateEvents.length, states.length);
  for (const [index, event] of stateEvents.entries()) {
    const boundary = journal.slice(0, journal.indexOf(event) + 1);
    assert.deepEqual(foldRunJournal(boundary).state, states[index]);
  }

  const folded = foldRunJournal(journal);
  assert.equal(folded.exact_replay, true);
  assert.equal(folded.replay_scope, 'native_journal');
  assert.deepEqual(
    folded.documents.map((document) => document.markdown),
    [fixture.markdown, workerEdited, checked],
  );
  assert.equal(folded.documents[1].kind, 'document_observed');
  assert.equal(folded.documents[1].before_hash, hashRunDocument(fixture.markdown));
  assert.equal(folded.documents[1].after_hash, hashRunDocument(workerEdited));
  assert.equal(folded.documents[2].before_hash, hashRunDocument(workerEdited));
  assert.equal(folded.documents[2].after_hash, hashRunDocument(checked));
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')), state);
});

test('an existing snapshot imports as one non-historical event without reading events.jsonl', async (t) => {
  const fixture = await fixtureRun(t);
  let state = transitionRunState(fixture.state, { event: 'run_started', at: at(1) });
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(fixture.root, 'events.jsonl'),
    '{"event":"fictional_history_that_must_not_be_imported"}\n',
    'utf8',
  );

  assert.deepEqual(await readRunState(fixture.statePath), state);
  const journal = await readRunJournal(fixture.journalPath);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].type, 'snapshot_imported');
  assert.equal(journal[0].replay, 'non_historical_snapshot');
  assert.equal(foldRunJournal(journal).exact_replay, false);
  assert.equal(foldRunJournal(journal).replay_scope, 'snapshot_forward_only');
  assert.doesNotMatch(await readFile(fixture.journalPath, 'utf8'), /fictional_history/);
});

test('resume drops a kill -9 torn tail and continues with a valid projection', async (t) => {
  const fixture = await fixtureRun(t);
  let state = transitionRunState(fixture.state, { event: 'run_started', at: at(1) });
  await persistRunState(fixture.statePath, state);
  const intact = await readFile(fixture.journalPath);

  await runKilledWriter(fixture.journalPath);
  assert.ok((await readFile(fixture.journalPath)).length > intact.length);

  const repaired = await readRunJournal(fixture.journalPath);
  assert.equal(repaired.length, 1);
  assert.deepEqual(await readFile(fixture.journalPath), intact);

  state = transitionRunState(state, {
    event: 'step_started',
    at: at(2),
    step_id: '1.1',
    worker: {
      runner: 'fixture',
      invocation_id: 'worker-after-kill',
      pid: 456,
      log_path: path.join(fixture.root, 'worker-after-kill.log'),
    },
  });
  await persistRunState(fixture.statePath, state);
  assert.deepEqual(await readRunState(fixture.statePath), state);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')), state);
});

async function fixtureRun(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignPath = path.join(root, 'campaign.md');
  const statePath = path.join(root, 'state.json');
  const markdown = '# Journal fixture\n\n- [ ] 1.1 First step\n';
  await writeFile(campaignPath, markdown, 'utf8');
  return {
    root,
    campaignPath,
    statePath,
    journalPath: runJournalPath(statePath),
    markdown,
    state: createRunState({
      id: 'journal-fixture',
      created_at: at(0),
      identity: {
        registry_id: null,
        source: { campaign_path: campaignPath, repo_root: root },
        execution: { campaign_path: campaignPath, repo_root: root, branch: 'campaign/journal' },
      },
      steps: [{ id: '1.1', name: 'First step', phase: '1' }],
      config: {
        runner: 'fixture',
        model: 'fixture-model',
        effort: 'none',
        watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
      },
      artifacts: {
        run_dir: root,
        receipts_dir: path.join(root, 'receipts'),
        final_review_path: path.join(root, 'final-review.md'),
      },
    }),
  };
}

function runKilledWriter(journalPath) {
  return new Promise((resolve, reject) => {
    const script = [
      "const fs = require('node:fs');",
      "const fd = fs.openSync(process.argv[1], 'a');",
      "fs.writeSync(fd, '{\"journal_version\":1,\"sequence\":2');",
      "process.kill(process.pid, 'SIGKILL');",
    ].join('');
    const child = spawn(process.execPath, ['-e', script, journalPath], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal === 'SIGKILL') resolve();
      else reject(new Error(`writer exited unexpectedly: code=${code} signal=${signal}`));
    });
  });
}

function nullUsage() {
  return { input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null };
}

function at(offset) {
  return new Date(Date.parse('2026-07-15T08:00:00.000Z') + offset * 1_000).toISOString();
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  foldRunJournal,
  hashRunJournalEvent,
  readRunJournal,
} from '../lib/run-journal.mjs';
import { createRunState, assertValidRunState, transitionRunState } from '../lib/run-state.mjs';
import {
  persistRunState,
  writeRunDocumentTransition,
} from '../lib/run-state-store.mjs';
import { parseCampaignPlan, runExecutableChecks } from '../lib/pump.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.resolve(process.argv[2] || path.join(repoRoot, 'replay/hello-run.journal.jsonl'));

await recordDemo(outputPath);
process.stdout.write(`${outputPath}\n`);

async function recordDemo(targetPath) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-replay-recording-'));
  try {
    const demoRepo = path.join(root, 'repo');
    const runDir = path.join(root, 'run');
    const campaignPath = path.join(demoRepo, 'hello-run.md');
    const statePath = path.join(runDir, 'state.json');
    const receiptsDir = path.join(runDir, 'receipts');
    const finalReviewPath = path.join(runDir, 'final-review.md');
    const sourceMarkdown = await readFile(path.join(repoRoot, 'examples/hello-run.md'), 'utf8');

    await mkdir(demoRepo, { recursive: true });
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(campaignPath, sourceMarkdown, 'utf8');
    await git(demoRepo, 'init', '-b', 'main');
    await git(demoRepo, 'config', 'user.name', 'Campaigns replay recorder');
    await git(demoRepo, 'config', 'user.email', 'replay@example.invalid');
    await git(demoRepo, 'add', 'hello-run.md');
    await git(demoRepo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Add hello run');

    const plan = parseCampaignPlan(sourceMarkdown);
    let state = createRunState({
      id: 'hello-run-replay-v1',
      identity: {
        registry_id: null,
        source: { campaign_path: campaignPath, repo_root: demoRepo },
        execution: { campaign_path: campaignPath, repo_root: demoRepo, branch: 'main' },
      },
      steps: plan.steps.map((step) => ({ id: step.id, name: step.name, phase: step.phase })),
      config: {
        runner: 'replay-recorder',
        reviewer: 'replay-reviewer',
        model: 'recorded-engine-fixture',
        effort: 'none',
        watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
      },
      artifacts: { run_dir: runDir, receipts_dir: receiptsDir, final_review_path: finalReviewPath },
    });
    state = transitionRunState(state, { event: 'run_started', message: 'Recorded hello run started.' });
    await persistRunState(statePath, state);

    for (const step of plan.steps) {
      const baseOid = await git(demoRepo, 'rev-parse', 'HEAD');
      state = transitionRunState(state, {
        event: 'step_started',
        step_id: step.id,
        message: `Recorded Step ${step.id} started.`,
        worker: {
          runner: 'replay-recorder',
          invocation_id: `record-${step.id}`,
          pid: process.pid,
          log_path: path.join(runDir, `step-${step.id}.log`),
        },
      });
      await persistRunState(statePath, state);

      if (step.id === '1.1') {
        await mkdir(path.join(demoRepo, 'hello-output'), { recursive: true });
        await writeFile(path.join(demoRepo, 'hello-output/greeting.txt'), 'Hello from Campaigns.\n');
        await git(demoRepo, 'add', 'hello-output/greeting.txt');
        await git(demoRepo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Add hello greeting');
      } else if (step.id === '1.2') {
        await writeFile(path.join(demoRepo, 'hello-output/verified.txt'), 'Greeting verified.\n');
        await git(demoRepo, 'add', 'hello-output/verified.txt');
        await git(demoRepo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Verify hello greeting');
      } else {
        throw new Error(`Unexpected hello-run step: ${step.id}`);
      }

      const checks = await runExecutableChecks(step.checks ?? [], { cwd: demoRepo });
      assert.ok(checks.length > 0 && checks.every((check) => check.passed));
      const receiptPath = path.join(receiptsDir, `${step.id}.md`);
      await writeFile(receiptPath, `# Step ${step.id}\n\nExecutable checks passed.\n`);
      await tickStep(statePath, campaignPath, step);
      await git(demoRepo, 'add', 'hello-run.md');
      await git(demoRepo, '-c', 'commit.gpgSign=false', 'commit', '-m', `Complete campaign step ${step.id}`);
      const headOid = await git(demoRepo, 'rev-parse', 'HEAD');
      state = transitionRunState(state, {
        event: 'step_completed',
        step_id: step.id,
        receipt_path: receiptPath,
        commit_range: { base_oid: baseOid, head_oid: headOid },
        runner: 'replay-recorder',
        model: 'recorded-engine-fixture',
        effort: 'none',
        message: `Recorded Step ${step.id} completed.`,
        details: { usage: emptyUsage() },
      });
      await persistRunState(statePath, state);
    }

    state = transitionRunState(state, {
      event: 'run_reached_final_review',
      message: 'All recorded steps are checked; final review is ready.',
    });
    await persistRunState(statePath, state);
    state = transitionRunState(state, {
      event: 'final_review_started',
      reviewer_runner: 'replay-reviewer',
      reviewer_family: 'recorded-fixture',
      reviewer_ladder_tier: 'explicit',
      message: 'Recorded final review started.',
    });
    await persistRunState(statePath, state);
    await writeFile(finalReviewPath, 'Verdict: APPROVED\nReasons:\n\nBoth hello-run checks passed.\n');
    state = transitionRunState(state, {
      event: 'final_review_approved',
      review_path: finalReviewPath,
      reasons: [],
      message: 'Recorded final review approved the campaign.',
      details: { usage: emptyUsage() },
    });
    await persistRunState(statePath, state);

    const journal = await readRunJournal(path.join(runDir, 'journal.jsonl'), { repairTornTail: false });
    const publicJournal = await sanitizeJournal(journal, root);
    const folded = foldRunJournal(publicJournal);
    assert.equal(folded.exact_replay, true);
    assert.equal(folded.state.run.status, 'completed');
    assert.equal(folded.documents.length, 3);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${publicJournal.map((event) => JSON.stringify(event)).join('\n')}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function tickStep(statePath, campaignPath, step) {
  const beforeMarkdown = await readFile(campaignPath, 'utf8');
  const lines = beforeMarkdown.replace(/\r\n?/g, '\n').split('\n');
  const match = lines[step.checklistLine].match(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/);
  assert.ok(match && match[2] === ' ');
  lines[step.checklistLine] = `${match[1]}x${match[3]}${match[4]}`;
  await writeRunDocumentTransition({
    statePath,
    campaignPath,
    beforeMarkdown,
    afterMarkdown: lines.join('\n'),
    kind: 'step_checked',
    stepId: step.id,
  });
}

async function sanitizeJournal(journal, temporaryRoot) {
  const roots = [...new Set([temporaryRoot, await realpath(temporaryRoot)])]
    .sort((left, right) => right.length - left.length);
  const sanitized = structuredClone(journal);
  for (const event of sanitized) {
    const replace = (value) => roots.reduce(
      (current, root) => current.split(root).join('/campaigns-demo'),
      value,
    );
    const replaced = JSON.parse(replace(JSON.stringify(event)));
    Object.keys(event).forEach((key) => delete event[key]);
    Object.assign(event, replaced);
    if (event.state) assertValidRunState(event.state);
  }
  let previous = null;
  for (const event of sanitized) {
    event.previous_hash = previous?.hash ?? null;
    delete event.hash;
    event.hash = hashRunJournalEvent(event);
    previous = event;
  }
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /\/Users\/|christiankatzmann|campaigns-replay-recording-/i);
  return sanitized;
}

function emptyUsage() {
  return { input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null };
}

async function git(cwd, ...args) {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

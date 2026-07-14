import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { runCampaign } from '../lib/pump.mjs';
import { classifyRunnerResult, createRunnerRegistry } from '../lib/runners.mjs';
import {
  RunStateTransitionError,
  createRunState,
  transitionRunState,
  validateRunState,
} from '../lib/run-state.mjs';

const execFileAsync = promisify(execFile);
const silent = { write() {} };

export const AUDIT_CLASS_COVERAGE = Object.freeze([
  coverage('watchdog timeout', 'test/pump.test.mjs', 'watchdog kills a silent runner and salvages its output tail in the receipt', 'step_failed / watchdog_stalled with salvage'),
  coverage('automation ended without completion signal', 'test/runners.test.mjs', 'exit zero without a marker records step_failed and never completes the step', 'step_failed / completion_signal_missing'),
  coverage('dirty or locked checkout', 'test/pump.test.mjs', 'dirty run-start preflight blocks without consuming an attempt and succeeds after cleanup', 'blocked / preflight_dirty_worktree'),
  coverage('worker exited nonzero', 'test/chaos.test.mjs', 'worker and harness exits become worker_exit failures with salvaged output', 'step_failed / worker_exit with salvage'),
  coverage('harness or tool failure mid-session', 'test/chaos.test.mjs', 'worker and harness exits become worker_exit failures with salvaged output', 'step_failed / worker_exit with salvage'),
  coverage('branch creation failed', 'test/pump.test.mjs', 'unavailable branch preflight records its taxonomy event without starting a step', 'blocked / preflight_branch_unavailable'),
  notApplicable('environment-specific gate', 'IP allowlists and private data-quality gates live outside the local engine contract.'),
  coverage('completed ledger stuck halted', 'test/chaos.test.mjs', 'successful terminal histories cannot become halted', 'transition rejected and corrupt ledger invalid'),
  coverage('malformed final review', 'test/pump.test.mjs', 'an unparseable review is re-asked exactly once before awaiting human review', 'awaiting_human_review / review_unparseable'),
  coverage('fix worker produced no commit', 'test/pump.test.mjs', 'a fix worker with no commit consumes the cap and never merges', 'awaiting_human_review / review_fix_attempts_exhausted'),
  coverage('needs work persisted past retry cap', 'test/pump.test.mjs', 'a repeated prose reason is preserved whole through fix-cap exhaustion', 'awaiting_human_review with intact raw reason'),
  coverage('unreviewed force merge', 'test/pump.test.mjs', 'force_merged_unreviewed occurs only with the explicit config escape hatch', 'force_merged only with explicit flag'),
  coverage('manual user stop', 'test/pump.test.mjs', 'user stop gives grace, kills the active process group, and records salvage', 'stopped_by_user with salvage'),
  coverage('dead worker recovery', 'test/recovery.test.mjs', 'a dead running worker is failed with salvaged output, reset, and resumes on next run', 'recovery resets and resumes the step'),
  coverage('step cap', 'test/pump.test.mjs', 'max_steps_per_run stops at the boundary with a visible cap event', 'cap_reached / max_steps_per_run'),
]);

test('audit taxonomy coverage names a real test or an explicit N/A for every class', async () => {
  const seenClasses = new Set();
  for (const row of AUDIT_CLASS_COVERAGE) {
    assert.equal(seenClasses.has(row.audit_class), false, row.audit_class);
    seenClasses.add(row.audit_class);
    if (row.na) {
      assert.match(row.reason, /outside the local engine contract/);
      continue;
    }
    const source = await readFile(path.resolve(row.test_file), 'utf8');
    assert.equal(source.includes(`test('${row.test_name}'`), true, `${row.test_file}: ${row.test_name}`);
    assert.ok(row.outcome);
  }
});

test('worker and harness exits become worker_exit failures with salvaged output', () => {
  const registry = createRunnerRegistry(fakeRunnerConfig());
  const classified = classifyRunnerResult(registry, 'fake', {
    exitCode: 1,
    stdout: 'last useful action before the harness died',
    stderr: 'tool transport closed unexpectedly',
    expected: { run_id: 'chaos-run', step_id: '1.1', invocation_id: 'worker-1' },
    receiptPath: '/tmp/unused-chaos-receipt.md',
  });

  assert.equal(classified.completed, false);
  assert.equal(classified.transition.event, 'step_failed');
  assert.equal(classified.transition.failure.code, 'worker_exit');
  assert.match(classified.transition.failure.output_tail, /last useful action/);
  assert.match(classified.transition.failure.output_tail, /tool transport closed/);
});

test('successful terminal histories cannot become halted', () => {
  let state = baseState();
  state = transitionRunState(state, { event: 'run_started' });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    worker: { runner: 'fake', invocation_id: 'worker-1', pid: 123, log_path: null },
  });
  state = transitionRunState(state, {
    event: 'step_completed',
    step_id: '1.1',
    receipt_path: '/tmp/chaos-run/receipts/1.1.md',
  });
  state = transitionRunState(state, { event: 'run_reached_final_review' });
  state = transitionRunState(state, { event: 'final_review_started' });
  state = transitionRunState(state, {
    event: 'final_review_approved',
    review_path: '/tmp/chaos-run/final-review.md',
  });

  assert.equal(state.run.status, 'completed');
  assert.throws(
    () => transitionRunState(state, { event: 'final_review_halted' }),
    RunStateTransitionError,
  );

  const corrupt = structuredClone(state);
  corrupt.run.status = 'halted';
  corrupt.run.ended_at = null;
  corrupt.history.at(-1).to_status = 'halted';
  const validation = validateRunState(corrupt);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('final_review_approved cannot end at halted')));
});

test('rendered board status DOM exposes attention for human review, caps, and stops', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const { renderAutomateStatusContent } = await import('../public/modules/automate-drawer.mjs');
    const expectedLabels = {
      awaiting_human_review: 'Awaiting review',
      cap_reached: 'Cap reached',
      stopped_by_user: 'Stopped by user',
    };

    for (const [status, label] of Object.entries(expectedLabels)) {
      const surface = new FakeElement('div');
      renderAutomateStatusContent(surface, {
        status,
        current_step: { id: '3.1', name: 'Chaos pass' },
      });
      const dump = surface.outerHTML;
      assert.match(dump, /automate-indicator--attention/);
      assert.match(dump, new RegExp(label));
      assert.match(dump, />!<\/span>/);
    }
  } finally {
    globalThis.document = originalDocument;
  }
});

test('hello E2E runs the step and final review to terminal completed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-chaos-hello-'));
  const repo = path.join(root, 'repo');
  const runsDir = path.join(root, 'runs');
  const campaignPath = path.join(repo, 'campaigns', 'hello.md');
  const configPath = path.join(root, 'campaigns.config.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.dirname(campaignPath), { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Campaigns Test']);
  await git(repo, ['config', 'user.email', 'campaigns@example.test']);
  await writeFile(campaignPath, helloCampaign(), 'utf8');
  await writeFile(configPath, `${JSON.stringify(fakeRunnerConfig(), null, 2)}\n`, 'utf8');
  await git(repo, ['add', 'campaigns/hello.md']);
  await git(repo, ['commit', '-m', 'Add hello campaign']);

  const result = await runCampaign(campaignPath, {
    configPath,
    runsDir,
    stdout: silent,
    stderr: silent,
    env: { ...process.env, CAMPAIGNS_CONFIG_DIR: path.join(root, 'user-config') },
  });
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));

  assert.equal(state.run.status, 'completed');
  assert.equal(state.review.status, 'approved');
  assert.equal(state.review.attempts, 1);
  assert.deepEqual(validateRunState(state), { valid: true, errors: [] });
  assert.ok(state.history.some((entry) => entry.event === 'step_completed'));
  assert.ok(state.history.some((entry) => entry.event === 'final_review_approved'));
  assert.equal(state.history.some((entry) => entry.event === 'campaign_merged'), false);
  assert.match(await readFile(campaignPath, 'utf8'), /- \[x\] Step 1\.1/);
});

function coverage(auditClass, testFile, testName, outcome) {
  return Object.freeze({ audit_class: auditClass, test_file: testFile, test_name: testName, outcome });
}

function notApplicable(auditClass, reason) {
  return Object.freeze({ audit_class: auditClass, na: true, reason });
}

function baseState() {
  return createRunState({
    id: 'chaos-run',
    identity: {
      registry_id: null,
      source: { campaign_path: '/repo/campaigns/chaos.md', repo_root: '/repo' },
      execution: { campaign_path: '/repo/campaigns/chaos.md', repo_root: '/repo', branch: 'main' },
    },
    steps: [{ id: '1.1', name: 'Chaos', phase: '1' }],
    config: {
      runner: 'fake',
      model: 'fake-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    },
    artifacts: {
      run_dir: '/tmp/chaos-run',
      receipts_dir: '/tmp/chaos-run/receipts',
      final_review_path: '/tmp/chaos-run/final-review.md',
    },
  });
}

function fakeRunnerConfig() {
  return {
    schemaVersion: 1,
    defaultRunner: 'fake',
    watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    run: {
      repoRoot: null,
      branch: null,
      max_steps_per_run: 50,
      max_run_minutes: 10,
      stop_grace_ms: 50,
    },
    review: { maxFixAttempts: 2, forceMergeUnreviewed: false },
    runners: {
      fake: {
        binary: process.execPath,
        args: [
          '-e',
          `const prompt = process.argv[1];
          process.stdout.write(
            prompt.includes('campaigns.step_completed')
              ? prompt
              : 'Verdict: APPROVED\\nReasons:\\n\\nThe hello run is sound.'
          );`,
          '{prompt}',
        ],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fake-model', effort: 'none' },
        effortMap: { none: 'none' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'text' }],
        },
      },
    },
  };
}

function helloCampaign() {
  return `# Hello run

## Progress checklist

### Phase 1 — Hello

- [ ] Step 1.1 — Say hello
- [ ] Final review

## Step 1.1 — Say hello

\`\`\`text
Complete the hello run.
\`\`\`

## Final review

\`\`\`text
Review the completed hello run.
\`\`\`
`;
}

function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
}

function fakeDocument() {
  return {
    createElement(tagName) { return new FakeElement(tagName); },
    querySelector() { return null; },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.title = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get outerHTML() {
    const attributes = { ...this.attributes };
    if (this.className) attributes.class = this.className;
    if (this.title) attributes.title = this.title;
    const attrs = Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
    const body = escapeHtml(this.textContent)
      + this.children.map((child) => child?.outerHTML ?? escapeHtml(String(child))).join('');
    return `<${this.tagName}${attrs}>${body}</${this.tagName}>`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

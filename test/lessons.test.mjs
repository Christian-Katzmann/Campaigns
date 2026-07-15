import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  aggregateUnifiedLessons,
  readUnifiedRunLedgers,
} from '../lib/lessons.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';

test('unified ledgers aggregate exact review, stop, failure, reason, and sizing metrics', () => {
  const ledgers = [
    fixtureLedger({ id: 'approved-first', runner: 'codex', stepCount: 2, outcome: 'approved' }),
    fixtureLedger({ id: 'approved-reworked', runner: 'claude', stepCount: 4, outcome: 'reworked' }),
    fixtureLedger({ id: 'stopped', runner: 'codex', stepCount: 3, outcome: 'stopped' }),
    fixtureLedger({ id: 'capped', runner: 'codex', stepCount: 5, outcome: 'capped' }),
  ];

  const lessons = aggregateUnifiedLessons(ledgers, { generatedAt: '2026-07-14T18:00:00.000Z' });

  assert.deepEqual(lessons.scanned, { total: 4, claude: 1, codex: 3 });
  assert.deepEqual(lessons.overall, {
    total: 4,
    withVerdict: 2,
    approved: 2,
    firstTry: 1,
    reworked: 1,
    manualStops: 1,
    capReached: 1,
    approvalRate: 1,
    firstTryRate: 0.5,
    reworkRate: 0.25,
    manualStopRate: 0.25,
  });
  assert.deepEqual(lessons.sizing, {
    medianSteps: 2,
    p90Steps: 2,
    maxFirstTrySteps: 2,
    avoidAboveSteps: 2,
    sample: 1,
  });
  assert.deepEqual(lessons.failureTaxonomy, {
    total: 2,
    counts: [
      { code: 'cap_reached', count: 1 },
      { code: 'stopped_by_user', count: 1 },
    ],
  });
  assert.deepEqual(lessons.reasons, {
    topTags: [
      { tag: 'documentation-gap', count: 1 },
      { tag: 'verification-gap', count: 1 },
    ],
    rawTopTags: [
      { tag: 'invented-tag', count: 1 },
      { tag: 'read the cumulative review', count: 1 },
    ],
  });
  assert.equal(lessons.dataQuality.invalidCanonicalTags, 1);
});

test('native lessons discover current and archived unified ledgers but ignore legacy state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-lessons-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'fixture');
  await mkdir(runDir, { recursive: true });
  const current = fixtureLedger({ id: 'current', outcome: 'approved' });
  const archived = fixtureLedger({ id: 'archived', outcome: 'capped' });
  archived.schema_version = 2;
  for (const step of archived.steps) {
    delete step.runner;
    delete step.model;
    delete step.effort;
  }
  await writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(current)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'state-archived.json'), `${JSON.stringify(archived)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'state-legacy.json'), '{"phase":"complete"}\n', 'utf8');
  await writeFile(path.join(runDir, 'state-malformed.json'), '{"schema_version":1}\n', 'utf8');

  const ledgers = await readUnifiedRunLedgers(root);

  assert.deepEqual(ledgers.map((state) => state.run.id), ['current', 'archived']);
});

test('server exposes and serves native lessons with a scratch HOME and no Python helper', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-lessons-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const registryDir = path.join(root, 'registry');
  const runsDir = path.join(root, 'runs');
  const runDir = path.join(runsDir, 'fixture');
  await mkdir(home, { recursive: true });
  await mkdir(registryDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(registryDir, 'registry.json'), '{"campaigns":[]}\n', 'utf8');
  await writeFile(
    path.join(runDir, 'state.json'),
    `${JSON.stringify(fixtureLedger({ id: 'server-fixture', outcome: 'approved' }))}\n`,
    'utf8',
  );

  const child = spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: runsDir,
      CAMPAIGNS_LESSONS_HELPER: path.join(home, 'missing-helper.py'),
      CAMPAIGNS_PORT_FILE: path.join(root, 'server.port'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));
  const port = await waitForServerPort(child);

  const [capabilitiesResponse, lessonsResponse, appResponse, moduleResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/capabilities`),
    fetch(`http://127.0.0.1:${port}/api/lessons`),
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/modules/library.mjs`),
  ]);
  const capabilities = await capabilitiesResponse.json();
  const lessons = await lessonsResponse.json();
  const app = await appResponse.text();
  const libraryModule = await moduleResponse.text();

  assert.equal(capabilities.personalLayer.lessons, true);
  assert.equal(lessons.available, true);
  assert.equal(lessons.source, 'unified');
  assert.equal(lessons.scanned.total, 1);
  assert.match(app, /id="library-lessons"/);
  assert.match(libraryModule, /Babysitting index/);
});

function fixtureLedger({ id, runner = 'codex', stepCount = 1, outcome }) {
  const root = path.join(tmpdir(), `campaigns-lessons-${id}`);
  const steps = Array.from({ length: stepCount }, (_, index) => ({
    id: `1.${index + 1}`,
    name: `Step ${index + 1}`,
    phase: '1',
  }));
  let state = createRunState({
    id,
    identity: {
      registry_id: id,
      source: {
        campaign_path: path.join(root, 'campaign.md'),
        repo_root: root,
      },
      execution: {
        campaign_path: path.join(root, 'campaign.md'),
        repo_root: root,
        branch: 'campaign/fixture',
      },
    },
    steps,
    config: {
      runner,
      model: 'fixture-model',
      effort: 'none',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 1_000 },
    },
    artifacts: {
      run_dir: root,
      receipts_dir: path.join(root, 'receipts'),
      final_review_path: path.join(root, 'final-review.md'),
    },
    created_at: `2026-07-14T18:00:0${id.length % 10}.000Z`,
  });
  state = transitionRunState(state, { event: 'run_started' });

  if (outcome === 'stopped') {
    state = transitionRunState(state, {
      event: 'step_started',
      step_id: steps[0].id,
      worker: fixtureWorker(root, steps[0].id),
    });
    return transitionRunState(state, { event: 'stopped_by_user' });
  }
  if (outcome === 'capped') return transitionRunState(state, { event: 'cap_reached' });

  for (const step of steps) {
    state = transitionRunState(state, {
      event: 'step_started',
      step_id: step.id,
      worker: fixtureWorker(root, step.id),
    });
    state = transitionRunState(state, {
      event: 'step_completed',
      step_id: step.id,
      receipt_path: path.join(root, 'receipts', `${step.id}.md`),
    });
  }
  state = transitionRunState(state, { event: 'run_reached_final_review' });
  state = transitionRunState(state, { event: 'final_review_started' });

  if (outcome === 'reworked') {
    state = transitionRunState(state, {
      event: 'final_review_needs_work',
      verdict: 'NEEDS WORK',
      reasons: ['documentation-gap', 'invented-signal'],
      raw_tags: ['read the cumulative review'],
      review_path: path.join(root, 'final-review.md'),
    });
    state = transitionRunState(state, {
      event: 'final_rework_completed',
      attempt: 1,
      commit_sha: 'abc123',
    });
    state = transitionRunState(state, { event: 'final_review_started' });
  }

  return transitionRunState(state, {
    event: 'final_review_approved',
    verdict: 'APPROVED',
    reasons: outcome === 'approved' ? ['verification-gap'] : [],
    raw_tags: outcome === 'approved' ? ['invented-tag'] : [],
    review_path: path.join(root, 'final-review.md'),
  });
}

function fixtureWorker(root, stepId) {
  return {
    runner: 'fixture',
    invocation_id: `worker-${stepId}`,
    pid: null,
    log_path: path.join(root, `${stepId}.log`),
  };
}

async function waitForServerPort(child) {
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. ${errors}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Campaigns: http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}. ${errors}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'close'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

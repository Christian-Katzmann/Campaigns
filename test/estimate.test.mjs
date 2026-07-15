import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildBackendDurationSamples,
  estimateCampaign,
  summarizeDurations,
} from '../lib/estimate.mjs';

test('synthetic duration distributions return hand-computable P50 and P90', () => {
  assert.deepEqual(summarizeDurations([20, 5, 10]), {
    sampleSize: 3,
    p50Minutes: 10,
    p90Minutes: 20,
  });
});

test('personal calibration creates backend-only cells from real-shaped ledgers', () => {
  const ledgers = [ledger({
    runner: 'codex',
    repoRoot: '/tmp/first-repo',
    steps: [
      timedStep('1.1', 4, { model: 'a', effort: 'low', name: 'Docs', kind: 'docs' }),
      timedStep('1.2', 7, { model: 'b', effort: 'xhigh', name: 'Code', kind: 'build' }),
      timedStep('1.3', 9, { runner: 'claude', model: 'c', effort: 'high' }),
    ],
  })];

  const samples = buildBackendDurationSamples(ledgers);

  assert.deepEqual(Object.keys(samples).sort(), ['claude', 'codex']);
  assert.deepEqual(samples.codex, [4, 7]);
  assert.deepEqual(samples.claude, [9]);
});

test('roll-up includes the Codex gap and uses deterministic Monte Carlo for campaign P90', () => {
  const historical = ledger({
    runner: 'codex',
    steps: [4, 5, 6, 7, 8].map((minutes, index) => timedStep(`1.${index + 1}`, minutes)),
  });
  const input = {
    steps: [
      { id: '2.1', runner: 'codex' },
      { id: '2.2', runner: 'codex' },
    ],
    ledgers: [historical],
    seed: 'gap-proof',
  };

  const first = estimateCampaign(input);
  const second = estimateCampaign(input);

  assert.deepEqual(first.duration, second.duration);
  assert.equal(first.duration.p50Minutes, 24); // 6 + 12m gap + 6
  assert.equal(first.duration.gapBudgetMinutes, 12);
  assert.ok(first.duration.p90Minutes < 28); // 8 + 12 + 8 would be summed step P90s
  assert.ok(first.duration.p90Minutes >= first.duration.p50Minutes);
});

test('sessions range is worker + review + checkable first-try rework history', () => {
  const estimate = estimateCampaign({
    steps: [
      { id: '1.1', runner: 'claude' },
      { id: '1.2', runner: 'claude' },
      { id: '1.3', runner: 'claude' },
    ],
    ledgers: [
      ledger({ history: ['final_review_approved'] }),
      ledger({ history: ['final_review_needs_work', 'final_rework_completed', 'final_review_approved'] }),
    ],
  });

  assert.deepEqual(estimate.reworkRisk, {
    rate: 0.5,
    label: 'medium',
    sampleSize: 2,
    firstTryRate: 0.5,
  });
  assert.deepEqual(estimate.sessions, {
    low: 4,
    high: 5,
    worker: 3,
    review: 1,
    likelyRework: 1,
  });
});

test('cold start returns a wide labeled low-confidence fleet estimate', () => {
  const estimate = estimateCampaign({
    steps: [{ id: '1.1', runner: 'claude' }],
    ledgers: [],
  });

  assert.equal(estimate.source, 'fleet');
  assert.equal(estimate.confidence, 'low');
  assert.equal(estimate.personalSampleSize, 0);
  assert.equal(estimate.duration.p50Minutes, 13);
  assert.ok(estimate.duration.p90Minutes > estimate.duration.p50Minutes);
  assert.equal(estimate.reworkRisk.label, 'unknown');
});

test('live completed steps at 2x prior raise the remaining estimate', () => {
  const historical = ledger({
    runner: 'codex',
    steps: Array.from({ length: 5 }, (_, index) => timedStep(`h.${index}`, 10)),
  });
  const steps = [
    { id: '1.1', runner: 'codex' },
    { id: '1.2', runner: 'codex' },
    { id: '1.3', runner: 'codex' },
  ];
  const base = estimateCampaign({
    steps: [{ ...steps[0], checked: true }, ...steps.slice(1)],
    ledgers: [historical],
    seed: 'pace',
  });
  const liveLedger = ledger({
    runner: 'codex',
    status: 'running',
    steps: [
      timedStep('1.1', 20, { status: 'completed' }),
      pendingStep('1.2'),
      pendingStep('1.3'),
    ],
  });
  const live = estimateCampaign({ steps, ledgers: [historical], liveLedger, seed: 'pace' });

  assert.equal(live.live.paceRatio, 2);
  assert.equal(live.live.completedSteps, 1);
  assert.equal(base.duration.p50Minutes, 32); // 2 workers + 1 Codex gap
  assert.equal(live.duration.p50Minutes, 52); // 2 workers at 2x + 1 Codex gap
});

test('GET /api/estimate resolves a registered campaign and returns fleet cold-start data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-estimate-http-'));
  let child = null;
  t.after(async () => {
    if (child) await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  const registryDir = path.join(root, 'registry');
  const campaignPath = path.join(repo, 'campaigns', 'estimate.md');
  await mkdir(path.dirname(campaignPath), { recursive: true });
  await mkdir(registryDir, { recursive: true });
  await run('git', ['init', '-q', repo]);
  await writeFile(campaignPath, campaignFixture(), 'utf8');
  await writeFile(
    path.join(registryDir, 'registry.json'),
    `${JSON.stringify({ campaigns: [{ id: 'estimate-fixture', filePath: campaignPath }] })}\n`,
    'utf8',
  );

  child = spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_CONFIG_DIR: path.join(root, 'config'),
      CAMPAIGNS_PORT_FILE: path.join(root, 'server.port'),
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: path.join(root, 'runs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await waitForServerPort(child);

  const response = await fetch(`http://127.0.0.1:${port}/api/estimate?id=estimate-fixture`);
  const estimate = await response.json();

  assert.equal(response.status, 200);
  assert.equal(estimate.remainingSteps, 2);
  assert.equal(estimate.source, 'fleet');
  assert.equal(estimate.confidence, 'low');
  assert.equal(estimate.duration.gapBudgetMinutes, 12);
  assert.equal(estimate.sessions.worker, 2);
});

function ledger({
  runner = 'codex',
  repoRoot = '/tmp/estimate-fixture',
  status = 'completed',
  steps = [],
  history = [],
} = {}) {
  return {
    run: {
      id: `run-${Math.random()}`,
      status,
      current_step_id: null,
      identity: {
        source: { repo_root: repoRoot },
        execution: { repo_root: repoRoot },
      },
    },
    config: { runner },
    steps,
    history: history.map((event) => ({ event })),
  };
}

function timedStep(id, minutes, overrides = {}) {
  const started = Date.parse('2026-07-14T10:00:00.000Z');
  return {
    id,
    name: `Step ${id}`,
    status: 'completed',
    started_at: new Date(started).toISOString(),
    completed_at: new Date(started + minutes * 60_000).toISOString(),
    runner: null,
    ...overrides,
  };
}

function pendingStep(id) {
  return {
    id,
    name: `Step ${id}`,
    status: 'pending',
    started_at: null,
    completed_at: null,
    runner: null,
  };
}

function campaignFixture() {
  return `# Estimate fixture

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — First
- [ ] Step 1.2 — Second
- [ ] Final review

## Step 1.1 — First

Model: GPT-5.6-Sol · Extra High / Fable 5 · High
Parallel: NO

\`\`\`text
Complete the first step.
\`\`\`

## Step 1.2 — Second

Model: GPT-5.6-Sol · Extra High / Fable 5 · High
Parallel: NO

\`\`\`text
Complete the second step.
\`\`\`

## Final review

\`\`\`text
Review the campaign.
\`\`\`
`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
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
  const closed = new Promise((resolve) => child.once('close', () => resolve(true)));
  child.kill('SIGTERM');
  if (await Promise.race([closed, closeTimeout()])) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    if (!await Promise.race([closed, closeTimeout()])) {
      throw new Error(`Server child ${child.pid ?? 'unknown'} did not close after SIGKILL.`);
    }
  }
}

function closeTimeout() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    timer.unref?.();
  });
}

#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPreflight } from '../action/preflight.mjs';
import { publishPrReport } from '../action/report-pr.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SENTINEL = 'campaigns-ci-sentinel-secret-7f83c1';
const HEAD_SHA = 'a'.repeat(40);
const FIXTURE_COST_USD = 0.01;

export async function runActionE2E({ outputDir, stdout = process.stdout } = {}) {
  const evidenceDir = path.resolve(required(outputDir, 'outputDir'));
  await ensureEmptyDirectory(evidenceDir);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'campaigns-action-e2e-'));
  const transcript = [];
  let summary;

  try {
    const workspace = path.join(fixtureRoot, 'repo');
    const runnerTemp = path.join(fixtureRoot, 'runner-temp');
    const userConfigDir = path.join(fixtureRoot, 'user-config');
    const campaignPath = path.join(workspace, 'campaigns', 'ci-fixture.md');
    const runnerPath = path.join(workspace, 'fake-cost-runner.mjs');
    const eventPath = path.join(fixtureRoot, 'event.json');
    const githubOutputPath = path.join(fixtureRoot, 'github-output.txt');
    const fixtureHome = path.join(fixtureRoot, 'home');
    await mkdir(path.dirname(campaignPath), { recursive: true });
    await mkdir(runnerTemp, { recursive: true });
    await mkdir(fixtureHome, { recursive: true });

    await writeFile(campaignPath, fixtureCampaign(), 'utf8');
    await writeFile(runnerPath, fakeRunnerSource(), 'utf8');
    await writeFile(path.join(workspace, '.campaigns.json'), `${JSON.stringify(
      fixtureConfig(runnerPath),
      null,
      2,
    )}\n`, 'utf8');
    await writeFile(eventPath, `${JSON.stringify(prEvent(), null, 2)}\n`, 'utf8');
    await initGitFixture(workspace);

    const actionMetadata = await readFile(path.join(ROOT, 'action', 'action.yml'), 'utf8');
    for (const requiredStep of [
      'Mask secrets and enforce PR trust',
      'Run campaign',
      'Upload redacted run evidence',
      'Publish PR receipt and check run',
    ]) {
      ensure(actionMetadata.includes(requiredStep), `action metadata is missing: ${requiredStep}`);
    }

    let preflightLog = '';
    const actionEnv = {
      PATH: required(process.env.PATH, 'PATH'),
      HOME: fixtureHome,
      LANG: 'C',
      LC_ALL: 'C',
      CI: 'true',
      ANTHROPIC_API_KEY: SENTINEL,
      CAMPAIGNS_CONFIG_DIR: userConfigDir,
      CAMPAIGNS_REGISTRY_DIR: path.join(fixtureRoot, 'registry'),
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'fixture/campaigns',
      GITHUB_RUN_ID: '20260715',
      GITHUB_RUN_ATTEMPT: '1',
      INPUT_CAMPAIGN: 'campaigns/ci-fixture.md',
      INPUT_RUNNER: 'claude',
      INPUT_MODEL: 'fixture-model',
      INPUT_EFFORT: 'none',
      INPUT_RUNNER_CLI_VERSION: '2.1.210',
      INPUT_MAX_STEPS: '2',
      INPUT_MAX_MINUTES: '1',
      INPUT_MAX_COST_USD: '0.05',
    };
    const preflight = await runPreflight({
      env: actionEnv,
      stdout: { write: (chunk) => { preflightLog += chunk; } },
    });
    ensure(Number(process.versions.node.split('.')[0]) >= 20, 'Node 20+ is required');

    const cliArgs = [
      path.join(ROOT, 'bin', 'campaigns.mjs'),
      'run',
      preflight.campaignPath,
      '--runner', 'claude',
      '--model', 'fixture-model',
      '--effort', 'none',
      '--no-worktree',
      '--state-dir', preflight.runsRoot,
      '--max-steps-per-run', '2',
      '--max-run-minutes', '1',
      '--max-cost-usd', '0.05',
    ];
    const engine = await runProcess(process.execPath, cliArgs, {
      cwd: workspace,
      env: actionEnv,
      timeout: 120_000,
    });

    const statePath = path.join(preflight.stateDir, 'state.json');
    const eventsPath = path.join(preflight.stateDir, 'events.jsonl');
    const receiptsDir = path.join(preflight.stateDir, 'receipts');
    const finalReviewPath = path.join(preflight.stateDir, 'final-review.md');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    ensure(state.run.status === 'completed', `unexpected run status: ${state.run.status}`);
    ensure(state.review?.verdict === 'APPROVED', 'fixture final review was not approved');
    ensure(state.steps?.length === 2, 'fixture did not produce two step records');
    ensure(state.steps.every((step) => step.status === 'completed'), 'fixture step did not complete');
    ensure(state.config.max_steps_per_run === 2, 'step cap was not persisted');
    ensure(state.config.max_run_minutes === 1, 'time cap was not persisted');
    ensure(state.config.max_cost_usd === 0.05, 'cost cap was not persisted');

    const github = fakeGitHub();
    const report = await publishPrReport({
      env: {
        ...actionEnv,
        GITHUB_API_URL: 'https://api.github.test',
        GITHUB_TOKEN: 'fixture-github-token',
        STATE_DIR: preflight.stateDir,
        ARTIFACT_URL: 'https://github.com/fixture/campaigns/actions/runs/20260715/artifacts/1',
      },
      fetchImpl: github.fetch,
    });
    ensure(report.comment === 'created' && github.comments.length === 1, 'sticky comment was not created once');
    ensure(report.check === 'created' && github.checks.length === 1, 'check run was not created once');
    ensure(github.checks[0].head_sha === HEAD_SHA, 'check run did not target the PR head');
    ensure(github.checks[0].conclusion === 'success', 'completed fixture check did not conclude success');

    const artifactDir = path.join(evidenceDir, 'artifacts');
    await mkdir(artifactDir, { recursive: true });
    await cp(statePath, path.join(artifactDir, 'state.json'));
    await cp(eventsPath, path.join(artifactDir, 'events.jsonl'));
    await cp(receiptsDir, path.join(artifactDir, 'receipts'), { recursive: true });
    await cp(finalReviewPath, path.join(artifactDir, 'final-review.md'));
    await writeFile(
      path.join(evidenceDir, 'fixture-campaign.md'),
      await readFile(campaignPath, 'utf8'),
      'utf8',
    );

    const usageEntries = state.history
      .filter((entry) => Number.isFinite(entry.details?.usage?.cost_usd))
      .map((entry) => ({
        event: entry.event,
        step_id: entry.step_id ?? null,
        cost_usd: entry.details.usage.cost_usd,
      }));
    const reportedCostUsd = Number(usageEntries
      .reduce((total, entry) => total + entry.cost_usd, 0)
      .toFixed(6));
    ensure(reportedCostUsd > 0 && reportedCostUsd < state.config.max_cost_usd, 'fixture cost was not normalized inside the cap');

    await writeJson(path.join(evidenceDir, 'sticky-comment.json'), github.comments[0]);
    await writeJson(path.join(evidenceDir, 'check-run.json'), github.checks[0]);
    await writeJson(path.join(evidenceDir, 'reported-fixture-cost.json'), {
      source: 'deterministic fake JSONL runner',
      reported_fixture_cost_usd: reportedCostUsd,
      actual_provider_spend_usd: 0,
      provider_calls: 0,
      usage_entries: usageEntries,
      note: 'Fixture cost validates normalized cap accounting; it is not provider spend.',
    });

    const artifactFiles = await listFiles(artifactDir);
    const artifactManifest = {
      upload_roots: ['state.json', 'events.jsonl', 'receipts/', 'final-review.md'],
      files: await Promise.all(artifactFiles.map(async (filePath) => ({
        path: path.relative(artifactDir, filePath),
        bytes: (await stat(filePath)).size,
        sha256: sha256(await readFile(filePath)),
      }))),
    };
    await writeJson(path.join(evidenceDir, 'artifact-manifest.json'), artifactManifest);

    const artifactText = (await Promise.all(artifactFiles.map((filePath) => readFile(filePath, 'utf8')))).join('\n');
    ensure(!artifactText.includes(SENTINEL), 'sentinel leaked into uploaded artifacts');
    ensure(artifactText.includes('[REDACTED]'), 'uploaded artifacts did not retain redaction proof');

    transcript.push(
      '# Campaigns Action no-provider E2E',
      '',
      `Node: ${process.version}`,
      'Event: pull_request, same repository',
      'Runner install: replaced by deterministic local fake runner; no package or provider network call',
      'Caps: max_steps=2, max_minutes=1, max_cost_usd=0.05',
      `Engine command: node bin/campaigns.mjs run campaigns/ci-fixture.md --runner claude --model fixture-model --effort none --no-worktree --state-dir <runner-temp> --max-steps-per-run 2 --max-run-minutes 1 --max-cost-usd 0.05`,
      '',
      '## Preflight',
      sanitize(preflightLog),
      '## Engine',
      sanitize(`${engine.stdout}${engine.stderr ? `\n${engine.stderr}` : ''}`),
      '## Upload and PR report',
      `Uploaded files: ${artifactManifest.files.length}`,
      `Sticky comments: ${github.comments.length}`,
      `Check runs: ${github.checks.length}`,
      `Check head: ${github.checks[0].head_sha}`,
      `Check conclusion: ${github.checks[0].conclusion}`,
      `Normalized fixture cost: $${reportedCostUsd.toFixed(2)}`,
      'Provider calls: 0',
      'Actual provider spend: $0.00',
      '',
    );

    summary = {
      evidenceDir,
      stateStatus: state.run.status,
      verdict: state.review.verdict,
      commentCount: github.comments.length,
      checkCount: github.checks.length,
      checkHeadSha: github.checks[0].head_sha,
      checkConclusion: github.checks[0].conclusion,
      reportedCostUsd,
      artifactFileCount: artifactManifest.files.length,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  transcript.push('Temporary fixture cleanup: verified; no scratch repository retained.');
  await writeFile(path.join(evidenceDir, 'workflow-harness.log'), `${transcript.join('\n')}\n`, 'utf8');
  const beforeScan = await listFiles(evidenceDir);
  const matches = [];
  for (const filePath of beforeScan) {
    if ((await readFile(filePath)).includes(Buffer.from(SENTINEL))) {
      matches.push(path.relative(evidenceDir, filePath));
    }
  }
  ensure(matches.length === 0, `sentinel leaked into evidence: ${matches.join(', ')}`);
  await writeJson(path.join(evidenceDir, 'sentinel-secret-scan.json'), {
    sentinel_sha256: sha256(Buffer.from(SENTINEL)),
    scanned_files: beforeScan.length,
    matches,
    result: 'PASS',
  });

  stdout?.write(`Campaigns Action E2E passed. Evidence: ${evidenceDir}\n`);
  return summary;
}

function fixtureCampaign() {
  return `# CI action fixture

## Progress checklist

### Phase 1 — Fixture work

- [ ] Step 1.1 — First fixture step
- [ ] Step 1.2 — Second fixture step
- [ ] Final review

## Step 1.1 — First fixture step

\`\`\`text
Complete the first deterministic fixture step.
\`\`\`

## Step 1.2 — Second fixture step

\`\`\`text
Complete the second deterministic fixture step.
\`\`\`

## Final review

\`\`\`text
Verify both fixture steps completed and the three configured caps remain in force.
\`\`\`
`;
}

function fakeRunnerSource() {
  return `const prompt = process.argv[2] ?? '';
const secret = process.env.ANTHROPIC_API_KEY ?? '';
const result = prompt.startsWith('Campaign source:')
  ? 'Verdict: APPROVED\\nReasons:\\n\\nDeterministic fixture review passed. AUTH_SECRET=' + secret
  : 'AUTH_SECRET=' + secret + '\\n' + prompt;
process.stdout.write(JSON.stringify({
  type: 'result',
  result,
  total_cost_usd: ${FIXTURE_COST_USD},
  usage: { input_tokens: 10, output_tokens: 5 }
}) + '\\n');
`;
}

function fixtureConfig(runnerPath) {
  return {
    schemaVersion: 1,
    defaultRunner: 'claude',
    watchdog: { minimum_runtime_ms: 10_000, stall_window_ms: 30_000 },
    review: { reviewer: 'claude', maxFixAttempts: 1, forceMergeUnreviewed: false },
    runners: {
      claude: {
        family: 'fixture',
        label: 'Deterministic fixture runner',
        binary: process.execPath,
        args: [runnerPath, '{prompt}'],
        prompt: { delivery: 'arg' },
        defaults: { model: 'fixture-model', effort: 'none' },
        effortMap: { none: 'none' },
        environment: { remove: [] },
        completion: {
          marker: { type: 'campaigns.step_completed', version: 1, status: 'completed' },
          sources: [{ kind: 'jsonl', match: { type: 'result' }, field: 'result' }],
        },
        usage: {
          sources: [{
            kind: 'jsonl',
            match: { type: 'result' },
            fields: {
              input_tokens: 'usage.input_tokens',
              output_tokens: 'usage.output_tokens',
              cost_usd: 'total_cost_usd',
            },
          }],
        },
      },
    },
  };
}

function prEvent() {
  return {
    number: 42,
    repository: { full_name: 'fixture/campaigns' },
    pull_request: {
      number: 42,
      head: {
        sha: HEAD_SHA,
        repo: { full_name: 'fixture/campaigns', fork: false },
      },
    },
  };
}

async function initGitFixture(workspace) {
  await runProcess('git', ['init', '-b', 'main'], { cwd: workspace });
  await runProcess('git', ['config', 'user.name', 'Campaigns CI Fixture'], { cwd: workspace });
  await runProcess('git', ['config', 'user.email', 'campaigns@example.test'], { cwd: workspace });
  await runProcess('git', ['add', '.'], { cwd: workspace });
  await runProcess('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Add CI fixture'], { cwd: workspace });
}

function fakeGitHub() {
  const comments = [];
  const checks = [];
  return {
    comments,
    checks,
    fetch: async (url, options) => {
      const method = options.method;
      const pathname = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      if (method === 'GET' && pathname.endsWith('/issues/42/comments')) return response(comments);
      if (method === 'POST' && pathname.endsWith('/issues/42/comments')) {
        const comment = { id: 10, ...body };
        comments.push(comment);
        return response(comment, 201);
      }
      if (method === 'GET' && pathname.includes('/commits/') && pathname.endsWith('/check-runs')) {
        return response({ check_runs: checks });
      }
      if (method === 'POST' && pathname.endsWith('/check-runs')) {
        const check = { id: 20, ...body };
        checks.push(check);
        return response(check, 201);
      }
      return response({ message: 'not found' }, 404);
    },
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) throw new Error(`outputDir must be empty: ${directory}`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else files.push(entryPath);
  }
  return files.sort();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stdout}${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sanitize(value) {
  return String(value)
    .replace(/^::add-mask::.*$/gm, '::add-mask::[MASKED]')
    .replaceAll(SENTINEL, '***')
    .trimEnd();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCliArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex < 0 || !argv[outputIndex + 1]) {
    throw new Error('Usage: npm run action:e2e -- --output <empty-directory>');
  }
  return { outputDir: argv[outputIndex + 1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runActionE2E(parseCliArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`campaigns-action-e2e: ${error.message}\n`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildFleetViewModel, fleetKroAsset } from '../public/lib/fleet.mjs';
import { runPathsForCampaign } from '../lib/pump.mjs';
import { createRunState, transitionRunState } from '../lib/run-state.mjs';

test('fleet view model groups three live states and presents badges, ETAs, Kro, and calm mode', () => {
  const view = buildFleetViewModel({
    generatedAt: '2026-07-15T06:00:00.000Z',
    worstStatus: 'needs-attention',
    babysitting: { manualStopRate: 1 / 3, manualStops: 1, sampleSize: 3 },
    campaigns: [
      fleetCampaign({ id: 'running', repo: ['repo-a', 'Northwind'], status: 'running', eta: [12, 28] }),
      fleetCampaign({
        id: 'attention',
        repo: ['repo-a', 'Northwind'],
        status: 'stalled',
        attention: 'Run cap',
        nudge: [{ mode: 'continue', label: 'Continue this step' }],
      }),
      fleetCampaign({ id: 'idle', repo: ['repo-b', 'Harbor'], status: 'idle', eta: [0, 0], remainingSteps: 0 }),
    ],
  });

  assert.equal(view.running, 1);
  assert.equal(view.needsYou, 1);
  assert.equal(view.calm, false);
  assert.equal(view.babysittingLabel, '33% · 1 manual stop');
  assert.equal(view.kroState, 'needs-attention');
  assert.equal(fleetKroAsset(view.kroState), '/assets/kro/attention.svg');
  assert.deepEqual(view.groups.map((group) => [group.id, group.label, group.campaigns.length]), [
    ['repo-b', 'Harbor', 1],
    ['repo-a', 'Northwind', 2],
  ]);
  const northwind = view.groups.find((group) => group.id === 'repo-a');
  assert.equal(northwind.campaigns[0].attentionLabel, 'Run cap');
  assert.equal(northwind.campaigns[0].primaryNudge.mode, 'continue');
  assert.equal(northwind.campaigns[1].etaLabel, '12m–28m');
  assert.equal(northwind.campaigns[1].currentStepLabel, '2.2 · Fleet view');

  const calm = buildFleetViewModel({ campaigns: [fleetCampaign({ status: 'idle' })] });
  assert.equal(calm.calm, true);
  assert.equal(calm.empty, false);
  assert.equal(calm.babysittingLabel, 'Not tracked yet');
});

test('fleet DOM receipt renders repo groups, state badges, ETAs, and existing quick actions', async (t) => {
  const dom = installFakeFleetDom(t);
  const { renderFleetPayload } = await import('../public/modules/fleet.mjs?fleet-dom-receipt');
  renderFleetPayload({
    generatedAt: '2026-07-15T06:00:00.000Z',
    worstStatus: 'needs-attention',
    babysitting: { manualStopRate: 0.25, manualStops: 1, sampleSize: 4 },
    campaigns: [
      fleetCampaign({ id: 'running', repo: ['repo-a', 'Northwind'], status: 'running', eta: [12, 28] }),
      fleetCampaign({
        id: 'attention',
        repo: ['repo-a', 'Northwind'],
        status: 'stalled',
        attention: 'Run cap',
        nudge: [{ mode: 'continue', label: 'Continue this step' }],
      }),
      fleetCampaign({ id: 'idle', repo: ['repo-b', 'Harbor'], status: 'idle', eta: [20, 40] }),
    ],
  });

  assert.match(dom.groups.textContent, /Northwind/);
  assert.match(dom.groups.textContent, /Harbor/);
  assert.match(dom.groups.textContent, /Running/);
  assert.match(dom.groups.textContent, /Stalled/);
  assert.match(dom.groups.textContent, /Idle/);
  assert.match(dom.groups.textContent, /12m–28m/);
  assert.match(dom.groups.textContent, /Run cap/);
  assert.equal(dom.running.textContent, '1');
  assert.equal(dom.attention.textContent, '1');
  assert.equal(dom.babysitting.textContent, '25% · 1 manual stop');
  assert.equal(dom.kro.src, '/assets/kro/attention.svg');
  assert.deepEqual(
    findElements(dom.groups, (node) => node.dataset?.fleetAction).map((node) => node.dataset.fleetAction).sort(),
    ['nudge', 'open', 'open', 'open', 'stop'],
  );
  const nudge = findElements(dom.groups, (node) => node.dataset?.fleetAction === 'nudge')[0];
  assert.equal(nudge.dataset.mode, 'continue');
});

test('shared companion/fleet endpoint aggregates repos, ETA, attention, actions, and unified babysitting', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-fleet-'));
  const registryDir = path.join(root, 'registry');
  const runsDir = path.join(root, 'runs');
  const repoA = path.join(root, 'Northwind');
  const repoB = path.join(root, 'Harbor');
  const runningPath = path.join(repoA, 'campaigns', 'running.md');
  const attentionPath = path.join(repoA, 'campaigns', 'attention.md');
  const idlePath = path.join(repoB, 'campaigns', 'idle.md');
  const historyPath = path.join(repoB, 'campaigns', 'history.md');
  await Promise.all([
    mkdir(path.join(repoA, '.git'), { recursive: true }),
    mkdir(path.join(repoB, '.git'), { recursive: true }),
    mkdir(path.dirname(runningPath), { recursive: true }),
    mkdir(path.dirname(idlePath), { recursive: true }),
    mkdir(registryDir, { recursive: true }),
    mkdir(runsDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(runningPath, campaignMarkdown('Running campaign'), 'utf8'),
    writeFile(attentionPath, campaignMarkdown('Attention campaign'), 'utf8'),
    writeFile(idlePath, campaignMarkdown('Idle campaign'), 'utf8'),
    writeFile(historyPath, campaignMarkdown('History campaign'), 'utf8'),
  ]);
  await writeFile(path.join(registryDir, 'registry.json'), `${JSON.stringify({
    campaigns: [
      registryEntry('running', runningPath),
      registryEntry('attention', attentionPath),
      registryEntry('idle', idlePath),
    ],
  }, null, 2)}\n`, 'utf8');

  await writeLedger(runsDir, runningPath, runningLedger('running', runningPath, repoA));
  await writeLedger(runsDir, attentionPath, attentionLedger('attention', attentionPath, repoA));
  await writeLedger(runsDir, historyPath, stoppedLedger('history', historyPath, repoB));

  const child = spawn(process.execPath, ['server.mjs', '--port', '0'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CAMPAIGNS_REGISTRY_DIR: registryDir,
      CAMPAIGNS_RUNS_DIR: runsDir,
      CAMPAIGNS_PORT_FILE: path.join(root, 'server.port'),
      CAMPAIGNS_CONFIG_DIR: path.join(root, 'config'),
      CAMPAIGNS_AUTOMATE_BASE: path.join(root, 'legacy-automate'),
      CODEX_HOME: path.join(root, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`${baseUrl}/api/companion-state`);
  const aggregate = await response.json();

  assert.equal(response.status, 200);
  assert.equal(aggregate.counts.total, 3);
  assert.equal(aggregate.counts.running, 1);
  assert.equal(aggregate.counts.needsAttention, 1);
  assert.equal(aggregate.worstStatus, 'needs-attention');
  assert.deepEqual(aggregate.babysitting, {
    manualStopRate: 1 / 3,
    manualStops: 1,
    sampleSize: 3,
  });

  const running = aggregate.campaigns.find((campaign) => campaign.id === 'running');
  const attention = aggregate.campaigns.find((campaign) => campaign.id === 'attention');
  const idle = aggregate.campaigns.find((campaign) => campaign.id === 'idle');
  assert.equal(running.repo.label, 'Northwind');
  assert.equal(attention.repo.id, running.repo.id);
  assert.equal(idle.repo.label, 'Harbor');
  assert.equal(running.current_step.id, '1.1');
  assert.ok(Number.isFinite(running.eta.lowMinutes));
  assert.ok(running.eta.highMinutes >= running.eta.lowMinutes);
  assert.equal(running.actions.stop.available, true);
  assert.equal(attention.status, 'stalled');
  assert.equal(attention.attention.cause, 'cap_reached');
  assert.equal(attention.attention.label, 'Run cap');
  assert.equal(attention.actions.stop.available, false);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.attention, null);

  const fleetPage = await fetch(`${baseUrl}/?view=fleet`).then((page) => page.text());
  const fleetModule = await fetch(`${baseUrl}/modules/fleet.mjs`).then((page) => page.text());
  assert.match(fleetPage, /id="fleet"/);
  assert.match(fleetPage, /id="fleet-babysitting-index"/);
  assert.match(fleetModule, /'\/api\/run\/stop'/);
  assert.match(fleetModule, /'\/api\/automate-nudge'/);
  assert.doesNotMatch(fleetModule, /\/api\/fleet/);

  const badNudge = await fetch(`${baseUrl}/api/automate-nudge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'attention', mode: 'fleet_override' }),
  });
  assert.equal(badNudge.status, 400);
  const idleStop = await fetch(`${baseUrl}/api/run/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'idle' }),
  });
  assert.equal(idleStop.status, 409);

  await rm(runsDir, { recursive: true, force: true });
  await mkdir(runsDir, { recursive: true });
  const noLessons = await fetch(`${baseUrl}/api/companion-state`).then((result) => result.json());
  assert.equal(noLessons.babysitting, null);
  assert.equal(noLessons.lessons, null);

  const serverSource = await readFile(path.resolve('server.mjs'), 'utf8');
  const aggregateSource = serverSource.slice(
    serverSource.indexOf('async function sendCompanionState'),
    serverSource.indexOf('/* ------------------------------ API: companion pet'),
  );
  assert.match(aggregateSource, /readUnifiedRunLedgers\(lessonsRunsDir\)/);
  assert.match(aggregateSource, /estimateCampaign\(/);
  assert.doesNotMatch(aggregateSource, /fetch\([^\n]*\/api\/estimate/);
});

function fleetCampaign({
  id = 'campaign',
  repo = ['repo', 'Repository'],
  status = 'idle',
  eta = null,
  remainingSteps = 1,
  attention = null,
  nudge = [],
} = {}) {
  return {
    id,
    title: `${id} title`,
    repo: { id: repo[0], label: repo[1] },
    status,
    label: status[0].toUpperCase() + status.slice(1),
    current_step: status === 'running' ? { id: '2.2', name: 'Fleet view' } : null,
    eta: eta ? { lowMinutes: eta[0], highMinutes: eta[1], remainingSteps } : null,
    attention: attention ? { cause: 'cap_reached', label: attention } : null,
    actions: { open: { available: true }, stop: { available: status === 'running' }, nudge },
  };
}

function registryEntry(id, filePath) {
  return {
    id,
    filePath,
    createdAt: '2026-07-15T05:00:00.000Z',
    lastOpenedAt: '2026-07-15T05:30:00.000Z',
    lastActivityAt: '2026-07-15T05:45:00.000Z',
  };
}

function campaignMarkdown(title) {
  return `# ${title}

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Ship the fixture
- [ ] Final review

## Step 1.1 — Ship the fixture

Model: GPT-5.6-Sol · High
Parallel: NO

\`\`\`text
Ship the fixture.
\`\`\`

## Final review

\`\`\`text
Review the fixture.
\`\`\`
`;
}

function baseLedger(id, campaignPath, repoRoot) {
  const paths = runPathsForCampaign(campaignPath, path.join(path.dirname(repoRoot), 'runs'));
  return createRunState({
    id: `${id}-run`,
    identity: {
      registry_id: id,
      source: { campaign_path: campaignPath, repo_root: repoRoot },
      execution: { campaign_path: campaignPath, repo_root: repoRoot, branch: 'campaign/fixture' },
    },
    steps: [{ id: '1.1', name: 'Ship the fixture', phase: '1' }],
    config: {
      runner: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      watchdog: { minimum_runtime_ms: 0, stall_window_ms: 60_000 },
    },
    artifacts: {
      run_dir: paths.runDir,
      receipts_dir: paths.receiptsDir,
      final_review_path: paths.finalReviewPath,
    },
    created_at: '2026-07-15T05:00:00.000Z',
  });
}

function runningLedger(id, campaignPath, repoRoot) {
  let state = baseLedger(id, campaignPath, repoRoot);
  state = transitionRunState(state, { event: 'run_started', at: '2026-07-15T05:01:00.000Z' });
  return transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    at: '2026-07-15T05:02:00.000Z',
    worker: { runner: 'codex', invocation_id: `${id}-worker`, pid: process.pid },
  });
}

function attentionLedger(id, campaignPath, repoRoot) {
  let state = baseLedger(id, campaignPath, repoRoot);
  state = transitionRunState(state, { event: 'run_started', at: '2026-07-15T05:01:00.000Z' });
  return transitionRunState(state, { event: 'cap_reached', at: '2026-07-15T05:03:00.000Z' });
}

function stoppedLedger(id, campaignPath, repoRoot) {
  let state = baseLedger(id, campaignPath, repoRoot);
  state = transitionRunState(state, { event: 'run_started', at: '2026-07-15T04:01:00.000Z' });
  state = transitionRunState(state, {
    event: 'step_started',
    step_id: '1.1',
    at: '2026-07-15T04:02:00.000Z',
    worker: { runner: 'codex', invocation_id: `${id}-worker`, pid: null },
  });
  return transitionRunState(state, { event: 'stopped_by_user', at: '2026-07-15T04:03:00.000Z' });
}

async function writeLedger(runsDir, campaignPath, state) {
  const paths = runPathsForCampaign(campaignPath, runsDir);
  state.artifacts.run_dir = paths.runDir;
  state.artifacts.receipts_dir = paths.receiptsDir;
  state.artifacts.final_review_path = paths.finalReviewPath;
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

function installFakeFleetDom(t) {
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLButtonElement: globalThis.HTMLButtonElement,
  };
  const ids = new Map();
  for (const id of [
    'fleet',
    'fleet-summary',
    'fleet-groups',
    'fleet-empty',
    'fleet-kro',
    'fleet-running-count',
    'fleet-attention-count',
    'fleet-babysitting-index',
    'fleet-updated',
  ]) {
    ids.set(id, new FakeElement('div'));
  }
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => ids.get(id) ?? null,
    querySelector: (selector) => selector.startsWith('#') ? ids.get(selector.slice(1)) ?? null : null,
  };
  globalThis.Element = FakeElement;
  globalThis.HTMLButtonElement = FakeElement;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.Element = previous.Element;
    globalThis.HTMLButtonElement = previous.HTMLButtonElement;
  });
  return {
    groups: ids.get('fleet-groups'),
    running: ids.get('fleet-running-count'),
    attention: ids.get('fleet-attention-count'),
    babysitting: ids.get('fleet-babysitting-index'),
    kro: ids.get('fleet-kro'),
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => (
      typeof child === 'string' ? child : child.textContent
    )).join('')}`;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this._text = '';
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function findElements(root, predicate) {
  const matches = [];
  for (const child of root.children) {
    if (!(child instanceof FakeElement)) continue;
    if (predicate(child)) matches.push(child);
    matches.push(...findElements(child, predicate));
  }
  return matches;
}

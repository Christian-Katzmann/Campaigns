import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CHECK_NAME,
  COMMENT_MARKER,
  conclusionForStatus,
  publishPrReport,
} from '../action/report-pr.mjs';

test('PR reporting creates then updates one sticky comment and check run', async (t) => {
  const fixture = await makeFixture(t, completedState());
  const github = fakeGitHub();

  const first = await publishPrReport({ env: fixture.env, fetchImpl: github.fetch });
  assert.equal(first.comment, 'created');
  assert.equal(first.check, 'created');
  assert.equal(github.comments.length, 1);
  assert.equal(github.checks.length, 1);

  await writeFile(fixture.statePath, JSON.stringify({
    ...completedState(),
    run: { status: 'cap_reached' },
    review: { status: 'not_started', verdict: null },
    history: [{ event: 'cap_reached', message: 'Maximum cost reached: $1.00.' }],
  }));
  const second = await publishPrReport({ env: fixture.env, fetchImpl: github.fetch });

  assert.equal(second.comment, 'updated');
  assert.equal(second.check, 'updated');
  assert.equal(github.comments.length, 1);
  assert.equal(github.checks.length, 1);
  assert.match(github.comments[0].body, new RegExp(COMMENT_MARKER));
  assert.match(github.comments[0].body, /\| 1\.1 — Build \| Completed \| Passed \| Receipt \|/);
  assert.match(github.comments[0].body, /Maximum cost reached: \$1\.00\./);
  assert.match(github.comments[0].body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/123\/artifacts\/456/);
  assert.equal(github.checks[0].conclusion, 'failure');
});

test('check conclusions target the PR head and map terminal outcomes', async (t) => {
  assert.equal(conclusionForStatus('completed'), 'success');
  assert.equal(conclusionForStatus('merged'), 'success');
  assert.equal(conclusionForStatus('cap_reached'), 'failure');
  assert.equal(conclusionForStatus('awaiting_human_review'), 'action_required');
  assert.equal(conclusionForStatus('failed'), 'failure');

  for (const [status, conclusion] of [
    ['completed', 'success'],
    ['merged', 'success'],
    ['cap_reached', 'failure'],
    ['awaiting_human_review', 'action_required'],
  ]) {
    const fixture = await makeFixture(t, { ...completedState(), run: { status } });
    const github = fakeGitHub();
    await publishPrReport({ env: fixture.env, fetchImpl: github.fetch });
    assert.equal(github.checks[0].name, CHECK_NAME);
    assert.equal(github.checks[0].head_sha, 'a'.repeat(40));
    assert.equal(github.checks[0].conclusion, conclusion);
  }
});

test('report payloads use persisted summary fields, not inherited secrets', async (t) => {
  const sentinel = 'sentinel-action-report-secret';
  const fixture = await makeFixture(t, completedState());
  const github = fakeGitHub();
  await publishPrReport({
    env: { ...fixture.env, ANTHROPIC_API_KEY: sentinel },
    fetchImpl: github.fetch,
  });

  assert.doesNotMatch(JSON.stringify({ comments: github.comments, checks: github.checks }), new RegExp(sentinel));
});

test('fork PRs are refused before any GitHub request', async (t) => {
  const fixture = await makeFixture(t, completedState(), { headRepo: 'fork/repo', fork: true });
  const github = fakeGitHub();
  await assert.rejects(
    publishPrReport({ env: fixture.env, fetchImpl: github.fetch }),
    /refused for fork pull requests/,
  );
  assert.equal(github.requests.length, 0);
});

async function makeFixture(t, state, { headRepo = 'owner/repo', fork = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-action-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'run');
  const statePath = path.join(stateDir, 'state.json');
  const eventPath = path.join(root, 'event.json');
  await mkdir(path.join(stateDir, 'receipts'), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(eventPath, JSON.stringify({
    number: 42,
    repository: { full_name: 'owner/repo' },
    pull_request: {
      number: 42,
      head: { sha: 'a'.repeat(40), repo: { full_name: headRepo, fork } },
    },
  }));
  return {
    statePath,
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_TOKEN: 'github-token',
      STATE_DIR: stateDir,
      ARTIFACT_URL: 'https://github.com/owner/repo/actions/runs/123/artifacts/456',
    },
  };
}

function completedState() {
  return {
    run: { status: 'completed' },
    steps: [{
      id: '1.1',
      name: 'Build',
      status: 'completed',
      receipt_path: '/tmp/run/receipts/1.1.md',
      failure: null,
    }],
    review: { status: 'approved', verdict: 'APPROVED' },
    history: [],
  };
}

function fakeGitHub() {
  const comments = [];
  const checks = [];
  const requests = [];
  return {
    comments,
    checks,
    requests,
    fetch: async (url, options) => {
      const method = options.method;
      const pathname = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ method, pathname, body });

      if (method === 'GET' && pathname.endsWith('/issues/42/comments')) return response(comments);
      if (method === 'POST' && pathname.endsWith('/issues/42/comments')) {
        const comment = { id: 10, ...body };
        comments.push(comment);
        return response(comment, 201);
      }
      if (method === 'PATCH' && pathname.endsWith('/issues/comments/10')) {
        Object.assign(comments[0], body);
        return response(comments[0]);
      }
      if (method === 'GET' && pathname.includes('/commits/') && pathname.endsWith('/check-runs')) {
        return response({ check_runs: checks });
      }
      if (method === 'POST' && pathname.endsWith('/check-runs')) {
        const check = { id: 20, ...body };
        checks.push(check);
        return response(check, 201);
      }
      if (method === 'PATCH' && pathname.endsWith('/check-runs/20')) {
        Object.assign(checks[0], body);
        return response(checks[0]);
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

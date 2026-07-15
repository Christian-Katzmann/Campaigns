#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMENT_MARKER = '<!-- campaigns-ci-report -->';
export const CHECK_NAME = 'Campaigns';

export async function publishPrReport({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return { skipped: true };

  const event = JSON.parse(await readFile(required(env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH'), 'utf8'));
  const context = trustedPrContext(event, env);
  const statePath = path.join(required(env.STATE_DIR, 'STATE_DIR'), 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const report = summarizeState(state, env.ARTIFACT_URL);
  const api = createGitHubApi({
    baseUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    token: required(env.GITHUB_TOKEN, 'GITHUB_TOKEN'),
    fetchImpl,
  });

  const comments = await api('GET', `/repos/${context.repo}/issues/${context.number}/comments?per_page=100`);
  const existingComment = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
  assertTrustedWrite(event, env);
  if (existingComment) {
    await api('PATCH', `/repos/${context.repo}/issues/comments/${existingComment.id}`, {
      body: report.commentBody,
    });
  } else {
    await api('POST', `/repos/${context.repo}/issues/${context.number}/comments`, {
      body: report.commentBody,
    });
  }

  const externalId = `campaigns-pr-${context.number}`;
  const checks = await api(
    'GET',
    `/repos/${context.repo}/commits/${context.headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
  );
  const existingCheck = checks.check_runs?.find((check) => check.external_id === externalId);
  const checkPayload = {
    name: CHECK_NAME,
    head_sha: context.headSha,
    status: 'completed',
    conclusion: report.conclusion,
    external_id: externalId,
    ...(report.artifactUrl ? { details_url: report.artifactUrl } : {}),
    output: {
      title: report.checkTitle,
      summary: report.checkSummary,
    },
  };
  assertTrustedWrite(event, env);
  if (existingCheck) {
    const { head_sha: _headSha, ...updatePayload } = checkPayload;
    await api('PATCH', `/repos/${context.repo}/check-runs/${existingCheck.id}`, updatePayload);
  } else {
    await api('POST', `/repos/${context.repo}/check-runs`, checkPayload);
  }

  return {
    skipped: false,
    comment: existingComment ? 'updated' : 'created',
    check: existingCheck ? 'updated' : 'created',
    ...report,
  };
}

export function summarizeState(state, artifactUrl) {
  const status = required(state?.run?.status, 'state.run.status');
  const conclusion = conclusionForStatus(status);
  const safeArtifactUrl = normalizeArtifactUrl(artifactUrl);
  const verdict = state.review?.verdict ?? humanize(state.review?.status ?? 'not_started');
  const capReason = status === 'cap_reached' ? findCapReason(state.history) : '—';
  const rows = (state.steps ?? []).map((step) => (
    `| ${cell(`${step.id} — ${step.name}`)} | ${cell(humanize(step.status))} | ${cell(stepOutcome(step))} | ${step.receipt_path ? 'Receipt' : '—'} |`
  ));
  if (rows.length === 0) rows.push('| — | — | No steps recorded | — |');

  const artifactLine = safeArtifactUrl
    ? `[Download redacted run evidence](${safeArtifactUrl})`
    : 'Run evidence unavailable';
  const summary = [
    '| Step | Status | Check outcome | Evidence |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `**Verdict:** ${cell(verdict)}`,
    `**Cap reason:** ${cell(capReason)}`,
    `**Artifacts:** ${artifactLine}`,
  ].join('\n');

  return {
    artifactUrl: safeArtifactUrl,
    conclusion,
    commentBody: `${COMMENT_MARKER}\n## Campaigns CI\n\n${summary}`,
    checkTitle: `Campaigns: ${humanize(status)}`,
    checkSummary: summary,
  };
}

export function conclusionForStatus(status) {
  if (status === 'completed' || status === 'merged') return 'success';
  if (status === 'awaiting_human_review') return 'action_required';
  return 'failure';
}

export function trustedPrContext(event, env) {
  assertTrustedWrite(event, env);
  const number = Number(event.pull_request?.number ?? event.number);
  const headSha = required(event.pull_request?.head?.sha, 'pull_request.head.sha');
  if (!Number.isInteger(number) || number <= 0) throw new Error('pull_request.number is required');
  return {
    repo: required(event.repository?.full_name, 'repository.full_name'),
    number,
    headSha,
  };
}

function assertTrustedWrite(event, env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    throw new Error('GitHub writes require the pull_request event');
  }
  const repo = required(event.repository?.full_name, 'repository.full_name');
  const headRepo = required(event.pull_request?.head?.repo?.full_name, 'pull_request.head.repo.full_name');
  if (repo !== headRepo || event.pull_request?.head?.repo?.fork === true) {
    throw new Error('GitHub writes are refused for fork pull requests');
  }
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== repo) {
    throw new Error('GitHub writes are refused outside the event repository');
  }
}

function stepOutcome(step) {
  if (step.status === 'completed') return 'Passed';
  if (step.status === 'skipped') return 'Skipped';
  if (step.status === 'failed') {
    return step.failure?.message ?? step.failure?.code ?? 'Failed';
  }
  return humanize(step.status ?? 'unknown');
}

function findCapReason(history = []) {
  const event = [...history].reverse().find((entry) => entry.event === 'cap_reached');
  return event?.message ?? 'Configured run cap reached';
}

function normalizeArtifactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function humanize(value) {
  const text = String(value ?? '').replaceAll('_', ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '—';
}

function cell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function createGitHubApi({ baseUrl, token, fetchImpl }) {
  return async (method, apiPath, body) => {
    const response = await fetchImpl(`${baseUrl}${apiPath}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${apiPath} failed (${response.status}): ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishPrReport().catch((error) => {
    process.stderr.write(`campaigns-action: ${error.message}\n`);
    process.exitCode = 1;
  });
}

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeRedactedFile } from './redaction.mjs';
import {
  buildRunnerInvocation,
  extractRunnerOutput,
} from './runners.mjs';

export const REVIEW_REASON_TAGS = Object.freeze([
  'verification-gap',
  'scope-drift',
  'acceptance-miss',
  'cross-step-contract',
  'visual-regression',
  'tooling-failure',
  'scheduler-failure',
  'branch-prep-failure',
  'data-quality-gap',
  'documentation-gap',
]);

export const REVIEW_REASON_ALIASES = Object.freeze({
  'missing-verification': 'verification-gap',
  verification: 'verification-gap',
  'no-proof': 'verification-gap',
  scope: 'scope-drift',
  'missed-acceptance': 'acceptance-miss',
  'acceptance-gap': 'acceptance-miss',
  'contract-gap': 'cross-step-contract',
  'cross-phase-shortcut': 'cross-step-contract',
  'tool-failure': 'tooling-failure',
  'registry-failure': 'scheduler-failure',
  'handoff-failure': 'scheduler-failure',
  'branch-failure': 'branch-prep-failure',
  'worktree-failure': 'branch-prep-failure',
  'data-gap': 'data-quality-gap',
  'doc-gap': 'documentation-gap',
});

const REVIEW_REASON_SET = new Set(REVIEW_REASON_TAGS);
const VERDICT_LINE = /^Verdict:[ \t]*(APPROVED|NEEDS[ \t]+WORK)[ \t]*$/gim;
const REASONS_LINE = /^Reasons:[ \t]*(.*)$/im;
const TAG_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

export function parseReviewOutput(output) {
  const text = String(output ?? '');
  const verdictMatches = [...text.matchAll(VERDICT_LINE)];
  const verdicts = [...new Set(verdictMatches.map((match) => (
    match[1].replace(/\s+/g, ' ').toUpperCase()
  )))];
  if (verdicts.length !== 1) {
    return malformedResult(verdicts.length === 0 ? 'missing-verdict' : 'ambiguous-verdict');
  }

  const verdictMatch = verdictMatches.find((match) => (
    match[1].replace(/\s+/g, ' ').toUpperCase() === verdicts[0]
  ));
  const afterVerdict = text.slice((verdictMatch?.index ?? 0) + (verdictMatch?.[0].length ?? 0));
  const reasonsMatch = afterVerdict.match(REASONS_LINE);
  if (!reasonsMatch) return malformedResult('missing-reasons-header', verdicts[0]);

  const rawValues = splitReasons(reasonsMatch[1]);
  if (verdicts[0] === 'NEEDS WORK' && rawValues.length === 0) {
    return malformedResult('missing-reasons', verdicts[0]);
  }

  const reasons = [];
  const rawTags = [];
  for (const value of rawValues) {
    const normalized = normalizeTag(value);
    const canonical = REVIEW_REASON_ALIASES[normalized] ?? normalized;
    if (REVIEW_REASON_SET.has(canonical)) {
      pushUnique(reasons, canonical);
    } else {
      pushUnique(rawTags, TAG_SHAPE.test(value) ? normalized : value);
    }
  }

  return {
    valid: true,
    verdict: verdicts[0],
    reasons,
    raw_tags: rawTags,
    issue: rawTags.length > 0 ? 'noncanonical-reasons' : null,
  };
}

export async function runFinalReview(options) {
  const {
    state,
    reviewPrompt,
    registry,
    runnerName,
    repoRoot,
    paths,
    runInvocation,
  } = options;
  if (typeof runInvocation !== 'function') throw new TypeError('runInvocation must be a function');

  await mkdir(paths.logsDir, { recursive: true });
  const attempts = [];
  let reaskIssue = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const round = options.reviewRound ?? 1;
    const logPath = path.join(paths.logsDir, `review-${round}-${attempt}.log`);
    const outputPath = path.join(paths.logsDir, `review-${round}-${attempt}-last-message.md`);
    const prompt = buildReviewPrompt({
      state,
      reviewPrompt,
      reaskIssue,
    });
    const invocation = buildRunnerInvocation(registry, runnerName, {
      prompt,
      repoRoot,
      outputPath,
      model: options.model,
      effort: options.effort,
      env: options.env,
    });
    const result = await runInvocation(invocation, {
      cwd: repoRoot,
      logPath,
      ignoredActivityPaths: [paths.runDir],
      signal: options.signal,
      stdout: options.stdout,
      stderr: options.stderr,
      watchdog: options.watchdog,
      onSpawn: async () => {},
    });
    const output = await readReviewOutput(outputPath, registry, runnerName, result.stdout);
    if (result.stop?.requested || result.cap) {
      const review = {
        kind: result.stop?.requested ? 'stopped' : 'cap_reached',
        verdict: null,
        reasons: [],
        raw_tags: [],
        attempts: [{
          attempt,
          exit_code: result.exitCode,
          output,
          parsed: null,
          log_path: logPath,
        }],
        review_path: paths.finalReviewPath,
        stop: result.stop,
        cap: result.cap,
        output_tail: result.outputTail,
      };
      await writeReviewArtifact(review);
      return review;
    }
    const parsed = result.exitCode === 0 && !result.watchdog?.stalled
      ? parseReviewOutput(output)
      : malformedResult(result.watchdog?.stalled ? 'runner-stalled' : 'runner-failed');
    attempts.push({
      attempt,
      exit_code: result.exitCode,
      output,
      parsed,
      log_path: logPath,
    });

    const needsReask = !parsed.valid || parsed.raw_tags.length > 0;
    if (attempt === 1 && needsReask) {
      reaskIssue = parsed.issue;
      await options.onReask?.({ issue: reaskIssue, parsed });
      continue;
    }

    if (!parsed.valid) {
      const review = {
        kind: 'unparseable',
        verdict: null,
        reasons: [],
        raw_tags: [],
        attempts,
        review_path: paths.finalReviewPath,
      };
      await writeReviewArtifact(review);
      return review;
    }

    const review = {
      kind: parsed.verdict === 'APPROVED' ? 'approved' : 'needs_work',
      verdict: parsed.verdict,
      reasons: parsed.reasons,
      raw_tags: parsed.raw_tags,
      attempts,
      review_path: paths.finalReviewPath,
    };
    await writeReviewArtifact(review);
    return review;
  }

  throw new Error('review loop exhausted without a result');
}

export async function runFixAttempt(options) {
  const {
    attempt,
    state,
    review,
    registry,
    runnerName,
    repoRoot,
    paths,
    runInvocation,
    readHead,
  } = options;
  if (typeof runInvocation !== 'function') throw new TypeError('runInvocation must be a function');
  if (typeof readHead !== 'function') throw new TypeError('readHead must be a function');

  await mkdir(paths.logsDir, { recursive: true });
  const logPath = path.join(paths.logsDir, `fix-${attempt}.log`);
  const outputPath = path.join(paths.logsDir, `fix-${attempt}-last-message.md`);
  const beforeHead = await readHead(repoRoot);
  const prompt = buildFixPrompt({
    state,
    review,
    acceptanceCriteria: options.acceptanceCriteria,
  });
  const invocation = buildRunnerInvocation(registry, runnerName, {
    prompt,
    repoRoot,
    outputPath,
    model: options.model,
    effort: options.effort,
    env: options.env,
  });
  const result = await runInvocation(invocation, {
    cwd: repoRoot,
    logPath,
    ignoredActivityPaths: [paths.runDir],
    signal: options.signal,
    stdout: options.stdout,
    stderr: options.stderr,
    watchdog: options.watchdog,
    onSpawn: async () => {},
  });
  const afterHead = await readHead(repoRoot);
  const output = await readReviewOutput(outputPath, registry, runnerName, result.stdout);
  const committed = beforeHead !== afterHead;
  return {
    attempt,
    committed,
    before_head: beforeHead,
    commit_sha: committed ? afterHead : null,
    exit_code: result.exitCode,
    watchdog: result.watchdog,
    stop: result.stop,
    cap: result.cap,
    output_tail: result.outputTail,
    output,
    log_path: logPath,
  };
}

function buildReviewPrompt({ state, reviewPrompt, reaskIssue }) {
  const base = reviewPrompt?.trim() || [
    `Run a final review of ${state.run.identity.execution.campaign_path}.`,
    'Read the campaign acceptance criteria and verify them against the cumulative git diff.',
    'Do not trust receipts; inspect the implementation and tests.',
  ].join('\n');
  const canonical = REVIEW_REASON_TAGS.map((tag) => `\`${tag}\``).join(', ');
  const contract = [
    'Your review must start exactly with Verdict: APPROVED or Verdict: NEEDS WORK.',
    'The second line must be Reasons: followed by comma-separated tags; APPROVED may leave it empty.',
    `Use only these tags: ${canonical}.`,
    'After the two-line header, add one blank line and a lean human-readable review.',
  ];
  if (reaskIssue) {
    contract.push(
      `This is the single structured re-ask because the previous response had ${reaskIssue}.`,
      'Return a complete corrected review from a fresh session.',
    );
  }
  return `${base}\n\n${contract.join('\n')}`;
}

function buildFixPrompt({ state, review, acceptanceCriteria }) {
  const reviewerOutput = review.attempts.at(-1)?.output?.trim() || '(review output unavailable)';
  const criteria = acceptanceCriteria?.trim()
    || `Read the acceptance criteria in ${state.run.identity.execution.campaign_path}.`;
  const source = state.run.identity.execution.branch;
  const target = state.run.identity.execution.merge_target_branch;
  const diffPointer = target && target !== source
    ? `git diff ${target}...${source}`
    : 'git diff HEAD^';
  return [
    'Fix the final-review gaps in this campaign branch.',
    'Keep the change to the smallest coherent fix. Verify it, then commit it before exiting.',
    '',
    '## Review',
    '',
    reviewerOutput,
    '',
    '## Acceptance criteria',
    '',
    criteria,
    '',
    '## Cumulative diff pointer',
    '',
    diffPointer,
  ].join('\n');
}

async function readReviewOutput(outputPath, registry, runnerName, stdout) {
  try {
    const output = await readFile(outputPath, 'utf8');
    if (output.trim()) return output;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return extractRunnerOutput(registry, runnerName, stdout);
}

async function writeReviewArtifact(review) {
  const latest = review.attempts.at(-1);
  const verdict = review.verdict ?? 'UNPARSEABLE';
  const body = [
    `Verdict: ${verdict}`,
    `Reasons: ${review.reasons.join(', ')}`,
    `Raw tags: ${review.raw_tags.join(', ')}`,
    `Worker sessions: ${review.attempts.length}`,
    '',
    '## Reviewer output',
    '',
    latest?.output?.trim() || '(no parseable reviewer output)',
    '',
  ].join('\n');
  await writeRedactedFile(review.review_path, body);
}

function malformedResult(issue, verdict = null) {
  return {
    valid: false,
    verdict,
    reasons: [],
    raw_tags: [],
    issue,
  };
}

function splitReasons(value) {
  const line = String(value ?? '').trim();
  if (!line) return [];
  return line
    .replace(/^\s*[\[({<]/, '')
    .replace(/[\])}>]\s*$/, '')
    .split(',')
    .map((part) => part.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

function normalizeTag(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function pushUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

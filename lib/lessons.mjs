import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { REVIEW_REASON_TAGS } from './review.mjs';
import {
  RUN_STATE_VERSION,
  upgradeRunState,
  validateRunState,
} from './run-state.mjs';

const REVIEW_EVENTS = new Set([
  'final_review_needs_work',
  'final_review_approved',
  'campaign_completed',
  'final_review_halted',
  'review_unparseable',
]);
const REWORK_EVENTS = new Set([
  'final_review_needs_work',
  'final_fix_started',
  'final_fix_failed',
  'final_rework_completed',
]);
const FAILURE_EVENTS = new Set([
  'preflight_dirty_worktree',
  'preflight_branch_unavailable',
  'preflight_campaign_invalid',
  'review_unparseable',
  'review_fix_attempts_exhausted',
  'review_merge_failed',
  'final_review_halted',
  'cap_reached',
  'stopped_by_user',
  'recovery_failed',
]);
const ADVERSE_STATUSES = new Set([
  'blocked',
  'failed',
  'awaiting_human_review',
  'cap_reached',
  'stopped_by_user',
  'halted',
]);
const CANONICAL_REASON_SET = new Set(REVIEW_REASON_TAGS);
const STATE_FILE = /^state(?:-[a-z0-9-]+)?\.json$/i;
const TOP_LIMIT = 5;

export async function readUnifiedRunLedgers(runsDir) {
  let runDirs;
  try {
    runDirs = await readdir(path.resolve(runsDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const candidates = [];
  for (const runDir of runDirs) {
    if (!runDir.isDirectory()) continue;
    const directory = path.join(path.resolve(runsDir), runDir.name);
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isFile() && STATE_FILE.test(file.name)) candidates.push(path.join(directory, file.name));
    }
  }

  const byRunId = new Map();
  for (const statePath of candidates.sort()) {
    const state = await readUnifiedState(statePath);
    if (!state) continue;
    const existing = byRunId.get(state.run.id);
    if (!existing || state.run.updated_at >= existing.run.updated_at) byRunId.set(state.run.id, state);
  }
  return [...byRunId.values()].sort((a, b) => a.run.created_at.localeCompare(b.run.created_at));
}

export async function hasUnifiedRunLedgers(runsDir) {
  return (await readUnifiedRunLedgers(runsDir)).length > 0;
}

export async function loadUnifiedLessons(runsDir, options = {}) {
  return aggregateUnifiedLessons(await readUnifiedRunLedgers(runsDir), options);
}

export function aggregateUnifiedLessons(ledgers, options = {}) {
  const runs = ledgers.map(runFacts);
  const runnerIds = [...new Set(runs.map((run) => run.runner))].sort();
  const canonicalReasons = [];
  const rawTags = [];
  const failureCounts = new Map();
  let invalidCanonicalTags = 0;

  for (const run of runs) {
    for (const event of run.state.history) {
      if (event.event === 'step_failed') {
        increment(failureCounts, event.details?.failure?.code || 'unknown');
      } else if (FAILURE_EVENTS.has(event.event)) {
        increment(failureCounts, event.event);
      }

      if (!REVIEW_EVENTS.has(event.event)) continue;
      for (const reason of stringArray(event.details?.reasons)) {
        if (CANONICAL_REASON_SET.has(reason)) canonicalReasons.push(reason);
        else invalidCanonicalTags += 1;
      }
      rawTags.push(...stringArray(event.details?.raw_tags));
    }
  }

  return {
    available: true,
    source: 'unified',
    schemaVersion: RUN_STATE_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scanned: {
      total: runs.length,
      ...Object.fromEntries(runnerIds.map((runner) => [runner, runs.filter((run) => run.runner === runner).length])),
    },
    overall: summarizeRuns(runs),
    backends: runnerIds.map((runner) => ({
      id: runner,
      label: titleCase(runner),
      ...summarizeRuns(runs.filter((run) => run.runner === runner)),
    })),
    sizing: sizingGuidance(runs),
    failureTaxonomy: {
      total: [...failureCounts.values()].reduce((total, count) => total + count, 0),
      counts: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, count]) => ({ code, count })),
    },
    reasons: {
      topTags: topCounts(canonicalReasons, TOP_LIMIT),
      rawTopTags: topCounts(rawTags, TOP_LIMIT),
    },
    dataQuality: {
      invalidCanonicalTags,
    },
  };
}

async function readUnifiedState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Number.isInteger(parsed?.schema_version)
      || parsed.schema_version < 1
      || parsed.schema_version > RUN_STATE_VERSION) return null;
    const state = upgradeRunState(parsed);
    return validateRunState(state).valid ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

function runFacts(state) {
  const events = state.history.map((entry) => entry.event);
  const verdict = ['APPROVED', 'NEEDS WORK'].includes(state.review.verdict)
    ? state.review.verdict
    : null;
  const reworked = events.some((event) => REWORK_EVENTS.has(event));
  return {
    state,
    runner: nonEmptyString(state.config.runner) ? state.config.runner.toLowerCase() : 'unknown',
    status: state.run.status,
    verdict,
    approved: verdict === 'APPROVED',
    firstTry: verdict === 'APPROVED' && !reworked,
    reworked,
    manualStop: events.includes('stopped_by_user'),
    capReached: events.includes('cap_reached'),
    stepCount: state.steps.length,
  };
}

function summarizeRuns(runs) {
  const withVerdict = runs.filter((run) => run.verdict);
  const approved = withVerdict.filter((run) => run.approved);
  const firstTry = withVerdict.filter((run) => run.firstTry);
  const reworked = runs.filter((run) => run.reworked);
  const manualStops = runs.filter((run) => run.manualStop);
  const capReached = runs.filter((run) => run.capReached);
  return {
    total: runs.length,
    withVerdict: withVerdict.length,
    approved: approved.length,
    firstTry: firstTry.length,
    reworked: reworked.length,
    manualStops: manualStops.length,
    capReached: capReached.length,
    approvalRate: rate(approved.length, withVerdict.length),
    firstTryRate: rate(firstTry.length, withVerdict.length),
    reworkRate: rate(reworked.length, runs.length),
    manualStopRate: rate(manualStops.length, runs.length),
  };
}

function sizingGuidance(runs) {
  const firstTryCounts = runs
    .filter((run) => run.firstTry && run.stepCount > 0)
    .map((run) => run.stepCount)
    .sort((a, b) => a - b);
  if (firstTryCounts.length === 0) {
    return {
      medianSteps: null,
      p90Steps: null,
      maxFirstTrySteps: null,
      avoidAboveSteps: null,
      sample: 0,
    };
  }

  const p90Index = firstTryCounts.length >= 10
    ? Math.min(firstTryCounts.length - 1, Math.floor(firstTryCounts.length * 0.9))
    : firstTryCounts.length - 1;
  const p90 = firstTryCounts[p90Index];
  let avoidAbove = null;
  const byStepCount = new Map();
  for (const run of runs) {
    if (run.stepCount <= 0) continue;
    const tier = byStepCount.get(run.stepCount) ?? [];
    tier.push(ADVERSE_STATUSES.has(run.status));
    byStepCount.set(run.stepCount, tier);
  }
  for (const [stepCount, tier] of [...byStepCount.entries()].sort((a, b) => a[0] - b[0])) {
    if (tier.length >= 3 && tier.filter(Boolean).length / tier.length >= 0.5) {
      avoidAbove = Math.max(1, stepCount - 1);
      break;
    }
  }

  return {
    medianSteps: median(firstTryCounts),
    p90Steps: p90,
    maxFirstTrySteps: firstTryCounts.at(-1),
    avoidAboveSteps: avoidAbove ?? p90,
    sample: firstTryCounts.length,
  };
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) increment(counts, value.trim());
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function increment(counts, value) {
  if (!value) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => nonEmptyString(item)).map((item) => item.trim())
    : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function titleCase(value) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

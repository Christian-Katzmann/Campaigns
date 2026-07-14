import { fleetPriorForBackend } from '../public/lib/estimate-priors.mjs';

export const PERSONAL_DURATION_MIN_SAMPLE = 5;
export const ESTIMATE_MONTE_CARLO_ITERATIONS = 4_000;

const REVIEW_OUTCOME_EVENTS = new Set([
  'final_review_approved',
  'campaign_completed',
  'final_review_needs_work',
  'final_review_halted',
]);
const REWORK_EVENTS = new Set([
  'final_review_needs_work',
  'final_fix_started',
  'final_fix_failed',
  'final_rework_completed',
]);

export function buildBackendDurationSamples(ledgers) {
  const samples = {};
  for (const ledger of Array.isArray(ledgers) ? ledgers : []) {
    const fallbackBackend = normalizeBackend(ledger?.config?.runner);
    for (const step of Array.isArray(ledger?.steps) ? ledger.steps : []) {
      const minutes = durationMinutes(step?.started_at, step?.completed_at);
      if (minutes == null) continue;
      const backend = normalizeBackend(step?.runner) || fallbackBackend || 'unknown';
      (samples[backend] ??= []).push(minutes);
    }
  }
  for (const values of Object.values(samples)) values.sort((a, b) => a - b);
  return samples;
}

export function summarizeDurations(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return { sampleSize: 0, p50Minutes: null, p90Minutes: null };
  return {
    sampleSize: sorted.length,
    p50Minutes: quantile(sorted, 0.5),
    p90Minutes: quantile(sorted, 0.9),
  };
}

export function estimateCampaign({
  steps,
  ledgers = [],
  liveLedger = null,
  seed = 'campaign-estimate',
  iterations = ESTIMATE_MONTE_CARLO_ITERATIONS,
  now = new Date().toISOString(),
} = {}) {
  const authoredSteps = Array.isArray(steps) ? steps : [];
  const backendSamples = buildBackendDurationSamples(ledgers);
  const liveSteps = new Map(
    (Array.isArray(liveLedger?.steps) ? liveLedger.steps : []).map((step) => [String(step.id), step]),
  );
  const remainingSteps = authoredSteps
    .filter((step) => isStepRemaining(step, liveSteps.get(String(step.id))))
    .map((step) => ({
      id: String(step.id),
      backend: normalizeBackend(step.runner) || 'unknown',
      live: liveSteps.get(String(step.id)) ?? null,
    }));

  const cells = new Map();
  for (const step of remainingSteps) {
    if (!cells.has(step.backend)) cells.set(step.backend, durationCell(step.backend, backendSamples));
  }
  const pace = livePace(liveLedger, cells, backendSamples);
  const gapBudgetMinutes = interStepGapBudget(remainingSteps, cells);
  const currentStepId = String(liveLedger?.run?.current_step_id ?? '');
  const currentElapsedMinutes = runningStepElapsed(liveSteps.get(currentStepId), now);
  const centerMinutes = remainingSteps.reduce((total, step) => {
    const predicted = cells.get(step.backend).p50Minutes * pace.ratio;
    const remaining = step.id === currentStepId && currentElapsedMinutes != null
      ? Math.max(0, predicted - currentElapsedMinutes)
      : predicted;
    return total + remaining;
  }, gapBudgetMinutes);

  const totals = simulateTotals({
    cells,
    currentElapsedMinutes,
    currentStepId,
    iterations,
    paceRatio: pace.ratio,
    remainingSteps,
    seed,
    gapBudgetMinutes,
  });
  const p50Minutes = roundMinutes(centerMinutes);
  const p90Minutes = Math.max(p50Minutes, roundMinutes(quantile(totals, 0.9)));
  const calibration = calibrationSummary(cells);
  const reworkRisk = reworkRiskFromLedgers(ledgers);
  const reviewSessions = reviewStillNeeded(liveLedger, remainingSteps.length) ? 1 : 0;
  const workerSessions = remainingSteps.length;
  const likelyReworkSessions = reworkRisk.rate == null ? 2 : Math.ceil(reworkRisk.rate * 2);
  const minimumSessions = workerSessions + reviewSessions;

  return {
    duration: {
      lowMinutes: p50Minutes,
      highMinutes: p90Minutes,
      p50Minutes,
      p90Minutes,
      gapBudgetMinutes: roundMinutes(gapBudgetMinutes),
    },
    sessions: {
      low: minimumSessions,
      high: minimumSessions + likelyReworkSessions,
      worker: workerSessions,
      review: reviewSessions,
      likelyRework: likelyReworkSessions,
    },
    reworkRisk,
    remainingSteps: remainingSteps.length,
    sampleSize: calibration.sampleSize,
    personalSampleSize: calibration.personalSampleSize,
    source: calibration.source,
    confidence: calibration.confidence,
    calibration: calibration.backends,
    live: {
      applied: pace.completedSteps > 0,
      completedSteps: pace.completedSteps,
      paceRatio: roundRatio(pace.ratio),
      rawPaceRatio: roundRatio(pace.rawRatio),
      currentStepElapsedMinutes: currentElapsedMinutes,
    },
  };
}

function durationCell(backend, backendSamples) {
  const personal = backendSamples[backend] ?? [];
  const fleet = fleetPriorForBackend(backend);
  if (personal.length >= PERSONAL_DURATION_MIN_SAMPLE) {
    const summary = summarizeDurations(personal);
    return {
      backend,
      source: 'personal',
      sampleSize: summary.sampleSize,
      personalSampleSize: summary.sampleSize,
      p50Minutes: summary.p50Minutes,
      p90Minutes: summary.p90Minutes,
      gapPerStep: fleet.gapPerStep,
      samples: personal,
      fleet,
    };
  }
  return {
    backend,
    source: 'fleet',
    sampleSize: fleet.sample,
    personalSampleSize: personal.length,
    p50Minutes: fleet.p50,
    p90Minutes: fleet.p90,
    gapPerStep: fleet.gapPerStep,
    samples: null,
    fleet,
  };
}

function calibrationSummary(cells) {
  const values = [...cells.values()];
  const personalCells = values.filter((cell) => cell.source === 'personal');
  const source = values.length === 0
    ? 'fleet'
    : personalCells.length === values.length
      ? 'personal'
      : personalCells.length > 0 ? 'personal+fleet' : 'fleet';
  const personalSampleSize = values.reduce((total, cell) => total + cell.personalSampleSize, 0);
  const sampleSize = values.reduce((total, cell) => total + cell.sampleSize, 0);
  const minimumPersonalSample = personalCells.length > 0
    ? Math.min(...personalCells.map((cell) => cell.personalSampleSize))
    : 0;
  const confidence = source !== 'personal'
    ? 'low'
    : minimumPersonalSample >= 20 ? 'high' : 'medium';
  return {
    source,
    confidence,
    sampleSize,
    personalSampleSize,
    backends: values.map((cell) => ({
      backend: cell.backend,
      source: cell.source,
      sampleSize: cell.sampleSize,
      personalSampleSize: cell.personalSampleSize,
      p50Minutes: roundMinutes(cell.p50Minutes),
      p90Minutes: roundMinutes(cell.p90Minutes),
    })),
  };
}

function livePace(liveLedger, cells, backendSamples) {
  let actualMinutes = 0;
  let priorMinutes = 0;
  let completedSteps = 0;
  for (const step of Array.isArray(liveLedger?.steps) ? liveLedger.steps : []) {
    const actual = durationMinutes(step?.started_at, step?.completed_at);
    if (step?.status !== 'completed' || actual == null) continue;
    const backend = normalizeBackend(step.runner)
      || normalizeBackend(liveLedger?.config?.runner)
      || 'unknown';
    const cell = cells.get(backend) ?? durationCell(backend, backendSamples);
    actualMinutes += actual;
    priorMinutes += cell.p50Minutes;
    completedSteps += 1;
  }
  const rawRatio = priorMinutes > 0 ? actualMinutes / priorMinutes : 1;
  return {
    completedSteps,
    rawRatio,
    ratio: completedSteps > 0 ? clamp(rawRatio, 0.5, 3) : 1,
  };
}

function simulateTotals({
  cells,
  currentElapsedMinutes,
  currentStepId,
  iterations,
  paceRatio,
  remainingSteps,
  seed,
  gapBudgetMinutes,
}) {
  if (remainingSteps.length === 0) return [0];
  const count = Number.isInteger(iterations) && iterations > 0 ? iterations : ESTIMATE_MONTE_CARLO_ITERATIONS;
  const random = seededRandom(seed);
  const totals = [];
  for (let iteration = 0; iteration < count; iteration += 1) {
    let total = gapBudgetMinutes;
    for (const step of remainingSteps) {
      const sampled = sampleDuration(cells.get(step.backend), random) * paceRatio;
      total += step.id === currentStepId && currentElapsedMinutes != null
        ? Math.max(0, sampled - currentElapsedMinutes)
        : sampled;
    }
    totals.push(total);
  }
  return totals.sort((a, b) => a - b);
}

function sampleDuration(cell, random) {
  if (cell.samples) return cell.samples[Math.floor(random() * cell.samples.length)];
  const mu = Math.log(cell.p50Minutes);
  const sigma = Math.max(0.01, Math.log(cell.p90Minutes / cell.p50Minutes) / 1.2815515655446004);
  const normal = standardNormal(random);
  return Math.exp(mu + sigma * normal);
}

function interStepGapBudget(steps, cells) {
  let total = 0;
  for (let index = 0; index < steps.length - 1; index += 1) {
    total += cells.get(steps[index].backend).gapPerStep;
  }
  return total;
}

function reworkRiskFromLedgers(ledgers) {
  const reviewed = [];
  for (const ledger of Array.isArray(ledgers) ? ledgers : []) {
    const events = (Array.isArray(ledger?.history) ? ledger.history : [])
      .map((entry) => entry?.event)
      .filter(Boolean);
    if (!events.some((event) => REVIEW_OUTCOME_EVENTS.has(event))) continue;
    const approved = events.includes('final_review_approved') || events.includes('campaign_completed');
    reviewed.push(approved && !events.some((event) => REWORK_EVENTS.has(event)));
  }
  if (reviewed.length === 0) {
    return { rate: null, label: 'unknown', sampleSize: 0, firstTryRate: null };
  }
  const firstTry = reviewed.filter(Boolean).length;
  const rate = 1 - firstTry / reviewed.length;
  return {
    rate: roundRatio(rate),
    label: riskLabel(rate),
    sampleSize: reviewed.length,
    firstTryRate: roundRatio(1 - rate),
  };
}

function isStepRemaining(authored, live) {
  if (live) return !['completed', 'skipped'].includes(live.status);
  return authored?.checked !== true;
}

function reviewStillNeeded(liveLedger, remainingCount) {
  if (remainingCount > 0) return true;
  if (!liveLedger) return remainingCount > 0;
  return !['completed', 'merged', 'force_merged'].includes(liveLedger.run?.status);
}

function runningStepElapsed(step, now) {
  if (step?.status !== 'running') return null;
  return durationMinutes(step.started_at, now);
}

function durationMinutes(startedAt, completedAt) {
  const start = Date.parse(startedAt ?? '');
  const end = Date.parse(completedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / 60_000;
}

function normalizeBackend(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function quantile(sortedValues, probability) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(probability * sortedValues.length) - 1);
  return sortedValues[Math.min(sortedValues.length - 1, index)];
}

function seededRandom(value) {
  let state = 2166136261;
  for (const character of String(value)) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function standardNormal(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function riskLabel(rate) {
  if (rate < 0.25) return 'low';
  if (rate < 0.6) return 'medium';
  return 'high';
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMinutes(value) {
  return Math.max(0, Math.round(value));
}

function roundRatio(value) {
  return Math.round(value * 100) / 100;
}

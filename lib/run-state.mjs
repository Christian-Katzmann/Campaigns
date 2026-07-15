import path from 'node:path';

export const RUN_STATE_VERSION = 6;

export const RUN_STATUSES = Object.freeze([
  'pending',
  'running',
  'blocked',
  'failed',
  'awaiting_review',
  'awaiting_human_review',
  'reviewing',
  'reworking',
  'recovering',
  'cap_reached',
  'stopped_by_user',
  'halted',
  'completed',
  'merged',
  'force_merged',
]);

export const STEP_STATUSES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'stopped',
  'skipped',
]);

export const RUN_EVENT_NAMES = Object.freeze([
  'run_created',
  'run_started',
  'preflight_dirty_worktree',
  'preflight_branch_unavailable',
  'preflight_campaign_invalid',
  'step_started',
  'check_failed',
  'step_completed',
  'step_skipped',
  'step_failed',
  'parallel_group_demoted',
  'parallel_group_started',
  'parallel_step_merged',
  'parallel_group_joined',
  'run_reached_final_review',
  'final_review_started',
  'final_review_reasked',
  'final_review_needs_work',
  'final_fix_started',
  'final_fix_failed',
  'review_unparseable',
  'review_fix_attempts_exhausted',
  'review_merge_failed',
  'final_rework_completed',
  'final_review_approved',
  'final_review_halted',
  'campaign_completed',
  'campaign_merged',
  'force_merged_unreviewed',
  'cap_reached',
  'stopped_by_user',
  'recovery_started',
  'stale_lock_released',
  'step_reset_by_recover',
  'step_continued_by_recover',
  'recovery_completed',
  'recovery_failed',
]);

export const STEP_FAILURE_CODES = Object.freeze([
  'watchdog_stalled',
  'completion_signal_missing',
  'checkout_failed',
  'worker_exit',
  'tool_failure',
  'merge_conflict',
  'branch_creation_failed',
  'environment',
  'unknown',
]);

const REVIEW_STATUSES = new Set([
  'not_started',
  'pending',
  'running',
  'needs_work',
  'awaiting_human',
  'approved',
  'halted',
  'unreviewed',
]);
const RUN_STATUS_SET = new Set(RUN_STATUSES);
const STEP_STATUS_SET = new Set(STEP_STATUSES);
const RUN_EVENT_SET = new Set(RUN_EVENT_NAMES);
const STEP_FAILURE_CODE_SET = new Set(STEP_FAILURE_CODES);
const SUCCESS_TERMINAL_STATUSES = new Set(['completed', 'merged', 'force_merged']);
const PREFLIGHT_EVENTS = new Set([
  'preflight_dirty_worktree',
  'preflight_branch_unavailable',
  'preflight_campaign_invalid',
]);
const EVENT_STATUS_TRANSITIONS = Object.freeze({
  run_created: { from: [null], to: ['pending'] },
  run_started: { from: ['pending', 'blocked'], to: ['running'] },
  preflight_dirty_worktree: { from: ['pending', 'running'], to: ['blocked'] },
  preflight_branch_unavailable: { from: ['pending', 'running'], to: ['blocked'] },
  preflight_campaign_invalid: { from: ['pending', 'running'], to: ['blocked'] },
  step_started: { from: ['running'], to: ['running'] },
  check_failed: {
    from: ['running', 'awaiting_review'],
    to: ['running', 'awaiting_review'],
  },
  step_completed: { from: ['running'], to: ['running', 'failed'] },
  step_skipped: { from: ['running'], to: ['running'] },
  step_failed: { from: ['running'], to: ['running', 'failed'] },
  parallel_group_demoted: { from: ['running'], to: ['running'] },
  parallel_group_started: { from: ['running'], to: ['running'] },
  parallel_step_merged: { from: ['running'], to: ['running'] },
  parallel_group_joined: { from: ['running'], to: ['running'] },
  run_reached_final_review: { from: ['running'], to: ['awaiting_review'] },
  final_review_started: { from: ['awaiting_review'], to: ['reviewing'] },
  final_review_reasked: { from: ['reviewing'], to: ['reviewing'] },
  final_review_needs_work: { from: ['reviewing'], to: ['reworking'] },
  final_fix_started: { from: ['reworking'], to: ['reworking'] },
  final_fix_failed: { from: ['reworking'], to: ['reworking'] },
  review_unparseable: { from: ['reviewing'], to: ['awaiting_human_review'] },
  review_fix_attempts_exhausted: { from: ['reworking'], to: ['awaiting_human_review'] },
  review_merge_failed: {
    from: ['reviewing', 'reworking', 'awaiting_human_review'],
    to: ['awaiting_human_review'],
  },
  final_rework_completed: { from: ['reworking'], to: ['awaiting_review'] },
  final_review_approved: { from: ['reviewing'], to: ['completed'] },
  final_review_halted: {
    from: ['awaiting_review', 'reviewing', 'reworking'],
    to: ['halted'],
  },
  campaign_completed: { from: ['reviewing'], to: ['completed'] },
  campaign_merged: { from: ['completed'], to: ['merged'] },
  force_merged_unreviewed: {
    from: ['awaiting_review', 'awaiting_human_review', 'reviewing', 'reworking', 'halted'],
    to: ['force_merged'],
  },
  cap_reached: {
    from: ['pending', 'running', 'awaiting_review', 'reviewing', 'reworking'],
    to: ['cap_reached'],
  },
  stopped_by_user: {
    from: [
      'pending',
      'running',
      'blocked',
      'failed',
      'awaiting_review',
      'awaiting_human_review',
      'reviewing',
      'reworking',
      'recovering',
    ],
    to: ['stopped_by_user'],
  },
  recovery_started: {
    from: [
      'pending',
      'running',
      'blocked',
      'failed',
      'awaiting_review',
      'halted',
      'cap_reached',
      'stopped_by_user',
    ],
    to: ['recovering'],
  },
  stale_lock_released: { from: ['recovering'], to: ['recovering'] },
  step_reset_by_recover: { from: ['recovering'], to: ['recovering'] },
  step_continued_by_recover: { from: ['recovering'], to: ['running'] },
  recovery_completed: {
    from: ['recovering'],
    to: ['pending', 'running', 'awaiting_review'],
  },
  recovery_failed: { from: ['recovering'], to: ['halted'] },
});

export class RunStateTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunStateTransitionError';
  }
}

export function createRunState({ id, identity, steps, config, artifacts, created_at } = {}) {
  const at = normalizeTimestamp(created_at ?? new Date().toISOString(), 'created_at');
  const state = {
    schema_version: RUN_STATE_VERSION,
    run: {
      id: requireString(id, 'id'),
      status: 'pending',
      created_at: at,
      updated_at: at,
      started_at: null,
      ended_at: null,
      current_step_id: null,
      current_step_ids: [],
      identity: normalizeIdentity(identity),
    },
    config: normalizeConfig(config),
    cursor: {
      step_id: null,
      phase: null,
      attempt: 0,
    },
    steps: normalizeSteps(steps),
    worker: null,
    workers: [],
    review: {
      status: 'not_started',
      attempts: 0,
      verdict: null,
      reasons: [],
      raw_tags: [],
      findings: [],
      review_path: null,
    },
    blockers: [],
    recovery: null,
    artifacts: normalizeArtifacts(artifacts),
    history: [
      {
        sequence: 1,
        at,
        event: 'run_created',
        from_status: null,
        to_status: 'pending',
        step_id: null,
        message: 'Run created.',
        details: {},
      },
    ],
  };

  assertValidRunState(state);
  return state;
}

export function validateRunState(state) {
  const errors = [];
  const add = (message) => errors.push(message);

  if (!isPlainObject(state)) return { valid: false, errors: ['state must be an object'] };
  if (state.schema_version !== RUN_STATE_VERSION) {
    add(`schema_version must be ${RUN_STATE_VERSION}`);
  }

  validateRunRecord(state.run, add);
  validateConfig(state.config, add);
  validateCursor(state.cursor, add);
  validateSteps(state.steps, add);
  validateWorker(state.worker, add);
  validateWorkers(state.workers, add);
  validateReview(state.review, add);
  validateBlockers(state.blockers, add);
  validateRecovery(state.recovery, add);
  validateArtifacts(state.artifacts, add);
  validateHistory(state.history, state.run, add);
  validateCrossFieldInvariants(state, add);

  return { valid: errors.length === 0, errors };
}

export function upgradeRunState(state) {
  if (!isPlainObject(state) || ![1, 2, 3, 4, 5].includes(state.schema_version)) return state;
  const next = structuredClone(state);
  if (next.schema_version === 1) {
    next.config.max_steps_per_run ??= 50;
    next.config.max_run_minutes ??= 360;
    next.config.stop_grace_ms ??= 3_000;
    if (next.run.status === 'stopped') next.run.status = 'stopped_by_user';
    if (next.recovery?.from_status === 'stopped') next.recovery.from_status = 'stopped_by_user';
    for (const entry of next.history ?? []) {
      if (entry.from_status === 'stopped') entry.from_status = 'stopped_by_user';
      if (entry.to_status === 'stopped') entry.to_status = 'stopped_by_user';
    }
    next.schema_version = 2;
  }
  if (next.schema_version === 2) {
    for (const step of next.steps ?? []) {
      step.runner ??= null;
      step.model ??= null;
      step.effort ??= null;
    }
    next.schema_version = 3;
  }
  if (next.schema_version === 3) {
    next.config.worktree_enabled ??= false;
    next.artifacts.worktree ??= null;
    next.schema_version = 4;
  }
  if (next.schema_version === 4) {
    next.config.max_parallel_steps ??= 2;
    next.run.current_step_ids = next.run.current_step_id ? [next.run.current_step_id] : [];
    next.workers = next.run.current_step_id && next.worker
      ? [{ step_id: next.run.current_step_id, ...next.worker }]
      : [];
    for (const step of next.steps ?? []) {
      step.parallel ??= null;
      step.lane ??= null;
    }
    next.artifacts.parallel_worktrees ??= [];
    next.schema_version = 5;
  }
  if (next.schema_version === 5) {
    for (const step of next.steps ?? []) {
      step.commit_range ??= null;
      step.parallel_group ??= null;
    }
    next.review.findings ??= [];
    next.schema_version = 6;
  }
  return next;
}

export function assertValidRunState(state) {
  const result = validateRunState(state);
  if (!result.valid) {
    throw new TypeError(`Invalid run state:\n- ${result.errors.join('\n- ')}`);
  }
  return state;
}

export function transitionRunState(state, input) {
  assertValidRunState(state);
  if (!isPlainObject(input)) throw new RunStateTransitionError('event must be an object');

  const eventName = requireString(input.event, 'event.event');
  if (!RUN_EVENT_SET.has(eventName) || eventName === 'run_created') {
    throw new RunStateTransitionError(`Unsupported transition event: ${eventName}`);
  }

  const next = structuredClone(state);
  const at = normalizeTimestamp(input.at ?? new Date().toISOString(), 'event.at');
  const fromStatus = next.run.status;

  if (SUCCESS_TERMINAL_STATUSES.has(fromStatus) && eventName !== 'campaign_merged') {
    illegal(eventName, fromStatus, 'successful terminal runs cannot be reopened or halted');
  }

  if (eventName === 'run_started') {
    requireRunStatus(next, eventName, ['pending', 'blocked']);
    setRunStatus(next, 'running', at);
    next.run.started_at ??= at;
    next.blockers = [];
  } else if (PREFLIGHT_EVENTS.has(eventName)) {
    requireRunStatus(next, eventName, ['pending', 'running']);
    requireNoRunningStep(next, eventName);
    setRunStatus(next, 'blocked', at);
    next.blockers.push({
      id: `${eventName}:${next.history.length + 1}`,
      event: eventName,
      message: requireString(input.message, `${eventName}.message`),
      created_at: at,
      step_id: stringOrNull(input.step_id),
    });
  } else if (eventName === 'step_started') {
    requireRunStatus(next, eventName, ['running']);
    const step = requireStep(next, input.step_id, eventName, ['pending']);
    step.status = 'running';
    step.attempt += 1;
    step.started_at = at;
    step.completed_at = null;
    step.receipt_path = null;
    step.commit_range = null;
    step.parallel_group = null;
    step.failure = null;
    next.cursor = { step_id: step.id, phase: step.phase, attempt: step.attempt };
    addActiveStep(next, step.id, input.worker, at);
  } else if (eventName === 'check_failed') {
    requireRunStatus(next, eventName, ['running', 'awaiting_review']);
  } else if (eventName === 'step_completed') {
    requireRunStatus(next, eventName, ['running']);
    const step = requireStep(next, input.step_id, eventName, ['running']);
    requireCurrentStep(next, step.id, eventName);
    step.status = 'completed';
    step.completed_at = at;
    step.receipt_path = requireAbsolutePath(input.receipt_path, `${eventName}.receipt_path`);
    if (step.commit_range) {
      throw new RunStateTransitionError(`Step ${step.id} already owns an immutable commit range`);
    }
    step.commit_range = normalizeCommitRange(input.commit_range, `${eventName}.commit_range`);
    step.parallel_group = normalizeCompletedParallelGroup(
      input.parallel_group ?? null,
      `${eventName}.parallel_group`,
    );
    step.runner = input.runner == null
      ? (activeWorker(next, step.id)?.runner ?? next.config.runner)
      : requireString(input.runner, `${eventName}.runner`);
    step.model = input.model == null ? next.config.model : requireString(input.model, `${eventName}.model`);
    step.effort = input.effort == null ? next.config.effort : requireString(input.effort, `${eventName}.effort`);
    step.failure = null;
    clearActiveStep(next, step);
    if (next.workers.length === 0 && next.steps.some((candidate) => candidate.status === 'failed')) {
      setRunStatus(next, 'failed', at);
    }
  } else if (eventName === 'step_skipped') {
    requireRunStatus(next, eventName, ['running']);
    requireNoRunningStep(next, eventName);
    const step = requireStep(next, input.step_id, eventName, ['pending']);
    step.status = 'skipped';
    step.completed_at = at;
    step.failure = null;
    next.cursor = { step_id: step.id, phase: step.phase, attempt: step.attempt };
  } else if (eventName === 'step_failed') {
    requireRunStatus(next, eventName, ['running']);
    const step = requireStep(next, input.step_id, eventName, ['running']);
    requireCurrentStep(next, step.id, eventName);
    step.status = 'failed';
    step.completed_at = null;
    step.failure = normalizeFailure(input.failure);
    clearActiveStep(next, step);
    if (next.workers.length === 0) setRunStatus(next, 'failed', at);
  } else if ([
    'parallel_group_demoted',
    'parallel_group_started',
    'parallel_step_merged',
    'parallel_group_joined',
  ].includes(eventName)) {
    requireRunStatus(next, eventName, ['running']);
  } else if (eventName === 'run_reached_final_review') {
    requireRunStatus(next, eventName, ['running']);
    requireAllStepsDone(next, eventName);
    requireNoRunningStep(next, eventName);
    setRunStatus(next, 'awaiting_review', at);
    next.review.status = 'pending';
  } else if (eventName === 'final_review_started') {
    requireRunStatus(next, eventName, ['awaiting_review']);
    setRunStatus(next, 'reviewing', at);
    next.review.status = 'running';
    next.review.attempts += 1;
    next.review.verdict = null;
    next.review.reasons = [];
    next.review.raw_tags = [];
    next.review.findings = [];
    next.review.review_path = null;
  } else if (eventName === 'final_review_reasked') {
    requireRunStatus(next, eventName, ['reviewing']);
    next.review.attempts += 1;
  } else if (eventName === 'final_review_needs_work') {
    requireRunStatus(next, eventName, ['reviewing']);
    setRunStatus(next, 'reworking', at);
    next.review.status = 'needs_work';
    next.review.verdict = 'NEEDS WORK';
    next.review.reasons = normalizeReasons(input.reasons);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? []);
    next.review.findings = normalizeReviewFindings(input.findings ?? []);
    next.review.review_path = requireAbsolutePath(input.review_path, `${eventName}.review_path`);
  } else if (eventName === 'final_fix_started' || eventName === 'final_fix_failed') {
    requireRunStatus(next, eventName, ['reworking']);
  } else if (eventName === 'review_unparseable') {
    requireRunStatus(next, eventName, ['reviewing']);
    setRunStatus(next, 'awaiting_human_review', at);
    next.review.status = 'awaiting_human';
    next.review.verdict = null;
    next.review.reasons = normalizeReasons(input.reasons ?? []);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? []);
    next.review.findings = normalizeReviewFindings(input.findings ?? []);
    next.review.review_path = requireAbsolutePath(input.review_path, `${eventName}.review_path`);
  } else if (eventName === 'review_fix_attempts_exhausted') {
    requireRunStatus(next, eventName, ['reworking']);
    setRunStatus(next, 'awaiting_human_review', at);
    next.review.status = 'awaiting_human';
  } else if (eventName === 'review_merge_failed') {
    requireRunStatus(next, eventName, ['reviewing', 'reworking', 'awaiting_human_review']);
    setRunStatus(next, 'awaiting_human_review', at);
    next.review.status = 'awaiting_human';
    next.review.verdict = input.verdict == null ? next.review.verdict : requireString(input.verdict, `${eventName}.verdict`);
    next.review.reasons = normalizeReasons(input.reasons ?? next.review.reasons);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? next.review.raw_tags);
    next.review.findings = normalizeReviewFindings(input.findings ?? next.review.findings);
    next.review.review_path = absolutePathOrNull(input.review_path ?? next.review.review_path, `${eventName}.review_path`);
  } else if (eventName === 'final_rework_completed') {
    requireRunStatus(next, eventName, ['reworking']);
    setRunStatus(next, 'awaiting_review', at);
    next.review.status = 'pending';
    next.review.verdict = null;
    next.review.reasons = [];
    next.review.raw_tags = [];
    next.review.findings = [];
  } else if (eventName === 'final_review_approved' || eventName === 'campaign_completed') {
    requireRunStatus(next, eventName, ['reviewing']);
    requireAllStepsDone(next, eventName);
    setRunStatus(next, 'completed', at);
    next.review.status = 'approved';
    next.review.verdict = 'APPROVED';
    next.review.reasons = normalizeReasons(input.reasons ?? []);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? []);
    next.review.findings = normalizeReviewFindings(input.findings ?? []);
    next.review.review_path = requireAbsolutePath(input.review_path, `${eventName}.review_path`);
  } else if (eventName === 'final_review_halted') {
    requireRunStatus(next, eventName, ['awaiting_review', 'reviewing', 'reworking']);
    setRunStatus(next, 'halted', at);
    next.review.status = 'halted';
    next.review.verdict = input.verdict == null ? null : requireString(input.verdict, `${eventName}.verdict`);
    next.review.reasons = normalizeReasons(input.reasons ?? []);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? []);
    next.review.findings = normalizeReviewFindings(input.findings ?? []);
    next.review.review_path = absolutePathOrNull(input.review_path, `${eventName}.review_path`);
  } else if (eventName === 'campaign_merged') {
    requireRunStatus(next, eventName, ['completed']);
    setRunStatus(next, 'merged', at);
  } else if (eventName === 'force_merged_unreviewed') {
    requireRunStatus(next, eventName, [
      'awaiting_review',
      'awaiting_human_review',
      'reviewing',
      'reworking',
      'halted',
    ]);
    if (input.explicit !== true) {
      throw new RunStateTransitionError('force_merged_unreviewed requires explicit: true');
    }
    setRunStatus(next, 'force_merged', at);
    next.review.status = 'unreviewed';
    next.review.verdict = null;
    next.review.reasons = normalizeReasons(input.reasons ?? []);
    next.review.raw_tags = normalizeReasons(input.raw_tags ?? []);
    next.review.findings = normalizeReviewFindings(input.findings ?? []);
  } else if (eventName === 'cap_reached' || eventName === 'stopped_by_user') {
    requireRunStatus(next, eventName, [
      'pending',
      'running',
      'awaiting_review',
      'reviewing',
      'reworking',
      ...(eventName === 'stopped_by_user'
        ? ['blocked', 'failed', 'awaiting_human_review', 'recovering']
        : []),
    ]);
    for (const runningStep of next.steps.filter((step) => step.status === 'running')) {
      runningStep.status = 'stopped';
    }
    clearAllActiveSteps(next);
    next.recovery = null;
    if (['reviewing', 'reworking'].includes(next.run.status)) next.review.status = 'halted';
    setRunStatus(next, eventName, at);
  } else if (eventName === 'recovery_started') {
    requireRunStatus(next, eventName, [
      'pending',
      'running',
      'blocked',
      'failed',
      'awaiting_review',
      'halted',
      'cap_reached',
      'stopped_by_user',
    ]);
    next.recovery = {
      from_status: next.run.status,
      step_id: stringOrNull(Object.hasOwn(input, 'step_id') ? input.step_id : next.cursor.step_id),
      started_at: at,
    };
    setRunStatus(next, 'recovering', at);
  } else if (eventName === 'stale_lock_released') {
    requireRunStatus(next, eventName, ['recovering']);
  } else if (eventName === 'step_reset_by_recover') {
    requireRunStatus(next, eventName, ['recovering']);
    const step = requireStep(next, input.step_id, eventName, ['failed', 'stopped', 'running']);
    step.status = 'pending';
    step.started_at = null;
    step.completed_at = null;
    step.receipt_path = null;
    step.commit_range = null;
    step.parallel_group = null;
    step.failure = null;
    clearAllActiveSteps(next);
    next.cursor = { step_id: step.id, phase: step.phase, attempt: step.attempt };
  } else if (eventName === 'step_continued_by_recover') {
    requireRunStatus(next, eventName, ['recovering']);
    requireNoRunningStep(next, eventName);
    const step = requireStep(next, input.step_id, eventName, ['failed', 'stopped']);
    step.status = 'running';
    step.started_at ??= at;
    step.failure = null;
    next.cursor = { step_id: step.id, phase: step.phase, attempt: step.attempt };
    addActiveStep(next, step.id, input.worker, at);
    next.recovery = null;
    setRunStatus(next, 'running', at);
  } else if (eventName === 'recovery_completed') {
    requireRunStatus(next, eventName, ['recovering']);
    const resumeStatus = requireString(input.resume_status, `${eventName}.resume_status`);
    if (!['pending', 'running', 'awaiting_review'].includes(resumeStatus)) {
      throw new RunStateTransitionError(`recovery_completed cannot resume as ${resumeStatus}`);
    }
    if (resumeStatus === 'awaiting_review') {
      requireAllStepsDone(next, eventName);
      next.review.status = 'pending';
    }
    if (resumeStatus === 'pending' || resumeStatus === 'running') next.blockers = [];
    next.recovery = null;
    setRunStatus(next, resumeStatus, at);
  } else if (eventName === 'recovery_failed') {
    requireRunStatus(next, eventName, ['recovering']);
    next.recovery = null;
    setRunStatus(next, 'halted', at);
  }

  appendHistory(next, input, eventName, fromStatus, next.run.status, at);
  assertValidRunState(next);
  return next;
}

function normalizeIdentity(identity) {
  if (!isPlainObject(identity)) throw new TypeError('identity must be an object');
  if (!Object.hasOwn(identity, 'registry_id')) {
    throw new TypeError('identity.registry_id must be present (use null when unknown)');
  }
  const source = normalizeLocation(identity.source, 'identity.source', false);
  const execution = normalizeLocation(identity.execution, 'identity.execution', true);
  return {
    registry_id: stringOrNull(identity.registry_id),
    source,
    execution,
  };
}

function normalizeLocation(location, label, includeBranch) {
  if (!isPlainObject(location)) throw new TypeError(`${label} must be an object`);
  const result = {
    campaign_path: requireAbsolutePath(location.campaign_path, `${label}.campaign_path`),
    repo_root: requireAbsolutePath(location.repo_root, `${label}.repo_root`),
  };
  if (includeBranch) {
    result.branch = requireString(location.branch, `${label}.branch`);
    if (location.merge_target_branch != null) {
      result.merge_target_branch = requireString(location.merge_target_branch, `${label}.merge_target_branch`);
      result.merge_target_repo_root = requireAbsolutePath(
        location.merge_target_repo_root,
        `${label}.merge_target_repo_root`,
      );
    }
  }
  return result;
}

function normalizeConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('config must be an object');
  if (!isPlainObject(config.watchdog)) throw new TypeError('config.watchdog must be an object');
  return {
    runner: requireString(config.runner, 'config.runner'),
    model: stringOrNull(config.model),
    effort: stringOrNull(config.effort),
    watchdog: {
      minimum_runtime_ms: requireNonNegativeInteger(
        config.watchdog.minimum_runtime_ms,
        'config.watchdog.minimum_runtime_ms',
      ),
      stall_window_ms: requirePositiveInteger(
        config.watchdog.stall_window_ms,
        'config.watchdog.stall_window_ms',
      ),
    },
    max_fix_attempts: config.max_fix_attempts == null
      ? 2
      : requirePositiveInteger(config.max_fix_attempts, 'config.max_fix_attempts'),
    force_merge_unreviewed: config.force_merge_unreviewed === true,
    max_steps_per_run: config.max_steps_per_run == null
      ? 50
      : requirePositiveInteger(config.max_steps_per_run, 'config.max_steps_per_run'),
    max_run_minutes: config.max_run_minutes == null
      ? 360
      : requirePositiveNumber(config.max_run_minutes, 'config.max_run_minutes'),
    stop_grace_ms: config.stop_grace_ms == null
      ? 3_000
      : requirePositiveInteger(config.stop_grace_ms, 'config.stop_grace_ms'),
    max_parallel_steps: config.max_parallel_steps == null
      ? 2
      : requirePositiveInteger(config.max_parallel_steps, 'config.max_parallel_steps'),
    worktree_enabled: config.worktree_enabled === true,
  };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) throw new TypeError('steps must be an array');
  const seen = new Set();
  return steps.map((step, index) => {
    if (!isPlainObject(step)) throw new TypeError(`steps[${index}] must be an object`);
    const id = requireString(step.id, `steps[${index}].id`);
    if (seen.has(id)) throw new TypeError(`duplicate step id: ${id}`);
    seen.add(id);
    return {
      id,
      name: requireString(step.name, `steps[${index}].name`),
      phase: stringOrNull(step.phase),
      status: 'pending',
      attempt: 0,
      started_at: null,
      completed_at: null,
      receipt_path: null,
      commit_range: null,
      parallel_group: null,
      runner: null,
      model: null,
      effort: null,
      failure: null,
      parallel: normalizeParallel(step.parallel),
      lane: normalizeLane(step.lane),
    };
  });
}

function normalizeArtifacts(artifacts) {
  if (!isPlainObject(artifacts)) throw new TypeError('artifacts must be an object');
  return {
    run_dir: requireAbsolutePath(artifacts.run_dir, 'artifacts.run_dir'),
    receipts_dir: requireAbsolutePath(artifacts.receipts_dir, 'artifacts.receipts_dir'),
    final_review_path: absolutePathOrNull(artifacts.final_review_path, 'artifacts.final_review_path'),
    worktree: normalizeWorktree(artifacts.worktree),
    parallel_worktrees: normalizeParallelWorktrees(artifacts.parallel_worktrees ?? []),
  };
}

function normalizeParallel(parallel) {
  if (parallel == null) return null;
  if (!isPlainObject(parallel)) throw new TypeError('step.parallel must be null or an object');
  const isParallel = parallel.is_parallel ?? parallel.isParallel;
  const siblingSteps = parallel.sibling_steps ?? parallel.siblingSteps ?? [];
  if (typeof isParallel !== 'boolean') throw new TypeError('step.parallel.is_parallel must be a boolean');
  if (!Array.isArray(siblingSteps) || siblingSteps.some((id) => !nonEmptyString(id))) {
    throw new TypeError('step.parallel.sibling_steps must be an array of step ids');
  }
  return { is_parallel: isParallel, sibling_steps: [...new Set(siblingSteps)] };
}

function normalizeLane(lane) {
  if (lane == null) return null;
  if (!isPlainObject(lane)) throw new TypeError('step.lane must be null or an object');
  if (!Array.isArray(lane.globs) || lane.globs.length === 0 || lane.globs.some((glob) => !nonEmptyString(glob))) {
    throw new TypeError('step.lane.globs must be a non-empty array of path globs');
  }
  return { globs: [...new Set(lane.globs.map((glob) => glob.trim()))] };
}

function normalizeParallelWorktrees(worktrees) {
  if (!Array.isArray(worktrees)) throw new TypeError('artifacts.parallel_worktrees must be an array');
  return worktrees.map((worktree, index) => {
    if (!isPlainObject(worktree)) throw new TypeError(`artifacts.parallel_worktrees[${index}] must be an object`);
    return {
      step_id: requireString(worktree.step_id, `artifacts.parallel_worktrees[${index}].step_id`),
      path: requireAbsolutePath(worktree.path, `artifacts.parallel_worktrees[${index}].path`),
      branch: requireString(worktree.branch, `artifacts.parallel_worktrees[${index}].branch`),
      base_sha: requireString(worktree.base_sha, `artifacts.parallel_worktrees[${index}].base_sha`),
      created_at: normalizeTimestamp(worktree.created_at, `artifacts.parallel_worktrees[${index}].created_at`),
      merged_at: worktree.merged_at == null
        ? null
        : normalizeTimestamp(worktree.merged_at, `artifacts.parallel_worktrees[${index}].merged_at`),
      pruned_at: worktree.pruned_at == null
        ? null
        : normalizeTimestamp(worktree.pruned_at, `artifacts.parallel_worktrees[${index}].pruned_at`),
    };
  });
}

function normalizeWorktree(worktree) {
  if (worktree == null) return null;
  if (!isPlainObject(worktree)) throw new TypeError('artifacts.worktree must be null or an object');
  return {
    path: requireAbsolutePath(worktree.path, 'artifacts.worktree.path'),
    branch: requireString(worktree.branch, 'artifacts.worktree.branch'),
    base_branch: requireString(worktree.base_branch, 'artifacts.worktree.base_branch'),
    created_at: normalizeTimestamp(worktree.created_at, 'artifacts.worktree.created_at'),
    cleanup_deadline: worktree.cleanup_deadline == null
      ? null
      : normalizeTimestamp(worktree.cleanup_deadline, 'artifacts.worktree.cleanup_deadline'),
    pruned_at: worktree.pruned_at == null
      ? null
      : normalizeTimestamp(worktree.pruned_at, 'artifacts.worktree.pruned_at'),
  };
}

function normalizeWorker(worker, defaultRunner, at) {
  if (!isPlainObject(worker)) throw new RunStateTransitionError('worker must be an object');
  return {
    runner: worker.runner == null ? defaultRunner : requireString(worker.runner, 'worker.runner'),
    invocation_id: requireString(worker.invocation_id, 'worker.invocation_id'),
    pid: worker.pid == null ? null : requirePositiveInteger(worker.pid, 'worker.pid'),
    started_at: normalizeTimestamp(worker.started_at ?? at, 'worker.started_at'),
    last_activity_at: normalizeTimestamp(worker.last_activity_at ?? at, 'worker.last_activity_at'),
    log_path: absolutePathOrNull(worker.log_path, 'worker.log_path'),
    live_output_path: absolutePathOrNull(worker.live_output_path, 'worker.live_output_path'),
  };
}

function normalizeFailure(failure) {
  if (!isPlainObject(failure)) throw new RunStateTransitionError('step_failed requires failure');
  const code = requireString(failure.code, 'failure.code');
  if (!STEP_FAILURE_CODE_SET.has(code)) {
    throw new RunStateTransitionError(`Unknown step failure code: ${code}`);
  }
  return {
    code,
    message: requireString(failure.message, 'failure.message'),
    retryable: failure.retryable === true,
    output_tail: failure.output_tail == null ? null : String(failure.output_tail),
  };
}

function normalizeReasons(reasons) {
  if (!Array.isArray(reasons)) throw new RunStateTransitionError('reasons must be an array');
  return reasons.map((reason, index) => requireString(reason, `reasons[${index}]`));
}

function normalizeCommitRange(range, label) {
  if (!isPlainObject(range)) throw new RunStateTransitionError(`${label} must be an object`);
  const baseOid = requireGitOid(range.base_oid, `${label}.base_oid`);
  const headOid = requireGitOid(range.head_oid, `${label}.head_oid`);
  return { base_oid: baseOid, head_oid: headOid };
}

function normalizeCompletedParallelGroup(group, label) {
  if (group == null) return null;
  if (!isPlainObject(group)) throw new RunStateTransitionError(`${label} must be null or an object`);
  if (!Array.isArray(group.step_ids) || group.step_ids.length < 2) {
    throw new RunStateTransitionError(`${label}.step_ids must contain at least two step ids`);
  }
  return {
    id: requireString(group.id, `${label}.id`),
    step_ids: [...new Set(group.step_ids.map((id, index) => (
      requireString(id, `${label}.step_ids[${index}]`)
    )))],
  };
}

function normalizeReviewFindings(findings) {
  if (!Array.isArray(findings)) throw new RunStateTransitionError('findings must be an array');
  return findings.map((finding, index) => {
    if (!isPlainObject(finding)) {
      throw new RunStateTransitionError(`findings[${index}] must be an object`);
    }
    if (!Array.isArray(finding.paths) || finding.paths.length === 0) {
      throw new RunStateTransitionError(`findings[${index}].paths must be a non-empty array`);
    }
    return {
      reason: requireString(finding.reason, `findings[${index}].reason`),
      paths: [...new Set(finding.paths.map((filePath, pathIndex) => (
        requireRepoRelativePath(filePath, `findings[${index}].paths[${pathIndex}]`)
      )))],
    };
  });
}

function appendHistory(state, input, event, fromStatus, toStatus, at) {
  const details = isPlainObject(input.details) ? structuredClone(input.details) : {};
  if (event === 'step_failed') details.failure = structuredClone(input.failure);
  if (event === 'step_completed') {
    const step = state.steps.find((candidate) => candidate.id === input.step_id);
    details.receipt_path = input.receipt_path;
    details.runner = input.runner ?? step?.runner ?? state.config.runner;
    details.model = input.model ?? step?.model ?? state.config.model;
    details.effort = input.effort ?? step?.effort ?? state.config.effort;
    details.commit_range = structuredClone(step?.commit_range ?? null);
    details.parallel_group = structuredClone(step?.parallel_group ?? null);
  }
  if (event === 'force_merged_unreviewed') details.explicit = true;
  if (event === 'final_fix_started' || event === 'final_fix_failed') {
    details.attempt = requirePositiveInteger(input.attempt, `${event}.attempt`);
    if (event === 'final_fix_failed') details.reason = requireString(input.reason, `${event}.reason`);
    if (input.log_path != null) details.log_path = requireAbsolutePath(input.log_path, `${event}.log_path`);
  }
  if (event === 'final_rework_completed') {
    details.attempt = requirePositiveInteger(input.attempt, `${event}.attempt`);
    details.commit_sha = requireString(input.commit_sha, `${event}.commit_sha`);
  }
  if (event === 'review_fix_attempts_exhausted') {
    details.attempts = requirePositiveInteger(input.attempts, `${event}.attempts`);
  }
  if (event === 'review_merge_failed') details.error = requireString(input.error, `${event}.error`);
  if ([
    'final_review_needs_work',
    'final_review_approved',
    'campaign_completed',
    'final_review_halted',
    'review_unparseable',
  ].includes(event)) {
    details.verdict = input.verdict ?? (
      ['final_review_approved', 'campaign_completed'].includes(event) ? 'APPROVED' : null
    );
    details.reasons = normalizeReasons(input.reasons ?? []);
    details.raw_tags = normalizeReasons(input.raw_tags ?? []);
    details.findings = normalizeReviewFindings(input.findings ?? []);
    details.review_path = input.review_path ?? null;
  }
  if (event === 'final_review_reasked') details.issue = input.issue ?? null;
  state.run.updated_at = at;
  state.history.push({
    sequence: state.history.length + 1,
    at,
    event,
    from_status: fromStatus,
    to_status: toStatus,
    step_id: stringOrNull(input.step_id),
    message: input.message == null ? null : requireString(input.message, 'event.message'),
    details,
  });
}

function setRunStatus(state, status, at) {
  state.run.status = status;
  state.run.ended_at = SUCCESS_TERMINAL_STATUSES.has(status) ? at : null;
}

function clearActiveStep(state, step) {
  state.workers = state.workers.filter((worker) => worker.step_id !== step.id);
  state.run.current_step_ids = state.run.current_step_ids.filter((id) => id !== step.id);
  syncLegacyActiveStep(state);
  state.cursor = { step_id: step.id, phase: step.phase, attempt: step.attempt };
}

function addActiveStep(state, stepId, worker, at) {
  const normalized = normalizeWorker(worker, state.config.runner, at);
  state.run.current_step_ids.push(stepId);
  state.workers.push({ step_id: stepId, ...normalized });
  syncLegacyActiveStep(state);
}

function activeWorker(state, stepId) {
  return state.workers.find((worker) => worker.step_id === stepId) ?? null;
}

function clearAllActiveSteps(state) {
  state.workers = [];
  state.run.current_step_ids = [];
  syncLegacyActiveStep(state);
}

function syncLegacyActiveStep(state) {
  state.run.current_step_id = state.run.current_step_ids[0] ?? null;
  const current = state.workers.find((worker) => worker.step_id === state.run.current_step_id) ?? null;
  if (!current) {
    state.worker = null;
    return;
  }
  const { step_id: _stepId, ...legacyWorker } = current;
  state.worker = legacyWorker;
}

function requireStep(state, stepId, event, allowedStatuses) {
  const id = requireString(stepId, `${event}.step_id`);
  const step = state.steps.find((candidate) => candidate.id === id);
  if (!step) throw new RunStateTransitionError(`${event}: unknown step ${id}`);
  if (!allowedStatuses.includes(step.status)) {
    throw new RunStateTransitionError(
      `${event}: step ${id} is ${step.status}; expected ${allowedStatuses.join(' or ')}`,
    );
  }
  return step;
}

function requireRunStatus(state, event, statuses) {
  if (!statuses.includes(state.run.status)) illegal(event, state.run.status, `expected ${statuses.join(' or ')}`);
}

function requireCurrentStep(state, stepId, event) {
  if (!state.run.current_step_ids.includes(stepId)) {
    throw new RunStateTransitionError(`${event}: ${stepId} is not the active step`);
  }
}

function requireNoRunningStep(state, event) {
  if (state.steps.some((step) => step.status === 'running')) {
    throw new RunStateTransitionError(`${event}: another step is already running`);
  }
}

function requireAllStepsDone(state, event) {
  const unfinished = state.steps.filter((step) => !['completed', 'skipped'].includes(step.status));
  if (unfinished.length > 0) {
    throw new RunStateTransitionError(
      `${event}: unfinished steps: ${unfinished.map((step) => step.id).join(', ')}`,
    );
  }
}

function illegal(event, status, reason) {
  throw new RunStateTransitionError(`${event} is illegal while run is ${status}: ${reason}`);
}

function validateRunRecord(run, add) {
  if (!isPlainObject(run)) return add('run must be an object');
  if (!nonEmptyString(run.id)) add('run.id must be a non-empty string');
  if (!RUN_STATUS_SET.has(run.status)) add(`run.status is invalid: ${run.status}`);
  validateTimestamp(run.created_at, 'run.created_at', add);
  validateTimestamp(run.updated_at, 'run.updated_at', add);
  validateNullableTimestamp(run.started_at, 'run.started_at', add);
  validateNullableTimestamp(run.ended_at, 'run.ended_at', add);
  if (!(run.current_step_id == null || nonEmptyString(run.current_step_id))) {
    add('run.current_step_id must be null or a non-empty string');
  }
  if (!Array.isArray(run.current_step_ids) || run.current_step_ids.some((id) => !nonEmptyString(id))) {
    add('run.current_step_ids must be an array of step ids');
  } else if (new Set(run.current_step_ids).size !== run.current_step_ids.length) {
    add('run.current_step_ids must not contain duplicates');
  }
  validateIdentity(run.identity, add);
}

function validateIdentity(identity, add) {
  if (!isPlainObject(identity)) return add('run.identity must be an object');
  if (!Object.hasOwn(identity, 'registry_id')) add('run.identity.registry_id must be present');
  if (!(identity.registry_id == null || nonEmptyString(identity.registry_id))) {
    add('run.identity.registry_id must be null or a non-empty string');
  }
  validateLocation(identity.source, 'run.identity.source', false, add);
  validateLocation(identity.execution, 'run.identity.execution', true, add);
}

function validateLocation(location, label, includeBranch, add) {
  if (!isPlainObject(location)) return add(`${label} must be an object`);
  validateAbsolutePath(location.campaign_path, `${label}.campaign_path`, add);
  validateAbsolutePath(location.repo_root, `${label}.repo_root`, add);
  if (includeBranch && !nonEmptyString(location.branch)) add(`${label}.branch must be a non-empty string`);
  if (includeBranch && location.merge_target_branch != null) {
    if (!nonEmptyString(location.merge_target_branch)) add(`${label}.merge_target_branch must be a non-empty string`);
    validateAbsolutePath(location.merge_target_repo_root, `${label}.merge_target_repo_root`, add);
  }
}

function validateConfig(config, add) {
  if (!isPlainObject(config)) return add('config must be an object');
  if (!nonEmptyString(config.runner)) add('config.runner must be a non-empty string');
  if (!(config.model == null || nonEmptyString(config.model))) add('config.model must be null or a string');
  if (!(config.effort == null || nonEmptyString(config.effort))) add('config.effort must be null or a string');
  if (!isPlainObject(config.watchdog)) return add('config.watchdog must be an object');
  if (!nonNegativeInteger(config.watchdog.minimum_runtime_ms)) {
    add('config.watchdog.minimum_runtime_ms must be a non-negative integer');
  }
  if (!positiveInteger(config.watchdog.stall_window_ms)) {
    add('config.watchdog.stall_window_ms must be a positive integer');
  }
  if (config.max_fix_attempts != null && !positiveInteger(config.max_fix_attempts)) {
    add('config.max_fix_attempts must be a positive integer');
  }
  if (config.force_merge_unreviewed != null && typeof config.force_merge_unreviewed !== 'boolean') {
    add('config.force_merge_unreviewed must be a boolean');
  }
  if (!positiveInteger(config.max_steps_per_run)) {
    add('config.max_steps_per_run must be a positive integer');
  }
  if (!positiveNumber(config.max_run_minutes)) {
    add('config.max_run_minutes must be a positive number');
  }
  if (!positiveInteger(config.stop_grace_ms)) {
    add('config.stop_grace_ms must be a positive integer');
  }
  if (!positiveInteger(config.max_parallel_steps)) {
    add('config.max_parallel_steps must be a positive integer');
  }
  if (typeof config.worktree_enabled !== 'boolean') {
    add('config.worktree_enabled must be a boolean');
  }
}

function validateCursor(cursor, add) {
  if (!isPlainObject(cursor)) return add('cursor must be an object');
  if (!(cursor.step_id == null || nonEmptyString(cursor.step_id))) add('cursor.step_id must be null or a string');
  if (!(cursor.phase == null || nonEmptyString(cursor.phase))) add('cursor.phase must be null or a string');
  if (!nonNegativeInteger(cursor.attempt)) add('cursor.attempt must be a non-negative integer');
}

function validateSteps(steps, add) {
  if (!Array.isArray(steps)) return add('steps must be an array');
  const ids = new Set();
  for (const [index, step] of steps.entries()) {
    const label = `steps[${index}]`;
    if (!isPlainObject(step)) {
      add(`${label} must be an object`);
      continue;
    }
    if (!nonEmptyString(step.id)) add(`${label}.id must be a non-empty string`);
    else if (ids.has(step.id)) add(`duplicate step id: ${step.id}`);
    else ids.add(step.id);
    if (!nonEmptyString(step.name)) add(`${label}.name must be a non-empty string`);
    if (!(step.phase == null || nonEmptyString(step.phase))) add(`${label}.phase must be null or a string`);
    if (!STEP_STATUS_SET.has(step.status)) add(`${label}.status is invalid: ${step.status}`);
    if (!nonNegativeInteger(step.attempt)) add(`${label}.attempt must be a non-negative integer`);
    validateNullableTimestamp(step.started_at, `${label}.started_at`, add);
    validateNullableTimestamp(step.completed_at, `${label}.completed_at`, add);
    validateNullableAbsolutePath(step.receipt_path, `${label}.receipt_path`, add);
    validateCommitRange(step.commit_range, `${label}.commit_range`, add);
    validateCompletedParallelGroup(step.parallel_group, `${label}.parallel_group`, add);
    if (!(step.runner == null || nonEmptyString(step.runner))) add(`${label}.runner must be null or a string`);
    if (!(step.model == null || nonEmptyString(step.model))) add(`${label}.model must be null or a string`);
    if (!(step.effort == null || nonEmptyString(step.effort))) add(`${label}.effort must be null or a string`);
    if (!(step.failure == null || isValidFailure(step.failure))) add(`${label}.failure is invalid`);
    validateParallel(step.parallel, `${label}.parallel`, add);
    validateLane(step.lane, `${label}.lane`, add);
  }
}

function validateParallel(parallel, label, add) {
  if (parallel == null) return;
  if (!isPlainObject(parallel)) return add(`${label} must be null or an object`);
  if (typeof parallel.is_parallel !== 'boolean') add(`${label}.is_parallel must be a boolean`);
  if (!Array.isArray(parallel.sibling_steps) || parallel.sibling_steps.some((id) => !nonEmptyString(id))) {
    add(`${label}.sibling_steps must be an array of step ids`);
  }
}

function validateCommitRange(range, label, add) {
  if (range == null) return;
  if (!isPlainObject(range)) return add(`${label} must be null or an object`);
  if (!isGitOid(range.base_oid)) add(`${label}.base_oid must be a Git object id`);
  if (!isGitOid(range.head_oid)) add(`${label}.head_oid must be a Git object id`);
}

function validateCompletedParallelGroup(group, label, add) {
  if (group == null) return;
  if (!isPlainObject(group)) return add(`${label} must be null or an object`);
  if (!nonEmptyString(group.id)) add(`${label}.id must be a non-empty string`);
  if (!Array.isArray(group.step_ids) || group.step_ids.length < 2 || group.step_ids.some((id) => !nonEmptyString(id))) {
    add(`${label}.step_ids must contain at least two step ids`);
  }
}

function validateLane(lane, label, add) {
  if (lane == null) return;
  if (!isPlainObject(lane)) return add(`${label} must be null or an object`);
  if (!Array.isArray(lane.globs) || lane.globs.length === 0 || lane.globs.some((glob) => !nonEmptyString(glob))) {
    add(`${label}.globs must be a non-empty array of path globs`);
  }
}

function validateWorker(worker, add) {
  if (worker == null) return;
  if (!isPlainObject(worker)) return add('worker must be null or an object');
  if (!nonEmptyString(worker.runner)) add('worker.runner must be a non-empty string');
  if (!nonEmptyString(worker.invocation_id)) add('worker.invocation_id must be a non-empty string');
  if (!(worker.pid == null || positiveInteger(worker.pid))) add('worker.pid must be null or a positive integer');
  validateTimestamp(worker.started_at, 'worker.started_at', add);
  validateTimestamp(worker.last_activity_at, 'worker.last_activity_at', add);
  validateNullableAbsolutePath(worker.log_path, 'worker.log_path', add);
  validateNullableAbsolutePath(worker.live_output_path, 'worker.live_output_path', add);
}

function validateWorkers(workers, add) {
  if (!Array.isArray(workers)) return add('workers must be an array');
  const stepIds = new Set();
  for (const [index, worker] of workers.entries()) {
    const label = `workers[${index}]`;
    if (!isPlainObject(worker)) {
      add(`${label} must be an object`);
      continue;
    }
    if (!nonEmptyString(worker.step_id)) add(`${label}.step_id must be a non-empty string`);
    else if (stepIds.has(worker.step_id)) add(`duplicate worker step id: ${worker.step_id}`);
    else stepIds.add(worker.step_id);
    validateWorker(worker, add);
  }
}

function validateReview(review, add) {
  if (!isPlainObject(review)) return add('review must be an object');
  if (!REVIEW_STATUSES.has(review.status)) add(`review.status is invalid: ${review.status}`);
  if (!nonNegativeInteger(review.attempts)) add('review.attempts must be a non-negative integer');
  if (!(review.verdict == null || nonEmptyString(review.verdict))) add('review.verdict must be null or a string');
  if (!Array.isArray(review.reasons) || review.reasons.some((reason) => !nonEmptyString(reason))) {
    add('review.reasons must be an array of non-empty strings');
  }
  if (!(review.raw_tags == null || (
    Array.isArray(review.raw_tags) && review.raw_tags.every((tag) => nonEmptyString(tag))
  ))) {
    add('review.raw_tags must be an array of non-empty strings');
  }
  if (!Array.isArray(review.findings)) {
    add('review.findings must be an array');
  } else {
    for (const [index, finding] of review.findings.entries()) {
      if (!isPlainObject(finding) || !nonEmptyString(finding.reason)) {
        add(`review.findings[${index}] must carry a reason`);
        continue;
      }
      if (!Array.isArray(finding.paths) || finding.paths.length === 0 || finding.paths.some((filePath) => !isRepoRelativePath(filePath))) {
        add(`review.findings[${index}].paths must be a non-empty string array`);
      }
    }
  }
  validateNullableAbsolutePath(review.review_path, 'review.review_path', add);
}

function validateBlockers(blockers, add) {
  if (!Array.isArray(blockers)) return add('blockers must be an array');
  for (const [index, blocker] of blockers.entries()) {
    const label = `blockers[${index}]`;
    if (!isPlainObject(blocker)) {
      add(`${label} must be an object`);
      continue;
    }
    if (!nonEmptyString(blocker.id)) add(`${label}.id must be a string`);
    if (!PREFLIGHT_EVENTS.has(blocker.event)) add(`${label}.event is invalid`);
    if (!nonEmptyString(blocker.message)) add(`${label}.message must be a string`);
    validateTimestamp(blocker.created_at, `${label}.created_at`, add);
    if (!(blocker.step_id == null || nonEmptyString(blocker.step_id))) add(`${label}.step_id is invalid`);
  }
}

function validateRecovery(recovery, add) {
  if (recovery == null) return;
  if (!isPlainObject(recovery)) return add('recovery must be null or an object');
  if (![
    'pending',
    'running',
    'blocked',
    'failed',
    'awaiting_review',
    'halted',
    'cap_reached',
    'stopped_by_user',
  ].includes(recovery.from_status)) {
    add('recovery.from_status is invalid');
  }
  if (!(recovery.step_id == null || nonEmptyString(recovery.step_id))) add('recovery.step_id is invalid');
  validateTimestamp(recovery.started_at, 'recovery.started_at', add);
}

function validateArtifacts(artifacts, add) {
  if (!isPlainObject(artifacts)) return add('artifacts must be an object');
  validateAbsolutePath(artifacts.run_dir, 'artifacts.run_dir', add);
  validateAbsolutePath(artifacts.receipts_dir, 'artifacts.receipts_dir', add);
  validateNullableAbsolutePath(artifacts.final_review_path, 'artifacts.final_review_path', add);
  validateWorktree(artifacts.worktree, add);
  validateParallelWorktrees(artifacts.parallel_worktrees, add);
}

function validateParallelWorktrees(worktrees, add) {
  if (!Array.isArray(worktrees)) return add('artifacts.parallel_worktrees must be an array');
  for (const [index, worktree] of worktrees.entries()) {
    const label = `artifacts.parallel_worktrees[${index}]`;
    if (!isPlainObject(worktree)) {
      add(`${label} must be an object`);
      continue;
    }
    if (!nonEmptyString(worktree.step_id)) add(`${label}.step_id must be a non-empty string`);
    validateAbsolutePath(worktree.path, `${label}.path`, add);
    if (!nonEmptyString(worktree.branch)) add(`${label}.branch must be a non-empty string`);
    if (!nonEmptyString(worktree.base_sha)) add(`${label}.base_sha must be a non-empty string`);
    validateTimestamp(worktree.created_at, `${label}.created_at`, add);
    validateNullableTimestamp(worktree.merged_at, `${label}.merged_at`, add);
    validateNullableTimestamp(worktree.pruned_at, `${label}.pruned_at`, add);
  }
}

function validateWorktree(worktree, add) {
  if (worktree == null) return;
  if (!isPlainObject(worktree)) return add('artifacts.worktree must be null or an object');
  validateAbsolutePath(worktree.path, 'artifacts.worktree.path', add);
  if (!nonEmptyString(worktree.branch)) add('artifacts.worktree.branch must be a non-empty string');
  if (!nonEmptyString(worktree.base_branch)) add('artifacts.worktree.base_branch must be a non-empty string');
  validateTimestamp(worktree.created_at, 'artifacts.worktree.created_at', add);
  validateNullableTimestamp(worktree.cleanup_deadline, 'artifacts.worktree.cleanup_deadline', add);
  validateNullableTimestamp(worktree.pruned_at, 'artifacts.worktree.pruned_at', add);
}

function validateHistory(history, run, add) {
  if (!Array.isArray(history) || history.length === 0) return add('history must be a non-empty array');
  let previousStatus = null;
  let successfulTerminalSeen = false;
  for (const [index, entry] of history.entries()) {
    const label = `history[${index}]`;
    if (!isPlainObject(entry)) {
      add(`${label} must be an object`);
      continue;
    }
    if (entry.sequence !== index + 1) add(`${label}.sequence must be ${index + 1}`);
    validateTimestamp(entry.at, `${label}.at`, add);
    if (!RUN_EVENT_SET.has(entry.event)) add(`${label}.event is invalid: ${entry.event}`);
    if (!(entry.from_status == null || RUN_STATUS_SET.has(entry.from_status))) add(`${label}.from_status is invalid`);
    if (!RUN_STATUS_SET.has(entry.to_status)) add(`${label}.to_status is invalid`);
    if (entry.from_status !== previousStatus) add(`${label}.from_status does not continue the state chain`);
    if (!(entry.step_id == null || nonEmptyString(entry.step_id))) add(`${label}.step_id is invalid`);
    if (!(entry.message == null || nonEmptyString(entry.message))) add(`${label}.message is invalid`);
    if (!isPlainObject(entry.details)) add(`${label}.details must be an object`);

    const transition = EVENT_STATUS_TRANSITIONS[entry.event];
    if (transition && !transition.from.includes(entry.from_status)) {
      add(`${label}.${entry.event} cannot start from ${entry.from_status}`);
    }
    if (transition && !transition.to.includes(entry.to_status)) {
      add(`${label}.${entry.event} cannot end at ${entry.to_status}`);
    }

    if (successfulTerminalSeen && !SUCCESS_TERMINAL_STATUSES.has(entry.to_status)) {
      add(`${label} leaves a successful terminal state for ${entry.to_status}`);
    }
    if (SUCCESS_TERMINAL_STATUSES.has(entry.to_status)) successfulTerminalSeen = true;
    previousStatus = entry.to_status;
  }
  if (isPlainObject(run) && previousStatus !== run.status) {
    add(`history ends at ${previousStatus}, but run.status is ${run.status}`);
  }
}

function validateCrossFieldInvariants(state, add) {
  if (!isPlainObject(state.run) || !Array.isArray(state.steps)) return;
  const runningSteps = state.steps.filter((step) => step?.status === 'running');
  const runningIds = runningSteps.map((step) => step.id);
  if (
    state.run.current_step_ids.length !== runningIds.length
    || runningIds.some((id) => !state.run.current_step_ids.includes(id))
  ) {
    add('run.current_step_ids must identify all running steps');
  }
  if (state.run.current_step_id !== (state.run.current_step_ids[0] ?? null)) {
    add('run.current_step_id must mirror the first active step');
  }
  if (state.workers.length !== runningSteps.length) add('each running step requires worker metadata');
  for (const id of runningIds) {
    if (!state.workers.some((worker) => worker.step_id === id)) add(`running step ${id} requires worker metadata`);
  }
  if (state.worker == null && state.workers.length > 0) add('worker must mirror the first active worker');
  if (state.worker != null && state.workers.length === 0) add('legacy worker metadata requires an active worker');
  if (state.worker && state.workers[0]?.invocation_id !== state.worker.invocation_id) {
    add('worker must mirror the first active worker');
  }
  for (const step of state.steps) {
    if (step?.status === 'completed' && (!step.completed_at || !step.receipt_path)) {
      add(`completed step ${step.id} requires completed_at and receipt_path`);
    }
    if (step?.parallel_group && !step.parallel_group.step_ids.includes(step.id)) {
      add(`parallel group for Step ${step.id} must include that step`);
    }
    if (step?.status === 'failed' && !step.failure) add(`failed step ${step.id} requires failure`);
  }
  if (SUCCESS_TERMINAL_STATUSES.has(state.run.status) && !state.run.ended_at) {
    add(`successful terminal status ${state.run.status} requires run.ended_at`);
  }
  if (!SUCCESS_TERMINAL_STATUSES.has(state.run.status) && state.run.ended_at != null) {
    add(`non-terminal status ${state.run.status} cannot have run.ended_at`);
  }
  if ([
    'awaiting_review',
    'awaiting_human_review',
    'reviewing',
    'reworking',
    'completed',
    'merged',
    'force_merged',
  ].includes(state.run.status)) {
    const unfinished = state.steps.filter((step) => !['completed', 'skipped'].includes(step.status));
    if (unfinished.length > 0) add(`${state.run.status} run has unfinished steps`);
  }
  if (state.run.status === 'awaiting_review' && state.review?.status !== 'pending') {
    add('awaiting_review requires review.status=pending');
  }
  if (state.run.status === 'reviewing' && state.review?.status !== 'running') {
    add('reviewing requires review.status=running');
  }
  if (state.run.status === 'awaiting_human_review' && state.review?.status !== 'awaiting_human') {
    add('awaiting_human_review requires review.status=awaiting_human');
  }
  if (state.run.status === 'reworking' && state.review?.status !== 'needs_work') {
    add('reworking requires review.status=needs_work');
  }
  if (['completed', 'merged'].includes(state.run.status) && state.review?.status !== 'approved') {
    add(`${state.run.status} requires an approved review`);
  }
  if (state.run.status === 'force_merged' && state.review?.status !== 'unreviewed') {
    add('force_merged requires review.status=unreviewed');
  }
  if (state.run.status === 'recovering' && state.recovery == null) add('recovering requires recovery metadata');
  if (state.run.status !== 'recovering' && state.recovery != null) add('recovery metadata requires recovering status');
}

function isValidFailure(failure) {
  return (
    isPlainObject(failure) &&
    STEP_FAILURE_CODE_SET.has(failure.code) &&
    nonEmptyString(failure.message) &&
    typeof failure.retryable === 'boolean' &&
    (failure.output_tail == null || typeof failure.output_tail === 'string')
  );
}

function requireString(value, label) {
  if (!nonEmptyString(value)) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireGitOid(value, label) {
  if (!isGitOid(value)) throw new TypeError(`${label} must be a 40- or 64-character Git object id`);
  return value.toLowerCase();
}

function requireRepoRelativePath(value, label) {
  if (!isRepoRelativePath(value)) throw new TypeError(`${label} must be a canonical repo-relative path`);
  return value;
}

function requireAbsolutePath(value, label) {
  if (!nonEmptyString(value) || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function absolutePathOrNull(value, label) {
  return value == null ? null : requireAbsolutePath(value, label);
}

function requireNonNegativeInteger(value, label) {
  if (!nonNegativeInteger(value)) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function requirePositiveNumber(value, label) {
  if (!positiveNumber(value)) throw new TypeError(`${label} must be a positive number`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!positiveInteger(value)) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function normalizeTimestamp(value, label) {
  if (!isTimestamp(value)) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  return new Date(value).toISOString();
}

function stringOrNull(value) {
  if (value == null) return null;
  return requireString(value, 'value');
}

function validateTimestamp(value, label, add) {
  if (!isTimestamp(value)) add(`${label} must be an ISO-8601 timestamp`);
}

function validateNullableTimestamp(value, label, add) {
  if (!(value == null || isTimestamp(value))) add(`${label} must be null or an ISO-8601 timestamp`);
}

function validateAbsolutePath(value, label, add) {
  if (!nonEmptyString(value) || !path.isAbsolute(value)) add(`${label} must be an absolute path`);
}

function validateNullableAbsolutePath(value, label, add) {
  if (!(value == null || (nonEmptyString(value) && path.isAbsolute(value)))) {
    add(`${label} must be null or an absolute path`);
  }
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isGitOid(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isRepoRelativePath(value) {
  if (!nonEmptyString(value) || value.includes('\\') || value.includes('\0')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..')
    && path.posix.normalize(value) === value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

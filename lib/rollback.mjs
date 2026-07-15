import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  defaultCampaignsRunsDir,
  parseCampaignPlan,
  runPathsForCampaign,
} from './pump.mjs';
import { writeRedactedFile } from './redaction.mjs';
import { transitionRunState } from './run-state.mjs';
import { persistRunState, readRunState } from './run-state-store.mjs';
import { writeFileAtomic } from './registry.mjs';
import { CHECK_LINE_REGEX } from '../public/lib/parser.mjs';

const execFileAsync = promisify(execFile);

export class RollbackError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RollbackError';
    Object.assign(this, details);
  }
}

export class RollbackConflictError extends RollbackError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'RollbackConflictError';
  }
}

export async function rollbackCampaign(campaignFile, options = {}) {
  const env = options.env ?? process.env;
  const campaignPath = await canonicalExistingPath(campaignFile);
  const runsDir = path.resolve(options.runsDir ?? defaultCampaignsRunsDir(env));
  const paths = runPathsForCampaign(campaignPath, runsDir);
  let state = await readState(paths.statePath);
  const requestedStepId = requiredStepId(options.to);
  const existingLock = await readLock(paths.lockPath);
  await assertRollbackCanAcquireLock(state, existingLock, paths.lockPath);
  const lock = await acquireRollbackLock(paths.lockPath, campaignPath);

  try {
    state = await readState(paths.statePath);
    assertNoLiveWorker(state);

    if (state.run.status === 'rollback_conflict') {
      assertSameRollbackTarget(state, requestedStepId);
      await cleanupTemporaryRollback(state);
      state = transitionRunState(state, {
        event: 'rollback_resumed',
        message: `Retrying rollback to Step ${requestedStepId}.`,
      });
      await persistState(paths.statePath, state);
    } else if (state.run.status === 'rolling_back') {
      assertSameRollbackTarget(state, requestedStepId);
    } else {
      await assertRollbackEligible(state);
      const transaction = await planRollback(state, requestedStepId, paths);
      state = transitionRunState(state, {
        event: 'rollback_started',
        step_id: transaction.boundary_step_id,
        rollback: transaction,
        message: `Started rollback to Step ${requestedStepId}.`,
        details: {
          reset_steps: transaction.step_ids,
          parallel_boundary: transaction.boundary_step_id !== requestedStepId,
        },
      });
      await persistState(paths.statePath, state);
      injectFailure(options, 'intent', paths.statePath);
    }

    if (state.rollback.status === 'intent') {
      const publishedHead = await executeGitRollback(state, paths.statePath);
      state = await readState(paths.statePath);
      injectFailure(options, 'git', paths.statePath);
      state = transitionRunState(state, {
        event: 'rollback_git_completed',
        step_id: state.rollback.boundary_step_id,
        published_head: publishedHead,
        message: `Published rollback Git history for Step ${requestedStepId}.`,
      });
      await persistState(paths.statePath, state);
    }

    if (state.rollback.status === 'git_completed') {
      const markdownCommitOid = await applyMarkdownRollback(state, campaignPath);
      if (markdownCommitOid && state.rollback.markdown_commit_oid !== markdownCommitOid) {
        state.rollback.markdown_commit_oid = markdownCommitOid;
        state.rollback.published_head = markdownCommitOid;
        state = transitionRunState(state, {
          event: 'rollback_progress',
          step_id: state.rollback.boundary_step_id,
          rollback: state.rollback,
          message: 'Recorded the rollback progress commit.',
        });
        await persistState(paths.statePath, state);
      }
      injectFailure(options, 'markdown', paths.statePath);
      state = transitionRunState(state, {
        event: 'rollback_markdown_completed',
        step_id: state.rollback.boundary_step_id,
        markdown_commit_oid: markdownCommitOid,
        message: `Unchecked steps after ${state.rollback.boundary_step_id}.`,
      });
      await persistState(paths.statePath, state);
    }

    const receiptPath = state.rollback.receipt_path;
    await writeRollbackReceipt(receiptPath, state);
    const transaction = structuredClone(state.rollback);
    state = transitionRunState(state, {
      event: 'rollback_completed',
      step_id: transaction.boundary_step_id,
      receipt_path: receiptPath,
      message: `Rolled back to Step ${transaction.boundary_step_id}; the pump will resume with the next step.`,
      details: {
        reset_steps: transaction.step_ids,
        published_head: transaction.published_head,
      },
    });
    await persistState(paths.statePath, state);

    return {
      ok: true,
      message: transaction.boundary_step_id === requestedStepId
        ? `Rolled back to Step ${requestedStepId}.`
        : `Step ${requestedStepId} is parallel; retained its whole group through Step ${transaction.boundary_step_id}.`,
      campaignPath,
      statePath: paths.statePath,
      receiptPath,
      to: requestedStepId,
      boundary: transaction.boundary_step_id,
      resetSteps: transaction.step_ids,
      state,
    };
  } finally {
    await releaseRollbackLock(paths.lockPath, lock.token);
  }
}

async function planRollback(state, requestedStepId, paths) {
  const targetIndex = state.steps.findIndex((step) => step.id === requestedStepId);
  if (targetIndex < 0) throw new RollbackError(`Unknown rollback step: ${requestedStepId}.`);
  const target = state.steps[targetIndex];
  if (!['completed', 'skipped'].includes(target.status)) {
    throw new RollbackError(`Step ${requestedStepId} is ${target.status}; rollback targets must be completed.`);
  }

  let boundaryIndex = targetIndex;
  if (target.parallel_group) {
    boundaryIndex = Math.max(...target.parallel_group.step_ids.map((stepId) => {
      const index = state.steps.findIndex((step) => step.id === stepId);
      if (index < 0) throw new RollbackError(`Parallel rollback group references missing Step ${stepId}.`);
      return index;
    }));
  }
  const resetSteps = state.steps.slice(boundaryIndex + 1)
    .filter((step) => ['completed', 'skipped'].includes(step.status));
  if (resetSteps.length === 0) {
    throw new RollbackError(`Nothing follows Step ${state.steps[boundaryIndex].id}; no rollback is needed.`);
  }

  const sourceRepoRoot = state.run.identity.source.repo_root;
  const executionBranch = state.run.identity.execution.branch;
  const startOid = await gitOid(sourceRepoRoot, `refs/heads/${executionBranch}`, {
    missingMessage: `Execution branch ${executionBranch} no longer exists. Start a new campaign instead.`,
  });
  await assertNotMergedToDefault(state, startOid);
  await assertExecutionWorktreeClean(state);
  const operations = await buildRollbackOperations(state, resetSteps, startOid);
  const id = randomUUID();
  const suffix = id.replace(/-/g, '').slice(0, 12);
  const runSuffix = state.run.id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  const now = new Date().toISOString();

  return {
    id,
    status: 'intent',
    source_status: state.run.status,
    to_step_id: requestedStepId,
    boundary_step_id: state.steps[boundaryIndex].id,
    step_ids: resetSteps.map((step) => step.id),
    start_oid: startOid,
    published_head: null,
    execution_branch: executionBranch,
    worktree_path: state.artifacts.worktree?.path ?? state.run.identity.execution.repo_root,
    temporary_branch: `campaigns/rollback-${runSuffix}-${suffix}`,
    temporary_worktree_path: path.join(paths.runDir, `rollback-${suffix}`),
    operations,
    started_at: now,
    updated_at: now,
    markdown_commit_oid: null,
    receipt_path: path.join(paths.receiptsDir, `rollback-${suffix}.md`),
    completed_at: null,
    conflict: null,
  };
}

async function buildRollbackOperations(state, resetSteps, startOid) {
  const sourceRepoRoot = state.run.identity.source.repo_root;
  const resetIds = new Set(resetSteps.map((step) => step.id));
  const handledGroups = new Set();
  const units = [];

  for (const step of resetSteps) {
    if (step.status !== 'completed') continue;
    if (!step.commit_range) throw new RollbackError(`Step ${step.id} has no committed range to roll back.`);
    const group = step.parallel_group;
    if (!group) {
      units.push({ kind: 'step', steps: [step], order: state.steps.indexOf(step) });
      continue;
    }
    if (handledGroups.has(group.id)) continue;
    const members = group.step_ids.map((stepId) => state.steps.find((candidate) => candidate.id === stepId));
    if (members.some((member) => !member || !resetIds.has(member.id) || member.status !== 'completed')) {
      throw new RollbackError(`Parallel group ${group.id} cannot be rolled back partially.`);
    }
    handledGroups.add(group.id);
    units.push({
      kind: 'parallel_group',
      steps: members,
      groupId: group.id,
      order: Math.max(...members.map((member) => state.steps.indexOf(member))),
    });
  }

  const operations = [];
  for (const unit of units.sort((left, right) => right.order - left.order)) {
    const ranges = unit.steps.map((step) => ({ step_id: step.id, ...step.commit_range }));
    const commits = unit.kind === 'parallel_group'
      ? await parallelRevertCommits(sourceRepoRoot, startOid, ranges)
      : await rangeRevertCommits(sourceRepoRoot, ranges[0]);
    operations.push({
      id: unit.kind === 'parallel_group' ? `parallel:${unit.groupId}` : `step:${unit.steps[0].id}`,
      kind: unit.kind,
      step_ids: unit.steps.map((step) => step.id),
      ranges,
      commits,
    });
  }
  return operations;
}

async function rangeRevertCommits(repoRoot, range) {
  const oids = await gitLines(repoRoot, ['rev-list', '--topo-order', range.head_oid, `^${range.base_oid}`]);
  if (oids.length === 0) throw new RollbackError(`Step ${range.step_id} has an empty Git range.`);
  return Promise.all(oids.map(async (oid) => ({
    oid,
    mainline: (await commitParents(repoRoot, oid)).length > 1 ? 1 : null,
    revert_oid: null,
  })));
}

async function parallelRevertCommits(repoRoot, startOid, ranges) {
  const bases = new Set(ranges.map((range) => range.base_oid));
  if (bases.size !== 1) throw new RollbackError('Parallel rollback ranges do not share one base commit.');
  const [baseOid] = bases;
  const mergeOids = await gitLines(repoRoot, ['rev-list', '--merges', '--topo-order', startOid, `^${baseOid}`]);
  const mergeParents = new Map(await Promise.all(mergeOids.map(async (oid) => [oid, await commitParents(repoRoot, oid)])));
  const matchedHeads = new Set();
  const commits = [];

  for (const mergeOid of mergeOids) {
    const parents = mergeParents.get(mergeOid);
    const matchingRange = ranges.find((range) => parents.slice(1).includes(range.head_oid));
    if (!matchingRange) continue;
    matchedHeads.add(matchingRange.head_oid);
    commits.push({ oid: mergeOid, mainline: 1, revert_oid: null });
  }

  const fastForwardRanges = ranges.filter((range) => !matchedHeads.has(range.head_oid));
  if (fastForwardRanges.length !== 1) {
    throw new RollbackError('Could not identify the single fast-forward member of the parallel merge group.');
  }
  commits.push(...await rangeRevertCommits(repoRoot, fastForwardRanges[0]));
  return commits;
}

async function executeGitRollback(initialState, statePath) {
  let state = initialState;
  const transaction = state.rollback;
  const repoRoot = state.run.identity.source.repo_root;
  const executionRef = `refs/heads/${transaction.execution_branch}`;
  const currentExecutionHead = await gitOid(repoRoot, executionRef);
  const markersOnExecution = await rollbackMarkers(repoRoot, transaction.execution_branch, transaction);

  if (markersOnExecution.complete) {
    state = recordMarkerOids(state, markersOnExecution.markers);
    await cleanupTemporaryRollback(state);
    await syncExecutionWorktree(state, currentExecutionHead);
    await persistState(statePath, state);
    return currentExecutionHead;
  }
  if (currentExecutionHead !== transaction.start_oid) {
    throw new RollbackError(`Execution branch ${transaction.execution_branch} moved after rollback intent; no changes were made.`);
  }

  const tempRoot = await prepareTemporaryRollbackWorktree(state);
  try {
    const existingMarkers = await rollbackMarkers(repoRoot, transaction.temporary_branch, transaction);
    state = recordMarkerOids(state, existingMarkers.markers);
    if (existingMarkers.markers.size > 0) await persistState(statePath, state);

    for (const operation of state.rollback.operations) {
      for (const commit of operation.commits) {
        if (commit.revert_oid) continue;
        const marker = rollbackMarker(state.rollback.id, operation.id, commit.oid);
        const args = ['revert'];
        if (commit.mainline) args.push('-m', String(commit.mainline));
        args.push('--no-commit', commit.oid);
        const reverted = await gitResult(tempRoot, args);
        if (!reverted.ok) {
          await gitResult(tempRoot, ['revert', '--abort']);
          const conflict = {
            operation_id: operation.id,
            commit_oid: commit.oid,
            message: reverted.error,
          };
          state = transitionRunState(state, {
            event: 'rollback_conflicted',
            step_id: state.rollback.boundary_step_id,
            conflict,
            message: `Rollback conflicted while reverting ${commit.oid.slice(0, 12)}.`,
          });
          await persistState(statePath, state);
          await cleanupTemporaryRollback(state);
          throw new RollbackConflictError(
            `Rollback conflict at ${commit.oid.slice(0, 12)}. The execution branch and campaign markdown were left unchanged; retry after resolving the underlying conflict.`,
            { statePath, conflict },
          );
        }
        const committed = await gitResult(tempRoot, [
          '-c', 'commit.gpgSign=false', 'commit', '-m', marker,
        ]);
        if (!committed.ok) throw new RollbackError(`Could not record rollback commit: ${committed.error}`);
        commit.revert_oid = await gitOid(tempRoot, 'HEAD');
        state = transitionRunState(state, {
          event: 'rollback_progress',
          step_id: state.rollback.boundary_step_id,
          rollback: state.rollback,
          message: `Reverted ${commit.oid.slice(0, 12)} for ${operation.id}.`,
        });
        await persistState(statePath, state);
      }
    }

    const publishedHead = await gitOid(tempRoot, 'HEAD');
    const executionWorktree = (await listWorktrees(repoRoot))
      .find((worktree) => worktree.branch === transaction.execution_branch);
    const published = executionWorktree
      ? await gitResult(executionWorktree.path, ['merge', '--ff-only', transaction.temporary_branch])
      : await gitResult(repoRoot, ['update-ref', executionRef, publishedHead, transaction.start_oid]);
    if (!published.ok) throw new RollbackError(`Could not publish rollback history: ${published.error}`);
    await cleanupTemporaryRollback(state);
    await syncExecutionWorktree(state, publishedHead);
    await persistState(statePath, state);
    return publishedHead;
  } catch (error) {
    if (!(error instanceof RollbackConflictError)) await cleanupTemporaryRollback(state).catch(() => {});
    throw error;
  }
}

async function applyMarkdownRollback(state, campaignPath) {
  const markdown = await readFile(campaignPath, 'utf8');
  const plan = parseCampaignPlan(markdown);
  const resetIds = new Set(state.rollback.step_ids);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let changed = false;
  for (const step of plan.steps) {
    if (!resetIds.has(step.id) || !step.checked) continue;
    const match = lines[step.checklistLine]?.match(CHECK_LINE_REGEX);
    if (!match) throw new RollbackError(`Could not uncheck Step ${step.id}.`);
    lines[step.checklistLine] = `${match[1]} ${match[3]}${match[4]}`;
    changed = true;
  }
  if (changed) await writeFileAtomic(campaignPath, lines.join('\n'));
  if (state.config.worktree_enabled) return null;
  return commitMarkdownRollback(state, campaignPath);
}

async function commitMarkdownRollback(state, campaignPath) {
  const repoRoot = state.run.identity.source.repo_root;
  const marker = `Campaigns rollback ${state.rollback.id}: reset campaign checkboxes`;
  const existing = await findCommitBySubject(repoRoot, state.rollback.execution_branch, marker);
  if (existing) return existing;
  const relative = path.relative(await realpath(repoRoot), await realpath(campaignPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RollbackError('Campaign markdown resolves outside the execution repository.');
  }
  const status = await gitResult(repoRoot, ['status', '--short', '--', relative]);
  if (!status.ok) throw new RollbackError(`Could not inspect campaign markdown: ${status.error}`);
  if (!status.stdout.trim()) return null;
  const added = await gitResult(repoRoot, ['add', '--', relative]);
  if (!added.ok) throw new RollbackError(`Could not stage campaign rollback: ${added.error}`);
  const committed = await gitResult(repoRoot, [
    '-c', 'commit.gpgSign=false', 'commit', '-m', marker, '--', relative,
  ]);
  if (!committed.ok) throw new RollbackError(`Could not commit campaign rollback: ${committed.error}`);
  return gitOid(repoRoot, 'HEAD');
}

async function writeRollbackReceipt(receiptPath, state) {
  const transaction = state.rollback;
  const originalCommits = transaction.operations.flatMap((operation) => operation.commits.map((commit) => commit.oid));
  const revertCommits = transaction.operations.flatMap((operation) => operation.commits.map((commit) => commit.revert_oid).filter(Boolean));
  const createdCommits = [...revertCommits, transaction.markdown_commit_oid].filter(Boolean);
  const undoOrder = [...createdCommits].reverse();
  const rangeLines = transaction.operations.flatMap((operation) => operation.ranges.map((range) => (
    `- Step ${range.step_id}: \`${range.base_oid}..${range.head_oid}\``
  )));
  const body = [
    '# Campaign rollback receipt',
    '',
    `- Transaction: \`${transaction.id}\``,
    `- Requested boundary: Step ${transaction.to_step_id}`,
    `- Effective boundary: Step ${transaction.boundary_step_id}`,
    `- Reset steps: ${transaction.step_ids.map((id) => `Step ${id}`).join(', ')}`,
    `- Execution branch: \`${transaction.execution_branch}\``,
    `- Published head: \`${transaction.published_head}\``,
    '',
    '## Reverted ranges',
    '',
    ...(rangeLines.length ? rangeLines : ['- No committed ranges; only source checkboxes were reset.']),
    '',
    '## Original commits',
    '',
    ...(originalCommits.length ? originalCommits.map((oid) => `- \`${oid}\``) : ['- None.']),
    '',
    '## Created rollback commits',
    '',
    ...(createdCommits.length ? createdCommits.map((oid) => `- \`${oid}\``) : ['- None.']),
    '',
    '## Undo this rollback',
    '',
    undoOrder.length
      ? `Run on the execution branch: \`git revert --no-edit ${undoOrder.join(' ')}\``
      : 'Re-check the reset campaign steps; no Git revert commits were created.',
    '',
  ].join('\n');
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeRedactedFile(receiptPath, body);
}

async function assertRollbackEligible(state) {
  if (['merged', 'force_merged'].includes(state.run.status)) {
    throw new RollbackError('This campaign result is already merged to the default branch. Start a new campaign instead.');
  }
  if (['reviewing', 'reworking', 'recovering'].includes(state.run.status)) {
    throw new RollbackError(`Campaign run is ${state.run.status}. Stop or recover it before rolling back.`);
  }
  if (state.steps.some((step) => step.status === 'running')) {
    throw new RollbackError('A campaign step is still running. Stop the campaign before rolling back.');
  }
}

async function assertNotMergedToDefault(state, executionHead) {
  const execution = state.run.identity.execution;
  const target = execution.merge_target_branch;
  if (!target) return;
  if (target === execution.branch) {
    throw new RollbackError(`The run executed directly on ${target}. Start a new campaign instead of rolling back default-branch history.`);
  }
  const repoRoot = execution.merge_target_repo_root ?? state.run.identity.source.repo_root;
  const targetExists = await gitResult(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
  if (!targetExists.ok) return;
  const merged = await gitResult(repoRoot, ['merge-base', '--is-ancestor', executionHead, `refs/heads/${target}`]);
  if (merged.ok) {
    throw new RollbackError(`This campaign result is already merged to ${target}. Start a new campaign instead.`);
  }
}

async function assertExecutionWorktreeClean(state) {
  const repoRoot = state.run.identity.source.repo_root;
  const worktrees = await listWorktrees(repoRoot);
  const registered = worktrees.find((worktree) => worktree.branch === state.run.identity.execution.branch);
  if (!registered) return;
  const status = await gitResult(registered.path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok) throw new RollbackError(`Could not inspect the execution worktree: ${status.error}`);
  if (status.stdout.trim()) {
    throw new RollbackError('The execution worktree has uncommitted changes. Commit or clear them before rolling back.');
  }
}

async function syncExecutionWorktree(state, headOid) {
  const repoRoot = state.run.identity.source.repo_root;
  const branch = state.rollback.execution_branch;
  const worktrees = await listWorktrees(repoRoot);
  const registered = worktrees.find((worktree) => worktree.branch === branch);
  let worktreePath = registered?.path ?? null;
  if (registered) {
    const worktreeHead = await gitOid(registered.path, 'HEAD');
    if (worktreeHead !== headOid) {
      throw new RollbackError(`Execution worktree did not advance to ${headOid.slice(0, 12)}.`);
    }
  } else if (state.config.worktree_enabled && state.artifacts.worktree) {
    worktreePath = state.artifacts.worktree.path;
    if (await pathExists(worktreePath)) {
      throw new RollbackError(`Execution worktree path exists but is not registered: ${worktreePath}`);
    }
    const restored = await gitResult(repoRoot, ['worktree', 'add', worktreePath, branch]);
    if (!restored.ok) throw new RollbackError(`Could not restore the execution worktree: ${restored.error}`);
  }
  if (state.artifacts.worktree && worktreePath) {
    state.artifacts.worktree.pruned_at = null;
    state.artifacts.worktree.cleanup_deadline = null;
    state.run.identity.execution.repo_root = await realpath(worktreePath);
  }
}

async function prepareTemporaryRollbackWorktree(state) {
  const transaction = state.rollback;
  const repoRoot = state.run.identity.source.repo_root;
  const worktrees = await listWorktrees(repoRoot);
  const existing = worktrees.find((worktree) => worktree.branch === transaction.temporary_branch);
  if (existing) {
    const status = await gitResult(existing.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.ok || status.stdout.trim()) {
      throw new RollbackError(`Temporary rollback worktree is not clean: ${existing.path}`);
    }
    return existing.path;
  }
  if (await pathExists(transaction.temporary_worktree_path)) {
    throw new RollbackError(`Temporary rollback path exists but is not registered: ${transaction.temporary_worktree_path}`);
  }
  const branchExists = await gitResult(repoRoot, [
    'show-ref', '--verify', '--quiet', `refs/heads/${transaction.temporary_branch}`,
  ]);
  const args = branchExists.ok
    ? ['worktree', 'add', transaction.temporary_worktree_path, transaction.temporary_branch]
    : ['worktree', 'add', '-b', transaction.temporary_branch, transaction.temporary_worktree_path, transaction.start_oid];
  const added = await gitResult(repoRoot, args);
  if (!added.ok) throw new RollbackError(`Could not create rollback worktree: ${added.error}`);
  return transaction.temporary_worktree_path;
}

async function cleanupTemporaryRollback(state) {
  const transaction = state.rollback;
  if (!transaction) return;
  const repoRoot = state.run.identity.source.repo_root;
  const worktrees = await listWorktrees(repoRoot);
  const registered = worktrees.find((worktree) => worktree.branch === transaction.temporary_branch);
  if (registered) await gitResult(repoRoot, ['worktree', 'remove', '--force', registered.path]);
  await gitResult(repoRoot, ['worktree', 'prune']);
  await gitResult(repoRoot, ['branch', '-D', transaction.temporary_branch]);
  await rm(transaction.temporary_worktree_path, { recursive: true, force: true });
}

function recordMarkerOids(state, markers) {
  for (const operation of state.rollback.operations) {
    for (const commit of operation.commits) {
      const marker = rollbackMarker(state.rollback.id, operation.id, commit.oid);
      commit.revert_oid = markers.get(marker) ?? commit.revert_oid;
    }
  }
  return state;
}

async function rollbackMarkers(repoRoot, ref, transaction) {
  const markers = new Map();
  const subjects = await gitLogSubjects(repoRoot, ref);
  for (const [oid, subject] of subjects) markers.set(subject, oid);
  const expected = transaction.operations.flatMap((operation) => operation.commits.map((commit) => (
    rollbackMarker(transaction.id, operation.id, commit.oid)
  )));
  return { markers, complete: expected.every((marker) => markers.has(marker)) };
}

function rollbackMarker(transactionId, operationId, commitOid) {
  return `Campaigns rollback ${transactionId} ${operationId}: revert ${commitOid}`;
}

async function findCommitBySubject(repoRoot, ref, subject) {
  const match = (await gitLogSubjects(repoRoot, ref)).find(([, candidate]) => candidate === subject);
  return match?.[0] ?? null;
}

async function gitLogSubjects(repoRoot, ref) {
  const result = await gitResult(repoRoot, ['log', ref, '--format=%H%x09%s']);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return [line.slice(0, tab), line.slice(tab + 1)];
  });
}

async function commitParents(repoRoot, oid) {
  const line = (await gitLines(repoRoot, ['rev-list', '--parents', '-n', '1', oid]))[0] ?? '';
  return line.split(/\s+/).slice(1);
}

async function listWorktrees(repoRoot) {
  const result = await gitResult(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!result.ok) throw new RollbackError(`Could not list Git worktrees: ${result.error}`);
  return result.stdout.trim().split(/\n\n+/).filter(Boolean).map((record) => {
    const lines = record.split('\n');
    return {
      path: lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? '',
      branch: lines.find((line) => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null,
    };
  });
}

async function readState(statePath) {
  try {
    return await readRunState(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new RollbackError(`No run ledger found: ${statePath}`);
    if (error instanceof SyntaxError) throw new RollbackError(`Run ledger is not valid JSON: ${statePath}`);
    if (error instanceof TypeError) throw new RollbackError(error.message);
    throw error;
  }
}

async function persistState(statePath, state) {
  await persistRunState(statePath, state);
}

async function assertRollbackCanAcquireLock(state, lock, lockPath) {
  const livePid = [
    lock?.pid,
    ...(state.workers ?? []).map((worker) => worker?.pid),
    state.worker?.pid,
  ].find((pid) => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid));
  if (livePid) throw new RollbackError(`Campaign run is still live (pid ${livePid}). Stop it before rolling back.`);
  if (!lock) return;
  if (lock.operation === 'rollback' && state.rollback) {
    await rm(lockPath, { force: true });
    return;
  }
  throw new RollbackError('A run lock still exists. Stop or recover the campaign before rolling back.');
}

function assertNoLiveWorker(state) {
  const pid = [
    ...(state.workers ?? []).map((worker) => worker?.pid),
    state.worker?.pid,
  ].find((candidate) => Number.isInteger(candidate) && candidate > 0 && isProcessAlive(candidate));
  if (pid) throw new RollbackError(`Campaign worker ${pid} is still running. Stop it before rolling back.`);
}

async function acquireRollbackLock(lockPath, campaignPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const data = {
    version: 1,
    token,
    pid: process.pid,
    campaign_path: campaignPath,
    started_at: new Date().toISOString(),
    operation: 'rollback',
  };
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.close();
    return data;
  } catch (error) {
    if (error.code === 'EEXIST') throw new RollbackError('The campaign became active before rollback could start. Stop it first.');
    throw error;
  }
}

async function releaseRollbackLock(lockPath, token) {
  const lock = await readLock(lockPath);
  if (lock?.token === token) await rm(lockPath, { force: true });
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function assertSameRollbackTarget(state, requestedStepId) {
  if (state.rollback?.to_step_id !== requestedStepId) {
    throw new RollbackError(`Rollback ${state.rollback?.id ?? ''} already targets Step ${state.rollback?.to_step_id}; retry that same target.`);
  }
}

function requiredStepId(value) {
  const stepId = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)+$/.test(stepId)) throw new RollbackError('--to must name a step such as 2.1.');
  return stepId;
}

function injectFailure(options, point, statePath) {
  if (options.failAfter === point) {
    throw new RollbackError(`Injected rollback interruption after ${point}.`, { statePath, injected: point });
  }
}

async function canonicalExistingPath(candidate) {
  try {
    return await realpath(path.resolve(candidate));
  } catch {
    throw new RollbackError(`Campaign file does not exist: ${path.resolve(candidate)}`);
  }
}

async function gitOid(repoRoot, ref, { missingMessage } = {}) {
  const result = await gitResult(repoRoot, ['rev-parse', '--verify', ref]);
  if (!result.ok) throw new RollbackError(missingMessage ?? result.error);
  return result.stdout.trim().toLowerCase();
}

async function gitLines(repoRoot, args) {
  const result = await gitResult(repoRoot, args);
  if (!result.ok) throw new RollbackError(result.error);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function gitResult(repoRoot, args) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, error: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      error: String(error.stderr ?? '').trim() || String(error.stdout ?? '').trim() || error.message,
    };
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

# 0004 - Unified Runner-Neutral Run State

## Status

Accepted.

## Context

The two existing automation engines record the same campaign in incompatible
ledgers. The Claude-side ledger centers `status/steps/history/finalize`; the
Codex-side ledger centers `phase/cursor/automations/blockers`. The board has to
guess which ledger belongs to a campaign from paths, and the lessons layer can
only partially read half the corpus.

The July 2026 learning-loop audit also found 25 runs whose history contained a
successful terminal event (`campaign_completed`, an approved final review, or
`force_merged_unreviewed`) while the stored status remained `halted`. That is a
state-machine failure, not a display problem.

## Decision

Use the versioned shape and pure transition function in `lib/run-state.mjs` for
every runner. Runner names are values in `config.runner` and `worker.runner`;
there are no runner-specific fields.

Schema version 2 adds the `cap_reached` and `stopped_by_user` lifecycle states
plus the run-cap and stop-grace config snapshot.

Schema version 4 adds the worktree-mode config snapshot and persisted execution
worktree metadata: path, branch, campaign base branch, creation time, optional
human-review cleanup deadline, and prune time. Older ledgers upgrade as direct
mode with no worktree metadata.

Schema version 8 adds the configured reviewer snapshot plus the selected
reviewer runner, family, and ladder tier. Version 7 ledgers migrate as
same-family review because that was the only previous behavior.

The current structural contract is published at
`schema/run-state.schema.json`. All ledger readers use the same upgrade,
validation, and atomic persistence path. A redacted `events.jsonl` beside the
ledger projects `history` into the documented observability envelope without
introducing a second state authority.

The campaign markdown remains the progress source of truth. The run state is an
execution ledger: it records attempts, worker activity, review/recovery state,
and evidence paths without becoming a second campaign plan.

### Identity

Every ledger stores:

- a unique run id;
- a nullable registry id, present as `null` when unknown;
- the source campaign path and source repository root registered with the board;
- the execution campaign path, execution repository root, and branch.

Source and execution locations are separate because a run may execute in a
worktree while the board still points at the source checkout. Matching order is
registry id, exact source path, then exact execution identity. New-engine
providers must not infer identity from a run-directory slug.

### Ledger shape

`createRunState()` produces these top-level records:

| Record | Purpose |
|---|---|
| `run` | Identity, lifecycle status, timestamps, and current step |
| `config` | Runner/model/effort snapshot and watchdog policy |
| `cursor` | Last/current step, phase, and attempt |
| `steps` | Runner-neutral step status, receipt reference, and failure |
| `worker` | Current invocation id, process/activity timestamps, and log path |
| `review` | Review attempts, selected runner/family/tier, verdict, reason tags, and evidence path |
| `blockers` | Structured preflight blockers with remedies in their messages |
| `recovery` | The interrupted status and step while recovery is active |
| `artifacts` | Run, receipt, and final-review locations |
| `history` | Ordered, structured, append-only event timeline |

`validateRunState()` checks the shape and cross-field invariants. It rejects,
among other contradictions, multiple running steps, a worker without a running
step, review status that disagrees with run status, completed steps without
receipts, and history whose final status disagrees with `run.status`.

`transitionRunState()` validates before and after reducing an event and returns
a new state object. Illegal transitions throw `RunStateTransitionError`; callers
must never patch lifecycle status directly.

### Campaign state machine

The normal path is:

```text
pending -> running -> awaiting_review -> reviewing -> completed -> merged
```

Review rework is:

```text
reviewing -> reworking -> awaiting_review
```

Failures, caps, and operator stops enter `blocked`, `failed`, `halted`,
`cap_reached`, or `stopped_by_user`.
Those states can only resume through the explicit recovery events, except a
preflight `blocked` run may start after the next preflight passes.

| Event | Legal run transition |
|---|---|
| `run_started` | `pending/blocked -> running` |
| `preflight_*` | `pending/running -> blocked` |
| `step_started/completed/skipped` | `running -> running` |
| `step_failed` | `running -> failed` |
| `run_reached_final_review` | `running -> awaiting_review` |
| `reviewer_unavailable` | `awaiting_review -> awaiting_human_review` |
| `final_review_started` | `awaiting_review -> reviewing` |
| `final_review_needs_work` | `reviewing -> reworking` |
| `final_rework_completed` | `reworking -> awaiting_review` |
| `final_review_approved` / `campaign_completed` | `reviewing -> completed` |
| `human_review_approved` | `awaiting_human_review -> completed` (only after `reviewer_unavailable`) |
| `final_review_halted` | review states `-> halted` |
| `campaign_merged` | `completed -> merged` |
| `force_merged_unreviewed` | review/halted states `-> force_merged`, only with `explicit: true` |
| `cap_reached` | active non-success states `-> cap_reached` |
| `stopped_by_user` | non-success states `-> stopped_by_user` |
| `recovery_started` | `pending/running/blocked/failed/awaiting_review/halted/stopped -> recovering` |
| recovery actions | `recovering -> recovering/running/pending/awaiting_review/halted` |

`awaiting_review` is the deliberate terminal boundary for the Campaign 2 pump,
not a successful terminal state for the full lifecycle.

The successful terminal states are `completed`, `merged`, and `force_merged`.
After the first successful terminal event, validation forbids history from
returning to a non-success status. The transition function permits only the
post-completion refinement `completed -> merged`. Therefore a completed,
merged, or force-merged run cannot later become `halted`.

### Step state machine

```text
pending -> running -> completed
                   -> failed
                   -> stopped
pending -> skipped
failed/stopped -> recovering -> pending/running
```

`pending/running/awaiting_review -> recovering` is reserved for harness
recovery: a dead pump may leave a stale lock between steps or at the review
boundary, or a `running` step whose worker process no longer exists. Normal
execution does not enter recovery from these states.

Only one step may run. `step_started` increments its attempt and requires
generic worker metadata. `step_completed` requires an absolute receipt path.
`step_failed` requires a stable failure code, human message, retryability, and
optional salvaged output tail. Reset and continue are explicit recovery events,
so recovery remains visible to the lessons layer.

### Event and failure taxonomy

The event enum gives first-class homes to the audit events:

- `step_failed`;
- `final_review_halted`;
- `force_merged_unreviewed`;
- `stopped_by_user`;
- `cap_reached`;
- `step_reset_by_recover` and `step_continued_by_recover`.

It also includes preflight, review/rework, stale-lock, and recovery lifecycle
events needed by later engine steps. Step failure codes cover watchdog stalls,
missing completion markers, checkout/branch failures, worker exits, tool/harness
failures, environment failures, and unknown failures. The event name stays
stable while runner-specific raw output belongs in the receipt or failure tail.

### Timeline and receipts

The structured timeline is `history` inside the state document. Status and the
event that caused it can therefore be written atomically and cannot drift across
two files.

Receipt bodies and worker logs stay as separate files. They are unbounded,
human-readable evidence; folding them into frequently-polled state would make
every update large and fragile. State keeps absolute receipt, log, and review
paths plus the small structured facts needed by the board.

### Runner completion contract

The engine gives each worker the run id, step id, and a unique invocation id.
Success requires the worker's final response to end with a JSON marker carrying
those three values plus the configured marker type, version, and completed
status. `lib/runners.mjs` extracts the final response from each CLI's structured
stream and verifies every field. Exit code zero without that marker becomes a
retryable `step_failed` event with code `completion_signal_missing`.

Runner binaries, argument templates, prompt delivery, effort aliases,
environment removals, stream extraction rules, and default models all live in
`campaigns.config.json`. This keeps runner selection out of the engine. The
engine writes the receipt only after it verifies the marker, then applies the
`step_completed` transition with that absolute receipt path.

## Consequences

- The board can match worktree runs without path guessing.
- Claude, Codex, fake test runners, and future runners share one reducer and
  validation contract.
- The halted-but-completed bug is rejected both when transitioning and when
  loading an externally corrupted ledger.
- The pump must persist state by atomically writing the whole validated document.
- Adding or changing lifecycle states requires a schema-version change, reducer
  transition, and tests; direct status mutation is unsupported.

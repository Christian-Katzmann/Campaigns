# Codex automate-state research

Findings from a Codex investigation of how its own automation system stores state, intended as required reading for the Codex provider implementation in `lib/automate-providers.mjs`.

## Investigation notes

Codex inspected live automation state, not just skill docs. Codex automations live in `~/.codex/automations/<id>/automation.toml`, but scheduler truth lives in `~/.codex/sqlite/codex-dev.db`. That DB has real `automations` and `automation_runs` tables. There is no `codex automation list/create` CLI in `codex --help`.

Two active Campaigns runs were observed at investigation time, including `publish-apps` at `<repo>/reports/campaign-automation/publish-apps/state.json`. Its live run had a lock at `.../publish-apps/lock`, timeline at `.../timeline.md`, receipts in the repo, and a live Codex session JSONL at `~/.codex/sessions/2026/05/25/rollout-2026-05-25T18-26-06-019e5ff5-3825-7792-b38a-94439557885b.jsonl`.

## 1. Detection

Given `<repo>/campaigns/<slug>.md`, do **not** grep automation names and do **not** trust `automation.toml` alone.

Exact cheap check:

```bash
find <repo>/reports/campaign-automation -maxdepth 2 -name state.json
jq -r '.campaign.campaign_path, .campaign.status, .automations[-1].id' <state.json>
sqlite3 ~/.codex/sqlite/codex-dev.db \
  "SELECT id,status,model,reasoning_effort,next_run_at,last_run_at FROM automations WHERE id='<automation-id>';"
sqlite3 ~/.codex/sqlite/codex-dev.db \
  "SELECT thread_id,status,created_at,updated_at,source_cwd FROM automation_runs WHERE automation_id='<automation-id>' ORDER BY created_at DESC LIMIT 1;"
```

A campaign is Codex-automated if a matching `state.json` has `campaign.campaign_path` equal to the resolved markdown path. It is **actively running** if the latest recorded automation is registry `ACTIVE` and either `automation_runs.status='IN_PROGRESS'` or `<run_dir>/lock` exists and is fresh.

## 2. State source

Current step comes from `<run_dir>/lock` first, then `state.cursor`, then parser status.

Observed lock shapes differ — parse both:

Text shape:
```text
automation_id: campaign-publish-apps-step-1-3-runner-20260525-182459
start_time: 2026-05-25T16:27:17Z
next_type: step
step_id: 1.3
phase: 1
```

JSON shape:
```json
{
  "automation_id": "campaign-devsec-rotation-completeness-step-2-2",
  "started_at": "2026-05-25T16:25:22.059300Z",
  "next_type": "step",
  "step_id": "2.2",
  "phase": "2"
}
```

Use lock `start_time` / `started_at` for elapsed display. If no lock exists but the DB says `IN_PROGRESS`, use `automation_runs.created_at`.

## 3. Event log

Primary event log is repo-local:

```text
<repo>/reports/campaign-automation/<campaign-slug>/timeline.md
```

Shape:

```text
- `2026-05-25T16:26:59+00:00` Verified clean Step 1.3 fallback automation produced a scheduler run after lock release.
```

Cheapest read: tail the file and parse `` - `ISO` message ``. Supplement with `automation_runs` for scheduler launches.

## 4. Logs

There is no clean per-run stdout/stderr file like Claude's `logs/`.

Best available live tail is the Codex session transcript:

```bash
find ~/.codex/sessions/<YYYY>/<MM>/<DD> -name '*<thread_id>.jsonl'
jq -r 'select(.type=="response_item" and .payload.type=="function_call_output") | .payload.output' <session.jsonl>
```

This is usable for `current_step_log`, but it is a JSONL transcript, not raw daemon stdout. `~/.codex/logs_2.sqlite` exists, but it is low-level telemetry and too noisy for the drawer.

## 5. Receipts

There is no single canonical Codex receipt registry today.

Observed receipts live in the repo, often under the campaign run dir:

```text
<repo>/reports/campaign-automation/publish-apps/step-1.2-receipt.md
```

Campaign markdown may declare receipt paths, for example `campaigns/devsec-rotation-completeness/receipts/01-end-to-end.md`, but the generic Codex runner does not currently write `receipt_path` into `state.json`. **Provider should infer from `run_dir` plus markdown-declared paths until the skill records receipts explicitly** (see Gaps section).

## 6. Nudge: continue

Codex does not currently have a `claude-automate recover --continue` equivalent.

`campaign-automation-step` is already disk-truth-driven, so it can resume safely in spirit. But today it skips if the lock is younger than 6 hours. A real continue nudge needs a small recovery mode:

```text
Recovery mode: continue interrupted attempt.
Previous attempt may have been interrupted; inspect git status, timeline, existing receipts, and campaign markdown. Finish only what remains.
```

The helper must archive a stale lock only after confirming no recent session JSONL activity.

## 7. Nudge: restart, skip, restart-failed

Current exact mechanisms are incomplete.

- **`restart`**: create a fresh automation for the same `state.cursor.step_id`, with a restart prompt. Existing low-level fallback command is `campaign_state.py register-automation`, but this should be wrapped.
- **`skip`**: must not only edit state. It must mark the campaign markdown via `python3 ~/Dev/skills/campaign-automate/scripts/campaign_parser.py mark-step --campaign <campaign.md> --step <step-id> --checked true`, then rerun parser status and schedule the next automation.
- **`restart_failed`**: should clear `state.blockers`, preserve timeline evidence, and schedule the blocked unit again.

**Recommended new CLI** (does not exist yet):

```bash
python3 ~/Dev/skills/campaign-automate/scripts/campaign_recover.py \
  --state <state.json> \
  --mode continue|restart|skip|restart-failed \
  --delay-minutes 1
```

Until that exists, Campaigns should show these buttons as unavailable.

## 8. Stall detection

Concrete heuristic:

A run is **`active`** if latest run is `IN_PROGRESS` or lock is fresh.

A run is **`stalled`** if:

```text
lock age > current_step.max_minutes
AND session JSONL mtime is older than 10-15 minutes
AND latest automation_runs row is still IN_PROGRESS or no completion event exists
```

Use `max_minutes = 60` for now. The skill's hard stale-lock rule is 6 hours; that is too late for UI stall detection.

**Queued-but-unfired** (scheduled-but-not-running):

```text
automation row ACTIVE
AND next_run_at has passed by > 90 seconds
AND no automation_runs row exists since that scheduled window
```

For the shared contract, represent this as `status: 'active', is_active: false` (no separate `scheduled` status added).

## 9. Don'ts

Campaigns **must not**:
- Raw-edit `automation.toml`
- Raw-write SQLite rows
- Poke Codex IPC sockets
- Delete locks directly
- Mark markdown checkboxes as a "skip" without scheduling the next automation
- Trust `state.json` alone as proof the scheduler launched — require `automation_runs`

## Implementation sketch

```js
async function getAutomateState(campaignMarkdownPath) {
  const statePath = await findMatchingState(campaignMarkdownPath);
  if (!statePath) return null;

  const state = await readJson(statePath);
  const runDir = state.campaign.run_dir;
  const lock = await readLock(`${runDir}/lock`);
  const latestAutomation = latestStateAutomation(state);
  const registry = latestAutomation
    ? await sqliteOne(CODEX_DB, `SELECT * FROM automations WHERE id=?`, [latestAutomation.id])
    : null;
  const run = latestAutomation
    ? await sqliteOne(CODEX_DB, `SELECT * FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC LIMIT 1`, [latestAutomation.id])
    : null;

  const markdown = await readFile(campaignMarkdownPath, 'utf8');
  const campaignMap = parseCampaignSteps(markdown);
  const stepId = lock?.step_id ?? state.cursor?.step_id ?? null;
  const step = stepId ? campaignMap.steps.get(stepId) : null;

  const sessionPath = run?.thread_id
    ? await findSessionJsonl(run.thread_id, run.created_at)
    : null;
  const logTail = sessionPath ? await tailCodexSessionLog(sessionPath, 120) : '';

  const active = registry?.status === 'ACTIVE'
    && (run?.status === 'IN_PROGRESS' || isFreshLock(lock));

  return {
    backend: 'codex',
    is_active: Boolean(active),
    status: normalizeCodexStatus(state, registry, run, lock, sessionPath),
    started_at: state.campaign.created_at,
    current_step: stepId ? {
      id: stepId,
      name: step?.name ?? latestAutomation?.expected_next ?? stepId,
      phase_name: step?.phase_name ?? lock?.phase ?? state.cursor?.phase ?? null,
      started_at: lock?.started_at ?? lock?.start_time ?? msToIso(run?.created_at),
      max_minutes: 60,
    } : null,
    steps: buildStepsFromMarkdownAndReceipts(markdown, runDir),
    timeline_events: await parseTimeline(`${runDir}/timeline.md`),
    current_step_log: logTail,
    nudge_modes: computeNudgeModes({ state, registry, run, lock, sessionPath }),
  };
}

async function nudge(campaignMarkdownPath, mode) {
  const statePath = await findMatchingState(campaignMarkdownPath);
  if (!statePath) return { ok: false, message: 'No Codex automation state found for this campaign.' };

  return execJson('python3', [
    `${HOME}/Dev/skills/campaign-automate/scripts/campaign_recover.py`,
    '--state', statePath,
    '--mode', mode,
    '--delay-minutes', '1',
    '--json',
  ]);
}
```

## Differences from Claude provider

- Claude has a purpose-built run root under `~/.claude-automate/campaigns/<slug>/` with canonical `logs/` and `receipts/`. Codex splits truth across repo-local `state.json` / `timeline.md` / lock, Codex app SQLite, and session JSONL transcripts.
- Codex can prove scheduler launch through `automation_runs`; Claude's model is more direct.
- Codex has a "registered but not fired yet" state. Contract represents this as `is_active: false` while `status: 'active'`.

## Gaps and small skill changes needed

1. **`campaign_recover.py` (or `campaign_state.py nudge`)** with modes `continue / restart / skip / restart-failed`. Rough effort: 2–4 hours. Required for nudge to work at all.
2. **`campaign-automation-step` recovery mode** that archives stale locks safely and resumes from disk truth. Rough effort: 1 hour. Pairs with #1.
3. **Record per-step receipts in `state.json`**: `receipts: [{ step_id, path, created_at }]`. Rough effort: 1 hour. Required for clean receipt list without inference.
4. *(Deferred)* JSONL event mirror beside `timeline.md`, while keeping timeline for humans. Rough effort: 30–60 minutes. Skip — timeline.md is parseable.
5. *(Deferred — out of scope)* Expose an official Codex automation create/update CLI or local API. Without it, Campaigns uses the registry fallback and waits for `automation_runs` proof. Works, but not as clean as Claude's CLI.

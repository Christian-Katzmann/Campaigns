# Running campaigns

`campaigns run <campaign.md>` executes unchecked steps from the campaign's
progress checklist. The campaign markdown remains the progress source of truth;
the run ledger records execution evidence and terminal reasons.

Install the engine with `npm install --global campaigns-app`. For a zero-install
look at the bundled sample board, run `npx campaigns-app`; add `--no-open --port
0` for an unattended smoke test. The installed executable remains `campaigns`.

## Worktree isolation

Runs use a dedicated Git worktree by default. Campaigns creates it below the
run-ledger directory, branches it from the campaign branch, and runs every step,
check, fix, and final review there. The canonical campaign markdown stays in the
parent checkout; only the pump updates its checkboxes.

Finalize fast-forwards the execution branch into the campaign branch, safely
merges the campaign branch into the default branch, and removes the execution
worktree. Runs awaiting human review keep the worktree until their persisted
cleanup deadline; status polling removes it after expiry while retaining the
branch. `campaigns recover` either reuses a clean interrupted worktree or saves
its changes on the execution branch before pruning it.

Use `campaigns run <campaign.md> --no-worktree` only when direct execution on the
campaign branch is intentional.

## Executable checks

A step can declare machine-checkable acceptance criteria inside its fenced
prompt. Each check is one physical line beginning with `CHECK:` followed by a
JSON object:

```text
SCOPE: Ship the parser change.
CHECK: {"command":"npm test","expectedExit":0,"timeoutMs":120000}
CHECK: {"command":"node -e \"console.log('ready')\"","expectedOutput":"ready","timeoutMs":10000}
```

| Field | Rule |
| --- | --- |
| `command` | Required non-empty shell command. |
| `expectedExit` | Non-negative integer; defaults to `0`. |
| `expectedOutput` | Optional literal substring in captured output. v1 does not interpret regular expressions. |
| `timeoutMs` | Positive integer in milliseconds; defaults to `120000`. |

The marker must be uppercase and the JSON must stay on one line. Because the
prompt is already fenced Markdown, Markdown does not interpret the command.
Inside the JSON string, escape only as JSON requires: `\"` for a double quote,
`\\` for a backslash, and `\n` for a newline. Shell quotes, pipes, `$`, and
backticks otherwise remain part of the command unchanged. Repeat the line for
several checks. Campaigns without `CHECK:` lines keep their previous plan shape.

The engine runs a step's checks from the repository root after its worker exits
successfully and before ticking the step. It matches `expectedOutput` against
combined stdout and stderr. Failed checks enter the fix loop and rerun after
each fix; all campaign checks run again before final review. Check output is
redacted first, then capped at 4096 characters with a visible truncation marker
before it is written to a receipt/state file or sent to a fix worker.

## Plan health

Run `campaigns lint <campaign.md>` to check a plan without starting it. The
shared rules report:

- **Error:** missing Model metadata, ACCEPTANCE criteria, or a campaign-level
  final-review prompt.
- **Warning:** step count above learned sizing guidance or more than five
  REQUIRED READING items in one step.
- **Info:** a step has no executable CHECK yet.

The CLI exits `1` only when at least one error finding exists. Warning- and
info-only results exit `0`; invocation or file-loading failures exit `2`. The
editor will use the same browser-safe rules module to display these findings
inline. The CLI reads local unified lessons directly and both consumers use
`sizing.avoidAboveSteps`, falling back to 10 steps when lessons have no sizing
data. Lint does not block the campaign pump in v1; a future `--strict` mode may
make that policy explicit.

## Run limits

The shipped defaults are 50 completed steps and 360 minutes per run. Local
dollar caps are opt-in:

```json
{
  "run": {
    "max_steps_per_run": 50,
    "max_run_minutes": 360,
    "max_cost_usd": null,
    "stop_grace_ms": 3000
  }
}
```

Override the caps for one launch with `--max-steps-per-run`,
`--max-run-minutes`, and `--max-cost-usd`. A dollar cap sums
`history[].details.usage.cost_usd` after every runner invocation and stops before
launching another runner once the total reaches the limit. Selecting a runner
without a `cost_usd` usage mapping is refused before launch. The CI action makes
all three caps mandatory. A cap ends the ledger as `cap_reached`; it does not
pretend the campaign completed.

## Configuration

Campaigns resolves configuration in this order; later layers win:

| Priority | Layer | Location |
| --- | --- | --- |
| 1 | Bundled defaults | `campaigns.config.json` in the installed package |
| 2 | Project | `.campaigns.json` in the campaign file's canonical Git root |
| 3 | User | Platform config directory, listed below |
| 4 | Explicit file | `--config <path>` |
| 5 | Environment | `CAMPAIGNS_*` scalar overrides |
| 6 | Command line | Explicit scalar flags such as `--runner` and `--model` |

Project discovery follows the campaign file, not the shell's current directory.
That means `campaigns run /absolute/path/campaign.md` loads the right project's
`.campaigns.json` from anywhere. A runner with the same name replaces the lower
layer's whole runner definition; runner fields are not partially merged.

The user config file is `config.json` in:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/Campaigns` |
| Linux | `$XDG_CONFIG_HOME/campaigns`, or `~/.config/campaigns` |
| Windows | `%APPDATA%\Campaigns` |

Set `CAMPAIGNS_CONFIG_DIR` to use another user-config directory. Scalar
environment overrides are `CAMPAIGNS_RUNNER`, `CAMPAIGNS_MODEL`,
`CAMPAIGNS_EFFORT`, `CAMPAIGNS_REPO`, `CAMPAIGNS_BRANCH`,
`CAMPAIGNS_MAX_STEPS_PER_RUN`, `CAMPAIGNS_MAX_RUN_MINUTES`,
`CAMPAIGNS_MAX_COST_USD`,
`CAMPAIGNS_STOP_GRACE_MS`, and `CAMPAIGNS_FORCE_MERGE_UNREVIEWED`.

Run `campaigns config doctor [campaign.md]` to print the effective values,
their source, and the project root. With no campaign argument it uses the
current directory's Git root. Unknown keys and paths that do not exist are
reported as warnings; secret-shaped values are masked.

## Final review selection

Final review defaults to `"reviewer": "auto"`:

```json
{
  "review": {
    "reviewer": "auto"
  }
}
```

At the review boundary, Campaigns checks the same runner capabilities exposed
to the board. It prefers an available runner from a different family than the
campaign worker, then starts a fresh process from the worker's family. The
reviewer uses its own default model and effort. If no runner is available,
Campaigns starts no doomed process: the ledger enters `awaiting_human_review`
and the existing review notification is sent.

Set `review.reviewer` to a runner id to pin review to that runner. An unavailable
pinned runner also waits for human review; it never silently switches runners.

This works with one subscription: the same runner family performs review in a
fresh process. Cross-family review only happens when another configured CLI is
actually available, and may consume that CLI's separate subscription. Campaigns
does not translate the worker's model or effort setting across providers.

## Stopping a run

Use `campaigns stop <campaign.md>` or `POST /api/run/stop` with the registered
campaign id. The pump stops at a boundary when possible. During an active
worker, it allows the configured grace period, then terminates that worker's
process group, saves the output tail as salvage, and records
`stopped_by_user`.

## Platform behavior

The engine uses argument arrays rather than shell command strings, and all run,
receipt, and working-directory paths use Node's platform path API. macOS and
Linux run in CI.

Windows support is best-effort in v1. Native runner executables can use the
same argument contract, but Node cannot directly launch `.cmd` or `.bat` agent
shims without a shell. Forced stops also target the direct runner process on
Windows, not a Unix-style process group, so descendants may need manual
cleanup.

## Containment

The source root is the canonical, real-path Git root containing the campaign
file. `--repo <path>` may declare that root explicitly. The worker root is the
engine-created worktree unless `--no-worktree` is set. Campaigns records both
locations and contains each worker to its execution root.

This is a path and process-containment contract, not an agent sandbox. Campaigns
chooses the worker's cwd and rejects paths outside the repo. What the worker CLI
may read, write, or access beyond that is controlled by that CLI's own
permission mode and operating-system permissions.

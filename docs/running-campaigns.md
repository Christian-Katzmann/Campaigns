# Running campaigns

`campaigns run <campaign.md>` executes unchecked steps from the campaign's
progress checklist. The campaign markdown remains the progress source of truth;
the run ledger records execution evidence and terminal reasons.

Install the engine with `npm install --global campaigns-app`. For a zero-install
look at the bundled sample board, run `npx campaigns-app`; add `--no-open --port
0` for an unattended smoke test. The installed executable remains `campaigns`.

## Run limits

The shipped defaults are 50 completed steps and 360 minutes per run:

```json
{
  "run": {
    "max_steps_per_run": 50,
    "max_run_minutes": 360,
    "stop_grace_ms": 3000
  }
}
```

Override the caps for one launch with `--max-steps-per-run` and
`--max-run-minutes`. A cap ends the ledger as `cap_reached`; it does not pretend
the campaign completed.

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
`CAMPAIGNS_STOP_GRACE_MS`, and `CAMPAIGNS_FORCE_MERGE_UNREVIEWED`.

Run `campaigns config doctor [campaign.md]` to print the effective values,
their source, and the project root. With no campaign argument it uses the
current directory's Git root. Unknown keys and paths that do not exist are
reported as warnings; secret-shaped values are masked.

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

The execution root is the canonical, real-path Git root containing the campaign
file. `--repo <path>` may declare that root explicitly. The pump refuses to
start if the campaign file or worker working directory resolves outside it;
this also catches symlinks that escape the repository.

This is a path and process-containment contract, not an agent sandbox. Campaigns
chooses the worker's cwd and rejects paths outside the repo. What the worker CLI
may read, write, or access beyond that is controlled by that CLI's own
permission mode and operating-system permissions.

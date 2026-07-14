# Running campaigns

`campaigns run <campaign.md>` executes unchecked steps from the campaign's
progress checklist. The campaign markdown remains the progress source of truth;
the run ledger records execution evidence and terminal reasons.

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

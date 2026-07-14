# Learning Loop Data Contract

Campaigns can show a local lessons summary from past automation runs. The
summary is advisory evidence for planning future campaigns; it is not a
separate project database and it does not replace the campaign markdown,
receipts, git history, or final review.

## Sources

`GET /api/lessons` reads versioned unified run ledgers from the Campaigns runs
directory natively in Node. The default is the platform data directory's
`runs/` folder; `CAMPAIGNS_RUNS_DIR` overrides it. Current `state.json` files
and archived `state-<run-id>.json` files are included and deduplicated by run
id.

Schema-versioned unified ledgers are the cutoff. Pre-unified Claude and Codex
state files are excluded by default. When no unified ledgers exist, a configured
`CAMPAIGNS_LESSONS_HELPER` remains a legacy fallback; native runs never shell
out to Python.

## Metrics

- `approval_rate` is approved runs divided by runs with a structured verdict.
- `first_try_rate` is verdict-bearing runs approved without `NEEDS WORK`, fix,
  or final-rework events.
- `rework_rate` is runs with structured review/fix rework evidence divided by
  all unified runs.
- `manual_stop_rate`, shown as the **babysitting index**, is runs with a
  `stopped_by_user` event divided by all unified runs. Recovered runs retain the
  stop signal.
- `failure_taxonomy` counts structured preflight, step-failure, review-failure,
  cap, stop, and recovery-failure events. `step_failed` is grouped by its stable
  `failure.code`.
- Canonical reason counts consume only values in validated `reasons`. Values in
  `raw_tags` are counted separately and never enter the canonical signal.
- `step-count guidance` is a correlation from local history, not a hard rule.
  Treat `avoid_above` as "split the campaign unless there is a good reason."

## Current Caveats

Only the unified ledger's structured fields count. Prose timelines, receipt
text, and pre-unified files are deliberately not guessed into metrics. A schema
version 1 unified ledger is upgraded in memory to the current schema before it
is validated and aggregated.

The most important interpretation rule is simple: compare trends, not tiny
differences. A first-try rate moving from 40% to 70% is meaningful. A one-run
change is probably noise unless the underlying receipt and review evidence also
explains it.

## Validation

Before trusting a learning-loop change, run:

```bash
npm test
npm run check
```

If UI or publication assets changed, also run:

```bash
npm run assets:render
```

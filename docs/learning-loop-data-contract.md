# Learning Loop Data Contract

Campaigns can show a local lessons summary from past automation runs. The
summary is advisory evidence for planning future campaigns; it is not a
separate project database and it does not replace the campaign markdown,
receipts, git history, or final review.

## Sources

The lessons helper reads two local ledgers:

- Claude campaign runs under the user's Claude automation campaign directory.
- Codex campaign runs discovered through the Campaigns registry, then resolved
  to each repo's `reports/campaign-automation/<slug>/state.json`.

The app calls the helper through `GET /api/lessons`. By default it looks for the
campaign-planner helper in the user's home directory. Set
`CAMPAIGNS_LESSONS_HELPER` to point at a different compatible helper.

## Metrics

- `approval_rate` counts campaigns with a final verdict and the share that ended
  `APPROVED`.
- `first_try_rate` counts verdict-bearing campaigns approved without any prior
  `NEEDS WORK`, final rework, or structured rework evidence.
- `rework_rate` counts campaigns with any `NEEDS WORK` review attempt or rework
  event. For Claude, older timelines are parsed for `NEEDS WORK` text because
  they did not always write structured rework events.
- `halt_rate` counts runs whose final state is halted, blocked, or failed.
- `recovery` counts explicit recovery events. Older runs can under-report this
  when recovery happened only in prose.
- `reason tags` come from normalized final-review `Reasons:` values. Unknown
  historical tags are kept as legacy evidence but are not used as planning
  reminders.
- `step-count guidance` is a correlation from local history, not a hard rule.
  Treat `avoid_above` as "split the campaign unless there is a good reason."

## Current Caveats

Legacy ledgers are uneven. Some older Codex campaigns have approved verdicts but
no recorded receipts, several older campaigns have no final verdict at all, and
some step counts are unavailable. Those rows stay in the scan, but they surface
`data_quality_warnings` so the UI can label the confidence instead of inventing
precision.

The most important interpretation rule is simple: compare trends, not tiny
differences. A first-try rate moving from 40% to 70% is meaningful. A one-run
change is probably noise unless the underlying receipt and review evidence also
explains it.

## Validation

Before trusting a learning-loop change, run:

```bash
python3 ~/.claude/skills/campaign-planner/bin/test_read_past_campaigns.py
python3 ~/.claude/skills/campaign-planner/bin/read-past-campaigns.py --include-raw
npm run check
```

If UI or publication assets changed, also run:

```bash
npm run assets:render
```

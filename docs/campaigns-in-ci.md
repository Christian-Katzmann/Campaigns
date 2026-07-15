# Campaigns in CI

The Campaigns composite action runs a markdown campaign in a GitHub Actions
pull-request job, uploads its redacted run evidence, updates one PR comment, and
creates a check run on the PR head commit.

## Workflow setup

Use only the `pull_request` event and pin the Campaigns action to a full commit
SHA. Replace both placeholders below with reviewed 40-character commit SHAs.

```yaml
name: Campaigns

on:
  pull_request:

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  campaign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-40-character-commit-sha>
      - uses: Christian-Katzmann/Campaigns/action@<full-40-character-campaigns-commit-sha>
        with:
          campaign: campaigns/release.md
          runner: claude
          runner_cli_version: 2.1.210
          model: claude-opus-4-8
          effort: medium
          max_steps: 3
          max_minutes: 20
          max_cost_usd: 1.00
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action accepts same-repository PRs only. It refuses fork PRs and every
`pull_request_target` run before runner installation or launch. This prevents
untrusted PR code from receiving base-repository secrets. The minimum workflow
permissions are the three shown above.

Create `ANTHROPIC_API_KEY` as a repository or environment secret. The action
registers inherited secret values with GitHub masking before starting a child
process; it does not put keys in command arguments or Campaigns config.
Interactive subscription login is not available on an ephemeral runner.

## Mandatory caps

`max_steps`, `max_minutes`, and `max_cost_usd` are all required and must be
positive. The dollar cap sums normalized `cost_usd` values reported by the
runner after each invocation and stops before the next invocation once the cap
is reached. Campaigns currently advertises Claude for CI because its supported
JSONL result contract includes cost reporting.

The dollar cap is a Campaigns execution guard, not a replacement for provider
billing limits. It is only as accurate as the runner's reported cost. Run
`campaigns lint` to check plan structure and sizing warnings; the local board
adds a range estimate. Neither plan-health signal replaces `max_cost_usd`.

## Evidence and status

The action uploads these share-safe surfaces even when the engine fails:

| Surface | Meaning |
| --- | --- |
| `state.json` | Current run status, configured caps, steps, review, and ordered history. |
| `events.jsonl` | Redacted structured projection of the run history. |
| `receipts/` | Per-step runner and executable-check evidence. |
| `final-review.md` | Automated final-review verdict and reviewer output. |

There is no separate timeline artifact. On a same-repository PR, the action
maintains one comment containing the step table, verdict or cap reason, and
artifact link. It also upserts one `Campaigns` check run on the PR head SHA:

| Run status | Check conclusion |
| --- | --- |
| `completed` or `merged` | `success` |
| `cap_reached` | `failure` |
| `awaiting_human_review` | `action_required` |
| Other terminal failures | `failure` |

Persisted state, events, receipts, and review output pass through Campaigns'
redaction pipeline. Do not deliberately print secrets; masking and redaction
are containment layers, not permission to log credentials.

## Reproduce the no-provider proof

From a Campaigns source checkout on Node 20+, run:

```bash
npm run action:e2e -- --output /tmp/campaigns-ci-evidence
```

The harness creates a temporary same-repository PR fixture with a two-step
campaign and a deterministic fake JSONL runner. It executes the action's
preflight, exact engine command, four-surface upload contract, sticky-comment
publisher, and PR-head check publisher under tight step, time, and dollar caps.
It archives a transcript, API payloads, artifact manifest, normalized fixture
cost, and sentinel scan in the output directory, then deletes the scratch repo.
The output directory must be empty.

This campaign did not perform a live provider-key run because no approved
metered key was available. The harness makes no provider call, writes no real
secret, retains no scratch repository, and spends nothing. Its reported fixture
cost proves normalization and cap accounting only; it is not provider spend.

## Limitations

- Live provider proof remains operator follow-up and requires an approved,
  metered API key.
- Fork PRs cannot run this secret-bearing workflow. Use a separate trusted
  process if fork contributions need campaign execution.
- A runner without normalized `cost_usd` support cannot satisfy the mandatory
  CI dollar cap and is refused.
- GitHub artifact retention and provider account billing limits remain separate
  platform settings.

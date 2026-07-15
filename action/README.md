# Campaigns in CI

This composite action runs the Campaigns engine from the same immutable
Campaigns commit as the action. Pin `uses:` to a full commit SHA. Do not install
`campaigns-app` separately.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@<full-commit-sha>
  - uses: Christian-Katzmann/Campaigns/action@<full-campaigns-commit-sha>
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

All three caps are required and positive. The runner CLI version must be an
exact semver. `claude` is the only advertised CI runner because its shipped
JSONL contract reports `cost_usd`; runners without that mapping are refused
before installation or launch.

Use the `pull_request` event only for PRs. Fork PRs and every
`pull_request_target` execution are refused before installing the runner. API
keys remain inherited environment values, are registered with GitHub masking
before any child runner starts, and never enter arguments or config. Interactive
subscription login does not carry into an ephemeral GitHub runner; use an API
key with billing and limits appropriate for CI.

The action always uploads the share-safe evidence surfaces from its deterministic
temporary state directory:

- `state.json`
- `events.jsonl`
- `receipts/`
- `final-review.md`

There is no separate timeline file. Logs and persisted evidence use Campaigns'
redaction pipeline, but workflows should still avoid deliberately printing
secrets.

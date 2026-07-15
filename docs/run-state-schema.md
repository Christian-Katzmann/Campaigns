# Run-state schema and engine events

Campaigns publishes the current unified ledger as
`schema/run-state.schema.json`. `schema_version` in each ledger and
`RUN_STATE_VERSION` in `lib/run-state.mjs` are the authority; the published
schema's `schema_version.const` matches them.

Consumers should validate the document before using it. The JSON Schema
covers the portable record shape. Campaigns additionally applies
`validateRunState()` for transition-chain and cross-record invariants such as
one worker per running step, completed-step receipts, and review/run status
agreement.

## Migration contract

`upgradeRunState()` owns the complete version-to-version chain. Every Campaigns
ledger read upgrades in memory, validates the final version, then atomically
persists the migrated document. Invalid JSON and invalid migrated documents
are rejected without changing the source bytes. Reading a current document a
second time is idempotent.

Do not edit `schema_version` in place. Produce a new schema version, add one
forward migration in `upgradeRunState()`, and keep old fixture coverage.

## Structured event log

Each valid state write also writes a redacted `events.jsonl` beside
`state.json`. It is a deterministic projection of the ledger's ordered
`history`, so sequences cannot be duplicated or reordered.

Every line follows `#/$defs/engine_event` in the published schema:

```json
{"event":"step_completed","at":"2026-07-15T04:00:00.000Z","run_id":"run-123","sequence":4,"step_id":"2.1","details":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"cost_usd":0.0042}}}
```

Required fields are `event`, `at`, `run_id`, and positive integer `sequence`.
`step_id` and `details` are optional. An empty object is invalid. Runner result
events use the normalized usage shape in `#/$defs/runner_usage`; all token/cost
fields are present and are explicitly `null` when the CLI does not report them.

State and event writes pass through `lib/redaction.mjs`. Logs and ledgers are
still local execution records, not a place to deliberately store secrets.

## OTel mapping

No OTel SDK is bundled. A collector can map `run_id` to a trace ID, `step_id`
to a span attribute, `event` to the event name, `at` to the event timestamp,
and `sequence` to an ordering attribute. Flatten `details.usage` into GenAI
usage attributes appropriate to the collector's chosen semantic-convention
version. This keeps the Campaigns runtime dependency-free while leaving a
stable export seam.

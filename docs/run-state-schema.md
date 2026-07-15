# Run-state schema and engine events

Campaigns publishes the current unified ledger as
`schema/run-state.schema.json`. `schema_version` in each ledger and
`RUN_STATE_VERSION` in `lib/run-state.mjs` are the authority; the published
schema's `schema_version.const` matches them.

`config.max_cost_usd` is either `null` for no local dollar cap or a positive
number. Cost enforcement sums the normalized `cost_usd` values already recorded
under `history[].details.usage`; `cap_reached` records the limit and final total.

Consumers should validate the document before using it. The JSON Schema
covers the portable record shape. Campaigns additionally applies
`validateRunState()` for transition-chain and cross-record invariants such as
one worker per running step, completed-step receipts, and review/run status
agreement.

## Journal and projection contract

Native runs write `journal.jsonl` first. Each line is one versioned event with
an increasing sequence, the previous line's SHA-256 hash, and its own SHA-256
hash. The first `run_initialized` event contains the validated run state and the
full initial campaign Markdown. Later `state_persisted` events carry the
resulting state at each durable boundary. Engine-applied checkbox and rollback
writes use `document_transition` with the before/after Markdown hashes and full
resulting Markdown.

`foldRunJournal()` is the pure authority for rebuilding `state.json` and the
board replay timeline. The campaign Markdown remains the live progress source
of truth; journal document copies are replay evidence, not a file-repair source.
Writers append and `fsync` one line before rebuilding projections. On resume,
only an unterminated final line may be discarded; corruption in an earlier or
newline-terminated line is rejected.

Runs created before journals existed import the current validated ledger as one
`snapshot_imported` event labelled `non_historical_snapshot`. Existing
`events.jsonl` is never treated as source history. Exact document replay is
therefore `native_journal` only; imported runs are `snapshot_forward_only`.

The journal contains full campaign Markdown and is local replay evidence, not a
share-safe artifact. State payloads are redacted before append. CI continues to
publish only the redacted projections and receipts documented below.

A one-step fixture with four durable boundaries is about 10 KiB. V1 never
truncates the journal; snapshot-assisted compaction is future work if long-run
measurements justify it.

## Migration contract

`upgradeRunState()` owns the complete version-to-version chain. Every Campaigns
ledger read upgrades in memory, validates the final version, then atomically
persists the migrated document. Invalid JSON and invalid migrated documents
are rejected without changing the source bytes. Reading a current document a
second time is idempotent.

Do not edit `schema_version` in place. Produce a new schema version, add one
forward migration in `upgradeRunState()`, and keep old fixture coverage.

## Structured event log

Each valid journal write rebuilds redacted `state.json` and `events.jsonl`.
`events.jsonl` is a deterministic projection of the folded state's ordered
`history`, so sequences cannot be duplicated or reordered.

Every line follows `#/$defs/engine_event` in the published schema:

```json
{"event":"step_completed","at":"2026-07-15T04:00:00.000Z","run_id":"run-123","sequence":4,"step_id":"2.1","details":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"cost_usd":0.0042}}}
```

Required fields are `event`, `at`, `run_id`, and positive integer `sequence`.
`step_id` and `details` are optional. An empty object is invalid. Runner result
events use the normalized usage shape in `#/$defs/runner_usage`; all token/cost
fields are present and are explicitly `null` when the CLI does not report them.

State and event projections pass through `lib/redaction.mjs`. Logs and ledgers
are still local execution records, not a place to deliberately store secrets.

## OTel mapping

No OTel SDK is bundled. A collector can map `run_id` to a trace ID, `step_id`
to a span attribute, `event` to the event name, `at` to the event timestamp,
and `sequence` to an ordering attribute. Flatten `details.usage` into GenAI
usage attributes appropriate to the collector's chosen semantic-convention
version. This keeps the Campaigns runtime dependency-free while leaving a
stable export seam.

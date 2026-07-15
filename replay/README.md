# Recorded replay demo

`hello-run.journal.jsonl` is a frozen, public-safe native journal generated from
`examples/hello-run.md` by the real run-state transition, executable-check, and
journal persistence code. The recorder performs the two fixture changes itself;
it does not call an agent or hand-author journal events.

Generate a fresh recording:

```bash
node scripts/record-replay-demo.mjs
```

Build the self-contained, `file://`-safe page:

```bash
node scripts/build-replay-demo.mjs
```

The recorder replaces its temporary directory with `/campaigns-demo`, re-hashes
the integrity chain, validates every state snapshot, and rejects home-directory
or recorder-temp-path leaks before writing the fixture.

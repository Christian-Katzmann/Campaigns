# Runner plugin API

Campaigns runner plugins are directories containing a `campaigns-runner.json`
manifest and any files used by the runner command. Add explicit plugin
directories to the top-level `runnerPaths` config array:

```json
{
  "runnerPaths": ["./tools/campaigns-runner-gemini"],
  "defaultRunner": "gemini"
}
```

`runnerPaths` uses the normal bundled → project → user → explicit config
precedence. The last layer that declares the array replaces earlier arrays.
Relative entries resolve from that winning config file, not the shell's current
directory. `campaigns config doctor [campaign.md]` prints the resolved paths,
missing paths, and rejected manifests.

## Manifest contract

The manifest is JSON with these fields:

| Field | Contract |
|---|---|
| `schemaVersion` | Required integer `1`. |
| `id` | Required stable ID matching `^[a-z][a-z0-9-]*$`. It is the config/UI runner value. |
| `family` | Required stable provider family, such as `google`. Review selection compares families, not IDs. |
| `label` | Optional human label; defaults from the ID. |
| `binary` | Required command. A relative path resolves from the manifest directory; a bare command resolves through `PATH`. |
| `args` | Required string array. Each item is one process argument; Campaigns never invokes a shell. |
| `prompt.delivery` | Required `stdin` or `arg`. `arg` requires `{prompt}` in `args`; `stdin` forbids it. |
| `defaults` | Required `{ "model": string, "effort": string }`. |
| `models` | Optional non-empty `{id,label}` catalog. Defaults to the default model. |
| `efforts` | Optional non-empty `{id,label}` catalog. It must include the default effort. |
| `effortMap` | Required object mapping Campaigns effort aliases to CLI effort values. |
| `environment.remove` | Required array of inherited environment variable names to remove. Other variables are inherited. |
| `completion` | Required completion-marker and output-extraction contract described below. |
| `usage` | Optional normalized token/cost extraction contract described below. |

Argument templates support `{model}`, `{effort}`, `{prompt}`, `{repo}`, and
`{output}`. A placeholder is resolved only when its argument is built. For
example, using `{output}` means the caller must supply an output path.

Plugins are additive. A plugin ID may not replace a built-in, configured, or
earlier plugin runner. Invalid manifests and collisions produce field-specific
warnings and are skipped; other runners remain available.

## Completion contract

Campaigns appends an exact JSON completion marker to every step prompt. The
marker combines `completion.marker` with `run_id`, `step_id`, and
`invocation_id`. The worker must print that object as the final non-empty line
of its final response. Exit code zero without the matching identity is a failed
step.

`completion.sources` tells Campaigns where final-response text appears:

- `{ "kind": "text" }` reads raw stdout.
- `{ "kind": "jsonl", "match": {...}, "field": "a.dotted.path" }` reads
  matching JSONL events and extracts a string field.

Every `match` key is a dotted path and every value is compared exactly. Multiple
sources are checked in manifest order.

## Usage contract

`usage.sources` is optional. Each source reads one matching JSONL event and maps
CLI-specific dotted paths onto `input_tokens`, `output_tokens`, `total_tokens`,
and `cost_usd`. Token values must be non-negative integers; cost must be a
non-negative number. When input and output are present, Campaigns derives a
missing total. Every runner result event carries all four normalized fields,
using explicit `null` values when the CLI or plugin does not report them.

`--max-cost-usd` requires the selected worker, reviewer, and fix runner to have
a `cost_usd` field mapping. Campaigns refuses a runner without that mapping
before spawning it. A mapped runner should emit cost on every invocation; the
ledger sums the normalized values rather than estimating from token counts.

## Complete Gemini example

Directory:

```text
campaigns-runner-gemini/
└── campaigns-runner.json
```

`campaigns-runner.json`:

```json
{
  "schemaVersion": 1,
  "id": "gemini",
  "family": "google",
  "label": "Gemini CLI",
  "binary": "gemini",
  "args": [
    "--model", "{model}",
    "--approval-mode", "yolo",
    "--output-format", "json",
    "--prompt", "{prompt}"
  ],
  "prompt": { "delivery": "arg" },
  "defaults": { "model": "auto", "effort": "none" },
  "models": [
    { "id": "auto", "label": "Gemini Auto" }
  ],
  "efforts": [
    { "id": "none", "label": "CLI default" }
  ],
  "effortMap": {
    "extra-high": "none",
    "high": "none",
    "medium": "none",
    "low": "none"
  },
  "environment": { "remove": [] },
  "completion": {
    "marker": {
      "type": "campaigns.step_completed",
      "version": 1,
      "status": "completed"
    },
    "sources": [
      { "kind": "jsonl", "match": {}, "field": "response" }
    ]
  },
  "usage": {
    "sources": [
      {
        "kind": "jsonl",
        "match": { "type": "result" },
        "fields": {
          "input_tokens": "usage.input_tokens",
          "output_tokens": "usage.output_tokens",
          "cost_usd": "usage.cost_usd"
        }
      }
    ]
  }
}
```

Gemini's JSON headless output is one object whose `response` field contains the
final text. If a future CLI stream differs, change only `args` and
`completion.sources`; the completion marker itself stays unchanged.

Campaigns currently discovers only explicit `runnerPaths`. A future
`campaigns-runner-*` package-name convention may add package scanning, but no
npm scanning happens today.

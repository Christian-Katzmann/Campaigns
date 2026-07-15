# Campaign Markdown Specification v1

- Version: 1.0.0
- Status: Stable
- Published: 2026-07-15
- License: MIT (the repository license)

This document defines the portable campaign-plan subset understood by Campaigns v1. The words MUST, MUST NOT, SHOULD, and MAY are normative.

## Conformance model

Campaign Markdown has three deliberately separate layers:

1. `parseMarkdown()` is a tolerant Markdown reader. It MUST return blocks for ordinary Markdown and MUST NOT reject a document because it is not a runnable campaign.
2. `analyzePlanHealth()` is the v1 conformance gate. A runnable v1 plan MUST have no `error` findings. Warnings and information findings do not make a plan invalid.
3. The execution engine consumes the parser output. It MUST NOT introduce a second, incompatible Markdown grammar.

The conformance suite lives in `test/campaign-spec.test.mjs`; its documents live in `test/fixtures/campaign-spec/v1/`.

## File names

Campaigns-created files use `<slug>.campaign.md`. Conforming publishers SHOULD use that compound suffix because it identifies the file as a campaign without making it cease to be Markdown.

Legacy `<slug>.md` files MUST continue to open, lint, register, and run. In semantic names, both `launch.campaign.md` and `launch.md` have the stem `launch`.

## Document structure

A runnable v1 document MUST contain:

1. an H1 campaign title;
2. one `## Progress checklist` section containing one or more phases;
3. one H2 step section for every implementation checklist item;
4. one campaign-level final-review section.

Other Markdown MAY appear between these required parts. The parser also renders ordinary headings, paragraphs, blockquotes, lists, tables, horizontal rules, and fenced code blocks; those presentation blocks do not change execution semantics.

## Progress checklist

The checklist heading is an H2 whose text contains `Progress checklist`, case-insensitively. A phase is an H3 beneath it. The conventional numbered form is:

```markdown
### Phase 1 — Prepare
```

When the heading contains `Phase N`, the parser exposes `N` as the phase number. The remaining text is its display title.

A progress item uses a Markdown task-list line:

```markdown
- [ ] Step 1.1 — Draft the release
- [x] Step 1.2 — Verify the release
```

`-` and `*` bullets are parsed. A space means unchecked; `x` or `X` means checked. A v1 plan MUST have exactly one checklist item linked to every step section. The first unchecked item is the resume target.

The canonical step id is numeric `N.M`. IDs MUST be unique within the document. Step ranges and `x` placeholders remain display-compatible parser input but are not conforming runnable v1 ids.

## Step headings

Each implementation step MUST have one level-two heading:

```markdown
## Step 1.1 — Draft the release
```

`Step` is case-insensitive. The id MUST equal the matching checklist id. The text after the id is the step name.

## Step metadata

Metadata is read from the first five non-empty lines after the step heading. Scanning stops at the first non-empty line that is not a recognized metadata line. Recognized labels are case-insensitive and MAY appear in any order.

### Model

Every step MUST have a valid, non-empty `Model:` line. The first segment is primary; one alternate MAY follow `/`:

```text
Model: Fable 5 · Max / GPT-5.6-Sol · Extra High
```

Within a segment, the last `·`-separated part is the effort label. The legacy `Model name - Effort` form remains accepted. The output shape carries the first two `/`-separated segments; authors SHOULD NOT add more.

### Parallel

Every step MUST have a valid, non-empty `Parallel:` line:

```text
Parallel: NO
Parallel: YES — with Step 1.2
```

A value beginning with `YES` opts into parallel scheduling and collects numeric sibling step references. Parallel execution additionally requires reciprocal same-phase links and disjoint lanes. Any other non-empty value is parsed as non-parallel; conforming authors SHOULD write `NO`.

### Lane

`Lane:` is optional unless a step opts into parallel scheduling. It is a comma-separated list of backtick-quoted, repository-relative globs:

```text
Lane: `public/**`, `test/*.test.mjs`
```

Absolute paths, parent traversal, backslashes, prose outside the backticks, and malformed bracket expressions do not produce lane metadata. A parallel group without valid lanes is rejected by parallel-safety checks.

## Step prompt

The first fenced code block after a step heading and before the next H2 is the executable prompt. It MUST be non-empty and MUST contain an `ACCEPTANCE:` section. Fence language labels are descriptive and do not affect execution.

`SCOPE`, `REQUIRED READING`, `OUTPUT`, and `OPEN QUESTIONS` are recommended authoring sections. They are not parser tokens. `ACCEPTANCE` is the only required prompt section in the v1 health gate.

## Executable CHECK lines

A prompt MAY contain one or more executable checks. Each line starts with `CHECK:` and contains exactly one JSON object:

```text
CHECK: {"command":"npm test","expectedExit":0,"expectedOutput":"pass","timeoutMs":120000}
```

Fields:

| Field | Required | Type | Default |
| --- | --- | --- | --- |
| `command` | yes | non-empty string | — |
| `expectedExit` | no | non-negative integer | `0` |
| `expectedOutput` | no | string | no output assertion |
| `timeoutMs` | no | positive integer | `120000` |

Unknown fields and malformed values are conformance errors reported by plan health. They do not make the Markdown block parser reject the document.

## Final review

A v1 campaign has exactly one unchecked or checked campaign-level item:

```markdown
- [ ] Final review
```

It also has exactly one H2 section with a non-empty fenced review prompt:

````markdown
## Final review

```text
Review the completed campaign and return APPROVED or NEEDS WORK.
```
````

The final-review heading and checklist text are matched case-insensitively. Legacy per-phase final-review items remain readable but are not the v1 campaign-level release gate.

## Conformance examples

- `valid-minimal.campaign.md`: smallest conforming plan.
- `valid-full.campaign.md`: dual models, reciprocal parallel metadata, lanes, and executable checks.
- `invalid-missing-model.campaign.md`: rejected with `missing-model`.
- `invalid-malformed-check.campaign.md`: rejected with `invalid-check` while still parseable as Markdown.
- `invalid-unlinked-checklist.campaign.md`: rejected with `checklist-mismatch`.

## Compatibility

Consumers deriving a campaign slug, display-title fallback, worktree label, or run-directory prefix MUST use the shared compound-extension helper. Existing `.md` paths and already-created files are never renamed implicitly.

## Changelog

### 1.0.0 — 2026-07-15

- Published the first versioned grammar and conformance suite.
- Established `.campaign.md` as the creation default while preserving `.md` compatibility.
- Separated tolerant Markdown parsing from strict campaign-plan health.

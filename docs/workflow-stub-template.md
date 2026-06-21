# Workflow Stub & Map — the canonical template

The standard for `/workflow-map` output and the Campaigns **Workflows** tab input.
A *stub* (undrawn) and a *drawn map* are the **same file at two maturity levels** —
the inventory pass writes the stub; the draw pass enriches it in place.

> Eventual home: the `/workflow-map` skill (the producer). Kept here for now as the hub.

---

## 1. Placement IS the identity

A map lives at `docs/workflows/<…category path…>/<slug>.md`, **inside the repo it describes.**
Everything positional is **derived from that path, never stored** — storing it invites drift; placement can't lie:

- **repo** — walk up to the nearest `.git`
- **category path** — the folders between `docs/workflows/` and the file
- **slug** — the filename (the permanent address; copy-refs and node anchors hang off it)

**The folder path is the hierarchy**, rendered to whatever depth in the tab:
`docs/workflows/data/sync/full-sync.md` → `repo › Data › Sync › Pulling fresh numbers…`

**Depth rules** (keep it navigable — the tree's job is "find any flow in two clicks"):
- A category level earns its place only if it groups **≥ 3** children. A folder with one child is noise — collapse it.
- Cap at **Repo + 2 category levels + workflow.**
- **Ragged is fine** — depth follows density; not every branch nests the same.

---

## 2. The machine record — authored content only

Embedded as a ` ```json ` block. It **never** carries repo / category / slug (those are positional, §1).

| field | rule |
|---|---|
| `name` | plain, **action-first gerund**; names the real-world outcome, not the code; ≤ ~7 words; no jargon. The name is *refinable forever*; the slug is the permanent address. |
| `what` | **one sentence** a non-technical person *in this domain* can paraphrase back. Keep real proper-nouns they'd know (Jobindsats, MitID, CVR, Ankestyrelsen, DST); paraphrase pure tech (MCP → "external AI assistants", blob → "file storage"). Outcome-first, no code identifiers. Soft shape: *"The thing that [trigger] → [does what] → [concrete result]."* For a **gate** workflow, the sentence centers the *refusal*. |
| `kind` | one of `pipeline` \| `gate` \| `job` \| `ops` \| `serve`. Tells the drawing agent the map's centre of gravity, and lets the catalog filter (e.g. "show me all the gates"). `serve` = renders/returns a public artifact (SEO/GEO surfaces, embeds, shared read-only views). |
| `entry_points` | the **doors** — a *list* (one workflow can be reached by cron + CLI + UI). Enumerating heads is also how the inventory stays complete — never free-recall. |
| `ends_with` | the terminal outcome / artifact (the flow's boundary). |
| `key_files` | 1–4 spine files the drawing agent reads first. |
| `touches_risk` | matching `.adx/risks.json` id(s), or omit. A cheap fragility hint for draw-order. |
| `actor` | **facet** — array of who the flow serves / acts as: `citizen` \| `caseworker` \| `admin` \| `public` \| `system`. Answers "admin vs user" as a *filter*, never a folder. |
| `data_source` | **facet** — array of external sources the data comes from: `jobindsats` \| `dst` \| `cvr` \| `krl` \| `retsinfo` \| `internal` (`retsinfo` = retsinformation.dk, ast.dk). Answers "where do we retrieve data" across every feature. |
| `status` | `undrawn` → `drawn`. |

**Facets** (`kind`, `actor`, `data_source`) are controlled-vocabulary tags that cut *across* the folder tree — they power filtered views (all gates · all admin flows · everything touching CVR) that one hierarchy can't give. The folder path is the *home*; facets are the *filters*.

When drawn, `/workflow-map` **appends** `nodes[]` (each: `ref`, `m`, `label`, `color`, `plain`, predicates),
`score{}`, `rubric`, `generated_from`, and flips `status` to `drawn`. Same file, grown up.

---

## 3. What counts as one workflow (grain)

- A **path that changes state or produces an externally-meaningful outcome**, reasoned about as a unit.
  Calibrate to `ai/retrieval` (a question → grounded answer) and `packets/approval` (draft → signed artifact).
- The unit is the **orchestrator / outcome, not the route** — one workflow can have many doors.
- **Read-only / thin CRUD surfaces are NOT workflows.** Represent a widget family by its one state-changing
  member, or skip it. The library is every *meaningful flow*, not every route.

---

## 4. Discipline

A map is a **generated lens, not a maintained doc** — regenerate when the code changes; version history = git.
The same goes for the inventory itself. Don't hand-maintain it into staleness.

---

## 5. The stub file shape (undrawn) — worked example

The machine record is a fenced ` ```json ` block — **load-bearing**: the Campaigns
**Workflows** tab discovers a map by parsing that fence. A drawn map's fence carries
`nodes[]` + `score{}`; an undrawn stub's carries neither (no `nodes[]`, no `score{}`),
which is exactly how the tab knows to render it grey. No fence → the file is skipped.

````markdown
# Pulling fresh numbers from Jobindsats and DST

> **Domain:** sync · **Slug:** full-sync · **Kind:** job · **Status:** ⬜ undrawn
> The thing that twice a day fetches the latest figures from Jobindsats and
> Statistics Denmark, with safety brakes so it can't run twice at once, can't
> write a runaway number of rows, and never refetches all of history by accident.

**Starts at:** cron `GET /api/jobs/sync` (06:00 & 17:00) · CLI `npm run sync`
**Ends with:** updated measurement data → refreshed signals + snapshots + cleared caches
**Key files:** `src/lib/sync/orchestrator.ts`, `src/app/api/jobs/sync/route.ts`, `src/scripts/sync.ts`
**Touches risk:** `database-writes-and-schema`, `vercel-crons-and-production-config`
**Facets:** actor `system` · source `jobindsats` + `dst` · kind `job`

<!-- machine record — authored content only; repo/category/slug come from the file's location -->
```json
{
  "name": "Pulling fresh numbers from Jobindsats and DST",
  "what": "The thing that twice a day fetches the latest figures from Jobindsats and Statistics Denmark, with safety brakes so it can't run twice at once, can't write a runaway number of rows, and never refetches all of history by accident.",
  "kind": "job",
  "actor": ["system"],
  "data_source": ["jobindsats", "dst"],
  "entry_points": ["cron GET /api/jobs/sync (06:00 & 17:00)", "CLI npm run sync"],
  "ends_with": "updated measurement data → refreshed signals + snapshots + cleared caches",
  "key_files": ["src/lib/sync/orchestrator.ts", "src/app/api/jobs/sync/route.ts", "src/scripts/sync.ts"],
  "touches_risk": ["database-writes-and-schema", "vercel-crons-and-production-config"],
  "status": "undrawn"
}
```
````

# Architecture

Campaigns renders a markdown campaign plan as an execution board. The markdown
file on disk is the source of truth; the browser UI is an editor around that
file, not an independent store. Everything flows from one loop: the server reads
the `.campaign.md` (or legacy `.md`) file → the browser parses it into a data model → renders the board →
edits mutate the markdown string → a `baseHash`-guarded `PUT` writes it back to
disk. Nothing is persisted anywhere else except small per-file UI preferences in
`localStorage` and the campaign registry (`registry.json`).

No build step: the browser loads `public/app.js` as an ES module and imports the
rest directly. The server is a single `node server.mjs` with no runtime deps.

## Frontend (`public/`)

`app.js` is the entry only — state hydration, view routing (board / library /
fleet / workflows), and the global action + keyboard bindings. It wires the modules
together and owns no feature logic.

- `lib/parser.mjs` — pure markdown → data model: blocks, phases, step sections,
  check↔step linking, progress stats, final-review migration. No DOM; imported
  directly by the Node tests.
- `lib/campaign-file.mjs` — browser-safe filename semantics shared with Node;
  both `name.campaign.md` and legacy `name.md` resolve to the stem `name`.
- `lib/prefs.mjs` — pure preference defaults, sanitize, and theme normalization.
- `lib/fleet.mjs` — pure fleet grouping, row presentation, ETA/babysitting
  labels, and Kro-state mapping.
- `modules/state.mjs` — the shared `state` object, the `elements` handle cache,
  and the automation runtime snapshot + its predicates. Everything imports it.
- `modules/dom.mjs` — shared DOM helpers: `element()`, escaping, the toast, the
  focus trap, relative-time, the campaign-logo + copy-path helpers.
- `modules/render.mjs` — board rendering: the block/step/phase/prompt/review-card
  renderers and the `render()` entry, plus save-status, focus/filter, the mobile
  step bar, and the step observer.
- `modules/board.mjs` — board interactions and document IO: click/input dispatch,
  the check toggles, code edit, autosave + the `baseHash` conflict flow, export,
  open-a-file, and the resume card.
- `modules/library.mjs` — the campaign grid: cards, collections, park/delete/drag,
  quick filter, lessons, and the automation status a card shows.
- `modules/fleet.mjs` — the shared companion-state fleet view, 15-second refresh,
  and existing open/stop/nudge action bindings.
- `modules/switcher.mjs` — the topbar campaign dropdown.
- `modules/settings.mjs` — the settings drawer + notification preferences.
- `modules/automate-drawer.mjs` — the automation polling loop and drawer panel.
- `modules/away.mjs` — Away mode: the ETA model and the "step out for N minutes"
  planner + overlay.
- `modules/effects.mjs` — theme application, audio, confetti, the phase banner,
  and notification delivery.
- `modules/prefs-store.mjs` — the `localStorage` side of preferences (read/write,
  migrations, today/session progress).

Import direction runs one way: feature modules → `dom`/`state` → `lib`. `board`
imports `render`; nothing imports `board` except `app.js`.

The Workflows view (`workflows-v2.js`, `workflow-chart.js`, `workflows-v2.css`)
is a self-contained module wired to `GET /api/workflows`; it is independent of
the board and is not part of the split above.

## Backend (`server.mjs` + `lib/`)

`server.mjs` owns CLI flags, route dispatch, and the document/registry/automation/
companion/workflow/lessons handlers. It delegates to:

- `lib/registry.mjs` — registry read/write/normalize, the atomic file writer, and
  missing-campaign pruning (paths passed in; covered by `test/registry.test.mjs`).
- `lib/http.mjs` — `sendJson`, `readJsonBody`, `httpError`, `sendStatic`.
- `lib/lessons.mjs` — native unified-ledger discovery and learning-loop metrics.
- `lib/notifications.mjs` — macOS/ntfy/webhook delivery and the stop-watcher's
  pure alert classification.
- `lib/automate-providers.mjs`, `lib/companion-pets.mjs` — pre-existing.

Conflict safety is load-bearing: `PUT /api/document` requires the client's
`baseHash`; a mismatch returns `409` so no concurrent edit is silently
overwritten. All writes go through the atomic temp-file-and-rename writer.

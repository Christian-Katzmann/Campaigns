# Campaigns

A local reader/editor for any markdown campaign plan. Open the file as
an interactive board: tick checks, copy prompts, navigate step-by-step,
review each step and phase.

## Run

```sh
node server.mjs --file path/to/your-campaign.md
```

Then open the URL it prints (defaults to `http://localhost:4178`).

Flags:

- `--file <path>` (required) — markdown file to open.
- `--port <number>` — defaults to `4178`.

Or via env:

- `CAMPAIGN_FILE=path/to/file.md` (instead of `--file`).
- `PORT=4179` (instead of `--port`).

## What the app expects

Any markdown opens. These conventions unlock more of the UI:

### Structure

- **`## Progress checklist`** — H2 with `### Phase N — Title` H3s and `- [ ]`
  checkboxes underneath. Drives phase grouping, filter chips, progress count.
  The descriptive title (after the em-dash) becomes the phase's chapter mark.
- **`## Step N.M — name`** step headings — linked from checks, navigable
  with `←` / `→` / `A` / `D`, gain a "Complete & next" button at the bottom.
  Each step also gets an auto-rendered REVIEW card.
- **All other H2 sections before the progress checklist** — wrap into
  collapsible `<details>` sections. Sections whose heading matches
  `/review protocol|codex grades/i` default closed; everything else defaults
  open. Open/closed state persists per section.

### Review templates

The app auto-detects two fenced code blocks anywhere in the document and uses
them to populate per-step and per-phase REVIEW cards:

- A code block containing `<STEP>` (and not `<PHASE>`) → **per-step review
  template**. Each step's REVIEW card substitutes `<STEP>` with that step's
  number on copy.
- A code block containing `<PHASE>` (and not `<STEP>`) → **per-phase review
  template**. The PHASE N REVIEW card at the end of each phase substitutes
  `<PHASE>` with that phase's number.
- `<STEP>` and `<PHASE>` are **reserved** tokens — they don't show up in
  the placeholder bar.

### Phase gates

- Each phase's checklist should end with `- [ ] Final review — Phase N`.
  This closes the phase: clicking it (or the "Close Phase N" button under
  the phase review card) toggles the line and advances.
- If the line is missing, the app auto-adds it on first load and shows a
  one-time toast.

### Other

- **`<UPPERCASE_TOKENS>`** (other than `<STEP>`/`<PHASE>`) — get an editable
  fill bar in the prompt card; copies use the substituted text.
- **Fenced code blocks** — collapse by default; chevron + Copy + Edit stay
  visible.
- **Completed steps** — collapse to a faint-green compact summary; expand
  to see description + impl prompt. Review card stays hidden.

Everything else just renders as markdown.

## Producing campaigns

The `/campaign-planner` skill produces files matching all the above
conventions. See `~/.claude/skills/campaign-planner/`.

## State per file

Each open file has its own filters, phase collapse, placeholder values,
doc-section open/closed states, expanded code-block keys, theme, feedback,
notification settings, and last-session memory, scoped by the file's absolute
path in `localStorage`.

## Notifications

Preferences can send quiet completion alerts when a phase or campaign closes.
Mac alerts use the local `/api/notify` endpoint. iPhone push uses an ntfy.sh
topic, and team pings use Slack or Discord webhooks through `/api/push`.

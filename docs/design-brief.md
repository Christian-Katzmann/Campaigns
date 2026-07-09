# Campaigns — Design Exploration Brief

Paste this into Claude Design as the project brief, attach the five screenshots
described in **Screenshots to attach** below, and point it at the design system you
want to try. The goal is **visual direction exploration**, not a faithful port —
explore freely, but keep the things under "Hold" intact so the result is still
Campaigns and stays cleanly implementable afterward.

## What Campaigns is

A **local, single-user** app that turns a markdown plan into a calm execution board
for AI-assisted projects: phases, checklists, prompt cards, progress, and a library
of plans you switch between. It runs on your own machine, reads and writes local
markdown, and pairs with AI agent skills that generate plans.

**The one load-bearing idea:** the markdown file is the source of truth. The UI is a
calmer surface *around* the file — never a second database. Editing in the UI edits
the file; the file can change under it. This is why "done", "resume", and conflict
states matter so much.

**Mood:** reading-first, document-like, low-chrome, unhurried. One person executing a
plan, not a team dashboard. It should feel like a good writing app, not a project
manager.

## The surfaces (each has ONE job)

1. **Board** — *shots 2–4* — the main screen. Render one campaign as an execution
   board you work top-to-bottom: sticky low-chrome topbar; a left overview rail
   (progress + Resume); the document body of context sections → progress checklist →
   phases → steps → prompt cards → final-review. *Job: make executing the next step
   obvious and calm.*

2. **Mobile step flow** — *no shot in this set; described here* — the same content
   reflowed for phone. The current step and a bottom navigation bar stay reachable;
   you move step-by-step. *Job: one step at a time, thumb-reachable, without changing
   the markdown model.*

3. **Library** — *shot 1* — "All campaigns": a grid of campaign cards split into
   **collapsible shelves** (active up top, a collapsed **Sleeping** shelf, a large
   **Finished** archive), plus **campaign stacks** (one card that collects several
   related campaigns under a count badge) and a "lessons" evidence surface from past
   automation runs. *Job: pick or resume the right plan fast, across hundreds of them.*

4. **Companion** — *no shot; described here* — a separate **compact floating window**.
   A small mascot with a status signal, a count of campaigns needing attention, an
   Active/All filter, and an "Open App" button. Always-on, glanceable. *Job: ambient
   at-a-glance status.*

Two supporting overlays: a **Settings / Preferences drawer** (*shot 5* — theme picker,
sound/feedback toggles, notification setup) and a right-side **Automation drawer**
(live activity feed). Both slide in over a dimmed/scrim board.

## Component anatomy (the repeating pieces)

- **Context sections** — collapsible disclosure rows at the top of a campaign (Scope,
  Context, execution contract, "How prompts work"). Quiet until expanded.
- **Progress checklist** — a `Todo · In flight · Done` legend, then phases.
- **Phase** — a numbered circle + eyebrow (`PHASE 1`) + title (`Hiring-now demand
  layer`), with an `X / N` count and a completion control. Phases contain steps.
- **Step** — a heading (`Step 1.1 — …`) followed by **agent pills** (which agent +
  thinking effort, e.g. `CC Opus 4.8 · Extra High` / `CX GPT-5.6-Sol · Extra High`) and a
  **SEQUENTIAL / PARALLEL** tag, a short description, and the prompt card.
- **Prompt card** — a fenced, monospace block holding the agent prompt, with a header
  (`PROMPT`), a one-click **copy**, and **Edit**. Collapsible. This is the hero — the
  thing users actually act on.
- **Step action** — a primary **Complete & next** button; heavy section rules like
  **BEGIN EXECUTION** separate orientation from execution.
- **Final-review card** — a distinct **closure card** (accent top border, eyebrow
  `FINAL REVIEW`, "Close out the campaign") holding the whole-plan grading prompt.
- **Progress** — a track + fill bar and an "X of Y done" label, in the overview rail
  and on every library card.
- **Resume** — a button that previews and jumps to where you left off.
- **Library card** — logo, title, file path, progress bar (or **All done**), last-active
  time, and status icons (sleep/moon, scheduled-warning, stats, copy, trash).
- **Stack card** — a count badge + stacked-paper look; "N campaigns collected".

## States that must survive a redesign

Design these, not just the happy path:

- **Empty** library (no campaigns yet) with a helpful onboarding nudge.
- **In-progress vs. complete** — steps, phases, and whole campaigns. Completion must
  read at a glance (today: a distinct green "done" treatment, library cards flip to
  **All done**).
- **Campaign stacks** — several campaigns collected under one card + count.
- **Sleeping vs. Finished** — collapsible shelves that keep a 200+ archive out of the way.
- **Resume** — "where was I".
- **Final-review / closure** — the campaign-level grade card shown before the box is ticked.
- **Conflict** — the file changed on disk; a modal asks before overwriting.
- **Automation active** — an indicator + status line when an agent is running a campaign.
- **Focus** mode — strips chrome to just the work.
- **Feedback moments** — a phase-complete banner, toasts, an optional small completion
  burst / confetti. The product has personality here; keep it tasteful.
- **Save status** — no changes / saving / saved.

## Today's visual language (what you're moving away from)

Warm paper-and-ink editorial: white page, near-black ink, warm grays, hairline rules, a
single blue accent, a green "done" family, one soft large shadow. Large reading type
(~19px, generous line-height), Inter + SF Mono. It's already **token-driven** with four
swappable themes (Desk, Carbon Ledger, Blueprint Room, Signal Paper). Calm and
competent — but safe. You're free to leave this entirely behind.

## Hold vs. Vary

**HOLD (don't break — keeps it Campaigns + implementable):**
- Markdown-as-source-of-truth; the UI stays a surface, never adds fields the file can't hold.
- The four surfaces and their jobs (board / mobile step flow / library / companion).
- The phase → step → checklist → **prompt card (with copy)** structure, and the
  **final-review** closure step.
- Legible complete-vs-incomplete; visible progress + resume; the library's
  active/sleeping/finished + stacks structure (it scales to hundreds).
- Accessibility: live-region announcements, keyboard reach, real focus states.
- A **token-driven** result (color/type/space/shape as variables) so a new skin swaps cleanly.

**VARY (go wild — this is the exploration):**
- Whole visual language: color, type personality, density, shape, depth, texture.
- How "progress", "done", and "resume" *feel* — the emotional payoff of finishing.
- The prompt card's treatment (it's the hero interaction — make it want to be clicked).
- Topbar / chrome treatment and overall information density.
- The library: how stacks, the sleeping shelf, and a huge finished archive are expressed.
- The companion mascot's personality and the feedback/celebration character.
- Motion: how things settle, check off, and transition; the drawer/scrim overlay feel.

## Real vocabulary to use in mockups (avoid lorem ipsum)

Use the real chrome — see the screenshots for live examples. Library: "All campaigns",
"Sleeping campaigns", "Finished campaigns", "N campaigns collected", "All done", "Active
4d ago". Overview: "Progress", "0 of 3 done", "Resume", "Saved …". Topbar: "Switch",
"Open .md", "Export", "Focus", "Companion", "Save file". Document: "Scope", "Progress
checklist", legend "Todo · In flight · Done", "Phase 1 — …", "Step 1.2 — …", agent pills
"CC Opus 4.8 · Extra High" / "CX GPT-5.6-Sol · Extra High", "SEQUENTIAL", "PROMPT", "Edit",
"Complete & next", "BEGIN EXECUTION", "FINAL REVIEW", "Close out the campaign". Settings:
"Preferences", "Appearance / Feedback / Notifications / Diagnostics", "Sound", "Completion
burst", "Mac alerts", themes "Desk · Carbon Ledger · Blueprint Room · Signal Paper".

## Screenshots to attach

1. **Library** — the full campaign library: an in-progress campaign (progress bar
   `5/9`), a **stack** card with a count badge, a collapsed **Sleeping campaigns** shelf,
   and an expanded **Finished campaigns** archive of "All done" cards with status icons.
   Shows the empty → in-progress → done range and how it scales to hundreds.
2. **Board (campaign top)** — overview rail (progress + Resume), title + intro,
   collapsible context sections, the **Progress checklist** with the Todo/In flight/Done
   legend, Phase 1 with its steps and the dashed final-review row, the BEGIN EXECUTION rule.
3. **Inside a step** — the numbered **phase header**, a step heading with its **agent
   pills** and SEQUENTIAL tag, the **prompt card** (PROMPT / copy / Edit / monospace body),
   and the **Complete & next** button. This is the hero interaction.
4. **Final-review / closure** — a later step (collapsed prompt) plus the accent-bordered
   **"Close out the campaign"** final-review card holding the whole-plan grading prompt.
5. **Settings drawer** — the **Preferences** drawer (Appearance/theme, Feedback toggles,
   Notifications, Diagnostics) over a **dimmed/scrim** board — also the reference for the
   overlay pattern.

## Short prompt to paste alongside this brief

> Use the **[NAME] design system** I've pointed you at. Here's the brief and five
> screenshots of the current app (1 library with stacks/sleeping/finished, 2 board, 3
> inside a step with its prompt card, 4 the final-review card, 5 the settings drawer).
> Don't copy today's look — give me **one distinct visual direction** for re-skinning
> Campaigns, respecting the "Hold" list but freely reinventing everything under "Vary".
> Start with the **Board** screen; once I like it, extend the same direction to the
> Library (with its stacks/sleeping/finished shelves), the step + prompt card, the
> final-review card, and the Settings drawer. Use the real vocabulary from the brief and
> screenshots, not placeholder text.

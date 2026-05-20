# Ideas — UX features that would lessen cognitive load

Working notes. The frame is calm computing — the app fades, the work stays foreground.

## Shipped

Most of these emerged from working with the trust-primitive-propagation campaign in production rather than from the original list. They're the dominant cognitive-load wins and they all earned their place by removing real friction.

- **Collapsible prompt cards** — every fenced code block defaults to collapsed. Toolbar (chevron + Copy + Edit) stays visible.
- **Per-step REVIEW card** with auto-substituted `<STEP>` — one click per step, no scroll-back to find the template, no hand-substitution.
- **Per-phase PHASE N REVIEW card** with auto-substituted `<PHASE>` — at the end of each phase. Visually distinct (accent ring) until closed; turns green when its FINAL REVIEW gate is checked.
- **"Close Phase N" button** — under each phase review card; toggles the FINAL REVIEW + scrolls to next phase.
- **FINAL REVIEW phase gates** — `- [ ] Final review — Phase N` per phase in the checklist; uppercase accent styling with dashed separator above. Auto-migration adds them if missing.
- **Phase chapter marks** — black circle with phase number on a thick line, eyebrow + descriptive title centered.
- **"Begin execution" work divider** — a single thick-bordered "Begin execution" gate between the passive checklist and the active steps.
- **Compact completed-step view** — faint green, collapsed to a one-line summary with checkmark; expandable to see description + impl prompt. Review card stays hidden.
- **Collapsible top-level doc sections** — every H2 between the H1 and the progress checklist becomes a `<details>`. Default open for Scope/Context/How prompts; default closed for Review protocol (heuristic by heading text). State persists.
- **Reserved-token logic for `<STEP>` and `<PHASE>`** — the app auto-substitutes; they don't appear in the placeholder bar.
- **/campaign-planner skill updated** to produce all of the above by default.
- **Quiet completion notifications** — optional Mac alerts, ntfy iPhone push, and Slack/Discord webhooks. Reserved for phase/campaign completion so the app does not become noisy.
- **Preferences drawer** — theme, sound, completion burst, and notification settings live off the main work surface.

## Probably worth building next

- **NEEDS WORK loop button** — when Codex returns NEEDS WORK, generate the follow-up Claude prompt that points at the review file and asks Claude to close the gaps. Set the step's state visibly to needs-work (different colour from in-flight). The protocol is described in prose at the top of the campaign — it isn't enacted. *Held for a later version per Christian.*

## Tier 2 — build if you find yourself wanting them

- **Cmd+K palette by S-ID or batch name** — moderate frequency, but each lookup costs ~10–20s today. Standard cmd+K affordance.
- **Auto-derived batch-weight badge** — count S-IDs per step → "tiny / medium / heavy". Decision-aiding for "I have 30 minutes" moments.
- **Receipt sync from target repo** — read each batch's receipt file inline on the step, configured per campaign. Receipts written elsewhere are invisible from the app today.
- **Pre-flight existence check** — verify referenced plan files exist before paste, warn if stale. Catches paste-and-fail before you burn a Claude session.
- **Per-step parking-lot note** — small notes field per step for thoughts that don't belong in the prompt or receipt.

## Tier 3 — speculative

- **Visual S-ID coverage map** — grid of all S-IDs from the synthesis, click to jump to owning batch. Beautiful audit artifact at the end of a campaign.
- **Per-batch elapsed-time tracking** — data without an immediate use; skip unless forecasting becomes a felt need.
- **Daily journal auto-append** — at session end, append a one-liner. Worth it only if you actually re-read journals.

## Considered and declined

- **Three-state checkbox (not started / in flight / approved)** — declined; binary checkbox kept. The phase-level FINAL REVIEW gate now covers a similar role at a higher level.
- **Resume-with-context (last-session story)** — declined; "more context = more cognitive load."
- **Standing quality-bar card** — declined; "adds more complexity."

## Anti-recommendations (still standing)

These look productive but are wrong school for this work:

- **Streaks / activity heatmaps / achievement badges.** Optimizes return-visits-to-app, not return-visits-to-work.
- **Daily reminders.** A 41-batch ministry-grade campaign is not a habit app. Completion notifications are different: they close a loop after work finishes.
- **Detailed analytics dashboards** ("velocity," "burndown"). The progress bar already shows what matters.
- **Pomodoro / session timer.** Paternalistic.
- **Auto-grade Claude's work.** Outsources the discipline. The standing review-card pattern protects the discipline; replacing the user's grade does the opposite.

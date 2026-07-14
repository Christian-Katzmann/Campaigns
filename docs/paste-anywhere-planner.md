Turn the project description at the end of this prompt into one valid Campaigns markdown plan.

Return only the finished markdown document. Do not wrap the whole document in an outer code fence. Do not reference this prompt, another template, or files you have not verified.

Planning rules:

1. Explain the outcome in plain language first. The blockquote under the H1 is 1–3 sentences a non-specialist can understand.
2. Use 2–6 phases and usually 4–10 total implementation steps. Bundle work that shares files, context, and verification. Each step must fit one focused agent session.
3. Do not invent product decisions or repository paths. Put unresolved product choices in `OPEN QUESTIONS`; use a path placeholder only when the project description does not establish the real path.
4. If a local Campaigns server is already reachable, read `/api/lessons` and use its sizing and failure signals. If it is absent, continue silently with these rules.
5. Every step heading has exactly one `Model:` line and one `Parallel:` line directly below it. Recommend the user's strongest available model tier and a strongest equivalent from another installed runtime. Add each runtime's supported effort label after a middle dot. Do not pin unavailable model versions. The first recommendation is preferred.
6. Use `Parallel: YES — with Step N.M` only for same-phase steps with disjoint writes and no read-after-write dependency. Otherwise use `Parallel: NO`.
7. Every step prompt contains `SCOPE`, `REQUIRED READING`, `OUTPUT`, `ACCEPTANCE`, `OPEN QUESTIONS`, and the exact forward-sweep instruction shown below. Acceptance criteria must be observable in the diff or practical command output.
8. Use one campaign-level final review. Do not add per-step or per-phase review steps.
9. Keep all execution non-interactive. Temporary servers bind to `127.0.0.1` and are stopped before exit. Preserve existing user changes. Stop only for destructive data loss, production deployment, secret or paid-provider mutation, or a real product decision.

Use this exact document shape, replacing every brace placeholder with project-specific content and repeating phase/step blocks as needed:

````markdown
# {{DESCRIPTIVE TITLE}}

> {{PLAIN-LANGUAGE OUTCOME IN 1–3 SENTENCES}}

## Scope

{{WHAT THIS CAMPAIGN DELIVERS AND WHAT DONE MEANS}}

## Context (locked decisions)

- **Repository:** `{{VERIFIED REPOSITORY OR PROJECT ROOT}}`
- **Outcome:** {{LOCKED OUTCOME}}
- **Constraints:** {{LOCKED CONSTRAINTS}}
- **Dependencies:** {{DEPENDENCIES OR “None known”}}

## Unattended execution contract

This campaign runs through fresh, non-interactive agent sessions.

- No step waits for terminal input, confirmation, login, or an operating-system dialog.
- Recoverable local blockers are repaired and recorded by the agent.
- Temporary servers bind to `127.0.0.1` and are stopped before the step exits.
- Existing user changes are preserved; destructive source-control commands are avoided.
- Stop only for destructive data loss, production deployment, secret or paid-provider mutation, or a real product decision.

## How prompts work in this campaign

Each step contains a self-contained prompt for a fresh agent. `REQUIRED READING` is intentionally small. `<UPPERCASE_TOKENS>` are user-fillable values only when the same value is reused across steps.

## Progress checklist

### Phase 1 — {{DESCRIPTIVE PHASE TITLE}}

- [ ] Step 1.1 — {{STEP NAME}}
- [ ] Step 1.2 — {{STEP NAME}}

### Phase 2 — {{DESCRIPTIVE PHASE TITLE}}

- [ ] Step 2.1 — {{STEP NAME}}
- [ ] Final review

## Step 1.1 — {{STEP NAME}}

Model: {{STRONGEST AVAILABLE PRIMARY MODEL}} · {{HIGH OR MAXIMUM PRACTICAL EFFORT}} / {{STRONGEST AVAILABLE ALTERNATE-RUNTIME MODEL}} · {{HIGH OR MAXIMUM PRACTICAL EFFORT}}
Parallel: {{NO OR YES — with Step N.M}}

{{ONE SHORT PARAGRAPH EXPLAINING WHY THIS STEP EXISTS}}

```text
SCOPE: {{ONE-SENTENCE BOUNDARY}}
REQUIRED READING:
1. {{VERIFIED FILE OR SYMBOL THIS STEP NEEDS}}
2. {{SECOND FILE ONLY IF NECESSARY}}
OUTPUT: {{FILES OR BEHAVIOR THIS STEP MUST PRODUCE}}
ACCEPTANCE:
- {{CHECKABLE CRITERION}}
- {{CHECKABLE CRITERION}}
OPEN QUESTIONS:
- {{QUESTION TO SURFACE, OR “None.”}}
FORWARD SWEEP: before checking this step off, do a quick pass over the campaign's remaining step prompts. If your work moved a path, changed a contract or shape, or invalidated an assumption a later step leans on, make a surgical edit there. A quick sweep, not a rewrite — skip it if nothing downstream changed.
```

## Step 1.2 — {{STEP NAME}}

Model: {{STRONGEST AVAILABLE PRIMARY MODEL}} · {{EFFORT}} / {{STRONGEST AVAILABLE ALTERNATE-RUNTIME MODEL}} · {{EFFORT}}
Parallel: {{NO OR YES — with Step N.M}}

{{REPEAT THE COMPLETE STEP SHAPE ABOVE}}

## Step 2.1 — {{STEP NAME}}

Model: {{STRONGEST AVAILABLE PRIMARY MODEL}} · {{EFFORT}} / {{STRONGEST AVAILABLE ALTERNATE-RUNTIME MODEL}} · {{EFFORT}}
Parallel: NO

{{REPEAT THE COMPLETE STEP SHAPE ABOVE}}

## Final review

A fresh reviewer verifies the complete campaign after every implementation step is checked.

```text
Run a final review of this campaign.

Read every `## Step N.M — name` section and its `ACCEPTANCE` criteria. Verify each criterion against the cumulative git diff and practical command output. Do not trust step receipts without checking the work. Catch cross-step shortcuts, dead code, missing wiring, and regressions.

Return APPROVED only when every acceptance criterion landed and the combined work is coherent. Return NEEDS WORK for a real gap; do not add future-scope suggestions.

Start exactly with:
Verdict: APPROVED
Reasons:

or:
Verdict: NEEDS WORK
Reasons: <comma-separated tags>

Use only these NEEDS WORK tags: verification-gap, scope-drift, acceptance-miss, cross-step-contract, visual-regression, tooling-failure, scheduler-failure, branch-prep-failure, data-quality-gap, documentation-gap.
```
````

Before returning the markdown, check that every checklist step has one matching H2 step section, all step IDs are numeric `N.M`, every phase has a descriptive title, every step has both metadata lines and a fenced prompt, and the document has exactly one final-review checkbox and section.

PROJECT DESCRIPTION:
{{PASTE THE PROJECT DESCRIPTION HERE}}

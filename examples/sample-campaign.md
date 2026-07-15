# Sample launch campaign

> A tiny example campaign for trying Campaigns without bringing your own plan.

## Scope

Ship a small public note in three calm steps: draft it, review it, and publish it.

## Context (locked decisions)

- Keep the note short.
- Use one final review at the end instead of reviewing every step.
- Treat the markdown file as the source of truth.

## How prompts work in this campaign

Each step has a fenced prompt you can copy into an agent session. The checklist above the steps drives progress in the Campaigns app.

## Progress checklist

### Phase 1 - Draft and publish

- [ ] Step 1.1 - Draft the note
- [ ] Step 1.2 - Tighten the note
- [ ] Step 1.3 - Publish the note
- [ ] Final review

## Step 1.1 - Draft the note

Model: GPT-5.6-Sol - High
Parallel: NO

Write the first version.

```text
SCOPE: Draft a short public note about a small thing you learned.
OUTPUT: A draft note in plain markdown.
ACCEPTANCE:
- The draft states one useful idea in plain language.
OPEN QUESTIONS:
- What is the one useful idea the reader should keep?
```

## Step 1.2 - Tighten the note

Model: GPT-5.6-Sol - High
Parallel: NO

Cut anything that does not help the reader.

```text
SCOPE: Edit the draft for clarity and brevity.
OUTPUT: A sharper note.
ACCEPTANCE:
- The revised note is clear, concise, and keeps the original useful idea.
OPEN QUESTIONS:
- Is the opening sentence doing real work?
```

## Step 1.3 - Publish the note

Model: GPT-5.6-Sol - High
Parallel: NO

Put the note where readers can find it.

```text
SCOPE: Prepare the final note for publishing.
OUTPUT: Published URL or a ready-to-paste final draft.
ACCEPTANCE:
- The note is published or ready to paste without further editing.
OPEN QUESTIONS:
- Which surface fits the note best?
```

## Final review

Run one campaign-level review before closing the campaign.

```text
Read the three completed steps and decide whether the note is ready.

APPROVED if the note is clear, short, and publishable.
NEEDS WORK if the note still has a concrete gap.
```

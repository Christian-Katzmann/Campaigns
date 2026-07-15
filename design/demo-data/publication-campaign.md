# Public launch guide

> Turn a rough internal workflow into a public guide another developer can run without knowing the original project.

## Scope

Publish a small local-first workflow guide with a clear install path, proof that it works, and one final review before release.

## Context (locked decisions)

- Keep the source in markdown so the guide can be edited in any text editor.
- Use one final review at the end instead of reviewing every step.
- Treat screenshots as product proof, not decoration.
- No hosted demo until the workflow can run safely without writing shared visitor data.

## How prompts work in this campaign

Each implementation step has a fenced prompt that can be copied into an agent session. The checklist is the progress ledger.

## Progress checklist

### Phase 1 - Prepare the guide

- [x] Step 1.1 - Draft the installation path
- [ ] Step 1.2 - Capture the product proof
- [ ] Step 1.3 - Tighten the release notes
- [ ] Final review

## Step 1.1 - Draft the installation path

Model: GPT-5.5 - High
Parallel: NO

Write the first public install path.

```text
SCOPE: Explain how a developer clones, installs, and runs the workflow locally.
OUTPUT: A quickstart that works in under five minutes.
ACCEPTANCE:
- A developer can follow the quickstart from clone to a running workflow.
OPEN QUESTIONS:
- Which prerequisite is easiest to miss?
```

## Step 1.2 - Capture the product proof

Model: GPT-5.5 - High
Parallel: NO

Show the workflow working.

```text
SCOPE: Capture the smallest screenshot or recording that proves the workflow is real.
OUTPUT: One hero image plus a one-sentence caption.
ACCEPTANCE:
- The visual and caption prove the workflow's core result at a glance.
OPEN QUESTIONS:
- What should the first-time visitor understand before reading the README?
```

## Step 1.3 - Tighten the release notes

Model: GPT-5.5 - High
Parallel: NO

Cut unclear claims.

```text
SCOPE: Make the release notes concrete and low-hype.
OUTPUT: Final release copy ready for the README.
ACCEPTANCE:
- Every release claim is concrete and supported by the guide or product proof.
OPEN QUESTIONS:
- Which claim needs evidence?
```

## Final review

Run a whole-guide review before publishing.

```text
APPROVED if the guide is installable, honest, and supported by real product proof.
NEEDS WORK if the install path, screenshot, or final claim is still vague.
```

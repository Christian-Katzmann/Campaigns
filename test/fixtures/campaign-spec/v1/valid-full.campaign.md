# Full campaign

> A conformance fixture covering the complete v1 execution core.

## Progress checklist

### Phase 1 — Build

- [ ] Step 1.1 — Write the artifact
- [ ] Step 1.2 — Verify the artifact
- [ ] Final review

## Step 1.1 — Write the artifact

Model: Fable 5 · Max / GPT-5.6-Sol · Extra High
Parallel: YES — with Step 1.2
Lane: `output/write.txt`

```text
SCOPE: Write the fixture artifact.
REQUIRED READING:
1. README.md
OUTPUT: Create output/write.txt.
ACCEPTANCE:
- output/write.txt contains the fixture value.
OPEN QUESTIONS:
- None.
CHECK: {"command":"test -f output/write.txt","timeoutMs":5000}
```

## Step 1.2 — Verify the artifact

Model: Fable 5 · Max / GPT-5.6-Sol · Extra High
Parallel: YES — with Step 1.1
Lane: `output/verified.txt`

```text
SCOPE: Verify the fixture artifact.
OUTPUT: Create output/verified.txt.
ACCEPTANCE:
- output/verified.txt records the verification.
CHECK: {"command":"test -f output/verified.txt","expectedExit":0,"expectedOutput":"","timeoutMs":5000}
```

## Final review

```text
Review both completed steps and return APPROVED or NEEDS WORK.
```

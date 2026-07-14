# Hello run

> A two-step real-agent smoke test for `campaigns run`.

## Progress checklist

### Phase 1 — Make the proof

- [ ] Step 1.1 — Write the greeting
- [ ] Step 1.2 — Verify the greeting
- [ ] Final review

## Step 1.1 — Write the greeting

Model: Claude Opus · Max
Parallel: NO

```text
Create hello-output/greeting.txt with exactly this line, including its final newline:
Hello from Campaigns.

Verify the file content, then commit only that file with commit message "Add hello greeting".
```

## Step 1.2 — Verify the greeting

Model: Claude Opus · Max
Parallel: NO

```text
Read hello-output/greeting.txt and verify it contains exactly "Hello from Campaigns." plus a final newline.
Create hello-output/verified.txt with exactly this line, including its final newline:
Greeting verified.

Verify both files, then commit only hello-output/verified.txt with commit message "Verify hello greeting".
```

## Final review

Confirm both proof files contain exactly the requested text and the run ledger is awaiting review.


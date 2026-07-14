# Hello run

> A two-step real-agent smoke test for `campaigns run`.

## Progress checklist

### Phase 1 — Make the proof

- [ ] Step 1.1 — Write the greeting
- [ ] Step 1.2 — Verify the greeting
- [ ] Final review

## Step 1.1 — Write the greeting

Model: Claude Opus · High
Parallel: NO

```text
SCOPE: Write the exact greeting proof file.
OUTPUT: Create hello-output/greeting.txt with exactly the required text.
ACCEPTANCE:
- hello-output/greeting.txt contains exactly "Hello from Campaigns." plus a final newline.
CHECK: {"command":"node -e \"const fs = require('node:fs'); if (fs.readFileSync('hello-output/greeting.txt', 'utf8') !== 'Hello from Campaigns.\\n') process.exit(1)\"","timeoutMs":10000}

Create hello-output/greeting.txt with exactly this line, including its final newline:
Hello from Campaigns.

Verify the file content, then commit only that file with commit message "Add hello greeting".
```

## Step 1.2 — Verify the greeting

Model: Claude Opus · High
Parallel: NO

```text
SCOPE: Verify the greeting and write the verification proof file.
OUTPUT: Create hello-output/verified.txt without changing the greeting.
ACCEPTANCE:
- Both proof files contain exactly their requested line plus a final newline.
CHECK: {"command":"node -e \"const fs = require('node:fs'); const ok = fs.readFileSync('hello-output/greeting.txt', 'utf8') === 'Hello from Campaigns.\\n' && fs.readFileSync('hello-output/verified.txt', 'utf8') === 'Greeting verified.\\n'; if (!ok) process.exit(1)\"","timeoutMs":10000}

Read hello-output/greeting.txt and verify it contains exactly "Hello from Campaigns." plus a final newline.
Create hello-output/verified.txt with exactly this line, including its final newline:
Greeting verified.

Verify both files, then commit only hello-output/verified.txt with commit message "Verify hello greeting".
```

## Final review

```text
Confirm both proof files contain exactly the requested text and the run ledger is awaiting review.
```

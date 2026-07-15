# Security policy

## Supported versions

Security fixes target the current release and `main`. Older releases are not
maintained separately. Campaigns is a local application, not a hosted service,
so this project does not operate or monitor users' installations.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Include the
affected version, impact, reproduction steps, and any suggested fix. If private
reporting is unavailable, open a minimal issue asking for a private contact
channel; do not publish exploit details or secrets.

Runner CLI vulnerabilities belong to that runner's project unless Campaigns'
invocation, persistence, or containment makes them exploitable. Reports about
that boundary are in scope here.

## Local-first network stance

Campaigns binds to `127.0.0.1` by default (`server.mjs`, `runCli()`). Its HTTP
API is a single-user local control plane: it has no login, authorization layer,
TLS termination, or cross-origin request protection. It can read and update
campaign files, start and stop agent runs, manage worktrees, and delete files
through the UI.

`CAMPAIGNS_HOST` and then `HOST` override the loopback address. Setting either
to `0.0.0.0`, a LAN address, or another non-loopback interface exposes that
control plane to hosts that can reach the port. Do not expose it directly to a
LAN, tunnel, container network, or the internet. If remote access is required,
put Campaigns behind authentication, TLS, and network access control that you
operate and trust.

## Autonomous runner permissions

Campaigns launches the configured runner CLI; it does not sandbox that CLI. The
bundled defaults are deliberately powerful:

- Claude uses `--permission-mode bypassPermissions`.
- Codex uses `approval_policy="never"` and `-s danger-full-access`.

Those modes allow unattended work, but the runner can act with the operating
system and network access of the user who started Campaigns. Worktree and cwd
containment do not change that fact.

Users may replace a bundled runner definition in project, user, explicit, or
environment-backed configuration with a more restrictive argument set supported
by their installed CLI. Runner definitions replace as a whole, so copy the full
definition and change its permission/sandbox arguments. Confirm the result with
`campaigns config doctor` before running valuable repositories.

## What Campaigns does protect

- Resolves the campaign and worker cwd against the selected Git repository.
- Uses dedicated Git worktrees by default; `--no-worktree` opts out.
- Starts Unix runners in a process group so stop requests can terminate descendants.
- Uses argument arrays rather than shell command strings.
- Atomically writes registry, campaign, and run-state files.
- Redacts common secret shapes before persisted logs, receipts, output, and state.
- Keeps run limits, reviewer selection, runner paths, and permission modes under
  user-controlled layered configuration.

Redaction is defense in depth, not a secret vault: an unusual secret format can
still reach a log or model transcript. Keep credentials scoped, avoid putting
secrets in campaign prompts, review receipts before sharing them, and protect
the Campaigns data directory with normal OS permissions.

The detailed boundary and abuse-path analysis is in
[`docs/threat-model.md`](docs/threat-model.md).

# Changelog

## 0.3.0 — 2026-07-15

Campaigns now turns a campaign plan into a bounded, observable execution system
that can run locally or in CI and leave a replayable evidence trail.

- Added layered configuration, per-step runner selection, runner plugins,
  cross-family final review, secret redaction, and a public threat model.
- Added executable `CHECK:` acceptance criteria, shared plan linting, an in-app
  planner, and evidence-based launch estimates.
- Added isolated worktree lifecycle, lane-safe parallel execution, live worker
  output, committed diffs, and transactional rollback.
- Added the versioned Campaign Markdown v1 contract, unified run-state schema,
  durable event journal, and static recorded replay.
- Added the capped Campaigns GitHub Action with redacted artifacts, sticky PR
  receipts, and check runs.
- Added Kro, secure ntfy onboarding, escalation policy, and a cross-repository
  fleet dashboard.

## 0.2.0 — 2026-07-14

Campaigns is now an end-to-end local execution board: plan in markdown, run with Claude Code or Codex, and watch progress and evidence arrive in the same app.

- Added the built-in campaign engine, runner configuration, recovery, stop controls, and live activity state.
- Added structured final review, guarded rework, merge loops, run caps, containment checks, and watchdogs.
- Kept personal integrations and Workflows out of the public surface unless local capability detection enables them.
- Released the companion planning and automation plugin, including the paste-anywhere planner prompt.
- Reworked the public story, screenshots, contributor docs, cross-platform behavior, HTTP integration coverage, and macOS/Linux CI matrix.

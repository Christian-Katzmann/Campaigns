# app-it Migration Report

Migrated from legacy appify launcher(s) to current app-it templates during the 2026-06-02 batch migration.

Apps:
- Campaigns: app.campaigns.desktop, preferred port 4178, start command `node server.mjs`

Notes:
- Uses the pilot-proven native Mach-O `Contents/MacOS/run` stub plus generated `run.sh`.
- Swift wrapper is compiled without `-O` so doctor marker probes remain deterministic.
- Legacy Desktop bundle registration is handled separately during installation/verification.
- Existing non-launcher worktree changes were left untouched.

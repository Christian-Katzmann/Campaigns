# 0003 - No Hosted Live Demo Yet

## Status

Accepted for the first public release.

## Context

A live demo is stronger than a screenshot when visitors can safely explore. Campaigns edits markdown files on disk, which is exactly the point locally and the wrong default for a shared public demo.

## Decision

Ship a recorded/screenshot-based demo for now. Do not host an interactive public instance until there is a sandbox mode with resettable demo data and no access to arbitrary server files.

## Consequences

- The README leads with a real product screenshot instead of a hosted demo link.
- `design/trailer/trailer.mp4` can be uploaded to GitHub user attachments after the repo is public.
- A custom domain is deferred until there is a demo or docs site worth sending visitors to.
- Future demo work should start by designing the sandbox boundary, not by deploying the current local server as-is.

# 0001 - Markdown Remains the Source of Truth

## Status

Accepted.

## Context

Campaigns exists to make long agent work easier to execute without trapping the plan in another app. The same file should remain readable in a terminal, a text editor, GitHub, or an agent session.

## Decision

Keep campaign markdown as the primary source of truth. The server parses headings, checklists, metadata, and fenced prompts from disk, then writes changes back to the same file.

## Consequences

- Users can keep campaigns in the repo where the work happens.
- Git history remains meaningful because progress is ordinary markdown diff.
- The app must preserve conflict checks when writing back to disk.
- Richer features should be encoded as markdown conventions before introducing separate state.

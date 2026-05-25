# 0002 - Local Registry and Port-File Contract

## Status

Accepted.

## Context

Paired agent skills need a small, stable way to tell the running app about newly created campaign files. They also need to discover the server port without hardcoding a single launch path.

## Decision

Expose a local `POST /api/registry` endpoint and write the active port to a platform-specific `server.port` file. Allow both locations to be overridden with environment variables.

## Consequences

- Skills can register new campaigns without editing browser localStorage.
- Manual server runs and the macOS desktop launcher use the same contract.
- The default paths are platform-specific, so docs must name the macOS, Linux, and Windows conventions.
- The port-file format should remain simple: one port number, no JSON wrapper.

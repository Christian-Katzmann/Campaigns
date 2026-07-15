# Releasing Campaigns

Releases are cut only from commits already pushed to `origin/main`. The package,
tag, and GitHub release use the same version and commit.

## One-time 0.2.0 backfill

Version 0.2.0 was prepared at commit
`f11eb5ca513849a451071d185a8ef6d3d311a5b9` but was never tagged or published.
Do not tag a later commit as 0.2.0. From an up-to-date clean checkout, preview
the guarded backfill:

```bash
./scripts/backfill-v0.2.0.sh
```

After reviewing its exact commands, run `./scripts/backfill-v0.2.0.sh
--execute`. It verifies and publishes the package from a detached worktree at
the historical commit, then pushes the annotated tag and creates the GitHub
release from `docs/releases/v0.2.0.md`. The command is reconcilable: rerunning
after a partial success verifies the published tarball and tag target, then
finishes only the missing tag push or GitHub release.

## Current release

Prepare and validate the current package:

```bash
npm run release:check
npm run check
npm test
npm pack --dry-run
```

After 0.2.0 exists on npm and GitHub, merge the release commit to `main`, push
it, and preview the guarded current-release script:

```bash
./scripts/publish-current-release.sh
```

Run `./scripts/publish-current-release.sh --execute` only after the preview is
correct. The script requires a clean `main`, requires `HEAD == origin/main`,
verifies any existing tag or npm version, reruns all release checks, publishes
missing package state, pushes the annotated tag, and creates the GitHub release from
`docs/releases/v<version>.md`. A retry accepts an existing npm version only when
its integrity matches the local dry-run tarball, accepts an existing tag only
when it resolves to the release commit, and resumes the remaining operations.

The recorded replay is independent of the npm/GitHub release. Publish it only
with the manual `Publish recorded replay` workflow after GitHub Pages is
enabled for Actions in repository settings.

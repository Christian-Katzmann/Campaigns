#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
tag="v$version"
notes="$root/docs/releases/$tag.md"

if [[ "${1:-}" != "--execute" ]]; then
  cat <<EOF
Dry run only. Current package: campaigns-app@$version

Required first:
  publish the historical v0.2.0 release
  merge this release commit to main and push origin/main

External mutations performed by --execute:
  npm publish campaigns-app@$version
  git tag -a $tag HEAD
  git push origin $tag
  gh release create $tag --notes-file $notes
EOF
  exit 0
fi

test -f "$notes"
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=no)"
commit="$(git rev-parse HEAD)"
test "$commit" = "$(git rev-parse origin/main)"
npm view campaigns-app@0.2.0 version >/dev/null
gh auth status >/dev/null

npm run release:check
npm run check
npm test
npm pack --dry-run

local_integrity="$(npm pack --dry-run --json --ignore-scripts 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].integrity))")"
registry_integrity="$(npm view "campaigns-app@$version" dist.integrity 2>/dev/null || true)"
if [[ -n "$registry_integrity" ]]; then
  test "$registry_integrity" = "$local_integrity"
else
  npm whoami >/dev/null
fi

remote_tag=false
remote_target="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk 'NR == 1 {print $1}')"
if [[ -z "$remote_target" ]]; then
  remote_target="$(git ls-remote --tags origin "refs/tags/$tag" | awk 'NR == 1 {print $1}')"
fi
if [[ -n "$remote_target" ]]; then
  remote_tag=true
  test "$remote_target" = "$commit"
fi
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  test "$(git rev-list -n1 "$tag")" = "$commit"
else
  git tag -a "$tag" "$commit" -m "Campaigns $version"
fi

if [[ -z "$registry_integrity" ]]; then
  npm publish --access public
fi
if [[ "$remote_tag" = false ]]; then
  git push origin "$tag"
fi
if ! gh release view "$tag" --repo Christian-Katzmann/Campaigns >/dev/null 2>&1; then
  gh release create "$tag" --repo Christian-Katzmann/Campaigns --title "Campaigns $version" --notes-file "$notes"
fi

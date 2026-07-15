#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit=f11eb5ca513849a451071d185a8ef6d3d311a5b9
tag=v0.2.0
notes="$root/docs/releases/$tag.md"

if [[ "${1:-}" != "--execute" ]]; then
  cat <<EOF
Dry run only. This release is pinned to $commit.

External mutations performed by --execute:
  npm publish campaigns-app@0.2.0 from a detached worktree at $commit
  git tag -a $tag $commit
  git push origin $tag
  gh release create $tag --notes-file $notes
EOF
  exit 0
fi

cd "$root"
test -f "$notes"
test -z "$(git status --porcelain)"
git fetch --prune origin
git merge-base --is-ancestor "$commit" origin/main
gh auth status >/dev/null

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/campaigns-v0.2.0.XXXXXX")"
worktree="$temporary_root/source"
cleanup() {
  git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$temporary_root"
}
trap cleanup EXIT
git worktree add --detach "$worktree" "$commit"
(
  cd "$worktree"
  npm run check
  npm test
  npm pack --dry-run
)

local_integrity="$(cd "$worktree" && npm pack --dry-run --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].integrity))")"
registry_integrity="$(npm view campaigns-app@0.2.0 dist.integrity 2>/dev/null || true)"
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
  git tag -a "$tag" "$commit" -m "Campaigns 0.2.0"
fi

if [[ -z "$registry_integrity" ]]; then
  (cd "$worktree" && npm publish --access public)
fi
if [[ "$remote_tag" = false ]]; then
  git push origin "$tag"
fi
if ! gh release view "$tag" --repo Christian-Katzmann/Campaigns >/dev/null 2>&1; then
  gh release create "$tag" --repo Christian-Katzmann/Campaigns --title "Campaigns 0.2.0" --notes-file "$notes"
fi

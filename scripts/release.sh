#!/usr/bin/env bash
# Release the package from a tag `vX.Y.Z` (GitHub Actions: .github/workflows/release.yml; docs/release.md).
# Agent-neutral. All logic is here; the workflow only wires triggers, permissions, and secrets.
#
#   validate the tag -> (real release) tag commit on origin/main -> refuse a version already on npm ->
#   set the version from the tag -> scripts/ci-check.sh -> pack once -> sha256 ->
#   publish | stage | dry-run -> GitHub release with the same .tgz.
#
# Env:
#   RELEASE_TAG       the tag, e.g. v1.2.3 or v1.2.3-rc.1 (GITHUB_REF_NAME on a tag push)
#   DRY_RUN           true (default) or false; a tag `v*-dryrun.*` is always a dry run
#   NODE_AUTH_TOKEN   the stage-only npm token; used for `npm stage publish` and nothing else
#   GH_TOKEN          for `gh release create`
# Test hooks: RELEASE_CI_CHECK (the check script), RELEASE_NODE_BIN (isolated Node dir; empty = none),
#   RELEASE_OUT (the output dir).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE="openclaw-all-cli"
OUT="${RELEASE_OUT:-$ROOT/out}"
CI_CHECK="${RELEASE_CI_CHECK:-$ROOT/scripts/ci-check.sh}"
NODE_BIN="${RELEASE_NODE_BIN-$ROOT/.spike/node/bin}"
TAG="${RELEASE_TAG:-}"
DRY_RUN="${DRY_RUN:-true}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'release: %s\n' "$1" >&2; exit 1; }

# The stage-only token reaches no other command: everything else sees the placeholder that
# actions/setup-node uses, which keeps the .npmrc it writes valid (and lets npm try OIDC).
STAGE_TOKEN="${NODE_AUTH_TOKEN:-}"
export NODE_AUTH_TOKEN="XXXXX-XXXXX-XXXXX-XXXXX"

use_isolated_node() {
  if [ -n "$NODE_BIN" ] && [ -d "$NODE_BIN" ]; then PATH="$NODE_BIN:$PATH"; export PATH; fi
}
use_isolated_node

# --- validate the tag and the mode -------------------------------------------------------------

SEMVER='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$TAG" =~ $SEMVER ]] || fail "tag \"$TAG\" is not allowed: use vMAJOR.MINOR.PATCH with an optional prerelease, e.g. v1.2.3 or v1.2.3-rc.1."
VERSION="${TAG#v}"

case "$DRY_RUN" in
  true | false) ;;
  *) fail "DRY_RUN must be true or false, got \"$DRY_RUN\"." ;;
esac
if [[ "$TAG" == *-dryrun.* ]]; then DRY_RUN=true; fi

PRERELEASE=false
DIST_TAG=latest
if [[ "$VERSION" == *-* ]]; then
  PRERELEASE=true
  DIST_TAG=next
fi

MODE="release"
if [ "$DRY_RUN" = true ]; then MODE="dry run"; fi
step "$MODE of $PACKAGE $VERSION (npm tag: $DIST_TAG)"

if [ "$DRY_RUN" = false ]; then
  step "Check the tag's commit is on origin/main"
  git rev-parse --verify --quiet "refs/tags/$TAG^{commit}" >/dev/null ||
    fail "tag $TAG does not exist in this checkout."
  [ "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$(git rev-parse HEAD)" ] ||
    fail "the checkout is not at tag $TAG; a release publishes the tagged commit."
  git merge-base --is-ancestor HEAD origin/main ||
    fail "tag $TAG is not on origin/main: a real release must come from a commit on main."
fi

# The version in git stays 0.0.0; restore the files on exit so a local run leaves the tree clean.
WORK="$(mktemp -d)"
cleanup() {
  if [ -f "$WORK/package.json" ]; then cp "$WORK/package.json" "$ROOT/package.json"; fi
  if [ -f "$WORK/package-lock.json" ]; then cp "$WORK/package-lock.json" "$ROOT/package-lock.json"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- npm state: refuse an existing version, find out whether this is the first release ----------

step "Check npm"
if existing="$(npm view "$PACKAGE@$VERSION" version 2>"$WORK/npm-error.txt")"; then
  [ -z "$existing" ] || fail "$PACKAGE@$VERSION is already on npm. Release a new version (never unpublish)."
else
  # A missing package or version is a 404; any other failure (network, registry) must not read as "free".
  grep -q 'E404\|404 Not Found' "$WORK/npm-error.txt" || fail "could not read $PACKAGE@$VERSION from npm: $(cat "$WORK/npm-error.txt")"
fi

FIRST_RELEASE=false
if view_err="$(npm view "$PACKAGE" name 2>&1 >/dev/null)"; then
  echo "$PACKAGE is on npm."
elif [[ "$view_err" == *E404* || "$view_err" == *"404 Not Found"* ]]; then
  FIRST_RELEASE=true
  echo "$PACKAGE is not on npm yet: this is the first release."
else
  fail "could not read $PACKAGE from npm: $view_err"
fi

if [ "$DRY_RUN" = false ] && [ "$FIRST_RELEASE" = true ] && [ -z "$STAGE_TOKEN" ]; then
  fail "first release: the NPM_TOKEN secret (stage-only npm token) is not set. See docs/release.md, \"First release\"."
fi

# --- version, checks, pack ---------------------------------------------------------------------

if [ -f "$ROOT/package-lock.json" ]; then cp "$ROOT/package-lock.json" "$WORK/package-lock.json"; fi
cp "$ROOT/package.json" "$WORK/package.json"

step "Set the version from the tag"
npm version "$VERSION" --no-git-tag-version --allow-same-version

step "Checks (same as CI)"
"$CI_CHECK"
use_isolated_node # ci-check installs the isolated Node when it was missing

step "Pack"
rm -rf "$OUT"
mkdir -p "$OUT"
npm pack --pack-destination "$OUT"
shopt -s nullglob
tarballs=("$OUT"/*.tgz)
shopt -u nullglob
[ "${#tarballs[@]}" -eq 1 ] || fail "expected one tarball in $OUT, found ${#tarballs[@]}."
TARBALL="${tarballs[0]}"
SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
echo "tarball: $(basename "$TARBALL")"
echo "sha256:  $SHA256"

# --- publish | stage | dry run -----------------------------------------------------------------

RESULT=""
if [ "$DRY_RUN" = true ]; then
  step "Dry run: npm publish --dry-run (nothing is published, no release is created)"
  npm publish "$TARBALL" --dry-run --tag "$DIST_TAG"
  RESULT="Dry run only: nothing was published and no GitHub release was created."
elif [ "$FIRST_RELEASE" = true ]; then
  step "First release: stage the tarball (the owner approves it with 2FA)"
  NODE_AUTH_TOKEN="$STAGE_TOKEN" npm stage publish "$TARBALL" --provenance --tag "$DIST_TAG"
  RESULT="Staged, not published. Approve it with 2FA on npmjs.com (package $PACKAGE, staged versions) or with \`npm stage approve <id>\`; then set the trust and delete the token. Steps: docs/release.md, \"First release\"."
else
  step "Publish with trusted publishing (OIDC, no token)"
  npm publish "$TARBALL" --provenance --tag "$DIST_TAG" ||
    fail "npm publish failed. If npm rejected the OIDC login, the trust is not set: see docs/release.md, \"First release\"."
  RESULT="Published $PACKAGE@$VERSION to npm (tag $DIST_TAG) with provenance."
fi

# --- GitHub release ----------------------------------------------------------------------------

if [ "$DRY_RUN" = false ]; then
  step "Create the GitHub release"
  args=("$TAG" "$TARBALL" --verify-tag --title "$TAG" --generate-notes --notes "sha256: $SHA256 ($(basename "$TARBALL"))")
  if [ "$PRERELEASE" = true ]; then args+=(--prerelease); fi
  gh release create "${args[@]}"
fi

# --- summary -----------------------------------------------------------------------------------

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## $MODE: $PACKAGE $VERSION"
    echo
    echo "- Tag: \`$TAG\` (npm tag \`$DIST_TAG\`)"
    echo "- Tarball: \`$(basename "$TARBALL")\`"
    echo "- sha256: \`$SHA256\`"
    echo
    echo "$RESULT"
  } >>"$GITHUB_STEP_SUMMARY"
fi

printf '\n%s\n' "$RESULT"

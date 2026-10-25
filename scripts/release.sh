#!/usr/bin/env bash
# Release the package as `vX.Y.Z` (GitHub Actions: .github/workflows/release.yml; docs/release.md), from a
# pushed tag or from a dispatch on main that creates the tag. A dispatch may leave the tag empty: the next
# version is computed from the stable `v*` tags on origin and RELEASE_BUMP.
# Agent-neutral. All logic is here; the workflow only wires triggers, permissions, and secrets.
#
#   validate the tag -> (real release) tag push: tag is HEAD and on origin/main; dispatch: HEAD is
#   origin/main's head and the tag is new -> refuse a version already on npm ->
#   set the version from the tag -> scripts/ci-check.sh -> pack once -> sha256 ->
#   release notes from CHANGELOG.md (the version's section, else Unreleased, else GitHub's generated notes) ->
#   publish | stage | dry-run -> GitHub release with the same .tgz.
#
# Env:
#   RELEASE_TAG       the tag, e.g. v1.2.3 or v1.2.3-rc.1 (GITHUB_REF_NAME on a tag push); empty on a
#                     dispatch = compute the next version (RELEASE_BUMP) from origin's stable tags
#   RELEASE_BUMP      patch (default), minor, or major; used only when RELEASE_TAG is empty
#   DRY_RUN           true (default) or false; a tag `v*-dryrun.*` is always a dry run
#   NODE_AUTH_TOKEN   the stage-only npm token; used for `npm stage publish` and nothing else
#   GH_TOKEN          for `gh release create`
#   RELEASE_EVENT     github.event_name; a real `workflow_dispatch` run creates the tag itself (the owner
#                     approves, the agent dispatches; see docs/release.md)
# Test hooks: RELEASE_CI_CHECK (the check script), RELEASE_NODE_BIN (isolated Node dir; empty = none),
#   RELEASE_OUT (the output dir), RELEASE_STAGE_NPM (the npm that runs `stage publish`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE="openclaw-all-cli"
OUT="${RELEASE_OUT:-$ROOT/out}"
CI_CHECK="${RELEASE_CI_CHECK:-$ROOT/scripts/ci-check.sh}"
NODE_BIN="${RELEASE_NODE_BIN-$ROOT/.spike/node/bin}"
TAG="${RELEASE_TAG:-}"
DRY_RUN="${DRY_RUN:-true}"
CREATE_TAG=false
# npm 11 documents "package must exist" for `npm stage`; npm 12.2.1 documents that staging creates a
# new package. The first release stages a package npm has never seen, so it uses npm 12.2.1.
read -r -a STAGE_NPM <<<"${RELEASE_STAGE_NPM:-npm exec --yes --package=npm@12.2.1 -- npm}"

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

if [ -z "$TAG" ]; then
  # A dispatch with no tag releases the next version: highest stable tag on origin plus the bump.
  [ "${RELEASE_EVENT:-push}" = workflow_dispatch ] ||
    fail "a tag push needs a tag; only a dispatched run may leave the tag empty to compute the next version."
  BUMP="${RELEASE_BUMP:-patch}"
  case "$BUMP" in
    patch | minor | major) ;;
    *) fail "RELEASE_BUMP must be patch, minor, or major, got \"$BUMP\"." ;;
  esac
  remote_tags="$(git ls-remote --tags --refs origin 'refs/tags/v*')" ||
    fail "could not read tags from origin; nothing was released."
  # Stable versions only: prereleases (and -dryrun.) tags never set the base.
  latest="$(printf '%s\n' "$remote_tags" | sed 's#.*refs/tags/##' |
    { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || true; } | sort -V | tail -n 1)"
  base="${latest#v}"
  IFS=. read -r base_major base_minor base_patch <<<"${base:-0.0.0}"
  case "$BUMP" in
    major) TAG="v$((base_major + 1)).0.0" ;;
    minor) TAG="v${base_major}.$((base_minor + 1)).0" ;;
    patch) TAG="v${base_major}.${base_minor}.$((base_patch + 1))" ;;
  esac
  echo "release: no tag given; $BUMP bump of ${latest:-no stable tag (base v0.0.0)} gives $TAG"
fi

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
TAG_ARGS=() # a stable version takes npm's default: it refuses to move `latest` below a higher version
if [[ "$VERSION" == *-* ]]; then
  PRERELEASE=true
  DIST_TAG=next
  TAG_ARGS=(--tag next)
fi

MODE="release"
if [ "$DRY_RUN" = true ]; then MODE="dry run"; fi
step "$MODE of $PACKAGE $VERSION (npm tag: $DIST_TAG)"

if [ "$DRY_RUN" = false ]; then
  if [ "${RELEASE_EVENT:-push}" = workflow_dispatch ]; then
    # Dispatched release: no tag yet; the GitHub release creates it at HEAD once publish or stage worked.
    CREATE_TAG=true
    step "Check HEAD is on origin/main and tag $TAG is new"
    ! git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null ||
      fail "tag $TAG already exists; a dispatched release creates a new tag. Pick the next version."
    remote_tag="$(git ls-remote --tags origin "refs/tags/$TAG")" ||
      fail "could not read tags from origin; nothing was released."
    [ -z "$remote_tag" ] ||
      fail "tag $TAG already exists on origin; a dispatched release creates a new tag. Pick the next version."
    # main's head, not any ancestor: a stale ref or a re-run of an old run must not release old code.
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
      fail "HEAD is not the head of origin/main: dispatch a new run on main (a re-run keeps the old commit)."
  else
    step "Check the tag's commit is on origin/main"
    git rev-parse --verify --quiet "refs/tags/$TAG^{commit}" >/dev/null ||
      fail "tag $TAG does not exist in this checkout."
    [ "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$(git rev-parse HEAD)" ] ||
      fail "the checkout is not at tag $TAG; a release publishes the tagged commit."
    git merge-base --is-ancestor HEAD origin/main ||
      fail "tag $TAG is not on origin/main: a real release must come from a commit on main."
  fi
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
# The checks run dependency scripts and tests: they get no job credential (the npm token is already
# hidden above; the GitHub token and the OIDC request token could write the repo or publish).
env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL "$CI_CHECK"
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

# --- release notes -----------------------------------------------------------------------------

# The section of CHANGELOG.md named for this version, else `Unreleased`. Anything else (no file, no lines,
# no node, a malformed file) falls back to GitHub's generated notes: the changelog never fails a release.
step "Release notes (CHANGELOG.md)"
NOTES_FILE=""
NOTES_SOURCE="generated by GitHub"
NOTES_STAMP=""
# Same credential rule as the checks: repository code runs without the job tokens.
if changelog_notes="$(env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
  node "$ROOT/scripts/changelog.mjs" section "$VERSION" "$ROOT/CHANGELOG.md" 2>"$WORK/changelog-note.txt")"; then
  NOTES_FILE="$WORK/release-notes.md"
  printf '%s\n\nsha256: %s (%s)\n' "$changelog_notes" "$SHA256" "$(basename "$TARBALL")" >"$NOTES_FILE"
  NOTES_SOURCE="$(sed -n 's/^changelog: notes from //p' "$WORK/changelog-note.txt")"
  NOTES_SOURCE="CHANGELOG.md, ${NOTES_SOURCE:-the changelog}"
  if [ "$NOTES_SOURCE" = "CHANGELOG.md, Unreleased" ]; then
    NOTES_STAMP="CHANGELOG.md on main still lists these lines under Unreleased: stamp them as $VERSION in a pull request (docs/release.md, \"Changelog\"), or the next release repeats them."
  fi
  echo "release notes: $NOTES_SOURCE"
  printf '%s\n' "$changelog_notes"
else
  NOTES_SOURCE="generated by GitHub ($(head -n 1 "$WORK/changelog-note.txt" 2>/dev/null | cut -c1-200))"
  echo "release notes: $NOTES_SOURCE"
fi
[ -z "$NOTES_STAMP" ] || echo "release: $NOTES_STAMP"

# --- publish | stage | dry run -----------------------------------------------------------------

RESULT=""
if [ "$DRY_RUN" = true ]; then
  step "Dry run: npm publish --dry-run (nothing is published, no release is created)"
  npm publish "$TARBALL" --dry-run "${TAG_ARGS[@]}"
  RESULT="Dry run only: nothing was published and no GitHub release was created."
elif [ "$FIRST_RELEASE" = true ]; then
  step "First release: stage the tarball (the owner approves it with 2FA)"
  NODE_AUTH_TOKEN="$STAGE_TOKEN" "${STAGE_NPM[@]}" stage publish "$TARBALL" --provenance "${TAG_ARGS[@]}"
  RESULT="Staged, not published. Approve it with 2FA on npmjs.com (package $PACKAGE, staged versions) or with \`npm stage approve <id>\`; then set the trust and delete the token. Steps: docs/release.md, \"First release\"."
else
  step "Publish with trusted publishing (OIDC, no token)"
  npm publish "$TARBALL" --provenance "${TAG_ARGS[@]}" ||
    fail "npm publish failed. If npm rejected the OIDC login, the trust is not set: see docs/release.md, \"First release\"."
  RESULT="Published $PACKAGE@$VERSION to npm (tag $DIST_TAG) with provenance."
fi

# --- GitHub release ----------------------------------------------------------------------------

if [ "$DRY_RUN" = false ]; then
  step "Create the GitHub release"
  # Printed first, so a failed release step still leaves what a manual `gh release create` needs.
  echo "release commit: $(git rev-parse HEAD), tarball sha256: $SHA256"
  if [ -n "$NOTES_FILE" ]; then
    args=("$TAG" "$TARBALL" --title "$TAG" --notes-file "$NOTES_FILE")
  else
    args=("$TAG" "$TARBALL" --title "$TAG" --generate-notes --notes "sha256: $SHA256 ($(basename "$TARBALL"))")
  fi
  if [ "$CREATE_TAG" = true ]; then args+=(--target "$(git rev-parse HEAD)"); else args+=(--verify-tag); fi
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
    echo "- Release notes: $NOTES_SOURCE"
    [ -z "$NOTES_STAMP" ] || echo "- $NOTES_STAMP"
    echo
    echo "$RESULT"
  } >>"$GITHUB_STEP_SUMMARY"
fi

printf '\n%s\n' "$RESULT"

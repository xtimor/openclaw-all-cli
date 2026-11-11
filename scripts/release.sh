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
#   publish | stage | dry-run -> GitHub release with the same .tgz -> ClawHub with the same .tgz (after npm and
#   the GitHub release; skipped while the first npm release is only staged; a dry run checks it locally).
#
# Env:
#   RELEASE_TAG       the tag, e.g. v1.2.3 or v1.2.3-rc.1 (GITHUB_REF_NAME on a tag push); empty on a
#                     dispatch = compute the next version (RELEASE_BUMP) from origin's stable tags
#   RELEASE_BUMP      patch (default), minor, or major; used only when RELEASE_TAG is empty
#   DRY_RUN           true (default) or false; a tag `v*-dryrun.*` is always a dry run
#   NODE_AUTH_TOKEN   the stage-only npm token; used for `npm stage publish` and nothing else
#   CLAWHUB_TOKEN     ClawHub API token for the first ClawHub publish; reaches only the `clawhub` commands, through a
#                     mode-600 config file in the work dir. Unset: ClawHub publishes through trusted publishing (OIDC).
#   CLAWHUB_VERSION   the `clawhub` CLI version (default below; ci.yml and release.yml pin the same one)
#   GH_TOKEN          for `gh release create`
#   RELEASE_EVENT     github.event_name; a real `workflow_dispatch` run creates the tag itself (the owner
#                     approves, the agent dispatches; see docs/release.md)
# Test hooks: RELEASE_CI_CHECK (the check script), RELEASE_NODE_BIN (isolated Node dir; empty = none),
#   RELEASE_OUT (the output dir), RELEASE_STAGE_NPM (the npm that runs `stage publish`),
#   RELEASE_CLAWHUB (the command that runs as `clawhub`; set, it skips installing the pinned CLI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE="openclaw-all-cli"
OUT="${RELEASE_OUT:-$ROOT/out}"
# Absolute: the clawhub CLI reads a relative `dir/file.tgz` as a GitHub `owner/repo`.
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
CI_CHECK="${RELEASE_CI_CHECK:-$ROOT/scripts/ci-check.sh}"
NODE_BIN="${RELEASE_NODE_BIN-$ROOT/.spike/node/bin}"
TAG="${RELEASE_TAG:-}"
DRY_RUN="${DRY_RUN:-true}"
CREATE_TAG=false
# npm 11 documents "package must exist" for `npm stage`; npm 12.2.1 documents that staging creates a
# new package. The first release stages a package npm has never seen, so it uses npm 12.2.1.
read -r -a STAGE_NPM <<<"${RELEASE_STAGE_NPM:-npm exec --yes --package=npm@12.2.1 -- npm}"
# The ClawHub CLI, pinned to an exact version (same as CLAWHUB_VERSION in ci.yml and release.yml).
CLAWHUB_VERSION="${CLAWHUB_VERSION:-0.25.1}"
REPOSITORY="${GITHUB_REPOSITORY:-xtimor/openclaw-all-cli}"
CLAWHUB=()
if [ -n "${RELEASE_CLAWHUB:-}" ]; then read -r -a CLAWHUB <<<"$RELEASE_CLAWHUB"; fi

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'release: %s\n' "$1" >&2; exit 1; }

# The stage-only token reaches no other command: everything else sees the placeholder that
# actions/setup-node uses, which keeps the .npmrc it writes valid (and lets npm try OIDC).
STAGE_TOKEN="${NODE_AUTH_TOKEN:-}"
export NODE_AUTH_TOKEN="XXXXX-XXXXX-XXXXX-XXXXX"
# Same for the ClawHub token: kept in an unexported variable, written only into the config file that the
# `clawhub` commands read ($CLAWHUB_CONFIG, see write_clawhub_config below). Surrounding whitespace (a pasted
# trailing newline or CR) is dropped: it would make the config invalid JSON, which the CLI ignores silently.
CLAWHUB_SECRET="${CLAWHUB_TOKEN:-}"
CLAWHUB_SECRET="${CLAWHUB_SECRET#"${CLAWHUB_SECRET%%[![:space:]]*}"}"
CLAWHUB_SECRET="${CLAWHUB_SECRET%"${CLAWHUB_SECRET##*[![:space:]]}"}"
unset CLAWHUB_TOKEN

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

# --- ClawHub helpers ---------------------------------------------------------------------------

# The CLI runs from the work dir; the token reaches it only through this file (written only when a token is set).
CLAWHUB_CONFIG="$WORK/clawhub-config.json"
CLAWHUB_OUT="$WORK/clawhub-out.json"
CLAWHUB_ERR="$WORK/clawhub-err.txt"
CLAWHUB_LINE=""   # the summary's ClawHub line
CLAWHUB_RESULT="" # what happened on ClawHub, in a sentence
CLAWHUB_NOTE=""   # the trusted publisher outcome
CLAWHUB_FAILED=false

mask() {
  local text="$1"
  if [ -n "$CLAWHUB_SECRET" ]; then text="${text//"$CLAWHUB_SECRET"/***}"; fi
  printf '%s' "$text"
}

# The pinned CLI, installed into the work dir with no install scripts and no credential at all (the npm token
# is already the placeholder; the ClawHub token is not exported).
install_clawhub() {
  [ "${#CLAWHUB[@]}" -eq 0 ] || return 0
  step "Install clawhub@$CLAWHUB_VERSION"
  env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
    npm install "clawhub@$CLAWHUB_VERSION" --ignore-scripts --no-audit --no-fund --prefix "$WORK/clawhub" || return 1
  [ -f "$WORK/clawhub/node_modules/clawhub/bin/clawdhub.js" ] || return 1
  CLAWHUB=(node "$WORK/clawhub/node_modules/clawhub/bin/clawdhub.js")
}

write_clawhub_config() {
  local token="${CLAWHUB_SECRET//\\/\\\\}"
  token="${token//\"/\\\"}"
  (umask 077 && printf '{"registry":"https://clawhub.ai","token":"%s"}\n' "$token" >"$CLAWHUB_CONFIG")
}

# `clawhub "$@"` without the GitHub token, reading only $CLAWHUB_CONFIG. Its stdout (the --json result) goes to
# $CLAWHUB_OUT; its stderr shows in the log and is kept in $CLAWHUB_ERR. --no-oidc also drops the OIDC request
# variables (the dry run and the trusted publisher call need none).
run_clawhub() {
  local -a strip=(-u GH_TOKEN -u GITHUB_TOKEN)
  if [ "$1" = --no-oidc ]; then
    strip+=(-u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL)
    shift
  fi
  : >"$CLAWHUB_OUT"
  : >"$CLAWHUB_ERR"
  { env "${strip[@]}" NO_COLOR=1 CLAWHUB_CONFIG_PATH="$CLAWHUB_CONFIG" "${CLAWHUB[@]}" "$@" 2>&1 >"$CLAWHUB_OUT" |
    tee "$CLAWHUB_ERR" >&2; }
}

last_clawhub_error() {
  local line
  line="$({ grep -v '^[[:space:]]*$' "$CLAWHUB_ERR" || true; } | tail -n 1 | cut -c1-300)"
  mask "${line:-the clawhub CLI exited non-zero with no message}"
}

# name, version, status, publicationStatus, artifactSha256 of the --json result, separated by \037.
read_clawhub_result() {
  env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    let result;
    try { result = JSON.parse(text); } catch { result = JSON.parse(text.slice(text.indexOf("{"))); }
    const field = (key) => String(result[key] ?? "").replace(/[\x1f\n]/g, " ");
    process.stdout.write(["name", "version", "status", "publicationStatus", "artifactSha256"].map(field).join("\x1f"));
  ' "$CLAWHUB_OUT"
}

clawhub_failed() {
  CLAWHUB_FAILED=true
  CLAWHUB_LINE="failed (see below)"
  if [ "$DRY_RUN" = true ]; then
    CLAWHUB_RESULT="ClawHub dry run failed: $1."
  else
    CLAWHUB_RESULT="npm and the GitHub release are done; ClawHub failed: $1. Nothing was undone. Recovery: docs/release.md, \"ClawHub\"."
  fi
}

# The real publish: the same tarball, waiting for ClawHub's checks. With a token it is a manual (token) publish,
# which ClawHub accepts only with a reason once a trusted publisher exists (and the CLI then never uses OIDC, so
# it gets no OIDC variables); without one the CLI uses OIDC.
CLAWHUB_REASON="Release $TAG from $REPOSITORY release.yml with the CLAWHUB_TOKEN secret (docs/release.md, ClawHub)"
clawhub_publish_args() {
  CLAWHUB_ARGS=(package publish "$TARBALL" --family code-plugin --wait --json --tags "$DIST_TAG"
    --source-repo "$REPOSITORY" --source-commit "$1" --source-ref "refs/tags/$TAG")
  if [ -n "$CLAWHUB_SECRET" ]; then CLAWHUB_ARGS+=(--manual-override-reason "$CLAWHUB_REASON"); fi
}

clawhub_dry_run() {
  local commit="${GITHUB_SHA:-}"
  if [ -z "$commit" ]; then commit="$(git rev-parse HEAD)" || fail "could not read the commit for ClawHub's --source-commit."; fi
  local -a args=(package publish "$TARBALL" --family code-plugin --dry-run --json --tags "$DIST_TAG"
    --source-repo "$REPOSITORY" --source-commit "$commit")
  if [ -n "${GITHUB_REF:-}" ]; then args+=(--source-ref "$GITHUB_REF"); fi
  step "Dry run: clawhub package publish --dry-run (checked locally, no registry call)"
  if ! install_clawhub; then
    clawhub_failed "could not install clawhub@$CLAWHUB_VERSION"
    return 0
  fi
  echo "clawhub$(printf ' %q' "${args[@]}")"
  if ! run_clawhub --no-oidc "${args[@]}"; then
    clawhub_failed "$(last_clawhub_error)"
    return 0
  fi
  cat "$CLAWHUB_OUT"
  clawhub_publish_args "$commit"
  local auth="through trusted publishing (OIDC, no token)"
  if [ -n "$CLAWHUB_SECRET" ]; then auth="with the CLAWHUB_TOKEN secret"; fi
  local real
  real="clawhub$(printf ' %q' "${CLAWHUB_ARGS[@]}")"
  echo "A real run publishes to ClawHub $auth, after npm and the GitHub release:"
  echo "$real"
  CLAWHUB_LINE="dry run passed (no registry call); a real run publishes $auth: \`$real\`"
  if [ "$FIRST_RELEASE" = true ]; then
    CLAWHUB_LINE="dry run passed (no registry call); a real run skips ClawHub while the first npm release is only staged"
  fi
  CLAWHUB_RESULT="ClawHub: dry run only, nothing was published."
}

clawhub_publish() {
  local commit="$1" auth="trusted publishing (OIDC)"
  local -a oidc=()
  step "Publish to ClawHub (same tarball, waits for ClawHub's checks)"
  if ! install_clawhub; then
    clawhub_failed "could not install clawhub@$CLAWHUB_VERSION"
    return 0
  fi
  clawhub_publish_args "$commit"
  if [ -n "$CLAWHUB_SECRET" ]; then
    write_clawhub_config
    auth="the CLAWHUB_TOKEN secret"
    oidc=(--no-oidc)
  fi
  echo "clawhub$(printf ' %q' "${CLAWHUB_ARGS[@]}") (auth: $auth)"
  if ! run_clawhub ${oidc[@]+"${oidc[@]}"} "${CLAWHUB_ARGS[@]}"; then
    cat "$CLAWHUB_OUT" >&2
    clawhub_failed "$(last_clawhub_error)"
    return 0
  fi
  cat "$CLAWHUB_OUT"
  local fields name version status publication sha
  if ! fields="$(read_clawhub_result)"; then
    clawhub_failed "the clawhub CLI printed no JSON result, so the published sha256 is unknown"
    return 0
  fi
  IFS=$'\037' read -r name version status publication sha <<<"$fields"
  name="${name:-$PACKAGE}"
  if [ "$publication" != published ]; then
    clawhub_failed "$name@${version:-$VERSION} is \"${publication:-unknown}\" on ClawHub, not published"
    return 0
  fi
  # artifactSha256 is optional in ClawHub's answer: only a reported sha256 that differs fails the run.
  if [ -n "$sha" ] && [ "$sha" != "$SHA256" ]; then
    clawhub_failed "ClawHub reports sha256 $sha for $name@$version, not the tarball's sha256 above"
    return 0
  fi
  local verify="clawhub package verify $(basename "$TARBALL") --package $name --version $version"
  if [ -n "$sha" ]; then
    CLAWHUB_LINE="\`$name@$version\` $publication (status \`$status\`, tag \`$DIST_TAG\`, via $auth), same sha256"
    CLAWHUB_RESULT="Published $name@$version to ClawHub (tag $DIST_TAG) with the same tarball."
  else
    CLAWHUB_LINE="\`$name@$version\` $publication (status \`$status\`, tag \`$DIST_TAG\`, via $auth); ClawHub reported no sha256: check it with \`$verify\`"
    CLAWHUB_RESULT="Published $name@$version to ClawHub (tag $DIST_TAG). ClawHub reported no sha256; check the release's tarball with \`$verify\`."
  fi

  if [ -n "$CLAWHUB_SECRET" ]; then
    # After a token publish, set the trusted publisher so later runs need no token. A failure here leaves the
    # release good: it is a warning with the command to run by hand.
    step "Set the ClawHub trusted publisher (later releases publish through OIDC)"
    local manual="clawhub package trusted-publisher set $name --repository $REPOSITORY --workflow-filename release.yml"
    if run_clawhub --no-oidc package trusted-publisher set "$name" --repository "$REPOSITORY" --workflow-filename release.yml; then
      cat "$CLAWHUB_OUT"
      CLAWHUB_NOTE="Trusted publisher set ($REPOSITORY, release.yml). Delete the CLAWHUB_TOKEN secret: later releases publish through OIDC (docs/release.md, \"ClawHub\")."
    else
      CLAWHUB_NOTE="Warning: the ClawHub trusted publisher was not set ($(last_clawhub_error)). Set it by hand after \`clawhub login\`: \`$manual\`; then delete the CLAWHUB_TOKEN secret (docs/release.md, \"ClawHub\")."
      echo "::warning title=ClawHub trusted publisher::$CLAWHUB_NOTE"
    fi
  fi
}

# --- publish | stage | dry run -----------------------------------------------------------------

RESULT=""
NPM_LINE=""
if [ "$DRY_RUN" = true ]; then
  step "Dry run: npm publish --dry-run (nothing is published, no release is created)"
  npm publish "$TARBALL" --dry-run "${TAG_ARGS[@]}"
  NPM_LINE="dry run, \`$PACKAGE@$VERSION\` not published (tag \`$DIST_TAG\`)"
  RESULT="Dry run only: nothing was published and no GitHub release was created."
  clawhub_dry_run
elif [ "$FIRST_RELEASE" = true ]; then
  step "First release: stage the tarball (the owner approves it with 2FA)"
  NODE_AUTH_TOKEN="$STAGE_TOKEN" "${STAGE_NPM[@]}" stage publish "$TARBALL" --provenance "${TAG_ARGS[@]}"
  NPM_LINE="\`$PACKAGE@$VERSION\` staged, not published (tag \`$DIST_TAG\`)"
  RESULT="Staged, not published. Approve it with 2FA on npmjs.com (package $PACKAGE, staged versions) or with \`npm stage approve <id>\`; then set the trust and delete the token. Steps: docs/release.md, \"First release\"."
else
  step "Publish with trusted publishing (OIDC, no token)"
  npm publish "$TARBALL" --provenance "${TAG_ARGS[@]}" ||
    fail "npm publish failed. If npm rejected the OIDC login, the trust is not set: see docs/release.md, \"First release\"."
  NPM_LINE="\`$PACKAGE@$VERSION\` published (tag \`$DIST_TAG\`)"
  RESULT="Published $PACKAGE@$VERSION to npm (tag $DIST_TAG) with provenance."
fi

# --- GitHub release ----------------------------------------------------------------------------

if [ "$DRY_RUN" = false ]; then
  step "Create the GitHub release"
  RELEASE_COMMIT="$(git rev-parse HEAD)"
  # Printed first, so a failed release step still leaves what a manual `gh release create` needs.
  echo "release commit: $RELEASE_COMMIT, tarball sha256: $SHA256"
  if [ -n "$NOTES_FILE" ]; then
    args=("$TAG" "$TARBALL" --title "$TAG" --notes-file "$NOTES_FILE")
  else
    args=("$TAG" "$TARBALL" --title "$TAG" --generate-notes --notes "sha256: $SHA256 ($(basename "$TARBALL"))")
  fi
  if [ "$CREATE_TAG" = true ]; then args+=(--target "$RELEASE_COMMIT"); else args+=(--verify-tag); fi
  if [ "$PRERELEASE" = true ]; then args+=(--prerelease); fi
  gh release create "${args[@]}"

  # --- ClawHub: only after npm and the GitHub release, so its failure never splits npm from the tag ----------
  if [ "$FIRST_RELEASE" = true ]; then
    CLAWHUB_LINE="skipped: the first npm release is only staged; ClawHub publishes from the next release"
    CLAWHUB_RESULT="ClawHub skipped: npm has only a staged version (docs/release.md, \"ClawHub\")."
  else
    clawhub_publish "$RELEASE_COMMIT"
  fi
fi

# --- summary -----------------------------------------------------------------------------------

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## $MODE: $PACKAGE $VERSION"
    echo
    echo "- Tag: \`$TAG\` (npm tag \`$DIST_TAG\`)"
    echo "- npm: $NPM_LINE"
    echo "- ClawHub: $CLAWHUB_LINE"
    echo "- Tarball: \`$(basename "$TARBALL")\`"
    echo "- sha256: \`$SHA256\`"
    echo "- Release notes: $NOTES_SOURCE"
    [ -z "$NOTES_STAMP" ] || echo "- $NOTES_STAMP"
    [ -z "$CLAWHUB_NOTE" ] || echo "- $CLAWHUB_NOTE"
    echo
    echo "$RESULT"
    echo
    echo "$CLAWHUB_RESULT"
  } >>"$GITHUB_STEP_SUMMARY"
fi

printf '\n%s\n' "$RESULT"
if [ "$CLAWHUB_FAILED" = true ]; then
  printf 'release: %s\n' "$CLAWHUB_RESULT" >&2
  exit 1
fi
printf '%s\n' "$CLAWHUB_RESULT"
[ -z "$CLAWHUB_NOTE" ] || printf '%s\n' "$CLAWHUB_NOTE"

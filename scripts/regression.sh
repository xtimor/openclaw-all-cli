#!/usr/bin/env bash
# Pre-release regression tiers (epic-regression-gate). One entry point for CI and the release.
#
#   scripts/regression.sh gateway|ui|live [--openclaw <min|latest|extended-stable|beta|X.Y.Z>] [--tgz <file>] [--result <file>]
#                                          [--turn-cap <n>]
#   scripts/regression.sh resolve <min|latest|extended-stable|beta|X.Y.Z>...
#
# gateway: packs this plugin, installs the .tgz into a fresh state of an isolated OpenClaw of the chosen
# version (default `min`, package.json openclaw.compat.minGatewayVersion; a tag resolves through npm), and
# runs test/regression/gateway (real Gateway, fake cursor-agent). ui: the same setup, then test/regression/ui
# (the Control UI of such a Gateway in Playwright's headless Chromium; failure screenshots in
# .regression/ui-screenshots/<version>, or OPENCLAW_ALL_CLI_UI_ARTIFACTS). gateway and ui need no secret and no
# network beyond installing Node and OpenClaw, and unset any Cursor key. live (ticket 4.5) needs CURSOR_API_KEY (it
# fails first, before any install, without it; only the live tests, the token reader and the result writer get it,
# never npm, the OpenClaw install or the build): the same setup, then the pinned cursor-agent behind a turn meter and
# test/live (real Cursor turns, each test up to 3 tries), stopping new turns at --turn-cap (default LIVE_TURN_CAP or
# 400); its result adds tries, turns and Cursor tokens. Everything lives under .regression/ (gitignored); .spike/ and
# ~/.openclaw are never read or written. --tgz installs that packed plugin instead of building and packing;
# --result writes a JSON summary (version, sha256, passed|failed|error, seconds, failing tests) for CI.
# resolve: prints the requested versions as JSON, resolved by the same rules and grouped by version, e.g.
# [{"version":"2026.10.3","requests":["min"]},{"version":"2026.11.10","requests":["latest","beta"]}].
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Relative --tgz and --result paths are the caller's.
CALLER_DIR="$PWD"
cd "$ROOT"
usage() {
  sed -n '2,21p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

absolute() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$CALLER_DIR" "$1" ;;
  esac
}

tier="${1:-}"
shift || true
case "$tier" in
  gateway | ui | resolve) ;;
  live) ;;
  *) usage ;;
esac
# live: the key is kept in a shell variable that is never exported, and given only to the three commands that need it
# (the live tests, the token reader, the result writer), never to npm, the OpenClaw install or the build.
LIVE_KEY=""
if [ "$tier" = live ]; then
  LIVE_KEY="${CURSOR_API_KEY:-}"
fi
# No secret anywhere else: gateway and ui run on the fake cursor-agent, and a real key must not reach the fresh state.
unset CURSOR_API_KEY CURSOR_AUTH_TOKEN

requested=min
requests=()
TGZ=""
RESULT_FILE=""
TURN_CAP="${LIVE_TURN_CAP:-400}"
if [ "$tier" = resolve ]; then
  [ $# -gt 0 ] || usage
  requests=("$@")
else
  while [ $# -gt 0 ]; do
    case "$1" in
      --openclaw | --tgz | --result | --turn-cap)
        [ $# -ge 2 ] && [ -n "$2" ] || usage
        case "$1" in
          --openclaw) requested="$2" ;;
          --tgz) TGZ="$(absolute "$2")" ;;
          --result) RESULT_FILE="$(absolute "$2")" ;;
          --turn-cap) TURN_CAP="$2" ;;
        esac
        shift 2
        ;;
      --openclaw=*)
        requested="${1#--openclaw=}"
        shift
        ;;
      *) usage ;;
    esac
  done
fi

if ! [[ "$TURN_CAP" =~ ^[1-9][0-9]*$ ]]; then
  echo "--turn-cap: not a positive whole number: '$TURN_CAP'" >&2
  exit 2
fi

if [ -n "$TGZ" ] && [ ! -f "$TGZ" ]; then
  echo "--tgz: no such file: $TGZ" >&2
  exit 2
fi

# The isolated Node from an earlier run serves `npm view` and package.json reads when the host has none.
for dir in "$ROOT"/.regression/openclaw-*/node/bin; do
  if ! command -v npm >/dev/null 2>&1 && [ -x "$dir/npm" ]; then PATH="$dir:$PATH"; fi
done
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "scripts/regression.sh needs Node and npm (any version) on PATH to bootstrap; it then installs its own Node under .regression/." >&2
  exit 2
fi

resolve_version() {
  local wanted="$1" found
  if [ "$wanted" = min ]; then
    node -p 'require(process.argv[1]).openclaw.compat.minGatewayVersion' "$ROOT/package.json"
  elif [[ "$wanted" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
    echo "$wanted"
  elif [[ "$wanted" =~ ^[a-z][a-z0-9._-]*$ ]]; then
    if ! found="$(npm view openclaw "dist-tags.$wanted" 2>/dev/null)"; then
      echo "Could not ask npm for the OpenClaw dist-tag '$wanted'." >&2
      exit 1
    fi
    if [ -z "$found" ]; then
      echo "Unknown OpenClaw dist-tag '$wanted' (try min, latest, extended-stable, beta, or X.Y.Z)." >&2
      exit 2
    fi
    echo "$found"
  else
    echo "Not an OpenClaw version or dist-tag: '$wanted'." >&2
    exit 2
  fi
}

if [ "$tier" = resolve ]; then
  pairs=()
  for wanted in "${requests[@]}"; do
    # A failed resolve stops here with its own message and exit code (1: npm unreachable, 2: unknown).
    found="$(resolve_version "$wanted")"
    pairs+=("$wanted" "$found")
  done
  node -e '
    const groups = new Map();
    const args = process.argv.slice(1);
    for (let i = 0; i < args.length; i += 2) {
      const requests = groups.get(args[i + 1]) ?? [];
      if (!requests.includes(args[i])) requests.push(args[i]);
      groups.set(args[i + 1], requests);
    }
    console.log(JSON.stringify([...groups].map(([version, requests]) => ({ version, requests }))));
  ' "${pairs[@]}"
  exit 0
fi

# --result: a JSON summary written on every exit of a gateway or ui run, so CI can show and report a run that stopped early
# too. `result` is passed or failed once the tier ran, error when the run stopped before the tier finished.
VERSION=""
SHA=""
TIER_STATUS=""
REPORT=""
LIVE_ARGS=()
write_result() {
  local code=$?
  if [ -n "$RESULT_FILE" ]; then
    # scripts/regression-result.mjs reads the failing test names from the Vitest JSON report.
    # The key only to scrub it from the failure messages it writes.
    if ! CURSOR_API_KEY="$LIVE_KEY" node "$ROOT/scripts/regression-result.mjs" --out "$RESULT_FILE" --requested "$requested" --version "$VERSION" --sha256 "$SHA" \
      --tier-status "$TIER_STATUS" --exit-code "$code" --seconds "$SECONDS" --report "$REPORT" ${LIVE_ARGS[@]+"${LIVE_ARGS[@]}"}; then
      echo "scripts/regression.sh: could not write the result file $RESULT_FILE" >&2
    fi
  fi
  exit "$code"
}
trap write_result EXIT

# live: the key comes first, before any install or turn (CI gives it only through the `regression` environment).
if [ "$tier" = live ]; then
  LIVE_ARGS=(--tier live --turn-cap "$TURN_CAP")
  if [ -z "${LIVE_KEY//[[:space:]]/}" ]; then
    echo "CURSOR_API_KEY is not set: the live tier needs the \`regression\` environment" >&2
    exit 1
  fi
fi

VERSION="$(resolve_version "$requested")"
echo "OpenClaw version: $VERSION (requested: $requested)"

export OPENCLAW_VERSION="$VERSION"
export SPIKE_DIR="$ROOT/.regression/openclaw-$VERSION"
PACK_DIR="$ROOT/.regression/pack"
DEV="$ROOT/scripts/dev-openclaw.sh"

step() { printf '\n==> %s\n' "$1"; }

step "Set up isolated Node and OpenClaw $VERSION ($SPIKE_DIR)"
"$DEV" setup
# Every npm and vitest command below runs on the isolated Node.
export PATH="$SPIKE_DIR/node/bin:$PATH"

# The ui tier also needs the pinned Playwright (its browser comes from `npx playwright install chromium`).
if [ ! -x "$ROOT/node_modules/.bin/vitest" ] || [ ! -x "$ROOT/node_modules/.bin/tsc" ] || { [ "$tier" = ui ] && [ ! -d "$ROOT/node_modules/playwright" ]; }; then
  step "Install dependencies (npm ci)"
  npm ci --no-audit --no-fund
fi

if [ -n "$TGZ" ]; then
  step "Use the packed plugin $TGZ (--tgz: no build, no pack)"
  TARBALL="$TGZ"
else
  step "Build and pack the plugin ($PACK_DIR)"
  rm -rf "$PACK_DIR"
  mkdir -p "$PACK_DIR"
  # Always build against the pinned OpenClaw (package.json openclaw.build.openclawVersion) under .regression/, never
  # .spike/ (where tsconfig.json points): the same build locally and in CI, whatever OpenClaw the tier tests.
  BUILD_VERSION="$(node -p 'require(process.argv[1]).openclaw.build.openclawVersion' "$ROOT/package.json")"
  BUILD_SPIKE="$ROOT/.regression/openclaw-$BUILD_VERSION"
  if [ "$BUILD_VERSION" != "$VERSION" ]; then
    SPIKE_DIR="$BUILD_SPIKE" OPENCLAW_VERSION="$BUILD_VERSION" "$DEV" setup >/dev/null
  fi
  printf '{\n  "extends": "../tsconfig.build.json",\n  "compilerOptions": { "paths": { "openclaw/plugin-sdk/*": ["%s/*"] } }\n}\n' \
    "$BUILD_SPIKE/openclaw/node_modules/openclaw/dist/plugin-sdk" > "$ROOT/.regression/tsconfig.build.json"
  echo "Building against the SDK types of OpenClaw $BUILD_VERSION ($BUILD_SPIKE)"
  rm -rf "$ROOT/dist"
  npx tsc -p "$ROOT/.regression/tsconfig.build.json"
  npm pack --pack-destination "$PACK_DIR" >/dev/null
  TARBALL="$(ls "$PACK_DIR"/openclaw-all-cli-*.tgz)"
fi
if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi
echo "Plugin tarball: $(basename "$TARBALL") sha256 $SHA"

step "Fresh OpenClaw state with the packed plugin"
rm -rf "$SPIKE_DIR/state" "$SPIKE_DIR/openclaw.json"
# The Gateway runs with --auth none; its CLI client refuses to connect unless the config says so too.
"$DEV" run config set gateway.auth.mode none >/dev/null
"$DEV" run plugins install --force --accept-capabilities "$TARBALL"

if [ "$tier" = ui ]; then
  TIER_TITLE="Control UI"
  # Failure screenshots and page texts (test/regression/ui/browser.ts); CI uploads this folder when the tier fails.
  # The default folder is the tier's own and starts empty; a folder the caller named keeps everything but the
  # screenshots and page texts of an earlier run.
  if [ -z "${OPENCLAW_ALL_CLI_UI_ARTIFACTS:-}" ]; then
    export OPENCLAW_ALL_CLI_UI_ARTIFACTS="$ROOT/.regression/ui-screenshots/$VERSION"
    rm -rf "$OPENCLAW_ALL_CLI_UI_ARTIFACTS"
    mkdir -p "$OPENCLAW_ALL_CLI_UI_ARTIFACTS"
  else
    export OPENCLAW_ALL_CLI_UI_ARTIFACTS
    mkdir -p "$OPENCLAW_ALL_CLI_UI_ARTIFACTS"
    find "$OPENCLAW_ALL_CLI_UI_ARTIFACTS" -maxdepth 1 -type f \( -name '*.png' -o -name '*.txt' \) -delete
  fi
elif [ "$tier" = live ]; then
  TIER_TITLE="Live"
else
  TIER_TITLE="Gateway"
fi

if [ "$tier" = live ]; then
  # Node's fetch (the plugin's usage ledger and quota reads, the token reader, the install) ignores HTTP(S)_PROXY without it.
  export NODE_USE_ENV_PROXY=1
  LIVE_DIR="$ROOT/.regression/live/$VERSION"
  rm -rf "$LIVE_DIR"
  mkdir -p "$LIVE_DIR/bin"
  step "The pinned cursor-agent (src/adapters/cursor/install.ts)"
  REAL_AGENT="$(node "$ROOT/scripts/install-cursor-agent.mjs" "$ROOT/.regression/cursor-agent")"
  # Every live test reaches Cursor through this shim, so the meter sees every turn (test/live/turn-meter.mjs).
  TURN_LOG="$LIVE_DIR/turns.jsonl"
  : >"$TURN_LOG"
  printf '#!/bin/sh\nOAC_LIVE_REAL_AGENT=%q OAC_LIVE_TURN_LOG=%q OAC_LIVE_TURN_CAP=%q exec %q %q "$@"\n' \
    "$REAL_AGENT" "$TURN_LOG" "$TURN_CAP" "$(command -v node)" "$ROOT/test/live/turn-meter.mjs" >"$LIVE_DIR/bin/cursor-agent"
  chmod +x "$LIVE_DIR/bin/cursor-agent"
  # The tests read the same log (one turn per process, #102).
  export OAC_LIVE_TURN_LOG="$TURN_LOG"
  export PATH="$LIVE_DIR/bin:$PATH"
  export CURSOR_AGENT_BIN="$LIVE_DIR/bin/cursor-agent"
  echo "cursor-agent: $("$CURSOR_AGENT_BIN" --version 2>/dev/null | head -n 1) behind the turn meter (cap $TURN_CAP turns)"
  TRIES_FILE="$LIVE_DIR/tries.json"
  TOKENS_FILE="$LIVE_DIR/tokens.json"
  export OAC_LIVE_MEASURE_FILE="$LIVE_DIR/measurements.jsonl"
  LIVE_ARGS+=(--tries "$TRIES_FILE" --turns "$TURN_LOG" --tokens "$TOKENS_FILE" --measurements "$OAC_LIVE_MEASURE_FILE")
fi

step "$TIER_TITLE tier (OpenClaw $VERSION)"
status=0
reporters=(--reporter=verbose)
if [ -n "$RESULT_FILE" ]; then
  REPORT="${RESULT_FILE%.json}.vitest.json"
  mkdir -p "$(dirname "$REPORT")"
  rm -f "$REPORT"
  reporters+=(--reporter=json "--outputFile.json=$REPORT")
fi
if [ "$tier" = live ]; then
  RUN_START_MS="$(node -p 'Date.now()')"
  # LIVE_TESTS narrows the run to some files (a local check); the release and CI run all of test/live.
  # `test/live/`, with the slash: a bare `test/live` filter also matches test/live-tier.test.ts.
  read -r -a live_tests <<<"${LIVE_TESTS:-test/live/}"
  CURSOR_API_KEY="$LIVE_KEY" OAC_LIVE_TRIES_FILE="$TRIES_FILE" OPENCLAW_ALL_CLI_LIVE=1 npx vitest run "${reporters[@]}" --reporter=./test/live/tries-reporter.ts "${live_tests[@]}" || status=$?
  # A refused turn fails the run even when every test that saw it passed.
  if grep -q '"kind":"refused"' "$TURN_LOG"; then
    echo "Turn cap $TURN_CAP reached: $(grep -c '"kind":"refused"' "$TURN_LOG") turns were refused" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  step "Cursor tokens of this run (usage ledger, by conversation id)"
  CURSOR_API_KEY="$LIVE_KEY" node "$ROOT/scripts/live-tokens.mjs" --turns "$TURN_LOG" --since "$RUN_START_MS" --out "$TOKENS_FILE" || echo "The token reader failed; tokens stay unknown." >&2
else
  OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run "${reporters[@]}" "test/regression/$tier" || status=$?
fi
TIER_STATUS="$status"

printf '\n%s tier, OpenClaw %s, plugin sha256 %s: %s\n' "$TIER_TITLE" "$VERSION" "$SHA" "$([ "$status" -eq 0 ] && echo passed || echo FAILED)"
exit "$status"

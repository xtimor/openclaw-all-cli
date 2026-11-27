#!/usr/bin/env bash
# Pre-release regression tiers (epic-regression-gate). One entry point for CI and the release.
#
#   scripts/regression.sh gateway [--openclaw <min|latest|extended-stable|beta|X.Y.Z>] [--tgz <file>] [--result <file>]
#   scripts/regression.sh resolve <min|latest|extended-stable|beta|X.Y.Z>...
#
# gateway: packs this plugin, installs the .tgz into a fresh state of an isolated OpenClaw of the chosen
# version (default `min`, package.json openclaw.compat.minGatewayVersion; a tag resolves through npm), and
# runs test/regression/gateway (real Gateway, fake cursor-agent). No secret and no network beyond
# installing Node and OpenClaw. Everything lives under .regression/ (gitignored); .spike/ and
# ~/.openclaw are never read or written. --tgz installs that packed plugin instead of building and packing;
# --result writes a JSON summary (version, sha256, passed|failed|error, seconds, failing tests) for CI.
# resolve: prints the requested versions as JSON, resolved by the same rules and grouped by version, e.g.
# [{"version":"2026.10.3","requests":["min"]},{"version":"2026.11.10","requests":["latest","beta"]}].
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Relative --tgz and --result paths are the caller's.
CALLER_DIR="$PWD"
cd "$ROOT"
# No secret: the tier runs on the fake cursor-agent, and a real key must not reach the fresh state.
unset CURSOR_API_KEY CURSOR_AUTH_TOKEN

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" >&2
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
  gateway | resolve) ;;
  *) usage ;;
esac

requested=min
requests=()
TGZ=""
RESULT_FILE=""
if [ "$tier" = resolve ]; then
  [ $# -gt 0 ] || usage
  requests=("$@")
else
  while [ $# -gt 0 ]; do
    case "$1" in
      --openclaw | --tgz | --result)
        [ $# -ge 2 ] && [ -n "$2" ] || usage
        case "$1" in
          --openclaw) requested="$2" ;;
          --tgz) TGZ="$(absolute "$2")" ;;
          --result) RESULT_FILE="$(absolute "$2")" ;;
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

# --result: a JSON summary written on every exit of a gateway run, so CI can show and report a run that stopped early
# too. `result` is passed or failed once the tier ran, error when the run stopped before the tier finished.
VERSION=""
SHA=""
TIER_STATUS=""
REPORT=""
write_result() {
  local code=$?
  if [ -n "$RESULT_FILE" ]; then
    if ! node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const [file, requested, version, sha256, tierStatus, code, seconds, report] = process.argv.slice(1);
      const failed = [];
      let parsed = null;
      try { parsed = report ? JSON.parse(fs.readFileSync(report, "utf8")) : null; } catch { /* no report: none failed by name */ }
      for (const suite of parsed?.testResults ?? []) {
        const name = path.basename(String(suite.name ?? ""));
        const tests = (suite.assertionResults ?? []).filter((test) => test.status === "failed");
        for (const test of tests) failed.push(`${name} > ${test.fullName ?? test.title}`);
        if (tests.length === 0 && suite.status === "failed") failed.push(`${name}: ${String(suite.message || "failed").split("\n")[0]}`);
      }
      const result = tierStatus === "" ? "error" : tierStatus === "0" ? "passed" : "failed";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const summary = { requested, version: version || null, sha256: sha256 || null, result, exitCode: Number(code), seconds: Number(seconds), failed };
      fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
    ' "$RESULT_FILE" "$requested" "$VERSION" "$SHA" "$TIER_STATUS" "$code" "$SECONDS" "$REPORT"; then
      echo "scripts/regression.sh: could not write the result file $RESULT_FILE" >&2
    fi
  fi
  exit "$code"
}
trap write_result EXIT

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

if [ ! -x "$ROOT/node_modules/.bin/vitest" ] || [ ! -x "$ROOT/node_modules/.bin/tsc" ]; then
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

step "Gateway tier (OpenClaw $VERSION)"
status=0
reporters=(--reporter=verbose)
if [ -n "$RESULT_FILE" ]; then
  REPORT="${RESULT_FILE%.json}.vitest.json"
  mkdir -p "$(dirname "$REPORT")"
  rm -f "$REPORT"
  reporters+=(--reporter=json "--outputFile.json=$REPORT")
fi
OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run "${reporters[@]}" test/regression/gateway || status=$?
TIER_STATUS="$status"

printf '\nOpenClaw %s, plugin sha256 %s: %s\n' "$VERSION" "$SHA" "$([ "$status" -eq 0 ] && echo passed || echo FAILED)"
exit "$status"

#!/usr/bin/env bash
# Pre-release regression tiers (epic-regression-gate). One entry point for CI and the release.
#
#   scripts/regression.sh gateway [--openclaw <min|latest|extended-stable|beta|X.Y.Z>]
#
# gateway: packs this plugin, installs the .tgz into a fresh state of an isolated OpenClaw of the chosen
# version (default `min`, package.json openclaw.compat.minGatewayVersion; a tag resolves through npm), and
# runs test/regression/gateway (real Gateway, fake cursor-agent). No secret and no network beyond
# installing Node and OpenClaw. Everything lives under .regression/ (gitignored); .spike/ and
# ~/.openclaw are never read or written.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# No secret: the tier runs on the fake cursor-agent, and a real key must not reach the fresh state.
unset CURSOR_API_KEY CURSOR_AUTH_TOKEN

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

tier="${1:-}"
shift || true
[ "$tier" = gateway ] || usage

requested=min
while [ $# -gt 0 ]; do
  case "$1" in
    --openclaw)
      [ $# -ge 2 ] || usage
      requested="$2"
      shift 2
      ;;
    --openclaw=*)
      requested="${1#--openclaw=}"
      shift
      ;;
    *) usage ;;
  esac
done

# The isolated Node from an earlier run (or .spike's) serves `npm view` and the project's npm commands when the host has none.
for dir in "$ROOT"/.regression/openclaw-*/node/bin "$ROOT/.spike/node/bin"; do
  if ! command -v npm >/dev/null 2>&1 && [ -x "$dir/npm" ]; then PATH="$dir:$PATH"; fi
done

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

step "Build and pack the plugin ($PACK_DIR)"
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR"
# tsconfig.json maps the SDK types to .spike/openclaw. Without it (a clean checkout), build against the same
# OpenClaw version (package.json openclaw.build.openclawVersion) set up under .regression/ instead.
if [ -d "$ROOT/.spike/openclaw/node_modules/openclaw/dist/plugin-sdk" ]; then
  npm run build
else
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
fi
npm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL="$(ls "$PACK_DIR"/openclaw-all-cli-*.tgz)"
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
OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run --reporter=verbose test/regression/gateway || status=$?

printf '\nOpenClaw %s, plugin sha256 %s: %s\n' "$VERSION" "$SHA" "$([ "$status" -eq 0 ] && echo passed || echo FAILED)"
exit "$status"

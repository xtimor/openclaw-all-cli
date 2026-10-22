#!/usr/bin/env bash
# Every check a pull request must pass, in one place: `npm run ci` locally, the same script in GitHub Actions.
# Agent-neutral and fail-fast. Needs no Cursor login; live tests (`npm run test:live`) are not part of it.
#
#   isolated Node 24 + OpenClaw in .spike/, npm ci, typecheck, unit tests, build,
#   the package allowlist test (with dist/), npm pack --dry-run, and an install smoke check of the packed tarball in a throwaway OpenClaw state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n==> %s\n' "$1"; }

step "Set up isolated Node and OpenClaw (.spike/)"
scripts/dev-openclaw.sh setup

# The project needs Node 24; run every npm command from the isolated one, not the host's.
export PATH="$ROOT/.spike/node/bin:$PATH"
OPENCLAW_BIN="$ROOT/.spike/openclaw/node_modules/.bin/openclaw"

step "Install dependencies (npm ci)"
npm ci --no-audit --no-fund

step "Typecheck"
npm run typecheck

step "Unit tests"
npm test

step "Build"
npm run build

step "Package allowlist (with dist)"
npx vitest run test/package-contents.test.ts

step "Package contents (npm pack --dry-run)"
npm pack --dry-run

# The smoke check never touches .spike/state or ~/.openclaw: it uses its own state dir and config path.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step "Pack the plugin"
mkdir -p "$TMP/pack" "$TMP/state"
npm pack --pack-destination "$TMP/pack" >/dev/null
TARBALL="$(ls "$TMP"/pack/openclaw-all-cli-*.tgz)"

step "Install smoke check (packed plugin in a throwaway OpenClaw state)"
export OPENCLAW_STATE_DIR="$TMP/state"
export OPENCLAW_CONFIG_PATH="$TMP/openclaw.json"
"$OPENCLAW_BIN" plugins install --force --accept-capabilities "$TARBALL"
# A failed inspect still goes to the check below, which prints the report.
"$OPENCLAW_BIN" plugins inspect openclaw-all-cli --runtime --json > "$TMP/inspect.json" || true
node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  let plugin;
  try { plugin = JSON.parse(raw).plugin; } catch { /* reported below */ }
  const backends = (plugin && plugin.cliBackendIds) || [];
  const ok = plugin && plugin.status === "loaded" && backends.includes("cursor-cli");
  console.log(`smoke: status=${plugin && plugin.status} cliBackendIds=${JSON.stringify(backends)}`);
  if (!ok) {
    console.error("smoke check failed: the plugin must be loaded with the cursor-cli backend. Report:");
    console.error(raw);
    process.exit(1);
  }
' "$TMP/inspect.json"

printf '\nAll checks passed.\n'

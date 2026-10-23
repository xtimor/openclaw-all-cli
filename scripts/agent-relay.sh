#!/usr/bin/env bash
# The one entry point for every relay write of the issue agents (docs/agents/identity.md): dispatches the `Agent write`
# workflow on main with an operations file, waits for the run, and checks that it succeeded. Agent-neutral.
#
#   scripts/agent-relay.sh /tmp/agent-ops-1.json      # prints the run id on stdout
#
# It only runs `gh workflow run agent-write.yml --ref main`, `gh run watch`, and `gh api .../actions/runs/<id>`. It never
# touches the proxy variables and prints no secret (the operations are public input; the file is not echoed). Exit 0: the run
# concluded success. Exit 1: dispatch, run id, or run conclusion failed (one-line reason on stderr). Exit 2: bad usage, or the
# file is missing or not valid JSON (nothing dispatched).
# Test hooks: AGENT_RELAY_GH (the gh binary, default `gh`), REPO (default xtimor/openclaw-all-cli).
set -euo pipefail

GH="${AGENT_RELAY_GH:-gh}"
REPO="${REPO:-xtimor/openclaw-all-cli}"

fail() { printf 'agent-relay: %s\n' "$1" >&2; exit "${2:-1}"; }

[ "$#" -eq 1 ] || fail "usage: scripts/agent-relay.sh <ops.json>" 2
OPS="$1"
[ -f "$OPS" ] || fail "ops file not found" 2
if command -v node >/dev/null 2>&1; then
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$OPS" 2>/dev/null || fail "ops file is not valid JSON" 2
elif command -v jq >/dev/null 2>&1; then
  jq -e . "$OPS" >/dev/null 2>&1 || fail "ops file is not valid JSON" 2
else
  fail "neither node nor jq is available to check the ops file" 2
fi

URL="$("$GH" workflow run agent-write.yml --ref main -f ops="$(cat "$OPS")")" || fail "dispatch failed"
URL="$(printf '%s\n' "$URL" | tail -n 1)"
ID="${URL##*/}"
case "$ID" in ''|*[!0-9]*) fail "no run id" ;; esac

"$GH" run watch "$ID" --exit-status >&2 || true
CONCLUSION="$("$GH" api "repos/$REPO/actions/runs/$ID" --jq .conclusion)" || fail "cannot read relay run $ID"
[ "$CONCLUSION" = success ] || fail "relay run $ID: $CONCLUSION"
printf '%s\n' "$ID"

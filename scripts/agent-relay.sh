#!/usr/bin/env bash
# The one entry point for every relay write of the issue agents (docs/agents/identity.md): dispatches the `Agent write`
# workflow on main with an operations file, waits for the run, and checks that it succeeded. Agent-neutral.
#
#   scripts/agent-relay.sh /tmp/agent-ops-1.json      # prints the run id on stdout
#
# It only runs `gh workflow run agent-write.yml --ref main`, `gh run watch`, and `gh api .../actions/runs/<id>`. It never
# touches the proxy variables and prints no secret (the operations are public input; the file is not echoed). After `gh run
# watch` (which can return early) it polls the run's status until `completed`. Exit 0: the run concluded success. Exit 1:
# dispatch, run id, or run conclusion failed, or the run is still going after the wait (one-line reason on stderr; do not
# re-dispatch, read back first). Exit 2: bad usage, or the file is missing, over 60000 bytes, or not a JSON array (nothing
# dispatched).
# Test hooks: AGENT_RELAY_GH (the gh binary, default `gh`), REPO (default xtimor/openclaw-all-cli), AGENT_RELAY_POLL_SECONDS
# (default 10), AGENT_RELAY_MAX_POLLS (default 120, about 20 minutes).
set -euo pipefail

GH="${AGENT_RELAY_GH:-gh}"
REPO="${REPO:-xtimor/openclaw-all-cli}"
POLL_SECONDS="${AGENT_RELAY_POLL_SECONDS:-10}"
MAX_POLLS="${AGENT_RELAY_MAX_POLLS:-120}"
MAX_BYTES=60000

fail() { printf 'agent-relay: %s\n' "$1" >&2; exit "${2:-1}"; }

[ "$#" -eq 1 ] || fail "usage: scripts/agent-relay.sh <ops.json>" 2
OPS="$1"
[ -f "$OPS" ] || fail "ops file not found" 2
[ "$(wc -c <"$OPS")" -le "$MAX_BYTES" ] || fail "ops file too large; split the step" 2
if command -v node >/dev/null 2>&1; then
  node -e 'if (!Array.isArray(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")))) process.exit(1)' "$OPS" 2>/dev/null || fail "ops file is not a JSON array" 2
elif command -v jq >/dev/null 2>&1; then
  jq -e 'type == "array"' "$OPS" >/dev/null 2>&1 || fail "ops file is not a JSON array" 2
else
  fail "neither node nor jq is available to check the ops file" 2
fi

URL="$("$GH" workflow run agent-write.yml --ref main -f ops="$(cat "$OPS")")" || fail "dispatch failed"
URL="$(printf '%s\n' "$URL" | tail -n 1)"
ID="${URL##*/}"
case "$ID" in ''|*[!0-9]*) fail "no run id" ;; esac

"$GH" run watch "$ID" --exit-status >&2 || true
# `gh run watch` can return early (network drop) while the run is still going: wait for it, never judge a running run.
STATUS=""
for ((i = 0; i < MAX_POLLS; i++)); do
  STATUS="$("$GH" api "repos/$REPO/actions/runs/$ID" --jq .status 2>/dev/null)" || STATUS="unreadable"
  [ "$STATUS" = completed ] && break
  sleep "$POLL_SECONDS"
done
[ "$STATUS" = completed ] || fail "relay run $ID still ${STATUS:-unknown}; do not re-dispatch, read back first"
CONCLUSION="$("$GH" api "repos/$REPO/actions/runs/$ID" --jq .conclusion)" || fail "cannot read relay run $ID"
[ "$CONCLUSION" = success ] || fail "relay run $ID: $CONCLUSION"
printf '%s\n' "$ID"

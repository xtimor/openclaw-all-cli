#!/usr/bin/env bash
# The one entry point for filing an upstream issue (docs/agents/identity.md, "Upstream issues"): dispatches the `Upstream issue`
# workflow on main with an issue file, waits for the run, checks that it succeeded, and prints the issue's URL. Agent-neutral.
#
#   scripts/upstream-issue.sh /tmp/upstream-issue-1.json      # prints https://github.com/openclaw/openclaw/issues/<n> on stdout
#
# The file is one JSON object: {"title": "...", "body": "...\nFiled for xtimor/openclaw-all-cli#<n>", "labels": ["..."]} (labels
# optional; see scripts/upstream-issue.mjs for every rule). It only runs `gh workflow run upstream-issue.yml --ref main`,
# `gh run watch` (both with `--repo`, the same repository the reads use, never the current directory's), and `gh api` reads of the run, its jobs, and the job's annotations (`gh run view --log` as a fallback). It never
# touches the proxy variables and holds no secret: the token stays in GitHub. After `gh run watch` (which can return early) it polls
# the run's status until `completed`. The result is the run's `notice` annotation, written by the workflow.
# Exit 0: the run concluded success and the issue's URL is on stdout (stderr says `created` or `existing`). Exit 1: the dispatch, run
# id, or run conclusion failed, the run is still going after the wait, or the result could not be read (one-line reason on stderr;
# dispatching the same file again is safe, the script returns the issue it already filed instead of a second one). Exit 2: bad
# usage, or the file is missing, over 40000 bytes, or not a JSON object (nothing dispatched).
# Test hooks: UPSTREAM_ISSUE_GH (the gh binary, default `gh`), UPSTREAM_ISSUE_REPO (default xtimor/openclaw-all-cli), UPSTREAM_ISSUE_POLL_SECONDS
# (default 10), UPSTREAM_ISSUE_MAX_POLLS (default 120, about 20 minutes).
set -euo pipefail

GH="${UPSTREAM_ISSUE_GH:-gh}"
REPO="${UPSTREAM_ISSUE_REPO:-xtimor/openclaw-all-cli}"
POLL_SECONDS="${UPSTREAM_ISSUE_POLL_SECONDS:-10}"
MAX_POLLS="${UPSTREAM_ISSUE_MAX_POLLS:-120}"
MAX_BYTES=40000
RESULT_RE='^upstream-issue: (created|existing) (https://github\.com/openclaw/openclaw/issues/[0-9]+)$'

fail() { printf 'upstream-issue: %s\n' "$1" >&2; exit "${2:-1}"; }

[ "$#" -eq 1 ] || fail "usage: scripts/upstream-issue.sh <issue.json>" 2
FILE="$1"
[ -f "$FILE" ] || fail "issue file not found" 2
[ "$(wc -c <"$FILE")" -le "$MAX_BYTES" ] || fail "issue file too large" 2
if command -v node >/dev/null 2>&1; then
  node -e 'const v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (v === null || typeof v !== "object" || Array.isArray(v)) process.exit(1)' "$FILE" 2>/dev/null || fail "issue file is not a JSON object" 2
elif command -v jq >/dev/null 2>&1; then
  jq -e 'type == "object"' "$FILE" >/dev/null 2>&1 || fail "issue file is not a JSON object" 2
else
  fail "neither node nor jq is available to check the issue file" 2
fi

URL="$("$GH" workflow run upstream-issue.yml --repo "$REPO" --ref main -f issue="$(cat "$FILE")")" || fail "dispatch failed"
URL="$(printf '%s\n' "$URL" | tail -n 1)"
ID="${URL##*/}"
case "$ID" in ''|*[!0-9]*) fail "no run id" ;; esac

"$GH" run watch "$ID" --repo "$REPO" --exit-status >&2 || true
# `gh run watch` can return early (network drop) while the run is still going: wait for it, never judge a running run.
STATUS=""
for ((i = 0; i < MAX_POLLS; i++)); do
  STATUS="$("$GH" api "repos/$REPO/actions/runs/$ID" --jq .status 2>/dev/null)" || STATUS="unreadable"
  [ "$STATUS" = completed ] && break
  sleep "$POLL_SECONDS"
done
[ "$STATUS" = completed ] || fail "run $ID still ${STATUS:-unknown}; read the run before dispatching again"
CONCLUSION="$("$GH" api "repos/$REPO/actions/runs/$ID" --jq .conclusion)" || fail "cannot read run $ID"

# The workflow's last step leaves the script's one-line result as an annotation (a notice on success, an error otherwise); the run
# log is the fallback. Only lines the script prefixed `upstream-issue:` count, and control characters are dropped.
result_lines() {
  local job lines
  job="$("$GH" api "repos/$REPO/actions/runs/$ID/jobs" --jq '.jobs[0].id' 2>/dev/null)" || job=""
  case "$job" in ''|*[!0-9]*) job="" ;; esac
  lines=""
  if [ -n "$job" ]; then
    lines="$("$GH" api "repos/$REPO/check-runs/$job/annotations" --jq '.[].message' 2>/dev/null)" || lines=""
  fi
  if ! printf '%s\n' "$lines" | grep '^upstream-issue: ' >/dev/null; then
    # Log lines read `<job>\t<step>\t<timestamp> <text>`.
    lines="$("$GH" run view "$ID" --repo "$REPO" --log 2>/dev/null | sed -E 's/^[^\t]*\t[^\t]*\t[0-9T:.Z-]+ //')" || lines=""
  fi
  printf '%s\n' "$lines" | tr -d '\000-\010\013-\037\177' | grep '^upstream-issue: ' || true
}
LINES="$(result_lines)"

if [ "$CONCLUSION" != success ]; then
  REASON="$(printf '%s\n' "$LINES" | tail -n 1 | cut -c1-400)"
  fail "run $ID: $CONCLUSION${REASON:+ ($REASON)}"
fi
LINE="$(printf '%s\n' "$LINES" | grep -E "$RESULT_RE" | tail -n 1 || true)"
[ -n "$LINE" ] || fail "run $ID succeeded but its result could not be read; dispatching the same file again returns the same issue"
printf '%s\n' "${LINE#upstream-issue: }" | awk '{ print $1 > "/dev/stderr"; print $2 }'

#!/usr/bin/env bash
# Stops an implementation run from ending between "tickets done" and "batch PR ready" (docs/agents/implement.md, Run checklist).
# Found live 2026-10-26: a run built and closed six tickets, then ended without the "Open the pull request" steps.
# The run marks the window it must not end in; an agent's stop hook asks this script whether it may stop. Agent-neutral: the
# agent-specific file (.claude/settings.json) only calls `stop-hook`.
#
#   scripts/batch-pending.sh set <branch>   # right after the batch is claimed (branch pushed, draft PR open)
#   scripts/batch-pending.sh clear          # right after the batch PR is ready for review, or when the run must end without one
#   scripts/batch-pending.sh stop-hook      # for a Stop hook: prints {"decision":"block","reason":...} while the marker stands
#
# The marker is one file (OAC_BATCH_MARKER, default /tmp/oac-batch-pending) with the branch, the start time, and the number of
# times the hook has blocked. It blocks at most 3 times (a run that truly cannot finish, for example with the relay down, is not
# trapped; it should `clear` and say why in its report) and ignores a marker older than 12 hours. No marker, no output, exit 0.
set -euo pipefail

MARKER="${OAC_BATCH_MARKER:-/tmp/oac-batch-pending}"
MAX_BLOCKS=3
MAX_AGE_SECONDS=$((12 * 3600))

fail() { printf 'batch-pending: %s\n' "$1" >&2; exit 2; }

value() { sed -n "s/^$1=//p" "$MARKER" 2>/dev/null | head -n 1; }

case "${1:-}" in
  set)
    [ "$#" -eq 2 ] || fail "usage: scripts/batch-pending.sh set <branch>"
    [[ "$2" =~ ^[A-Za-z0-9._/-]{1,200}$ ]] || fail "the branch name has characters a branch does not"
    umask 077
    printf 'branch=%s\nstarted=%s\nblocks=0\n' "$2" "$(date -u +%s)" >"$MARKER.tmp"
    mv "$MARKER.tmp" "$MARKER"
    ;;
  clear)
    [ "$#" -eq 1 ] || fail "usage: scripts/batch-pending.sh clear"
    rm -f "$MARKER" "$MARKER.tmp"
    ;;
  stop-hook)
    cat >/dev/null || true # the hook's JSON input is not needed
    [ -f "$MARKER" ] || exit 0
    started="$(value started)"
    blocks="$(value blocks)"
    branch="$(value branch)"
    case "$started" in '' | *[!0-9]*) rm -f "$MARKER"; exit 0 ;; esac
    case "$blocks" in '' | *[!0-9]*) blocks=$MAX_BLOCKS ;; esac
    if [ $(($(date -u +%s) - started)) -gt "$MAX_AGE_SECONDS" ] || [ "$blocks" -ge "$MAX_BLOCKS" ]; then
      rm -f "$MARKER"
      exit 0
    fi
    printf 'branch=%s\nstarted=%s\nblocks=%s\n' "$branch" "$started" $((blocks + 1)) >"$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"
    printf '{"decision":"block","reason":"This run claimed the batch on %s and has not marked its pull request ready for review. Finishing the tickets is not finishing the run. Follow the Run checklist and \\"Open the pull request\\" in docs/agents/implement.md now: npm run ci, push, pr_edit and pr_ready through scripts/agent-relay.sh, read the pull request back, status:in-review on each issue, then scripts/batch-pending.sh clear. If the run truly cannot finish (relay or GitHub down), run scripts/batch-pending.sh clear and say why in the report."}\n' "$branch"
    ;;
  *)
    fail "usage: scripts/batch-pending.sh set <branch> | clear | stop-hook"
    ;;
esac

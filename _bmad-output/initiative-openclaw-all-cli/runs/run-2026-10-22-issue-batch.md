---
run_id: run-2026-10-22-issue-batch
scope: issue batch #8 #10 #12 #13
status: completed
checkpoint: none
branch: claude/nice-ritchie-0qbcbr
models: build sonnet, review opus, plan opus (Claude Code map, effort high); fallbacks swapped
tickets:
  - story-publish-reasoning-support-and-an-effort-choice-for-cursor-cli-models.md
  - story-cursor-provider-in-the-control-ui-provider-list.md
  - bug-cursor-cli-models-all-report-the-same-128k-context-window.md
  - bug-webchat-shows-the-assistant-reply-twice.md
---

# Run run-2026-10-22-issue-batch

Unattended batch from `docs/agents/implement.md`. Build order: issue order (#8, #10, #12, #13). Review depth quick for all (risk below high). blocked_policy continue.

## Journal

- backlog/1 build — start
- backlog/1 build — built (sonnet, quick; no subagent tool, oneshot). Commit 02c7927. Live Cursor effort check not run.
- backlog/1 review — built, followup false (opus, self-run lenses). Commit b72ba00. Deferred 1: host sends `medium` when no level is set; design choice left open.
- backlog/1 close — done. Decision: lenses ran in the worker itself because workers have no subagent tool.
- backlog/2 build — start
- backlog/2 build — built (sonnet, quick, full route by size). Commit c3005bc. Live Cursor check and real Control UI not run.
- backlog/2 review — built, followup false (opus, self-run lenses). Commit a21a027. Deferred 1: the Control UI dialog ends with "did not return a credential profile" after either method.
- backlog/2 close — done.
- backlog/3 build — start
- backlog/3 build — built (sonnet, quick, oneshot). Commit 143f589. Live Cursor check not run.
- backlog/3 review — built, followup false, no change (opus, self-run lenses). Commit 46f1150. Open: whether the per-turn compaction budget reads the published window (not traced).
- backlog/3 close — done.
- backlog/4 build — start
- backlog/4 build — done, no plugin change (sonnet, criterion 4: the host emits one final assistant event itself and the plugin result only sets final text; one delta stream plus one final over the Gateway wire). Commit 26f4303. Control UI and real Cursor not checked. Review lenses ran inside the worker.
- Closing: run completed. Issue #13 goes to the owner as blocked with the finding, because "no change needed" is not a fix.

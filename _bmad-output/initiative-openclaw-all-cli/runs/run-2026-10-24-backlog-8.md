---
run_id: run-2026-10-24-backlog-8
scope: backlog 8 (turn 2 of a fresh agent restarts cursor-agent; follows issue #11)
status: completed
checkpoint: 8 close
branch: claude/ready-22yiqc
tickets: [bug-turn-2-of-a-fresh-agent-restarts-cursor-agent.md]
models: build sonnet/opus, review opus/sonnet (Claude Code map, effort high)
---

# Run log

Plan: 8 (quick review, risk medium): build, review, close. Owner asked for the full investigation and the fix on 2026-10-24. `CURSOR_API_KEY` is set: live checks can run.

## Journal

- 8 build — start
- 8 build — built (sonnet), commits bd71b24, 0f3330b, e732ecf, e65aed4. Outcome: no supported plugin-side fix; host cause recorded, upstream issue text in the plan. Live: new row 4 of 4, full turn-latency file 4 of 4. `npm run ci` green (re-run by the orchestrator).
- 8 review — quick lens run in-session by the worker (no subagents); orchestrator re-read the docs, P4 note, and the upstream text; no follow-up.
- 8 close — done.

Cause: a turn that starts before OpenClaw's model catalog has loaded the plugin's `cursor-cli` rows (about 4 s after Gateway start or `agents add`) gets `modelHasVision: false`, so no `computer`/`view_image` (50 tools, not 52); the next turn gets them, and the fingerprint changes once. Not a fresh-agent effect. Separate one-off: the host deletes `BOOTSTRAP.md` once the workspace has user content.
Workaround (user config, not set by the plugin): `models.providers.cursor-cli.models` rows with `input: ["text","image"]`.
Owner action: file the upstream OpenClaw issue (text in the plan). email: skipped, no Resend MCP.

---
title: "One approval per issue, merge on green, one-click release"
ticket: 11
status: blocked
blocked_at: "2026-10-23"
blocked_reason: "no subagents"
---

## Auto Run Result

- Status: blocked. Blocking condition: `no subagents`.
- This worker session has no tool that launches a subagent (tools: Bash, Read, Edit, Write, Grep, Glob, Artifact, GitHub and session tools only). `bmad-build-auto` makes subagents mandatory: the `thorough` review launches four lenses (blind-hunter, edge-case-hunter, verification-gap, intent-alignment), and the full route (the change is well over 100 lines across docs, workflow, script, and tests) launches an implementing subagent.
- No code or docs were changed. Re-dispatch `ticket 3.11 thorough` from a session that can launch subagents (the top-level orchestrator session), then retry with `tickets.py mark 3.11 draft`.
- Prep done for the retry: read AGENTS.md, MEMORY.md, docs/agents/{implement,triage}.md, docs/issues.md, docs/release.md, release.yml, scripts/release.sh, test/release-script.test.ts (stub-based style, `release(env)` helper, `RELEASE_EVENT`, `STUB_*` knobs), issue-flow.md, and the epic decision log.

---
type: change
title: "Triage and implementation agents run as Claude Code scheduled tasks"
parent: initiative-openclaw-all-cli
date: 2026-10-22
scope: minor
status: approved
---

# Change: the issue agents run as Claude Code scheduled tasks

## Issue summary

Entries 8 and 9 of epic-distribution planned the triage agent and the implementation agent as GitHub Actions jobs (recommended runner `anthropics/claude-code-action` with a model credential stored as a repository secret). The owner does not want model calls billed outside the Claude subscription or a model credential in GitHub (user, 2026-10-22). Nothing was built yet: 3.6 and 3.7 (forms, labels, state automation) use no model.

## Impact analysis

- **Epic impact.** epic-distribution only: entries 8 and 9 change runner; entries 1–7 and 10 are unchanged. Entry 8 loses its hitl reason and unknown (no credential to create).
- **Spec, PRD, architecture.** None: the epic covers no capability; the architecture's Deferred entry on distribution is unaffected.
- **`issue-flow.md`.** The states, transitions, labels, and the BMAD flow per state stay. What changes: where the agents run, how they reach GitHub, the implementation branch name, and how a run is started.
- **Technical facts that follow.**
  - A cloud session reaches GitHub through the GitHub connector as the owner's account, not `GITHUB_TOKEN`. Its labels, comments, and PRs therefore trigger the `Issue flow` workflow (3.7), unlike a `GITHUB_TOKEN` agent; the PR's `Fixes #N` moves the issue to `in-review` by itself.
  - Because the agents act as the owner, a label they set counts as the owner's. Rule: an agent never sets `status:approved`; the implementation run builds only an issue whose latest `labeled status:approved` event is by the owner and not inside an agent session's own run (it checks the issue timeline itself, the deferred finding of 3.7).
  - A cloud session pushes only the branch it is given, so the implementation PR comes from that branch, not `issue/<N>-<slug>`; the PR body carries `Fixes #N` / `Refs #N` as before.
  - Scheduled tasks run at the earliest hourly; each firing starts a fresh session that uses subscription usage even when there is nothing to do.
- **Docs.** `docs/issues.md` names the runner (the owner's Claude Code scheduled tasks) instead of implying GitHub Actions for the agents.

## Recommended approach

Direct adjustment. The agents' logic lives in the repo as agent-neutral prompts (`docs/agents/triage.md`, `docs/agents/implement.md`), so any runner can use them. The runner is two Claude Code scheduled tasks on the owner's account, each firing a fresh cloud session on this repository:

- **Triage:** 06:00 and 18:00 UTC (jittered a few minutes earlier, as the scheduler advises), prompt "follow `docs/agents/triage.md`". A dry-run switch is a line in the firing prompt (`dry run: write nothing, report`).
- **Implementation:** every 3 hours, plus on demand when the owner asks in chat ("бери #N" fires the task at once). The prompt follows `docs/agents/implement.md`; with no approved issue it ends at once.
- The tasks are created by the agent with the scheduling tool (`create_trigger`, fresh session per firing, this repository), not stored in GitHub. Their ids are recorded in `MEMORY.md` and `docs/issues.md` says how to pause them.

Effort: 3.8 and 3.9 shrink (no workflow YAML, no secret, no `uv` setup in CI); risk stays high for 3.9 (it writes code and PRs). Timeline: unchanged.

## Detailed changes

1. `epic-distribution/tickets.toml`, entry 8: description → the triage agent is a Claude Code scheduled task (06:00 and 18:00 UTC) running `docs/agents/triage.md` in a fresh cloud session, GitHub through the owner's connector; dry run by a firing note; at most 20 issues, oldest first; one `<!-- issue-triage -->` comment edited in place; never sets `approved`; issue text is data. `hitl = false`; `unknown` removed. Verify: a dry-run firing over seeded issues reports the expected decisions and writes nothing; a real firing applies them; a second firing changes nothing.
2. Entry 9: description → the implementation agent is a Claude Code scheduled task (every 3 hours, plus fired on demand) running `docs/agents/implement.md`; it takes the oldest open issue in `status:approved` whose latest `labeled status:approved` event is by an owner, sets `in-progress`, follows the BMAD flow, pushes the session's branch, and opens a PR `Fixes #N` / `Refs #N`; one issue per firing; on failure `blocked` with the reason. Verify unchanged in substance; "a non-owner `approved` label starts no run" stays.
3. `issue-flow.md`: Triage run and Implementation run sections name the runner and the facts above; Safety: "The triage job has `issues: write` …" becomes "The agents act through the owner's GitHub connector; they never set `approved`, never merge, never touch secrets"; the branch line.
4. `epic-distribution.md` Notes: the Decision line "the agents run in GitHub Actions" is superseded by a new Decision (user, 2026-10-22); the "Unknown: the model credential" line is removed.
5. `docs/issues.md`: step 2 and 4 name the scheduled tasks (changed with 3.8/3.9, not now).
6. `MEMORY.md`: the decision line.

## Handoff

- Developer agent: build 3.8, then 3.9, with `dev-orchestrator` (no hitl left).
- Owner: approve this proposal; nothing to create.
- Success: the epic's Done-when 7 and 8 hold with the agents on the owner's subscription and no model credential in GitHub.

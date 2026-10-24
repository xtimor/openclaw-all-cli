---
id: 8
type: bug
title: "Turn 2 of a fresh agent restarts cursor-agent"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# Turn 2 of a fresh agent restarts cursor-agent

## Description

Since ticket 6 a `cursor-cli` follow-up reuses the running `cursor-agent` process, but only from turn 3 of a fresh agent. Turn 2 still restarts it (about 3 s more to first text). After this, the exact host inputs that change between turn 1 and turn 2 are known, and the session keeps one warm process from turn 1 when a supported way exists; when none exists, the host cause is recorded and an upstream issue text is ready for the owner.

## Reproduction

1. Real Gateway, a fresh agent on `cursor-cli/auto`.
2. Send four short plain messages in one session.
3. Actual: the log shows `cli live session start` on turns 1 and 2 and `reuse=reusable-drift:prompt-tools` on turn 2; turns 3 and 4 reuse the process. Expected: one `cli live session start` for the whole session.

## Cause Hypothesis

OpenClaw 2026.10.3 hashes the system prompt and the prompt tool names into its live-session fingerprint. Between turn 1 and turn 2 only `systemPromptHash` and `promptToolNamesHash` differ; turns 2 to 4 are equal (ticket 6 fingerprint dump). The content of the change was never read. A likely source is first-turn bootstrap material (workspace bootstrap files, a new-session intro) or a tool list that is complete only after turn 1; unverified.

## Acceptance Criteria

1. **The drift is identified**
   **Given** a fresh agent through a real Gateway
   **When** the build dumps the fingerprint's hashed inputs (not only the hashes) for turns 1 to 3
   **Then** the plan records exactly which prompt text and which tool names differ between turn 1 and turn 2, and which host code path adds or drops them, with no key, token, or account id
2. **One warm process when supported**
   **Given** a supported plugin-side way to make turn 1 and turn 2 fingerprint-equal (a backend option, a prompt transport, or a host contract the plugin already uses)
   **When** the fix lands
   **Then** a live run shows one `cli live session start` for turns 1 to 4 of a fresh agent, and an OpenClaw tool call on turn 2 works
3. **Or the other valid outcome**
   **Given** no supported plugin-side way
   **When** the investigation ends
   **Then** the plan says why each candidate fails, the host cause is recorded in `MEMORY.md`, and a ready-to-file OpenClaw issue text (title, steps, the differing inputs, a proposed host change) is in the plan for the owner
4. **The model still gets what it needs**
   **Given** the fix
   **When** turn 1 runs
   **Then** the system prompt, skills, and tools the model receives on turns 1 and 2 are unchanged from today, proved by a test or a live dump
5. **Tests cover the condition**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the turn-2 restart and passes on the fix covers it (when there is a fix), and `npm run ci` passes

## Boundaries

- Must not change: tool routing, permissions, session resume, the system-prompt block rules, and the ticket 6 warm path (turn 3 on stays warm).
- No patch to installed OpenClaw files except a temporary probe that is restored after, and no use of private host internals that a host update would silently break without a failing test.

## References

- parent — none
- bug — _bmad-output/backlog/bug-15-20-s-to-first-token-because-cursor-agent-is-restarted-on-every-turn-plan.md, deferred and Measurements
- memory — MEMORY.md, "Warm process (backlog bug 6 ...)" (probe method: patch `buildCliLiveSessionFingerprint`, restore after)

## Notes

- Follows issue #11 (ticket 6 deferred item "Turn 2 of a brand-new agent still restarts"). Owner asked for the full investigation and the fix on 2026-10-24.
- Check outside the criteria: a live Gateway run (`NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1`) when `CURSOR_API_KEY` is set; otherwise recorded as not run.
- Risk medium: a wrong fix could drop the system prompt or tools on the first turns.
- Open question: whether a host-side change is the only fix; then it goes to the owner as an upstream issue, not a blocker.

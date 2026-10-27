---
id: 13
type: bug
title: "First replies still take 15-20 s; investigate a warm cursor-agent start per agent"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: high
severity: P2
---

# First replies still take 15-20 s; investigate a warm cursor-agent start per agent

## Description

The first replies of a new session take 15-20 s. Find what the time is made of and whether a warm start per agent (a kept process or a pre-loaded Cursor chat, forked per session) is safe. If no safe way exists, record the numbers and reasons.

## Reproduction

1. Gateway with 0.1.3, an agent on a `cursor-cli` model.
2. Start a new session, send a short message, measure the time to the first character of the first and second reply.
3. Actual: 15-20 s for the first replies. Expected: about as fast as later turns.

## Cause Hypothesis

Process start, `session/new` with the agent's whole bootstrap, and the model's first answer add up; the bootstrap is nearly constant per agent.

## Acceptance Criteria

1. **The time is split**
   **Given** a new session
   **When** the first turn is measured (live when `CURSOR_API_KEY` is set, otherwise recorded as not run)
   **Then** the numbers for process start, `session/new`, bootstrap prompt, and model time are written in `MEMORY.md` and `docs/`
2. **The idea is judged**
   **Given** the current `cursor-agent` and OpenClaw 2026.10.3
   **When** fork or copy of a chat, a plugin-owned process pool, the live-session fingerprint, and resume are checked
   **Then** the decision is written with cost and risk: bootstrap tokens, stale bootstrap, idle memory, isolation between agents
3. **No unapproved architecture change**
   **Given** a safe way that changes the process pool or the architecture
   **When** the investigation ends
   **Then** no such code is built; a course correction is proposed instead

## References

- parent — none
- source — GitHub issue #38

## Notes

- Issue: #38
- Outside check for this high-risk ticket: the owner reads the written decision. Earlier backlog tickets 6 and 8 found no ACP fork support; re-check with the current version.

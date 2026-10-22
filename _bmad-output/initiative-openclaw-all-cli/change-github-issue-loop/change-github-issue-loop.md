---
type: change
title: "GitHub issue loop: intake, twice-daily triage agent, owner approval, implementation agent"
parent: initiative-openclaw-all-cli
date: 2026-10-22
scope: moderate
status: approved
---

# Change: the GitHub issue loop

## Issue summary

The project has no intake for bugs and ideas from outside the planning sessions. The user asked (2026-10-22) that people and agents can file issues and ideas on GitHub, that an agent processes all open issues twice a day (confirm the problem, set a priority, ask for details, reject or hand to the owner for approval), that the owner's approval starts development, and that the ticket state flow be designed. All of it goes into epic-distribution. Type: new requirement from the stakeholder. Added the same day: every development, bug fix, and course correction goes through the BMAD flow in this repo, and the agent tickets must define which BMAD skills and agents run in each issue state.

## Impact analysis

- **Epic impact.** epic-distribution grows from "npm release" to "npm release and the GitHub issue loop": title, description, outcome, Done when (items 6 to 8), Boundaries, Notes. Entries 3.1 to 3.5 are unchanged. epic-cursor-cli and epic-antigravity-cli are unchanged.
- **Stories.** Four new: 3.6 issue forms, labels, guide; 3.7 state automation without a model; 3.8 triage agent twice a day (hitl: credential); 3.9 implementation run on approval.
- **Spec.** No capability covers project process; the new entries cover none. No spec edit.
- **Architecture.** Deferred, Distribution entry: one sentence that the issue loop is in epic-distribution and touches `.github/` and `scripts/issue-flow/`, not `src/`. No invariant changes.
- **Artifacts.** `.github/ISSUE_TEMPLATE/`, `.github/labels.yml`, `.github/workflows/` (labels, issue flow, triage, implement), `scripts/issue-flow/`, `SECURITY.md`, `docs/issues.md`, an agent-neutral triage prompt under `docs/agents/`, `README.md`.
- **Risk.** Issue text is untrusted and goes into an agent with repo access: prompt injection. Mitigated by least-privilege job permissions, the owner-only approval gate, no merge or tag rights for agents, and seeded injection cases in 3.8's verify. Cost: a model credential billed per run, capped per run.

## Recommended approach

Direct adjustment inside epic-distribution. The flow, states, transitions, priorities, and safety rules are in `epic-distribution/issue-flow.md`.

| Ticket | What | Risk | Order |
| --- | --- | --- | --- |
| 3.6 | Issue forms, labels as code, `docs/issues.md`, `SECURITY.md` | low | any time |
| 3.7 | Deterministic state automation (new, author reply, owner-only approve, PR links, stale) | medium | after 3.2, 3.6 |
| 3.8 | Triage agent at 06:00 and 18:00 UTC, dry-run mode | high, hitl | after 3.6, 3.7 |
| 3.9 | Implementation run on `status:approved` by the owner, PR with `Fixes #N` | high | after 3.2, 3.7, 3.8 |

The issue loop does not depend on the npm entries 3.3 to 3.5, only on CI (3.2). Effort: 3.6 and 3.7 about a day of agent work; 3.8 and 3.9 a day each once the credential exists.

## Detailed changes applied now

1. `epic-distribution/issue-flow.md`: new design note (states, transitions, labels, triage run, implementation run, safety).
2. `epic-distribution/epic-distribution.md`: title, description, outcome, Done when 6 to 8, Boundaries, References, Notes (two decisions, one unknown).
3. `epic-distribution/tickets.toml`: entries 6 to 9.
4. `tickets.toml` (initiative): epic 3 title.
5. `initiative-openclaw-all-cli.md`, Notes: decision line.
6. `architecture-openclaw-all-cli.md`, Deferred: Distribution entry extended.
7. `MEMORY.md`: decision lines (issue loop, BMAD only).
8. `issue-flow.md`: the BMAD requirement, the `planned` state, and a 'BMAD flow per state' table; entries 8 and 9 refer to it; epic Done when 9.
9. `AGENTS.md`: one rule line for the BMAD-only requirement (user asked to record it as a requirement).

## Handoff

- Developer agent: 3.6 now; 3.7 after 3.2; 3.8 and 3.9 after the credential.
- The user (hitl): approve this proposal and the flow; create the model credential for CI and store it as a repository secret (3.8).
- Success criteria: Done when 6 to 8 of epic-distribution.

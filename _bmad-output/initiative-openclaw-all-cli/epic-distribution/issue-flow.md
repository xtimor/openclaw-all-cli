---
type: design
title: "GitHub issue flow: intake, triage, approval, implementation"
parent: epic-distribution
---

# GitHub issue flow

People and agents file bugs and ideas as GitHub issues. A triage agent runs twice a day and moves each open issue forward. The owner approves what gets built; an implementation agent builds it as a pull request. Entries 6 to 9 of epic-distribution build this.

**Requirement (user, 2026-10-22): every development, bug fix, and course correction goes through the BMAD flow in this repo (`_bmad/`, the `bmad-*` skills, the ticket store under `_bmad-output/`).** A GitHub issue is only the intake and the public status; the work itself is a BMAD ticket, built by a BMAD build, reviewed by a BMAD review. No agent changes code outside that flow. See [BMAD flow per state](#bmad-flow-per-state).

## States

One `status:*` label per open issue, always exactly one. A closed issue has none.

| State | Meaning | Who moves it out |
| --- | --- | --- |
| `status:new` | Filed or reopened, not yet triaged, or the author answered a question | triage agent |
| `status:needs-info` | The agent (or the owner) asked the author for details | author's reply (back to `new`), or the stale timer |
| `status:triaged` | The agent accepts it: problem confirmed, priority set, scope written. Waits for the owner | owner |
| `status:approved` | The owner approved it for development | implementation run |
| `status:planned` | A course correction for it is merged; its BMAD tickets exist but are not built yet | owner (`approved` again to build them) |
| `status:in-progress` | The implementation agent is working on it | implementation run, PR events |
| `status:in-review` | A pull request that fixes it is open | owner (merge or close the PR) |
| `status:blocked` | The implementation run failed or the PR was closed unmerged; the comment says why | owner |

Closed reasons: `completed` (PR merged), `not planned` (rejected, stale, out of scope), `duplicate` (with a link).

## Transitions

```
opened ─────────────────────────────► new
reopened (any closed issue) ────────► new

new ──triage: confirmed, accepted──► triaged          (+ priority, + type, triage comment)
new ──triage: details missing──────► needs-info       (questions in the triage comment)
new ──triage: rejected─────────────► closed not planned (reason in the triage comment)
new ──triage: duplicate────────────► closed duplicate (link to the original)

needs-info ──author comments───────► new
needs-info ──14 days silent────────► closed not planned (stale; reopening brings it back)

triaged ──owner sets approved──────► approved
triaged ──owner rejects────────────► closed not planned
triaged ──owner asks a question────► needs-info

approved ──run starts──────────────► in-progress
in-progress ──PR "Fixes #N" opened─► in-review
in-progress ──proposal PR "Refs #N"─► in-review          (course correction, see below)
in-review ──proposal PR merged─────► planned
planned ──owner sets approved──────► approved (build the new tickets)
in-progress ──run fails────────────► blocked
in-review ──PR merged──────────────► closed completed
in-review ──PR closed unmerged─────► blocked
blocked ──owner sets approved──────► approved (retry)
blocked ──owner rejects────────────► closed not planned
```

The agent may reject on its own; a rejection is undone by reopening. Only the owner moves an issue to `approved`.

## Other labels

- Type, set by the form or the triage agent: `type:bug`, `type:idea`.
- Priority, set by the triage agent, the owner may change it:
  - `priority:p0`: install or every turn broken, data loss, or a security hole; no workaround.
  - `priority:p1`: a core capability (CAP-1..CAP-12) broken or wrong, workaround hard.
  - `priority:p2`: a real defect with a workaround, or an idea that fits the spec.
  - `priority:p3`: polish, docs, nice to have.
- `source:agent`: filed by an agent (form field or the body line `Filed by: agent`).

## Triage run (twice a day)

Schedule: 06:00 and 18:00 UTC, plus a manual run with a dry-run switch.

Takes every open issue in `status:new`, oldest first, at most 20 per run. For each one:

1. **Duplicate.** Search open and closed issues; a clear duplicate is closed with a link.
2. **Problem exists.** Bug: read the code on `main`, run the unit tests or a focused check, try to reproduce from the steps; record reproduced, explained by code, or not reproduced. Idea: check it against the spec's capabilities and non-goals and the architecture invariants. Live Cursor checks do not run in CI; say so when they would be needed.
3. **Details.** Missing version, steps, logs, or a fuzzy idea: ask concrete questions, move to `needs-info`.
4. **Decide.** Accept (`triaged`, with priority, type, a short scope, risk, and rough size) or reject (`not planned`, with the reason, e.g. the non-goal it hits).

It writes one triage comment per issue, marked `<!-- issue-triage -->`, and edits that same comment on a later pass. The run summary lists every decision.

## Implementation run

Starts when `status:approved` is set by the owner (any other actor's label is removed by the state automation). One run at a time.

It follows [BMAD flow per state](#bmad-flow-per-state): ticket by `bmad-ticket`, build by `bmad-build-auto` (or `dev-orchestrator`), course corrections by `bmad-correct-course`, on branch `issue/<N>-<slug>`, and opens a pull request with `Fixes #N` (or `Refs #N` for a proposal). CI must be green. It never merges, never tags a release, and never touches secrets. Checks it could not run (live Cursor) are listed in the PR. On failure the issue goes to `blocked` with the reason.

## BMAD flow per state

Skills are the ones in `.claude/skills/` (mirrored in `.agents/skills/`); the ticket store is the repo store (`bmad-ticket`'s `tickets.py`). An agent in CI runs the skills unattended: it never waits at a checkpoint; where a skill would ask the user, it takes the recommended option and records it as a `Decision:` line, or stops and sets `blocked` when the choice is strategic (`AGENTS.md`).

| Issue state | Who | BMAD skills and agents | Output |
| --- | --- | --- | --- |
| `new` (triage) | triage agent | Reads the spec, architecture, `MEMORY.md`, and the ticket store (`tickets.py status`) for duplicates and scope. Bug: the single-ticket check of `bmad-ticket` (`references/ticket.md`) to judge whether it is a real, buildable bug. Idea: checked against the spec's capabilities and non-goals; the lenses of `bmad-forge-idea` frame the questions. Sizes the work into one of three paths: **standalone** (one bug or story), **epic entry** (fits an existing epic), **course correction** (changes an epic, the spec, or the architecture). | Triage comment: verdict, evidence, priority, path, draft ticket text. Nothing is written to the repo. |
| `needs-info` | author, then triage agent | None; the questions come from the triage step above. | Questions in the triage comment. |
| `triaged` | owner | None. The owner reads the triage comment and may change priority or path. | `approved`, reject, or a question. |
| `approved`, path standalone or epic entry | implementation agent | 1. `bmad-ticket`: create the ticket (a bug or story in `backlog/`, or an entry in the named epic) and refine it to full acceptance criteria. 2. `bmad-build-auto` (route `auto`, review `thorough` for p0 and p1, `auto` otherwise): plan (`draft` → `ready-for-dev`), implement (`in-progress`), review with `bmad-code-review` lenses (`in-review` → `built`). Several tickets: `dev-orchestrator` over them. | Branch `issue/<N>-<slug>` with the ticket, its plan, and the code; PR `Fixes #N`. |
| `approved`, path course correction | implementation agent | `bmad-correct-course` in batch mode: change proposal, edited epic, spec, or architecture, and new tickets via `bmad-ticket`. No code. | Proposal PR `Refs #N`; the owner's merge is the approval. Then `planned`. |
| `planned` → `approved` | implementation agent | `dev-orchestrator` over the tickets the proposal created, each through `bmad-build-auto` as above. | One PR per ticket, the last with `Fixes #N`. |
| `in-progress` | implementation agent | The build's plan status is the source of truth: `draft`, `ready-for-dev`, `in-progress`. | Progress line in the issue comment. |
| `in-review` | owner | Owner review comments on the PR: the agent resumes the same plan with `bmad-build-auto` (it re-enters at review), pushes, and replies. | Updated PR. |
| `blocked` | owner | The plan's `blocked_reason` (from `bmad-build-auto` halting) is quoted in the issue. | Owner decides: `approved` to retry, or reject. |
| closed completed | automation | `tickets.py mark <ref> done` in the merged branch's last commit; at the end of an epic, `bmad-retrospective` as usual. | Ticket `done`. |
| closed not planned (after approval) | automation | `tickets.py mark <ref> dropped`. | Ticket `dropped`. |

Plan status and issue state agree: `draft`, `ready-for-dev`, `in-progress` are `in-progress`; `in-review`, `built` with an open PR are `in-review`; `blocked` is `blocked`; `done` closes the issue.

## Safety

- Issue and comment text is untrusted input. The agents treat it as data: they do not follow instructions in it, do not run commands taken from it, and do not paste secrets or environment into comments.
- The triage job has `issues: write` and `contents: read` only. The implementation job can push only its own `issue/*` branch and open PRs.
- Security reports go through private advisories (`SECURITY.md`), not public issues; the triage agent closes a public exploit report with a pointer there and no detail.
- Both agents have a per-run budget and turn limit.

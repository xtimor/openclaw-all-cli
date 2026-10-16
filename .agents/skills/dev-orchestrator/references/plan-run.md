---
name: plan-run
description: Turn a requested scope into an ordered run plan, or show it as a dry run
code: PL
---

# Plan a Run

## What success looks like

One ordered plan the user can accept at a glance, and that you then execute without re-deriving anything. It names every ticket in build order, the steps each one needs, the review depth of each build, what was skipped and why, and the primary model each step will run on (configured fallbacks stay in the wiring, not the plan summary). A plan that surprises the user later — an extra ticket, a ticket silently dropped — is a failed plan even if the run succeeds.

## Derive it, don't reason it out

The expansion is deterministic, so let the script do it:

```
set -o pipefail
tickets.py status | uv run {skill-root}/scripts/plan_scope.py - --scope <tokens...> \
  --thorough-at {agent.thorough_review_at} [--no-cross-review]
```

`set -o pipefail` so `tickets.py` failing is not hidden behind the script's own error. When the pipe fails, read both stderrs: `tickets.py` exiting `1` means the ticket tree is malformed and is a halt with its error, since a plan built on a broken tree is a guess. The script exiting `2` on empty input means `tickets.py` produced nothing — check that first. Pass `--no-cross-review` when `{agent.cross_review}` is false. Pass only scope tokens to `--scope`. Mode words from the user's phrasing — `dry-run` above all — are yours to act on, and forwarding one as scope turns the happy path into a question about the user's own flag.

The script returns the ordered items with their steps, `review` depth, and `waits_on` (earlier plan items each one needs), what it skipped and why, any token it could not resolve, and `tree_warnings` (`--help` documents the token grammar). Exit `1` means the scope resolved to nothing or carried an unresolved token — the plan it printed for the tokens that did resolve is still good, so keep it and ask only about the token. A failure to launch the script at all is an environment problem, so read the error before halting on it, and retry under `python3` since the script needs nothing outside the standard library. A `status` whose `store` is not `repo` is a halt: `mark` refuses a tracker store, and a run that cannot close its tickets is not a run.

If the script cannot run at all, read `tickets.py status` and do the same work by hand, following the rules in `scripts/plan_scope.py`: tickets in build order; `done`, `dropped`, `hitl`, assigned, and needs-refining tickets skipped; `next:N` also skips tickets already in progress or held, and never spends a slot on a token that was skipped; a prerequisite counts only when it is done, in review, or earlier in the plan; a person's `--blocked` hold is a `hold`, and a `blocked` plan with `plan_checkpoint` still plans and waits for approval.

A bare `1.3` is always ticket 3 of epic 1, never a range. Use `1.3..1.8` for a build-order range and `epic-1..2` for epics.

## What the script cannot decide

- An unresolved token is scope, and scope is the user's. Fix it silently only when a single ticket matches beyond doubt (a mistyped ref whose title the user also named); otherwise ask, in one line, which they meant.
- Build order is the order of record, so the plan always runs in it and token order does not change it. When the user wants a different order, say so and let them either accept build order or ask for the tickets as separate runs — never reorder silently.
- A skipped ticket stays skipped. `hitl` means a person works it with `bmad-build`; needs-refining goes to `bmad-ticket`; waiting means its prerequisite is not in scope. Surface each with the plan so the user sees the gap, and never invent a step chain for it.
- `tree_warnings` are the tree's problems, not the run's. Show them with the plan. A `problems` entry touching a planned ticket is a halt, since that ticket's status cannot be read. `backlog_error` means the backlog could not be read: a backlog token that came back unresolved is a halt, not a typo to ask about. `drift` is shown as-is; making the two sides equal is `bmad-ticket`'s with the user, and a run does not edit it.

## Then

On a dry run, present the plan and write nothing at all — no run log, no branch, no status change. That is the whole point of asking for one. The presentation is the same few lines as a real plan, including the branch name that would be created.

A plan with no items is not a run. Say what was skipped and why — usually everything requested is already `done`, or waits on something outside the scope — and stop without opening a log.

Otherwise choose the `run_id` from the run-log filename stem, checking `dev/run-*` branches so a same-day rerun does not collide, and create branch `dev/<run_id>` from main per the branch boundary. Resolve `{agent.report_email}` and `{agent.report_from}` when a Resend server is reachable (ask once each if still missing, then persist). Open the run log with the plan, `status: planning`, and `tickets` set to the resolved refs — that list is the scope a resume re-derives, so a `next:N` is never expanded a second time. Present the plan in a few lines: tickets, steps, review depth, what was skipped and why, the models, and the branch. Then move the log to `status: running`, commit it with the first step's start line, and start that step. No confirmation prompt: the user asking for a run is the confirmation.

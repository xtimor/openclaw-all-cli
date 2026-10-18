---
name: run-step
description: Execute the next planned step, close it, and advance or halt
code: RS
---

# Run a Step

## What success looks like

The step ran on its primary model, or on the configured fallback when the primary was unavailable before work started; its result was judged from the plan file rather than accepted from chat; its work is committed and pushed; the run log and the ticket tree agree with what is on disk; and the run either advanced to the next step or halted with a reason a stranger could act on.

## Before you dispatch

Check for a stop request first — if one is pending, hand off to `references/hold-and-resume.md` rather than starting anything new. Then confirm the tree is clean: uncommitted work you did not put there is not yours to bury under a step commit, and `bmad-build-auto` refuses a dirty tree anyway. The step's start line is already in the committed log from the last boundary.

Check the step's precondition too, because a plan can outlive the truth it was built on: run `tickets.py find <ref>` and read the plan's current `status`. A `review` or `close` with no plan file on disk is an environment halt, not a guess at free intent. A ticket whose status moved while the run was in flight may need a different step than the one queued. Re-derive the step from the current status rather than dispatching a stale one, and say so when you do. A step the journal already closed is never dispatched again, including an `approve` already recorded.

## The steps

**`plan`** dispatches the planning worker on `{agent.model_plan}` (not the build model) with `ticket <ref>. Halt after planning.` Planning needs no sub-agents, so it runs in a worker even when the orchestrator runs at the top level; do not write the plan in the orchestrator's own session, whatever model that session runs on. A good result is the plan at `ready-for-dev`; `approve` follows, then `build` runs on `{agent.model_build}`.

**`approve`** is the entry's `plan_checkpoint`. Show the user the ticket, or the plan path with its intent and risk in three lines, and hold as `waiting_for_user` per `references/hold-and-resume.md`. An approval is logged and the run continues. Requested changes are the user's to make or to dictate; apply them to the plan outside its `<intent-contract>` unless they change the intent itself, commit, and continue.

**`build`** dispatches the build worker with `ticket <ref>`, plus `thorough` when the review depth is `thorough`. The depth starts as the plan item's `review`; after a build, re-read `risk` from the plan, and if it now meets `{agent.thorough_review_at}` the following review is `thorough` even when the item said `quick`. A good result is `built`. Any other non-blocked status means the worker stopped early; dispatch it again, since `bmad-build-auto` resumes from the plan's status, and count it as an attempt. When `{agent.cross_review}` is false there is no review step: a `built` result that still recommends a follow-up is closed anyway, and the journal records that the recommendation was declined by policy.

**`review`** dispatches the review worker on `{agent.model_review}` with invocation `ticket <ref>`, plus `thorough` at the depth above. Naming the ticket keeps the HALT protocol's `ticket_args`, so a blocked halt still writes `blocked_reason`; pointing at the plan file alone would not. `bmad-build-auto` runs a fresh follow-up review on a `built` plan and may patch. A good result is `built` with `followup_review_recommended: false` and no re-derivation. When the recommendation comes back `true`, run another pass, up to `{agent.review_limit}` passes; the pass after the limit is an escalation, because review that will not converge is evidence the ticket or the plan is wrong rather than the code. The diff since the build's baseline includes the run-log commits; findings about the runs directory are out of scope and the brief already says so. If the worker rewrote the log anyway, restore it from the last commit.

**`unblock`** routes the plan's `blocked_reason`, or the entry's `unknown`, through `references/route-question.md`, then lifts the block as described below. A `hold` is not an unblock: someone asked to be waited for, and you wait.

**`close`** runs `tickets.py mark <ref> done` when `{agent.ticket_done_at}` is `done`, and commits it; with `built` it leaves the ticket for a person and logs that. Nothing but a clean last review closes a ticket. `mark` refuses a tracker store; this skill runs on the repo store, and a `status` whose `store` is anything else is a halt at plan time.

**`hold`** waits as `waiting_for_user` until the user says continue. It is the entry's `done_checkpoint`, a person's `mark <status> --blocked` (status other than `blocked`, reason in `hold_reason`), or an epic gate at the end of a run. You never clear a person's hold yourself.

## Judging what comes back

Read the plan's frontmatter yourself: `status`, `blocked_reason`, `followup_review_recommended`, `deferred`, `risk`. Read the result with suspicion. A worker reporting success while the plan says otherwise, or while the ticket's `verify` is visibly unmet in the plan's `Auto Run Result`, is a failed step.

A `blocked` plan is classified by its reason before anything else:

| Blocking condition | Class | Lift it by |
| --- | --- | --- |
| `unclear intent`, `intent gap`, `matrix ambiguity`, `plan failed ready-for-development standard`, and a halt whose reason is the unresolved questions themselves | a question | answering it per `references/route-question.md`, then the plan repair below |
| `implementation verification failed`, `patch verification failed`, `matrix test audit failed` | a work failure | marking `ready-for-dev` and building again on `{agent.model_rework}`, within `{agent.rework_limit}` attempts |
| `review repair loop exceeded 5 iterations (non-convergence)` | an escalation | not a retry: the counter is already past the limit, so another build halts on the first loopback |
| `handoff conflicts with plan` | an escalation | the conflict is between the skill's handoff and the plan, and it recurs until a person changes one of them |
| `blocked plan supplied` | the reason already in the plan | re-read `blocked_reason` and classify that; the halt wrote nothing new |
| `dropped plan supplied` | dropped | skip the ticket, leave the plan `dropped` |
| a dirty tree, a branch mismatch, `version-control metadata not writable`, `finalization left repository dirty`, `no subagents`, `ticket not resolved`, a missing or vanished plan file | the environment | fixing it when the cause is yours or operational, else halting `blocked` |

A work failure gets its `Auto Run Result` read before the retry: when the failing check is environmental — a sandboxed shell that cannot reach the Cursor login, the isolated OpenClaw not running, a missing credential — it belongs to the environment row, and a retry that changes nothing is not an attempt worth spending. The attempt after `{agent.rework_limit}` is an escalation, because the third identical failure is evidence the ticket or the plan is wrong rather than the code.

A follow-up review that reverted the ticket is not a successful review. `intent gap` saved the change as a `.patch` beside the plan and reverted the code: route the question, and when it is answered `git apply` the patch, `tickets.py mark <ref> in-review`, and dispatch `review` again. Do not rebuild from scratch. A re-derivation (`bad_plan` in the plan's change log, with new implementation commits from the review worker) counts as a review pass that did not converge: keep the code, and the next pass is another `review`, spending `{agent.review_limit}`.

To lift a question, record the grounded answer as a dated `Decision:` line where the build reads it as intent: the leaf file's Notes when the ticket has a file, or the epic file's Notes when it does not. An `unknown` on a pulled ticket is the file's `Unknown:` lines, so clear it there; `tickets.py` no longer reads the entry. On an entry with no file, clear `unknown` from that entry in `tickets.toml` and put the `Decision:` line in the epic's Notes. Then make the plan match:

- A plan with an `<intent-contract>`: amend that block with the answer — its read-only rule binds the build, and you stand where the user would — then `tickets.py mark <ref> draft`, which clears `blocked_at` and `blocked_reason`. Leave an `intent gap` patch in place for the path above; that one is applied, not rebuilt.
- A plan holding only frontmatter: delete it, so the next build starts fresh from the ticket and reads the new `Decision:` line. Marking it `draft` instead would send the build past the step that loads the ticket's intent.
- No plan: nothing to change.

Commit, and dispatch the next `build`. A ticket whose `plan_checkpoint` is still ahead of an approval goes through `plan` and `approve` first; the unblock does not skip them.

A ticket you could not unblock stops the run when `{agent.blocked_policy}` is `stop`. With `continue`, skip every later item whose `waits_on` reaches it, say which ones and why, and move on.

## Closing the step

A halt commits nothing of its own, so the tree is dirty and you decide what survives:

- Always commit the plan file and a `.patch` the halt saved beside it.
- A work failure you will retry: commit the product code too. It is the checkpoint the retry continues from, and the message says so (`Ticket 1.3: checkpoint after verification failed`).
- An `intent gap` whose code the worker already reverted: commit the plan and the patch only. Discard anything else the attempt left untracked.
- An environment halt you are not retrying: commit the plan so the reason survives, and leave product code uncommitted only when it is half-written and the journal says you discarded it. Say which.

Then append the closing line and the next step's start line to the run log, commit the log, and push. Verify the state matches the claim: `tickets.py status` should show the ticket where the step left it. When it does not, fix it and note the correction rather than assuming the worker knew better.

Then report the boundary in one line and start the next step. When the plan is empty, look at the tickets the plan skipped as `waiting on epic <slug> not done`. If every ticket of that epic is now done, the gate is the user's: hold as `waiting_for_user` and ask, in one line, to close the epic through `bmad-ticket`. Do not close it yourself, and do not end the run while scoped tickets are waiting only on that. Otherwise close the run log with `status: completed` and a summary per ticket: outcome, commits, review passes, and the plan's `deferred` findings, which are the user's to turn into tickets or not. For every epic the run touched — never the backlog — whose tickets are now all done, recommend `bmad-retrospective` and say the epic itself is the user's to close. Commit and push the log, then send the completion email per the Run Wiring contract.

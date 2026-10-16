---
name: hold-and-resume
description: Hold a run without losing work, and resume it from its checkpoint
code: HR
---

# Hold and Resume

## What success looks like

The user says stop and nothing finished is lost. Every completed step is already committed and pushed, the run log names the exact point the run reached, every plan's status agrees with what is on disk, and a later resume continues from the next step instead of redoing work or double-committing it.

## Holding

A stop request reaches you as a message at a turn boundary, which is the only place it can land while workers are awaited synchronously. Record it in the run log the moment it arrives, so it survives even if the turn does not. Then start nothing new: no next step, no next ticket.

For the step already in flight, let it finish and close normally — that is the cheap, consistent path, and the worker's plan file keeps its progress either way. Abort mid-step only when the user asks for an immediate halt; then restore that step's tracked files to the last commit and delete the untracked files it created, since a restore alone leaves new files behind and half-written work is what a clean stop exists to prevent. Keep the commits the worker already made. Log what you discarded.

Then make the state honest: commit the last completed step if it somehow is not committed yet, set any plan whose status claims progress the tree no longer shows back with `tickets.py mark <ref> <status>` (a plan whose implementation you discarded goes back to `ready-for-dev`), and write the checkpoint — last completed step, its commit SHA, ticket ref, position in the plan. Close with `status: stopped_clean`, commit and push the log, and tell the user in three lines what got done, where the checkpoint is, and how to resume.

A ticket left mid-build keeps the plan status that matches the tree, never `built` or `done` ahead of its review. Reporting a ticket further along than it is turns a clean stop into a corrupt one.

## Resuming

Take the run id, or the most recent held run. The log is on the run branch, so from `main` find it with `git branch -a --list 'dev/run-*'` rather than by listing files. Check out the run's branch `dev/<run_id>` when you are not already on it. Verify the checkpoint commit exists and the tree is clean and compatible with it; if someone changed the branch underneath the run, say so and ask before proceeding rather than committing on top of a moved base.

Then re-derive the remaining steps from `tickets.py status` through `scripts/plan_scope.py`, passing the log's `tickets` refs and not the original tokens — a `next:N` expanded once must not pick up new tickets just because the first ones are done. Statuses may have moved since the hold, and the user may have built or closed a ticket by hand. Continue from the first step the checkpoint did not cover. Steps the journal already closed are never rerun, and an `approve` the run log already records is not asked again. A ticket the journal closed at `built` because `{agent.ticket_done_at}` is `built` stays closed even though a fresh derivation would review it again.

An escalation, an `approve`, and a `hold` all wait through this same procedure — the in-flight step is closed or discarded, the checkpoint is written, and the status is `waiting_for_user` instead of `stopped_clean`. When the answer arrives the checkpoint is still valid and the run continues from it.

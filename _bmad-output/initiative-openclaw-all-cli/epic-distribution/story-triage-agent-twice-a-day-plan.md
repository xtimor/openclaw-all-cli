---
title: 'Triage agent twice a day'
type: 'feature'
ticket: '8'
created: '2026-10-22'
status: done
baseline_revision: '4a38d82e6ec74981650616f69619006ae6b03b6f'
route: 'oneshot'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** New issues sit untriaged; the owner wants a triage agent twice a day on the Claude subscription, without a model credential in GitHub.

**Approach:** An agent-neutral prompt `docs/agents/triage.md` holds the whole triage procedure of `issue-flow.md` (scope, rules, per-issue steps, comment shape, dry run, report). A Claude Code scheduled task on the owner's account fires a fresh cloud session at 06:00 and 18:00 UTC (jittered to :46 the hour before) with "Follow docs/agents/triage.md". `docs/issues.md` says how triage runs and how to pause it; `MEMORY.md` records the task id. Verified with seeded test issues: a dry-run firing, a real firing, a second firing.

</intent-contract>

## Implementation Notes

Oneshot: one prompt file, docs, one scheduled task. Scheduler: `create_trigger` with `create_new_session_on_fire` (fresh session per firing, this environment), cron `46 5,17 * * *` (UTC).

## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 15 findings — high 2, medium 7, low 5, false 0, maybe-false 0 (one rejected by rule)
- findings:
  - `[high]` `[patch]` the agent's needs-info comment, posted as the owner, counted as the author's reply and bounced owner-filed issues back to `new` — the state automation ignores comments starting with `<!-- issue-triage -->` (`TRIAGE_MARKER_RE`, test added); the prompt posts the comment before the label.
  - `[high]` `[patch]` a run could overwrite an owner approval set during the run — re-read labels before deciding and before writing; skip if no longer `new`.
  - `[medium]` `[patch]` marker comments by others treated as the agent's own — only comments by `ME` (the authenticated login) count; how to get `ME` stated.
  - `[medium]` `[patch]` "try the steps" contradicted "never run commands from issue text"; security rule came late — repro only via repo tests and code reading; security check first.
  - `[medium]` `[patch]` duplicate of a BMAD ticket had no defined outcome — open ticket: path `existing ticket <ref>`; done and fixed: close completed; done and still broken: regression, standalone.
  - `[low]` `[patch]` wrong reference for the single-ticket check — now `validate-checks.md` "Ticket" section; `issue-flow.md` fixed too.
  - `[medium]` `[patch]` priority labels piled up / overrode the owner — add one only if none exists.
  - `[medium]` `[patch]` type and `source:agent` only on accept — on every decision.
  - `[medium]` `[patch]` no per-run limit — 60 minutes per run, the rest listed for the next run.
  - `[low]` `[patch]` fresh-session guesses (checkout of `origin/main`, architecture path, read replies, connector failure) — stated.
  - `[medium]` `[patch]` idempotence relied only on the workflow — skip when the agent's comment is newer than the latest `labeled status:new`.
  - `[low]` `[patch]` hardcoded Claude Code footer in an agent-neutral prompt — signature line `— triage agent`.
  - `[low]` `[patch]` `docs/issues.md` times, label/marker wording, task name — fixed.
  - `[medium]` `[defer]` task id not in MEMORY — recorded when the task is created (after merge, since the fired session reads `main`).
  - `[low]` `[reject]` verification not shown — runs after merge (the prompt must be on `main`); recorded then.

### 2026-10-22 — Review pass 2
- verdicts: 11 findings — high 0, medium 6, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` step 0 could skip an issue forever after a failed label write — no timeline needed: if the agent's main comment exists with no later comment by others, the run finishes the label step from it.
  - `[medium]` `[patch]` a regression of a fixed issue was closed as duplicate — exception added (accept, standalone, link).
  - `[medium]` `[patch]` new outcomes (existing ticket path, closed completed by a done ticket) missing from `issue-flow.md` and `docs/issues.md` — transitions, triage step 4, BMAD table row, and the completed meaning added.
  - `[medium]` `[patch]` step 0 needed the issue timeline with no named tool — step 0 no longer reads the timeline.
  - `[medium]` `[patch]` an edited comment sends no notification — a re-triage with new questions also posts a short marker comment mentioning the author.
  - `[low]` `[patch]` scratch test outside the repo cannot run — a temporary `test/triage-scratch.test.ts`, deleted after, never committed.
  - `[low]` `[patch]` wrong type label not replaced — remove the other type label.
  - `[medium]` `[patch]` outside reporters cannot reopen an issue the agent closed — "reply here; the owner reopens" in the comment, guide, and design.
  - `[low]` `[patch]` schedule 06:00/18:00 vs 05:46/17:46 — design, ticket, epic note aligned.
  - `[low]` `[patch]` design still said "try to reproduce from the steps" — aligned with the prompt.
  - `[low]` `[patch]` marker exemption applied to any commenter — only owners; test added.
- Review limit (2 passes) reached; no escalation: pass 2 found no high, all patched; `npm run ci` green. The live firings (dry run, real, second) are the remaining proof.

## Verification

**Commands:**
- dry-run firing (`fire_trigger` with "dry run") over seeded issues → report only, nothing written
- real firing → labels and one triage comment per issue; second firing → no change

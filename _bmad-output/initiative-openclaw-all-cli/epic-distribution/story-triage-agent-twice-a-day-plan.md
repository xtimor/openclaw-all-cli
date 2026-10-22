---
title: 'Triage agent twice a day'
type: 'feature'
ticket: '8'
created: '2026-10-22'
status: 'in-progress'
baseline_revision: '4a38d82e6ec74981650616f69619006ae6b03b6f'
route: 'oneshot'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
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

## Verification

**Commands:**
- dry-run firing (`fire_trigger` with "dry run") over seeded issues → report only, nothing written
- real firing → labels and one triage comment per issue; second firing → no change

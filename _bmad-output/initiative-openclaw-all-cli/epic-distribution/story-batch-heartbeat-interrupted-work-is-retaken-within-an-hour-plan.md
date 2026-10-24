---
title: 'Batch heartbeat: interrupted work is retaken within an hour'
type: 'bugfix'
ticket: 18
created: '2026-10-23'
status: done
baseline_revision: '703418530e2375a0b661c9f46a1000ee9b108a54'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['self']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** After the owner closed draft #24 by hand, #14 stayed `in-progress` and the next run built nothing for 6 hours, holding #9 and #11 back too.

**Approach:** Runs refresh their draft every 30 minutes; an idle in-progress draft (1 hour) or an orphaned `in-progress` issue is retaken under the standing approval; only an open batch PR stops a new batch; an owner-paused batch is never closed.

</intent-contract>

## Implementation Notes

Oneshot (about 40 changed lines): `scripts/agent-write.mjs` IDLE 4 h → 1 h and `pr_close` only for the exact title `Issue batch (in progress)`; tests for the 1-hour boundary and a paused-title refusal (mutation: removing the title check fails a test); `docs/agents/implement.md` step 2 (paused vs interrupted), step 4 (orphans retaken, never blocked, never holding others), step 8 heartbeat; `identity.md`, `issues.md`, `issue-flow.md`, `MEMORY.md`.

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Self review
- The 1-hour window vs a live run: runs push after each issue and now refresh at least every 30 minutes, also during live checks and check waits. A run that dies after retitling but before ready leaves a paused-looking draft: reported, not closed (safe side).

## Verification

**Commands:**
- `npx vitest run test/agent-write.test.ts` -- 33 passed
- `npm run ci` -- "All checks passed."

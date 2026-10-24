---
title: 'Interrupted window of 2 hours; an approved asset ships at the path the host reads'
type: 'bugfix'
ticket: 19
created: '2026-10-24'
status: done
baseline_revision: '8bdcb0c797df814637027e1eec3b3a8696ff841b'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
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

**Problem:** A 63-minute build broke the 1-hour interrupted window, and #9 was blocked over an icon path the draft guessed wrong.

**Approach:** 2-hour window; approved assets ship at the path and format the host reads.

</intent-contract>

## Implementation Notes

Oneshot: `IDLE_MS` 2 h with boundary tests (1h59 refused, 2h01 closed); window text in implement/identity/issues/issue-flow; files exception for an approved asset's single files under `assets/`; MEMORY.

## Review Triage Log

### 2026-10-24 — Self review
- 2 h covers the longest observed gap (63 min) with margin; orphan pickup within about 2 h still meets the owner's "no waiting on me" goal.

## Verification

- `npx vitest run test/agent-write.test.ts` -- 33 passed
- `npm run ci` -- "All checks passed."

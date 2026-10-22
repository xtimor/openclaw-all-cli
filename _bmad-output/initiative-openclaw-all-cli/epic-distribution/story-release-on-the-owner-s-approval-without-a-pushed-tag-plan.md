---
title: 'Release on the owner''s approval, without a pushed tag'
type: 'feature'
ticket: '10'
created: '2026-10-22'
status: 'in-review'
baseline_revision: '65cd12e82f8b12f947059670d3013f52e6ad9dbb'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
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

**Problem:** The agent cannot push git tags from its session, but the owner wants to approve a release with one word and have the agent do the rest.

**Approach:** `release.yml` passes `RELEASE_EVENT` (`github.event_name`). In `scripts/release.sh`, a real run from `workflow_dispatch` creates the release itself: it requires HEAD on `origin/main` and the tag absent locally and on `origin` (fails before checks otherwise), runs the same steps, and `gh release create` creates the tag at HEAD (`--target <HEAD sha>`, no `--verify-tag`) after publish or stage succeeded. A tag push keeps the current checks (tag exists, HEAD is the tag, on main) and `--verify-tag`. Dry runs are unchanged. `docs/release.md` "Cut a release" says the agent asks, the owner approves, the agent dispatches; pushing a tag stays an alternative. Tests in `test/release-script.test.ts` cover dispatch on main, dispatch with an existing tag (local or remote), dispatch off main, and the unchanged tag-push path.

</intent-contract>

## Implementation Notes

Oneshot: about 40 lines in the script, one env line in the workflow, tests, a docs paragraph. A tag created by `GITHUB_TOKEN` triggers no workflow, so the dispatch run does not start a second tag-push run.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `bash -n scripts/release.sh && npx vitest run test/release-script.test.ts` -- expected: pass
- `npm run ci` -- expected: exit 0

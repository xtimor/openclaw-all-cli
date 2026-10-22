---
title: 'Release on the owner''s approval, without a pushed tag'
type: 'feature'
ticket: '10'
created: '2026-10-22'
status: 'built'
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

### 2026-10-22 — Review pass
- verdicts: 5 findings — high 1, medium 2, low 2, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` a failing `git ls-remote` read as "tag is new" (and the stub exited 1 on no tag) — output captured with `|| fail`; stub exits 0; test for an unreadable origin added.
  - `[medium]` `[patch]` dispatch accepted any ancestor of `origin/main` (stale ref, re-run after a fix) — dispatch now requires HEAD == `origin/main`; test added; docs say to dispatch a new run, not re-run.
  - `[medium]` `[patch]` `docs/release.md` intro, step 1, and "CI never moves tags" described only the tag push — rewritten for both paths.
  - `[low]` `[patch]` stale comments in `release.yml` and the script header — updated.
  - `[low]` `[patch]` manual recovery after a failed GitHub release step lacked the commit and the tarball — the script prints `release commit: <sha>, tarball sha256: <sha256>` before `gh release create`; docs take the tarball from npm (`npm pack openclaw-all-cli@X.Y.Z`) and give the full command.

### 2026-10-22 — Review pass (follow-up)
- verdicts: 8 findings — high 0, medium 1, low 7, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` MEMORY.md quoted a Ukrainian word (project in English) — now "release?".
  - `[low]` `[patch]` README still said "cut a release from a tag" — now names the approval flow.
  - `[low]` `[patch]` recovery advice wrong for a failed tag-push run and for re-runs — split per path.
  - `[medium]` `[patch]` first-release manual fallback assumed a GitHub release and tag that the dispatch path never created — now builds from the run's commit, publishes with 2FA, and creates the release and tag with `--target`.
  - `[low]` `[reject]` tag pushed by hand between the check and `gh release create` — needs a person to push the same new tag during a run they approved; the fix is an extra guard.
  - `[low]` `[patch]` duplicate "off main" test (dispatch never calls merge-base) — removed; the head-of-main test covers it.
  - `[low]` `[patch]` no test for a dispatched dry run — added (no git calls, no tag or head requirements).
  - `[low]` `[reject]` verification records in the plan — plan edit (rule); `npm run ci` after these patches: green; the GitHub dispatch dry run runs after merge.

## Auto Run Result

- Summary: a real `workflow_dispatch` run on `main` releases `main`'s head and the GitHub release creates the new tag (`--target`); tag pushes are unchanged.
- Review: 5 patched (1 high, 2 medium, 2 low), 0 deferred, 0 rejected.
- Follow-up review recommended: true by the rule (a high was patched); the risk named: the dispatch path itself is proven only by stubs until a real dispatched release runs. Covered by the release run that follows, which the owner approves.
- Follow-up pass: no high; converged.
- Verification: 41 release-script tests and `npm run ci` green after the follow-up patches; `npm run ci` green (962 unit tests) before the review patches; dispatch dry run on GitHub (run 39814678405) green before this change.

## Verification

**Commands:**
- `bash -n scripts/release.sh && npx vitest run test/release-script.test.ts` -- expected: pass
- `npm run ci` -- expected: exit 0

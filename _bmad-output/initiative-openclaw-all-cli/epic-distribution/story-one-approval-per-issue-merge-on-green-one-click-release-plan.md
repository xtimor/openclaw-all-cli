---
title: 'One approval per issue, merge on green, one-click release'
type: 'feature'
ticket: 11
created: '2026-10-23'
status: 'ready-for-dev'
baseline_revision: 'a8c2509a842c1d9a332d2af70e36d9cd473161fb'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** After the owner approves an issue, a batch pull request still waits for the owner to merge it, a course correction needs a second approval, and a release needs a hand-picked tag. The owner wants one touch per issue (`status:approved` after triage) and a release they start whenever they like with one action.

**Approach:** The implementation agent merges its own green batch PR (in the run, or at the start of the next run), builds `status:planned` issues without a second approval, and the release dispatch computes the next version when no tag is given.

## Boundaries & Constraints

**Always:** the agent merges only an open PR from this repository whose title starts with `Issue batch`, that is not a draft, whose head checks all completed with `success` (or `skipped`/`neutral`), whose mergeable state is `clean`, with merge method `merge` and the expected head sha. Owner-only `status:approved`, protected files, no secrets, no tags or releases by the issue agents stay as they are. Release: an explicit tag keeps today's behavior exactly; the tag push path is unchanged.

**Never:** merge any other PR; force-push; auto-approve issues; release from the issue agents; change `scripts/issue-flow/` or the state machine (a merge already closes `Fixes` issues and moves `Refs` issues to `planned`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Next patch | dispatch, tag empty, bump patch, origin tags v0.1.0 v0.1.1 v0.2.0-rc.1 | tag v0.1.2 printed and released | — |
| Next minor / major | same tags, bump minor / major | v0.2.0 / v1.0.0 | — |
| No stable tag | no `v*` tag (or only prereleases and `-dryrun.`) | base 0.0.0: patch v0.0.1 | — |
| Bump unset | dispatch, tag empty, RELEASE_BUMP unset | patch | — |
| Bad bump | RELEASE_BUMP=huge | fail before any check, names the allowed values | exit 1 |
| Empty tag on push | RELEASE_EVENT=push, tag empty | fail "a tag push needs a tag" | exit 1 |
| Origin unreadable | ls-remote fails while computing | fail before checks, nothing released | exit 1 |
| Explicit tag | dispatch with tag v1.0.1 | unchanged behavior, bump ignored | — |

</intent-contract>

## Code Map

- `scripts/release.sh` -- tag validation at "validate the tag and the mode" (`TAG`, `SEMVER`, `RELEASE_EVENT`); add the computed tag before `[[ "$TAG" =~ $SEMVER ]]`. Read origin tags with `git ls-remote --tags --refs origin 'refs/tags/v*'` (the script already reads origin with ls-remote; local tags can be stale). Stable = matches `^v[0-9]+\.[0-9]+\.[0-9]+$`; highest by `sort -V`. Update the header comment's Env list (`RELEASE_BUMP`).
- `.github/workflows/release.yml` -- `inputs.tag` `required: false`, `default: ''`; new `bump` input (`type: choice`, options patch/minor/major, default patch); env `RELEASE_BUMP: ${{ inputs.bump }}` (empty on push). Event data only via env.
- `test/release-script.test.ts` -- stub `git` `ls-remote` branch (lines ~60-63): add `STUB_REMOTE_TAGS` (space-separated tag names, printed as `<sha>\trefs/tags/<tag>` lines) used when the pattern is `refs/tags/v*`; keep `STUB_REMOTE_TAG`/`STUB_LS_REMOTE_FAIL`. New describe block for the matrix above, in the file's style (`release(env)`, `called(o, ...)`).
- `docs/agents/implement.md` -- Rules ("You act as the owner": allow merging own batch PR per Always), "Before the batch" step 2 (open batch PR: green → merge, then continue; checks pending → wait up to ~20 min polling ~1 min; red/conflicted/draft → report and end; a draft `Issue batch (in progress)` older than 6 h → report as interrupted), step 5 (`status:approved` and `status:planned`), step 6 (planned: the latest `labeled status:approved` by an owner in history), "Open the pull request" (wait up to ~30 min for checks; green → merge; red → one fix attempt through BMAD if the cause is in the batch, else leave open; timeout → leave open), course correction rides the batch PR, Report gains "merged".
- `docs/agents/triage.md` -- "Then: implementation": approved and planned issues.
- `docs/issues.md` -- intro, states table (`approved`, `planned`, `in-review` rows), "What happens when" steps 4-5: one approval, the agent merges, owner releases (link `release.md`); owner can still close a batch PR or revert.
- `docs/release.md` -- "Cut a release": tell an agent "release", or Actions → Release → Run workflow on main, tag empty, bump, `dry_run` off. Mention the computed tag in the steps list.
- `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`, `epic-distribution.md` (decision log, 2026-10-23), `MEMORY.md` -- the new flow in short.
- Do not change: `scripts/issue-flow/*`, `.github/workflows/issue-flow.yml`, `_bmad/custom/dev-orchestrator.toml`.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/release.sh` -- compute the tag when empty on dispatch, validate `RELEASE_BUMP`, refuse empty tag on push -- one-step release
- [ ] `.github/workflows/release.yml` -- optional tag, `bump` choice, `RELEASE_BUMP` env -- the UI for it
- [ ] `test/release-script.test.ts` -- stub support and tests for every matrix row -- prove it
- [ ] `docs/agents/implement.md`, `docs/agents/triage.md` -- merge on green, planned without second approval -- the agent's behavior
- [ ] `docs/issues.md`, `docs/release.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md` -- docs of record

**Acceptance Criteria:**
- Given a dispatch with no tag, when `scripts/release.sh` runs, then it prints the computed tag and releases it as if that tag was given.
- Given an open green batch PR at the start of a run, when the agent follows `implement.md`, then it merges it before starting a new batch.
- Given a batch the agent just opened, when its checks pass within the wait, then the agent merges it and its `Fixes` issues close with no owner action.
- Given a `status:planned` issue whose owner approval is in its history, when a run starts, then it is built without a new approval.
- Given the docs, when the owner reads `docs/issues.md` and `docs/release.md`, then they say: approve once, the agent merges, release by telling an agent or one Run workflow.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Decision: no stable tag → base `0.0.0`. Ground: the patch bump then gives `v0.0.1`, the smallest valid version; the repo already has `v0.1.1`, so this only matters on a fresh fork.
Decision: a draft batch PR blocks a run (it may be another run in progress); older than 6 h it is reported as interrupted for the owner, not merged. Ground: a draft was never finished; merging it is unsafe.

## Verification

**Commands:**
- `npx vitest run test/release-script.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."

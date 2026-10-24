---
title: 'One approval per issue, merge on green, one-click release'
type: 'feature'
ticket: 11
created: '2026-10-23'
status: done
baseline_revision: 'a8c2509a842c1d9a332d2af70e36d9cd473161fb'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred:
  - summary: >-
      release.yml wiring of an empty dispatch tag and RELEASE_BUMP is not exercised by any test.
    evidence: |-
      No workflow harness in the repo; settle with one dispatched dry run, tag empty, after merge.
    location: >-
      .github/workflows/release.yml
    severity: medium
  - summary: >-
      Merge on green and the start-of-run merge are agent instructions, not run yet.
    evidence: |-
      Settle with the next routine run over an approved issue.
    location: >-
      docs/agents/implement.md
    severity: medium (unverified)
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

- Implemented by the full-route subagent; strict semver (no leading zeros) for stable tags; a dispatched dry run with an empty tag also computes the version; `""` left the BAD_TAG list (empty tag is valid on a dispatch; refused on a push by its own test). The orchestrator ran this build in its own session after a nested worker had no subagents (run log).

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 34 findings — high 1, medium 9, low 14, false 2, maybe-false 0, plus 8 descriptive intent-alignment notes (no verdict: 3 aligned, 3 live-only surfaces deferred, 2 stricter-than-intent accepted)
- findings:
  - `[high]` `[patch]` merge rules never checked the PR author (edge) — added: author `ME`, head branch `claude/...` in this repo.
  - `[medium]` `[patch]` green could pass before the CI run exists; legacy statuses ignored (blind) — require the `check` run present and success, combined status not failure/pending; merge call named.
  - `[medium]` `[patch]` no branch for zero checks / `unknown` / `blocked`/`unstable` (edge ×2) — four outcomes Green/Wait/Red/Hold, unknown and zero checks are Wait.
  - `[low]` `[patch]` retitled draft never marked ready stalls (edge) — any `Issue batch` draft >6 h is interrupted.
  - `[medium]` `[patch]` interrupted draft stalls the flow with no owner action in docs (blind) — docs/issues.md and issue-flow.md name it.
  - `[medium]` `[patch]` no way for the owner to hold a merge; in-review row stale (blind) — convert to draft pauses; row updated.
  - `[low]` `[patch]` Refs/Fixes state lags after a step-2 merge (edge, blind) — wait a minute and re-read.
  - `[medium]` `[patch]` a reverted non-owner approval blocks a planned issue forever (edge) — latest owner approval counts.
  - `[low]` `[patch]` planned issue with nothing to build (edge) — block it.
  - `[low]` `[patch]` "ticket is reopened" undefined (blind) — new fix ticket via bmad-ticket, one attempt, outside the 6-issue limit.
  - `[low]` `[patch]` waits vs the 3-hour limit (blind) — waits are outside it; mid-wait end leaves the PR open.
  - `[medium]` `[patch]` "tell an agent 'release'" had no agent instructions, version unseen (blind) — "For agents" in docs/release.md.
  - `[low]` `[patch]` partial failure recomputes a version already on npm (blind) — named in docs/release.md.
  - `[low]` `[patch]` duplicate dry-run sentence (blind) — dropped.
  - `[low]` `[patch]` RELEASE_TAG expression hard to read (blind) — `push && ref_name || inputs.tag || ''`.
  - `[medium]` `[patch]` leading-zero/non-semver filter not pinned (verification-gap, blind) — test with `v01.5.0 v0.08.0 v1.2.3.4`.
  - `[low]` `[patch]` exact log line not asserted (blind) — asserted.
  - `[medium]` `[defer]` workflow wiring of empty tag and RELEASE_BUMP untested (verification-gap, blind, intent) — no workflow harness; settled by one dispatched dry run with an empty tag after merge.
  - `[medium]` `[defer]` merge-on-green and start-of-run merge are prompt text, not run (intent ×2) — settled by the next routine run.
  - `[low]` `[reject]` stub's literal `*` match fragile (blind) — test-only, works, fix adds nothing.
  - `[low]` `[reject]` merged head branch not deleted (blind) — repository setting, not this change.
  - `[false]` `[reject]` plan not updated (blind) — the diff was taken mid-review; the plan is updated in this pass.
  - `[false]` `[reject]` no evidence `npm run ci` passed (intent) — it passed before and after the patches (Verification).
  - remaining low rows: 7 duplicates of the rows above across lenses, same routes.

## Design Notes

Decision: no stable tag → base `0.0.0`. Ground: the patch bump then gives `v0.0.1`, the smallest valid version; the repo already has `v0.1.1`, so this only matters on a fresh fork.
Decision: a draft batch PR blocks a run (it may be another run in progress); older than 6 h it is reported as interrupted for the owner, not merged. Ground: a draft was never finished; merging it is unsafe.

## Verification

**Commands:**
- `npx vitest run test/release-script.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."

## Auto Run Result

- Status: built. The agent merges its own green batch PR (in the run or at the next run's start), `planned` issues build without a second approval, and the release dispatch computes the next version when no tag is given; docs of record updated.
- Files: `scripts/release.sh` (computed tag), `.github/workflows/release.yml` (optional tag, bump), `test/release-script.test.ts` (COMPUTED_TAG block), `docs/agents/implement.md`, `docs/agents/triage.md`, `docs/issues.md`, `docs/release.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md`.
- Review: 17 patches applied (1 high, 7 medium, 9 low), 2 deferred (live checks), 4 rejected with reasons above.
- Follow-up review recommended: false (the one high patch is a single added condition, verified by reading).
- Verification: `npx vitest run test/release-script.test.ts` 51 passed; `npm run ci` "All checks passed." before and after the patches.
- Residual risk: the workflow expression and the agent's merge behavior run only live: a dispatched dry run with an empty tag, and the next routine run.


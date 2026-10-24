---
title: 'GitHub merges the green batch PR; the agent only marks it ready'
type: 'feature'
ticket: 20
created: '2026-10-24'
status: 'in-progress'
baseline_revision: '85cf00b805d603b1996da6876d7735df3e374b35'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md', '{project-root}/docs/agents/implement.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The routine's permission check refuses an agent's merge of its own batch PR ("Merge Without Review"), so green batches wait for the owner, against the owner's decision that batches merge on green without them.

**Approach:** A GitHub Actions workflow merges qualifying batch PRs as the app, with the same guards the relay merge has; the agent only marks the batch ready and reads the result back.

## Boundaries & Constraints

**Always:** the workflow runs only from `main` (`if: github.ref == 'refs/heads/main'` where the event has a ref; `workflow_run` and `pull_request_target` run from the default branch), uses environment `agent`, never checks out or runs PR code (checkout of `main` only, `persist-credentials: false`), passes event data only through env, pins actions by full SHA like `.github/workflows/agent-write.yml`, `permissions: {}` top-level and `contents: read` on the job, masks and revokes the token like agent-write.yml. It only merges; it never comments, labels, closes, or edits. A PR merges only if every guard of the relay's `merge` holds (reuse `checkMergeable` and `checkGreen`; the head sha is the PR's current head). Concurrency group `batch-merge` with `cancel-in-progress: false` is fine here (a dropped pending run is harmless: the next trigger re-checks).

**Never:** merge a PR that fails a guard; add any other write; change `agent-write.mjs` guards; touch release or CI workflows; let the agent dispatch a merge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Qualifying | open ready `Issue batch: #1` by the app, `claude/x` head in repo, clean, `check` success | PUT merge with head sha; summary "merged #N" | — |
| Draft | same but draft | skipped, "draft" | exit 0 |
| Not the app | author `xtimor` | skipped | exit 0 |
| Other title / branch / fork | — | skipped | exit 0 |
| Not clean | `mergeable_state` unknown/blocked/dirty | skipped (unknown: retried by the next trigger) | exit 0 |
| Checks | `check` missing, pending, failed; other run failed; status pending/failure | skipped | exit 0 |
| Merge refused by GitHub | PUT 405/409 | reported, exit 1 | — |
| Several PRs | one qualifying, one not | merges only the qualifying one | — |
| Missing variables | no `GH_TOKEN`/`AGENT_LOGIN` | exit 2 | — |

</intent-contract>

## Code Map

- `scripts/agent-write.mjs` -- export what the merge script reuses (`checkMergeable`, `checkGreen`, and if needed a small REST client helper); do not change behavior; keep its tests green.
- `scripts/batch-merge.mjs` (new) -- env `GH_TOKEN`, `AGENT_LOGIN`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`, optional `BATCH_PR` (a number from the event to check first); lists open PRs (`GET /pulls?state=open&per_page=100`), keeps those titled `Issue batch`* by `AGENT_LOGIN`, reads each PR (for `mergeable_state`), check runs and combined status at its head, applies the guards, merges qualifying ones; one line per PR to stdout (`batch-merge: #N merged|skipped: <reason>`), summary table to `GITHUB_STEP_SUMMARY`; exit 0 unless a merge call failed (1) or config is missing (2). No redirects followed, token redacted from messages (as agent-write does).
- `test/batch-merge.test.ts` (new) -- local stub like `test/agent-write.test.ts`; every matrix row; workflow file assertions like the agent-write workflow tests (SHA pins, permissions, environment `agent`, no PR checkout, env-only event data, triggers `workflow_run` CI completed, `pull_request_target` ready_for_review, `workflow_dispatch`, hourly `schedule`).
- `.github/workflows/batch-merge.yml` (new) -- mint with `node scripts/agent-token.mjs` (and `--login`) in one step, mask, trap-revoke, run `node scripts/batch-merge.mjs` without the key in its env (same pattern as agent-write.yml); `BATCH_PR` from `github.event.pull_request.number` or `github.event.workflow_run.pull_requests[0].number` via env.
- `docs/agents/implement.md` -- "Merging the batch pull request" becomes: GitHub's `Batch merge` workflow merges it; the agent never merges (no `merge` dispatch). End of batch: mark ready (`pr_edit` + `pr_ready`), then poll the PR by REST for up to ~30 minutes for `merged: true`; merged → report; red → the one fix attempt as today; still open and green → report "GitHub merges it on the next trigger"; Before-the-batch step 2 "Ready" bullet: green and still open → report "waiting for Batch merge" and end (or continue only if merged); keep red/hold rules.
- `docs/agents/identity.md` -- the `merge` op row: kept in the relay for completeness but not used by agents; point to batch-merge.
- `docs/issues.md`, `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`, `epic-distribution.md` (decision 2026-10-24), `MEMORY.md` -- who merges now.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/batch-merge.mjs`, `test/batch-merge.test.ts`
- [ ] `.github/workflows/batch-merge.yml`
- [ ] `scripts/agent-write.mjs` exports only
- [ ] docs and MEMORY

**Acceptance Criteria:**
- Given a ready, green, clean batch PR by the app, when CI completes or it is marked ready, then the Batch merge workflow merges it as the app.
- Given any PR that fails a guard, when the workflow runs, then it is not merged.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/batch-merge.test.ts test/agent-write.test.ts` -- all pass
- `npm run ci` -- "All checks passed."

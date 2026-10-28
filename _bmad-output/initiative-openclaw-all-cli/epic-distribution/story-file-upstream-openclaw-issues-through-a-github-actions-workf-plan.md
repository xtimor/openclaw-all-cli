---
title: 'File upstream OpenClaw issues through a GitHub Actions workflow with the owner''s token'
type: 'feature'
ticket: 23
created: '2026-10-28'
status: built
baseline_revision: '052e9271b1e3beef91a988150c03d46074f90838'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md']
warnings: ['oversized']
deferred:
  - summary: >-
      scripts/agent-relay.sh sends its dispatch and watch to the current-directory repository but its reads to REPO.
    evidence: |-
      Found by the independent security review of ticket 3.23 (finding 3). The same flaw was fixed in scripts/upstream-issue.sh (--repo on gh workflow run and gh run watch, hook renamed UPSTREAM_ISSUE_REPO); the relay helper was left unchanged because this ticket does not touch it.
    location: >-
      scripts/agent-relay.sh
    severity: low
---

<intent-contract>

## Intent

**Problem:** Sessions cannot write to `openclaw/openclaw`: the session proxy swaps the owner's session credentials into every `api.github.com` call, and they are scoped to this repository. The owner stored a personal token as the secret `GH_PUBLIC_TOKEN` and wants upstream issues filed with it.

**Approach:** A dispatch-only workflow (`upstream-issue.yml`) and a tested script (`scripts/upstream-issue.mjs`) create one issue in an allow-listed repository, idempotently, with strict guards; a local helper `scripts/upstream-issue.sh` dispatches it like `agent-relay.sh`. Docs and MEMORY follow.

## Boundaries & Constraints

**Always:** workflow `workflow_dispatch` only, job `if: github.ref == 'refs/heads/main'`, `environment: agent` (the secret `GH_PUBLIC_TOKEN` lives there; deployment branch `main` only), `permissions: {}` top level and `contents: read` on the job, checkout and setup-node pinned by the same SHAs as `agent-write.yml`, checkout of `main` without credentials and no PR code. The token reaches the script only through `env` (`GH_PUBLIC_TOKEN`), is masked with `::add-mask::` before use, and is never interpolated into script text, written to a file, output, or log. Input `issue` (one JSON object) reaches the script only through `env`. Allowed target: `openclaw/openclaw`, a constant in code, not input or env. Dispatcher and triggering actor are in `ISSUE_FLOW_OWNERS` (same value as `agent-write.yml`); run attempt 1. Limits: title one line up to 256 characters, body up to 30 000, whole input up to 40 000, labels at most 5. The body has exactly one line `Filed for xtimor/openclaw-all-cli#<n>` (repository from `GITHUB_REPOSITORY`). Before creating, list the token owner's own issues in the target (`GET /user`, then `GET /repos/<target>/issues?creator=<login>&state=all`, which is not search-lagged) and return a match (same marker line, or same title ignoring case) instead of creating. One issue per dispatch; a concurrency group `upstream-issue` (no cancel) serialises runs. Output is one-line, prefixed, and never holds title, body, or token. Reuse `makeClient`, `WriteError`, `parseOwners`, and small exported helpers of `scripts/agent-write.mjs`.

**Never:** check out or run PR code; add a third-party action; accept another repo, a second issue, a comment, edit, or close; print the token or the body; edit `.claude/settings.json`, `AGENTS.md`, `tickets.toml`, or run logs; change an `agent-write.mjs` guard.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create | valid issue, no match | POST issue; `upstream-issue: created <url>`; labels reported as applied or not | No error expected |
| Existing | same marker or same title among the owner's issues | no POST; `existing <url>` | exit 0 |
| Other repo, extra key, bad types | `repo` not allow-listed, unknown field, non-string title, bad labels | refused, no request | exit 1 |
| Marker | none, two, other repository | refused, no request | exit 1 |
| Size | title/body/input over limit, control characters | refused, no request | exit 1 |
| Actors | dispatcher or triggering actor not an owner, attempt not 1 | refused, no request | exit 1 |
| API | `/user` or list or create fails, 401 echoing the token | failure with status only, token `[redacted]` | exit 1 |
| Config | no `GH_PUBLIC_TOKEN`, bad repository | exit 2, no request | message names the variable |

</intent-contract>

## Code Map

- `scripts/agent-write.mjs` -- export `lower`, `cell`, `logLine`, `writeSummary` (no behavior change); `makeClient`, `WriteError` already exported.
- `scripts/upstream-issue.mjs` (new) -- `validate`, `findExisting`, `run`, `main`; writes `result=<line>` to `GITHUB_OUTPUT` and a summary without title or body.
- `.github/workflows/upstream-issue.yml` (new) -- one step runs the script with the token in env; a second `always()` step turns `result` into a `::notice::`/`::error::` annotation, so a session can read the outcome by REST.
- `scripts/upstream-issue.sh` (new) -- dispatch, watch, poll, check the conclusion, read the result annotation (fallback: the run log), print the URL.
- `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts` (new) -- local API stub, stub `gh`, workflow file pins.
- `test/agent-flow-docs.test.ts` -- pin the helper's call shape and the doc rules.
- `docs/agents/{identity,implement,triage}.md`, `docs/issues.md`, `MEMORY.md` -- how and when, owner setup, allow-list lines.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/agent-write.mjs` -- export four helpers -- reuse, no copy
- [ ] `scripts/upstream-issue.mjs` -- build and test -- the guards and idempotency
- [ ] `.github/workflows/upstream-issue.yml` -- build -- token via env only
- [ ] `scripts/upstream-issue.sh` -- build -- the allowed-call shape
- [ ] tests, docs, MEMORY -- cover every matrix row; owner steps and settings lines in docs

**Acceptance Criteria:**
- Given a valid issue, when the workflow runs on main by an owner, then one issue exists in `openclaw/openclaw` and the helper prints its URL; a repeat dispatch prints the same URL and creates nothing.
- Given any refused input, then no write request is sent and neither stream holds the token.
- Given `npm run ci`, then it passes.

## Implementation Notes

No subagent tool was available to this worker, so the build was done in-session (full route by size, no implementing subagent). Files: `scripts/agent-write.mjs` (exports `lower`, `cell`, `writeSummary`; no behavior change), `scripts/upstream-issue.mjs`, `scripts/upstream-issue.sh`, `.github/workflows/upstream-issue.yml`, `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/{identity,implement,triage}.md`, `docs/issues.md`, `MEMORY.md`. Decisions: the existing-issue check lists the token owner's issues in the target (`GET /user`, then `GET /issues?creator=`) instead of search, since search lags; the outcome travels as a `notice`/`error` annotation of the job (the script writes `result=` to `GITHUB_OUTPUT`, a final `always()` step annotates it) because sessions cannot read run logs but can read annotations by REST (`gh run view --log` is the helper's fallback); a concurrency group `upstream-issue` (no cancel) serialises runs, so a race cancels a dispatch rather than duplicating an issue; the environment is the existing `agent`. OpenClaw's issue forms could not be read from this sandbox (the MCP tool is limited to this repository), so the docs name generic headings and tell the agent to read the target's forms. Mutation checks (allow-list widened, attempt check removed, idempotency removed, marker count loosened) each fail the intended tests.

## Plan Change Log

## Review Triage Log

### 2026-10-28 -- Review pass
- verdicts: 11 findings -- high 0, medium 1, low 8, false 2, maybe-false 0
- findings: (all four lenses -- blind hunter, edge-case hunter, verification gap, intent alignment -- ran in the build's own session: no subagent tool was available, so none was context-free)
  - `[low]` `[patch]` The same-title match returns an older or closed issue silently for a genuinely new report -- docs now say to check an `existing` answer and to give a new report a new title.
  - `[low]` `[patch]` Labels dropped by the target are reported only in the run log, which sessions cannot read -- docs say to read the new issue's labels by REST if they matter.
  - `[low]` `[patch]` The token owner's login regex rejected a login with an underscore -- relaxed to `[\w.-]`; the value is URL-encoded anyway and `../x` still fails.
  - `[medium]` `[defer]` No technical tie between a dispatch and an owner-approved issue of ours -- the intent's guard list does not include it and the "owner asks" case has no label to check; recorded in `deferred` with the mitigations.
  - `[low]` `[reject]` The result is read from a check-run annotation and a log format never seen live -- failure mode is exit 1 with "dispatching again returns the same issue" (idempotent); stated as not verified in MEMORY.
  - `[low]` `[reject]` Whether a failed step's `GITHUB_OUTPUT` reaches the `always()` step is unverified -- if not, the annotation reads "no result" and only the failure reason is lost.
  - `[false]` `[reject]` `echo "::add-mask::$GH_PUBLIC_TOKEN"` prints the token -- the runner consumes the command; same pattern as the relay's workflow; the workflow test pins that no other step sees the secret.
  - `[false]` `[reject]` Exactly one marker line refuses a body that quotes the marker in a code block -- intended; the refusal names the rule and the agent rewrites the body.
  - `[low]` `[reject]` More than 1000 own issues in the target refuses -- fail closed on purpose (cannot rule out a duplicate); an owner with that many issues there can raise `MAX_LIST_PAGES`.
  - `[low]` `[reject]` A third dispatch replaces the pending one (cancelled) -- the helper reports `cancelled`; safer than a duplicate, and the docs say one dispatch at a time.
  - `[low]` `[reject]` Workflow tests are text pins, not a YAML or actionlint parse -- the repository's other workflow tests do the same and no linter is installed here.

### 2026-10-28 -- Independent security review (after the build)
- verdicts: 5 findings -- high 0, medium 1, low 4, false 0, maybe-false 0
- findings: (from an independent reviewer of `052e927..HEAD`; fixed on the same branch by the build worker, in-session)
  - `[medium]` `[patch]` The "approved issue only" rule lived only in the docs; changing the marker number could file any number of issues -- the script now reads the marker's issue of ours and its events with the job's own `GITHUB_TOKEN` (job permission `issues: read`, never logged, never sent upstream; the owner's token never goes to our repository) and refuses unless it exists, is not a pull request, and an owner (`ISSUE_FLOW_OWNERS`) labeled `status:approved` at some point; a new issue is also refused when 3 or more by the token's user were created in the target in the last 24 hours (an existing match is still returned). Tests: `APPROVED_ISSUES_ONLY` and `DAILY_CAP` in `test/upstream-issue.test.ts`; mutation checks (approval removed, cap removed, owner test removed) fail them. This resolves the earlier `defer` of the same gap (removed from `deferred`).
  - `[low]` `[patch]` The annotation unescapes `%0A`, `%0D`, `%25` -- the report step now escapes `%` first (`RESULT="${RESULT//%/%25}"`); a test runs the step's block with a hostile result and pins the output; removing the line fails it.
  - `[low]` `[patch]` The helper dispatched and watched in the current-directory repository but read from `REPO` -- `--repo "$REPO"` on `gh workflow run` and `gh run watch`, hook renamed `UPSTREAM_ISSUE_REPO` (the old name moves nothing, tested). `scripts/agent-relay.sh` has the same mismatch and stays unchanged here: `deferred` (low).
  - `[low]` `[patch]` Workflow-level concurrency let a dispatch on another branch cancel a pending main run -- the group moved under `jobs.file`, below the `main` condition; pinned by the workflow test.
  - `[low]` `[patch]` The owner-setup check filed a real issue with marker `#1` -- `identity.md` now says to test only with a real approved issue and its real marker; a doc pin forbids the throwaway marker.

## Design Notes

Why list by creator, not search: the search index lags minutes, so an immediate re-dispatch would duplicate; the issues list is consistent. Why a result annotation: sessions cannot read run logs, but check-run annotations are plain REST. Labels: GitHub drops labels a non-triager sets without error, so the script reports which were applied. The body should follow the target's form headings; docs list the usual ones (the forms cannot be read from this sandbox).

## Verification

**Commands:**
- `npx vitest run test/upstream-issue.test.ts test/upstream-issue-sh.test.ts test/agent-write.test.ts test/agent-flow-docs.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): the owner adds `GH_PUBLIC_TOKEN` to the `agent` environment; an owner session files the prepared OpenClaw icon issue for #45 and links it.

## Auto Run Result

Status: built. Blocking condition: none.

**Summary:** The `Upstream issue` workflow (`workflow_dispatch` only, `main` only, Environment `agent`, secret `GH_PUBLIC_TOKEN` only through `env`) runs `scripts/upstream-issue.mjs`, which creates one issue in `openclaw/openclaw` (the only allow-listed repository) with title, body, and optional labels, idempotently (it returns the owner's existing issue with the same marker line or title). Guards: owner dispatcher and triggering actor, attempt 1, size limits, exactly one `Filed for xtimor/openclaw-all-cli#<n>` line, no request on any refusal. `scripts/upstream-issue.sh <file.json>` dispatches, waits, and prints the URL. Docs, owner setup, and the `.claude/settings.json` allow-list lines are in `docs/agents/identity.md`.

**Files changed:** `scripts/agent-write.mjs` (three exports), `scripts/upstream-issue.mjs`, `scripts/upstream-issue.sh`, `.github/workflows/upstream-issue.yml`, `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/{identity,implement,triage}.md`, `docs/issues.md`, `MEMORY.md`, this plan.

**Review:** 11 findings from four lenses run in-session (no subagents available): 3 patched (low), 1 deferred (medium, no technical tie to an approved issue), 7 rejected or false with reasons in the triage log.

**Follow-up review recommended: false.** Patched: high 0, medium 0, low 3.

**Verification:** `npm run ci` passed (plan gate, typecheck, unit tests, build, package checks, install smoke); `test/upstream-issue.test.ts` (17), `test/upstream-issue-sh.test.ts` (10), and the doc pins pass; four mutation checks fail the intended tests.

**Not run:** the live run (the owner has not added `GH_PUBLIC_TOKEN` yet); the real-runner behavior of `GITHUB_OUTPUT`, the annotation, and `gh run view --log`; OpenClaw's issue-form headings (unreadable from this sandbox).

**Residual risks:** the deferred finding above; the issue is authored by the owner's account; an `existing` answer by title can be a different, older issue.

## Auto Run Result (security review fixes)

Status: built. Blocking condition: none.

**Summary:** The five findings of the independent security review are fixed. Filing now needs an owner-approved issue of ours (checked by the workflow, not by docs) and is capped at 3 new issues per 24 hours (a new one is refused once 3 exist); the annotation escapes `%`; the helper uses one repository for dispatch, watch, and reads; the concurrency group sits on the job; the owner-setup check no longer files a throwaway issue.

**Files changed:** `scripts/upstream-issue.mjs` (`checkApproved`, `findExisting` returns the recent count, `DAILY_CAP`, `GITHUB_TOKEN`), `.github/workflows/upstream-issue.yml`, `scripts/upstream-issue.sh`, `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/{identity,implement}.md`, `MEMORY.md`, this plan.

**Review:** 5 findings from the independent review, all patched (1 medium, 4 low); 0 new deferrals except the low `agent-relay.sh` one; the earlier deferred medium is resolved by finding 1.

**Follow-up review recommended: false.** Patched: high 0, medium 1, low 4. Each fix has a test and a mutation check.

**Verification:** `npm run ci` passed (see the commit); `test/upstream-issue.test.ts` and `test/upstream-issue-sh.test.ts` pass.

**Not run:** the live run (secret not set); whether `secrets.GITHUB_TOKEN` with `issues: read` returns events in the `agent` environment (documented REST behavior for a public repository; not exercised here).

**Residual risks:** "approved at some point" is by design: a later removal of the label does not stop a dispatch; the events API can lag right after the owner labels the issue (dispatch again); a changed marker number to another approved issue of ours still files, capped at 3 per 24 hours.

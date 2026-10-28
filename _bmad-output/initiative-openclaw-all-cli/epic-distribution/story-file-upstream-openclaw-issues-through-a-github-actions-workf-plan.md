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
      Nothing technical ties an upstream-issue dispatch to an owner-approved issue of ours.
    evidence: |-
      The workflow checks the dispatcher (an owner), the marker line, and the allow-listed repository, but not that issue #n carries an owner's status:approved (the rule also allows "the owner asks", which has no label). A session that read hostile issue text and has the helper in its allow list could file public issues in the owner's name, one per dispatch. Mitigations in place: the allow-list lines are the owner's opt-in and are not added here, one issue per dispatch, idempotency, and the docs rule.
    location: >-
      scripts/upstream-issue.mjs
    severity: medium
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

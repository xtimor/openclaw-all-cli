---
title: 'Relay writes pass the routine permission check; interrupted batches recover without the owner'
type: 'bugfix'
ticket: 17
created: '2026-10-23'
status: 'built'
baseline_revision: 'fb975fd8e2e29f3f3b6fd390edc02562bb22daf0'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'auto'
lenses_ran: ['edge-case-hunter']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md', '{project-root}/docs/agents/implement.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** In the first live routine run with the relay, the session's auto-mode permission check denied an ad hoc relay write (a shell function in `/tmp` writing ops files and calling `/tmp/relay.sh`), so the run stopped after one issue and left draft batch PR #24 open; today's rules then make every later run wait on or merely report that draft, which needs the owner.

**Approach:** Give the agents one repository script for every relay write, allowed by the repository's Claude settings, and let a run close an interrupted draft batch PR of its own (new relay op `pr_close`) and take its issues again under the owner's standing approval.

## Boundaries & Constraints

**Always:** `scripts/agent-relay.sh` only dispatches `agent-write.yml` on `main`, watches that run, and checks its conclusion; it never touches the proxy variables, never prints secrets, and exits non-zero (with a one-line reason on stderr) on any failure. The settings allow only that script by its repository path and the read commands it uses; nothing broader (no `Bash(*)`, no `gh *`). `pr_close` closes only an open draft PR authored by the app, head `claude/...` in this repository, title starting `Issue batch`. An interrupted draft is one not updated for more than 4 hours. Its issues come back only when the owner's latest `labeled status:approved` still stands (as in implement.md step 6) and the issue is still `in-progress` or `approved`.

**Never:** add `status:approved`; close any other PR; widen the allow list; bypass the proxy; change release or CI workflows.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Relay ok | `scripts/agent-relay.sh ops.json`, stub gh prints run URL, conclusion success | exit 0, prints the run id | — |
| Dispatch fails | `gh workflow run` exits 1 | exit 1, "dispatch failed" | — |
| No URL | `gh workflow run` prints nothing | exit 1, "no run id" | — |
| Run failed | conclusion `failure` | exit 1, "relay run <id>: failure" | — |
| Missing file | ops path missing or not valid JSON | exit 2 before dispatch | — |
| Close own draft | `pr_close` on open draft by app, `claude/` head, `Issue batch` title | PATCH state closed | — |
| Close other | not a draft, not by app, other title, fork head, already closed | refused, nothing applied | exit 1 |

</intent-contract>

## Code Map

- `scripts/agent-relay.sh` (new, bash, `set -euo pipefail`): arg = ops file; validate it exists and parses (`node -e` JSON.parse, or `jq`); `URL="$(gh workflow run agent-write.yml --ref main -f ops="$(cat "$1")")"`; id from URL; `gh run watch "$ID" --exit-status || true`; `gh api repos/${REPO:-xtimor/openclaw-all-cli}/actions/runs/$ID --jq .conclusion` must be `success`; print the id on stdout. Test hooks: `AGENT_RELAY_GH` (path of the gh binary, default `gh`).
- `test/agent-relay.test.ts` (new): stub `gh` script in a temp dir (like `test/release-script.test.ts` stubs), covering every relay row of the matrix.
- `scripts/agent-write.mjs` + `test/agent-write.test.ts`: new op `pr_close` with fields `pr`; guards as in Boundaries (read the PR first; reuse the PR guard helpers of `pr_ready`/`pr_edit`); `PATCH /repos/{repo}/pulls/{pr}` `{state:"closed"}`; tests for each refusal.
- `.claude/settings.json`: add to `permissions.allow`: `"Bash(scripts/agent-relay.sh *)"`, `"Bash(bash scripts/agent-relay.sh *)"`, `"Bash(./scripts/agent-relay.sh *)"`. Keep existing entries and hooks.
- `docs/agents/identity.md` step 3: replace the inline snippet with: write the list to a file under `/tmp` with the Write tool or a plain heredoc (no shell functions), then run `scripts/agent-relay.sh /tmp/agent-ops-<n>.json` from the repository root; one dispatch per call; everything else (read-back, rules, ops table) stays; add `pr_close` to the ops table.
- `docs/agents/implement.md` "Before the batch" step 2 (draft branch): a draft `Issue batch` PR whose author is `ME` and that was not updated for more than 4 hours is interrupted: close it with one `pr_close` relay op (with the relay off: close it as the owner with the GitHub tools), comment on it why, then continue; step 4 (recover interrupted work) and step 5: its issues still `in-progress` whose owner approval stands are taken again in this run (no `blocked`, no new approval); a younger draft still means another run is building: report and end.
- `docs/issues.md`, `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`: the interrupted-batch line now says the agent recovers it; `MEMORY.md`: the live finding (auto-mode check denied an ad hoc relay write; use the repository script).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/agent-relay.sh`, `test/agent-relay.test.ts` -- one allowed relay entry point
- [ ] `scripts/agent-write.mjs`, `test/agent-write.test.ts` -- `pr_close`
- [ ] `.claude/settings.json` -- allow the script
- [ ] `docs/agents/identity.md`, `docs/agents/implement.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md` -- behavior and record

**Acceptance Criteria:**
- Given an unattended routine run, when it writes through the relay, then it calls `scripts/agent-relay.sh` and the permission check allows it.
- Given a draft batch PR by the agent idle for more than 4 hours, when a run starts, then it closes that PR and builds its issues without a new approval.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass (edge-case-hunter)
- verdicts: 10 findings — high 2, medium 5, low 3
- findings:
  - `[high]` `[patch]` watch returning early made a live run look failed and invited a re-dispatch — poll status to completed (~20 min), else stop with "do not re-dispatch".
  - `[high]` `[patch]` closing an interrupted draft with `Fixes` lines moves its issues to blocked — `pr_edit` to a plain body before `pr_close`; retake in-progress/in-review/blocked-by-that-close issues of that draft.
  - `[medium]` `[patch]` 4-hour idle rule only in the agent — relay `pr_close` also refuses a draft updated less than 4 h ago.
  - `[medium]` `[patch]` retake widened to every in-progress issue at 4 h — limited to the closed draft's set; generic recovery stays at 6 h.
  - `[medium]` `[patch]` allow rules match one spelling only — docs say run exactly `scripts/agent-relay.sh /tmp/agent-ops-<n>.json`, ops written with the Write tool.
  - `[low]` `[patch]` node/jq validation differed — top-level JSON array required in both.
  - `[low]` `[patch]` oversize ops failed generically — exit 2 "too large; split".
  - `[medium]` `[reject]` gh without a run URL — the session's gh prints it (probed 2026-10-23).
  - `[low]` `[reject]` live run silent for 4 h — runs push after each issue, which updates the PR.
  - `[low]` `[reject]` env/cd-prefixed invocations — docs forbid them.

## Verification

**Commands:**
- `npx vitest run test/agent-relay.test.ts test/agent-write.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."

## Auto Run Result

- Status: built. Fixes in eda4b0d. `npm run ci` green; relay and writer tests 45 passed.
- Live check pending: the next routine run uses the script under the auto-mode check, closes draft #24, and builds #14, #11, #9.


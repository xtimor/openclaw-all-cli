---
title: 'OpenClaw version matrix in CI and a weekly beta run'
type: 'feature'
ticket: '4'
created: '2026-11-27'
status: 'in-review'
baseline_revision: '54d6565b2b6d4e1b30f53d0e0d1f69d28ee9ba56'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Gateway tier (`scripts/regression.sh gateway`) runs only by hand; CI and the release pin one OpenClaw (2026.10.3), so a break on npm `latest` or on the next `beta` reaches users unseen.

**Approach:** A reusable workflow `.github/workflows/regression.yml` that resolves the requested OpenClaw versions at run time (min from `package.json`, dist-tags through npm), runs the Gateway tier as one job per version, and prints the resolved versions and per-version results in the job summary; `ci.yml` calls it on min and latest for pull requests and pushes to main; a weekly workflow calls it on `beta` and opens one issue when red, commenting on that issue instead of opening another while it is open.

## Boundaries & Constraints

**Always:** no secret in any of these jobs (the tier runs on `fake-cursor-agent`; `scripts/regression.sh` already unsets the key); actions pinned by full commit sha with the version comment, as in `ci.yml`; least `permissions` per job (`issues: write` only on the job that files the beta issue); `regression.yml` takes the versions as an input (a list of `min|latest|extended-stable|beta|X.Y.Z`) and, for ticket 4.7, an optional input naming an already packed `.tgz` artifact to test instead of packing (add the matching `scripts/regression.sh` flag, e.g. `--tgz <path>`, keeping today's default); each version's job is named with both the request and the resolved version (e.g. `gateway (latest = 2026.11.10)`), and a version requested twice (beta equal to latest) runs once; failure logs (vitest output and Gateway logs under `.regression/`) are uploaded as an artifact; per-version cache of `.regression/openclaw-<v>/node` and `/openclaw`; job timeout covering about 10 minutes of tier plus setup; the issue logic lives in a small script (`scripts/regression-beta-issue.mjs` or similar) with an offline unit test using a stub, like `scripts/regression-ledger.mjs`; English.

**Never:** change `src/`; weaken or skip a scenario to make a version green (the min run is red today on the #39 case until bug #106 is fixed, and that red is the gate working); run the live tier or anything needing `CURSOR_API_KEY` (ticket 4.5); change `release.yml` (ticket 4.7 wires it); open more than one beta issue while one is open; touch `.spike/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PR run | pull request | two Gateway jobs, `min = 2026.10.3` and `latest = <npm latest>`, the summary lists request, resolved version, result, time, plugin sha256 | a red version fails its own job, the other still runs (`fail-fast: false`) |
| Duplicate tags | `beta` resolves to the same version as `latest`, or `min` equals a tag | one job per distinct resolved version, the summary names every request that maps to it | none |
| Unknown tag | `nightly` not in npm dist-tags | the resolve job fails with the message from `scripts/regression.sh` | fails fast, no tier job starts |
| Beta red, no open issue | weekly run red | one issue opened with the beta version, the failing scenarios (from the job output), the run link, and a marker label | idempotent per run |
| Beta red, issue open | weekly run red again | a comment on the open issue with the new version and run link, no new issue | none |
| Beta green | weekly run green | no issue, no comment (an open issue stays open for a person to close) | none |
| Forced red | dispatch input that forces a red (e.g. `force_red: true` making the tier fail on purpose) | same as beta red | only on dispatch, never on schedule |

</intent-contract>

## Code Map

- `.github/workflows/ci.yml` -- `check` (unit tests, ledger step) and `clawhub` jobs; pinned action shas and the `.spike` cache pattern to copy; add a `regression` job calling `./.github/workflows/regression.yml` with min and latest.
- `.github/workflows/release.yml` -- read only (4.7 calls `regression.yml` from here; design the inputs for it: versions and an optional `.tgz` artifact).
- `scripts/regression.sh` -- `resolve_version` (min from `openclaw.compat.minGatewayVersion`, tags via `npm view openclaw dist-tags.<tag>`); state under `.regression/openclaw-<v>`; packs into `.regression/pack`; prints `OpenClaw <v>, plugin sha256 <sha>: passed|FAILED` at the end. A resolve-only mode (e.g. `scripts/regression.sh resolve <tags...>` printing JSON) lets the workflow build its matrix with the same rules.
- `scripts/regression-ledger.mjs`, `test/regression-ledger-script.test.ts` -- pattern for a GitHub-API script with a stubbed unit test.
- `.github/labels.yml`, `scripts/sync-labels.mjs`, `docs/issues.md`, `.github/workflows/issue-flow.yml` -- the label set and the issue flow a new issue enters; add the marker label for the beta issue here, and make the issue fit the flow (it is not a confirmed plugin bug: OpenClaw beta may be at fault, so triage decides).
- `docs/release.md` and `docs/setup.md` -- where the regression tier is documented; add the CI matrix and the weekly beta run in a few lines.
- GitHub constraint: a scheduled or dispatched workflow runs only once its file is on the default branch, so the weekly dispatch can be exercised only after merge; the PR proves the matrix, the unit test proves the issue logic.

## Tasks & Acceptance

**Execution:**
- [x] `.github/workflows/regression.yml` -- reusable (`workflow_call`, plus `workflow_dispatch` for a manual run): resolve job, per-version matrix job, summary, failure artifact
- [x] `scripts/regression.sh` -- resolve-only mode and an optional packed-`.tgz` flag, default behavior unchanged
- [x] `.github/workflows/ci.yml` -- `regression` job on min and latest
- [x] `.github/workflows/regression-beta.yml` (or similar) -- weekly schedule and dispatch on `beta`, issue job with `issues: write`
- [x] `scripts/regression-beta-issue.mjs` + its unit test -- open or comment, with the stubbed API
- [x] `.github/labels.yml`, `docs/release.md` -- marker label; a short section on the matrix and the weekly run
- [x] `MEMORY.md` -- the facts a later thread needs (job names, where results show)

**Acceptance Criteria:**
- Given this pull request, when CI runs, then the Gateway tier shows as one job per version (min and latest) with the resolved versions in the summary, and a red scenario turns only its version red.
- Given the beta issue script with a stub, when it runs red with no open issue, red with an open issue, and green, then it opens exactly one issue, comments on the open one, and does nothing.
- Given `npm test` and `npm run typecheck`, when they run, then both are green.
- Given `scripts/regression.sh gateway` without the new flags, when it runs locally, then it behaves as before.

## Implementation Notes

- `scripts/regression.sh`: new `resolve <requests...>` mode (same `resolve_version` rules; prints `[{"version","requests"}]` grouped by version in request order, a request named twice listed once; an unknown tag exits 2 with the existing message). `gateway` gains `--tgz <file>` (installs that tarball, skips the build, the build-version setup, and the pack; a missing file exits 2 before any setup) and `--result <file>` (an EXIT trap calls `scripts/regression-result.mjs`, which writes `{requested, version, sha256, result: passed|failed|error, exitCode, seconds, failed[]}`; with it, Vitest also writes its JSON report to `<file minus .json>.vitest.json`, from which the failing test names come: `<file> > <full name>`, or `<file>: <first message line>` for a file that failed outside a test). Without the new flags the commands and output are the old ones (verbose reporter only; the trap only re-exits with the same code). Relative paths are the caller's (`CALLER_DIR`).
- `.github/workflows/regression.yml` (reusable + dispatch): inputs `versions` (space or comma list), `tgz_artifact` (artifact of the same run with exactly one `.tgz`; for 4.7), `force_red`; output `results` (JSON array per version, with `requests`). Jobs `resolve` (an `::error::` annotation with the script's message on failure, the version table in the summary), `gateway (<requests> = <version>)` (a request equal to its version is not repeated, e.g. `gateway (2026.11.10)`; `fail-fast: false`; 35 min; one cache per OpenClaw version, `regression-<os>-node<v>-openclaw<v>`, for the tested version and, when different and no `.tgz` is given, the build version, so min and latest share the 2026.10.3 entry instead of storing it twice; `actions/cache/restore` before and `actions/cache/save` with `always()` after, gated on the tier having run (result passed or failed) and no exact hit, so a red leg saves too and a half-finished setup never does), `summary` (`!cancelled()`: table of requested, OpenClaw, result, time, sha256, then the failing tests; a version whose job wrote no result shows `no result`). Artifacts: `regression-result-<version>` always, `regression-logs-<version>` on failure (tier.log, Vitest JSON report, `<state>/logs/` for OpenClaw 2026.11+, `$TMPDIR/openclaw/*.log` for 2026.10, which is where 2026.10.3 writes its Gateway log; the scenario files' own `gateway.log` sits in a temp dir they remove, so it is not collected). `force_red` runs the tier, then marks the result failed with a `force_red: ...` entry and fails the job.
- `ci.yml`: job `regression` calls it with `min latest` (`contents: read`). `.github/workflows/regression-beta.yml`: Mondays 05:37 UTC and dispatch (`force_red`, passed only when `github.event_name == 'workflow_dispatch'`), `concurrency: regression-beta` without cancel so two runs never race to open two issues; job `issue` (`if: !cancelled()`, the only job with `issues: write`) runs the script with `needs.regression.result`.
- `scripts/regression-beta-issue.mjs report --outcome --results --run-url [--run-id]`: any outcome but `failure` exits 0 with no request (no token needed); red lists open issues labelled `regression:beta` (pull requests left out) and comments on the oldest, else opens one with labels `regression:beta` + `status:todo` and re-adds them if GitHub dropped them. A run reports once: its marker `<!-- regression-beta run=<id> -->` in the issue body or a comment makes a re-run a no-op. Missing or unreadable results still report ("No tier result reached this job", title `unknown version`). Lines are flattened, capped (30 failing names, 300 chars), and cannot forge the marker.
- Issue-flow fit: an issue made with `GITHUB_TOKEN` starts no issue-flow run, so the script sets `status:todo` itself; no type label, because OpenClaw beta may be at fault: triage adds the type (docs/agents/triage.md already does). The body says so and tells the reader to close it once settled.
- `regression:beta` added to `.github/labels.yml` (synced on merge); `test/sync-labels.test.ts` counts 21 labels now and names it beside `upstream:post`. Docs: `docs/release.md` "Regression tier in CI", a sentence each in `docs/setup.md` and `docs/issues.md` (Other labels). `MEMORY.md` has the job names, artifacts, and the issue rules. No `CHANGELOG.md` line (CI only). `src/`, `release.yml`, `.spike/` untouched.
- Pinned action added: `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2` (2026-10-07; a pattern that matches nothing downloads nothing without failing, a single match extracts without a subfolder, hence `merge-multiple: true` and per-version file names).
- Both new workflows set `defaults: run: shell: bash` (an explicit bash is `bash --noprofile --norc -eo pipefail`; the implicit default is `bash -e`, without pipefail), and the tier step reads the script's code from `${PIPESTATUS[0]}` between `set +e`/`set -e`, so `| tee` can never turn a red leg green, with or without pipefail. That is the only shell pipe in either file. Checkouts in `resolve`, `gateway`, and `issue` use `persist-credentials: false`.
- The beta issue script also looks for this run's marker among the 100 newest issues (`state=all`, newest first, any label) before it creates one: an issue the run opened that lost its label (dropped at create, re-add failed) is found, gets the marker label back if open (not the status: by then it is the issue flow's), and no second issue opens.
- Risk, not changed (outside this ticket): `scripts/agent-write.mjs` `checkGreen` (used by `Batch merge`) needs every check run green, so the red `regression / gateway (min = 2026.10.3)` blocks every batch merge until bug #106 is fixed.

## Plan Change Log

## Review Triage Log

Quick review by the coordinator after commit 50b2a71 (5 findings: 1 high, 4 low; all patched).

| # | Severity | Finding | Decision |
| --- | --- | --- | --- |
| 1 | high | regression.yml tier step: `regression.sh ... \| tee ... \|\| status=$?` ran under the implicit `bash -e` (no pipefail), so `status` was tee's 0 and every red leg went green; `failure()` uploads never ran and the beta workflow never saw `failure` (masked by `force_red`, which set `status=1` itself) | patched: `defaults: run: shell: bash` in both new workflows, and `${PIPESTATUS[0]}` between `set +e`/`set -e` in the tier step; no other shell pipe in either file |
| 2 | low | `actions/cache` saves only after a green job, so red legs never saved their cache | patched: `actions/cache/restore` + `actions/cache/save` (same v6.1.0 sha) with `always()`, gated on the tier having run and no exact hit |
| 3 | low | checkout without `persist-credentials: false` in `resolve`, `gateway`, `issue` | patched |
| 4 | low | regression-beta-issue.mjs could open a duplicate when GitHub dropped the label at create and the re-add failed | patched: marker search among the 100 newest issues (any state and label) before creating; test added |
| 5 | low | tests: no paging past 100 rows or page cap; `regression.sh --result` untested | patched: tests for >100 comments, >100 open issues, the 2000-row cap; result writer moved to `scripts/regression-result.mjs`, tests for passed, failed (names), error (no report), and the trap through `regression.sh gateway --result` |

## Verification

**Results (2026-11-27):**
- `npm test` (after the review patches): 72 files passed, 26 skipped; 2114 tests passed, 90 skipped. `test/regression-beta-issue-script.test.ts` has 23 tests: red with no issue opens one, red with one open comments, green and other outcomes make no request, same-run re-run is a no-op (also when the issue lost its label), oldest open issue and PRs left out, paging past 100 comments and 100 open issues and the 2000-row cap, no result still reports, forced red, dropped labels re-added, capping, token and API failures, usage; `regression.sh resolve` with a stub `npm` (dedupe, unknown tag, bad request), `--tgz` refusal; `scripts/regression-result.mjs` passed / failed with names / error, and the `--result` exit trap.
- `npm run typecheck`: clean.
- `scripts/regression.sh resolve min latest beta` after the review patches (real npm): `[{"version":"2026.10.3","requests":["min"]},{"version":"2026.11.10","requests":["latest"]},{"version":"2026.12.1-beta.1","requests":["beta"]}]` (beta has moved on since the first run). Before them, `resolve min latest beta extended-stable`: `[{"version":"2026.10.3","requests":["min"]},{"version":"2026.11.10","requests":["latest","beta"]},{"version":"2026.10.34","requests":["extended-stable"]}]`; `resolve min nightly` (stub npm): exit 2, `Unknown OpenClaw dist-tag 'nightly' ...`.
- `scripts/regression.sh gateway` (no new flags, local, once): OpenClaw 2026.10.3, 8 files, 1 failed | 18 passed | 1 skipped, 560 s; the only red is `auth-setup.regression.test.ts > ... #39 ...` (bug #106, expected); output as before, no result file written.
- `actionlint` 1.7.9 (release binary, checksum checked, in the scratchpad) on all workflows: clean, before and after the review patches. The gateway path of `regression.sh` changed after the local run only in the result writer (covered by the tests above), so the full tier was not run again. Its shellcheck pass did not run (shellcheck not available); the `run:` scripts were read by hand and their `jq` programs run locally against sample data.
- Not provable here: the PR's CI run (matrix jobs `regression / gateway (min = 2026.10.3)` red on #39 only, `regression / gateway (latest = 2026.11.10)`, the summary table, caches, artifacts) and the weekly/dispatched beta run (only after merge to `main`).

**Commands:**
- `npm test` -- expected: green, including the new script test
- `npm run typecheck` -- expected: clean
- `scripts/regression.sh resolve min latest beta` (or the chosen form) -- expected: the resolved versions, deduplicated
- push to the PR branch -- expected: CI shows `gateway (min = 2026.10.3)` and `gateway (latest = …)`; min red only on the #39 case (#106), latest green

**Manual checks (if no CLI):**
- `actionlint` if available, else a careful read of the YAML against GitHub's reusable-workflow rules (`workflow_call` inputs, `needs` outputs into `strategy.matrix` via `fromJSON`)

---
title: 'OpenClaw version matrix in CI and a weekly beta run'
type: 'feature'
ticket: '4'
created: '2026-11-27'
status: 'in-progress'
baseline_revision: '54d6565b2b6d4e1b30f53d0e0d1f69d28ee9ba56'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
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
- [ ] `.github/workflows/regression.yml` -- reusable (`workflow_call`, plus `workflow_dispatch` for a manual run): resolve job, per-version matrix job, summary, failure artifact
- [ ] `scripts/regression.sh` -- resolve-only mode and an optional packed-`.tgz` flag, default behavior unchanged
- [ ] `.github/workflows/ci.yml` -- `regression` job on min and latest
- [ ] `.github/workflows/regression-beta.yml` (or similar) -- weekly schedule and dispatch on `beta`, issue job with `issues: write`
- [ ] `scripts/regression-beta-issue.mjs` + its unit test -- open or comment, with the stubbed API
- [ ] `.github/labels.yml`, `docs/release.md` -- marker label; a short section on the matrix and the weekly run
- [ ] `MEMORY.md` -- the facts a later thread needs (job names, where results show)

**Acceptance Criteria:**
- Given this pull request, when CI runs, then the Gateway tier shows as one job per version (min and latest) with the resolved versions in the summary, and a red scenario turns only its version red.
- Given the beta issue script with a stub, when it runs red with no open issue, red with an open issue, and green, then it opens exactly one issue, comments on the open one, and does nothing.
- Given `npm test` and `npm run typecheck`, when they run, then both are green.
- Given `scripts/regression.sh gateway` without the new flags, when it runs locally, then it behaves as before.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm test` -- expected: green, including the new script test
- `npm run typecheck` -- expected: clean
- `scripts/regression.sh resolve min latest beta` (or the chosen form) -- expected: the resolved versions, deduplicated
- push to the PR branch -- expected: CI shows `gateway (min = 2026.10.3)` and `gateway (latest = …)`; min red only on the #39 case (#106), latest green

**Manual checks (if no CLI):**
- `actionlint` if available, else a careful read of the YAML against GitHub's reusable-workflow rules (`workflow_call` inputs, `needs` outputs into `strategy.matrix` via `fromJSON`)

---
title: 'Regression ledger: one entry and one test per past bug'
type: 'feature'
ticket: '1'
created: '2026-11-27'
status: 'in-review'
baseline_revision: '34940e6f6cdce5f45a77447a8b55d92087d0f88a'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing records which test guards which past bug, at which level, so fixes verified only against the plugin's own model of the host count the same as fixes verified on a real host, and five bug families came back (#76→#102, #40→#97, #11→#38→#44, #9→#35→#45, #39→#98).

**Approach:** A committed ledger `test/regression/ledger.toml` with one entry per closed `type:bug` issue; an offline vitest check that every named test exists; a CI-only check (GitHub API, workflow token) that every closed `type:bug` issue has an entry; and agent rules that make every bug fix add its entry and a test at the tier where the bug showed.

## Boundaries & Constraints

**Always:** the ledger is plain TOML, one `[[bug]]` table per issue; it is honest: an entry whose test is only a unit-level proxy says so (`reproduces = false`), and a bug with no test yet names the epic-regression-gate ticket that will add it (`planned = "4.3"` etc.) instead of pointing at a test that does not exist; `npm test` stays offline; English.

**Never:** add a runtime dependency; change `src/`; fetch issues in `npm test`; weaken or move existing tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid ledger | every entry's `tests` names files that exist and test titles found in them | `ledger.test.ts` passes | — |
| Missing test | an entry names a file or a test title that does not exist | `ledger.test.ts` fails naming the issue and the missing test | — |
| Bad entry | duplicate `issue`, unknown `tier`, an entry with neither `tests` nor `planned` nor `no_test_reason`, an unknown key, a value type the subset parser does not accept | fails naming the line or the issue | — |
| Issue coverage OK | `scripts/regression-ledger.mjs check-issues` with a token; every closed `type:bug` issue (pull requests excluded) has an entry | exit 0, prints the count | — |
| Issue missing | a closed `type:bug` issue has no entry | exit 1, lists the issue numbers | — |
| No token / API error | `GITHUB_TOKEN` unset, or the API fails | no token: exit 0 with "skipped: no GITHUB_TOKEN"; API failure: exit 1 with the status | — |

</intent-contract>

## Code Map

- Closed `type:bug` issues on 2026-11-27 (20): #11, #12, #13 (closed not_planned: OpenClaw-side, no plugin change), #14, #35, #36, #38, #39, #40, #44, #45, #46, #67, #74, #75, #76, #80, #97, #98, #99. Open: #102 (gets its entry with its fix). Read each issue (`gh api repos/xtimor/openclaw-all-cli/issues/<n>`) and the commits/tests that name it (`git log --grep '#<n>'`, `grep -rn '#<n>\b' test src`) to fill the ledger.
- Families (from the change proposal `_bmad-output/initiative-openclaw-all-cli/change-pre-release-regression-gate/change-pre-release-regression-gate.md`): `native-tools-note` (#76, #102), `context-usage` (#40, #97, #12, #46), `first-reply-latency` (#11, #38, #44), `provider-icon` (#35, #45), `provider-name` (#36, #14), `auth-status` (#39, #98), `quota` (#99), `structured-output` (#75), `process-lifecycle` (#74), `native-selection` (#67), `docs` (#80), `webchat` (#13).
- Tiers: `unit` (vitest under `src/` or `test/`, no host), `gateway` (`test/regression/gateway/`, ticket 4.2 harness), `ui` (ticket 4.6), `live` (`test/live/`, real Cursor). Planned owners: gateway scenarios 4.3 (turn/process/prompt: #13 #14 #12/#46 #40/#97 #67 #74 #11/#38 #76 #99) and 4.9 (#98 #39 #80 and Test connection / managed install), UI 4.6 (#35/#45 #39/#98 #40/#97), live 4.5 (#76 #75 #44 latency).
- `test/regression/harness.ts`, `test/regression/gateway/tracer.regression.test.ts` -- the Gateway tier from ticket 4.2 (not edited here).
- `.github/workflows/ci.yml` job `check` -- add one step after `scripts/ci-check.sh`: `node scripts/regression-ledger.mjs check-issues` with `GITHUB_TOKEN: ${{ github.token }}` and `GITHUB_REPOSITORY` (job permissions stay `contents: read`; add `issues: read`).
- `docs/agents/implement.md` "Reproduction test" rule and `_bmad/custom/bmad-build.toml`, `_bmad/custom/bmad-build-auto.toml` `persistent_facts` -- extend with the ledger rule.
- Test-title matching: a ledger test is `{ file = "path", name = "substring of an it()/describe title" }`; check by reading the file text for the substring inside a string literal (no need to run vitest).

## Tasks & Acceptance

**Execution:**
- [x] `test/regression/ledger.toml` -- new: header comment with the schema; one `[[bug]]` per closed `type:bug` issue: `issue` (int), `title` (short), `family`, `tier` (the tier where the bug showed), `fixed` (bool; false for #13), `tests` (array of inline tables `{ file, name, tier, reproduces }`, may be empty), `planned` (optional ticket ref like `"4.3"`), `no_test_reason` (optional string) -- the record
- [x] `test/regression/ledger.ts` -- new: a minimal parser for exactly this TOML subset (comments, `[[bug]]`, `key = "string" | int | bool | [ ... ]` with strings or inline tables of string/bool values, multi-line arrays) that throws with the line number on anything else, plus `loadLedger()` -- shared by the test and the script
- [x] `test/regression/ledger.test.ts` -- new: the Valid / Missing test / Bad entry rows, including mutation-style cases on in-memory ledgers (a missing file, a missing name, a duplicate issue, an entry with no test, plan, or reason)
- [x] `scripts/regression-ledger.mjs` -- new: `check-issues` reads the ledger (import the parser via a small `.mjs` copy or by running the TS through node's type stripping, whichever works on Node 24.22 without a build step) and the GitHub API (`/repos/{repo}/issues?state=closed&labels=type:bug&per_page=100`, paginated, pull requests excluded), then the Issue coverage rows -- the CI check
- [x] `test/regression-ledger-script.test.ts` -- new: drives `check-issues` against a local HTTP stub (`GITHUB_API_URL` override) for OK, missing, no-token, and API-error rows
- [x] `.github/workflows/ci.yml` -- the step and `issues: read`
- [x] `docs/agents/implement.md`, `_bmad/custom/bmad-build.toml`, `_bmad/custom/bmad-build-auto.toml` -- the rule: a bug fix adds or updates its ledger entry and a test at the tier where the bug showed (gateway or ui for a host-visible bug, live for model behavior), proved red before the fix; never delete an entry
- [x] `MEMORY.md` -- one line under "Where things are"

**Acceptance Criteria:**
- Given main with this change, when `npx vitest run test/regression/ledger.test.ts` runs, then it passes and the ledger has exactly one entry for each of the 20 closed bugs.
- Given an entry's test name changed to text that is in no test, when the ledger test runs, then it fails naming that issue.
- Given CI on a pull request, when the job runs, then the coverage step passes with the 20 issues and would fail if an entry were removed.
- Given an agent fixing a bug, when it reads `docs/agents/implement.md`, then the rule to add a ledger entry and a tier-appropriate test is there.

## Implementation Notes

- Parser: `test/regression/ledger.ts` (`parseTomlSubset`, `parseLedger`, `loadLedger`, `testTitles`, `missingTests`). `scripts/regression-ledger.mjs` imports it directly through Node's type stripping (works with no flag and no warning on Node 24.22; also on 22.23). No `.mjs` copy.
- Title matching reads the string literal of each `describe`/`it`/`test` call (with `.skipIf(...)`/`.each(...)` modifiers and `describeLive`/`describeRegression`), so a name found only in a comment or an assertion does not count.
- Schema checks beyond the matrix: a unit test cannot claim `reproduces = true` for a bug from a higher tier; a `live` test must be under `test/live/`, a `gateway` test under `test/regression/gateway/`; `planned` is `"4.3"` or `"4.3, 4.6"`; `family` is kebab-case. The committed-ledger test also requires `planned` or `no_test_reason` for every bug with no reproducing test at its own tier.
- Backfill: 20 entries. No gateway or ui test exists yet, so every entry has unit proxies (`reproduces = false`) or live tests plus `planned`; #11 has one reproducing live test (`turn-latency.live`, warm process over four turns). #36 is planned for 4.6 (the provider card shows the name) though that ticket's text names only the icon. #13 `fixed = false`.
- `check-issues` falls back to package.json `repository.url` when `GITHUB_REPOSITORY` is unset; `--ledger <path>` checks another file (tests, scratch mutation).
- CI: job-level `permissions: contents: read, issues: read` on `check` only (the clawhub job keeps the workflow default).
- `docs/agents/implement.md`: the rule says "a `type:bug` issue in state `closed`", because `test/agent-flow-docs.test.ts` refuses lines that talk about closing issues.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/regression/ledger.test.ts test/regression-ledger-script.test.ts` -- expected: pass
- `GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=xtimor/openclaw-all-cli node scripts/regression-ledger.mjs check-issues` -- expected: exit 0, 20 issues covered (if `gh auth token` is unavailable, use the session's GitHub access through `gh api` to list the issues and compare by hand; record it)
- `npm test` -- expected: green
- `npm run typecheck` -- expected: clean

**Results (2026-11-27):**
- `npx vitest run test/regression/ledger.test.ts test/regression-ledger-script.test.ts`: 31 passed (Node 24.22 and 22.23).
- `GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=xtimor/openclaw-all-cli node scripts/regression-ledger.mjs check-issues`: exit 0, "20 closed type:bug issues of xtimor/openclaw-all-cli, every one in the ledger".
- Mutation: a ledger name changed to text in no test fails `ledger.test.ts` naming the issue (in-memory test for #14, and by hand on the file for #35); an entry removed in a scratch copy fails `check-issues` with `#14` (script test against the stub).
- `npm test`: green. `npm run typecheck`: clean.

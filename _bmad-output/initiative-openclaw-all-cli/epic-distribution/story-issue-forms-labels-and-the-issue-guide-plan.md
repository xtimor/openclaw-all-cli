---
title: 'Issue forms, labels, and the issue guide'
type: 'feature'
ticket: '6'
created: '2026-10-22'
status: 'in-progress'
baseline_revision: '4622b2e18950392922f80fd6cfc22540ccfcc3da'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** There is no way to file a bug or an idea in a shape the triage and implementation agents can rely on, and the labels of `issue-flow.md` do not exist on GitHub.

**Approach:** Add GitHub issue forms (`bug.yml`, `idea.yml`, `config.yml` with blank issues off and a private security-report link), `SECURITY.md`, the label set of `issue-flow.md` as code (`.github/labels.yml`) with an idempotent sync workflow, and `docs/issues.md` (how people and agents file, the states, what happens when, only the owner approves work), linked from `README.md`.

## Boundaries & Constraints

**Always:** forms set their type label (`type:bug` / `type:idea`) and `status:new`; both forms have a "Filed by an agent" checkbox, and `docs/issues.md` gives agents the same headings for `gh issue create` / the REST API plus the body line `Filed by: agent`; labels file lists every label of `issue-flow.md` (all `status:*` states, `type:bug`, `type:idea`, `priority:p0`..`p3`, `source:agent`) with color and description; the sync creates missing labels and updates color/description, never deletes; logic in an agent-neutral script (`scripts/sync-labels.mjs`, Node only, no new dependency), the workflow only wires it; actions pinned by the SHAs used in `ci.yml`; workflow `permissions: issues: write` only.

**Never:** add the state automation (3.7) or the triage/implementation agents (3.8, 3.9); delete labels; read issue text in this ticket's code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_SYNC | repo without the labels | every label created with color and description | API error: non-zero exit naming the label |
| SECOND_SYNC | all labels present and equal | no write calls, exit 0 (idempotent) | No error expected |
| DRIFT | a label with another color/description | updated in place | No error expected |
| EXTRA_LABEL | a label not in the file | left as is | No error expected |
| BAD_FILE | labels file with a missing color or a duplicate name | fails before any API call | message names the entry |

</intent-contract>

## Code Map

- `.github/ISSUE_TEMPLATE/bug.yml` -- new form: plugin version, OpenClaw version, `cursor-agent` version, steps, expected, actual, logs (render: shell), "Filed by an agent" checkbox; `labels: ["type:bug", "status:new"]`.
- `.github/ISSUE_TEMPLATE/idea.yml` -- new form: problem, proposal, who benefits, checkbox; `labels: ["type:idea", "status:new"]`.
- `.github/ISSUE_TEMPLATE/config.yml` -- `blank_issues_enabled: false`; contact link "Report a security issue privately" → `https://github.com/xtimor/openclaw-all-cli/security/advisories/new`.
- `SECURITY.md` -- new: report privately via that link, what to include, no public issues for vulnerabilities, supported version = latest release.
- `.github/labels.yml` -- new: list of `{name, color, description}` (a flat YAML list the script can parse without a YAML library, or JSON-compatible YAML).
- `scripts/sync-labels.mjs` -- new: reads the file, validates it, lists repo labels via the REST API (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, Node `fetch`, paginated), creates or patches only what differs; `--dry-run` prints the plan; `SYNC_LABELS_API` overrides the API base for tests.
- `test/sync-labels.test.ts` -- new: a local HTTP stub of the labels API covering every matrix row; also asserts the labels file has exactly the labels `issue-flow.md` names.
- `.github/workflows/labels.yml` -- new: `push` to `main` with `paths: [.github/labels.yml, scripts/sync-labels.mjs]` and `workflow_dispatch`; checkout + setup-node 24.22.0 (pins as in `ci.yml`), `node scripts/sync-labels.mjs`, `GITHUB_TOKEN: ${{ github.token }}`.
- `docs/issues.md` -- new user doc: filing (web forms; agents via `gh issue create --label ... --body` or the REST API with the same `### ` headings as the forms and `Filed by: agent`), the states table and what happens when (triage twice a day, the owner approves, an agent opens a PR), security reports via `SECURITY.md`. `README.md` Docs links it.

## Tasks & Acceptance

**Execution:**
- [ ] forms, `config.yml`, `SECURITY.md`
- [ ] `.github/labels.yml`, `scripts/sync-labels.mjs`, `test/sync-labels.test.ts`
- [ ] `.github/workflows/labels.yml`
- [ ] `docs/issues.md`, `README.md` link

**Acceptance Criteria:**
- Given the stub tests, when `npm test` runs, then every matrix row passes and the labels file equals the labels of `issue-flow.md`.
- Given the change on `main`, when the label workflow runs twice, then the first run creates every label and the second writes nothing (orchestrator checks after merge).
- Given an issue filed through the API with the documented headings and labels, then it reads like a form issue and carries its type label (orchestrator checks after merge).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run typecheck && npx vitest run test/sync-labels.test.ts` -- expected: pass
- `python3 -c "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/**/*.yml',recursive=True)]"` -- expected: parses
- `npm run ci` -- expected: exit 0

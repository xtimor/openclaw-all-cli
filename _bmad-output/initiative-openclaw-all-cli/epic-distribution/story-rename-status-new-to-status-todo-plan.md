---
title: 'Rename `status:new` to `status:todo`'
type: 'chore'
ticket: 27
created: '2026-10-31'
status: built
baseline_revision: '67315361cf08c9c88d35511198eefe5ad3bcbe3a'
route: 'oneshot'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['in-session']
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred:
  - summary: >-
      After the sync migrates the issues, the old status:new label is kept (never deleted), so it needs a manual delete by the owner.
    evidence: |-
      By the ticket ("never delete a label"). The sync warns on every run while both labels exist and lists nothing to move once the old one is empty. The earlier note here (GitHub renames the label on every issue, so a form issue gets no label for a while) was wrong: issue-flow adds status:todo before the rename, GitHub auto-creates it, both labels then exist; the review of 2026-10-31 found it and the migration fixes it.
    location: >-
      scripts/sync-labels.mjs migrate
    severity: low
  - summary: >-
      The triage routine's own prompt (set by the owner in claude.ai) may still name the old status.
    evidence: |-
      A routine prompt is not in the repository, so it cannot be checked here. docs/agents/triage.md (the file the prompt points at) says status:todo.
    location: >-
      claude.ai routine "Triage issues"
    severity: low (unverified)
  - summary: >-
      The migration runs only against the stub: a real repository with thousands of issues carrying the old label, rate limits, and locked issues are untested.
    evidence: |-
      listNumbersWithLabel pages up to 10 000 issues, then adds and removes one by one; a failure is named and makes the run non-zero, and the next run retries the rest (the old label is still on those issues).
    location: >-
      scripts/sync-labels.mjs listNumbersWithLabel, migrate
    severity: low (unverified)
---

<intent-contract>

## Intent

**Problem:** `status:new` reads as "just filed", but the status also holds reopened issues and an author's answer to a question. Work the owner sends back after approval must not land here (that is `status:rework`, ticket 3.28).

**Approach:** Rename the status to `status:todo` (waiting for triage to pick it up) everywhere, same meaning and transitions. On GitHub the existing label is renamed through a new optional `renamed_from` key in `.github/labels.yml` handled by `scripts/sync-labels.mjs` (never create a second label, never delete). Historical `status:new` label events count as `status:todo`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RENAME | entry `status:todo` with `renamed_from: "status:new"`; repository has `status:new` only | one `PATCH` of the old label (`new_name`, color, description); issues keep it; log says renamed | No error |
| NO_OP | repository has `status:todo` only (renamed before) | no write for that label (`unchanged`), no create | No error |
| FRESH | repository has neither | `status:todo` is created like any label | No error |
| BOTH | repository has `status:new` and `status:todo` | nothing is written for that label; run exits non-zero naming both labels; the other labels still sync | `FAILED` line on stderr, non-zero exit, in a dry run too |
| BAD_KEY | `renamed_from` equal to the name (any case), empty, not a string, or the name of another entry | the file is refused before any API call | `labels file line N: ...` |
| HISTORY | label events with `status:new` (labeled/unlabeled) | read as `status:todo` (latest wins, approval-revert restore, stale timing) | none |

</intent-contract>

## Code Map

- `.github/labels.yml` -- the label set; `status:new` entry becomes `status:todo` + `renamed_from`.
- `scripts/sync-labels.mjs` -- `parseLabels`/`validateLabels`/`planSync`/`main`: optional fifth key, new `rename` and `conflict` actions.
- `scripts/issue-flow/transitions.mjs` -- `STATUS_LABELS`, `NEW` constant (all its uses), `normalizeTimeline` and the `labeled` event label (history mapping).
- `.github/ISSUE_TEMPLATE/{bug,idea}.yml` -- `labels:` line.
- `docs/issues.md`, `docs/agents/{triage,comments,identity}.md`, `_bmad-output/.../epic-distribution/{issue-flow,epic-distribution}.md`, `MEMORY.md`, `CHANGELOG.md` -- names.
- `test/{sync-labels,issue-flow,agent-write,agent-flow-docs}.test.ts` -- updated and new tests.
- Not touched: `scripts/agent-write.mjs` (its `LABEL_RE` is generic and names no status), older plans and tickets (history), `.github/workflows/*` (no status name).

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `scripts/sync-labels.mjs` -- `renamed_from` key and rename/conflict logic
- [ ] `scripts/issue-flow/transitions.mjs` -- `TODO` constant, `LEGACY_STATUS` map applied to timeline and event labels
- [ ] issue forms, docs, design docs, MEMORY, CHANGELOG -- rename
- [ ] tests: labels file, sync cases (rename, no-op, fresh, both, bad key, dry run), transitions (opened, reopened, author reply, none left, history), forms, grep pin
- [ ] mutation checks of the new guards, recorded in the review log

**Acceptance Criteria:**
- Given the labels file, then it has `status:todo` with `renamed_from: "status:new"` and no `status:new` entry.
- Given a repository with only `status:new`, when the sync runs, then that label is renamed in place (one PATCH, no POST, no DELETE); with both labels it fails with a message naming both.
- Given label events naming `status:new`, when the state is settled, then they act as `status:todo`.
- Given the repository, then no live code or doc outside the changelog, history, and `renamed_from` names `status:new`.

## Implementation Notes

Route is `oneshot`, pinned: this worker has no subagent tool, and the caller asked for an in-session build and review (the full route and the thorough review need subagents).

Decisions:
- A lingering `status:new` on an issue before the label sync has run (minutes after the merge) is not mapped: only label events are (the ticket says so). GitHub renames the label on every issue when the sync renames it.
- `conflict` (both labels exist) is a failure in dry run too, so the owner can see it before a merge.
- `renamed_from` stays in the file after the rename (the key does nothing once the old label is gone); the file header says so.
- The history alias is one table, `LEGACY_STATUS` in `transitions.mjs`, read by `normalizeTimeline` and by the event's own label; nothing else in the module reads label names from events.
- Found while testing: `main` POSTed the whole parsed entry, so the new `renamedFrom` field would have gone to the API; the create body is now exactly name, color, description (`FIRST_SYNC` pins it).

Files touched: `.github/labels.yml`, `.github/ISSUE_TEMPLATE/{bug,idea}.yml`, `scripts/sync-labels.mjs`, `scripts/issue-flow/transitions.mjs`, `docs/issues.md`, `docs/agents/{triage,comments,identity}.md`, `epic-distribution/{issue-flow,epic-distribution}.md`, `MEMORY.md`, `CHANGELOG.md`, `test/{sync-labels,issue-flow,agent-write,agent-flow-docs}.test.ts`.

## Plan Change Log

### 2026-10-31 -- independent review (opus) of the first build
- Triggering finding M1 (rollout race): between the merge and the `Labels` run, issue-flow adds `status:todo` before the rename, GitHub auto-creates it, both labels exist, and the sync as built failed forever. Amended: (a) `normalizeIssue` reads a literal `status:new` as todo and never adds `status:todo` beside it; (b) the sync migrates the issues of the old label to the new one when both exist, keeps the old label, warns, and a dry run lists the moves. The Implementation Notes decisions "a lingering status:new is not mapped" and "conflict is a failure in dry run too" are superseded.
- Also: L6 a `renamed_from` used by two entries is refused; L7 the relay refuses adding any `status:` name outside `STATUS_LABELS`.
- Known-bad states avoided: a sync that fails every run after the race; a second status label added beside the legacy one; a stray `status:` label made from a typo. KEEP: the history alias, the create body of three keys, the rename and no-op paths.

## Review Triage Log

### 2026-10-31 -- Review pass (quick, in this session: the worker has no subagent tool and the caller asked for an in-session review)
- verdicts: 3 findings -- high 0, medium 0, low 2, false 1, maybe-false 0
- findings:
  - `[low]` `[defer]` An issue that still carries the old `status:new` label in the minutes between the merge and the label sync is not read as a status (only label events are mapped, as the ticket says) -- SUPERSEDED by the independent review below (M1: this window is a real race, not a harmless gap) -- GitHub renames the label on every issue when the sync runs on the merge; the forms already set `status:todo`, so a form issue filed in that window gets no status label until its next event. Recorded in MEMORY.
  - `[low]` `[defer]` The triage routine's own prompt is set by the owner in claude.ai and may name the old status -- not visible from the repository; the owner checks it after the merge.
  - `[false]` `[reject]` "`planSync` renames a label that another file entry still wants" -- `validateLabels` refuses a `renamed_from` that is another entry's name (mutation-checked).
- Mutation checks (each applied alone, the tests run, the change reverted): 17 mutations, all killed by a test: rename branch removed; both-exist check removed; conflict not counted as a failure; dry run skips the conflict; rename PATCH without `new_name`; old label matched case-sensitively (found a gap: added the `renamed_from` case test); `renamed_from` equal to the name, empty, or another entry accepted; create body carries `renamedFrom`; `renamed_from` dropped from the file; `status:new` kept as the entry name; a form sets `status:new` again; history alias removed; event payload label not mapped; `TODO` renamed back; `status:new` back in `docs/issues.md`.

### 2026-10-31 -- Independent review (opus) of the first build, fixed in a follow-up
- verdicts: 3 findings for this ticket -- high 1, medium 0, low 2, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` M1 rollout race (see the Plan Change Log): the sync failed forever once both labels existed, and my first review had called the window harmless (a wrong deferred note) -- patched: `normalizeIssue`/`setStatus`/`clearStatus` treat a literal `status:new` as todo and never add `status:todo` beside it; `sync-labels.mjs` `migrate` moves every issue and pull request (open and closed, paginated) from the old label to the new one, adds before it removes, keeps the old label, warns every run, lists the moves in a dry run; tests in `test/issue-flow.test.ts` and `test/sync-labels.test.ts`.
  - `[low]` `[patch]` L6 a duplicate `renamed_from` (case-insensitive) was accepted -- patched in `validateLabels`, test added.
  - `[low]` `[patch]` L7 the relay accepted any `status:` name, so a typo or `status:new` would create a stray label -- patched: refused unless in `STATUS_LABELS` (removing is fine), test added.
- Mutation checks (follow-up): 15 mutations, all killed: literal old name not read as todo; todo added beside it; legacy duplicate kept; clear/removal sending the canonical name; migrate removing before adding; listing open issues only; reading one page only; no warning; dry run writing; a failed issue not counted; the new label not updated; duplicate `renamed_from` accepted; relay accepting any status name. One gap found and closed (the stub ignored `state=`).

## Verification

**Commands:**
- `npx vitest run test/sync-labels.test.ts test/issue-flow.test.ts test/agent-write.test.ts test/agent-flow-docs.test.ts` -- all pass
- `npm run ci` -- passes (`.spike` Node 24 first in PATH, done by the script)

## Auto Run Result

Status: built.

Summary: `status:new` is `status:todo` everywhere (label file, forms, state automation, docs, design docs, tests). The label file takes an optional `renamed_from`; the sync renames the old label in place, no-ops when only the new one exists, creates when neither exists, and fails (writing nothing for it) when both exist. Historical `status:new` label events count as `status:todo` in `scripts/issue-flow/transitions.mjs`.

Review: quick, run in this session (no subagent tool in this worker). 3 findings: 2 low deferred as risks (recorded above), 1 false. Patches applied: 0 (one bug, the create body carrying `renamedFrom`, was found by a test during the build, before the review). Follow-up review recommended: false (no patched `high`, fewer than two patched `medium`).

Follow-up (2026-10-31): the independent review's M1, L6, and L7 are fixed (see the Plan Change Log and the second triage entry). Follow-up review recommended: true, because M1 was a patched high and the migration has only run against a stub (a real repository's rate limits, locked issues, and a large backlog of old-label issues are unverified).

Verification: `npx vitest run` on the four touched test files, then `npm run ci` (plan gate, typecheck, 1630 unit tests, build, package allowlist, pack, install smoke): all passed.

Residual risks: not run live: the label sync renaming the real label on `main`, and the owner's routine prompt if it names the old status.

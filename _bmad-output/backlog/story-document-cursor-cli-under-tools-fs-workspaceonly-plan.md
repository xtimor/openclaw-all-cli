---
title: 'Document cursor-cli under tools.fs.workspaceOnly'
type: 'chore'
ticket: '19'
created: '2026-11-04'
status: built
baseline_revision: '3d7fe1316952a4bde493d1ccec0d44bba1240072'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** An agent bound to `cursor-cli` with `tools.fs.workspaceOnly: true` is unenforced on OpenClaw 2026.10.3 (Cursor's native `read`, `grep`, `glob` reach outside the workspace) and refused at preflight on 2026.10.9 (the host asks for an exact tool list, the plugin's `prepareExecution` throws its existing `cursor-cli keeps native read, grep, glob on in every turn ... OpenClaw did not start the run.`, the fallback chain logs `candidate_failed`). No user doc says so (issue #65).

**Approach:** Docs only, worded as current behavior (issue #67 changes it later). Scope and acceptance criteria are the ticket's (`_bmad-output/backlog/story-document-cursor-cli-under-tools-fs-workspaceonly.md`, AC 1-5):

1. `docs/providers/cursor.md`: a new `### Workspace-only file access (tools.fs.workspaceOnly)` subsection at the end of `## Permissions and tool availability` (before `## Shell commands`). It states: `cursor-cli` keeps native `read`, `grep`, `glob` on in every turn and cannot honour `tools.fs.workspaceOnly`; unenforced on OpenClaw 2026.10.3 and earlier (the run starts, nothing narrows the native tools); refused at preflight on 2026.10.9 and later releases that carry the host-side handling (also seen on 2026.10.8; the first such release is not named); the refusal is a model failure in fallback decisions (`candidate_failed`, then the next fallback), not a configuration error at `config set` time (config accepts it); the advice: do not combine `workspaceOnly: true` with a `cursor-cli` primary, run an agent that needs the boundary on the embedded runtime (an API model), or accept the refusal and configure a fallback model on purpose, knowing the fallback answers without the CLI backend. Quote the message as in `src/core/backend.ts` `prepareExecutionFor`.
2. Same file, `## Known limits`: one bullet naming the limit and pointing to the new subsection.
3. `docs/setup.md` Troubleshooting: the existing `cursor-cli keeps native read, grep, glob on in every turn...` row gains `tools.fs.workspaceOnly: true` (OpenClaw 2026.10.9) in its cause and a link `providers/cursor.md#workspace-only-file-access-toolsfsworkspaceonly` in its fix.
4. `CHANGELOG.md` `## Unreleased` `### Changed`: one plain `Docs: ...` line with `([#65](https://github.com/xtimor/openclaw-all-cli/issues/65))`, matching the neighbouring lines' style.

Must not change: plugin code, the preflight message, tests' expectations.

</intent-contract>

## Implementation Notes

Oneshot route: about 15 lines of prose in three docs files, no code; below the 100-line threshold.

- Decision: the ticket's AC 5 names `npm run check`, which `package.json` does not define; the plan verifies with `npm run typecheck` and `npm run ci` (`scripts/ci-check.sh`, which also runs `npm test`) in its place.
- Decision: the doc adds that 2026.10.8 also refused (MEMORY.md, upstream follow-up #55, probed 2026-10-29) without claiming the first release; this keeps AC 1's "2026.10.9 and later" and the ticket's note not to name a first release.
- Decision: extend the existing Troubleshooting row (same symptom text) instead of adding a duplicate row; add a Known limits bullet because every limit in `cursor.md` is listed there.
- Live Cursor check: not needed (docs only); not run.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `grep -n workspaceOnly docs/providers/cursor.md` -- expected: hits in the new subsection and the Known limits bullet
- `grep -n 'workspace-only-file-access' docs/setup.md` -- expected: the Troubleshooting row's link; the anchor matches GitHub's slug of the new heading
- `git diff --stat` -- expected: only `docs/providers/cursor.md`, `docs/setup.md`, `CHANGELOG.md` (plus this plan)
- `npm test` -- expected: pass (includes `test/changelog.test.ts` and `test/parity-suite.test.ts`, which read these files)
- `npm run typecheck` and `npm run ci` -- expected: pass

## Review Triage Log

### 2026-11-04 — Review pass
- verdicts: 6 findings — high 0, medium 0, low 3, false 1, maybe-false 0 (plus 2 patched lows counted below)
- findings:
  - `[false]` `[reject]` Review step not done — the review ran in this pass (first worker had no subagents); the finding describes the earlier blocked state.
  - `[low]` `[patch]` Ticket AC 5 names `npm run check`, which does not exist — ticket now says `npm run typecheck`.
  - `[low]` `[patch]` Setup row says "2026.10.9" only while cursor.md says "2026.10.9 and later" — setup row now says "2026.10.9 and later".
  - `[low]` `[reject]` "2026.10.3 and earlier" only evidenced for 2026.10.3 — the wording is the ticket's AC 1; rejected, not worth more words.
  - `[low]` `[reject]` "see above" pointer is vague — the preceding paragraph in the same section; fix would not change meaning.
  - `[low]` `[reject]` Quoted message is the full three-tool text — correct for an empty native selection, which is what `workspaceOnly` produces.

## Auto Run Result

Status: built
Implementation: commit 4da61955a3dab45552bcb0b44319e8f09ef16ee1 (baseline 3d7fe1316952a4bde493d1ccec0d44bba1240072). Added `### Workspace-only file access (tools.fs.workspaceOnly)` in `docs/providers/cursor.md`, a Known limits bullet there, the Troubleshooting row link in `docs/setup.md`, and one `Docs:` line in `CHANGELOG.md` (#65). Review patches: setup row wording, ticket AC 5 command.
Review: quick lens ran (context-free subagent); 2 low findings patched, 4 rejected (see triage log).
Verification: `npm run typecheck` and `npm run ci` pass; live Cursor check not needed (docs only), not run.

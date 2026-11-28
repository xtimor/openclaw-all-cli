---
title: 'In ask mode the model reads a missing native edit tool as a read-only session'
type: 'bugfix'
ticket: '33'
created: '2026-11-28'
status: 'in-progress'
baseline_revision: 'cd8a412cd3177daefc602f47154ca2118ebb0e13'
route: 'full'
route_source: 'pinned'
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

**Problem:** A turn where the host serves no OpenClaw `exec` runs in Cursor's `ask` mode, which has no edit tool, with the native shell and write denied. The prompt says nothing about it (`shellNote`, #76, goes only to `exec` turns), so the model takes the session for read-only and refuses writes the OpenClaw tools (`write`, `edit`, `workboard_comment`, ...) allow, on consecutive turns of one process (issue #102).

**Approach:** The core adds one neutral sentence, `askToolsNote(listed)`, to every prompt of a process opened for a turn whose host tool list has no `exec` but holds at least one OpenClaw tool that changes files or records: the native shell, write and edit tools are off, that does not make the chat or the session read-only, the named OpenClaw tools stay usable, never refuse a change because the chat seems read-only. `ask` mode stays.

## Boundaries & Constraints

**Always:** Core text names no CLI (AD-2). Name only mutating tools actually in the turn's list. Send on every prompt of the process (refusals came on turn 2 too), unlike `shellNote`.

**Never:** Change `modeFor`, the permission profiles, the `exec`/`process` serving, the #76 sentence, the continuity or `structured_output` notes. Touch `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, protected `package.json` fields.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ask turn | list `read, write, edit, workboard_comment` | sentence names `write`, `edit` and `workboard_comment` | none |
| Warm turns | 2-3 turns, one process | sentence in every prompt | none |
| Marker, no exec | host flagged a shell, list has no `exec` | sentence sent | none |
| Exec turn | list has `exec` | #76 sentence only | none |
| Nothing mutating | list `read, sessions_history` or empty | no sentence | none |
| Unreadable list / side question | `tools/list` fails, or no MCP | no sentence | fail safe: nothing |

</intent-contract>

## Code Map

- `src/core/turn-prompt.ts` -- `shellNote`, `HOST_*_TOOL`: add `MUTATING_HOST_TOOLS` and `askToolsNote(listed)`.
- `src/core/execute.ts` -- `openFresh` (~L270): `listed` from `listToolNames`, `hostShell`; set `fresh.askToolsNote` when not `hostShell`. `promptTurn` (~L421): the `note` array; do not clear the new field.
- `src/core/live-entry.ts` -- `LiveEntry.shellNote`: add `askToolsNote`.
- `src/adapters/cursor/index.ts` -- `modeFor` comment (unchanged code; comment may point at the sentence).
- `src/adapters/cursor/manifest.ts` -- P8, P10 notes.
- `test/fixtures/host-tools-turn.ts` -- `turnWithHostTools(names, {marker, turns})`, reuse.
- `test/shell-hint.test.ts` -- style; `test/ask-tools-hint.test.ts` (new).
- `test/regression/gateway/reply-prompt.regression.test.ts` -- #76 scenario; add #102. `sessions.patch {key, execHost: "node"}` makes the host serve no `exec` (`resolveCliMcpToolOwnership` in the host's `prepare.runtime-*.mjs`: `host !== "node"`, 2026.10.3 and 11.x).
- `test/regression/ledger.toml` -- #76 comment, add #102.
- `docs/providers/cursor.md` (mode paragraph, Shell commands, "No `exec`" limit, P8/P10 rows), parity matrix P8/P10, `CHANGELOG.md`, `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [ ] `test/ask-tools-hint.test.ts`, `test/regression/gateway/reply-prompt.regression.test.ts` -- unit and Gateway reproduction; prove red on the baseline, commit
- [ ] `src/core/turn-prompt.ts`, `src/core/live-entry.ts`, `src/core/execute.ts` -- the fix
- [ ] `src/adapters/cursor/manifest.ts`, docs, parity matrix, ledger, CHANGELOG, MEMORY

**Acceptance Criteria:**
- Given the Gateway tier on OpenClaw latest and min, when it runs, then #102 is green and every other scenario as before (min: #39 red, #106, expected).
- Given `npm run typecheck`, `npm test`, `node scripts/changelog.mjs check`, when run, then green.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Decision: the mutating set is a fixed, ordered list of OpenClaw tool names that change files or records: `write`, `edit`, `apply_patch` (core `fs` group), `file_write` (file-transfer plugin), `workboard_create`, `workboard_comment` (Workboard plugin), `wiki_apply` (memory-wiki plugin). `listed` is the raw `tools/list` names of the host's MCP loopback (`listToolNames`), which carry no `readOnlyHint` (the host's `buildMcpToolSchema` sends name, description, schema only), so the plugin cannot classify tools itself; listing every non-read tool (Workboard alone has 39) would make the sentence long and vague. The sentence says "every OpenClaw tool offered here stays usable, including ..." so tools outside the set are not implied read-only.

Decision: the Gateway scenario reaches `ask` mode through a per-session exec host `node` (`sessions.patch`), a documented no-`exec` case, because cron runs with a tool allow-list (the reporter's restricted profile) open a new process per run (probed on 2026.11.11: two `cron run`s of one `session:<id>` job, two pids), so they cannot show turn 2 of one process.

## Verification

**Commands:**
- `npx vitest run test/ask-tools-hint.test.ts` -- red on baseline, green after
- `npm run typecheck`, `npm test` -- green
- `scripts/regression.sh gateway --openclaw latest` -- green; `--openclaw min` -- green except #39 (#106)
- `node scripts/changelog.mjs check`, `npx vitest run test/regression/ledger.test.ts` -- green

---
title: 'In ask mode the model reads a missing native edit tool as a read-only session'
type: 'bugfix'
ticket: '33'
created: '2026-11-28'
status: 'in-review'
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
- [x] `test/ask-tools-hint.test.ts`, `test/regression/gateway/reply-prompt.regression.test.ts` -- unit and Gateway reproduction; prove red on the baseline, commit
- [x] `src/core/turn-prompt.ts`, `src/core/live-entry.ts`, `src/core/execute.ts` -- the fix
- [x] `src/adapters/cursor/manifest.ts`, docs, parity matrix, ledger, CHANGELOG, MEMORY

**Acceptance Criteria:**
- Given the Gateway tier on OpenClaw latest and min, when it runs, then #102 is green and every other scenario as before (min: #39 red, #106, expected).
- Given `npm run typecheck`, `npm test`, `node scripts/changelog.mjs check`, when run, then green.

## Implementation Notes

- Implemented directly in the build session (no subagents here); the plan checkpoint was covered by the owner's `status:approved` on #102 and the orchestrator's instruction to plan and implement. Review (step 4) not run here: the orchestrator runs it.
- Reproduction first (commit 1bde249): `test/ask-tools-hint.test.ts` and the #102 Gateway scenario, red on the baseline build (see Verification).
- The note: `askToolsNote(listed)` in `src/core/turn-prompt.ts`; `LiveEntry.askToolsNote`, set in `openFresh` (`else if (listed)` after the `hostShell` branch), joined into `note` after `shellNote` and before the `structured_output` sentence, and never cleared, so every prompt of the process carries it. Text with two or more tools: "[OpenClaw] The native shell, write and edit tools are disabled in this chat. That does not make this chat or this session read-only: every OpenClaw tool offered here stays usable, and `write`, `edit` and `workboard_comment` change files and records. Never refuse a change on the grounds that the chat is read-only; make it with those tools." (one tool: "changes", "that tool").
- Probe (2026.11.11, scratch Gateway test, not committed): a chat with `sessions.patch {execHost: "node"}` runs both turns on one process in `ask` mode (no `set_mode`), and its loopback offers no `write` or `edit` (default profile: native readers on) but `file_write`; the note named `file_write` on both turns. So the scenario asserts at least one named tool, all from `MUTATING_HOST_TOOLS`, the same on both turns, not `write`/`edit`. The reporter's restricted profile (empty native selection) puts OpenClaw's file tools on the loopback (docs, #67), but its only Gateway route, a cron job with `--tools`, opens a new process per run (probed: two `cron run`s of one `session:<id>` job, two pids).
- Side questions: no MCP target, so no list and no note (unit test with `executionMode: "side-question"`; `turnWithHostTools` got a `ctx` option).
- Docs: P8 and P10 in `src/adapters/cursor/manifest.ts`, the parity matrix, `docs/providers/cursor.md` (mode paragraph, Shell commands, "No `exec`" limit, P8/P10 rows); the `modeFor` comment points at the note. Doc pin in `test/ask-tools-hint.test.ts`. `CHANGELOG.md` Fixed line, ledger entry #102 (and the #76 comment), `MEMORY.md`.
- Live Cursor check not run (optional per the orchestrator; no login used): whether a real model follows the sentence is unverified.

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

**Results (2026-11-28):**
- Unit reproduction `test/ask-tools-hint.test.ts` on the baseline src: 5 failed, 1 passed (the "says nothing" guard): `expected 'do it 0' to match /does not make this chat or this sessi…/` and `askToolsNote is not a function`. After the fix: 10 passed.
- Gateway #102 scenario on the baseline build: red on 2026.11.11 and on 2026.10.3 (the final version of the test), `turn 1 prompt (note absent)`; the other three scenarios of the file green.
- `npm run typecheck`: green. `npm test`: 73 files passed, 30 skipped; 2160 tests passed, 102 skipped.
- `node scripts/changelog.mjs check`, `test/regression/ledger.test.ts`, `test/parity-suite.test.ts`: green.
- `scripts/regression.sh gateway --openclaw latest` (2026.11.11): 19 passed, 4 skipped, 0 failed (748 s); #102 11.8 s.
- `scripts/regression.sh gateway --openclaw min` (2026.10.3): 21 passed, 1 skipped, 1 failed (654 s): only #39, the known #106 (`models.authStatus has no saved cursor-cli profile 30 s after the save`), not touched; #102 6.7 s.
- Matrix audit: ask turn, warm turns, marker without exec, exec turn, nothing mutating, unreadable list and side question each have a unit test that ran and passed.
- Live Cursor check: not run.

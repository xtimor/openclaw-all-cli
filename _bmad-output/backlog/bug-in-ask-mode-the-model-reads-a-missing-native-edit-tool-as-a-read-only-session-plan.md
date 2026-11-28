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
review: 'quick'
review_source: 'auto'
lenses_ran: [self-review, quick]
review_loop_iteration: 1
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

### 2026-11-28 — Reopened after the live regression (ticket 4.5)
- Trigger: the live #102 scenario (`test/live/ask-mode-write.live.test.ts`) was red on OpenClaw 2026.11.11 and 2026.10.3, 3 tries each, on the shipped sentence: the model called no tool and said Ask mode blocks writes, "even though the OpenClaw instructions mention `file_write`". A variant with `tools.deny: ["exec","process"]` refused the same way.
- Amended: the intent contract's "Never: change `modeFor`" and "`ask` mode stays" are superseded by evidence (owner rule 2026-11-28: a regression finding is fixed at once, no approval; the contract block itself is left as written). A turn without `exec` whose list holds an OpenClaw tool that changes files or records now opens in Cursor's `agent` mode (`OpenParams.hostWrites`). The sentence stays. The live scenario moves to the reporter's conditions. See "Follow-up after live regression".
- Known-bad state avoided: a no-exec chat offered OpenClaw's `write`/`edit` that refuses every write (0 of 12 live), and a live scenario whose only writer (`file_write`, default profile) cannot write a local file at all.
- KEEP: `askToolsNote` on every prompt, `MUTATING_HOST_TOOLS`, side questions always `ask`, the fail-safe `ask` for an unreadable list, the static profiles unchanged.

## Follow-up after live regression

**Findings** (live turns used for exploration: 8, budget 60; key: the owner's, never printed):
- (c) The scenario was wrong. With exec host `node` on the default profile the loopback offers no `write`/`edit`, only the file-transfer plugin's `file_write`, which writes on a paired node by absolute path ("Requires operator opt-in: `gateway.nodes.commands.allow` must include `file.write`, and file-transfer policy must authorize the path ... Without policy configured, every call is denied", host descriptor, 2026.11.11). No tool in that turn can write a file on the Gateway host, whatever the mode or the wording.
- Routes to the reporter's conditions (restricted profile, OpenClaw `write`/`edit`, no `exec`), probed with the fake Cursor through a real Gateway (0 Cursor turns): `tools.fs.workspaceOnly: true` on 2026.11.11 gives the restricted profile, `write`, `edit`, `apply_patch`, `file_write` in the list, no `exec`, one process for two turns; on 2026.10.3 the setting is unenforced (default profile, `exec` served, agent mode). `cron add --tools read,write,edit,...` gives the restricted profile with `write`, `edit`, `apply_patch` on both versions, one process per run. A fixture plugin whose `before_prompt_build` hook returns `toolsAllow` gives a restricted chat on one process, but its list has no file writer (the hook only narrows the default projected surface); dropped.
- (a) Reporter's conditions, `ask` mode, current sentence (2026.11.11, `tools.fs.workspaceOnly`, baseline build): 0 of 3 written, no tool called; replies: "Ask mode is active in this session, which blocks file edits ... switch to Agent mode". With the default-profile runs (6 + 3 with `tools.deny`), 0 of 12.
- (b) Cursor's `ask` mode itself makes the model refuse: every refusal names Ask mode, one says it "overrides the OpenClaw note". Same conditions in `agent` mode (fix build): 3 of 3 written through `mcp__openclaw__write`.
- Safety: restricted profile in `agent` mode, asked to use only its own tools (2 turns): native Write blocked (`Read permission denied`), native Shell blocked (`Command blocked by permissions configuration`), no file. The default profile's `agent`-mode lock was checked live on 2026-10-19 (MEMORY, entry 19); its deny list is the restricted one's minus `Read(*)`.
- Cost: an `agent`-mode writing turn about 127k Cursor tokens (3 turns, 382,380: cache read 309,342, cache write 70,600, output 2,410), an `ask`-mode refusal about 37k (3 turns, 110,081, the regression's explore run). Every ordinary chat with `exec` already runs in `agent` mode; this adds only no-exec turns that are offered a writer.

Decision: a turn without `exec` opens in Cursor's `agent` mode when its tool list holds any `MUTATING_HOST_TOOLS` name (`offersHostWrites`); wording alone was tried and failed 0 of 12, and the refusals cite the mode, not the tools.
Decision: the trigger is the same fixed list the sentence names, `file_write` and the Workboard and wiki writers included: with exec host `node` the user's files live on the node, where `file_write` is the writer, and `ask` mode refuses it like any other change.
Decision: the mode is set at open (`LiveEntry.hostWrites`); a warm process that re-reads its list keeps its mode (as for `exec`); an unreadable list stays `ask` (fail safe). Side questions stay `ask`.
Decision: the live scenario runs in the reporter's conditions: `tools.fs.workspaceOnly` (one chat, two turns, one process) on OpenClaw 2026.10.9+, and on older hosts (2026.10.3) two `cron --tools` runs of one cron session, since that host offers no other route and gives each run its own process; the one-process check runs where the host can give one. It still asserts the file, its content, an OpenClaw writer called and no `exec`, on turn 1 and turn 2.
Decision: the turn meter logs each ended OpenClaw MCP call by tool name (`{kind:"tool"}`), the only tool evidence a cron run leaves; no input, output or prompt text.

**Changes:** `src/core/turn-prompt.ts` (`offersHostWrites`), `src/core/live-entry.ts` (`hostWrites`), `src/core/execute.ts` (set at open), `src/core/attach-session.ts` and `src/core/ports.ts` (`OpenParams.hostWrites`), `src/adapters/cursor/index.ts` (`modeFor`), unit tests in `test/ask-tools-hint.test.ts` and `src/adapters/cursor/index.test.ts`, `test/live/turn-meter.mjs` + `test/live-tier.test.ts`, the Gateway #102 scenarios (`agent` mode on the `node` route; new: `tools.fs.workspaceOnly` route, 2026.10.9+; no writer stays `ask`), the live scenario, ledger #102, docs, manifest P8, parity matrix P8, CHANGELOG, MEMORY.

## Review Triage Log

### 2026-11-28 — Review pass 1 (quick lens, triaged by the orchestrator; patches in one commit)
- verdicts: 6 findings — high 0, medium 5, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` a no-`exec` process whose tool list was unreadable at open never got the sentence on a warm turn (no marker, so not `degraded`) — `LiveEntry.withoutHostShell`; a warm turn of such a process with no `askToolsNote` reads the list (one read shared with the `structured_output` re-read) and sets it. Unit test: three turns, first list read fails, turns 2 and 3 carry the sentence (red before).
  - `[medium]` `[patch]` a warm turn whose proxy target was cleared ("OpenClaw tools are unavailable in this turn") still said "every OpenClaw tool offered here stays usable" — the sentence goes only when the turn's target is usable (`turnTarget.ok`). Unit test: turn 2 with a missing MCP config file has no sentence, turn 3 has it again (red before).
  - `[medium]` `[patch]` P10 in the manifest and the parity matrix tied the sentence to the restricted profile; a restricted run can still be served `exec` — worded as "a turn whose tool list has no `exec`, restricted or not".
  - `[medium]` `[patch]` `docs/providers/cursor.md` did not say which ask-mode turns get the sentence — the mode paragraph, the "No `exec`" limit, Shell commands and the P10 row now name the conditions (list read, one of the named tools, usable OpenClaw tools) and the exceptions (side question, unreadable list, no such tool, unavailable tools; a warm process re-reads).
  - `[low]` `[patch]` the CHANGELOG examples (`write`, `edit`, `workboard_comment`) do not appear on a default-profile run — reworded: `file_write`, or `write` and `edit` when Cursor's native file readers are off.
  - `[medium]` `[patch]` the ledger called a fake-Cursor scenario a reproduction of model behavior — #102 is `tier = "live"` like #76, the Gateway scenario `reproduces = false`, `planned = "4.5"` (the ledger test accepts a bug without a reproducing test at its tier when `planned` is set).

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

**Results after review pass 1 (2026-11-28):**
- New unit tests (warm turn after an unreadable list; warm turn with an unusable target): red before the patch (`expected 'do it 1' to match /does not make this chat…/`; `expected '[OpenClaw] The native shell…' to be 'do it 1'`), green after; `test/ask-tools-hint.test.ts` 12 passed.
- `npm run typecheck`: green. `npm test`: 73 files passed, 30 skipped; 2169 tests passed, 102 skipped.
- `node scripts/changelog.mjs check`, `test/regression/ledger.test.ts`, `test/parity-suite.test.ts`: green.
- #102 Gateway scenario alone (`-t "#102"`, fresh state with the patched build): green on 2026.11.11 and on 2026.10.3. Whole tiers not re-run.

**Results of the follow-up after the live regression (2026-11-28, cursor-agent 2026.11.11-b912975):**
- Unit, red before (baseline `src`) and green after: `test/ask-tools-hint.test.ts` "asks the adapter for it when ..." (`expected {...} to match object { hostShell: false, hostWrites: true }`) and "keeps it for every warm turn ...", `src/adapters/cursor/index.test.ts` "is exactly agent without exec when the host offers tools that change files" (`expected 'mode:ask' to be 'mode:agent'`); 3 failed before, 92 passed after. `test/live-tier.test.ts` meter tool log: the replay guard's test red without the guard, green with it.
- Gateway, red before: the baseline build ran the default-profile route and the `workspaceOnly` route in `mode:ask` (the old scenario asserted `ask`; probe on 2026.11.11: restricted profile, `write`/`edit`/`apply_patch`/`file_write` named, `mode:ask`); the new scenarios assert `agent`.
- Gateway tier 2026.11.11 (tarball 29534ac9, the fix without the final comment and manifest-text edits): 21 passed, 4 skipped, 0 failed; the three #102 scenarios green. Gateway tier 2026.10.3 (same tarball, run beside a live run): 22 passed, 2 skipped (the `workspaceOnly` scenario skips by version), 1 failed: the tracer's "exactly one final chat frame" (`expected [...] to have a length of 1 but got 2`, a second prompt in the fake log); green when re-run alone on the same state; not touched by this change (its turn has `exec`).
- Live, scenario only (`LIVE_TESTS=test/live/ask-mode-write.live.test.ts`), final build da082d9c: 2026.11.11 passed on try 1 (`workspaceOnly` chat, one process, 2 turns, 175,806 Cursor tokens); 2026.10.3 passed on try 1 (two cron runs, one process each, `write` per run in the meter log, 2 turns, 152,240 tokens). An earlier 2026.10.3 run on tarball 29534ac9 also passed on try 1 (215,086 tokens; its meter still logged `session/load` replays, fixed since).
- Cursor turns: exploration 8 (ask mode 3, agent mode 3, native-tools safety 2), verification 6; tokens of the exploration's agent-mode run 382,380.
- `npm run typecheck` green; `npm test` 74 files passed, 33 skipped, 2190 tests passed, 109 skipped (one earlier run under load failed `test/turn-timings.test.ts` on a timing margin, green alone and on the re-run); `node scripts/changelog.mjs check`, `test/regression/ledger.test.ts`, `test/parity-suite.test.ts` green.

## Auto Run Result

Status: done

- Summary: a turn without OpenClaw `exec` (Cursor `ask` mode) now carries, on every prompt of its process, one neutral sentence: the native shell, write and edit tools are disabled, that does not make the chat read-only, and the named OpenClaw tools in the list (`write`, `edit`, `apply_patch`, `file_write`, `workboard_create`, `workboard_comment`, `wiki_apply`) change files and records. Left out when the turn's OpenClaw tools are unavailable; a warm process re-reads the list when it had no sentence yet.
- Files: `src/core/turn-prompt.ts`, `src/core/live-entry.ts`, `src/core/execute.ts`, `src/adapters/cursor/manifest.ts`, `src/adapters/cursor/index.ts` (comment), `test/ask-tools-hint.test.ts`, `test/fixtures/host-tools-turn.ts`, `test/regression/gateway/reply-prompt.regression.test.ts`, `test/regression/ledger.toml`, `docs/providers/cursor.md`, the parity matrix, `CHANGELOG.md`, `MEMORY.md`.
- Review: self-review, then quick lens (orchestrator-triaged): 6 findings, all patched.
- Follow-up review recommended: false.
- Verification: unit and Gateway reproductions red before, green after; tiers latest green and min green except #39 (#106) before the review patches; after them typecheck, `npm test` and the #102 scenario on latest and min green.
- Residual risks: whether a real model follows the sentence is unverified (live scenario planned in ticket 4.5); the write-tool list is fixed; about 60 tokens per ask-mode prompt; a no-`exec` process without a write tool reads the tool list once per warm turn.

Follow-up after the live regression (2026-11-28): status in-review.

- Summary: the sentence alone did not make the model write (live: 0 of 12 in `ask` mode, it names Ask mode as the reason). A turn without `exec` whose list holds an OpenClaw tool that changes files now opens its process with `hostWrites`, and the Cursor adapter picks `agent` mode for it; native shell and write stay denied by the permission profile (checked live). Side questions and unreadable lists stay `ask`. The live #102 scenario now runs in the reporter's conditions (restricted profile, OpenClaw `write`/`edit`).
- Files: `src/core/turn-prompt.ts`, `src/core/live-entry.ts`, `src/core/execute.ts`, `src/core/ports.ts`, `src/core/attach-session.ts`, `src/adapters/cursor/index.ts`, `src/adapters/cursor/manifest.ts`, `src/adapters/cursor/index.test.ts`, `test/ask-tools-hint.test.ts`, `test/live/turn-meter.mjs`, `test/live-tier.test.ts`, `test/live/ask-mode-write.live.test.ts`, `test/regression/gateway/reply-prompt.regression.test.ts`, `test/regression/ledger.toml`, `docs/providers/cursor.md`, the parity matrix, `CHANGELOG.md`, `MEMORY.md`.
- Verification: see "Results of the follow-up after the live regression" above.
- Residual risks: `agent` mode costs about 3 times the tokens of an `ask` refusal per turn; on 2026.10.3 each cron run has its own process, so the one-process check runs only on 2026.10.9+; a warm process keeps the mode it opened with; `file_write` and the Workboard and wiki writers also open `agent` mode.

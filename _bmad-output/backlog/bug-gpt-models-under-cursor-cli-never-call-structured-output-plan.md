---
title: 'GPT models under cursor-cli never call structured_output'
type: 'bugfix'
ticket: '24'
created: '2026-11-09'
status: done
baseline_revision: '0f239b65675043605e33c9d4a75d2d1f0f3dde67'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A run with an `outputSchema` succeeds only if the model calls the host's `structured_output` tool. A GPT model behind `cursor-cli` answers in prose, so the run fails with `structured_output was not called`. The plugin tells the model nothing about the tool (issue #75).

**Approach:** The core adds one neutral sentence to the prompt of a process whose host tool list holds `structured_output`: the final answer goes through that tool, prose alone fails the run. No sentence without the tool. The Cursor doc says so.

## Boundaries & Constraints

**Always:** Core names no CLI (AD-2). Text only where the host's tool list for the turn holds `structured_output`.

**Never:** Change permissions, the mode choice, the `exec` and `process` serving, the shell sentence, or the continuity note. Re-prompt a turn that ended without the call. Touch `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, protected `package.json` fields.

</intent-contract>

## Implementation Notes

Oneshot: one core sentence, two fields on the live entry, one list read moved out of the exec-only branch, docs.

- Reproduction first: `test/structured-output-hint.test.ts`, run before any source change; the ticket's test failed with `expected 'do it 0' to contain 'structured_output'`, the reported reason.
- Helpers shared with ticket 23: `adapterRecording`, `warmHost`, `turnWithHostTools` moved from `test/shell-hint.test.ts` to `test/fixtures/host-tools-turn.ts` (`names` may also be a per-turn function).
- Decision: the sentence (`structuredOutputNote`, `src/core/turn-prompt.ts`, neutral text) goes in the prompt like the shell sentence: once per process, after the continuity note and the shell sentence (`LiveEntry.structuredNote` pending, `structuredSent` after). A resumed chat in a new process gets it again.
- Decision (AC 3): `openFresh` now reads the host's tool list for every turn with a target, not only with the exec marker (the shell mode still needs the marker). A warm process that has not sent the sentence reads the list again at each turn, from the target it opened with, until `structured_output` shows up, then sends it once. Cost: one local `tools/list` per such warm turn. In production the host restarts a process when the tool list changes, so this is defensive; it is what AC 3 asks for.
- `src/core/execute.test.ts`: the host stub keeps `tools/list` out of `seen` (those tests count what the CLI sent).
- Tests: criterion 1, criterion 2 (no tool, empty, unreadable list), an unflagged host, order after the shell sentence, once per process, late tool on a warm process, no CLI named, doc pin. Mutation checked: no warm re-read failed the late-tool test.
- Docs: `docs/providers/cursor.md` (OpenClaw tools), the parity matrix P7 row, `CHANGELOG.md` (#75), `MEMORY.md`.
- Live Cursor check not run: no `cursor-agent` login on this host. Whether a real GPT model follows the sentence is unverified.
- Review (step 4) not started: this session has no subagent tool. The orchestrator runs the quick review.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/structured-output-hint.test.ts -t "tells the model to answer through structured_output"` -- expected: fails first with `expected 'do it' to contain 'structured_output'`, then passes
- `npm run ci` -- expected: success

**Manual checks:**
- Live Cursor turn needs a `cursor-agent` login (or `CURSOR_API_KEY`).

## Auto Run Result

Status: built

- Summary: when the host's tool list for a turn holds `structured_output`, the first prompt of the process carries one neutral sentence telling the model to give its final answer through that tool. No sentence without the tool.
- Files: `src/core/turn-prompt.ts`, `src/core/live-entry.ts`, `src/core/execute.ts`, `src/core/execute.test.ts`, `test/structured-output-hint.test.ts`, `test/shell-hint.test.ts`, `test/fixtures/host-tools-turn.ts`, `docs/providers/cursor.md`, the parity matrix, `CHANGELOG.md`, `MEMORY.md`.
- Verification: reproduction failed first with `expected 'do it 0' to contain 'structured_output'`, then green; `npm run ci` passed. Live Cursor check not run (no login).
- Review: pending. No subagents in this session; the orchestrator runs the quick review.

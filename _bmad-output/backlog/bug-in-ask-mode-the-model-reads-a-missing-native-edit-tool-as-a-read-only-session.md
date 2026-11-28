---
id: 33
type: bug
title: "In ask mode the model reads a missing native edit tool as a read-only session"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# In ask mode the model reads a missing native edit tool as a read-only session

## Description

When the host serves no OpenClaw `exec` for a turn, the Cursor adapter runs it in Cursor's `ask` mode, which has no edit tool, and the agent's config denies the native shell and write. The OpenClaw tools offered over the MCP proxy (`write`, `edit`, `apply_patch`, `workboard_comment`, `wiki_apply`, ...) still change files and records, but the prompt says nothing about that: `shellNote` (#76) goes only to turns that serve `exec`. Asked to write a file or a Workboard comment, the model answers that the session is read-only and refuses, on consecutive turns of one process; told the exact tool, it writes fine. After the fix, every prompt of such a process says that the missing native edit tools do not make the chat read-only and names the OpenClaw tools that change things. `ask` mode itself stays (cost, see the comment above `modeFor`).

## Reproduction

1. An agent on `cursor-cli/grok-4.7` with an empty native selection (the `restricted` profile, #67): allow `Mcp(openclaw:*)`, deny Read, Shell, Write, WebFetch. The host serves no `exec`, so the adapter picks `ask`.
2. Ask the model to write a file or to comment on a Workboard card.
3. Actual: the model says the session is read-only and refuses, on turn 1 and again on turn 2 of the same process. The prompt the CLI receives holds no sentence about the native tools.
4. Expected: the prompt of every turn of that process says the native shell, write and edit are off, that this does not make the chat read-only, and which OpenClaw tools change files and records.

## Cause Hypothesis

`src/core/execute.ts` sets `shellNote` only when `exec` is in the host's tool list. An `ask`-mode turn gets no note, and Cursor's `ask` mode framing ("no edit tool") reads to the model as a read-only session.

## Acceptance Criteria

1. **The model is told the chat is not read-only**
   **Given** a turn whose host tool list has no `exec` and holds at least one OpenClaw tool that changes files or records
   **When** the plugin sends the turn to the CLI
   **Then** the prompt holds one sentence: the native shell, write and edit are disabled, that does not make the chat or the session read-only, the named OpenClaw tools present in the list stay usable, and a change is never refused because the chat is read-only
2. **On every turn of the process**
   **Given** two turns on one warm process of that kind
   **When** each is sent
   **Then** both prompts hold the sentence
3. **No sentence when nothing changes things**
   **Given** a turn whose host tool list holds `exec`, or holds no such tool, or cannot be read, or a side question
   **When** the plugin sends it
   **Then** the prompt has no such sentence (an `exec` turn keeps the #76 shell sentence)
4. **Neutral text, mode unchanged**
   **Given** the sentence
   **When** the architecture tests run
   **Then** it names no CLI (AD-2), and the turn's Cursor mode stays `ask`
5. **Tests and docs**
   **Given** the suites and the docs
   **When** they run and are read
   **Then** unit tests and a Gateway scenario (two turns of one process, mode `ask`) are red before the fix and green after; the ledger has a `[[bug]]` entry for #102 at tier `gateway` with `reproduces = true`; P8/P10, the parity matrix and `docs/providers/cursor.md` say what the prompt tells the model; `CHANGELOG.md` has a `### Fixed` line

## Boundaries

- Must not change: the mode choice (`modeFor`), the permission profiles, the `exec` and `process` serving, the #76 shell sentence, the continuity and `structured_output` notes.
- The core names no CLI (AD-2).
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- issue — https://github.com/xtimor/openclaw-all-cli/issues/102
- bug — _bmad-output/backlog/bug-a-denied-native-shell-call-tells-the-model-nothing-about-openclaw-exec.md (#76, bug 23)
- bug — _bmad-output/backlog/bug-cursor-cli-refuses-every-run-with-an-empty-native-selection.md (#67)
- change — _bmad-output/initiative-openclaw-all-cli/change-pre-release-regression-gate/change-pre-release-regression-gate.md (#102 is the second half of #76)
- code — `src/adapters/cursor/index.ts` (`modeFor`), `src/core/turn-prompt.ts`, `src/core/execute.ts`, `src/adapters/cursor/manifest.ts` (P8, P10)

## Notes

- Issue: #102 (`status:approved`).
- Backlog id 33 is set by hand: 31 and 32 are taken by #105 and #106, which are in flight.
- Live Cursor check optional; whether a real model follows the sentence is verified only by a live run.

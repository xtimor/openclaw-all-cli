---
id: 16
type: bug
title: "No per-turn ACP phase timings to find where the first-reply wait goes"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# No per-turn ACP phase timings to find where the first-reply wait goes

## Description

The owner waits 15-20 s for the first reply of a turn. The plugin logs no phase timings, so the split between process start, session setup, model selection, and the model's own thinking is inferred from file times. Each turn should log its phases, so the next measurement is exact and silence can be told from thinking.

## Reproduction

1. Run a turn on `cursor-cli/grok-4.7` (new chat, or after a model switch).
2. Look in the plugin's debug log for how long `initialize`, `session/new` or `session/load`, model selection, and the wait for the first output took.
3. Actual: no such line. Expected: one line per turn with these durations.

## Cause Hypothesis

The ACP turn path never records timestamps between its steps, and no log line reports durations.

## Acceptance Criteria

1. **One timing line per turn**
   **Given** a turn that runs to its end on the fake `cursor-agent`
   **When** the debug log is read
   **Then** one line for that turn holds the milliseconds of spawn, `initialize`, `session/new` or `session/load` (whichever ran), model selection, prompt sent, first thought delta, first text delta, and end; a phase that did not happen (for example a reused process has no spawn) is absent or marked as skipped, never zero
2. **Silence is told from thinking**
   **Given** a turn where thought deltas arrive before the first text
   **When** the line is read
   **Then** the first-thought and first-text marks differ and both are present; a turn with no thought deltas has no first-thought mark
3. **Model selection order is decided by evidence**
   **Given** the fake `cursor-agent`
   **When** model selection is tried beside `session/load`
   **Then** it moves only if a test proves the session still ends on the wanted model, in every case the current order handles (new session, loaded session, model already selected, failed load); otherwise the order stays and Notes says why
4. **Nothing else changes**
   **Given** the existing suite
   **When** `npm test` runs
   **Then** it passes, no message sent to `cursor-agent` and no text shown to the model or the user changes, and the line holds no prompt text, key, or path outside the agent's own directory
5. **Tests cover the condition fixed**
   **Given** the test suite
   **When** it runs
   **Then** tests on the fake `cursor-agent` fail without the timing line and pass with it, including a failed turn
6. **Docs and live split**
   **Given** `docs/providers/cursor.md` and `CHANGELOG.md`
   **When** they are read
   **Then** the docs name the log line and its fields, and the changelog has a line linking #44; with `CURSOR_API_KEY` set, the live split of one turn on `grok-4.7` and one on `auto` is added to the docs from the log, otherwise Notes and the pull request say the live run was not run

## Boundaries

- Not in scope: a pool of processes, a shorter system prompt, dropping the duplicate `AGENTS.md` text. Each changes what the model receives or the memory use; they are proposed from the numbers as separate issues.

## References

- parent — none
- source — GitHub issue #44
- docs — docs/providers/cursor.md, section "First reply of a new chat"

## Notes

- Issue: #44
- Open question: the owner's idea of a pool of initialized processes is built only if the measured process start is a meaningful share of the wait; on the owner's trace that is about 3 s of 20.8 s.

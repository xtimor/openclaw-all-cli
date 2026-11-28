---
id: 40
type: bug
title: "A codex model skips structured_output after the host's reply-normally line"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# A codex model skips structured_output after the host's reply-normally line

## Description

Found by the live regression tier (ticket 4.5, 2026-11-28, OpenClaw 2026.10.3, cursor-agent 2026.11.11): a collector child with an `outputSchema` on `cursor-cli/gpt-5.3-codex` ends `failed` with `structured_output was not called`, while `cursor-cli/gpt-5.5` passes. The #75 sentence ("Give your final answer by calling the OpenClaw `structured_output` tool ...") reaches the child, but it sits before the user's text, and OpenClaw closes a plugin backend's prompt with its delivery guidance as `appendContext`: "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation." The codex model follows that last line and answers `ok` in prose. After the fix, the sentence is the last part of the prompt and says a prose answer fails also where the text above says to reply normally.

## Reproduction

1. OpenClaw 2026.10.3 Gateway with the plugin, `tools.swarm.enabled`, parent `cursor-cli/auto`.
2. The parent calls `sessions_spawn` with `{task: "Reply with exactly the word: ok", model: "cursor-cli/gpt-5.3-codex", collect: true, context: "isolated", outputSchema: {reply: string}}` and `agents_wait`.
3. Actual: the child's record (`subagent_runs`) has `collectorCompletion: {status: "failed", schemaError: "structured_output was not called"}`, its reply `ok` in prose (2 of 2 runs; a third run lost its parent turn to OpenClaw's `cli_budget` compaction). The child's Cursor chat holds the #75 sentence, then the task, then the host's "reply normally" line last.
4. Expected: `status: "done"` with `structured: {reply: "ok"}`.

## Cause

`composePrompt` (`src/core/turn-prompt.ts`) orders the prompt as system block, notes (continuity, shell, `structured_output`), host `prependContext`, the user's text, host `appendContext`. The host's delivery guidance (`buildHarnessVisibleReplyGuidance`, passed as `deliveryGuidance` to `prepareCliTurnPromptContext`, which returns it as `appendContext` for a plugin backend) comes after the sentence and contradicts it.

## Acceptance Criteria

1. **The sentence ends the prompt**
   **Given** a turn whose host tool list holds `structured_output` and whose host context appends text
   **When** the plugin sends the first prompt of the process
   **Then** the prompt ends with the `structured_output` sentence, after the user's text and the appended context; the continuity and shell sentences stay before the user's text
2. **It wins over a reply-normally line**
   **Given** the sentence
   **When** it is read
   **Then** it says a prose answer fails the run also where the text above says to reply normally, and names no CLI
3. **Live**
   **Given** the live tier on OpenClaw 2026.10.3
   **When** `test/live/structured-output.live.test.ts` runs
   **Then** the codex case and the #75 gpt-5.5 case are green

## Boundaries

- Must not change: the once-per-process rule and the warm re-read of the #75 sentence, the shell and ask-mode sentences, the mode choice.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- issue — none (a follow-up of https://github.com/xtimor/openclaw-all-cli/issues/75; the ledger records it under #75)
- live tier — _bmad-output/initiative-openclaw-all-cli/epic-regression-gate/story-live-tier-in-github-actions-with-the-real-cursor-agent-plan.md
- doc — docs/providers/cursor.md, "OpenClaw tools"

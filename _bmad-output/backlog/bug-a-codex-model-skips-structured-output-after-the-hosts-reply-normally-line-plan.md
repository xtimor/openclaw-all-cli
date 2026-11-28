---
title: "A codex model skips structured_output after the host's reply-normally line"
type: 'bugfix'
ticket: '40'
created: '2026-11-28'
status: 'done'
baseline_revision: '6d512552c94ca8563a02864d4af7ad043ed82d63'
route: 'oneshot'
route_source: 'auto'
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

**Problem:** A collector child with an `outputSchema` on `cursor-cli/gpt-5.3-codex` ends `failed` with `structured_output was not called` (live tier, OpenClaw 2026.10.3, 2 of 2 runs; gpt-5.5 passes). The #75 sentence reaches the child but comes before the user's text, and OpenClaw ends a plugin backend's prompt with "For the current source conversation, reply normally in your final assistant message ..." (its delivery guidance, as `promptContext.appendContext`); the codex model obeys that last line.

**Approach:** The `structured_output` sentence becomes the last part of the prompt (a `tail` after the host's appended context) and says a prose answer fails the run also where the text above says to reply normally. Everything else about the sentence (once per process, warm re-read) stays.

## Boundaries & Constraints

**Always:** Core text names no CLI (AD-2). The continuity, shell and ask-mode sentences keep their place before the user's text.

**Never:** Re-prompt a turn that ended without the call. Change the mode choice, permissions, the shell or ask-mode sentences (ticket 33's area, another agent's), or the once-per-process rule. Touch `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, protected `package.json` fields.

</intent-contract>

## Implementation Notes

Oneshot: one argument of `composePrompt`, one sentence, the order of one array in `execute`.

- Found by the live tier (ticket 4.5's first full run; the coordinator's exploration on 2026.10.3: codex failed in 2 of 3 tries). Re-run here before any change, with the live file's model swapped to codex by a scratch patch (not committed): run 1 lost its parent turn to OpenClaw's `cli_budget` compaction ("No API key found for provider cursor-cli", the known flake), runs 2 and 3 red with `collectorCompletion: {status: "failed", schemaError: "structured_output was not called"}`, the child's reply `ok`.
- Evidence of the cause: the child's Cursor chat store (`acp-sessions/<chat>/store.db*`) holds, in order, the OpenClaw system block (with the host's own `Call structured_output with {"result": <your final result>} ...`), the continuity, shell and #75 sentences, the subagent task, and last "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation." The model's reasoning: "Confirming minimal "ok" reply". In the host (2026.10.3 dist): `buildHarnessVisibleReplyGuidance` (`source-reply-delivery-mode-*.mjs`) -> `deliveryGuidance` of `prepareCliTurnPromptContext` (`prepare.runtime-*.mjs`), returned as `appendContext` for a plugin backend (`prompt-context-*.mjs`), also for a collector child with an output schema.
- Decision: the sentence goes last (`composePrompt(..., tail)`, after `appendContext`), not into the system prompt: the system block comes first and the host's line would still be last. The added clause ("also where the text above says to reply normally") names the conflict without naming the host's wording or a CLI.
- Decision: the gateway tier is not used. A collector child needs a parent model that calls `sessions_spawn`, which the fake cursor-agent cannot; the unit test gives the turn a host-shaped `appendContext`, and the live file is the reproduction (model behavior).
- Tests: `test/structured-output-hint.test.ts` "ends the prompt with the sentence, after the host's appended reply guidance (bug 40)" and "tells the model a prose final answer fails even where the text before says to reply normally" (red before: `expected false to be true`, `expected '[OpenClaw] Give your final answer by …' to match /reply normally/`); three existing assertions on the old order updated (one test renamed to "goes after the shell sentence and after the user's text"). `test/live/structured-output.live.test.ts` gains "bug 40: a collector child with an outputSchema on cursor-cli/gpt-5.3-codex ..." beside the #75 gpt-5.5 case (one helper, both catalog rows awaited).
- Ledger: no issue of its own (an entry needs one), so the #75 entry gains the two tests with a comment.
- Files: `src/core/turn-prompt.ts`, `src/core/execute.ts`, `test/structured-output-hint.test.ts`, `test/live/structured-output.live.test.ts`, `test/regression/ledger.toml`, `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md`.

## Plan Change Log

## Review Triage Log

### 2026-11-28 — Self-review (the build session has no subagents; the coordinator runs the quick review)
- verdicts: 0 findings beyond what is recorded here.
- checked: the tail is plugin text, so it is not passed through `neutralizeBlockMarkers` (the user's text and the host's contexts still are); a warm turn that re-reads the list and finds `structured_output` sends it as tail the same way; a side question sends no sentence (no MCP target, unchanged).

### 2026-11-28 — Quick review (coordinator), patch round 1
- verdicts: 6 findings — high 0, medium 5, low 1, false 0, maybe-false 0; 3 of them (1, 3, 4) concern the live-test fixes of findings A and B and are triaged in backlog 41's plan
- findings:
  - `[medium]` `[patch]` (1) permission-routing fallback test scripted the fallback — moved to backlog 41 and patched there.
  - `[medium]` `[patch]` (2) the live-test fixes had no ticket or verification record of their own — backlog 41 (ticket and plan with the green runs); its files are out of this plan's scope.
  - `[medium]` `[patch]` (3) history-continuity (c) could leave retries without a Gateway — backlog 41.
  - `[medium]` `[patch]` (4) history-continuity (c) did not check that the Gateway and cursor-agent exited — backlog 41.
  - `[medium]` `[patch]` (5) the #75 gpt-5.5 case waited for the codex catalog row too — `beforeAll` waits for the gpt-5.5 row alone (fails without it, as before), then up to 15 s for the codex row; without it the codex case skips with the reason (`ctx.skip`), and a catalog-less 2026.11.x skips both as before.
  - `[low]` `[patch]` (6) the bug 40 unit test did not show the other sentences stay before the user's text — it now also asserts the continuity note (fresh chat, `continuity` option of `turnWithHostTools`) and the shell sentence before the user's text, and in a no-`exec` turn with an OpenClaw writer the ask-mode sentence before the user's text, the `structured_output` sentence last in both.

## Verification

**Commands:**
- `npx vitest run test/structured-output-hint.test.ts` -- red before (2 new tests), green after
- `npm run typecheck`, `npm test`, `node scripts/changelog.mjs check` -- green
- `LIVE_TESTS=... OPENCLAW_ALL_CLI_LIVE=1` live file on OpenClaw 2026.10.3 -- both cases green

**Results (2026-11-28, this container, OpenClaw 2026.10.3, cursor-agent 2026.11.11-b912975):**
- Unit: red before as above; after the fix `test/structured-output-hint.test.ts`, `test/shell-hint.test.ts`, `test/ask-tools-hint.test.ts`, `src/core/execute.test.ts`: 202 passed.
- Live, codex child, `--retry 0`, three separate runs on the fixed build: 3 of 3 green (before: 2 of 2 valid runs red).
- Live, the committed file (both cases, default retries): 2 passed, first try each.
- `npm run typecheck`: green. `npm test`: 74 files passed, 33 skipped; 2189 tests passed, 108 skipped (a first run under load beside a live run had 2 timing failures, `test/backend.test.ts` maxConcurrentTurns and `test/turn-timings.test.ts`, both green alone and in the re-run). `node scripts/changelog.mjs check`, `test/regression/ledger.test.ts`, `test/parity-suite.test.ts`: green.
- Not run: OpenClaw 2026.11.x live (this container cannot reach catalog.openclaw.ai, so no cursor-cli child can be spawned there; the file skips with that reason).

**Results after review patch round 1 (2026-11-28, on 61b5433's merged base):**
- `test/structured-output-hint.test.ts`, `test/ask-tools-hint.test.ts`, `test/shell-hint.test.ts`: 34 passed.
- Live, `test/live/structured-output.live.test.ts` (per-model catalog wait), OpenClaw 2026.10.3: 2 passed, first try each, none skipped (about 4 turns).
- `npm run typecheck`, `npm test`: green (counts in the Auto Run Result).

## Auto Run Result

Status: done

- Summary: the `structured_output` sentence now ends the prompt, after the host's appended reply guidance, and says prose fails also where the text above says to reply normally; a codex collector child answers through the tool.
- Review: self-review, then the coordinator's quick review: 6 findings, all patched (1-4 in backlog 41, 5-6 here), one commit.
- Checks after the patches: `npm run typecheck` green; `npm test` 74 files passed, 33 skipped, 2194 tests passed, 110 skipped; `node scripts/changelog.mjs check` green.
- Residual risks: another model may still skip the tool (no re-prompt, by design); the sentence's place now differs from the other notes (it follows the host's text), so a host that appends a stronger contrary line would need the same look again.

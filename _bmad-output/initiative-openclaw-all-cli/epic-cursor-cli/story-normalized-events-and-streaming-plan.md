---
title: 'Normalized events and streaming'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '6ac91f6b74c2f5095f308c010a8725089fa0c6b7'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The ACP transport forwards only `agent_message_chunk` and `agent_thought_chunk`. Cursor's tool activity (`tool_call`, `tool_call_update`) is dropped, so OpenClaw shows no tool progress, and nothing proves that text and thinking reach the channel as deltas before the turn ends. `retryable` is also not tied to whether a tool started (AD-11).

**Approach:** Map every ACP update the transport understands onto entry 1's `NormalizedEvent` language and let the core's `parseJsonlEvent` pass them to OpenClaw: `text` and `thinking` deltas, `toolStart` and `toolResult` for Cursor's native tools (display-only, AD-3), `sessionId`, one closing `result`, and `error`. Parity row P3.

## Boundaries & Constraints

**Always:** The generic ACP transport (`src/transports/acp/`) stays CLI-agnostic: it maps standard ACP update kinds (`tool_call`, `tool_call_update` with id, title, kind, status, rawInput/rawOutput, content) and any Cursor-specific naming lives in the adapter. A tool call renders once: repeated `tool_call_update` messages for one call ID produce one `toolStart` (at the first sight) and at most one `toolResult` (at `completed`/`failed`). A call still open when the turn ends gets a closing `toolResult` marked as error/aborted so nothing stays pending. Native tool events are display-only: they never change permission or tool policy. `retryable` is false once any tool call started in the turn (AD-11), true only for failures before any tool. Text deltas concatenate to the final `result.text` exactly (the transport already accumulates the reply). Do not repeat the calls that OpenClaw already shows for tools served through the MCP proxy: verify live whether an OpenClaw tool called through the proxy would be displayed twice (once by the host, once by our `toolStart`) and prevent duplicates, recording the finding.

**Never:** Buffer a turn's events until the end; invent usage (entry 9/10 decided that); change permission routing; put Cursor names into the transport.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Streamed reply | Many `agent_message_chunk` | A `text` event per chunk, in order, before the turn ends; `result.text` equals their concatenation | No error expected |
| Thinking | `agent_thought_chunk` | `thinking` deltas | No error expected |
| Tool lifecycle | `tool_call` then several `tool_call_update` to `completed` | One `toolStart`, one `toolResult` | No error expected |
| Failed tool | Update with status `failed` | `toolResult` with the error flag | No error expected |
| Tool never finishes | Turn ends or aborts with a call open | Closing `toolResult` marked aborted | No error expected |
| Update before call | `tool_call_update` for an unknown ID | Treated as a start, then as above | No error expected |
| Crash after a tool | Process dies after a tool started | `error` with `retryable: false` | Error result |
| Crash before any tool | Process dies mid-reply | `error` with `retryable: true` | Error result |
| Unknown update kind | A `session/update` kind the transport does not know | Ignored, no crash | No error expected |

</intent-contract>

## Code Map

- `src/transports/acp/session.ts` -- `sessionUpdate` handler: add `tool_call`/`tool_call_update` mapping and per-turn call bookkeeping; `deathError` retryability from "a tool started this turn"
- `src/core/ports.ts` -- `NormalizedEvent` already has `toolStart`/`toolResult`; check their field shapes against what OpenClaw's `parseJsonlEvent` needs
- `src/core/events.ts` -- `parseJsonlEvent` passes `toolStart`/`toolResult`; verify argument and result shapes (`toolCallId`, `name`, `args`, `isError`, `result`)
- `src/core/execute.ts` -- records for tool events; closing `toolResult` for open calls on turn end or abort
- `src/adapters/cursor/` -- Cursor naming of tools (reuse `permissions.ts` canonical names where it helps display)
- `test/fixtures/fake-cursor-agent.mjs` -- scripted tool calls, repeated updates, failures, a crash after a tool
- Host reference (read-only): `.spike/openclaw/node_modules/openclaw/dist/cli-backend.types-*.d.ts` (`CliBackendParsedJsonlEvent`), `parseJsonlEvent` call sites
- Facts: real `cursor-agent acp` sends `tool_call` (pending) then `tool_call_update` messages with status `in_progress`/`completed`; `kind` values include `execute`, `edit`, `search`; Cursor's permission request carries no rawInput, so entry 4 joins it from `tool_call` updates by call ID (that bookkeeping exists in `session.ts`). Real cursor-agent and `CURSOR_API_KEY` are available.

## Tasks & Acceptance

**Execution:**
- [x] `src/transports/acp/session.ts` -- map tool updates, dedupe by call ID, close open calls, retryability
- [x] `src/core/events.ts`, `execute.ts` -- verify and fix the record shapes OpenClaw needs; no event buffering
- [x] unit tests -- every matrix row with the fake agent
- [x] live test (gated) -- a real turn: text and thinking deltas arrive over time before the closing record (record the gap between the first delta and the result), a tool call renders exactly once, final text equals the concatenated deltas; a real OpenClaw run shows the tool once
- [x] docs, manifest and parity P3 -- match behavior and evidence

**Acceptance Criteria:**
- Given a turn with a long reply, when it streams, then text and thinking deltas reach the consumer before the result.
- Given a tool call with several updates, when the turn runs, then it renders once.
- Given a finished turn, then the final text equals Cursor's reply.

## Implementation Notes

Built as planned, with the two changes in the Plan Change Log. Files: `src/transports/acp/tool-calls.ts` (per-turn call table), `session.ts` (wiring, closing results, retryability), `src/adapters/cursor/tool-display.ts` (naming), `src/core/execute.ts` (`ToolLedger`: drops a second start or result for one call and closes calls left open before the result or error record), tests next to each, `test/fixtures/fake-cursor-agent.mjs` (`[[updates]]<json>` scripts any update sequence), `test/live/streaming.live.test.ts`.

- **`parseJsonlEvent`.** Already passed `toolStart`/`toolResult` unchanged; their fields (`toolCallId`, `name`, `args`, `isError`, `result`) match `CliBackendParsedJsonlEvent`. No change beyond a test.
- **Host display.** The host handles them as display events (`onDisplayToolUseStart`), dedups by call ID, and drops tool events that follow an `errorText` result, so closing results go before the closing record.
- **Real Cursor shapes** (probe, 2026.10.16): see MEMORY.md. A call is announced with a generic title and empty `rawInput` for search and MCP calls.
- **Proxy duplicate check (live, OpenClaw 2026.10.3).** `openclaw agent --local --json` reports `meta.toolSummary`. With proxied calls hidden: `calls: 1, tools: [read]`. With them shown: `calls: 2, tools: [read, mcp__openclaw__session_status]`. The host's loopback emits no display event of its own, so there is no duplicate: showing the call is the only display, and nothing is hidden. The live test asserts `calls === 2`.
- **Streaming evidence (live, real cursor-agent 2026.10.16, stub host).** 159 text and 4 thinking deltas; first delta 5.5 s after the turn started and 9.6 s before the result; final text equals the concatenation; the `read` call and the proxied `oac_echo` call each had one start and one result.
- **`retryable`.** True only for a process death before any tool call started; the host never receives it (its JSONL contract carries only `errorText`).
- **Results** over 8 000 characters are cut (display only).
- **Not handled.** ACP message chunks carry no separator between text before and after a tool call, so the reply reads `...sentence.Next`; Cursor sends it that way.
- **Verification run.** `npm run typecheck && npm run build && npx vitest run` and `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` (see the run log).

## Plan Change Log

- **Start timing.** The plan says one `toolStart` at the first sight. Cursor's first announcement has no usable title or input (and for MCP calls no server), so the transport lets the adapter wait one update (`DescribeToolCall` returns `undefined`). Without a hook, or when the adapter decides at once (read, shell), the start is at first sight. A call that never gets its next update starts when it completes or when the turn closes.
- **No hiding of proxied calls.** The plan expected the host might show them too; it does not (see the proxy duplicate check), so the hide path that was built first was removed.

## Review Triage Log

## Design Notes

Display events are the transport's job; policy is not. Keep the per-turn call table in the transport so the core only sees the clean event language.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)

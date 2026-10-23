---
title: 'WebChat shows the assistant reply twice because the result repeats the streamed text'
type: 'bugfix'
ticket: 'bug-webchat-shows-the-assistant-reply-twice'
created: '2026-10-22'
status: done
baseline_revision: 'a04525f375ed8cde646544c1bd1d36d0755cf3cf'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A webchat turn on a `cursor-cli` model is reported to show the answer twice: once as streamed text and once as a completed block, with the closing `result` event (which repeats the whole reply) blamed for the second copy.

**Approach:** Read what the host's CLI runner does with a plugin `result` record's `text` versus the streamed `text` events. If the result text is what makes the second block, stop repeating it when it was streamed (CAP-2 kept). If it is not, change nothing and document the evidence (acceptance criterion 4).

## Boundaries & Constraints

**Always:** The transcript text equals Cursor's terminal result (CAP-2); a turn with no streamed text still delivers its reply through the result.

**Never:** Work around the host (drop the reply, fake an interim record, patch host files); touch the ticket, `tickets.toml`, or protected paths; run Cursor live.

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [x] Read the host's CLI runner in the isolated OpenClaw 2026.10.3 (`createCliJsonlStreamingParser`, `projectCliBackendEvent`, `buildCliRunResult`, `runCliAgent` wrapper in `agent-runner.runtime`) -- decide whether the result text causes a second block -- AC4
- [x] Run the reproduction through a Gateway with the fake agent: a webchat-style `chat.send`, frames recorded, with the plugin as built and with a build whose result record carries `text: ""` -- evidence
- [x] `docs/providers/cursor.md`, `MEMORY.md` -- record the finding (no behavior change) -- docs rule

**Acceptance Criteria:**
- Given the reproduction on the current code, when the host's handling of the result is read and a streamed turn is run with and without the result text, then the host's frames, final payload, and transcript are the same, so the result text is not what makes a second copy (AC4; AC1 to 3 do not apply).

## Implementation Notes

Route: oneshot, no production code. This worker cannot launch subagents, so it plans and reviews in the main session (`lenses_ran` stays empty).

**Host reading (OpenClaw 2026.10.3, `dist/`):**
- A plugin line goes through `parseJsonlEvent` into `handleCustomJsonlLine` -> `projectCliBackendEvent` (`cli-live-session-registry`). A `text` event calls `onAssistantDelta` (a streamed partial). A `result` event only sets `state.output.text = event.text.trim() || state.output.text || texts || state.assistantText.trim()`: it emits nothing to the display. So the result text and the streamed text give the same final text, and an empty result text falls back to the streamed text.
- `onCompletedReply` (the "completed block", `blockReplyHandler(..., {completed: true})`) is called only in `handleParsedRecord`, for a record with `openclaw_interim_result === true`, which is the built-in (Claude stream-json) path. A plugin record never reaches it.
- `buildCliRunResult` (`cli-runner`) makes the final payloads `[{text: output.text}]`. Then `runCliAgent`'s wrapper in `agent-runner.runtime` emits one more `assistant` agent event, `{text: <final payload text>}` with no `delta`, for every CLI backend after the run ends. That snapshot is the host's, not the plugin's.

**Experiment (isolated Gateway, port 18931, copied state, packed plugin, `test/fixtures/fake-cursor-agent.mjs` as `command`, `say:` prompt split into two chunks, webchat path `chat.send`):**
- Frames, both runs: `agent assistant {text, delta}`, `chat delta` x2, then `agent assistant {text: <full>}` (the host's snapshot), `agent lifecycle end`, and one `chat final` with the full text once. Same run id on every `chat` frame.
- With the built plugin and with the built `events.js` patched so the `result` record carries `text: ""` (scratch copy only): the frame sequence and payloads were identical. The patch changes nothing the host shows.
- Transcript (`transcript_events`): one `user` and one `assistant` row per turn, text once (matches `sessions_history` having a single assistant row).

**Result:** the hypothesis does not hold. The plugin's result text is not delivered as a separate block. Dropping it when it was streamed would change nothing on the wire and would put CAP-2 on the host's fallback (`assistantText`) instead of Cursor's result, so it is not done. The Gateway sends the streamed deltas plus one `final`; if a Control UI still draws two bubbles, that is the host's handling of the delta frames, the final message, or the `assistant` snapshot, tracked upstream (openclaw/openclaw#180927). Not checked: the Control UI itself (no browser, no Cursor login). AC4's "appears once" is shown at the Gateway wire and transcript, not in a browser.

The plugin side is already pinned: `src/transports/acp/session.test.ts` ("the result text is their concatenation", CAP-2), `src/core/events.test.ts` (a result record maps to one `result` event).

## Plan Change Log

## Review Triage Log

### 2026-10-22 - Review pass (quick, in-session)
- verdicts: 3 findings - high 0, medium 0, low 2, false 1, maybe-false 0
- findings:
  - `[low]` `[reject]` AC4 says "the reply already appears once" but no browser ran: the evidence is the Gateway's `chat` frames (deltas, one `final`) and the transcript. A Control UI check needs a browser and is the owner's check outside the criteria (ticket Notes). Stated in the result.
  - `[low]` `[reject]` Omitting the result text on a streamed turn would be harmless on 2026.10.3 (identical frames) but risks CAP-2 on a host that reads `result.text` differently, and the ticket's own boundary is not to work around the host. No code change.
  - `[false]` `[reject]` The host's final `assistant` snapshot could be suppressed by the plugin: it is emitted from the final payload text of any CLI run (`runCliAgent` wrapper), and the only way to empty that payload is to lose the reply.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own read of the host code, the frames, and the plan's criteria (`lenses_ran` empty). Plan lens (self): scope is the ticket file only; no protected file touched; the only repo changes are docs, `MEMORY.md`, and this plan.

## Verification

**Commands:**
- `npm run ci` -- expected: passes

## Auto Run Result

**Summary:** No plugin change. The host does not turn the plugin's `result` text into a second block: a `result` event only sets the turn's final text (falling back to the streamed text when empty), and the "completed block" path (`onCompletedReply`) runs only for the built-in Claude records flagged `openclaw_interim_result`. The one extra copy in the host's event stream is its own final `assistant` snapshot, emitted for every CLI run from the final payload text. Through a webchat-style `chat.send` on an isolated Gateway (fake agent), the frames and transcript were identical with the real result text and with a build whose result text was empty; the Gateway sent the streamed deltas and one `chat final`, and the transcript holds one assistant row. So the cause in the ticket does not hold and nothing in the plugin can remove a host-side duplicate without dropping the reply (CAP-2). Acceptance criterion 4 applies; 1 to 3 do not.

**Files changed:**
- `docs/providers/cursor.md` - Streaming section: what the host does with the closing record; Known limits: a possible double bubble is host-side.
- `MEMORY.md` - the finding and the probe recipe.
- This plan.

**Review:** patches applied 0; deferred 0; rejected 2 low and 1 false, reasons in the triage log. Independent Quick lens not run (no subagent available).

**Verification:** `npm run ci` passed. Isolated OpenClaw 2026.10.3, fake agent, `chat.send` frames and the transcript, with and without the result text. Live Cursor and a browser check not run: the owner sends one live webchat turn and looks for one bubble; if two appear, the upstream issue (openclaw/openclaw#180927) is the place.

**Residual risks:** The Control UI was not driven. A different host version may change what it does with the closing record: `test/host-contract.test.ts` does not cover it.

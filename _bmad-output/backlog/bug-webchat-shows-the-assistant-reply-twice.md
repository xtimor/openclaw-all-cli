---
id: 4
type: bug
title: "WebChat shows the assistant reply twice because the result repeats the streamed text"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# WebChat shows the assistant reply twice because the result repeats the streamed text

## Description

With block streaming off, a short webchat turn on a `cursor-cli` model shows the answer twice: once from the streamed text and once as a completed block. It should show one copy.

## Reproduction

1. Webchat session on a `cursor-cli` model, `agents.defaults.blockStreamingDefault` unset.
2. Send a short message.
3. Actual: the final answer appears twice. Expected: one bubble. `sessions_history` holds a single assistant row.

## Cause Hypothesis

The session yields each text chunk and then a closing `result` event whose text is the whole reply. The host shows the chunks as partial replies and the result as a completed block. The host half is tracked upstream (openclaw/openclaw#180927).

## Acceptance Criteria

1. **The expected behavior holds**
   **Given** a turn whose reply was already streamed as text events
   **When** the closing event is produced
   **Then** the host receives the full reply once as streamed text and the closing event does not repeat it as a separate block
2. **The full reply stays available**
   **Given** the same turn
   **When** the transcript text is read
   **Then** it equals Cursor's terminal result (CAP-2)
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers a streamed turn, and one covers a turn with no streamed text
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the reply already appears once, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-2

## Notes

- Issue: #13
- Open question: what the host reads from the result record (transcript text or completed block); the build reads the host's CLI runner in the isolated OpenClaw and records it.
- Check outside the criteria: the owner sends one live webchat turn and sees one bubble.

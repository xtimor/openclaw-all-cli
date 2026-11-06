---
id: 19
type: bug
title: "cursor-cli refuses every run with an empty native tool selection, though Cursor can switch its native read, grep and glob off"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# cursor-cli refuses every run with an empty native tool selection, though Cursor can switch its native read, grep and glob off

## Description

A `cursor-cli` run whose native tool selection is empty is refused before Cursor starts, with `cursor-cli keeps native read, grep, glob on in every turn and cannot switch them off for this run`. The reason is wrong: Cursor's own permission file can close those three tools, so the run can be served with them closed and the model can reach files through OpenClaw's own tools, where the run's boundary applies.

## Reproduction

1. Bind an agent to a `cursor-cli` model with `tools.fs.workspaceOnly: true` (the host asks for `native: []` for such a run), or any run whose native selection is empty.
2. Start a turn.
3. Actual: the run is refused before a process starts, and the host treats it as a model failure (`model fallback decision: decision=candidate_failed`), so a fallback answers or the turn has no model. Expected: the turn runs with Cursor's native read, grep and glob closed.

## Cause Hypothesis

The adapter's static permissions only ever allow `Read(**)`, and the core reads the native tools the adapter keeps open as the ones it cannot switch off. Nothing in the adapter offers a permission set that closes them, so the core has no way to serve such a selection.

## Acceptance Criteria

1. **A run with an empty native selection is served**
   **Given** a `cursor-cli` run whose native tool selection is empty
   **When** the turn starts
   **Then** Cursor runs with its native read, grep and glob closed, the model reaches files through OpenClaw's own tools under the run's boundary, and the turn is not refused
2. **A selection the plugin cannot serve is still refused**
   **Given** a native tool selection that takes only part of read, grep and glob
   **When** the turn starts
   **Then** the run is refused before a process starts, and the message names the native tools that stayed on
3. **A profile never serves another profile's turn**
   **Given** a warm process started under one permission profile
   **When** a turn under the other profile arrives
   **Then** the process is not reused, because the permission file is read once per process
4. **A chat is resumable under either profile**
   **Given** a chat created under one permission profile
   **When** the same chat is continued under the other profile
   **Then** the chat resumes, because the profile's config directory points at the default profile's chat store
5. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails without the change and passes with it covers the profile selection, the refusal, the reuse key, and the shared chat store

## References

- parent — none
- source — GitHub issue #67

## Notes

- Issue: #67
- Measured live against `cursor-agent` 2026.10.22 over ACP: a `deny: ["Read(*)"]` takes native read, grep and glob down together (one rule governs the three), in ask mode and in agent mode, and Cursor's MCP path stays open under that deny.
- Cursor rejects an incomplete `cli-config.json`: it writes a `.bad` copy and falls back to the default configuration, where `deny` is empty. Accepted shapes are `{version, permissions}` and `{permissions}`; `selectedModel` without `parameters` is rejected.
- The permission file is read once per process, so the profile is part of the process identity.
- A live check in the isolated OpenClaw with a real `cursor-agent` login is the owner's check outside the criteria.

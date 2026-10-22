---
id: 3
type: bug
title: "All cursor-cli models report the same 128k context window"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# All cursor-cli models report the same 128k context window

## Description

Every `cursor-cli/*` row shows 128k in the picker, the host default, because the catalog row carries no window. OpenClaw sizes compaction by it, so a wrong value compacts too early (and drops the Cursor chat binding) or builds turns that are too large.

## Reproduction

1. Enable the plugin with a working `cursor-agent` login.
2. Run `openclaw models list --all` and read the window of any `cursor-cli/*` row.
3. Actual: every row shows 128k. Expected: each row shows the window of its model.

## Cause Hypothesis

The catalog row builder returns no window or limit field, so the host falls back to its default. Cursor model ids carry a `context=` parameter that may hold the value.

## Acceptance Criteria

1. **The expected behavior holds**
   **Given** a catalog with rows whose Cursor id has a `context=` parameter and rows without one
   **When** the rows are built
   **Then** a row with the parameter carries that window, a row of a known model family without it carries the family's window, and a row of an unknown model carries none
2. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers rows with and without a `context` parameter and an unknown id
3. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the windows already differ per model, with the evidence recorded in Notes — this supersedes 1 and 2

## References

- parent — none
- docs — docs/providers/cursor.md
- matrix — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md, P14

## Notes

- Issue: #12
- Check outside the criteria: the owner runs `openclaw models list --all` on a gateway with a login and sees differing windows.

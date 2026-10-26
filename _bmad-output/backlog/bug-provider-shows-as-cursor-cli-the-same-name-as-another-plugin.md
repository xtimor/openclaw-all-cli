---
id: 11
type: bug
title: "Provider shows as Cursor-CLI, the same name as another plugin"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# Provider shows as Cursor-CLI, the same name as another plugin

## Description

The provider appears as "Cursor-CLI", like the separate plugin `@jeehou/openclaw-cursor-cli`, and users mix them up. It should read "OAC / Cursor-CLI". Only display names change.

## Reproduction

1. Install the plugin 0.1.3.
2. Look at the provider in the Control UI and in the CLI lists.
3. Actual: "Cursor-CLI". Expected: "OAC / Cursor-CLI".

## Cause Hypothesis

The provider label and the manifest labels (`providerAuthChoices[].groupLabel`, `uiHints` label) carry the old name.

## Acceptance Criteria

1. **The provider shows the new name**
   **Given** the plugin loaded
   **When** the provider label, `providerAuthChoices` group label, and `uiHints` label are read
   **Then** each is "OAC / Cursor-CLI", and the provider id `cursor-cli`, the model refs, and the plugin name are unchanged
2. **Tests cover the label and the id**
   **Given** the test suite
   **When** it runs
   **Then** tests assert the new label and the unchanged id, and `npm test` passes
3. **Docs and changelog follow**
   **Given** the change
   **When** a user reads `docs/` and `CHANGELOG.md`
   **Then** they name the provider "OAC / Cursor-CLI" and the changelog has a line linking #36

## References

- parent — none
- source — GitHub issue #36

## Notes

- Issue: #36
- Live check of `plugins.list` / `models list` names is not run without a Cursor login.

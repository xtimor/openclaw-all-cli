---
id: 1
type: story
title: "Publish reasoning support and an effort choice for cursor-cli models"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
---

# Publish reasoning support and an effort choice for cursor-cli models

## Description

Every `cursor-cli/*` catalog row is published with `reasoning: false`, so the composer's Effort control is dead. After this, a row is `reasoning: true` when Cursor's model listing shows the model has an effort setting, and OpenClaw's effort level selects the matching Cursor model variant. Where Cursor offers no way to set effort, the limit is documented.

## Acceptance Criteria

1. **Reasoning follows the model**
   **Given** a Cursor model listing with a model that has `reasoning_effort` variants and one that has none
   **When** the catalog is built
   **Then** the first row is published with `reasoning: true` and the second with `reasoning: false`
2. **Effort selects a variant**
   **Given** a `reasoning: true` row with several effort variants
   **When** a turn runs with an OpenClaw effort level
   **Then** the Cursor model id used for the session is the variant that matches that level, and a level with no matching variant uses the row's default
3. **The limit is documented**
   **Given** the docs
   **When** a reader looks up effort for Cursor
   **Then** `docs/providers/cursor.md` and the `claude-cli-parity.md` row say how effort maps and what Cursor does not offer

## Boundaries

- Must not change: model ids already published; turns for rows without effort variants.

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-1
- docs — docs/providers/cursor.md

## Notes

- Issue: #8
- Assumption: a live check of effort over `cursor-agent acp` is not run in the unattended build; the mapping uses the variant ids in Cursor's listing.
- Check outside the criteria: the owner runs one live `cursor-cli` turn per effort level.

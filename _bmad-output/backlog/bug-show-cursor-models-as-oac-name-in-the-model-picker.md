---
id: 12
type: bug
title: "Show Cursor models as OAC / name in the model picker"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# Show Cursor models as OAC / name in the model picker

## Description

Cursor models from this plugin look like any other provider's models in the picker. Every catalog row name gets the prefix "OAC / ", for example "OAC / GPT-5.3 Codex", including the default row. Ids, refs, aliases, and configs stay.

## Reproduction

1. Open the model picker with the plugin loaded.
2. Actual: names like "GPT-5.3 Codex". Expected: "OAC / GPT-5.3 Codex".

## Cause Hypothesis

The catalog builder uses the Cursor display name unchanged.

## Acceptance Criteria

1. **Names carry the prefix**
   **Given** the catalog built from the Cursor model list
   **When** its rows are read
   **Then** every row name, the default row included, starts with "OAC / " and every `id`, ref, and alias is unchanged
2. **Tests cover it**
   **Given** `src/core/catalog.test.ts`
   **When** it runs
   **Then** it asserts the prefixed names and unchanged ids, and `npm test` passes
3. **Docs and changelog follow**
   **Given** the change
   **When** a user reads `docs/` and `CHANGELOG.md`
   **Then** both describe the prefix, with a changelog line linking #37

## References

- parent — none
- source — GitHub issue #37

## Notes

- Issue: #37
- Pairs with ticket 11 (same naming scheme).

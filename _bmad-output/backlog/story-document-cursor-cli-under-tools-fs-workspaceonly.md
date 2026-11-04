---
id: 19
type: story
title: "Document cursor-cli under tools.fs.workspaceOnly"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
---

# Document cursor-cli under tools.fs.workspaceOnly

## Description

An agent bound to `cursor-cli` with `tools.fs.workspaceOnly: true` is unenforced on OpenClaw 2026.10.3 and refused at preflight on 2026.10.9, and no user doc says so. After this, `docs/providers/cursor.md` has a short section on it, `docs/setup.md` Troubleshooting links to it, and `CHANGELOG.md` has one line. Docs only; no plugin behavior changes.

## Acceptance Criteria

1. **The behavior is stated**
   **Given** `docs/providers/cursor.md`
   **When** its `workspaceOnly` section is read
   **Then** it says `cursor-cli` keeps native `read`, `grep` and `glob` on in every turn and cannot honour `tools.fs.workspaceOnly`
   **And** it says the setting is unenforced on OpenClaw 2026.10.3 and earlier, and refused at preflight on 2026.10.9 and later releases that carry the host-side handling
2. **The advice is given**
   **Given** the same section
   **When** an operator reads what to do
   **Then** it says: do not combine `workspaceOnly: true` with a `cursor-cli` primary; run an agent that needs that boundary on the embedded runtime; or accept the refusal and configure a fallback model on purpose, knowing the fallback answers without the CLI backend
3. **The failure mode is named**
   **Given** the same section
   **When** it describes the refusal
   **Then** it says the refusal appears as a model failure in fallback decisions, not as a configuration error at `config set` time
4. **It is reachable and logged**
   **Given** `docs/setup.md` and `CHANGELOG.md`
   **When** they are read
   **Then** Troubleshooting links to the section, and `## Unreleased` has one plain line with the link to issue #65
5. **Checks pass**
   **Given** the branch
   **When** `npm test` and `npm run typecheck` run
   **Then** both pass, and `grep -n workspaceOnly docs/providers/cursor.md` finds the section

## Boundaries

- Must not change: plugin code and the preflight message.
- Word it as the current behavior; issue #67 changes it later with permission profiles.

## References

- parent — none
- docs — docs/providers/cursor.md
- docs — docs/setup.md

## Notes

- Issue: #65
- Decision: the preflight message is not changed; it cannot tell the cause (an empty native selection also comes from other settings).
- Assumption: the release that first carries the host-side handling is not identifiable offline; the doc says "2026.10.9 is confirmed refusing" and does not name an earlier one.

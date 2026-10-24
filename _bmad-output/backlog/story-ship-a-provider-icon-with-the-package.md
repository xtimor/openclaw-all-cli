---
id: 5
type: story
title: "Ship a provider icon with the package"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
---

# Ship a provider icon with the package

## Description

In the model picker and on the provider card, `cursor-cli` shows a generic letter avatar. After this, the package ships its own neutral PNG icon (a terminal with a cursor, not Cursor's brand mark) at `assets/icon.png`, the host picks it up from its fixed icon path, and the published package contains it.

## Acceptance Criteria

1. **The icon file exists**
   **Given** the repository
   **When** `assets/icon.png` is read
   **Then** it is a valid, small square PNG that is not Cursor's brand mark
2. **The host reads it**
   **Given** the plugin loaded in the isolated OpenClaw
   **When** `openclaw plugins inspect` runs for the plugin
   **Then** it reports `hasIcon: true`
3. **The package publishes it**
   **Given** `npm pack --dry-run`
   **When** the file list is read
   **Then** it lists `assets/icon.png`, `package.json` `files` has that exact path (no directory, no glob), and `test/package-contents.test.ts` expects it
4. **Existing package entries stay**
   **Given** `package.json` `files`
   **When** it is compared with `main`
   **Then** `dist` and `openclaw.plugin.json` are unchanged

## Boundaries

- Must not change: any other `package.json` field, and any protected file other than the one allowed `files` addition.
- The icon follows the adapter later; this ticket ships the one icon for `cursor-cli`.

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-10
- docs — docs/issues.md

## Notes

- Issue: #9
- Decision: owner, 2026-10-23: a neutral own icon, no Cursor brand mark.
- Decision: owner, 2026-10-24: ship it as `assets/icon.png` (PNG); OpenClaw 2026.10.3 reads a plugin icon only from that fixed path and has no manifest key.
- Check outside the criteria: the owner sees the icon in the picker on a real gateway.

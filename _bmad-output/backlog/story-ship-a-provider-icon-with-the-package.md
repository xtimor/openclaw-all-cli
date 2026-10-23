---
id: 7
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

The model picker and provider card draw `cursor-cli` with a generic letter avatar because the package ships no icon. The package should ship our own neutral SVG, a terminal with a cursor and not Cursor's mark, at `assets/cursor-cli.svg`, and the manifest should reference it the way OpenClaw 2026.10.3 reads plugin icons.

## Acceptance Criteria

1. **The icon ships**
   **Given** the package
   **When** `npm pack --dry-run` runs
   **Then** it lists `assets/cursor-cli.svg`, which is a valid SVG that is not Cursor's mark
2. **The host sees it**
   **Given** the plugin installed in the isolated OpenClaw
   **When** `openclaw plugins inspect` runs
   **Then** it reports `hasIcon: true`; the manifest key is the one the installed host reads, confirmed in `.spike/openclaw`; if the host cannot be run, this is recorded as not run
3. **The path is pinned**
   **Given** `package.json` `files`
   **When** the change is done
   **Then** the exact path `assets/cursor-cli.svg` is added as a new entry, no existing entry is changed or removed, and `test/package-contents.test.ts` expects the path
4. **Checks pass**
   **Given** `npm run ci`
   **When** it runs
   **Then** it passes

## Boundaries

- Must not change: existing `files` entries, `name`, `scripts`, `publishConfig`, and the manifest fields other than the icon.

## References

- parent — none
- package test — test/package-contents.test.ts

## Notes

- Issue: #9
- Decision: own neutral icon, no Cursor brand mark, so no brand terms apply (owner, 2026-10-23).
- Decision: the exact path in `files` is allowed by the approved draft (docs/agents/implement.md).
- Open question: the manifest key for the icon; the build reads the host and records it.

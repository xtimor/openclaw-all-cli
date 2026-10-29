---
id: 18
type: bug
title: "The model setup page shows no plugin icon"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# The model setup page shows no plugin icon

## Description

The OAC / Cursor-CLI choices on the model setup page of the Control UI show a letter avatar, not the plugin icon. The host reads the `icon` of each `providerAuthChoices` entry (an HTTPS URL) for non-workspace plugins, and the manifest sets none. The icon should show there.

## Reproduction

1. Install the plugin in OpenClaw 2026.10.3 and open the model setup page.
2. Actual: the OAC / Cursor-CLI choices have no plugin art. Expected: `assets/icon.png`.
3. In `openclaw.plugin.json` neither `providerAuthChoices` entry has an `icon`.

## Cause Hypothesis

The manifest lacks the choice `icon`. The host's setup catalog allow-lists the `icon` of every non-workspace plugin's choices (`resolveManagedSetupCatalogIconUrl`), so a raw GitHub URL of the packaged file should be honored. The chat picker, the provider cards, and the Connect dialog use bundled brand art by provider id and stay unchanged (upstream: openclaw/openclaw#186945).

## Acceptance Criteria

1. **The setup page icon is set**
   **Given** `openclaw.plugin.json`
   **When** read
   **Then** both `providerAuthChoices` entries carry `"icon": "https://raw.githubusercontent.com/xtimor/openclaw-all-cli/main/assets/icon.png"`; the provider id `cursor-cli`, the choice ids, and every model ref are unchanged
2. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test in `test/provider-auth.test.ts` fails without the icons and passes with them: every choice has an HTTPS `icon` that ends in the path of the packaged `assets/icon.png`
3. **Docs say where the icon shows**
   **Given** `docs/providers/cursor.md`
   **When** read
   **Then** it lists the Plugins page, the command palette, and the setup page as showing the icon, and the chat picker, provider cards, and Connect dialog as not showing it until OpenClaw changes, with a link to openclaw/openclaw#186945
4. **Changelog and memory**
   **Given** `CHANGELOG.md` and `MEMORY.md`
   **When** read
   **Then** `Unreleased` has a plain line with the #45 link, and the MEMORY.md line that says the choice `icon` is honored only from ClawHub metadata is corrected
5. **Checks**
   **Given** the branch
   **When** `npm test` runs
   **Then** it passes; the live Gateway and browser check of the setup page is run if a Gateway is available, else recorded as not run

## References

- parent — none
- issue — #45
- upstream — https://github.com/openclaw/openclaw/issues/186945
- docs — docs/providers/cursor.md

## Notes

- Issue: #45
- Decision: approved scope is the owner's approval of #45 (2026-10-28); files are `openclaw.plugin.json`, `test/provider-auth.test.ts`, `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md`.

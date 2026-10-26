---
id: 10
type: bug
title: "The provider icon is shown nowhere in the Control UI"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# The provider icon is shown nowhere in the Control UI

## Description

The plugin ships `assets/icon.png`, but no icon shows in the model list or on the plugin and provider cards. The icon should show wherever the host draws a plugin icon; where the host never does, that is documented.

## Reproduction

1. Install the plugin in the isolated OpenClaw 2026.10.3 (`.spike`).
2. Open the Control UI: plugin page, plugin card, Connect provider list, provider card, model picker.
3. Actual: no icon anywhere. Expected: the icon wherever the host draws a plugin icon.

## Cause Hypothesis

The host may draw plugin icons only on some pages (by plugin id, `hasIcon`), or the file path, format, size, or manifest field may not match what the host reads.

## Acceptance Criteria

1. **The icon shows where the host draws one**
   **Given** the plugin installed in the isolated OpenClaw
   **When** a headless browser opens the plugin page, plugin card, Connect provider list, provider card, and model picker
   **Then** the icon appears in each place the host draws a plugin icon, and the notes record which places those are
2. **Host limits are documented**
   **Given** a place where the host never draws a plugin icon
   **When** a user reads `docs/` and `CHANGELOG.md`
   **Then** both say so and name the OpenClaw code that decides it
3. **Tests pass**
   **Given** any change to the package contents or manifest
   **When** `npm test` runs
   **Then** it passes, with a test for each change

## References

- parent — none
- source — GitHub issue #35

## Notes

- Issue: #35
- Live UI check needs a headless browser against the isolated OpenClaw; if it cannot run, record it as not run and decide from the host bundle.

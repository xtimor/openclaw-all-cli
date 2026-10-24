---
id: 7
type: bug
title: "Explain a cursor-cli backend id clash with the older plugin"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# Explain a cursor-cli backend id clash with the older plugin

## Description

At gateway start the log shows `cli backend already registered: cursor-cli (cursor-cli)` as an ERROR attributed to this plugin. The first owner of the id is the older `cursor-cli` plugin (`@jeehou/openclaw-cursor-cli`) still on disk, so this plugin is the second registrant. After this, the setup docs say the older plugin must be removed, not only disabled, and name this log line.

## Reproduction

1. Install both `@jeehou/openclaw-cursor-cli` (plugin id `cursor-cli`) and this plugin; disable the older one in config but leave it on disk.
2. Start the gateway.
3. Actual: the ERROR line above. Expected: one registration of `cursor-cli`, or a message that names both owners.

## Cause Hypothesis

`registerAdapters` registers once per adapter and there is one adapter, so this plugin does not register twice. The host reports the clash with the older plugin that registered the id first. Not reproduced here (needs both plugins).

## Acceptance Criteria

1. **The docs name the clash**
   **Given** `docs/setup.md`
   **When** a reader migrates from the older plugin
   **Then** it says to remove the older plugin, not only disable it, and quotes the log line and its meaning
2. **Any warning is tested**
   **Given** a plugin-side warning when config shows the older plugin installed (only if the config exposes this reliably)
   **When** the test suite runs
   **Then** a unit test covers the warning and its absence, or the plan records why no warning is added
3. **Existing registration stays**
   **Given** a start without the older plugin
   **When** the adapters register
   **Then** `cursor-cli` is registered exactly once and `npm run ci` passes

## Boundaries

- Must not change: the backend id `cursor-cli` and the registration of the adapter.

## References

- parent — none
- docs — docs/setup.md

## Notes

- Issue: #14
- Check outside the criteria: none beyond the docs read by the owner.

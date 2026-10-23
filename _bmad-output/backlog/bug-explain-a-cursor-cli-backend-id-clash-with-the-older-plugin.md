---
id: 5
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

On gateway start the host logs an ERROR `cli backend already registered: cursor-cli (cursor-cli)` naming this plugin. The cause is the older `cursor-cli` plugin (`@jeehou/openclaw-cursor-cli`, plugin id `cursor-cli`) still on disk: it registered the id first and this plugin is the second owner. A user cannot tell this from the log or the docs. The docs should name the clash, and the plugin may warn when the config shows the older plugin.

## Reproduction

1. OpenClaw 2026.10.3 with this plugin enabled and the older `cursor-cli` plugin disabled in `plugins.entries` but still installed on disk.
2. Start the gateway and read its log.
3. Actual: `[plugins] cli backend already registered: cursor-cli (cursor-cli) (plugin=openclaw-all-cli, ...)`. Expected: `docs/setup.md` explains this line and says to remove the older plugin, not only disable it.

## Cause Hypothesis

This plugin registers `cursor-cli` once (one adapter). The host message shows the existing owner is plugin id `cursor-cli`, so the first owner is the older plugin. Not a double registration by this plugin.

## Acceptance Criteria

1. **The docs name the clash**
   **Given** `docs/setup.md`
   **When** a user reads it
   **Then** it names the older plugin and its id, quotes the `cli backend already registered: cursor-cli` log line, and says the older plugin must be removed, not only disabled
2. **A warning, if added, is accurate and tested**
   **Given** a config that lists the older plugin as installed
   **When** this plugin registers its backend
   **Then** it logs one warning pointing at the setup doc, and logs none when the older plugin is absent; if the host config offers no reliable way to tell, no warning is added and Notes records why
3. **Registration stays as it is**
   **Given** the existing tests
   **When** they run
   **Then** `cursor-cli` is still registered once and all pass
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** run against the current code and docs
   **Then** the docs already explain the clash, with the evidence in Notes; this supersedes 1 to 3

## Boundaries

- Must not change: the backend id, the registration call, and the model list.

## References

- parent — none
- setup doc — docs/setup.md

## Notes

- Issue: #14
- Decision: the warning is optional; the docs change is required.
- Check outside the criteria: the owner confirms the next gateway start with the older plugin removed has no `already registered` line.

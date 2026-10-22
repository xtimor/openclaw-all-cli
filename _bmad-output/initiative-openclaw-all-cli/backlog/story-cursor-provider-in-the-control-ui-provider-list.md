---
id: 2
type: story
title: "Cursor provider in the Control UI provider list"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
---

# Cursor provider in the Control UI provider list

## Description

The `cursor-cli` provider publishes no auth method, so the Control UI "Connect a provider" list does not offer it. After this, the provider declares a "Use the cursor-agent login" method that reports the login state, and an optional `CURSOR_API_KEY` method that stores the key in the plugin config. The setup docs name the `modelPolicy.allow` requirement.

## Acceptance Criteria

1. **The provider is listed with a login method**
   **Given** the plugin loaded in the isolated OpenClaw
   **When** the provider's auth methods are read
   **Then** the list holds a zero-field "Use the cursor-agent login" method that runs the existing login probe and reports logged in or not logged in
2. **The API key method stores the key**
   **Given** the optional `CURSOR_API_KEY` method
   **When** a key is entered
   **Then** it is written to the plugin config `env` for `cursor-cli` and read back by the usage code, and it is never logged
3. **The allow-list pitfall is documented**
   **Given** `docs/setup.md`
   **When** a reader sets up a gateway with an explicit `agents.defaults.modelPolicy.allow`
   **Then** the doc says `cursor-cli/*` must be allowed and what the symptom is when it is not

## Boundaries

- Must not change: the native login path (`prepareSyntheticAuth`) and the published model catalog.

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-1, CAP-10
- docs — docs/setup.md

## Notes

- Issue: #10
- Assumption: OpenClaw 2026.10.3 lists a provider with a zero-field method; the build confirms it in the isolated OpenClaw and records the finding.
- Check outside the criteria: the owner opens the Control UI on a real gateway and sees the provider.

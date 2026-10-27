---
id: 14
type: bug
title: "Provider card reads Not configured although the cursor-agent login works"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P3
---

# Provider card reads Not configured although the cursor-agent login works

## Description

The Control UI provider card shows "Not configured" with a Connect button although every model works through the local CLI login. Find an honest stop-gap from the plugin side, or document the limit.

## Reproduction

1. Install the plugin with a valid `cursor-agent` login; models answer.
2. Open Control UI, Model Providers, the Cursor card.
3. Actual: "Not configured" and a Connect button. Expected: the card reflects the CLI login.

## Cause Hypothesis

Core builds the credential summary from persisted profiles and config or env keys only, and honors manifest `syntheticAuthRefs` and `nonSecretAuthMarkers` only for bundled plugins (reported upstream as openclaw/openclaw#184700).

## Acceptance Criteria

1. **A stop-gap, or a documented limit**
   **Given** the host bundle of 2026.10.3
   **When** the card's possible states and the plugin's levers (labels, `uiHints`, description, `providerAuthChoices` hints) are checked
   **Then** either a stop-gap is built that passes: working login shows no "Not configured", broken login still reports unauthorized, nothing key-like in config; or `docs/setup.md` and `CHANGELOG.md` document the limit and the upstream issue
2. **Tests pass**
   **Given** any change
   **When** `npm test` runs
   **Then** it passes, with tests for each change

## References

- parent — none
- source — GitHub issue #39

## Notes

- Issue: #39
- Never write a placeholder key to config.

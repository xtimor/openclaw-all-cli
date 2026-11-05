---
id: 21
type: story
title: "Verify the cursor-cli provider card on current OpenClaw latest"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
---

# Verify the cursor-cli provider card on current OpenClaw latest

## Description

Two display points of the Control UI Model Providers card for `cursor-cli` are unmeasured on a current OpenClaw: whether Connect provider is still offered for a provider with `auth: []`, and what the card shows after the CLI login is lost while the Gateway runs. Measure both in an isolated stand and record the result.

## Acceptance Criteria

1. **Three card states are recorded**
   **Given** an isolated stand on current npm `latest` OpenClaw with this plugin installed from a packed tarball
   **When** the card is read (a) with a valid `cursor-agent` login, (b) after the CLI login is moved aside with the Gateway running and the page reloaded, (c) after the login is restored
   **Then** for each state the credential line (verbatim) and the presence of Connect provider are recorded, and for (c) whether the card recovers alone or only after a restart
2. **Models are checked per state**
   **Given** the three states
   **When** the provider's models are listed and a turn is tried
   **Then** each state records whether the models stay listed and runnable
3. **A control exists**
   **Given** a provider that is genuinely not configured
   **When** its card is read
   **Then** its credential line and button state are recorded
4. **The record is in the repo**
   **Given** the measurements
   **When** the ticket closes
   **Then** `docs/` holds the findings (OpenClaw version, date, states, control); `docs/setup.md` and `docs/providers/cursor.md` change only where a finding changes a stated limit
5. **A check that cannot run is said so**
   **Given** the host lacks a browser, a `cursor-agent` login, or network reach
   **When** a state cannot be measured
   **Then** it is recorded as not run with the reason, and no value is invented
6. **Tests pass**
   **Given** the change
   **When** `npm run ci` runs
   **Then** it passes

## Boundaries

- Must not change: plugin code, the declared auth markers, or any file under `.github/`, `scripts/`, `_bmad/`.
- The marker gate (`nonSecretAuthMarkers` only for bundled plugins) is already reported upstream; it is not re-measured.

## References

- parent — none
- source — GitHub issue #69
- docs — docs/providers/cursor.md, docs/setup.md

## Notes

- Issue: #69
- Priority: p3. Size: M.
- The upstream comment draft for openclaw/openclaw#184700 goes in the issue comment, not in the repo. Screenshots stay out of the repo; the findings text is committed.

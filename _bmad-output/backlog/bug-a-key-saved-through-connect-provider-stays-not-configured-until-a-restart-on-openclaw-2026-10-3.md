---
id: 31
type: bug
title: "A key saved through Connect provider stays Not configured until a restart on OpenClaw 2026.10.3"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# A key saved through Connect provider stays Not configured until a restart on OpenClaw 2026.10.3

## Description

On OpenClaw 2026.10.3, a Gateway that loaded the plugin at start, with `cursor-cli` as the configured
model, on a state whose auth store held no profile yet, never shows a key saved through the Control
UI's Connect provider (`models.authLogin`, the API key method). `models.authStatus` lists no
`cursor-cli` profile, so the provider card stays "Not configured" until the Gateway restarts. The
profile is there: `openclaw models auth list` shows it, and `models.probe` answers `ok` in the same
Gateway. Without `cursor-cli` as the configured model the profile shows at once, and OpenClaw
2026.11.10 is fine.

## Reproduction

1. Fresh state on OpenClaw 2026.10.3 (no auth profile, no auth store yet), the packed plugin installed,
   `agents.defaults.model.primary` = `cursor-cli/auto`, a logged-in `cursor-agent`.
2. Start the Gateway; wait until the catalog lists the `cursor-cli` models.
3. Save a key through Connect provider (`models.authLogin`, option `openclaw-all-cli/cursor-cli-api-key`).
4. Actual: the login ends `done` with "Auth profile: cursor-cli:default", but `models.authStatus` lists
   no `cursor-cli` profile 30 s later.
5. Expected: `models.authStatus` lists `cursor-cli:default` (`api_key`) right after the save.

Red on `main` today: the `#39` case of `test/regression/gateway/auth-setup.regression.test.ts` on
2026.10.3 (`scripts/regression.sh gateway`), and the `#39` card check of
`test/regression/ui/provider-card.regression.test.ts` (`scripts/regression.sh ui`).

## Cause Hypothesis

Suspected: `src/core/auth-store.ts` reads the store at catalog time with the deprecated
`ensureAuthProfileStore(dir, { readOnly: true, ... })` on 2026.10.3, which may leave an empty
snapshot in the host's in-process cache. Unverified; confirm against the installed OpenClaw 2026.10.3
sources (`.regression/openclaw-2026.10.3/openclaw/node_modules/openclaw/dist`) before fixing.

## Acceptance Criteria

1. **A saved key shows on the card at once on 2026.10.3**
   **Given** OpenClaw 2026.10.3, a Gateway that loaded the plugin at start with `cursor-cli` as the
   configured model, on a state whose auth store had no profile
   **When** a key is saved through Connect provider
   **Then** `models.authStatus` lists `cursor-cli:default` as an `api_key` profile without a restart,
   and the Control UI card shows it with Remove key, not "Not configured"
2. **2026.11.x behaves as before**
   **Given** OpenClaw 2026.11.x
   **When** the Gateway starts and a key is saved
   **Then** the plugin does nothing new, and the gateway tier passes as before
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** the gateway and UI `#39` cases above pass on 2026.10.3 (red before the fix), unit tests
   cover the plugin change, and `test/regression/ledger.toml` has a `[[bug]]` entry for #106

## Boundaries

- Must not change: what the plugin reads from the auth store, the API key method's saved profile, or
  any behaviour on OpenClaw 2026.11.x.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected
  `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/106
- related — https://github.com/xtimor/openclaw-all-cli/issues/39 (the card that read "Not configured";
  plan 27 made the API key method save a real profile the card reads)
- code — src/core/auth-store.ts, src/core/register.ts

## Notes

- Issue: #106
- Reproduction test: already on `main`, red on 2026.10.3: the `#39` case in
  `test/regression/gateway/auth-setup.regression.test.ts` and the `#39` card check in
  `test/regression/ui/provider-card.regression.test.ts`.
- Verify: `scripts/regression.sh gateway` (2026.10.3) and `scripts/regression.sh ui` (2026.10.3) are
  green, `scripts/regression.sh gateway --openclaw latest` stays green, then `npm test` and
  `npm run typecheck`.

---
title: "Provider card reads Not configured although the cursor-agent login works"
type: 'bugfix'
ticket: 14
created: '2026-10-26'
status: built
baseline_revision: '5ab8643f7777707e5696ebf21945f7eebc7d78d2'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['inline-self-review']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Control UI provider card shows "Not configured" and a Connect button for `cursor-cli` with a working `cursor-agent` login.

**Approach:** Check the card's states and the plugin's levers in the OpenClaw 2026.10.3 bundle. Build a stop-gap only if it passes the ticket's criteria (login shows no "Not configured", broken login still unauthorized, nothing key-like in config); else document the limit and the upstream issue in `docs/setup.md` and `CHANGELOG.md`.

## Boundaries & Constraints

**Always:** Record the live Control UI check as not run. Protected files stay unchanged.

**Never:** Write a placeholder or key-like value to config; create a stand-in auth profile.

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [x] `docs/setup.md`, `docs/providers/cursor.md` -- document the limit, its cause, and the upstream issue -- AC1
- [x] `CHANGELOG.md` -- one `Unreleased` line linking #39 -- AC1
- [x] `test/provider-card-limit.test.ts` -- pin the host facts and the documentation -- AC2
- [x] `MEMORY.md` -- record findings

**Acceptance Criteria:**
- Given the 2026.10.3 host bundle, when the card states and levers are checked, then no honest stop-gap exists and `docs/setup.md` and `CHANGELOG.md` document the limit with openclaw/openclaw#184700.
- Given `npm test`, when run, then it passes, including the new test.

## Implementation Notes

Route: oneshot (docs plus one small test). Findings (OpenClaw 2026.10.3):
- Card (`model-providers-page-*.js` `yn`): the credentials line prints `Not configured` (i18n `modelProviders.credentials.none`) with no oauth/token profile, no api_key profile, and no `apiKey` summary. Badge (`view-status-*.js` `xt`/`yt`): needs `hasConfigApiKey`, `apiKey`, or a profile. The plugin supplies only the provider id; labels, `uiHints`, descriptions, and `providerAuthChoices` hints are not drawn on the card.
- `apiKey` summary (`models-auth-status-*.mjs` `resolveProviderApiKeys`): config `models.providers.<id>.apiKey` (non-marker) or provider env vars. `syntheticAuthRefs` is not read there; `nonSecretAuthMarkers` only for `origin === "bundled"` (`model-auth-markers-*.mjs`).
- Candidate stop-gaps all fail: a placeholder `apiKey` in config (forbidden, key-like), a fake auth profile (stores a credential, changes auth resolution, a broken login would look signed in), a config `SecretRef` to `CURSOR_API_KEY` (shows only with a real key in the env, not the login case), an `auth.profiles` `oauth` entry (turns the card to "Not signed in", worse).
- Live Control UI: not run (no browser on this host).

## Plan Change Log

## Review Triage Log

Inline self-review (no subagents in this session), pass 1: 0 high, 0 medium, 1 low.
- low, patched: first test version found host files by a hashed name and a prefix shared by three files; now matched by prefix plus a content marker (fails loudly if the host moves them).
- Doc claims checked against the bundle text: card line, `resolveProviderApiKeys` sources, bundled-only markers, "API key from environment" for a Gateway env key (`Y` in `view-status`), saved plugin-config key not shown (it is `plugins.entries...env`, not read by `resolveProviderApiKeys`).

## Verification

**Commands:**
- `npm run ci` -- expected: success

## Auto Run Result

Status: built. `npm run ci` passed. Live Control UI check: not run. Review: inline self-review (no subagents).

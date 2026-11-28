---
title: 'A key saved through Connect provider stays Not configured until a restart on OpenClaw 2026.10.3'
type: 'bugfix'
ticket: '31'
created: '2026-11-28'
status: 'in-progress'
baseline_revision: 'd467522ce1d83620ff67bfa8b7ac4b7b6128370a'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** On OpenClaw 2026.10.3, a Gateway that loaded the plugin at start with `cursor-cli` as the
configured model, on a state with no auth store yet, never shows a key saved through Connect provider
in `models.authStatus`: the card stays "Not configured" until a restart (issue #106), although the
profile is saved and `models.probe` uses it.

**Approach:** Confirm the cause in the installed 2026.10.3 sources first (the ticket's suspect, the
plugin's own `ensureAuthProfileStore` read, is unverified). Then make the smallest plugin change that
keeps the host's view of the store consistent on 2026.10.3, and does nothing on 2026.11.x.

## Boundaries & Constraints

**Always:** feature-detect the host the way `auth-store.ts` already does (the async reader means
2026.11.x); never throw from the new code; keep every read of the store as it is.

**Never:** write or remove an auth profile; change the API key method's result; change anything on a
host that has `ensureAuthProfileStoreAsync`; import host internals outside `openclaw/plugin-sdk/*`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 2026.10.3, fresh state | no auth store, cursor-cli configured, Gateway start | the host settles the shared store's location before its catalog worker reads it; a key saved later shows in `models.authStatus` at once | none expected |
| 2026.10.3, store already settled | ownership already `state-db`, or a legacy store exists | the host's no-op update returns at once; nothing changes | none expected |
| 2026.11.x | `ensureAuthProfileStoreAsync` present | nothing is called | none expected |
| host without the updater | `updateAuthProfileStoreWithLock` missing | nothing is called | none |
| failure | module load fails, the updater throws or returns null (lock contention) | Gateway start goes on; reported as not settled | swallowed |

</intent-contract>

## Code Map

- `src/core/auth-store.ts` -- the plugin's one reader of OpenClaw's auth store (`createAuthStore`, `readStoredKey`, `findAnyStoredKey`); feature-detects 2026.10.3 by the missing `ensureAuthProfileStoreAsync`. The fix's home.
- `src/core/register.ts` -- `registerAdapters`: the full (Gateway) load's start-time work (managed-CLI sweep, reaping, key-cache drop). Calls the fix at start.
- `src/core/synthetic-auth.ts` -- catalog `run` and `prepareSyntheticAuth`; read the store at catalog time (the ticket's suspect; they run in the host's catalog worker thread).
- `test/auth-store.test.ts` -- unit and host-contract tests of the reader; gets the fix's unit and host-contract tests.
- `test/regression/gateway/auth-setup.regression.test.ts` -- the `#39` gateway case, red on 2026.10.3 (the reproduction).
- `test/regression/ui/provider-card.regression.test.ts` -- the `#39` card check, red on 2026.10.3.
- `test/regression/ledger.toml` -- gets the `[[bug]]` entry for #106.
- Host (2026.10.3, read-only): `dist/path-resolve-*.mjs` (`resolveSharedAuthStoreOwnership`, per-thread cache), `dist/sqlite-*.mjs` (`initializeFreshSharedAuthStore`), `dist/agents/prepared-model-catalog.worker.js` (`refreshAuthStore`), `dist/model-auth-refresh-*.mjs` (`refreshModelAuthStateAfterMutation`).

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/auth-store.ts` -- add a start-time "settle the shared store" call: on a host without the async reader, one `updateAuthProfileStoreWithLock` with an updater that changes nothing; never throws -- the host commits the store's location before its catalog worker caches it
- [ ] `src/core/register.ts` -- run it once at a full load, before the start-time store reads -- the earliest point the plugin has in the Gateway's main thread
- [ ] `test/auth-store.test.ts` -- unit tests for every row of the matrix, and a host-contract test that the no-op update settles a fresh state's location and writes no profile
- [ ] `test/regression/ledger.toml` -- `[[bug]]` for #106 (tier gateway), naming the gateway and UI `#39` tests (`reproduces = true`) and the unit tests (`reproduces = false`)
- [ ] `CHANGELOG.md` -- one `### Fixed` line under `## Unreleased` with the issue link

**Acceptance Criteria:**
- Given OpenClaw 2026.10.3 and a fresh state with `cursor-cli` configured, when a key is saved through Connect provider, then `models.authStatus` lists `cursor-cli:default` (`api_key`) without a restart and the card shows it (gateway and UI `#39` cases green, red before the fix)
- Given OpenClaw latest (2026.11.x), when the gateway tier runs, then it stays green and the plugin makes no new call

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh gateway` (2026.10.3) -- expected: all pass, the `#39` case included
- `scripts/regression.sh gateway --openclaw latest` -- expected: all pass
- `scripts/regression.sh ui` (2026.10.3) -- expected: all pass, the `#39` card check included
- `npm test` -- expected: all pass
- `npm run typecheck` -- expected: clean

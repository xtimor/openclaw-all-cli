---
title: 'Read the auth store through plugin-sdk/provider-auth, not the retiring agent-runtime barrel'
type: 'bugfix'
ticket: ''
created: '2026-11-16'
status: 'built'
baseline_revision: 'b9fae5901ba6bd32f71a0544b2da1d8c97775632'
route: 'oneshot'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 0.1.9 reads the saved Cursor key through `openclaw/plugin-sdk/agent-runtime`. OpenClaw marks that import as a broad runtime barrel (`plugin-sdk-broad-runtime-barrels`, removeAfter 2026-10-01). OpenClaw 2026.11.x now shows "Uses OpenClaw APIs that retire on Oct 1, 2026" when the plugin is enabled (reported by nick, 2026-11-16). If a later OpenClaw drops the barrel, the plugin can no longer see the key and `cursor-cli` turns fail.

**Approach:** Read the auth store through the focused subpath `openclaw/plugin-sdk/provider-auth` instead: `ensureAuthProfileStoreAsync` (2026.11.x), or `ensureAuthProfileStore` (2026.10.3), always with `{ readOnly: true, allowKeychainPrompt: false }`, plus `listProfilesForProvider`. Keep the reader's three answers (key, absent, unreadable). Keep the fallback from an agent to the main agent's profile. After the change, the plugin imports no broad barrel.

</frozen-after-approval>

## Implementation Notes

**Why oneshot:** the change fits one module (`src/core/auth-store.ts`), its real-SDK test, one docs line and one changelog line, about 60 lines in all.

**Investigation (2026-11-16).** I ran scratch probes against the isolated OpenClaw 2026.10.3 (`.spike`) and 2026.11.3 installs, using a temporary `OPENCLAW_STATE_DIR`.

| Check | Result on both versions |
| --- | --- |
| A profile saved for main, read for main, for another agent, and with no agent | `provider-auth` `ensureAuthProfileStore[Async](agentDir)` returns it, the same as the old `findPersistedAuthProfileCredential[Async]` |
| An agent's own profile and a main profile with the same id | The agent's own profile wins |
| A read with `{ readOnly: true, allowKeychainPrompt: false }` for an agent that has no store | Creates no file |
| `listProfilesForProvider` | Exported from `provider-auth` |

`ensureAuthProfileStoreAsync` exists only on 2026.11.x. On 2026.11.3 the sync `ensureAuthProfileStore` is deprecated, supported through 2026-12-31.

**Files changed:**
- `src/core/auth-store.ts`: `AuthStoreRuntime` is now the `provider-auth` surface. `readKey` and `findAnyKey` share one read-only store read, `STORE_READ_OPTIONS`.
- `test/auth-store.test.ts`: fakes for the new surface. The host-contract test runs on the real `provider-auth`. It adds checks that main's profile is read for an agent with none, that the agent's own profile wins, and that a read writes no store. A new test keeps all seven broad barrels out of `src`.
- `test/provider-auth.test.ts`: fake moved to the new surface.
- `docs/providers/cursor.md`: the "key at run time" line names the new reader.
- `CHANGELOG.md`: one `Fixed` line.

**Live check on OpenClaw 2026.11.3:**
- How it was checked: the isolated Gateway, `gateway call plugins.list`.
- 0.1.9 from npm: `compatibilityNotices` held the `deprecated-sdk-api` notice "Uses OpenClaw APIs that retire on Oct 1, 2026" for `openclaw/plugin-sdk/agent-runtime`.
- This build: `compatibilityNotices: []`.
- The host-contract test passed on 2026.10.3, and on 2026.11.3 with `OPENCLAW_ALL_CLI_HOST_DIST` under Node 24.

**Test results:** after the review patches, typecheck, `npm test` (2014 passed, 70 skipped) and the build pass. The host-contract test passes on 2026.10.3 and on 2026.11.3.

## Review Triage Log

Quick lens, pass 1:

| Verdict | Route | Finding | Evidence and action |
| --- | --- | --- | --- |
| medium | patch | `docs/providers/cursor.md`, the Remove key paragraph, still named `loadAuthProfileStoreWithoutExternalProfiles[Async]` | Real. The paragraph now names `ensureAuthProfileStore[Async]` and `listProfilesForProvider` from `provider-auth`, and says `:default` alone is read only when the host has no listing. |
| medium | patch | `MEMORY.md` still recorded the `agent-runtime` reader | Real. Updated that entry, and added an entry for the broad-barrel deprecation and how to see its notice (`gateway call plugins.list`). |
| low | patch | The Verification grep covered 5 of the 7 barrels | Real, and fixed by editing the plan text: the grep now covers all seven. |
| medium | patch | `ensureAuthProfileStore[Async]` overlays other CLIs' credentials | Real. `keyOfCredential` already drops other providers, but the reads should not pull them in at all. `STORE_READ_OPTIONS` now carries `externalCli: { mode: "none" }`, which `resolveExternalCliOverlayOptions` handles on both 2026.10.3 and 2026.11.3. |
| maybe-false (medium if true) | defer | The new read may serve OpenClaw's in-memory store copy after a terminal `auth logout` | Not settled. After a logout, OpenClaw refreshes the running Gateway: Control UI `refreshModelAuthStateAfterMutation`, and `models.authRefresh` from the CLI. OpenClaw's own runs use the same copy, so a stale profile there would hit OpenClaw first. To settle it, run a live terminal logout while the Gateway runs, then a keyless check. Recorded in `deferred-work.md`. |
| low | patch | The barrel guard matched only double-quoted imports | Real and cheap to fix. Moved the guard to `test/import-boundary.test.ts`, which uses its `IMPORT_PATTERNS` (single and double quotes, re-exports, dynamic imports, a `.js` suffix). |
| low | patch | The "writes no store" assertion covered two reads at once | Real and cheap to fix. Each read is now followed by its own check. A read-only check against an existing store is not added: `readOnly` is the host's contract, and its own tests cover it. |

## Verification

**Commands:**
- `npm run typecheck`. Expected: passes.
- `npm test`. Expected: passes, including `test/auth-store.test.ts` against the real OpenClaw SDK.
- `grep -rn "plugin-sdk/\(agent\|cli\|conversation\|hook\|media\|plugin\|security\)-runtime" src`. Expected: no match.
- A scratch probe on OpenClaw 2026.11.3 (`node` importing the built `dist`) that reads a saved profile. Expected: the key is found.

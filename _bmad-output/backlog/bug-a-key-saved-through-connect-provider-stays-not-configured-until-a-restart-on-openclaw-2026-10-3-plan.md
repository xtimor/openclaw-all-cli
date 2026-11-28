---
title: 'A key saved through Connect provider stays Not configured until a restart on OpenClaw 2026.10.3'
type: 'bugfix'
ticket: '32'
created: '2026-11-28'
status: 'done'
baseline_revision: 'd467522ce1d83620ff67bfa8b7ac4b7b6128370a'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: [self-review, quick]
review_loop_iteration: 1
followup_review_recommended: true
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
- `test/regression/ui/provider-card.regression.test.ts` -- the `#39` card check, red on 2026.10.3 only when this file saves the first key in the tier's shared state (run alone on a fresh state).
- `test/regression/ledger.toml` -- gets the `[[bug]]` entry for #106.
- Host (2026.10.3, read-only): `dist/path-resolve-*.mjs` (`resolveSharedAuthStoreOwnership`, per-thread cache), `dist/sqlite-*.mjs` (`initializeFreshSharedAuthStore`), `dist/agents/prepared-model-catalog.worker.js` (`refreshAuthStore`), `dist/model-auth-refresh-*.mjs` (`refreshModelAuthStateAfterMutation`).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/auth-store.ts` -- add a start-time "settle the shared store" call: on a host without the async reader, one `updateAuthProfileStoreWithLock` with an updater that changes nothing; never throws -- the host commits the store's location before its catalog worker caches it
- [x] `src/core/register.ts` -- run it once at a full load, in the background, before the start-time store reads, and log one line when it fails -- the earliest point the plugin has in the Gateway's main thread
- [x] `test/auth-store.test.ts` -- unit tests for every row of the matrix, and a host-contract test that the no-op update settles a fresh state's location and writes no profile
- [x] `test/regression/ledger.toml` -- `[[bug]]` for #106 (tier gateway), naming the gateway `#39` test (`reproduces = true`), the UI `#39` test and the unit tests (`reproduces = false`; the UI check reproduces #106 only by file order)
- [x] `CHANGELOG.md` -- one `### Fixed` line under `## Unreleased` with the issue link

**Acceptance Criteria:**
- Given OpenClaw 2026.10.3 and a fresh state with `cursor-cli` configured, when a key is saved through Connect provider, then `models.authStatus` lists `cursor-cli:default` (`api_key`) without a restart and the card shows it (gateway `#39` case and the UI `#39` check green; the gateway case red before the fix, the UI check red before it when run alone on a fresh state)
- Given OpenClaw latest (2026.11.x), when the gateway tier runs, then it stays green and the plugin makes no new call

## Implementation Notes

**Root cause (confirmed in the installed 2026.10.3 dist, not the ticket's suspect).**
- The suspect is ruled out: with every plugin store read disabled in the installed plugin (`ensureAuthProfileStore` replaced by "no reader", so nothing of ours touches the store), the `#39` gateway case stays red.
- Instrumenting the host (copies of `store-*.mjs`, `runtime-snapshots-*.mjs`, `agents/prepared-model-catalog.worker.js` with `appendFileSync` logs, restored after) showed the sequence:
  1. The main thread's prepared runtime gets `cursor-cli:default` right after the save.
  2. The catalog worker thread then republishes the store with no profile, and `models.authStatus` reads that.
- Cause, all in OpenClaw 2026.10.3:
  - `resolveSharedAuthStoreOwnership` (`path-resolve-*.mjs`) caches the shared store's location per thread. An absent `auth.sharedStore` row means `legacy-main`, `agents/main/agent/openclaw-agent.sqlite`.
  - On a fresh state the first auth write runs `initializeFreshSharedAuthStore` (`sqlite-*.mjs`). It moves the location to `state-db` (`state/openclaw.sqlite`) and updates only the writing thread's cache. `refreshModelAuthStateAfterMutation` reloads only the main thread's.
  - The catalog worker was started at Gateway start for the configured `cursor-cli` catalog, so it keeps `legacy-main`.
  - Its `refreshAuthStore` reads the empty old store, and `replacePreparedModelCatalogAuth` puts that view into the published owner that `models.authStatus` shows. It drops `cursor-cli:default` because main marks it `runtimePersistedProfileIds`, and the worker trusts its own durable read for those.
- Proof:
  - Patching the worker to reload the location per request turned `#39` green; the worker's log went from `legacy-main` to `state-db` after the save.
  - Without the patch it stays `legacy-main` throughout.
- This also explains the ticket's other facts:
  - The main thread serves `models.probe` and `models auth list`, so both see the profile.
  - With no plugin provider at start, no worker caches the old location.
  - A restart or a plugin hot reload rotates the worker (MEMORY ticket 4.6 line).
  - 2026.11.x is not affected.

**Fix.**
- `settleSharedStore` in `createAuthStore`, exported as `settleSharedAuthStore`.
  - On a host without `ensureAuthProfileStoreAsync` (the module's existing 2026.10.3 test), it runs one `updateAuthProfileStoreWithLock({ updater: () => false })`. That is a shared-store write, so the host settles the location as the first saved key would, before the worker's first read.
  - On a fresh state it writes only the `config_machine_state` row `auth.sharedStore = {"location":"state-db"}` (checked with `node:sqlite`): no profile, no store save.
  - On a settled state, or one with legacy sources, the host returns at once. A failing or contended update reads as `failed`.
  - It never throws, and it does nothing on 2026.11.x.
- `registerAdapters` calls it once per full load, first, injectable through a new optional `RegisterOptions.settleAuthStore` for tests. It runs in the background (fire-and-forget), so it is a timing race with the worker's first read, not a guarantee: nothing in the host orders the two. In the experiment that proved it (the same call patched into the installed plugin, with the host's worker logging), the settle finished about 6 ms after it started, and the worker's first read came about 4.5 s later and already saw `state-db`.
- A `failed` outcome logs one plugin line: "could not settle the auth store location on OpenClaw 2026.10.3; a key saved before the next restart may show as Not configured". `settled` and `skipped` (2026.11.x, or no updater) log nothing.
- A failed settle is not silent on the host side either: for a state with an invalid `auth.sharedStore` row, or legacy auth files that need `openclaw doctor --fix`, the host's update throws and the host itself warns "auth profile store update failed" on each full load. The plugin line above says which plugin caused it and what it means for a saved key.
- Files: `src/core/auth-store.ts`, `src/core/register.ts`, `test/auth-store.test.ts` (unit tests for every matrix row, plus a host-contract test on the 2026.10.3 dist: `legacy-main` becomes `state-db`, no profile, idempotent), `test/backend.test.ts` (a full load settles once, a discovery load does not; the one full-mode call now passes a stub, so `npm test` never writes a real store), `test/regression/ledger.toml` (#106), `CHANGELOG.md`, `docs/release.md` (dropped "the min job is red while #106 is open"), `MEMORY.md`.
- Local only: a `.spike` symlink to `.regression/openclaw-2026.10.3`, so `npm run typecheck` and the host-contract tests find the 2026.10.3 SDK. It is untracked and not committed.

**Review (inline self-review, no subagents).**
- Race: the settle is async at register. If the worker's first store read came before it commits, that one Gateway run would still show the bug. In the one probe the margin was seconds; nothing guarantees it.
- The update fails on a state whose legacy auth files need `openclaw doctor --fix`: the host throws there, and the result is `failed`. Since review pass 1 that logs one plugin line, and the host warns "auth profile store update failed" too.
- A no-op write lock at every full load on 2026.10.3: cheap.
- Test gap, not changed (`test/regression/` is outside this ticket): the UI tier's `#39` check reproduces #106 only when `provider-card` is the first file to save a key in the tier's shared state. In a full `ui` run `key-actions` goes first, so that check passes with or without the fix (see Verification). The gateway tier's `#39` case does reproduce it (`auth-setup` saves the first key there).
- No patch was needed in the self-review. The quick lens (review pass 1) then found six issues, all patched; see the Review Triage Log.

## Plan Change Log

## Review Triage Log

### 2026-11-28 — Inline self-review (no subagents)

- verdicts: 0 high, 0 medium, 3 low (all accepted as residual risk, none patched), 0 false
- findings:
  - `[low]` `[accept]` The async settle can lose a race with the worker's first read. It completed in about 6 ms against a margin of about 4.5 s in the probe; if lost, that Gateway run behaves as before the fix.
  - `[low]` `[accept]` A state with legacy auth files that need `openclaw doctor --fix` makes the host's update throw. The result is `failed`, nothing else happens, and the bug does not occur there: the location stays `legacy-main` in every thread.
  - `[low]` `[accept]` The UI tier's `#39` check depends on file order to reproduce #106 (see Implementation Notes). Changing the shared regression tests is out of this ticket's scope.

### 2026-11-28 — Review pass 1 (quick lens, triaged by the coordinator)

- verdicts: 1 high, 3 medium, 2 low; all patched (route: patch), 0 deferred, 0 false

| # | Finding | Verdict | Route | What changed |
|---|---------|---------|-------|--------------|
| 1 | `docs/release.md`: the Weekly beta run bullet lost the 4.11 text (`source:regression`/`type:bug` labels, the "fixed at once ... no triage and no approval" note, the `force_red` ... `forced` sentence) because the hunk was made on an older base | high, real | patch | Bullet restored to the 4.11 text, checked against `scripts/regression-beta-issue.mjs`; only the two "#106 is open" sentences are dropped |
| 2 | Ledger #106 marks the UI `#39` check `reproduces = true`, but a full ui run passes it without the fix | medium, real | patch | UI `#39` test is `reproduces = false`, with a comment saying why; the gateway `#39` case stays the reproduction |
| 3 | `register.ts`: a failed settle is invisible, and the comment reads as a guarantee | medium, real | patch | Settle stays fire-and-forget; a `failed` outcome logs one line ("could not settle the auth store location on OpenClaw 2026.10.3; a key saved before the next restart may show as Not configured"); the comment, this plan and MEMORY call it a timing race. New unit test in `test/backend.test.ts`: one line for `failed`, none for `settled` or `skipped` (in the #106 ledger entry, `reproduces = false`) |
| 4 | "A failed settle is silent" is wrong: the host warns "auth profile store update failed" on each full load for an invalid shared-store row or legacy files needing `openclaw doctor --fix` | low, real | patch | Implementation Notes and the self-review note now say so; the plugin line from 3 gives the attribution |
| 5 | `docs/providers/cursor.md` does not say the plugin now takes the auth-store write lock on 2026.10.3 | medium, real | patch | "The key at run time" says: on 2026.10.3, one write lock per full load, a no-op update that on a fresh state records `auth.sharedStore` (no profile), background and not guaranteed, the log line on failure; nothing on 2026.11.x |
| 6 | `MEMORY.md`: the ticket 4.6 line still describes #106 as current; the #106 line overstates the fix | low, real | patch | Ticket 4.6 line in past tense, pointing to the bug 32 line, and records that the UI `#39` check reproduces #106 only when provider-card saves the first key in the shared state; the bug 32 line calls the settle a timing race (about 6 ms vs the worker's read about 4.5 s later in one probe) and names both warning lines |

## Verification

**Commands:**
- `scripts/regression.sh gateway` (2026.10.3) -- expected: all pass, the `#39` case included.
  - Before the fix (d467522): failed, 612 s, only `#39` red ("models.authStatus has no saved cursor-cli profile 30 s after the save").
  - After: passed, 601 s, 19 passed, 1 skipped (the 2026.11.x-only `#80` case).
- `scripts/regression.sh gateway --openclaw latest` (resolved to 2026.11.11) -- expected: all pass. Result: passed, 960 s (run beside a UI run), 16 passed, 4 skipped (the offline-catalog cases, as before).
- `scripts/regression.sh ui` (2026.10.3) -- expected: all pass, the `#39` card check included. Result: passed, 269 s, 8 of 8.
- Red before for the UI check:
  - The full UI tier does not reproduce #106. `key-actions` runs before `provider-card` in the tier's shared state and saves a key first, so the location is already settled when `provider-card`'s Gateway starts. A full `scripts/regression.sh ui --tgz <the fix's package with the settle call removed>` passed 8 of 8 (424 s).
  - So the reproduction ran `provider-card.regression.test.ts` alone on a fresh 2026.10.3 state (the script's own steps). Without the settle: `#39` red, "the card still reads Not configured 30 s after the save (#106 on 2026.10.3)" (217 s). With the fix's package: 4 of 4 green (178 s).
- `npm test` -- expected: all pass. Result: 73 files passed, 28 skipped; 2118 tests passed, 98 skipped (live and regression only).
- `npm run typecheck` -- expected: clean. Result: clean (with `.spike` linked to `.regression/openclaw-2026.10.3`).
- `node scripts/changelog.mjs check` -- expected: clean. Result: clean.
- Live Cursor check: not run (no `cursor-agent` login here; the change has no Cursor-side path).

**After review pass 1** (on the branch tip 77a441e plus the patches):
- `npm run typecheck` -- clean (with `.spike` linked to `.regression/openclaw-2026.10.3`, removed after).
- `npm test` -- 73 files passed, 29 skipped; 2158 tests passed, 100 skipped (84 s).
- `test/regression/gateway/auth-setup.regression.test.ts` alone, on a fresh 2026.10.3 state with the plugin built and packed from this tree -- 4 of 4 passed (`#39`, PR #96, #98 x2; 154 s). The whole gateway and ui tiers were not re-run (the patches change only the failure log line, docs, and the ledger flag).
- `node scripts/changelog.mjs check` -- clean.

## Auto Run Result

- Status: in-review, review loop iteration 1 (lenses: self-review, quick). Six quick-lens findings, all patched in one commit; none deferred.
- Fix: one no-op `updateAuthProfileStoreWithLock` per full load on OpenClaw 2026.10.3 settles a fresh state's auth store location before the host's model-catalog worker reads it, so a key saved through Connect provider shows without a restart. It is a timing race won by seconds in the probe, not a guarantee; a failure logs one plugin line. Nothing changes on 2026.11.x.
- Evidence: gateway `#39` red before (d467522), green after on 2026.10.3; gateway tier green on 2026.10.3 and 2026.11.11; ui tier green on 2026.10.3 (the UI `#39` check red without the fix only when run alone on a fresh state).
- Residual risk: a lost race or a state that needs `openclaw doctor --fix` leaves that Gateway run as before the fix (logged).

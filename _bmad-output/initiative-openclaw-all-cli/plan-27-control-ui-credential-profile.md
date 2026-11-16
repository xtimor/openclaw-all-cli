---
title: 'Control UI Connect provider ends cleanly for the Cursor CLI API key'
type: 'bugfix'
ticket: ''
created: '2026-11-15'
status: 'built'
baseline_revision: '92da2d67f8d89deb91c4c3feb39705838385cb24'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/_bmad-output/backlog/story-connecting-cursor-cli-installs-cursor-agent-when-it-is-missing-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** In the Control UI (OpenClaw 2026.11.x, Settings → Models → Connect provider), every cursor-cli method ends with the red error "<method> did not return a credential profile.", although the key and the managed CLI are already saved. OpenClaw's `models.authLogin` requires at least one auth profile from a method; ours return `profiles: []` because the key lives in plugin config (`cursor-cli.env.CURSOR_API_KEY`). Found live on 2026-11-15 while checking story 27 (PR #92); present since 0.1.x.

**Approach (nick, 2026-11-15: "fix first"; store the key in OpenClaw's account store):** the API key method returns a real `api_key` auth profile for provider `cursor-cli` holding the key, so OpenClaw stores it and the dialog ends cleanly. At turn time the backend reads the key from the auth profile the host selected and gives it to `cursor-agent` only; plugin config `cursor-cli.env.CURSOR_API_KEY` stays a fallback for manual setups.

## Boundaries & Constraints

**Always:** works on OpenClaw 2026.10.3 (dev baseline) and 2026.11.x; the key reaches only the `cursor-agent` process (not `exec`, not other providers); a real key only, never a placeholder or fake profile (bug 14 decision stands); the install offer and key check of story 27 stay as they are; terminal `openclaw models auth login --provider cursor-cli --method ...` keeps working.

**Decision (nick, 2026-11-16):** the Control UI lists only the API key method; `login` and `remove` stay as terminal methods (`openclaw models auth login --provider cursor-cli --method login|remove`). OpenClaw's own Remove key button removes our key; when we saved the key for a CLI we installed, the plugin then removes that CLI by itself. A CLI logged in by itself shows "Not configured" on the card (no fake account).

**Never:** a placeholder/fake credential; editing OpenClaw; touching Cursor's own `~/.config/cursor/auth.json`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| UI API key, new | Control UI, key entered, check ok | dialog ends without error; profile `cursor-cli:default` saved; provider card shows the account | none |
| Turn with profile | profile exists, no key in plugin config | `cursor-agent` runs with the profile's key | profile unreadable → fall back to plugin config key, then to the CLI's own login |
| Both present | profile and plugin-config key | profile key wins | none |
| Built-in Remove key | user presses OpenClaw's Remove key | profile deleted; next turn has no key from it, and the CLI no longer works through a cached copy of that key | the managed CLI follows the row below (nick, 2026-11-16) |
| Usage / quota | profile key only | usage ledger and quota read work with the profile key | same fallback as a turn |
| Model list | profile key only, CLI not logged in | `/model` lists the account's models (the catalog probe sees the key) | no key → default model only, as today |
| Remove key, managed CLI keyed by us | profile gone, marker `<managed root>/.key-saved` present, no other key, CLI not logged in by itself | the plugin removes the managed CLI and unsets `cursor-cli.command` at the next Gateway start or the next turn without a key | CLI logged in by itself, or status unclear → kept |
| Remove key, CLI not ours | no marker | nothing removed | none |

</frozen-after-approval>

## Code Map

- `src/core/provider-auth.ts` -- `createAuthMethods`: api-key method returns `profiles: []` and a `configPatch` writing `cursor-cli.env.CURSOR_API_KEY` (lines ~297-302, 365-378). Change to return `[{ profileId: "<backendId>:default", credential: { type: "api_key", provider: backendId, key } }]` and stop writing the key into plugin config (keep the `command` patch). Login method (`~340-380`) and remove method (`~390-470`) return no profile: see Open Questions.
- `openclaw.plugin.json` `providerAuthChoices` -- the Control UI list comes from here (MEMORY line 28); a method left out of it stays usable from the terminal because the CLI path reads `api.registerProvider` methods. `choiceHint` of the API key choice says "Keep a key in the plugin config" and must change.
- `src/core/backend.ts` `prepareExecutionFor` -- host passes `authProfileId` and `agentDir` in `PrepareExecutionContext`; since the backend has `prepareExecution`, the host auto-selects the first `cursor-cli` profile (`prepare.runtime` 2026.11.3 l.1218-1226). Resolve the key here with `resolveApiKeyForProfile` (exported by `openclaw/plugin-sdk/agent-runtime` in 2026.10.3 and 2026.11.3) and put it into the launch env as `adapter.apiKeyEnvVar`.
- `src/core/execute.ts` -- env assembled at l.181 and l.451 (`{ ...ctx.env, ...home.env }`); `reuseKey` already includes `authProfileId`, so a key change restarts the warm process.
- `src/adapters/cursor/usage.ts:296`, `src/adapters/cursor/quota.ts`, `src/adapters/cursor/index.ts:96,364` -- read `env.CURSOR_API_KEY`; must see the profile key too (same resolved env).
- `src/core/register.ts:21` `livePools` -- module-level map; the Control UI runs auth methods in another module instance, so `remove` there says it cannot see Gateway turns. Move to a `globalThis` registry keyed by `Symbol.for(...)` (needed only if `remove` stays in the UI).
- Host checks: `models-auth-login-*.mjs` l.127 (the error), `auth-*.mjs` `runProviderAuthMethod`/`persistProviderAuthResult` (profile persistence), MEMORY bug 14 (provider card needs an auth profile).
- **Cursor caches the key (found in review pass 1, live, cursor-agent 2026.11.11):** any run with `CURSOR_API_KEY` writes `apiKey`/tokens to `$XDG_CONFIG_HOME/cursor/auth.json` (default `~/.config/cursor/auth.json`); afterwards `cursor-agent status` without a key says `Logged in`. So a removed key keeps working and the sweep sees a "self login". `XDG_CONFIG_HOME=<dir>` moves that file (and `cli-config.json`, `statsig-cache.json`) into `<dir>/cursor/` (checked live). Isolate every run that gets a plugin-supplied key (profile or plugin config) into a plugin-owned config dir inside the agent's home (`home.dir`, see `src/core/home.ts` and the adapter's `prepareHome` env; check it does not clash with `CURSOR_CONFIG_DIR` the adapter already sets for permission profiles). The real `~/.config/cursor` is then never written by a keyed run, and a self login stays the user's.
- Store reader must be tri-state (`key` / `absent` / `unreadable`): the sweep keeps the CLI on `unreadable` (frozen matrix: unclear → kept).
- Sweep `hasKey` must cover every configured agent (`configuredAgentIds` in `register.ts` + `api.runtime.agent.resolveAgentDir`) and every `cursor-cli` api_key profile the host lists, not only `cursor-cli:default` of main (the host persists a Control UI profile under the agent the dialog names; `findPersistedAuthProfileCredential` falls back agent → main, never main → agent). When the host offers no profile listing (2026.10.3), check `cursor-cli:default` per agent.
- Docs: `docs/setup.md`, `docs/providers/cursor.md`, CHANGELOG Unreleased, MEMORY (new fact + supersede "key in plugin config" lines), tests `test/provider-auth.test.ts`, `test/host-contract.test.ts`, `test/provider-card-limit.test.ts` (likely flips).


## Tasks & Acceptance

**Execution:**
- [x] `src/core/auth-store.ts` (new) -- `readStoredKey({agentDir, profileId})`: dynamic import of `openclaw/plugin-sdk/agent-runtime` `findPersistedAuthProfileCredential`; returns the `api_key` key or undefined, never throws; injectable for tests -- one place reads the auth store.
- [x] `src/core/provider-auth.ts` -- API key method returns profile `<backendId>:default` (`type: "api_key"`), removes a plugin-config key of the same var (migration, note says so), writes the `.key-saved` marker when the managed CLI is the command; notes and docs comments updated; `remove` also deletes the marker.
- [x] `src/core/backend.ts`, `src/core/execute.ts` -- prepareExecution resolves the key (host `authProfileId`, else `<backendId>:default`) into `home.env[keyVar]` when present; a key fingerprint joins the warm-process reuse key.
- [x] `src/core/synthetic-auth.ts`, `src/core/quota.ts` -- catalog/login probes and quota see the stored key (store first, then plugin config, then env).
- [x] `src/core/managed-install.ts` + `src/core/register.ts` -- `sweepManagedInstall`: on full load and on a keyless turn, remove the managed CLI (and unset `command` via `openclaw/plugin-sdk/config-mutation`) when the marker is set, no key exists anywhere, and the CLI is not logged in.
- [x] `openclaw.plugin.json` -- keep only the API key choice; new hint.
- [x] tests (`test/provider-auth.test.ts`, new `test/auth-store.test.ts`, sweep tests, `test/host-contract.test.ts`, `test/provider-card-limit.test.ts`), docs (`docs/setup.md`, `docs/providers/cursor.md`), CHANGELOG Unreleased, MEMORY.

**Execution, pass 2 (review loop 1; re-derive, reusing the KEEP list in the Plan Change Log):**
- [x] everything from the list above, plus:
- [x] key-cache isolation for every run that gets a plugin-supplied key (turns, catalog/login probes, usage/quota calls that spawn the CLI); a keyless run uses the real config dir as before. When no plugin-supplied key exists, the plugin-owned config dir of that home is deleted (the cached key goes with the key).
- [x] tri-state store reader; sweep keeps on `unreadable`; sweep checks every configured agent and every `cursor-cli` profile it can list.
- [x] sweep never blocks a turn: a keyless turn starts it without awaiting it.
- [x] quota `resolveUsageAuth`: ask `context.resolveApiKeyFromConfigAndStore` before the module import (host budget is 5 s; the first import takes 4-10 s); honor `context.signal`.
- [x] `API_KEY_METHOD_ID` and similar constants in a leaf module (no `backend.ts` ↔ `provider-auth.ts` cycle).
- [x] `login` method: its "a key takes precedence" note also counts a stored profile key; docs match the notes the `remove` method really prints; supersede MEMORY l.113 ("What works: the plugin config `cursor-cli.env` … Docs recommend login, then this").

**Acceptance Criteria:**
- Given OpenClaw 2026.11.3 Control UI, when the user connects Cursor CLI with a valid API key, then the dialog ends without an error and the provider card shows the account.
- Given only the stored profile holds the key, when a `cursor-cli/auto` turn runs, then it answers and `exec` does not see the key.
- Given OpenClaw 2026.10.3, when `openclaw models auth login --provider cursor-cli --method api-key-env` runs, then the key is stored as a profile and a turn works.
- Given our key was removed with Remove key and we installed the CLI, when the Gateway restarts, then the managed CLI folder is gone and `cursor-cli.command` is unset.
- Given a turn ran with the profile key (real `cursor-agent`), when the key is removed with Remove key, then a later turn does not authenticate through a cached copy, and `~/.config/cursor/auth.json` was never created by the plugin.

## Implementation Notes

- Store read: `src/core/auth-store.ts` uses `findPersistedAuthProfileCredentialAsync` when present (2026.11.x warns on the sync one), else `findPersistedAuthProfileCredential` (2026.10.3), not `resolveApiKeyForProfile` from the code map: the Execution list names the persisted lookup, and it needs no config or secret resolution. Only an inline `api_key` of the same provider counts (no keyRef, token, oauth, `nativeAuth`, `openclaw:` marker, or whitespace). A failed module load is retried on the next read; the reader never throws.
- Key order everywhere (turn, catalog and native-login probes, quota): profile (host `authProfileId`, else `<backendId>:default`), plugin config, Gateway env; quota asks OpenClaw first (pass 2, below). The key goes into `home.env` only; `backend.config.env`, the prepared env, and `process.env` stay without it. A sha256 prefix of the key joins `reuseKey`.
- Marker `<managed root>/.key-saved` (0600, no key) is written by the API key method when `command` is inside the managed root, best effort; install pruning and `readManaged().present` ignore it. The `remove` method's "no" to the CLI also drops it; a sweep that finds the CLI logged in by itself drops it too.
- Sweep (`sweepManagedInstall`, `createManagedSweep`): marker, no key (default profile, plugin config, Gateway env), pool not busy, `probeAuth` without the key = missing, then recheck marker and key, close idle, remove, unset `command` with `mutateConfigFile`. Runs at full load (`void`) and on a keyless turn (shared run, pass 2: started, never awaited). Never throws.
- `livePools` stays module-level: `remove` left the Control UI, so the globalThis registry was not needed.
- Manifest `providerAuthChoices` holds only `api-key-env`; `login` and `remove` stay registered for the terminal.

- Pass 2, key cache: adapter port `keyCacheEnv(dir)` (Cursor: `{ XDG_CONFIG_HOME: dir }`; `CURSOR_CONFIG_DIR` keeps `cli-config.json` and statsig, only `auth.json` moves, checked live). `src/core/key-cache.ts`: `<home>/key-cache` (0700) for a turn with a plugin-supplied key (store or plugin config; a Gateway-env key is the user's and uses the real config); a failed mkdir fails the turn (`unclassified`), never falls back. A turn without such a key and with a readable store drops `<home>/key-cache`; an unreadable store keeps it. Catalog listing and login probes with a plugin key run in a throwaway `<home>/key-cache/once-*` (or `$TMPDIR/oac-key-cache-*` without a home), deleted after. On full load, `dropStaleKeyCaches` drops the cache of every agent home whose store answers `absent` (only homes that have one; skipped while the plugin config holds a key).
- Pass 2, store: `StoredKey = key | absent | unreadable`; `findAnyKey({agentDir})` lists the agent's `cursor-cli` profiles (`loadAuthProfileStoreWithoutExternalProfiles[Async]` + `listProfilesForProvider`, which includes main's), else `<backendId>:default`; any throw or a missing lookup is `unreadable`. Sweep `keyPresence`: plugin config or Gateway env key first, then every configured agent dir (`configuredAgentIds` + `resolveAgentDir`; a throw there is `unreadable`); `unreadable` keeps the CLI (`kept: unreadable`). `busy` is read before the first await.
- Pass 2, quota: `resolveUsageAuth` checks `signal`, asks `resolveApiKeyCandidatesFromConfigAndStore` (then the legacy `resolveApiKeyFromConfigAndStore`; `openclaw:` markers skipped), then plugin config, then `context.env`; it reads the store itself only when the host offers neither resolver, raced against `signal`.
- Pass 2, ids: `LOGIN_METHOD_ID`, `API_KEY_METHOD_ID`, `REMOVE_METHOD_ID` live in `src/core/auth-ids.ts`; `test/import-cycles.test.ts` fails on any runtime import cycle in `src/`.
- Pass 2, notes: the login note names a stored, plugin-config or env key ("A CURSOR_API_KEY is saved too (in OpenClaw's auth store, profile cursor-cli:default) and takes precedence over the login."); the sweep's removal line and the remove method's notes are quoted in the docs as printed.

## Plan Change Log

- **Loop 1 (2026-11-16), quick review pass 1.** Trigger: (a) live with real `cursor-agent` 2026.11.11 after a Control UI setup and one turn, `~/.config/cursor/auth.json` held the key and `cursor-agent status` (no key) said `Logged in`, so Remove key does not disconnect Cursor and the sweep would keep the CLI and drop the marker for good (AC4 unreachable); (b) the sweep reads only `cursor-cli:default` of the main agent and treats a failed store read as no key, so it can delete a CLI another agent's key still uses. Amended: Code Map (key cache, tri-state reader, all agents), Tasks pass 2, one AC. Known-bad state avoided: a removed key that still works; deleting a CLI in use. KEEP (pass 1 diff saved at `/tmp/claude-0/-home-user/7a0d76c3-74a6-57e5-8195-7087962fc9ee/scratchpad/plan27-pass1-keep.diff`; reuse it freely): `auth-store.ts` reader shape (async lookup first, sync on 10.3, `keyOfCredential` filters), profile `<backendId>:default` from the API key method with the plugin-config migration, the marker file and its exclusion from pruning and `present`, key in `home.env` only plus the sha256 prefix in `reuseKey`, `unsetManagedCommand` via `openclaw/plugin-sdk/config-mutation`, manifest with only `api-key-env`, all its tests (adapt, do not drop). Live in pass 1 (2026.11.3 Control UI): dialog ended with "Provider credentials saved", card "cursor-cli · 48 models, Ultra, Credentials configured", chat turn on OAC / Auto answered — keep that behavior.

## Review Triage Log

**Pass 1 (quick):** high 2, medium 4, low 4, false 1, rejected 1 → loopback (bad_plan).
- high, bad_plan — sweep checks only main/default profile (another agent's or `cursor-cli:manual` key ignored) → CLI deleted while in use. Verified in `createManagedSweep` (`resolveCliKey` without agentDir/profileId) and host fallback agent→main only.
- high, bad_plan — AC4 unreachable with real Cursor: key cached in `~/.config/cursor/auth.json`, status then `Logged in`; verified live 2026-11-16.
- medium, bad_plan — failed store read = no key → sweep may delete; `createStoredKeyReader` maps every throw to undefined.
- medium, bad_plan — first quota read may exceed host's 5 s usage budget (module import 4-10 s); `resolveUsageAuth` awaits it first.
- medium, bad_plan — keyless turns await the sweep (status probe up to 5 s) every time while status is unclear.
- medium, intent (resolved) — frozen row "Built-in Remove key: managed CLI stays" contradicted nick's 2026-11-16 decision; row was a stale transcription, aligned to the decision.
- low, bad_plan — `login` note ignores a profile key although docs say it counts.
- low, bad_plan — docs describe a `remove` note the code does not print.
- low, bad_plan — stale MEMORY l.113.
- low, bad_plan — `backend.ts` ↔ `provider-auth.ts` import cycle.
- false — "AC1/AC2 not verified": verified live 2026-11-16 on 2026.11.3 Control UI (dialog "Provider credentials saved", card shows the account, chat turn answered `pong` with no `CURSOR_API_KEY` in the Gateway env and no key in plugin config).
- rejected — "no ticket": fix is to edit this build's plan frontmatter (follow-up of story 27, PR #92).

**Pass 2 (quick):** medium 3, low 4, maybe-false 1 → patch 7, defer 2 (`deferred-work.md`).
- medium, patch — API key method deleted the global plugin-config key when the profile was saved for a non-main agent (host fallback agent → main only): migrate only for the main agent, else keep and note. Fixed + tests.
- medium, patch — upgrade path: a key cached by an older version in `~/.config/cursor/auth.json` keeps working after Remove key and makes the sweep keep the CLI; plugin never touches that file: migration note and docs name `cursor-agent logout`. Fixed.
- medium, patch — removal timing over-promised: live 2026.11.3, OpenClaw blocks the keyless chat turn ("No provider credential is configured"), so removal happens at the next Gateway start that loads the plugin (verified live: log line, folder, `command`, key-cache gone). Docs/note fixed.
- low, patch — README.md:25 and three doc lines stale. Fixed.
- low, patch — sweep sampled busy once: re-check before removal (`ownTurns` for the triggering turn). Fixed + tests.
- low, patch — keyless `dropKeyCache` could delete a concurrent `once-*` throwaway: skip young `once-*`. Fixed + tests.
- maybe-false (medium if true), defer — first `readStoredKey` import may slow the first turn/catalog in the Gateway; settle by timing.
- low, defer — `:default`-only reads in catalog/probes/notes vs host-picked `:manual` profile.

**Live, pass 2 (2026-11-16, OpenClaw 2026.11.3 Control UI, real cursor-agent 2026.11.11):** Connect provider lists only the API key method; install + key → "Provider credentials saved"; card "cursor-cli · 48 models, Ultra, Credentials configured" with quota bars; chat turn on OAC / Auto answered `pong`; key cached only in `<agent>/openclaw-all-cli/cursor-cli/key-cache/cursor/auth.json`, `~/.config/cursor` untouched; Remove key → "Saved API keys removed", card "Not configured"; next Gateway start logged the removal, `state/tools/cursor-agent` and key-cache gone, `cursor-cli.command` unset. After patches: `npm run typecheck`, `npm test` (68 files, 2013 passed, 70 skipped), `npm run build` pass.

## Verification

**Commands:**
- `npm run typecheck && npm test` -- expected: pass
- Control UI on OpenClaw 2026.11.3 (scratch `SPIKE_DIR`, headless Chromium over CDP) -- expected: API key flow ends without error; a `cursor-cli/auto` turn answers with the key only in the auth profile

**Results (2026-11-16):**
- `npm run typecheck && npm test`: pass (66 files, 1982 tests, 70 skipped live/host-version tests). `npm run build`: pass. New: `test/auth-store.test.ts` (with a host contract against the 10.3 store), `test/profile-key.test.ts`, `test/managed-sweep.test.ts` (with a host contract for `unsetManagedCommand`), host-contract and provider-card-limit pins for the profile error, auto-selection, and the card's profile listing.
- Mutations, each caught by a named test, then restored: key left out of `reuseKey`; provider check removed; prune deleting the marker; plugin config before the store.
- OpenClaw 2026.10.3, packed plugin in a scratch state, fake agent as `command`: `openclaw models auth login --provider cursor-cli --method api-key-env` saved `cursor-cli:default` (state DB `authProfiles.store`, mode 600), removed the legacy plugin-config key with a note, and ended cleanly; `openclaw agent --local --model cursor-cli/auto` answered with the profile's key (fake agent `keyHash`), over a different `CURSOR_API_KEY` in the shell env. After `openclaw models auth logout cursor-cli:default` with a simulated managed install plus marker and no env key, the next load removed the folder and unset `command`; that one-shot turn then failed with OpenClaw's `CLI backend executable could not be resolved` (load-time sweep races the first turn; documented). With the shell's `CURSOR_API_KEY` set the sweep kept the CLI (`kept: key`).
- OpenClaw 2026.11.3 (scratch install, plain Node, vitest cannot import its dist): store upsert/find round trip, `mutateConfigFile` unset, `models auth logout`, the profile error line, and auto-selection in `prepare.runtime` confirmed.
- Not run: the Control UI on 2026.11.3 in a browser (no Playwright here, no real Cursor login), a live Cursor turn with a real key through the profile, macOS.

**Results, pass 2 (2026-11-16):**
- `npm run typecheck && npm test && npm run build`: pass (68 files, 2010 tests, 69 skipped live/host-version tests). New: `test/key-cache.test.ts`, `test/import-cycles.test.ts`; tri-state, all-agents, non-blocking sweep, key-cache and quota-order tests in `test/auth-store.test.ts`, `test/managed-sweep.test.ts`, `test/profile-key.test.ts`, `test/quota.test.ts`, `test/provider-auth.test.ts`; the fake agent caches a keyed run's key under `$XDG_CONFIG_HOME/cursor/auth.json` (`FAKE_CURSOR_KEY_CACHE=1`).
- Mutations, each caught by a named test, then restored: key cache left out of a keyed turn; cache dropped on an unreadable store; sweep awaited by the turn; sweep not keeping on `unreadable`; `busy` read after an await; quota importing the store before asking the host; `keyPresence` ignoring `unreadable`; only `:default` checked per agent; login probe not isolated; catalog listing not isolated; the old `backend.ts` -> `provider-auth.ts` import (cycle test).
- Real `cursor-agent` 2026.11.11, plugin code with an injected profile reader: keyed turn answered `pong`, listing returned 48 models, `<home>/key-cache/cursor/auth.json` written and `~/.config/cursor/auth.json` never created; after the key was removed the next turn got Cursor's auth error (no cached copy used) and `key-cache` was gone.
- OpenClaw 2026.10.3, packed plugin, real `cursor-agent` as the managed CLI, profile `cursor-cli:default`, marker, no `CURSOR_API_KEY` in the env: `openclaw agent --local --model cursor-cli/auto` answered `pong` with the cache under the agent home; after `models auth logout cursor-cli:default --yes` the next run logged the removal, the folder and `command` were gone, `key-cache` was gone, no user `auth.json`; that run failed with `CLI backend executable could not be resolved` (load-time sweep vs. first turn, documented).
- OpenClaw 2026.11.3, the pass-1 Control UI state (profile saved by the dialog, marker, managed real `cursor-agent`), new pack: a turn answered `pong` with `key-cache/cursor/auth.json` under `agents/main/agent/openclaw-all-cli/cursor-cli/` and no `~/.config/cursor/auth.json`; after `models auth logout cursor-cli:default --yes` the next run printed the documented removal line, removed `state/tools/cursor-agent`, unset `command`, dropped `key-cache`; that run failed the same documented way.
- Not run in pass 2: the Control UI dialog in a browser (pass 1 verified it live; the API key method is unchanged), macOS (Keychain not isolated or checked).

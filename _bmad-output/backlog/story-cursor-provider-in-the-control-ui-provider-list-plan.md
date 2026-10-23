---
title: 'Cursor provider in the Control UI provider list'
type: 'feature'
ticket: '2'
created: '2026-10-22'
status: done
baseline_revision: '1e2a9e3848a8f34118b23f94ec101191c69b493a'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred:
  - summary: >-
      The Control UI dialog for both new methods ends with OpenClaw's own "<label> did not return a credential profile." after the report or the config write.
    evidence: |-
      OpenClaw 2026.10.3 `models.authLogin` (models-auth-login.mjs) throws that error when a method returns no profile, after `configPatch` is already applied and the notes are shown (probed through a WebSocket wizard client against the isolated Gateway; the CLI path `models auth login` ends cleanly). Returning a profile would store a placeholder or a second copy of the key in OpenClaw's auth store and change auth resolution, which the ticket's boundary excludes. Settled by the owner's look at a real Control UI and by a host that accepts a profile-less credential-only method.
    location: >-
      src/core/provider-auth.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The `cursor-cli` provider publishes no auth method, so OpenClaw's Control UI "Connect a provider" list does not offer it, and the setup docs do not name the `modelPolicy.allow` requirement.

**Approach:** The provider declares a zero-field "Use the cursor-agent login" method that runs the existing login probe and reports the state, and an optional `CURSOR_API_KEY` method that writes the key to the plugin config `env` for `cursor-cli`. `docs/setup.md` names the allow-list rule and its symptom.

## Boundaries & Constraints

**Always:** Core stays CLI-agnostic (AD-2): Cursor names live only in `src/adapters/cursor/`. The key is never logged or echoed.

**Never:** Change the native login path (`prepareSyntheticAuth`) or the published model catalog; store the key anywhere but the plugin config `env`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Logged in | `cursor-agent status` says logged in | login method reports logged in, no fields, nothing stored | none |
| Not logged in | status says not logged in, or the CLI is missing | login method fails with the fix (`cursor-agent login`) | error text, no key |
| Key set too | `CURSOR_API_KEY` in env or config | the probe ignores it; the report says the key takes precedence | none |
| Key entered | a non-empty key without spaces | config patch sets `plugins.entries.openclaw-all-cli.config.cursor-cli.env.CURSOR_API_KEY`, keeping the rest | none |
| Bad key | empty, or with spaces | refused before any patch | message never holds the key |

</intent-contract>

## Code Map

- `src/core/provider-auth.ts` (new) -- `createAuthMethods`, `createAuthProvider`: the two methods and the provider `registerProvider` takes.
- `src/core/register.ts` -- registers the provider beside the backend. The catalog entry (`src/core/synthetic-auth.ts`) stays as it is.
- `src/core/ports.ts`, `src/adapters/cursor/index.ts` -- optional `apiKeyEnvVar`, `loginCommand` on the adapter.
- `openclaw.plugin.json` -- `providerAuthChoices` (credential-only), which is what lists the provider in the Control UI.
- `test/provider-auth.test.ts` (new), `test/backend.test.ts` (stubs gain `registerProvider`).
- Docs: `docs/setup.md`, `docs/providers/cursor.md`, `README.md`, `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/provider-auth.ts`, `register.ts`, `ports.ts`, Cursor adapter -- the two methods; provider registered -- AC1, AC2
- [x] `openclaw.plugin.json` -- `providerAuthChoices` for both methods -- AC1
- [x] tests for the matrix rows, the config round trip into `readBackendConfig`, the backend `config.env`, and the usage reader -- AC1, AC2
- [x] `docs/setup.md` -- sign-in methods, the allow-list rule and symptom, troubleshooting rows -- AC3
- [x] probe in the isolated OpenClaw and record the finding -- ticket assumption

**Acceptance Criteria:**
- Given the plugin loaded in the isolated OpenClaw, when the provider's auth methods are read, then the list holds a zero-field "Use the cursor-agent login" method that runs the existing probe and reports logged in or not.
- Given the optional API key method, when a key is entered, then it is written to the plugin config `env` for `cursor-cli`, read back by the usage code, and never logged.
- Given `docs/setup.md`, when a reader sets up a gateway with an explicit `modelPolicy.allow`, then it says `cursor-cli/*` must be allowed and what the symptom is.

## Implementation Notes

Route: full by size (about 150 lines of production code), but this worker has no way to launch a subagent, so it implemented in the main session and ran the Quick review lens itself.

Findings from the probe (OpenClaw 2026.10.3, isolated Gateway, fake agent as `command`; no Cursor login on this host, live Control UI not run):
- The Connect list comes from the manifest `providerAuthChoices` (`models.authStatus` `loginOptions`), not from runtime `auth`. The login flow finds methods only in a provider passed to `registerProvider`; the catalog entry's `auth` is not read.
- Method ID `api-key` gets OpenClaw's quick key entry (auth-store profile), so the key method is `api-key-env`.
- `models.authLogin` applies `configPatch` and shows the notes, then fails with "did not return a credential profile" (deferred above). `models auth login --provider cursor-cli --method login` ends cleanly.
- With `modelPolicy.allow: ["openai/*"]`, `--model cursor-cli/auto` fails with `Model override "cursor-cli/auto" is not allowed for agent "main" by agents.defaults.modelPolicy.allow ...`.
- `models status` still shows `synthetic:Cursor CLI native auth` (native path unchanged).

## Plan Change Log

## Review Triage Log

### 2026-10-22 - Review pass
- verdicts: 4 findings - high 0, medium 1, low 2, false 1, maybe-false 0
- findings:
  - `[medium]` `[defer]` The Control UI dialog ends with OpenClaw's "did not return a credential profile" after both methods - host contract of `models.authLogin`; the smallest fix (return a profile) changes auth resolution and stores a second copy of the key, which the boundary excludes. Recorded in `deferred` and documented in `docs/setup.md`.
  - `[low]` `[patch]` `src/core/ports.ts` comment named `CURSOR_API_KEY`, which the core-names-no-CLI test rejects - reworded to `ACME_API_KEY`; `npm run ci` passes.
  - `[low]` `[patch]` The API key method's label differed from its manifest choice label (`CURSOR_API_KEY (API key)` vs `Cursor API key (CURSOR_API_KEY)`) - both are now `Cursor CLI API key (CURSOR_API_KEY)`, with a test that pins them equal.
  - `[false]` `[reject]` `registerProvider` for an ID the catalog entry also exports might clash in the host - `plugins inspect --runtime` shows only the known provenance warning, the Gateway lists the catalog and the methods, and `models status` still resolves the synthetic auth.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own adversarial read of the diff (`lenses_ran` empty). AC1 to AC3 were checked against the diff, the tests, and the probes above.

### 2026-10-22 — Review pass (follow-up, cross-family)
- verdicts: 7 findings — high 0, medium 1, low 2, false 4, maybe-false 0
- findings:
  - `[low]` `[patch]` `src/core/provider-auth.ts`: the "could not tell" error told the user to run `<command> status`, a Cursor subcommand baked into the CLI-agnostic core (AD-2); a next adapter would get a wrong fix — now names the adapter's `loginCommand` (default `<command> login`) and no subcommand; the test pins it for an `acme-agent` adapter whose login is `acme-agent auth`.
  - `[low]` `[patch]` `docs/providers/cursor.md`, the `login` method bullet: nested backticks (`` `... Run `cursor-agent login` ...` ``) broke the inline code — now a double-backtick span.
  - `[medium]` `[defer]` carried — the Control UI dialog ends with OpenClaw's "did not return a credential profile" after both methods; `models-auth-login-*.mjs` line 96 still throws on `profiles.length === 0`, and `provider-auth.ts` still returns `profiles: []`. Kept in `deferred`; not deferred again.
  - `[false]` `[reject]` The `api-key-env` config patch could drop other plugin entries or `plugins` keys if the host replaced a level — the host's `applyProviderAuthConfigPatch` runs `mergeConfigPatch` (deep merge) over the current config (`provider-auth-choice-helpers-*.mjs`), and the earlier probe saw the key land next to the existing `command`.
  - `[false]` `[reject]` `docs/setup.md`'s "OpenClaw hot-reloads plugin config" is unverified — `config-reload-plan-*.mjs` has the rule `prefixes: ["plugins"], kind: "hot", actions: ["reloadPlugins", ...]`, so a write under `plugins.entries.openclaw-all-cli.config` re-registers the plugin with the new `env`.
  - `[false]` `[reject]` `openclaw models auth login --provider cursor-cli --method api-key-env` (named in `docs/setup.md`) might not write the key — the CLI and Gateway paths both go through `runModelsAuthLoginFlow` and `persistProviderAuthResult`, which writes the `plugins` part of the patch in `credentialOnly` mode.
  - `[false]` `[reject]` `assistantPriority` 10 for the key and -10 for the login might promote the key over the recommended login — the host sorts ascending (`(a.assistantPriority ?? 0) - (b.assistantPriority ?? 0)`), so the login comes first.
- Note: no subagent tool on this host either; per the dispatcher's instruction the Quick lens ran as this worker's own independent, adversarial read of the diff since `baseline_revision` (`lenses_ran` stays empty). Checked: AC1 to AC3 against the diff and tests; the key reaches only the config patch (not notes, errors, validator messages, or the console; the manifest marks `cursor-cli.env.*` sensitive); `src/core/` names no CLI (the core-names test passes) and, after the patch, assumes no CLI subcommand.

## Verification

**Commands:**
- `npm run ci` -- expected: passes

## Auto Run Result

**Summary:** The `cursor-cli` provider now registers two auth methods and declares them in the manifest, so OpenClaw's Control UI "Connect provider" list offers it. "Use the cursor-agent login" has no fields and reports the `cursor-agent status` result (a configured `CURSOR_API_KEY` is left out of the probe and named). "Cursor CLI API key (CURSOR_API_KEY)" asks for a hidden key and patches it into `plugins.entries.openclaw-all-cli.config.cursor-cli.env`, keeping the rest of the entry; nothing is logged or stored elsewhere. `docs/setup.md` names the `cursor-cli/*` allow-list rule and its symptom.

**Files changed:**
- `src/core/provider-auth.ts` (new) - the methods and the provider object.
- `src/core/register.ts` - `registerProvider`.
- `src/core/ports.ts`, `src/adapters/cursor/index.ts` - `apiKeyEnvVar`, `loginCommand`.
- `openclaw.plugin.json` - `providerAuthChoices`.
- `test/provider-auth.test.ts` (new), `test/backend.test.ts` - tests.
- `docs/setup.md`, `docs/providers/cursor.md`, `README.md`, `MEMORY.md` - docs and the findings.

**Review:** patches applied 2 (low 2); deferred 1 (medium, host behavior); rejected 1 (false). Independent Quick lens not run (no subagent available). Follow-up review recommended: false (no `high` patched, fewer than two `medium` patched).

**Verification:** `npm run ci` passed (typecheck, 1098 unit tests, build, package test, pack, install smoke). Probed in the isolated OpenClaw 2026.10.3: `models.authStatus` lists both methods; `models.authLogin` through a WebSocket wizard client for both (the key landed in the config next to the existing `command`, and in no log); `models auth login --provider cursor-cli --method login` under a pty; `modelPolicy.allow` symptom. Live Cursor check not run (no Cursor login on this host); the owner's look at a real Control UI is open.

**Residual risks:** The dialog's trailing host message (deferred). The key sits in plaintext in the OpenClaw config and its rotated copies, as with the manual route (documented). Whether a running Gateway applies the key without a restart was not separately probed (docs say to restart if usage stays 0).

**Follow-up review (2026-10-22, cross-family, quick):** patches applied 2 (low 2: the core's "could not tell" message no longer assumes a `status` subcommand; a broken inline code span in `docs/providers/cursor.md`); deferred 0 new (1 carried, medium, the host's trailing dialog message); rejected 4 (false: config patch merge, hot reload of plugin config — host rule `plugins` is `hot` with `reloadPlugins`, which also settles the restart risk above for the host side; CLI path writes the patch; `assistantPriority` order). Files changed: `src/core/provider-auth.ts`, `test/provider-auth.test.ts`, `docs/providers/cursor.md`. Follow-up review recommended: false (follow-up pass, no `high` patched). Verification: `npm run ci` passed (typecheck, 1098 unit tests, build, package test, pack, install smoke). Live Cursor check not run (no Cursor login on this host); the owner's look at a real Control UI is still open.

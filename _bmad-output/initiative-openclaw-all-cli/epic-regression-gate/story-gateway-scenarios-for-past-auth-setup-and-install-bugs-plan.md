---
title: 'Gateway scenarios for past auth, setup, and install bugs'
type: 'feature'
ticket: '9'
created: '2026-11-27'
status: 'in-review'
baseline_revision: '73b2f541689649c47019b499a58fb352c4e35cc3'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The setup side (key checks, provider auth, Test connection, the managed CLI, the update path) is guarded only by unit tests against the plugin's own model of the host (`reproduces = false` for #98, #39, #80 in `test/regression/ledger.toml`), and #39 → #98 already recurred once.

**Approach:** Add Gateway-tier scenario files under `test/regression/gateway/` on the 4.2/4.3 harness that recreate each row's conditions with `fake-cursor-agent` through a real Gateway and the packed plugin, prove each red with one mutation in a scratch worktree, and record #98, #39 and #80 in the ledger as `tier = "gateway", reproduces = true` with `4.9` removed from `planned` (keep `4.6`).

## Boundaries & Constraints

**Always:** the 4.3 patterns (one shared Gateway per file at most, `onStarted` stop, `finishRegression`, fresh session ids, a chat's process found by `chatPids` from its prompt, `FAKE_CURSOR_STORE`, evidence in every assertion message, cleanup of anything a test adds to the shared state such as config keys, profiles or files); each scenario passes on OpenClaw 2026.10.3 and 2026.11.10, or states which versions it applies to and why (2026.11.10 lists no models offline); the whole tier stays under about 10 minutes per version; English; the key used is a dummy string, never a real one.

**Never:** change `src/` (a scenario red on main is a new bug: stop and report it with evidence, as 4.3 did for #105); network access to Cursor or ClawHub; a real `cursor-agent`; weaken an assertion to get green; add a second agent to the shared config (#105); touch `.spike/`.

## I/O & Edge-Case Matrix

| Scenario | Conditions recreated | Expected (green on main) | Red when (mutation) |
|----------|---------------------|--------------------------|----------|
| #98 refused key | a dummy `CURSOR_API_KEY` reaches the plugin (plugin-config env or a saved api-key profile) and the fake refuses it (`FAKE_CURSOR_ABOUT=invalid`); a second case where `status` prints the degraded "Logged in (unable to fetch user details)" line (new knob) | no Gateway surface reports cursor-cli authenticated: the catalog stays at its unauthenticated form, Test connection (`models.probe`) is not `ok`, and the fake log shows the key was checked (`about`) | `probeAuth` returns `available` for any non-empty key (`src/adapters/cursor/index.ts` `probeAuth`), or the degraded regex in `parseStatusOutput` is removed |
| #39 login works | the fake is logged in (default) and no key is stored anywhere | the plugin reports the login usable (full `cursor-cli/*` catalog where the version lists models), and `models.authStatus` has no `cursor-cli` profile (the documented host limit, `docs/providers/cursor.md`); after saving a key through the plugin's api-key method, `models.authStatus` lists a `cursor-cli` api_key profile | the api-key method returns no profile (`src/core/provider-auth.ts`, plan 27 `profiles: [...]`) |
| Test connection (PR #96) | a usable dummy key, `models.probe` for `cursor-cli` (what Control UI Test connection calls) | status `ok`, and the fake log shows exactly one text-only ACP turn for the probe; with the fake failing the turn (new knob if missing), the probe reports a failure that is not a timeout | the provider's stream hook is not registered (`src/core/register.ts` `...createStreamHook(...)`) |
| Managed CLI removed (PR #92) | the fake placed as the managed CLI under `state/tools/cursor-agent/<version>/` with its `.key-saved` marker, `cursor-cli.command` pointing there, no key anywhere, fake logged out | at the next Gateway start the managed folder is gone, `cursor-cli.command` is unset, and the Gateway log has the "Removed … key is gone" line; a second case with a key present keeps the folder | the sweep call at Gateway start is removed (`register.ts` `sweepAndReport`) or the sweep keeps everything |
| #80 update while running | a Gateway running with the installed plugin | the README's running-Gateway command, with the ClawHub spec replaced by the packed `.tgz` (`openclaw plugins install <tgz> --accept-capabilities --force`), exits 0 while the Gateway runs, and a turn after it still answers through the plugin | docs-only fix, no `src/` mutation: record instead that the old documented path (`plugins update` against the running Gateway) is refused or leaves the Gateway on the old build, with its output as evidence |

The managed download itself (hard-coded Cursor URL and sha256 in `src/adapters/cursor/install.ts`) cannot run offline; it stays a unit test and the plan's notes say so.

</intent-contract>

## Code Map

- `test/regression/harness.ts` (`startRegressionGateway` :237 drops `CURSOR_API_KEY` and forwards no `env`; `gatewayCall` :298 hard-codes `--timeout 15000`, too short for `models.probe`), `test/live/harness.ts` `startGateway` (accepts `env`) -- extend only with small helpers two scenarios need; keep the live tier unchanged.
- `test/fixtures/fake-cursor-agent.mjs` -- existing knobs `FAKE_CURSOR_ABOUT=invalid|unknown`, `FAKE_CURSOR_ABOUT_THEN`/`_COUNT`, `FAKE_CURSOR_LOGGED_IN`, `FAKE_CURSOR_NEW_ERROR`, `FAKE_CURSOR_NO_INIT`; `status` output is hard-coded (:104-111). Add a status-text knob and, if needed, an env knob that fails every prompt (the probe prompt is written by OpenClaw, so prompt markers do not reach it), documented in the header; existing unit tests stay green.
- Auth path: `src/adapters/cursor/index.ts` `probeAuth` :110-130, `parseStatusOutput` :96-102; `src/adapters/cursor/auth-probe-cache.ts` (5 min cache, 30 s for `unknown`, so use a fresh key or state per case); `src/core/synthetic-auth.ts` (`catalog.run` :114); `src/core/provider-auth.ts` :449.
- Test connection: `src/core/stream.ts` `createStreamHook`/`createStreamFn` :189-, `register.ts` :258; `models.probe` params `{provider, profileId?, timeoutMs?, agentId?}`; CLI `openclaw models status --probe`.
- Managed CLI: `src/core/managed-install.ts` `managedRoot` :75, `sweepManagedInstall` :472-500 (runs only with the marker, no key anywhere, no turn running, login probe `missing`), `register.ts` :123, :192, :262; state dir is `$SPIKE_DIR/state`.
- Update path: `README.md` Update section :54-70, `test/docs-update-instructions.test.ts`, backlog `bug-update-instructions-say-a-running-gateway-is-refreshed-by-plugins-update*.md`; `scripts/regression.sh` :122 has the `.tgz` path (`.regression/pack`).
- Per-bug context: backlog `bug-provider-reports-authenticated-with-invalid-cursor-api-key*.md`, `bug-provider-card-reads-not-configured-although-the-cursor-agent-login-works*.md`, `story-connecting-cursor-cli-installs-cursor-agent-when-it-is-missing*.md`, initiative `plan-test-connection-through-cli.md`, `plan-27-control-ui-credential-profile.md`, `MEMORY.md`.
- Mutation proof as in 4.3: a `git worktree` under the session scratchpad, one mutation per row, `scripts/regression.sh gateway` there, red/green recorded per row.

## Tasks & Acceptance

**Execution:**
- [x] `test/regression/gateway/*.regression.test.ts` -- new files covering every matrix row (group by shared setup)
- [x] `test/fixtures/fake-cursor-agent.mjs` -- only the knobs the rows need
- [x] `test/regression/harness.ts` -- env pass-through to the Gateway, a per-call timeout, and other shared helpers only if two scenarios need them
- [x] `test/regression/ledger.toml` -- #98, #39, #80 get their gateway tests (`reproduces = true`), `4.9` removed from `planned`
- [x] this plan's Implementation Notes -- per row: how the conditions are made, the mutation, red/green on 2026.10.3, green or stated skip on 2026.11.10

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh gateway` and `--openclaw latest` run, then every scenario passes (or skips with a stated reason) and the tier stays under about 10 minutes per version.
- Given each row's mutation in a scratch copy, when the tier runs there, then that row fails.
- Given `npm test` and `npm run typecheck`, when they run, then both are green with the new ledger entries.
- Given a run ends, then no Gateway or fake process from it is left, and the shared state holds no key, profile or managed folder a scenario added.

## Implementation Notes

**Files.** Three scenario files: `test/regression/gateway/auth-setup.regression.test.ts` (#39, PR #96 Test connection, #98 refused key, #98 degraded status; one shared Gateway), `managed-cli.regression.test.ts` (PR #92, two cases, one Gateway start per case since the check is what a Gateway start does; no shared Gateway), `update-path.regression.test.ts` (#80, two cases, one shared Gateway). Fake knobs (header documented, unit tests green): `FAKE_CURSOR_STATUS_TEXT=<text>` (what `status` prints, exit 0), `FAKE_CURSOR_PROMPT_ERROR=<json string>` (every `session/prompt` answers with that one reply chunk: the probe prompt is OpenClaw's, so a prompt marker cannot reach it); every `status` run now logs `{method:"status", keyed}`. Harness: `gatewayCall(port, method, params, timeoutMs = 15000)` (per-call limit, `models.probe` gets 90 s), `cursorCatalog` (the former private `catalogRows`, exported, now returns the cursor-cli row IDs; #39, #98 x2 and the PR #96 relisting read it), `authLogin(port, authChoice, text)` (the Control UI's Connect provider: ws `models.authLogin` then `wizard.next` until done; #39 and PR #96 use it). No env pass-through to the Gateway was added: every row gets its key through the plugin config's `cursor-cli.env` or an auth profile, so no scenario needed one (the harness keeps dropping `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`). Ledger: #39 (1 test), #98 (2), #80 (2) carry their gateway tests with `reproduces = true`; `4.9` removed from `planned` (#39 and #98 keep `4.6`; #80 has no `planned` left). Every key is a dummy string (`regression-dummy-...`).

**How each row recreates its conditions** (real Gateway, packed plugin, `fake-cursor-agent`; a case that needs other CLI behavior points `cursor-cli.command` at a shim of its own: a `config set` of `plugins.entries.openclaw-all-cli.config.cursor-cli` hot-reloads the plugin ("Plugin replacement applied") and reruns the catalog, and a new command path is also a fresh `auth-probe-cache` key; setting the whole object also drops a case's `env`):
- #98 refused key: shim with `FAKE_CURSOR_ABOUT=invalid`, the dummy key in the plugin config's `cursor-cli.env`. Before: the CLI login lists five cursor-cli rows. After: the shim's first run is logged, `models.list` drops to no cursor-cli row (2026.10.3 lists the provider only while the login probe says `available`), still none 5 s later, the shim saw no `initialize`/`session/new` (no listing ran on the key), `about` ran with the key and no keyed `status`, `models.authStatus` has no cursor-cli profile, `models.probe` is not `ok` (no probe target: a plugin-config key is no target). Restored to the logged-in shim in a `finally`.
- #98 degraded: shim with `FAKE_CURSOR_STATUS_TEXT="Logged in (unable to fetch user details)"`, no key anywhere; same checks, plus `status` ran keyless and no `about` ran.
- #39: the file's shim is logged in (the fake's default) and no key exists: the catalog has the CLI's five rows (`auto`, `fake-fast`, `fake-slow`, `twin`, `twin-high`), the login probe ran `status` with no key, `models.authStatus` has no cursor-cli profile (the documented host limit). Then the API key method through Connect provider (`authLogin`, choice read from `models.authStatus` `loginOptions`): a sensitive text step, the note "accepted the key", `done`, an `about` with the key; then `models.authStatus` must list exactly `cursor-cli:default` `api_key` (polled up to 30 s). `models.authLogout {provider: "cursor-cli"}` in a `finally`, and its effect asserted.
- PR #96 Test connection: a key saved through `authLogin`, `models.probe {provider: "cursor-cli", timeoutMs: 60000}`: `ok` on `cursor-cli:default`; the fake log has exactly one `session/prompt`, on a process of its own whose `session/new` has `mcpServers: []`, one `session/set_mode` `ask`, text blocks only, `keyed` on `initialize`. Then a shim with `FAKE_CURSOR_PROMPT_ERROR` = Cursor's `NonRetriableError: [unauthenticated]` chunk; the test waits until that command relisted the catalog (the probe needs its model there: probing at once gave `format`), then the probe reached the shim with one prompt and reports `auth` (not `ok`, not `timeout`). Logout and the logged-in shim restored in a `finally`.
- PR #92 managed CLI: the fake placed as `<state>/tools/cursor-agent/2026.10.14-fake/cursor-agent` (a launcher that execs a logged-out shim whose log and pid record live outside the folder), the `.key-saved` marker, `cursor-cli.command` pointing there, `agents.defaults.model.primary = cursor-cli/auto` (see facts), no key anywhere. A Gateway start: the Gateway log gets one "Removed <root>: ... that key is gone. cursor-cli.command pointed there and is unset." line, the folder is gone, `command` is unset in `openclaw.json`, and the sweep's login probe ran `status` without a key. Second case: the same with a dummy key in `cursor-cli.env`: after "http server listening (... openclaw-all-cli ...)" plus 6 s, no "Removed" line, launcher and marker present, `command` unchanged. The file removes the managed folder and resets the config in `finally`/`afterAll`. The managed download itself (hard-coded Cursor URL and sha256 in `src/adapters/cursor/install.ts`) cannot run offline and stays a unit test.
- #80: a running Gateway with the installed plugin; a turn first; then the README's running-Gateway command with the ClawHub spec replaced by the packed `.tgz` (`openclaw plugins install .regression/pack/openclaw-all-cli-*.tgz --accept-capabilities --force`): exit 0, "Installed plugin: openclaw-all-cli" ("Applied in Gateway generation N"), `cursor-cli.command` kept, and a turn after it answers through the plugin's fake (its prompt reached one fake process). Second case, the old documented path kept as evidence: `openclaw plugins update openclaw-all-cli` against the running Gateway refreshes nothing: 2026.10.3 exit 0 `Skipping "openclaw-all-cli" (source: archive).`; 2026.11.10 exit 1 `Cannot admit plugins.update ... This operation requires exclusive offline state ownership ... This command is offline-only.`; a turn still answers.

**Facts the build found.**
- OpenClaw 2026.11.10 offline runs no provider catalog at all (the fake is never called at a Gateway start, `models.list` is empty also with `refresh`/`view`), and `models.probe` answers `format` there without starting the CLI. So PR #96 and both #98 cases skip on 2026.11.10 with that reason stated in the test (`ctx.skip` on `gateway.catalog === "empty"`); #39 runs there without its catalog half. A turn on 2026.11.10 with a refused plugin-config key still runs (the fake ignores keys), so no other 2026.11.10 Gateway surface shows the #98 difference.
- `models.probe` targets auth-store profiles only; a plugin-config key gives "No probe targets are available for this provider."
- OpenClaw 2026.10.3 loads this plugin at a Gateway start only when the config uses it: a fresh state with no cursor-cli model starts the Gateway with 14 plugins and no openclaw-all-cli. The first m92 proof run (managed file first in a fresh state, no primary model) was therefore void; the managed file now sets `agents.defaults.model.primary` itself, and was re-proved green first in a fresh state on both versions and red under m92.
- A profile that `openclaw models auth login` (CLI) writes straight into the store while a Gateway runs stays invisible to that Gateway's `models.authStatus` until a restart (the wizard path, which the Control UI uses, is what the scenarios drive).

**NEW BUG, not fixed here (stop-and-report rule): the #39 scenario is red on main on OpenClaw 2026.10.3.** In a Gateway that loaded the plugin at start (cursor-cli as the configured model) on a state whose auth store held no profile, a key saved through Connect provider (`models.authLogin` wizard, status `done`, "accepted the key") never appears in that Gateway's `models.authStatus` (`providers` has no cursor-cli entry; polled 40 s, also with `refresh: true`, also after `models.authLogout` plus a second save), so the provider card keeps reading "Not configured" (the #39 symptom) until a Gateway restart. The profile is in the store: `openclaw models auth list` lists `cursor-cli:default [cursor-cli/api_key]` and `models.probe` in the same Gateway answers `ok` on it. Evidence: the tier run on main (`final status done`, then `expected [] to deeply equal [["cursor-cli:default","api_key"]]` after the 30 s poll), every 2026.10.3 mutation run (fresh state, auth file first), and a manual repro on a fresh state (scratch `explore/repro.sh`: before 0, wizard done, 8 polls over 40 s 0, refresh 0). Discriminating run: the same fresh state with no cursor-cli primary model (the plugin not loaded at Gateway start, so its catalog never read the auth store) shows the profile at once (8 polls 1). Green when the store already held a profile at Gateway start (state reused from earlier runs, profile logged out before the save). 2026.11.10, which never runs the plugin's catalog offline, is green on a fresh state. Suspect: the plugin's read-only store read at catalog time on 2026.10.3 (`src/core/auth-store.ts`, sync `ensureAuthProfileStore(..., {readOnly: true})`) leaves the host serving a stale (empty) snapshot to `models.authStatus`; not verified, since `src/` is out of scope. The #39 assertion is unchanged and stays red on 2026.10.3 until that bug is fixed or triaged. Needs its own bug ticket.

**Mutation proof** (scratch `git worktree` of HEAD with this change copied in, under the session scratchpad, `node_modules` and the OpenClaw/Node dirs symlinked from the main checkout, its own `.regression/` state; its `scripts/regression.sh` was changed there only to accept a file subset, so each run packs the mutated build, installs it into a wiped state, and runs the files named; scripts `mutate.py`, `mutrun.sh`):

| Row | Mutation | 2026.10.3 | 2026.11.10 | Others red in the same run |
|-----|----------|-----------|------------|----------------------------|
| #98 refused key | `probeAuth` returns `available` for any non-empty key (`src/adapters/cursor/index.ts`) | red: the refused shim ran `initialize`/`session/new` and `models.list` kept `auto, fake-fast, fake-slow, twin, twin-high` | skip (no catalog) | #39 (the new bug, not the mutation) |
| #98 degraded | degraded regex removed from `parseStatusOutput` | red: `models.list` kept the five rows after two keyless `status` runs | skip (no catalog) | #39 (new bug) |
| #39 | API key method returns `profiles: []` (`src/core/provider-auth.ts`) | red: wizard `status: "error"`, "Cursor CLI API key (CURSOR_API_KEY) did not return a credential profile." (an earlier assertion than the new bug's) | red: same | PR #96 (it saves a key first) |
| PR #96 | `...createStreamHook(adapter, PLUGIN_ID)` removed from `register.ts` | red: `models.probe` `status: "timeout"` after 85 s (OpenClaw's runtime went to the placeholder URL) | skip (probe answers `format` offline) | #39 (new bug) |
| PR #92 | `void sweepAndReport?.()` at Gateway start removed (`register.ts`) | red: no "Removed" line, folder and marker present, `command` still set (keep case green) | red: same (keep case green) | none |
| #80 | docs-only fix, no `src/` mutation | the old path's output is asserted instead (second #80 case): `Skipping "openclaw-all-cli" (source: archive)` | refused, exit 1, "offline-only" | - |

On main (no mutation) the managed file was also run first in a fresh state on both versions: green (94 s, 92 s).

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh gateway` -- expected: all scenarios pass on 2026.10.3
- `scripts/regression.sh gateway --openclaw latest` -- expected: all pass or stated skips on 2026.11.10
- `npm test` -- expected: green (ledger check included)
- `npm run typecheck` -- expected: clean

**Results (on main plus this change, fresh `.regression/` state each run, 2026-11-27):**
- `scripts/regression.sh gateway` (2026.10.3): 19 passed, 1 failed, exit 1, 607 s (vitest 589 s). The failure is #39, the new bug above (`models.authStatus` shows no cursor-cli profile after a `done` Connect provider save); every other scenario, the 4.3 ones included, is green. An earlier full run gave the same (19 passed, #39 red, 574 s).
- `scripts/regression.sh gateway --openclaw latest` (2026.11.10): 16 passed, 4 skipped (PR #96, #98 x2: no catalog and `models.probe` answers `format` offline, stated in the tests; #12/#46 as before), exit 0, 583 s (vitest 558 s). An earlier full run: same counts, 593 s.
- No fake-cursor-agent or Gateway process left after either run; the shared state holds no auth profile, no `cursor-cli.env` key and no managed `cursor-agent` folder afterwards (checked with `models auth list`, `openclaw.json`, `state/tools/`).
- Budget: the tier now takes 9.5-10 min per version (was 4.5-6.5 min); the new files add about 5 min on 2026.10.3 and 3.5 min on 2026.11.10. At the plan's limit of about 10 minutes, so the next scenarios need a faster tier (ticket 4.10) or shorter waits.
- `npm test`: 71 files passed (26 skipped, the gated tiers among them), 2090 tests passed, ledger check green (80 s). `npm run typecheck`: clean.
- Mutation proof: every row red under its mutation on 2026.10.3, and on 2026.11.10 where the row runs there (table above); the scratch worktree is removed.

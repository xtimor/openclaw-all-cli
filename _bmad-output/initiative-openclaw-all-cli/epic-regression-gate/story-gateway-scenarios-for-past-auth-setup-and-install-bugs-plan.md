---
title: 'Gateway scenarios for past auth, setup, and install bugs'
type: 'feature'
ticket: '9'
created: '2026-11-27'
status: 'in-progress'
baseline_revision: '73b2f541689649c47019b499a58fb352c4e35cc3'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
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
- [ ] `test/regression/gateway/*.regression.test.ts` -- new files covering every matrix row (group by shared setup)
- [ ] `test/fixtures/fake-cursor-agent.mjs` -- only the knobs the rows need
- [ ] `test/regression/harness.ts` -- env pass-through to the Gateway, a per-call timeout, and other shared helpers only if two scenarios need them
- [ ] `test/regression/ledger.toml` -- #98, #39, #80 get their gateway tests (`reproduces = true`), `4.9` removed from `planned`
- [ ] this plan's Implementation Notes -- per row: how the conditions are made, the mutation, red/green on 2026.10.3, green or stated skip on 2026.11.10

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh gateway` and `--openclaw latest` run, then every scenario passes (or skips with a stated reason) and the tier stays under about 10 minutes per version.
- Given each row's mutation in a scratch copy, when the tier runs there, then that row fails.
- Given `npm test` and `npm run typecheck`, when they run, then both are green with the new ledger entries.
- Given a run ends, then no Gateway or fake process from it is left, and the shared state holds no key, profile or managed folder a scenario added.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh gateway` -- expected: all scenarios pass on 2026.10.3
- `scripts/regression.sh gateway --openclaw latest` -- expected: all pass or stated skips on 2026.11.10
- `npm test` -- expected: green (ledger check included)
- `npm run typecheck` -- expected: clean

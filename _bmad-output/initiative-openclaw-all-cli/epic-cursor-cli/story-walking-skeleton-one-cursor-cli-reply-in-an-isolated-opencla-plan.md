---
title: "Walking skeleton: one cursor-cli reply in an isolated OpenClaw"
type: 'feature'
ticket: 1
created: '2026-10-16'
status: done
baseline_revision: '789bc963dfd4c60182f4aab681fa052455d6872c'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      Real Cursor reports models as ACP `models` (ids like `default[]`, `grok-4.7[...]`), not as a configOptions model select, so a non-auto model fails with capability_mismatch.
    evidence: |-
      Seen live on cursor-agent 2026.10.16 (session/new result). `auto` works because it sends no switch.
    location: >-
      src/transports/acp/session.ts
    severity: medium
  - summary: >-
      Cursor reports backend errors (network, quota) as an agent_message_chunk plus stopReason end_turn, so the plugin shows the error text as a normal reply.
    evidence: |-
      Seen live: a blocked host produced "Error: RetriableError: ..." as the reply and a successful turn.
    location: >-
      src/transports/acp/session.ts
    severity: medium
  - summary: >-
      Error code and retryable never reach OpenClaw's failover logic; a dead native session is never dropped.
    evidence: |-
      Unknown whether the host's result event can carry a failover reason or drop the binding on session_expired. Read the SDK parsed-event type.
    location: >-
      src/core/events.ts
    severity: medium (unverified)
  - summary: >-
      Reuse key ignores command, args and env.
    evidence: |-
      Settled by checking whether the host live-session fingerprint covers them.
    location: >-
      src/core/execute.ts
    severity: medium (unverified)
  - summary: >-
      Handshake has no timeout of its own.
    evidence: |-
      Settled by confirming the host watchdog always aborts the turn's signal.
    location: >-
      src/transports/acp/session.ts
    severity: medium (unverified)
  - summary: >-
      An agent-sent current_mode_update could lift the read-only ask mode.
    evidence: |-
      Needs real Cursor ACP traffic. Entries 2 and 4 add permission routing.
    location: >-
      src/transports/acp/session.ts
    severity: high (unverified)
  - summary: >-
      Resuming with cursor-cli/auto may keep the previous session's model.
    evidence: |-
      Needs real Cursor session/load behavior.
    location: >-
      src/adapters/cursor/index.ts
    severity: medium (unverified)
---

## Auto Run Result

Status: blocked. Blocking condition: `no subagents`.

This worker had no tool to launch subagents. The full route's implementing subagent (step 3) and the thorough review lenses (step 4) both require one. The worker therefore wrote the code itself, committed it, and stopped before review. **Review has not run; no `lenses_ran`.** The plan was written after the code, not before: reading the OpenClaw SDK was needed to fix the design, so planning and implementation interleaved. No code was reverted and the implementation was not re-derived.

Implementation commit: `4af9048e17a0e2539e66b7daed1e68890df5beab` (baseline `789bc963dfd4c60182f4aab681fa052455d6872c`). Re-run review with `bmad-build-auto ticket 1.1 thorough` on this plan from a worker that can launch subagents; the diff is `git diff 789bc96 4af9048`.

### What was built

- Scaffold: `package.json`, `tsconfig*.json`, `vitest.config.ts`, `openclaw.plugin.json` (configSchema generated from zod, checked by a test), `scripts/dev-openclaw.sh` (setup, install, run, env), gated `test/live/` harness, `docs/setup.md`, `docs/providers/cursor.md`, README link.
- Core: `src/core/ports.ts` (adapter port `open/prompt/cancel/close`, `NormalizedEvent`, `CliError`, manifest P1-P19), `manifest.ts` (flags derived from the manifest), `events.ts` (`parseJsonlEvent`, stateless), `execute.ts` (live-process reuse per AD-13 subset, abort grace, idle close), `backend.ts`, `register.ts`, `synthetic-auth.ts`.
- Transport: `src/transports/acp/session.ts`, a generic ACP client (initialize, authenticate, new/load, mode, model, prompt, cancel, permission policy, process death).
- Adapter: `src/adapters/cursor/` (manifest, `cursor-agent status` probe, `acp` launch, read-only `ask` mode, fail closed without it, every permission request rejected).
- Composition roots: `src/plugin.ts`, `src/provider-discovery.ts`, `src/registry.ts`.

### Verification run (isolated Node 24.22.0, OpenClaw 2026.10.3)

- `npm run typecheck`: pass. `npm test`: 64 passed, 2 skipped (live). `npm run build`: pass.
- Import-boundary test (AD-2): pass, and shown to fail when a core file imports an adapter and an adapter imports the SDK.
- Plugin load: `plugins inspect openclaw-all-cli --runtime --json` reports `loaded`, `cliBackendIds: [cursor-cli]`, `providerIds: [cursor-cli]`.
- `npm run dev:setup` from an empty directory installed Node and OpenClaw.
- Against a stand-in ACP agent (`test/fixtures/fake-cursor-agent.mjs`, not Cursor): `openclaw agent --local --model cursor-cli/auto --message 'Say hi'` printed the stand-in's reply; a second `--session-id` turn resumed with ACP `session/load`; through a Gateway two turns of one session used one warm process (one `initialize`, two `session/prompt`); a watchdog timeout on a hung turn left no process behind; the gated live test passed against the stand-in.

### NOT RUN (needs a real `cursor-agent` and Cursor login, absent on this host)

- `openclaw agent --model cursor-cli/auto --message 'Say hi'` with real Cursor. This is the ticket's `verify` command.
- Real-Cursor findings that depend on it: that `cursor-agent acp` accepts `authenticate{cursor_login}`, offers an `ask` mode, reports models through a `category: "model"` config option (the plugin uses it for non-`auto` models), the `cursor-agent status` wording, and Cursor's `session/load`.

### Findings the ticket asks to record (stand-in evidence, real Cursor NOT RUN)

- **liveSession:** OpenClaw 2026.10.3 accepts `liveSession: "claude-stdio"` from a third-party plugin's `prepareExecution().execute`. It hands `ctx.liveSession`, queues per session, and the second turn reused the process. AD-8 needs no amendment.
- **Synthetic auth:** works for a third-party plugin with `syntheticAuthRefs`, `nonSecretAuthMarkers`, a `providerCatalogEntry` default-exporting `{id, prepareSyntheticAuth}`, and, necessarily, `providers: ["cursor-cli"]` in the manifest. Without `providers` the entry never loads and `models status` shows `[indeterminate]`. With a logged-in stand-in the route issue disappears; with a missing login or binary it stays `[indeterminate]`.
- **Plugin startup loading (#148584):** with no config naming `cursor-cli`, the Gateway did not load the plugin at startup (14 plugins) and loaded it on the first turn that selected `cursor-cli/...`. With `agents.defaults.model.primary = cursor-cli/auto` it loaded at startup (15 plugins). `cliBackends` activation works; not an issue in 2026.10.3 for these paths.
- **Install:** a `--link` install of the checkout fails (`.spike/` inside the plugin root); install a packed `.tgz`. A copy install needs compiled `dist/`.

### Decisions and spine deviations to review

- Added error codes `capability_mismatch`, `unsupported_version`, `cli_not_found` beyond the 16 failover reasons (AD-11 says "one-to-one"); mapped to `format`/`format`/`unclassified`.
- `src/provider-discovery.ts` and `src/registry.ts` are composition roots beside `src/plugin.ts`; AD-2's table names only `plugin.ts`. `createManifest` lives in `ports.ts` because adapters may import only ports and transports.
- 1.1 runs Cursor in `ask` mode and rejects all permission requests as an interim lockdown (entries 2 and 4 replace it); `nativeToolMode: "always-on"` is declared honestly until then.
- The OpenClaw system prompt, MCP tools, usage, version check (AD-14), concurrency cap, pid lock, and unload close are not in this ticket and are not built.
- `ClientSideConnection` from the ACP SDK is deprecated in 1.8.0 in favor of `client()`; used for its simpler lifetime.
- AD-13 reuse key covers model, cwd, and native session ID; mode, home, and auth profile do not exist yet.

## Review Triage Log

### 2026-10-16 — Review pass
- verdicts: 30 findings — high 1, medium 10, low 13, false 0, maybe-false 6
- findings:
  - `medium` `patch` Blind/Edge: `npm run package` fails on a fresh clone (tsconfig paths into `.spike`, `openclaw` not a devDependency) — verified; patch: docs name `npm run dev:setup` as the prerequisite of `package`
  - `maybe-false` `defer` Blind/Edge/VGap: error `code`/`retryable` dropped by `parseJsonlEvent`, `FAILOVER_REASON_BY_CODE` unused — maybe-false: unknown whether the host's result event can carry a failover reason; settle by reading the SDK's parsed-event type and the architecture's error entry
  - `maybe-false` `defer` Blind: dead native session never recovered (`session/load` fails every turn) — maybe-false: depends on whether the host drops the binding on `session_expired`; same root cause as the dropped error code
  - `medium` `patch` Blind: `retryable: true` for a death mid-turn contradicts AD-11 (tool calls are not tracked) — patch: mid-turn process death reports `retryable: false`
  - `high` `patch` Blind/Edge: `AcpSession.open` has no SIGKILL escalation after SIGTERM, so a CLI that ignores SIGTERM hangs `open` forever — patch: escalate to SIGKILL after `KILL_GRACE_MS` in the failure and abort paths
  - `medium` `patch` Blind/Edge/VGap: `prompt()` finally awaits `settled` unbounded when the consumer stops early and the CLI ignores `session/cancel` — patch: bound the wait, then close the session; add a test
  - `low` `reject` Blind: clean cancel still discards the warm process — intended by AD-11 (close after abort); nothing to change
  - `medium` `patch` Blind/Intent: manifest rows P1, P3, P7, P8, P18, P19 say `match` for unbuilt behavior and disagree with docs (`match (planned)`) — patch: set honest statuses (`approx`/`spike`) in manifest and docs, and the version note
  - `medium` `patch` Blind: minimum Cursor version (`unsupported_version`, 2026.07.06) is not enforced — patch: P19 and docs state it is not yet enforced; enforcement is a later ticket
  - `medium` `patch` Blind/Edge: `parseStatusOutput` fails open on wordings like "You are not currently logged in" — patch: broaden the negation check; test the new wordings
  - `low` `patch` Blind/Edge: `dev-openclaw.sh` version checks (any v24, unanchored grep matches 2026.10.30) — patch: compare exact versions
  - `low` `patch` Blind: `npm run package` leaves a `.tgz` in the repo root and `.gitignore` lacks `*.tgz` — patch: ignore it
  - `maybe-false` `defer` Blind: reuse key ignores command/args/env — maybe-false: depends on whether the host fingerprint covers them; settle by reading `live.fingerprint` derivation
  - `low` `patch` Blind: troubleshooting table lacks rows for errors the code produces — patch: add the rows
  - `medium` `patch` Blind/VGap/Intent: test gaps (process.ts, createConfigValidator, refusal, no `allow_once` option, "not authenticated" probe, abort-grace kill, reusable() guards, `auto` selection test that cannot fail, early consumer stop, test title overclaim, packaged-plugin load check gated behind the live flag, P4/P5 rows with no live test) — patch: add tests; split the no-login `plugins inspect` check out of the live gate; list P4/P5 live tests as not run
  - `low` `reject` Blind: `runCommand` decodes chunks separately and reports an aborted signal as timeout — negligible on `cursor-agent status` output; fix would add a decoder and a branch
  - `medium` `patch` Edge: a missing `cwd` is reported as `cli_not_found` (spawn ENOENT) — patch: check the cwd before blaming the binary
  - `maybe-false` `defer` Edge: `ctx.timeoutMs` ignored during the handshake — maybe-false: AD-11 gives timers to the host, which aborts via `abortSignal`; settle by confirming the watchdog always aborts
  - `medium` `patch` Edge: `assertCurrent()` after `restart()` is inside the try, so a superseded run yields an error record instead of throwing — patch: call it outside the try
  - `maybe-false` `defer` Edge: `current_mode_update` leaving `ask` mid-session would lift the read-only lockdown — maybe-false (high if true): settle with real Cursor traffic; entries 2 and 4 add permission routing
  - `maybe-false` `defer` Edge: resuming with `cursor-cli/auto` keeps the previous session's model — maybe-false (medium if true): needs real Cursor `session/load` behavior
  - `low` `patch` Edge: `isCoreRecord` accepts `"event": null` and then throws in `event.kind` — patch: reject null
  - `low` `reject` Edge: `parseJsonlEvent` switch has no default — the writer is this same module; an unknown kind cannot occur, and a default branch adds code for nothing
  - `low` `reject` Edge: a later ChildProcess 'error' marks a live process exited — unlikely, and the fix adds branches
  - `low` `reject` Edge: authMethods without `cursor_login` skips authenticate and later fails as `server_error` — unlikely with Cursor; fix adds a branch
  - `low` `reject` Edge: only `*_always` permission options are answered as cancelled — Cursor offers `*_once`; fix adds a branch
  - `low` `reject` Edge: duplicate result after a result — `prompt()` emits one terminal event, so the path is unreachable
  - `medium` `patch` Intent: live test and the verify command differ (`--local`, weak assertion) and the docs disagree — patch: docs state which form is the verify command and why `--local` is used by the test
  - `low` `patch` Intent: #148584 finding is in the plan only — patch: add the startup-loading line to MEMORY.md
  - `low` `reject` Intent: extra composition roots and a lifecycle larger than the minimum scaffold — the plan records the deviation; the scope is a descriptive finding, not a defect
  - Lenses reported grouped findings; rows above merge duplicates from several lenses under the same root cause.

### 2026-10-16 — Review pass (follow-up)
- verdicts: 25 findings — high 0, medium 5, low 17, false 2, maybe-false 1
- findings:
  - `low` `patch` Test title says retryable but expects `retryable: false` — renamed (576f3af)
  - `false` `reject` Blind/Edge: `live.restart()` moved out of the try is unintended — the host's `restart()`/`register` throw failover errors on purpose (read in the host registry), so propagating them as throws is correct
  - `medium` `patch` VGap: no test rejects `live.restart()` — added a test that `execute` rejects with the host error and yields no record (576f3af)
  - `low` `reject` Blind: `KILL_GRACE_MS` reused as the cancel-ignored timeout overlaps `abortGraceMs` — cosmetic; a new option adds surface
  - `low` `patch` Blind/VGap: `parseStatusOutput` docstring stale and positive wordings untested — docstring updated, two assertions added (576f3af)
  - `medium` `patch` Blind/Intent: parity matrix not updated with manifest/docs; P4/P5 `match` without live test; P2 wording unconfirmed — matrix, manifest and docs made equal (576f3af)
  - `low` `patch` Blind: MEMORY.md misses the new fixture controls — listed (576f3af)
  - `low` `reject` Blind: setup.md should use a pinned devDependency instead of `dev:setup` — design choice already routed in pass 1; docs name the prerequisite
  - `low` `patch` Blind/Intent: setup.md uses internal wording and misplaces "isolated" (`--local` vs Gateway), vague report line — reworded (576f3af)
  - `low` `patch` Blind/VGap: isolated-OpenClaw test checks the last `dev:install`, skips silently — docblock note added; rebuild-in-test is a larger harness change and not worth it here
  - `low` `reject` Blind/Edge: `assertDirectory` message for a file or EACCES — unlikely path; fix adds branches
  - `low` `reject` Blind: new execute tests leave effects unchecked (restart ran, handle removed, error type) — the behavior is covered by the added restart and register tests
  - `low` `reject` Blind: process.test pins aborted == timeout and misses cap/cwd cases — negligible
  - `low` `patch` Blind: fake agent cancel short-circuit hard to read — plain `if` (576f3af)
  - `low` `reject` Blind: MEMORY.md cites #148584 without a link — the project already uses that form for the OpenClaw issue
  - `medium` `patch` Edge/VGap: SIGKILL fallback never exercised (fake exits on stdin EOF) and no test aborts `open` — added the stdin-EOF knob, a SIGKILL test, and an abort-during-handshake test (576f3af)
  - `medium` `patch` Edge: grace timer starts only after `cancel()` resolves, so a stalled cancel write blocks the finally — timer now starts first (576f3af)
  - `maybe-false` `defer` Edge/Intent: `cursor-cli/auto` keeps a non-auto model — duplicate of the pass-1 deferred item; carried, not re-deferred
  - `low` `reject` Edge: status wording anchoring ("token not refreshed, authenticated", "logged out" mentioned elsewhere) — speculative wordings; real `status` text unconfirmed
  - `low` `reject` Edge: `parseJsonlEvent` default branch and array events — carried from pass 1 (writer is this module)
  - `false` `reject` Edge: `{kind:'error'}` without an error object throws in the parser — the only writer always sets `error`; unreachable
  - `low` `patch` Edge: setup.md reinstall glob matches several archives — exact archive named (576f3af)
  - `medium` `patch` VGap: `adapter.open` spawns before `live.register`, which can throw and orphan the process — register failure now closes the session and rethrows; test added (576f3af)
  - `low` `reject` VGap: `retryable: false` on the `died` promise has no effect — the catch rebuilds the error; behavior is right
  - `low` `reject` Intent: tests exercise the stand-in, not Cursor — descriptive; live check recorded NOT RUN

## Auto Run Result (review pass 1)

- Review: thorough, four lenses, 30 findings (high 1, medium 10, low 13, maybe-false 6). Patched in 4ce9618 by the implementing worker; 5 items deferred; low findings rejected with reasons in the triage log.
- Patched counts by verdict: high 1 (no SIGKILL escalation in `open`), medium 8, low 4.
- Follow-up review recommended: true. Unverified risk: the new `terminate()`/grace-close paths in `src/transports/acp/session.ts` and the idempotent live-handle close in `src/core/execute.ts` were written after the first review.
- Verification (orchestrator, isolated Node 24): `npm run typecheck`, `npm run build` clean; `npx vitest run` 83 passed, 1 skipped (live test, needs real Cursor).
- Residual risk: the live Cursor check (`openclaw agent --model cursor-cli/auto --message 'Say hi'`) is NOT RUN; all Cursor-specific behavior was tested only against the stand-in agent.

## Auto Run Result (follow-up pass)

- Follow-up review (thorough, four lenses) on the fix commit: 25 findings, no `high`. Patched in 576f3af (register-failure cleanup, cancel grace timer, SIGKILL and abort-during-open tests, matrix/manifest/docs equal, small test and doc fixes); the rest rejected with reasons.
- Follow-up review recommended: false. No high patched; the work converged.
- Verification (orchestrator, isolated Node 24): `npm run typecheck` and `npm run build` clean; `npx vitest run` 86 passed, 1 skipped (live test, needs real Cursor).
- Residual risks: live Cursor check NOT RUN; real `cursor-agent status` wording, `ask` mode, model list and `session/load` unconfirmed; 5 deferred items listed in frontmatter.

## Live Cursor check (2026-10-17)

cursor-agent 2026.10.16 installed on the host; `CURSOR_API_KEY` set; isolated OpenClaw 2026.10.3, Node 24.
- Found and fixed: `authenticate{cursor_login}` fails with an API key ("Failed to open browser"). The adapter now skips it when `CURSOR_API_KEY` is set.
- Confirmed: `initialize` (loadSession true, authMethods cursor_login), `session/new` with modes agent/plan/ask, `cursor-agent status` says "Not logged in" without a login. The plugin starts a live session and runs the turn in the real Cursor.
- Network: the proxy first blocked `agentn.global.api5.cursor.sh`; after the host was allowed the turn ran.
- Confirmed live: `session/load` of an id Cursor does not know returns "Invalid params", so a stale binding fails every turn (deferred item 2).

### Live result (verify met)

- `openclaw agent --model cursor-cli/auto --message 'Say hi'` through a Gateway (no `--local`) printed Cursor's reply. `--local` also works. Live tests (`OPENCLAW_ALL_CLI_LIVE=1`) pass: reply and plugin load.
- liveSession: works. Second turn of one session logged `reuse=reusable` and no new live session start, so the warm process was reused through the Gateway; with `--local` each call is a new process and the second turn resumed via `session/load` with context kept.
- Synthetic auth: works. Turns run with no auth profile, only `CURSOR_API_KEY` in the environment.
- Plugin startup loading (#148584): loads on the first turn that selects `cursor-cli/...`, and at Gateway start when the config names a `cursor-cli/...` model (stand-in evidence, then confirmed with the real Cursor run).
- Fixes found by the live run: login step skipped with an API key; the live test uses a fresh session id each run.

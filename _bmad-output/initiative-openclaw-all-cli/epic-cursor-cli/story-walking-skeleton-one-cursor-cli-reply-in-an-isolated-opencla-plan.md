---
title: "Walking skeleton: one cursor-cli reply in an isolated OpenClaw"
type: 'feature'
ticket: 1
created: '2026-10-16'
status: in-review
baseline_revision: '789bc963dfd4c60182f4aab681fa052455d6872c'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
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

# Review — Currency & Reality Check

- **Spine:** `architecture-openclaw-all-cli.md` (draft, 2026-10-15)
- **Lens:** Was every committed decision checked against the web or the installed reality, rather than asserted from memory? Are versions current, do named technologies exist and fit, and are the live defaults the spine leans on correct?
- **Reviewed:** 2026-10-15
- **Reality used:** OpenClaw 2026.10.3 installed at `.spike/openclaw/node_modules/openclaw` (dist `.d.ts`/`.mjs`, docs, package.json); `cursor-agent` 2026.10.14-941492e (only `--help` and a bundle grep); `npm view` and `npm pack` against the live registry.

## Verdict

The names and versions are all real and current. Every Stack row matches npm `latest`, and every OpenClaw symbol the spine names exists in 2026.10.3. The ADs, though, rest on research that was partly read from GitHub `main` and on a spike that never drove OpenClaw. The installed 2026.10.3 already provides several things the spine has the core build itself: per-session lanes with host-owned process lifecycle, session-binding persistence, watchdogs, an exact tool-availability contract, and a per-run MCP grant. Its behavior contradicts or duplicates AD-5, AD-8, AD-9, and AD-11. Fix those four before stories start.

## Verified facts

| Claim in spine | Status | Evidence |
| --- | --- | --- |
| Node `≥ 24.16 < 25, or ≥ 26.1` | ✅ exact | `package.json` engines: `>=24.16.0 <25 \|\| >=26.1.0` |
| OpenClaw 2026.10.3 | ✅ current | npm `latest` = 2026.10.3 (`beta` 2026.10.10-beta.1, `extended-stable` 2026.9.33) |
| TypeScript 7.0.2 | ✅ current | npm `latest` = 7.0.2 |
| vitest 5.0.5 | ✅ current | npm `latest` = 5.0.5 |
| `@agentclientprotocol/sdk` 1.8.0 | ✅ current | npm `latest` = 1.8.0 (published 2026-10-09); ESM-only; exports `ClientSideConnection` and `ndJsonStream` from `.`; peer `zod ^3.25 \|\| ^4` |
| `@modelcontextprotocol/sdk` 1.32.1 | ✅ current (v1 line) | npm `latest` = 1.32.1, not deprecated |
| cursor-agent 2026.10.14-941492e | ✅ | `cursor-agent --version` |
| `api.registerCliBackend` | ✅ | `registerCliBackend: (backend: CliBackendPlugin) => void` |
| `prepareExecution` returning `execute` | ✅ | `CliBackendPreparedExecution.execute?: CliBackendExecute`, which yields `AsyncIterable<Record<string, unknown>>` |
| `requestToolPermission` in the execute context | ✅ | `CliBackendExecuteContext.requestToolPermission(request) → {behavior:"allow",updatedInput} \| {behavior:"deny",message}` |
| `bundleMcpMode: "gemini-system-settings"` | ✅ | `CliBundleMcpMode = "claude-config-file" \| "codex-config-overrides" \| "gemini-system-settings"`; the file path is passed in env `GEMINI_CLI_SYSTEM_SETTINGS_PATH` |
| `hostOwnedTools` | ✅ | `CliBackendPluginBase.hostOwnedTools?: readonly string[]` ("Applies only with bundled loopback MCP, outside exact or node runs") |
| `serialize` | ✅ | `CliBackendConfig.serialize?: boolean` |
| `syntheticAuthRefs` | ✅ (but see M3) | manifest field; `docs/plugins/manifest.md:240` |
| `setup.cliBackends` | ✅ | `docs/plugins/cli-backend-plugins.md:85`; drift diagnostics in `setup-registry-*.mjs:673` |
| Plugin config at `plugins.entries.<id>.config` | ✅ — drop the `[ASSUMPTION]` | `docs/cli/plugins/install.md:160`, plus several plugin docs |
| `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` | ✅ | 195 and 57 runtime references; `plugin-sdk/state-paths` docs |
| `cursor-agent acp` | ✅ (hidden) | not listed in `--help`; `cursor-agent acp --help` prints "Start the Cursor Agent as an ACP (Agent Client Protocol) server" and takes no options |
| `CURSOR_CONFIG_DIR` read by 2026.10.14 | ✅ | `index.js`: `CURSOR_CONFIG_DIR` → else `$XDG_CONFIG_HOME/cursor` → else `~/.cursor` |
| `CURSOR_DATA_DIR` read by 2026.10.14 | ✅ | `index.js`: `CURSOR_DATA_DIR` → else `~/.cursor` (with `projects/` under it); also `3676.index.js`, `9310.index.js` |
| "CLI login stays shared" (AD-6) | ✅ | the credential store is the macOS keychain, with a darwin fallback of `~/.cursor/auth.json` under `homedir()`; it does not follow `CURSOR_CONFIG_DIR` |

## Findings

### H1 — AD-8 rests on an outdated premise: 2026.10.3 gives third-party backends per-session lanes and host-owned process lifecycle

- **Spine says:** use `serialize: false`, and the core runs its own in-memory per-`(backendId, agentId, sessionKey)` lane, cap, and slot reclaim. AD-11 adds that the core owns spawn and kill.
- **Where that came from:** research claim OC25 ("liveSession closed to claude-stdio; per-agent locking must live in plugin"), read from GitHub `main`.
- **Installed reality (2026.10.3):**
  - `resolveCliRunQueueKey` (`dist/helpers-*.mjs:38`) returns `${backendId}:owner:${ownerKey}` whenever `liveSession !== undefined` and an owner key exists. That check is not gated on the `claude-cli` id. The owner key is `sha256({agentAccountId, agentId, authProfileId, sessionId, sessionKey})` (`buildCliLiveOwnerKey`).
  - `acceptsCliLiveSession` (`cli-live-session-registry-*.mjs:1749`) requires only three things: `executionTarget.kind === "plugin"` (meaning `prepareExecution` returned an `execute`), `backend.liveSession !== undefined`, and `output === "jsonl"` with `input === "stdin"`. There is no backend-id check.
  - When those hold, `execute` receives `ctx.liveSession: CliBackendLiveSessionCapability` with `register`, `activate`, `restart`, `remove`, and `current`. The docs (`plugins/cli-backend-plugins.md:297`) require transports to `await liveSession.restart()` before replacing a process.
  - The type still limits `liveSession` to the single value `"claude-stdio"`, so the name is Claude-flavored even though the gating is generic.
- **Risk:** the core builds a second lane and lifecycle owner in parallel with the host's. The host may also refuse replacement ("A fresh CLI session must wait for its predecessor's cleanup") in ways the core's in-memory lanes can't see.
- **Fix:** add a spike: register `cursor-cli` with `liveSession: "claude-stdio"`, `output: "jsonl"`, `input: "stdin"`, and a custom `execute`. Confirm the per-owner queue key and that the `liveSession` capability arrives.
  - If it works, rewrite AD-8 and AD-11: the host owns the per-session lane and the process lifecycle (`register`, `activate`, `restart`), and the core keeps only the per-backend concurrency cap and the ACP-specific close.
  - If it doesn't, record the observed reason in AD-8.

### H2 — AD-4 and AD-9: the MCP Bearer token is per run, but the warm ACP session fixes `mcpServers` once

- **Spine says:** the core reads the URL and Bearer header from the Gemini settings file and gives the adapter one `McpServerSpec`, which goes into ACP `session/new.mcpServers` (AD-7). The process is one per live session (AD-4).
- **Installed reality:**
  - `docs/gateway/cli-backends.md:520` says the loopback server is "authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt".
  - `bundle-mcp-gemini` (`prompt-context-*.mjs:120-202`) resolves header env placeholders into literal `Bearer …` values in the file. Per attempt, `writeGeminiMcpCaptureSettings` writes a new temp file that adds an `x-openclaw-cli-capture-key` header to `mcpServers.openclaw.headers`, and swaps `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to point at it.
  - The host closes managed live sessions with the reason `"mcp-capture-rotation"` (`execute.runtime-*.mjs:2667`).
- **Not verified:** the spike used a static Bearer stand-in, and OpenClaw was "not yet driven" (`spike-cursor-transport.md:3`).
- **Risk:**
  - On turn 2 a warm `cursor-agent acp` session sends the turn-1 token and capture key, so tools fail or bind to the wrong run.
  - Reading the file in `prepareExecution` (`ctx.env`) gets the pre-capture file, not the attempt file.
- **Fix:**
  - In AD-9, read `GEMINI_CLI_SYSTEM_SETTINGS_PATH` from `CliBackendExecuteContext.env` on every turn.
  - Fingerprint the `openclaw` server headers and URL. When they change, either re-open the session (ACP `session/load` or `resumeSession` with the new `mcpServers`) or restart the process via `liveSession.restart()`.
  - Make a live test that runs two consecutive tool turns on one warm session a gate for CAP-6.

### H3 — AD-5 duplicates OpenClaw's own session-binding owner

- **Spine says:** the core stores `(backendId, agentId, sessionKey) → nativeSessionId` in plugin state, and adapters never persist anything.
- **Installed reality:**
  - OpenClaw "Persists session ids per backend so follow-ups reuse the same CLI session" (`gateway/cli-backends.md:124`).
  - `CliBackendExecuteContext` already carries `sessionId?` and `useResume`.
  - Session ids reported through `sessionId` or `result.sessionId` records "participate in resumed-session and fork persistence" (`cli-backend-plugins.md:408`).
  - The host also does auth-epoch invalidation (`authEpochMode`), `freshSessionRecovery`, `/reset`, fork-with-checkpoint, and history account boundaries on that binding.
- **Risk:** AD-5's stated goal is to prevent "two owners of the session-to-chat mapping", and as written it creates exactly that. A plugin-side map won't be cleared on `/reset`, an auth change, or a fork.
- **Fix:**
  - Rewrite AD-5 so the host binding is the source of truth. The core yields `sessionId` records and reads `ctx.sessionId` and `ctx.useResume`.
  - Keep a plugin keyed store only for data the host doesn't hold. If one is kept, use `api.runtime.state.openKeyedStore({ namespace, retention: "retained" })`, or `overflowPolicy: "reject-new"` so records are never evicted. For deferred code use `createPluginStateKeyedStore` from `openclaw/plugin-sdk/plugin-state-store-runtime`.
  - Don't use `plugin-sdk/runtime-store`, which is a process-local runtime slot, or `plugin-sdk/plugin-state-runtime`, which is private-local after July 2026.

### M1 — AD-11: the host already owns watchdogs, timeouts, cancellation, and the failure vocabulary

- **Installed reality:**
  - "OpenClaw retains cancellation, watchdogs, session policy, and MCP grant ownership" (`cli-backend-plugins.md:293`).
  - `execute` receives `abortSignal`, `timeoutMs`, and `assertCurrent`. The no-output watchdog is configured through `config.reliability.watchdog.{fresh,resume}`.
  - Failure classification uses the frozen `FailoverReason` list (`auth`, `rate_limit`, `timeout`, `session_expired`, `context_overflow`, …). Only `session_expired` proves a binding dead under `freshSessionRecovery: "invalidated-only"`.
- **Fix:**
  - In AD-11, the core honors `abortSignal` and `timeoutMs` and sets `reliability.watchdog` instead of running its own watchdog. Any inner ACP-level timeout is only a guard.
  - Map `CliError.code` onto `FailoverReason` and emit it via `result.errorText` or a thrown error the host classifies.
  - Decide `freshSessionRecovery` explicitly.

### M2 — AD-9 "Restricted runs" reinvents the host's exact tool-availability contract

- **Installed reality:**
  - Restricted runs arrive as `ctx.toolAvailability = { native, openClaw }`. The backend declares `nativeToolMode: "selectable"` together with `toolAvailabilityEnforcement: "prepare-execution"`, and returns `toolAvailabilityEnforced: true` from `prepareExecution`. A missing acknowledgement fails closed (`cli-backend-plugins.md:333-353`).
  - The host limits the MCP config and grant to `toolAvailability.openClaw` itself: "plugins must not translate it".
  - A backend that can't disable all native tools declares `nativeToolMode: "always-on"`, and the host refuses restricted runs for it.
- **Fix:** name these fields in AD-9 and AD-10. The adapter only stages the per-agent native policy (`cli-config.json`) from `toolAvailability.native`. The host, not the adapter, refuses the run.
- **Also:**
  - Add `sideQuestionToolMode` and `isolatesInstructionsWithExactTools` to the manifest rows, or mark them as gaps.
  - Note that `hostOwnedTools` only applies with bundled MCP, outside exact or node runs.

### M3 — AD-1: the "synthetic auth" mechanism is not named, and the Structural Seed is missing its entry

- **Installed reality:**
  - `syntheticAuthRefs` only lists refs that get probed. The hook itself is `prepareSyntheticAuth` or `resolveSyntheticAuth` on a provider entry.
  - `claude-cli` does this through the manifest field `providerCatalogEntry: "./provider-discovery.js"`. That module exports `{ id: "claude-cli", prepareSyntheticAuth }`, runs `claude auth status`, and returns a non-secret marker listed in `nonSecretAuthMarkers`.
  - `nonSecretAuthMarkers` is documented as "Bundled-plugin-owned", so whether a third-party plugin's marker is honored is unverified.
  - The runtime also duck-types `resolveSyntheticAuth` on a CLI backend (`synthetic-auth.runtime-*.mjs:50`), but that field isn't in the public `CliBackendPlugin` type.
- **Fix:**
  - Add `providerCatalogEntry` and a lightweight discovery module to the Structural Seed. Probe with `cursor-agent status`, which is listed in `--help` as `status|whoami`.
  - Spike whether a third-party marker counts as auth. If it doesn't, record the fallback.

### M4 — AD-4 doesn't record why OpenClaw's built-in ACP "cursor" harness was rejected

- **Installed reality:** OpenClaw ships ACP Agents (acpx) with a built-in `cursor` agent running `cursor-agent acp` (`docs/tools/acp-agents-setup.md:37`, `quickstart.md:86`), plus `plugin-sdk/acp-runtime*` subpaths. The research skipped this explicitly: "acpx … with cursor-agent: not searched, because of the tool budget" (`digests/tool-loop-r2-1.md:63`).
- **Assessment:** it probably doesn't fit. ACP Agents are `/acp spawn` and `sessions_spawn({runtime:"acp"})` sessions rather than `/model` refs (CAP-1), and the `acp-runtime` `.d.ts` files are excluded from the published package. That is still an unrecorded decision about an existing technology.
- **Fix:** add one sentence to AD-4 saying why acpx/ACP Agents and `plugin-sdk/acp-runtime` aren't used, and keep the acpx `cursor` defaults as a cross-check for the spawn command.

### L1 — Stack is missing `zod` and `@types/node`

- `@agentclientprotocol/sdk` 1.8.0 requires the peer `zod ^3.25 || ^4`; current is 4.6.7. Add a row.
- Pin `@types/node` to the lowest supported Node line (24.x) instead of npm `latest` (26.6.5), so code doesn't use APIs that are missing on 24.16.

### L2 — The Deferred note on ACP usage is overstated

- ACP schema 1.8.0 has `PromptResponse.usage` (marked UNSTABLE: `inputTokens`, `outputTokens`, `thoughtTokens`, `totalTokens`) and a `usage_update` session update (context `used`/`size`, `cost`).
- The spike only showed that Cursor 2026.10.14 doesn't populate usage.
- **Fix:** reword to "Cursor's ACP doesn't populate `usage` today", and list ACP `usage`/`usage_update` as the first source to check before `_meta`, the transcript, or `-p`.

### L3 — `cursor-agent acp` is hidden; the spine needs a version guard

- `acp` doesn't appear in top-level `--help`. Hidden commands can change without notice, and OpenClaw's acpx docs mention installs that expose `agent acp` instead.
- **Fix:** have the Cursor adapter probe `cursor-agent --version` and `cursor-agent acp --help` once at startup and fail with a clear `CliError` on mismatch. Record the tested floor in the manifest rather than only in the Stack.

### L4 — Packaging details are unchecked against the install docs

- OpenClaw docs use `peerDependencies.openclaw: ">=2026.3.24-beta.2"`, and `openclaw doctor` relinks the host `openclaw` into plugins that declare it as a peer (`cli/plugins/inspect-and-diagnose.md:98`). The Stack's "OpenClaw (peer) 2026.10.3" doesn't say whether that is an exact pin or a floor.
- **Fix:** state `>=2026.10.3`. Add `openclaw.compat.pluginApi`/`minGatewayVersion` and `openclaw.build.openclawVersion` to the `package.json` seed.
- If the plugin's config is absent or invalid, install records it as disabled (`cli/plugins/install.md:160`), so `configSchema` should accept an empty object.

### L5 — AD-6: resolve the state directory through the SDK, not the env var

- **Fix:** use `api.runtime.state.resolveStateDir(process.env)` (or `plugin-sdk/state-paths`) so the legacy and `OPENCLAW_CONFIG_PATH` rules apply. Keep `OPENCLAW_STATE_DIR` only in the test-environment note.

### L6 — `@modelcontextprotocol/sdk` v1 vs. the v2 split

- 1.32.1 is the current v1 release and isn't deprecated, but the v2 split packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.3.1, created 2026-04) exist.
- This is fine for a dev-only test server. Note the choice so a later bump doesn't silently cross majors.

### L7 — Unmentioned host capability

- `CliBackendExecuteContext.requestUserInput` (structured questions) exists. It could serve ACP elicitation or Cursor ask-question flows. Consider a parity row for it.

## Recommended spine edits (summary)

1. **AD-8 and AD-11:** spike `liveSession` on a third-party id, then either adopt the host lane and lifecycle or record why not.
2. **AD-9 and AD-4:** read the MCP settings file from the execute env on every turn, and rotate the ACP session when headers change.
3. **AD-5:** make the host binding authoritative; keep a plugin keyed store only for data the host doesn't hold.
4. **AD-11:** honor `abortSignal`, `timeoutMs`, and `reliability.watchdog`; map errors to `FailoverReason`.
5. **AD-9 and AD-10:** use `nativeToolMode`, `toolAvailabilityEnforcement: "prepare-execution"`, and `toolAvailabilityEnforced`.
6. **AD-1 and the Seed:** add `providerCatalogEntry` with `prepareSyntheticAuth`, and verify third-party marker acceptance.
7. **AD-4:** record why OpenClaw's ACP Agents `cursor` harness is not used.
8. **Stack and Conventions:** add `zod` and `@types/node`; state the peer floor; drop the `[ASSUMPTION]` on the config path.

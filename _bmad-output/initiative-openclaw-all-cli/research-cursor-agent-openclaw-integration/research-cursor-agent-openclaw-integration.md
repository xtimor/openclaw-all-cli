---
title: 'Technical research: cursor-agent as an OpenClaw model provider'
type: 'technical'
topic: 'cursor-agent as an OpenClaw model provider'
decision: 'How the plugin connects cursor-agent to OpenClaw (contract, tool bridging, session resume, per-agent isolation) and which README criteria are feasible as written'
source: 'run'
status: complete
preset: 'standard'
validation: 'normal'
created: '2026-10-15'
updated: '2026-10-15'
claims_verified: 23
claims_unverified: 22
claims_disputed: 2
---

# Technical research: cursor-agent as an OpenClaw model provider

**Decision this research serves:** How the plugin connects cursor-agent to OpenClaw (contract, tool bridging, session resume, per-agent isolation) and which README criteria are feasible as written.

**Evidence:** 47 claim entries in the research log, of which 23 are verified by two independent sources, 22 rest on one source, and 2 are disputed. A citation check lowered the confidence of four recommendations (2, 4, 5, 7). All sources were accessed 2026-10-15.

## Executive summary

**Build `cursor-cli` as a standalone OpenClaw CLI backend plugin (`api.registerCliBackend`) on OpenClaw ≥ 2026.10.3 and cursor-agent ≥ 2026.07.06. Keep the transport behind the backend swappable: spawned `cursor-agent` first, `@cursor/sdk` as the fallback.** All five criteria are reachable:
- C3 needs a live spike.
- C2 holds only for history written under one Cursor API key profile.
- C5 needs rewording, as does the README's bar "the CLI only produces the reply".

### Criteria verdicts

| # | README criterion | Verdict | Needs | Condition |
|---|---|---|---|---|
| C1 | Like a native model | Feasible | None | Custom `parseJsonlEvent` for Cursor's stream-json; usage keys have drifted across versions |
| C2 | Session carries over | Limited | Cursor API key profile | Reseed replays only history accrued under the same auth-profile fingerprint from an empty start; earlier API-model or other-backend turns get a metadata note. Capped at 12,288 characters by default |
| C3 | MCP, skills, tools in place | Feasible with a spike | Spike (Q1 or Q2) | Tools via loopback MCP; skills via the system-prompt catalog; built-ins denied but not removed (CLI), or removed (SDK) |
| C4 | Isolation on request | Feasible | None | Per-agent `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` + cwd; login stays shared |
| C5 | Agents don't interfere | Mostly feasible | Rewording | The plugin owns per-session locks; the shared login, a shared (apparently telemetry) helper process, and a few home-dir writes remain |
| — | Bar: "the CLI only produces the reply" | Not as written | Rewording | The CLI runs the tool loop, with OpenClaw's tools only |

### What drives this

1. **No official Cursor surface lets OpenClaw own the tool loop.** Neither does the built-in `claude-cli` backend, the benchmark this plugin is measured against. `claude-cli` lets Claude Code drive the loop: it calls OpenClaw tools through a loopback MCP server, and OpenClaw does not inject tool calls into the CLI protocol [2]. The only truly host-owned loop found uses Cursor's private `agent.v1` RPC [32]; its author warns of terms-of-service and drift risk (no Cursor ToS text was found). Read the bar "the CLI only produces the reply" as: the CLI runs the loop, but only with OpenClaw's tools, and OpenClaw owns the policy, transcript, and session.
2. **Turning off cursor-agent's built-in tools is the weak spot.** The CLI cannot remove built-in tools. It can only deny them through `cli.json` allow/deny rules. In `-p` mode, shell commands not on the allowlist are denied silently, and file changes are only proposed [14][17][19]. `@cursor/sdk` can remove them (`tools: ["mcp"]`) and inject MCP servers per run [23], but requires an API key [23].
3. **OpenClaw's plugin hooks are enough, but the plugin must own the MCP bridge (for either transport), per-session locking, and a Cursor auth profile for history replay** [3][4][5].

**Biggest caveat:** the tool bridge is an inference from source code and is untested. Neither `prepareExecution` nor a custom `execute` receives the loopback MCP URL, so both transports must read it from the Gemini-mode settings file [3][4]. The CLI transport would then write the project `.cursor/mcp.json` and deny built-ins in `cli.json`; the SDK would pass it as an inline server. Spike it before the spec settles on the transport.

**Stale evidence:** the cursor-agent path and auth findings come from the six-month-old local 2026.04.17 build [18], and their re-check date (2026-07-01) has passed. Re-verify them on the current cursor-agent before the spike. The installed build has to be updated for the spike anyway.

## 1. OpenClaw side

**Extension point.** A plugin uses `definePluginEntry` with `api.registerCliBackend(...)`, declares `cliBackends: ["cursor-cli"]` in `openclaw.plugin.json`, and sets `openclaw.extensions` in `package.json`. The backend ID becomes the model-ref prefix (`cursor-cli/<model>`) [1][26]. Upstream moved the CLI mechanics out of `agents.defaults.cliBackends` config and into plugin code [2]. The installed OpenClaw 2026.2.22 still describes CLI backends as text-only, with no tools and no streaming, so it must be upgraded; 2026.10.3, the current release, is the version this research read [10][6]. The experimental agent-harness API is the heavier alternative, recommended only for trusted plugins [9].

**Auth readiness.** Models show `missing-auth` unless OpenClaw finds auth evidence: an auth profile, config auth, or synthetic auth (`syntheticAuthRefs` in the manifest) [39][28] (medium confidence). The hook name is unsettled: jeehou's issue names `resolveSyntheticAuth`, and the 2026.9.2 release notes add `prepareSyntheticAuth` [28][38]. If `modelProvider` is omitted, OpenClaw warns at registration and skips the provider-to-runtime binding; direct `cursor-cli/<model>` refs still work [3][1]. Backends that declare `modelProvider` are hidden from provider pickers as runtime aliases [37], which is the reason to omit it. jeehou's HTTP-transport failure involved an extra provider registration plus `models.providers` config, which the source neither confirms nor explains [28]. Issue #148584 (plugin skipped at startup) is closed with no traced fix [7].

**Contract.**
- **Config.** The backend config covers command, args, `resumeArgs`, JSONL output, `sessionIdFields`, system-prompt flags, `serialize`, and a watchdog [1][3].
- **Hooks.** Optional hooks include `resolveExecutionArgs`, `prepareExecution` (returns env, clearEnv, `beforeExecution`, cleanup, or a custom `execute` transport), `parseJsonlEvent`, `nativeToolMode` (`none` / `always-on` / `selectable`), and `bundleMcp` [1][3].
- **Resume.** On resume, argv is `resumeArgs ?? args`, so `resumeArgs` must repeat the headless flags. Omitting them is the bug that broke resume in jeehou/openclaw-cursor-cli (see section 3) [4][27].
- **Parsing.** `liveSession` and `jsonlDialect` are closed unions tied to Claude and Gemini [3], so Cursor needs its own `parseJsonlEvent`.
- **Host approval.** The custom `execute` context carries `requestToolPermission` [3], so a custom transport could route each Cursor permission request (for example over ACP) to OpenClaw's approval flow.

**Tools.**
- **Loopback MCP.** With `bundleMcp`, OpenClaw starts a loopback HTTP MCP server with Gateway tools, guarded by a per-run `OPENCLAW_MCP_TOKEN` [2][4]. `tools.allow`/`deny` are projected into native filters only for Claude, Codex, and Gemini; a third-party backend must translate them itself, or restricted runs are refused [2].
- **Closed modes.** `bundleMcpMode` is a closed union (`claude-config-file`, `codex-config-overrides`, `gemini-system-settings`), and plugins can't add their own config writer [3]. `prepareExecution` gets no MCP URL field, only env [3].
- **Workaround.** Gemini mode writes a settings file with the concrete URL and Bearer header [4], so a plugin could read that file and hand the server to cursor-agent or the SDK. This inference is untested (medium confidence).
- **Known bug.** Open bug #116235: a Gateway restart rotates the loopback port and token, and live runs lose their MCP tools [8].

**Skills.** Non-Claude backends get OpenClaw's skills catalog in the system prompt [4][2].

**History.** Resumed turns send only the new prompt plus bounded notes, and continuity comes from CLI-side resume, with one binding per backend [2]. A fresh session can be reseeded from OpenClaw's transcript, capped at 12,288 characters by default. This requires an auth profile credential of type `api_key`, `token`, or OAuth with an account ID. The code is explicit: "never ... opaque CLI login alone" [5][2]. Replay covers only history that accrued under the same fingerprint (which includes the provider), starting from an empty session; legacy or unaccounted content cannot authorize it, and existing conversations are not backfilled [5][2]. Cross-backend switches otherwise get a metadata note and a `sessions_history` hint [2]. The issue asking for full cross-backend context (#79047) was closed as stale [36].

**Concurrency.** For a non-Claude backend, `serialize: true` puts every agent on one global lane keyed by backend ID. `serialize: false` gives one key per run, meaning no ordering at all. Per-owner keys need `liveSession: "claude-stdio"` [4]. `beforeExecution` runs after queue admission and is documented for "mutable per-profile CLI homes" [3], which is where a plugin-owned per-session lock fits.

## 2. cursor-agent side

**Headless stream.** The invocation is `-p --output-format stream-json --stream-partial-output`. Events are NDJSON:
- `system/init`;
- `assistant` deltas, filtered on `timestamp_ms` and `model_call_id`;
- `tool_call` started/completed;
- a terminal `result` with `session_id` [11][31].

Token usage (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) arrives on `result`. It is absent from the official docs, and its shape has varied between top-level and nested [31][22]. Plain-text mode buffers until exit [31]. Silent `-p` hangs recur across versions, so a watchdog is mandatory [21][13].

**Models.** Select a model with `--model <id>`; list IDs with `models` or `--list-models`. Auto is the default, admins can restrict models, and exact-ID matching was fixed in 2026.09.28 [12][13].

**Tool control.**
- **No removal.** No flag removes built-in tools or injects tool definitions per run [12][18].
- **Silent deny.** In `-p` mode without `--force`, shell commands not on the allowlist are denied without a prompt, and the agent sees the failure [19]. File changes are only proposed, not applied [17]. Delete maps to "User Rejected" [20]. Read, MCP, and WebFetch behavior in `-p` mode is undocumented.
- **Deny rules.** Rules cover `Shell`, `Read`, `Write`, `WebFetch`, and `Mcp(server:tool)`, and deny wins [14]. Delete has no permission token, and `WebFetch` allow is buggy in `--print` [20]. Whether `Shell(*)`-style denies block everything is untested.
- **MCP sources.** MCP comes from project or user `mcp.json` [12].

**Sessions.** `create-chat` returns an ID; `--resume <id>` or `--continue` continues it [12][31]. Chats live in `<configDir>/chats/<md5(cwd)>/<uuid>/store.db` [18]. Nothing documents two processes resuming the same chat at once.

**Isolation** (from the 2026.04.17 bundle; stale, see Staleness map).
- **Relocatable.** `CURSOR_CONFIG_DIR` moves `cli-config.json`, `chats/`, and `acp-sessions/`. `CURSOR_DATA_DIR` moves `projects/` and `ts/` [18][15].
- **Hardcoded to home.** The user `mcp.json` is always `~/.cursor/mcp.json`, so per-agent MCP config must go in the project `.cursor/mcp.json` under each agent's cwd. Worktrees default to the home directory (overridable with `CURSOR_WORKTREES_ROOT`), and macOS `prompt_history.json` stays there [18].
- **Login.** On macOS the login is in the Keychain (`cursor-user`), independent of the config dir, so agents share one login [18]. A file-based credential store (instead of the Keychain) needs ≥ 2026.06.29 [13].
- **Shared helper.** CLI processes appear to share a helper process under a spawn lock; it looks telemetry-related [18] (medium confidence).
- **Upgrade needed.** Before 2026.07.06, concurrent runs could corrupt `cli-config.json`. The installed 2026.04.17 build is affected [13].

## 3. Cursor transports and prior art

### Cursor transports

| Transport | How tools reach the model | Built-ins | Resume / usage | Auth | Status |
|---|---|---|---|---|---|
| `cursor-agent -p` stream-json [11][12] | MCP from project or user `mcp.json` | Denied by `cli.json`, not removed | `--resume`; usage on `result` | `agent login` (Keychain) or API key | Official; default choice |
| `@cursor/sdk` 1.0.37, local runtime [23][24] | `customTools` or inline `mcpServers`, per run | Removable (`tools: []` / `["mcp"]`) | `Agent.resume`, checkpoint store; usage on `run.wait()` | API key only; browser login mints a 90-day key | Official; fallback choice |
| `agent acp` [16][25] | Spec allows client `mcpServers`; Cursor doesn't confirm it | Per-call `reject-once` | `session/load`; usage undocumented | Login, API key or auth token | Official; third candidate (Q5) |
| Cursor BDK [35] | BDK-defined tools, run inside the BDK runtime | Unknown | `continuationToken`; usage on `turn.completed` | Unknown | Official server product; no path found that hands tool calls back to a remote host (inference) |
| Private `agent.v1` Connect-RPC (oakimov) [32] | Host tools as a synthetic MCP server; Run held open during host execution | Soft-denied | Checkpoint resume; usage estimated | OAuth PKCE or API key | Reverse-engineered; ToS and drift risk |

### Prior art

| Project | Shape | How tools reach the model | Built-ins | State / concurrency | Status |
|---|---|---|---|---|---|
| jeehou/openclaw-cursor-cli [26] | OpenClaw CLI backend + provider, `cursor-cli` | No OpenClaw tools; Cursor's own tools run with `--force --trust` | `always-on` | Nothing | Last commit 2026-05; resume and auth broken on current OpenClaw, binding issue disputed [27][28] |
| elvatis bridge [29] | OpenAI proxy behind `vllm` provider | Prompt-injected JSON protocol, parsed back to `tool_calls` | Not disabled | No resume; replays last ~20 messages | 2026-07; no Cursor support |
| drewstone/cli-bridge [30] | Standalone OpenAI server | Per-request MCP passthrough | CLI runs its own | SQLite ID map, per-session turn lane, global slots | Very active; no Cursor support |
| verivus llm-cli-gateway [31] | MCP server (inverse direction) | n/a | n/a | Real chat IDs, worktrees, env scrubbing | Best record of Cursor's stream-json |
| Nomadcxx / chiarelli [33][34] | CLI or SDK wrappers for OpenCode / Kilo | Intercept `tool_call`, cancel run, hand to host | chiarelli: `cli.json` deny Write/Shell/Edit/Delete/Mcp | Per host session | Active 2026-10 |

Patterns:
- Every project with resume maps host IDs to the CLI's own resume IDs [30][31][26].
- Resume is fragile: elvatis dropped it, and jeehou's never worked headless [29][27].
- drewstone has the only explicit concurrency design (per-session lane plus global slots) [30].
- chiarelli writes a project `cli.json` that denies write, shell, edit, delete, and all MCP (`Mcp(*:*)`), and intercepts and cancels the remaining tool calls [34]. Its `Edit` and `Delete` tokens are not in Cursor's documented set [14][20]. It shows deny lists in use, not that they suffice alone.

## Cross-dimension insights

- **A Cursor API key matters twice, but OpenClaw won't hand it over.** OpenClaw's history reseed needs an `api_key` or `token` auth profile [5], and `@cursor/sdk` needs an API key [23]. A third-party plugin receives only the `authProfileId`, not the credential ("Only bundled backends receive this private credential bridge") [3]. So the user configures the key twice: as an OpenClaw auth profile for reseed, and as plugin config or `CURSOR_API_KEY` for the SDK. A plain `agent login` serves neither, though it is enough for the CLI transport.
- **The SDK removes one untested step, not both.** OpenClaw's loopback MCP is plain HTTP plus a Bearer token [4], and SDK inline `mcpServers` takes servers per run [23]. An SDK transport with `tools: ["mcp"]` and the loopback as its only server gives "only OpenClaw's tools" with documented built-in removal. Both transports still share the untested step of reading the loopback URL from the Gemini-mode file [3][4]. The CLI path adds a second untested step: deny-all rules.
- **Isolation splits along `.cursor` directories.** The per-agent cwd chosen by OpenClaw [4] is also where cursor-agent reads project `mcp.json` and `cli.json` [18][14]. So the plugin can stage tools and deny rules per agent in the workspace, but it writes into the user's workspace. Core sets the spawn cwd; only a custom `execute` could change it [4][3].

## Recommendations

### For the architecture

1. **Standalone CLI backend, ID `cursor-cli`, without `modelProvider`.** Use the manifest `cliBackends` and `setup.cliBackends`, plus synthetic auth so models don't show `missing-auth`. Omitting `modelProvider` keeps the backend visible in pickers [37]. *High confidence* for the contract [1][3]; *low* for the auth hook names [28][38].
2. **A transport seam inside the backend.** The default transport spawns `cursor-agent -p --output-format stream-json --stream-partial-output --trust`, with `resumeArgs` repeating every base flag. The fallback is `@cursor/sdk` via `prepareExecution().execute`. The same seam carries the next CLIs. *High* for the default [4]; *medium* for the fallback, untested (Q2) [3][23].
3. **Own Cursor stream parsing** in `parseJsonlEvent`: deltas, tool events shown for display only, `session_id`, and usage keys accepted in camelCase, whether top-level or nested. *High* for the schema [11][31]; *medium* for usage shapes [22].
4. **Tool bridge.** Turn on `bundleMcp` in Gemini mode. In `prepareExecution`, write the loopback server into the agent workspace's `.cursor/mcp.json` and a `cli.json` that denies Shell, Write, Read, and WebFetch and allows only `Mcp(openclaw:*)`. Run without `--force`. Declare `nativeToolMode: "always-on"` until the deny spike proves that `"selectable"` works. *Low: untested* [3][4][14].
5. **Isolation.** Per agent, set `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` to a plugin-owned state dir. Pass `--workspace` explicitly; verivus treats it as separate from the process cwd [31]. Whether cursor-agent reads project `.cursor` files from the cwd or from `--workspace` is untested. Document that the login is shared. *Medium*: [18] is a stale build, so re-verify.
6. **Concurrency.** Set `serialize: false`, and add a plugin-owned per-session lock taken in `beforeExecution`, a global slot cap (drewstone pattern), and a watchdog. *High* for the core behavior [4][30].
7. **History.** Support an optional auth profile that holds a Cursor API key (`defaultAuthProfileId`). With it, reseed works for history accrued under that profile from an empty start; earlier history and other backends' turns still get metadata notes. *Medium* [5][3].

### For the spec

8. **Reword the bar and C5.** "The CLI only produces the reply" becomes "the CLI runs the loop with OpenClaw's tools only; OpenClaw owns policy, transcript, and session". "Agents don't interfere" should exclude the shared login and the shared helper process.
9. **Versions:** target OpenClaw 2026.10.3 (the current release; no source sets a lower floor) and cursor-agent ≥ 2026.07.06; test on the latest. Both installed versions are too old: OpenClaw 2026.2.22 has no tools or streaming for CLI backends [10], and cursor-agent 2026.04.17 has the config-corruption race and lacks the file credential store [13]. Any live test must upgrade first.

## Open questions

- **Q1 (blocks recommendation 4):** does cursor-agent load an HTTP MCP server with a Bearer header from project `.cursor/mcp.json` in `-p` without approval prompts, or does it need `--approve-mcps`? Do the deny rules block every built-in, and does the model recover from denials? *Answer with:* a live spike on current versions.
- **Q2 (blocks the fallback in recommendation 2):** does the SDK transport work end to end? That covers `tools: ["mcp"]` plus inline loopback MCP, how SDK events map to `parseJsonlEvent` records, and whether a third-party custom `execute` behaves in practice. *Answer with:* a spike.
- **Q3 (affects recommendation 7):** is a Cursor user API key (minted by `Cursor.auth.login()`) billed against the subscription's included usage? *Answer with:* Cursor docs or support, then a usage-dashboard check.
- **Q4 (affects recommendation 6):** can two processes resume the same chat ID safely, and what does the shared helper process share? *Answer with:* a live concurrency test.
- **Q5 (third transport):** does `agent acp` honor `session/new.mcpServers`, and does it report usage? *Answer with:* a live ACP probe.
- **Q6 (affects recommendation 1):** is #148584 (plugin skipped at Gateway startup) fixed in 2026.10.x? *Answer with:* its referenced commits, or a load test.

## Source appendix

All sources were accessed 2026-10-15.

| # | Supports | Publisher | Pub date | Confidence |
|---|---|---|---|---|
| [1] | Plugin contract, manifest, hooks | [OpenClaw docs: CLI backend plugins](https://docs.openclaw.ai/plugins/cli-backend-plugins) | unknown (matches main 2026-10) | high |
| [2] | Bundle MCP, sessions, reseed, skills, fallbacks | [OpenClaw docs: CLI backends](https://docs.openclaw.ai/gateway/cli-backends) | unknown (matches main 2026-10) | high |
| [3] | Type shapes: bundleMcpMode, prepareExecution, execute, liveSession, modelProvider | [openclaw/openclaw cli-backend.types.ts @275c611](https://github.com/openclaw/openclaw/blob/275c611ead7a010e544ce5337e0588ec593e8087/src/plugins/cli-backend.types.ts) | 2026-10 | high |
| [4] | Resume argv, queue keys, loopback env, Gemini settings, skills prompt, synthetic auth | [openclaw/openclaw cli-runner @275c611](https://github.com/openclaw/openclaw/tree/275c611ead7a010e544ce5337e0588ec593e8087/src/agents/cli-runner) | 2026-10 | high |
| [5] | History account boundary | [openclaw/openclaw history-boundary.ts @275c611](https://github.com/openclaw/openclaw/blob/275c611ead7a010e544ce5337e0588ec593e8087/src/agents/cli-runner/history-boundary.ts) | 2026-10 | high |
| [6] | Current release v2026.10.3 | [OpenClaw releases](https://github.com/openclaw/openclaw/releases) | 2026-10 | high |
| [7] | Startup-skip issue status | [openclaw/openclaw#148584](https://github.com/openclaw/openclaw/issues/148584) | 2026-09 | medium |
| [8] | Loopback MCP lost on Gateway restart | [openclaw/openclaw#116235](https://github.com/openclaw/openclaw/issues/116235) | 2026-08 | medium |
| [9] | Agent harness alternative | [OpenClaw docs: agent harness](https://docs.openclaw.ai/plugins/sdk-agent-harness) | unknown | medium |
| [10] | Local 2026.2.22: text-only CLI backends | [local openclaw 2026.2.22 docs/gateway/cli-backends.md](file:///opt/homebrew/lib/node_modules/openclaw/docs/gateway/cli-backends.md) | 2026-02 | high |
| [11] | stream-json schema, deltas | [Cursor docs: output format](https://cursor.com/docs/cli/reference/output-format) | unknown | high |
| [12] | Flags, models, resume, MCP subcommands | [Cursor docs: parameters](https://cursor.com/docs/cli/reference/parameters) | unknown | high |
| [13] | Config race fix, credential store, hang fixes, model fixes | [Cursor CLI changelog](https://cursor.com/docs/cli/changelog) | 2026-04..2026-10 | high |
| [14] | Permission tokens, deny precedence | [Cursor docs: permissions](https://cursor.com/docs/cli/reference/permissions) | unknown | high |
| [15] | CURSOR_CONFIG_DIR, approvalMode | [Cursor docs: configuration](https://cursor.com/docs/cli/reference/configuration) | unknown | high |
| [16] | ACP flow, permission replies | [Cursor docs: ACP](https://cursor.com/docs/cli/acp) | unknown | high |
| [17] | Without --force changes are only proposed | [Cursor docs: headless](https://cursor.com/docs/cli/headless) | unknown | high |
| [18] | Config/data dir resolution, chat paths, hardcoded mcp.json, Keychain, helper lock | [local cursor-agent 2026.04.17 bundle](file:///Users/xtimor/.local/share/cursor-agent/versions/2026.04.17-787b533/) | 2026-04 | high (old build) |
| [19] | Headless silent deny | [Cursor forum 157243](https://forum.cursor.com/t/disable-permissions-ask-in-sandbox/157243) | unknown | medium |
| [20] | Delete has no token; WebFetch allow bug | [Cursor forum 172763](https://forum.cursor.com/t/cli-allowlist-cannot-auto-approve-deletetoolcall-or-webfetch-skipapproval-stays-false-print-mode-user-rejected/172763) | unknown | medium |
| [21] | -p hangs (transport cluster) | [Cursor forum 164841](https://forum.cursor.com/t/cursor-agent-p-hangs-with-zero-output-on-2026-07-01-41b2de7-macos-intel-all-output-formats-even-trivial-prompts/164841) | 2026-07 | medium |
| [22] | Usage shapes varied | [multica-ai/multica#4108](https://github.com/multica-ai/multica/issues/4108) | 2026 | medium |
| [23] | SDK tools, customTools, inline mcpServers, auth, usage, resume | [Cursor docs: TypeScript SDK](https://cursor.com/docs/api/sdk/typescript) | unknown | high |
| [24] | SDK version 1.0.37 and dist types | [npm @cursor/sdk](https://www.npmjs.com/package/@cursor/sdk) | 2026-10 | high |
| [25] | ACP spec mcpServers semantics | [ACP spec: session setup](https://agentclientprotocol.com/protocol/session-setup) | unknown | high |
| [26] | Prior-art Cursor backend config | [jeehou/openclaw-cursor-cli](https://github.com/jeehou/openclaw-cursor-cli) | 2026-05 | high |
| [27] | Resume broken (resumeArgs) | [jeehou/openclaw-cursor-cli#2](https://github.com/jeehou/openclaw-cursor-cli/issues/2) | 2026-08 | high |
| [28] | missing-auth, modelProvider, startup-load issues | [jeehou/openclaw-cursor-cli issues](https://github.com/jeehou/openclaw-cursor-cli/issues) | 2026-05..2026-10 | medium |
| [29] | Proxy + prompt-injected tool protocol | [elvatis/openclaw-cli-bridge-elvatis](https://github.com/elvatis/openclaw-cli-bridge-elvatis) | 2026-07 | high |
| [30] | Session id map, turn lanes, slots | [drewstone/cli-bridge](https://github.com/drewstone/cli-bridge) | 2026-10 | high |
| [31] | Measured Cursor stream-json, buffering, workspace vs cwd | [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) | 2026-09 | high |
| [32] | Private agent.v1 host-owned loop | [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider) | 2026-10 | high |
| [33] | Intercept-and-cancel loop | [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor) | 2026-10 | high |
| [34] | cli.json deny list in practice | [chiarelli/kilocode-cursor](https://github.com/chiarelli/kilocode-cursor) | 2026-10 | high |
| [35] | BDK sessions (no remote host loop found) | [Cursor docs: BDK sessions](https://cursor.com/docs/bdk/reference/sessions) | unknown | medium |
| [36] | Cross-backend context request closed stale | [openclaw/openclaw#79047](https://github.com/openclaw/openclaw/issues/79047) | 2026-07 | medium |
| [37] | Backends with modelProvider hidden from pickers | [openclaw/openclaw cli-backends.ts @275c611](https://github.com/openclaw/openclaw/blob/275c611ead7a010e544ce5337e0588ec593e8087/src/agents/cli-backends.ts) | 2026-10 | high |
| [38] | prepareSyntheticAuth hook added | [OpenClaw release notes 2026.9.2](https://github.com/openclaw/openclaw/blob/275c611ead7a010e544ce5337e0588ec593e8087/docs/releases/2026.9.2.md) | 2026-09 | medium |
| [39] | Auth evidence for model availability | [openclaw/openclaw model-auth-availability.ts @275c611](https://github.com/openclaw/openclaw/blob/275c611ead7a010e544ce5337e0588ec593e8087/src/agents/model-auth-availability.ts) | 2026-10 | medium |


## Staleness map

Re-check windows, in months, by claim class: version-compat 1, api-contract 3, behavior 3, limitation 3, ecosystem 6.

| Claim | Class | Pub | Re-check by |
|---|---|---|---|
| cursor-agent ≥ 2026.07.06 fixes the `cli-config.json` race | version-compat | 2026-07 | 2026-08-01 (stale) |
| User `mcp.json` hardcoded to `~/.cursor`; Keychain login shared (from the 2026.04.17 bundle) | behavior | 2026-04 | 2026-07-01 (stale) |
| OpenClaw v2026.10.3 plugin contract shape | version-compat | 2026-10 | 2026-11-01 |
| `@cursor/sdk` 1.0.37 tools / customTools / mcpServers | version-compat | 2026-10 | 2026-11-01 |
| jeehou plugin abandoned and broken | ecosystem | 2026-05 | 2026-11-01 |
| cursor-agent stream-json schema and usage keys | api-contract | 2026-09 | 2026-12-01 |
| bundleMcpMode closed union; history boundary; queue keys; no built-in removal | api-contract / behavior / limitation | 2026-10 | 2027-01-01 |
| oakimov private protocol pin | ecosystem | 2026-10 | 2027-04-01 |

The earliest re-check date, 2026-07-01, has passed; the executive summary flags it.

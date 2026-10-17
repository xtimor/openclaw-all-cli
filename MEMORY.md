# Memory

## Where things are

- Plan of record: `_bmad-output/initiative-openclaw-all-cli/`: spec (`spec-cursor-cli-provider/`), architecture spine (`architecture-openclaw-all-cli/`, AD-1..AD-14), parity matrix (`spec-cursor-cli-provider/claude-cli-parity.md`), tickets (`tickets.toml`, `epic-cursor-cli/tickets.toml`).
- Spike harness: `.spike/` (gitignored). OpenClaw 2026.10.3 in `.spike/openclaw`, Node 24 in `.spike/node` (system Node 25 is rejected by OpenClaw), test MCP server `.spike/mcp/server.mjs`, ACP probe `.spike/acp-probe.mjs`.

## Decisions (user)

- Goal: `claude-cli` experience and features for every CLI; Cursor first, Antigravity next.
- The agent decides design; the user decides strategy only.
- Work only against the isolated OpenClaw; the user's own Node and OpenClaw (`~/.openclaw`, 2026.2.22) are upgraded at the end (epic entry 18).
- A host without a Cursor login still develops. It installs Node 24 and OpenClaw 2026.10.3 into `.spike` when they are missing. The live `cursor-agent` check waits for a machine that has the login, and that wait is not a question (user, 2026-10-16).
- Cursor API key optional. No public release in this initiative.
- Cursor usage must be found; shipping without it is a last resort.

## Facts learned the hard way

- `cursor-agent -p` reads project `.cursor/mcp.json` only at the workspace's git root, and ignores project `.cursor/cli.json` permissions; permissions work from `CURSOR_CONFIG_DIR/cli-config.json`.
- `cursor-agent acp` honors `session/new.mcpServers` (HTTP + headers), asks permission for shell, auto-applies edits unless `Write(**)` is denied, and reports no usage.
- `deny: Read(**)` does not block grep/glob.
- OpenClaw mints a new loopback MCP token per run; a warm session needs the per-turn MCP proxy (AD-12).
- OpenClaw owns session binding (`ctx.sessionId`/`useResume`) and per-session lanes with `liveSession`; do not duplicate them.
- Sandboxed shells can't read the Cursor login from the Keychain; run `cursor-agent` with full permissions.
- OpenClaw scans a plugin's whole root dir. A `--link` install of the checkout fails (`.spike/` holds hundreds of nested packages; state under the root trips "directory changed during admission"). Install a packed `.tgz` (`npm run dev:install`); copy install needs built `dist/` (`openclaw.runtimeExtensions`).
- Manifest `providers: ["<backend>"]` is required for `providerCatalogEntry` (synthetic auth) to load; `cliBackends` alone leaves `models status` at `[indeterminate]`. Entry may export an array.
- A CLI backend's `execute` yields records; OpenClaw JSON-stringifies them into `parseJsonlEvent`. Records with `type: "result"` end the turn. `useResume` needs non-empty `resumeArgs`; `sessionMode: "existing"` passes only the stored ID.
- Vitest env makes OpenClaw mute output; strip `VITEST*` when a test spawns it.
- Host-less checks use `test/fixtures/fake-cursor-agent.mjs` (ACP stand-in; steer with `[[hang]]`, `[[crash]]`, `[[ask-permission]]`, `[[refuse]]`, `[[ask-json]]<json>` (`{toolCall, announce?, options?}`: an ACP permission request; `announce` is sent first as a `tool_call` update), `say:<text>`; env knobs `FAKE_CURSOR_DEFAULT_MODEL`, `FAKE_CURSOR_IGNORE_CANCEL`, `FAKE_CURSOR_IGNORE_TERM`, `FAKE_CURSOR_IGNORE_STDIN_EOF`, `FAKE_CURSOR_NO_INIT`, `FAKE_CURSOR_NO_ASK_MODE`, `FAKE_CURSOR_LOGGED_IN`, `FAKE_CURSOR_LOG`). It proves wiring only, not Cursor behavior.
- Plugin startup loading (#148584, OpenClaw 2026.10.3): with no config naming `cursor-cli`, the Gateway loads the plugin on the first turn selecting it; with `agents.defaults.model.primary = cursor-cli/auto` it loads at startup.

- Live Cursor (2026.10.16): with `CURSOR_API_KEY`, skip `authenticate{cursor_login}` (it opens a browser and fails). ACP lists models under `models` with ids like `default[]`, not a configOptions select. Cursor returns backend errors as message text with `end_turn`. The proxy must allow `agentn.global.api5.cursor.sh` for a real turn.
- Per-agent home (entry 2): `<agentDir>/openclaw-all-cli/<backendId>/` with `cli-config.json` permissions; real `cursor-agent acp` in agent mode creates no file with it and does create one without it (checked 2026-10-17, `test/live/per-agent-home.live.test.ts`). Unverified: a login kept in the config dir (no Keychain) may be invisible to a per-agent `CURSOR_CONFIG_DIR`; this host has only `CURSOR_API_KEY`.
- MCP proxy (entry 3, 2026-10-17): Cursor connects to its MCP servers while `session/new`/`session/load` runs and drops a server for good after one rejected connection. So `execute` registers and activates the host live-session handle, and points the proxy at the turn's target, before `adapter.open`. Otherwise the host answers 401 (its MCP grant capture is not active yet).
- Host settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` in `ctx.env`, real OpenClaw 2026.10.3): `{mcp:{allowed:["openclaw"]},mcpServers:{openclaw:{url:"http://127.0.0.1:<port>/mcp",type:"http",headers:{Authorization:"Bearer <64 hex>","x-openclaw-cli-capture-key":"<uuid>"}}}}`. The path is a new temp file per attempt, so the host's live-session fingerprint (which hashes env values) differs every turn: no warm reuse, every turn restarts the process and resumes with `session/load`. The URL is stable per Gateway; token and capture key change per turn.
- Open risk: if a host version makes the fingerprint stable, `live.activate` moves the later turn's grant onto the first turn's bearer and capture key (`adoptProcessToken`, `beginCapture(record.capture.key)`), and the later turn's file credentials would be rejected with 401. AD-12 reads each turn's file; check this before lifting the restart.
- Live tests share one isolated OpenClaw state: `vitest.config.ts` runs live files serially. Two `openclaw agent --local` at once fail.
- Gateway for multi-turn checks: `scripts/dev-openclaw.sh run gateway run --allow-unconfigured --auth none --port 18911`, then `OPENCLAW_GATEWAY_PORT=18911 ... run agent --session-id X` (no `--local`). Do not `pkill -f` by name from a shell whose command line contains it.
- Review fixes (2026-10-17): a first turn with no usable settings leaves the process degraded (Cursor drops the server after the proxy's 503), so `reusable()` skips it. `handle.close()` during `adapter.open` is detected after the open and the new session is closed. The proxy drops the CLI's `x-openclaw-*`, `cookie`, `origin`, `x-forwarded-*` headers. `ExecuteOptions.mcp` (from manifest P7) off means no proxy, no `mcpServers`, no warning.
- Permission routing (entry 4, 2026-10-17, cursor-agent 2026.10.16 / OpenClaw 2026.10.3):
  - ACP `session/request_permission` carries no `rawInput`; join it with the earlier `tool_call` update by `toolCallId`. Titles: shell `` `cmd` `` (kind `execute`), `Edit \`path\``/`Write path`/`Delete \`path\`` (kind `edit`, diff content), `Read \`path\``, MCP `<server>: <tool>` with a ```json block (kind `other`), web calls `web_fetch_*`/`web_search_*`. Question prompts reuse the request: their allow options are answers (`__ask_question_skip__` is the reject), never allow them.
  - Native edits never ask in agent mode (any permissions, `approvalMode`, sandbox, outside the workspace too); `ask` and `plan` mode have no edit tool. Shell asks in both modes and runs after approval, but in `ask` mode the model refuses commands that change files.
  - Denying `Read(**)`, `Grep(**)`, and `Glob(**)` makes grep and glob return nothing (a static "no native readers" home is possible, not built). `Read(**)` alone does not.
  - Host: `hostOwnedTools` applies only to `toolAvailabilityEnforcement: "execution-args"`, so with `prepare-execution` no OpenClaw `exec` reaches the model (real run listed 47 tools, `exec: no`), even with `tools.allow` naming it. `tools.deny` hides tools from the model (live). Caps, `disableTools`, and system agents send `toolAvailability.native: []`; the host denies a native tool not in `native` itself and demands `toolAvailabilityEnforced: true` or throws.
  - `openclaw config set tools.deny '[...]' --strict-json` / `config unset` works in the isolated state; unset leaves `"tools": {}`.

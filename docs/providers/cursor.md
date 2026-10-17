# Cursor provider

What `cursor-cli/<model>` does in OpenClaw and how it compares with `claude-cli`. Setup is in [Setup](../setup.md).

> **Status:** walking skeleton. Rows marked *spike* or *planned* change as the plugin grows; each change to a row updates this page and that row's live test together.

## How it runs

OpenClaw selects the `cursor-cli` backend from the model ref `cursor-cli/<model>`. The plugin starts `cursor-agent acp` and talks to it over the Agent Client Protocol (ACP). One process serves one conversation. The plugin keeps it warm between turns (closed after 15 idle minutes) whenever OpenClaw allows reuse; see the P4 row. OpenClaw owns the session binding: it stores the Cursor session ID the plugin reports, and the next turn resumes it with ACP `session/load` when OpenClaw says to.

Each agent gets its own Cursor home, `<agentDir>/openclaw-all-cli/cursor-cli/` (`agentDir` is OpenClaw's per-agent directory). The plugin points `CURSOR_CONFIG_DIR` at it and `CURSOR_DATA_DIR` at its `data/` folder, so agents share no Cursor config or chat store. The Cursor login stays shared. The plugin writes nothing into the agent's working directory. If OpenClaw gives no agent directory, the turn fails with `OpenClaw gave no agent directory`; the plugin never falls back to a shared home.

The home holds one file the plugin writes, `cli-config.json`, with the same static permissions for every agent:

| Rule | Entries |
| --- | --- |
| Deny | `Shell(*)`, `Write(**)`, `WebFetch(*)` |
| Allow | `Read(**)`, `Mcp(openclaw:*)` |

The home directory is created with mode 0700 and the file with mode 0600 (an existing stricter file mode is kept). If `cli-config.json` exists but cannot be read, the turn fails and names the file instead of replacing it. The plugin writes the file once through an atomic rename and leaves it alone while it already holds these rules. Other keys Cursor stores there are kept, and edits to the `permissions` key are overwritten on the next turn. No per-turn policy goes into a file. Native read, grep, and glob stay available.

## OpenClaw tools

OpenClaw's tools (`sessions_list`, `memory_search`, `web_fetch`, and the rest) reach Cursor as the MCP server `openclaw`. The backend sets `bundleMcp` with `bundleMcpMode: "gemini-system-settings"`, so for every turn OpenClaw writes a settings file with its own loopback URL, a fresh token, and a capture key, and names it in `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. That URL and token change on every run, so the plugin never gives them to Cursor. Instead it runs one local HTTP proxy per live session, on `127.0.0.1` with a random port and its own random Bearer token, and hands Cursor only that proxy through ACP `mcpServers` (`session/new` and `session/load`). At the start of each turn the plugin reads `mcpServers.openclaw` (`url` or `httpUrl`, and `headers`) from the settings file and points the proxy at it; the proxy forwards method, path, body, and the response stream unchanged, with the turn's `Authorization` and `x-openclaw-cli-capture-key` headers. Between turns, after an abort, and after the proxy's session closes, the proxy rejects every call.

| Situation | What happens |
| --- | --- |
| Call outside a turn | HTTP 503 with a JSON-RPC error; nothing is forwarded |
| Missing or wrong client token | HTTP 401; nothing is forwarded. The token is checked before the path, so a wrong token gets 401 even for a path outside `/mcp` |
| Path outside `/mcp` | HTTP 404; nothing is forwarded |
| Proxy failure while handling a call | HTTP 500 with a JSON-RPC error |
| The proxy cannot start | The turn fails with a retryable error; Cursor is not started |
| The live session was closed while Cursor was starting | The new Cursor process is stopped and the turn fails with a retryable error (`The live session was closed while the CLI was starting`) |
| OpenClaw's endpoint unreachable | HTTP 502 to Cursor; the turn continues |
| No settings file, or no `mcpServers.openclaw` in it | The turn runs without OpenClaw tools and the plugin logs a warning; the chat does not fail. Cursor drops the `openclaw` server for the life of that process, so a process whose first turn had no settings is closed when that turn ends and the next turn starts a new one |
| Settings URL is not a loopback `http` URL | Treated as no settings, so the proxy never sends OpenClaw's token anywhere else |

Cursor connects to its MCP servers while it opens the session, before the first prompt, so the plugin registers the session with OpenClaw and points the proxy at the turn's endpoint before it starts `cursor-agent`. The plugin writes no MCP configuration into the workspace or any file you own.

Until permission routing lands, every session also runs in Cursor's read-only `ask` mode and every Cursor permission request is rejected, so Cursor's shell and edit tools cannot act. The plugin refuses to run when `cursor-agent` offers no `ask` mode.

## Models

`cursor-cli/auto` lets Cursor choose. Any other `cursor-cli/<id>` is selected when the account lists that ID; otherwise the turn fails with `The CLI has no model "<id>" for this account`. Listing the account's models in `/model` is planned.

## Parity with `claude-cli`

| # | Feature | Status | Notes |
| --- | --- | --- | --- |
| P1 | Provider in `/model`, model aliases | spike | `cursor-cli/<model>` runs; the model list in `/model` is not built |
| P2 | Subscription login counts as auth | match | `cursor-agent status` or `CURSOR_API_KEY`; the real `status` wording is unconfirmed |
| P3 | Streaming text and thinking | approx | Text and thinking deltas; tool progress is not mapped yet |
| P4 | Warm process per conversation | approx | The plugin keeps one `cursor-agent acp` process per conversation, but OpenClaw 2026.10.3 puts the per-turn MCP settings path into its live-session fingerprint, so it restarts the process every turn and the next turn resumes with `session/load`. Live evidence: `test/live/mcp-proxy.live.test.ts` (warm session with a stand-in host) and the real-host run in the ticket notes |
| P5 | Resume a session | match | ACP `session/load`. No live test yet (live Cursor not run) |
| P6 | Fork, resume at a checkpoint | gap | `cursor-agent` has no fork or checkpoint flag |
| P7 | OpenClaw tools as MCP | match | The plugin hands Cursor one MCP proxy per live session, and nothing else, in ACP `mcpServers`. It forwards each call to the turn's OpenClaw endpoint and rejects calls between turns. Live test: `test/live/mcp-proxy.live.test.ts` |
| P8 | Native shell replaced by OpenClaw `exec` | approx | The per-agent `cli-config.json` denies `Shell(*)`, `Write(**)`, and `WebFetch(*)`; OpenClaw `exec` is not offered yet. Live test: `test/live/per-agent-home.live.test.ts` |
| P9 | Tool approvals through OpenClaw | approx | Shell and MCP ask; native edits do not ask. Routing to OpenClaw is not built |
| P10 | `tools.allow` and `tools.deny` | spike | Static permissions, equal for every agent. The adapter does not translate `tools.allow`/`deny` (the host filters the OpenClaw tool list, AD-9); OpenClaw's own tool filtering is a later entry |
| P11 | Skills as a native plugin | spike | |
| P12 | System prompt every turn | spike | The OpenClaw system prompt is not sent yet |
| P13 | Images | spike | |
| P14 | Native and manual compaction | spike | |
| P15 | History reseed | approx | Needs a Cursor API-key profile |
| P16 | Usage per turn | gap | ACP reports no usage so far |
| P17 | Clean env, watchdog, timeouts | match | OpenClaw's watchdog and timeouts apply |
| P18 | Side questions without tools | spike | Every session runs in `ask` mode; side questions are not handled separately |
| P19 | Binary detection, live tests | approx | OpenClaw finds `cursor-agent` on `PATH`. The minimum version 2026.07.06 is recorded but not enforced yet |

## Known limits

- **No usage.** Cursor's ACP reports no token counts, so OpenClaw records none for a turn.
- **No OpenClaw system prompt or skills yet.** The model sees only the prompt text and OpenClaw's tools.
- **No warm process across turns with OpenClaw 2026.10.3.** Each turn restarts the process and resumes it with `session/load`, because OpenClaw's live-session check sees a different MCP settings path every turn.
- **Native read, grep, and glob stay reachable.** `Read(**)` is allowed, and Cursor's `grep` and `glob` are not blocked by a `Read` rule.
- **Permissions are not configurable.** Every agent gets the same rules; changing them in `cli-config.json` has no lasting effect.

## Check it works

```sh
OPENCLAW_ALL_CLI_LIVE=1 npm run test:live
```

The live test needs a Cursor login and must run outside any sandbox that hides the login.

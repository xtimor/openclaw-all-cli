# Spike: Cursor transport for cursor-cli

Date: 2026-10-15. Throwaway harness in `.spike/` (gitignored): `cursor-agent` 2026.10.14-941492e, a local HTTP MCP server with a Bearer header standing in for OpenClaw's loopback, isolated `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR`. OpenClaw 2026.10.3 installed in `.spike/openclaw` (needs Node 24 or ≥ 26.1; system Node 25 is rejected), not yet driven.

## Results

| # | Question | `cursor-agent -p` stream-json | `cursor-agent acp` |
|---|---|---|---|
| S1 | OpenClaw MCP server with Bearer header reaches the model | Yes, but only from `.cursor/mcp.json` at the **git root** of the workspace, plus `--approve-mcps` | Yes, from `session/new.mcpServers` (HTTP + headers); no files in the workspace |
| S2 | MCP calls auto-approved | Only via `permissions.allow: ["Mcp(openclaw:*)"]` in the per-agent `cli-config.json`; project `.cursor/cli.json` was not applied | Same rule works; without it, MCP calls arrive as `session/request_permission` |
| S3 | Native shell blocked | `deny: Shell(*)` → every call `permissionDenied` | Shell arrives as `request_permission` (`kind: execute`); `reject_once` blocks it |
| S4 | Native write/edit blocked | `deny: Write(**)` blocks edits | Edits auto-apply **without** a permission request unless `deny: Write(**)` is set; then blocked |
| S5 | Native read | `deny: Read(**)` blocks `read`, but **not** `grep`/`glob` (file content leaked via grep) | not tested |
| S6 | Model recovers from denials | Yes: falls back to the OpenClaw MCP tool (`host_exec`) | Yes |
| S7 | Warm process across turns | No (one process per turn) | Yes: turn 3 in the same process 2.4–2.6 s vs 4.9–10.8 s first turn |
| S8 | Usage per turn | Yes: `result.usage` `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` top-level | **No**: `session/prompt` returns only `stopReason` |
| S9 | Thinking stream | Yes: `thinking` events | Yes: `agent_thought_chunk` |
| S10 | Capabilities | — | `loadSession: true`, MCP `http`+`sse`, images, modes `agent`/`plan`/`ask`, model list in `session/new` |

## What it means

- **ACP is the closest match to `claude-cli`**: a warm session per conversation (P4), per-session MCP injection with no writes into the user's repo (P7), and shell routed to the host's approval (P8, P9). Its gap is usage (P16).
- **`-p` stream-json** has usage and is simpler, but needs `.cursor/mcp.json` at the user's git root and has no approval channel.
- **Parity on native tools**: `claude-cli` replaces only shell with OpenClaw `exec`/`process` and keeps native file tools under OpenClaw approval. Cursor ACP asks for shell but not for edits; so edits need either a deny rule (then the model uses OpenClaw tools) or a way to make them ask.
- Permissions belong in the per-agent `CURSOR_CONFIG_DIR/cli-config.json`, which the plugin owns.

## Still open

- ACP usage: any `_meta` or event carrying tokens? Otherwise read Cursor's transcript or accept the gap.
- Can ACP edits be made to ask (e.g. an `approvalMode` value) instead of only allow/deny?
- `grep`/`glob` deny tokens.
- SDK path (needs a Cursor API key).
- Driving all of this from a real OpenClaw 2026.10.3 plugin (Gemini-mode loopback file, `requestToolPermission`).

# claude-cli parity

What OpenClaw's built-in `claude-cli` backend does (OpenClaw 2026.10.3, `extensions/anthropic/setup-api.js`), and the target for each provider. Spike results: `../spike-cursor-transport/spike-cursor-transport.md`. Status: **match** (same behavior), **approx** (same outcome, different mechanism), **gap** (not possible; reason given), **spike** (unknown until tested), **tbd** (not researched).

| # | claude-cli feature | Mechanism in claude-cli | cursor-cli | Antigravity |
|---|---|---|---|---|
| P1 | Provider in `/model`, model aliases | `modelProvider`, `modelAliases`, `resolveModelId` | spike: `cursor-cli/<model>` runs; the model list in `/model` and aliases from `cursor-agent models` are not built | tbd |
| P2 | Subscription login counts as auth | `syntheticAuthRefs`, `subscriptionAuthDispatch` | match: synthetic auth from `cursor-agent status` or `CURSOR_API_KEY`; the real `cursor-agent status` wording is unconfirmed | tbd |
| P3 | Streaming text, thinking, tool progress | `output: jsonl`, Claude stream-json | approx: text and thinking deltas over ACP (`agent_message_chunk`, `agent_thought_chunk`); tool progress is not mapped yet | tbd |
| P4 | Warm process per conversation | `liveSession: "claude-stdio"` via custom `execute` | match (spiked): `agent acp` keeps one process per conversation; later turns 2.4–2.6 s vs 5–11 s first; no live test yet (live Cursor not run) | tbd |
| P5 | Resume a session | `sessionArgs`, `resumeArgs`, `--resume` | match: `--resume <chatId>` / ACP `session/load`; no live test yet (live Cursor not run) | tbd |
| P6 | Fork, resume at a checkpoint | `forkArg`, `resumeAtArg` | gap: no fork or checkpoint flag in cursor-agent | tbd |
| P7 | OpenClaw tools as MCP | `bundleMcp`, `claude-config-file` | spike: ACP `session/new.mcpServers` with HTTP + Bearer header works in the spike; the MCP proxy is not wired; `-p` needs `.cursor/mcp.json` at the user's git root | tbd |
| P8 | Native shell replaced by OpenClaw `exec`/`process` | `hostOwnedTools`, `nativeToolMode: "selectable"` | approx: the per-agent `cli-config.json` denies `Shell(*)`, `Write(**)`, and `WebFetch(*)`, and every ACP permission request is rejected; live check: in agent mode a write request creates no file and asks nothing, `grep` still answers. OpenClaw `exec` is not offered yet | tbd |
| P9 | Tool approvals through OpenClaw | permission hook to `before_tool_call` / exec approval | approx (spiked): shell and MCP ask; native edits do not ask (only allow/deny) | tbd |
| P10 | Tool policy (`tools.allow`/`deny`) enforced | `toolAvailabilityEnforcement: "execution-args"` | spike: static permissions, equal for every agent; the adapter does not translate `tools.allow`/`deny` (the host filters the OpenClaw tool list, AD-9); OpenClaw's own tool filtering is a later entry | tbd |
| P11 | Skills as a native plugin | temporary plugin via `--plugin-dir` | spike: `cursor-agent --plugin-dir`; fallback: prompt catalog | tbd |
| P12 | System prompt every turn | `--append-system-prompt-file`, `systemPromptWhen: "always"` | spike: no system-prompt flag known; prompt prefix or ACP | tbd |
| P13 | Images | `imageArg: "@"`, workspace scope | spike | tbd |
| P14 | Native and manual compaction | `ownsNativeCompaction`, `/compact` | spike | tbd |
| P15 | History reseed and fallback prelude | `reseedFromRawTranscriptWhenUncompacted`, prelude from Claude JSONL | approx: reseed with a Cursor API-key profile; prelude from Cursor transcripts: spike | tbd |
| P16 | Usage per turn | parsed from the terminal event | `-p`: match (`result.usage`); ACP: gap so far (no usage in `session/prompt`) | tbd |
| P17 | Clean env, watchdog, timeouts | `clearEnv`, `reliability.watchdog` | match | tbd |
| P18 | Side questions without tools | `sideQuestionToolMode: "disabled"` | spike: every ACP session runs in `ask` mode; side questions are not handled separately | tbd |
| P19 | Binary detection, live tests | `runtimeArtifact`, `liveTest` | approx: OpenClaw finds `cursor-agent` on `PATH`; the minimum version 2026.07.06 is recorded, not enforced | tbd |

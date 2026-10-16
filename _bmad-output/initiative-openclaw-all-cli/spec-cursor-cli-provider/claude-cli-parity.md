# claude-cli parity

What OpenClaw's built-in `claude-cli` backend does (OpenClaw 2026.10.3, `extensions/anthropic/setup-api.js`), and the target for each provider. Spike results: `../spike-cursor-transport/spike-cursor-transport.md`. Status: **match** (same behavior), **approx** (same outcome, different mechanism), **gap** (not possible; reason given), **spike** (unknown until tested), **tbd** (not researched).

| # | claude-cli feature | Mechanism in claude-cli | cursor-cli | Antigravity |
|---|---|---|---|---|
| P1 | Provider in `/model`, model aliases | `modelProvider`, `modelAliases`, `resolveModelId` | match: `cursor-cli/<model>`, aliases from `cursor-agent models` | tbd |
| P2 | Subscription login counts as auth | `syntheticAuthRefs`, `subscriptionAuthDispatch` | match: synthetic auth for `cursor-agent login` | tbd |
| P3 | Streaming text, thinking, tool progress | `output: jsonl`, Claude stream-json | match: deltas and thinking in both `-p` (`thinking`) and ACP (`agent_thought_chunk`) | tbd |
| P4 | Warm process per conversation | `liveSession: "claude-stdio"` via custom `execute` | match (spiked): `agent acp` keeps one process per conversation; later turns 2.4–2.6 s vs 5–11 s first | tbd |
| P5 | Resume a session | `sessionArgs`, `resumeArgs`, `--resume` | match: `--resume <chatId>` / ACP `session/load` | tbd |
| P6 | Fork, resume at a checkpoint | `forkArg`, `resumeAtArg` | gap: no fork or checkpoint flag in cursor-agent | tbd |
| P7 | OpenClaw tools as MCP | `bundleMcp`, `claude-config-file` | match (spiked): ACP `session/new.mcpServers` with HTTP + Bearer header; `-p` needs `.cursor/mcp.json` at the user's git root | tbd |
| P8 | Native shell replaced by OpenClaw `exec`/`process` | `hostOwnedTools`, `nativeToolMode: "selectable"` | match (spiked): shell arrives as ACP `request_permission` and is rejected; `-p`: `deny: Shell(*)`. Model falls back to OpenClaw tools | tbd |
| P9 | Tool approvals through OpenClaw | permission hook to `before_tool_call` / exec approval | approx (spiked): shell and MCP ask; native edits do not ask (only allow/deny) | tbd |
| P10 | Tool policy (`tools.allow`/`deny`) enforced | `toolAvailabilityEnforcement: "execution-args"` | spike: translated to per-agent `cli-config.json` `Mcp(server:tool)` rules (allow rule verified) | tbd |
| P11 | Skills as a native plugin | temporary plugin via `--plugin-dir` | spike: `cursor-agent --plugin-dir`; fallback: prompt catalog | tbd |
| P12 | System prompt every turn | `--append-system-prompt-file`, `systemPromptWhen: "always"` | spike: no system-prompt flag known; prompt prefix or ACP | tbd |
| P13 | Images | `imageArg: "@"`, workspace scope | spike | tbd |
| P14 | Native and manual compaction | `ownsNativeCompaction`, `/compact` | spike | tbd |
| P15 | History reseed and fallback prelude | `reseedFromRawTranscriptWhenUncompacted`, prelude from Claude JSONL | approx: reseed with a Cursor API-key profile; prelude from Cursor transcripts: spike | tbd |
| P16 | Usage per turn | parsed from the terminal event | `-p`: match (`result.usage`); ACP: gap so far (no usage in `session/prompt`) | tbd |
| P17 | Clean env, watchdog, timeouts | `clearEnv`, `reliability.watchdog` | match | tbd |
| P18 | Side questions without tools | `sideQuestionToolMode: "disabled"` | match: `--mode ask` | tbd |
| P19 | Binary detection, live tests | `runtimeArtifact`, `liveTest` | match: detect `cursor-agent`; reuse OpenClaw live-test harness | tbd |

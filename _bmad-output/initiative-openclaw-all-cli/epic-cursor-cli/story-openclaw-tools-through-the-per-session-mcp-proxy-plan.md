---
title: 'OpenClaw tools through the per-session MCP proxy'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '6e0d93161c5913023e24b0023ac5ae58a39f2c6d'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Cursor cannot reach OpenClaw's tools. OpenClaw mints a new loopback MCP URL and token for every run, but a warm live session keeps one Cursor process across turns, so a URL handed to `session/new` goes stale after turn 1.

**Approach:** Per AD-12 the core runs one local HTTP MCP endpoint per live session (`127.0.0.1`, random port, its own random Bearer token) and gives Cursor only that endpoint as MCP server `openclaw` through ACP `mcpServers`. At the start of each turn the core reads the turn's loopback URL and headers (`Authorization`, `x-openclaw-cli-capture-key`) from the JSON file named by `GEMINI_CLI_SYSTEM_SETTINGS_PATH` in the execute env (`mcpServers.openclaw`) and the proxy forwards to them. Outside a turn it rejects every call. The backend sets `bundleMcp: true` and `bundleMcpMode: "gemini-system-settings"` so the host writes that file; parity row P7.

## Boundaries & Constraints

**Always:** The proxy lives in `src/core/` and names no CLI (AD-2). It binds `127.0.0.1` only and requires its own Bearer token on every request. The target is replaced at each turn start and cleared when the turn ends or aborts, even on error. Forward the MCP HTTP request body, method and response (including streamed bodies) unchanged except for the target URL and the two headers. The proxy closes with its live session. The adapter receives the endpoint as `mcpServers` in `OpenParams` and hands it to ACP `session/new` and `session/load`. A turn whose settings file is missing or lacks `mcpServers.openclaw` still runs, with the proxy rejecting calls (tools unavailable, logged), because the Cursor chat itself must not break.

**Never:** Hand the CLI the host's per-run URL or token directly; write MCP config into a workspace or a file the user owns (AD-7); filter or translate OpenClaw tools (host does it); permission routing (entry 4); `nativeToolMode` changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two turns, one warm session | Turn 1 and turn 2 carry different URLs/tokens | Each tool call reaches that turn's target with that turn's headers | No error expected |
| Call outside a turn | Between turns, or after abort | Rejected with HTTP 503 and a JSON-RPC style error | Target never reused from an earlier turn |
| Wrong client token | Request without or with a wrong Bearer | HTTP 401, nothing forwarded | No error expected |
| No settings file | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` unset or unreadable | Turn runs without tools; proxy rejects calls | Warning logged, turn not failed |
| Target down | Forward fails (connection refused) | HTTP 502 to the CLI | Turn continues |
| Live session closes | Idle close, abort, restart | Proxy server closed, port freed | No error expected |
| Parallel sessions | Two live sessions | Two proxies, two ports, two tokens, no crosstalk | No error expected |

</intent-contract>

## Code Map

- `src/core/mcp-proxy.ts` (new) -- the per-session proxy: `startMcpProxy()` returns `{ url, token, setTarget, clearTarget, close }`; Node `http` + `fetch` streaming
- `src/core/mcp-target.ts` (new) -- read the turn target from the settings file (`mcpServers.openclaw`: `url` or `httpUrl`, `headers`)
- `src/core/execute.ts` -- start the proxy in `openEntry`, set the target at turn start from `ctx.env`, clear in `finally`, close with the entry; pass `mcpServers` to the adapter
- `src/core/ports.ts` -- `OpenParams.mcpServers`
- `src/core/backend.ts` -- `bundleMcp: true`, `bundleMcpMode: "gemini-system-settings"`, `hostOwnedTools: ["exec", "process"]`, `toolAvailabilityEnforcement: "prepare-execution"`; leave `nativeToolMode`
- `src/adapters/cursor/index.ts` -- pass `mcpServers` to `AcpSession.open`; `src/transports/acp/session.ts` already accepts `mcpServers` (ACP `McpServer` http shape: `type: "http"`, `name`, `url`, `headers: [{name, value}]`)
- `.spike/openclaw/node_modules/openclaw/dist/prompt-context-*.mjs` -- read-only reference: `writeGeminiSystemSettings`, `writeGeminiMcpCaptureSettings` show the exact file shape; verify the real shape by running an OpenClaw turn and reading the file named in `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
- `test/live/`, `test/fixtures/`, `docs/providers/cursor.md`, parity matrix P7, `manifest.ts` P7
- Facts: real `cursor-agent acp` honors `session/new.mcpServers` (HTTP + headers) and asks permission for MCP calls only when not allowed; the AD-9 file already allows `Mcp(openclaw:*)`. Isolated OpenClaw is in `.spike` (Node 24); real cursor-agent and `CURSOR_API_KEY` are available on this host.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/mcp-proxy.ts`, `src/core/mcp-target.ts` -- proxy and target reader -- AD-12
- [ ] `src/core/execute.ts`, `ports.ts`, `backend.ts`, adapter -- wire it; set/clear target per turn; close with the session
- [ ] unit tests -- every matrix row (proxy forwarding with a stub target, 401, 503, 502, retarget, parallel proxies, close frees the port, missing settings)
- [ ] live test (`test/live/`, gated) -- real cursor-agent, a stub HTTP target standing in for OpenClaw records the Authorization and capture-key headers; two consecutive turns of one warm `createExecute` session each make Cursor call a tool and each reaches the stub with that turn's headers; a request to the proxy between turns is rejected
- [ ] end-to-end check -- in the isolated OpenClaw with real Cursor, ask `cursor-cli/auto` to use an OpenClaw tool and record what happened in Implementation Notes (this answers the ticket's uncertainty about the settings file)
- [ ] docs, manifest and parity P7 -- match behavior and the evidence

**Acceptance Criteria:**
- Given one warm session and two turns with different targets, when Cursor calls an OpenClaw tool in each turn, then each call reaches that turn's target with that turn's headers.
- Given no turn is running, when anything calls the proxy, then it is rejected.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

The proxy is a thin forwarder, not an MCP server: it does not parse tool calls. Cursor speaks MCP streamable HTTP to it; it relays method, path, body and the response stream. Headers to Cursor stay the proxy's own Bearer; headers to the target are the turn's. Keep it dependency-free (Node `http`, global `fetch`).

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY`

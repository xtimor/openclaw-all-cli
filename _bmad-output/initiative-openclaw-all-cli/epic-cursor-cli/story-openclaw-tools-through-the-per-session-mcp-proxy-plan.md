---
title: 'OpenClaw tools through the per-session MCP proxy'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: 'in-review'
baseline_revision: '6e0d93161c5913023e24b0023ac5ae58a39f2c6d'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: []
deferred:
  - summary: >-
      A Cursor MCP GET/SSE stream cut between turns and rejected on reconnect may disable the openclaw server.
    evidence: |-
      Observed harmless on 2026.10.3 where every turn restarts; settle on a host with a stable fingerprint.
    location: >-
      src/core/mcp-proxy.ts
    severity: medium (unverified)
  - summary: >-
      Mcp-Session-Id from turn 1 reaches turn 2's target.
    evidence: |-
      Only matters with warm reuse across host runs, which 2026.10.3 does not do.
    location: >-
      src/core/mcp-proxy.ts
    severity: medium (unverified)
  - summary: >-
      Nothing checks without a Cursor login that the real host writes GEMINI_CLI_SYSTEM_SETTINGS_PATH with a loopback mcpServers.openclaw.
    evidence: |-
      Checked only by the live tests; needs a fake-agent env log.
    location: >-
      test/isolated-openclaw.test.ts
    severity: medium
  - summary: >-
      hostOwnedTools and toolAvailabilityEnforcement are set without enforcement code.
    evidence: |-
      Settle by reading how the host treats the value when toolAvailabilityEnforced is not returned; entry 4 owns it.
    location: >-
      src/core/backend.ts
    severity: medium (unverified)
  - summary: >-
      No warm reuse in gemini-system-settings mode on 2026.10.3 (per-turn settings path is hashed into the fingerprint); if a host stabilises it, per-turn credentials would get 401 after activate adopts the first turn's token.
    evidence: |-
      Cannot happen on this host. Revisit with entries 7 and 8.
    location: >-
      src/core/execute.ts
    severity: medium (unverified)
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

Built as planned (`mcp-proxy.ts`, `mcp-target.ts`, wiring in `execute.ts`, `ports.ts` `McpServerSpec`/`OpenParams.mcpServers`, adapter mapping to the ACP http shape). Deviations and evidence:

- **Order.** Cursor connects to MCP servers inside `session/new`/`session/load` and drops a server after one rejected connection. The first real-host run failed that way (host 401: its MCP grant capture is only active after `live.activate`). So `execute` now creates the handle and proxy, calls `live.register` and `live.activate`, points the proxy at the turn target, and only then calls `adapter.open`. A failed open removes the handle. Host `register`/`activate` errors still propagate as throws.
- **Manifest flags.** `deriveFlags` gained `mcp` (P7 decided); `backend.ts` sets `bundleMcp`, `bundleMcpMode: "gemini-system-settings"`, `hostOwnedTools: ["exec","process"]`, `toolAvailabilityEnforcement: "prepare-execution"` from it. `nativeToolMode` stays `always-on`, so `hostOwnedTools` is inert today (the host applies it only with `execution-args`) and `prepareExecution` does not claim `toolAvailabilityEnforced`.
- **Warnings.** `buildCliBackend` takes `warn`; `register.ts` passes the plugin logger.
- **Target check.** `readTurnTarget` accepts only a loopback `http` URL, so the proxy never carries the host token elsewhere.
- **Live runs.** `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` passes (real `cursor-agent` with `CURSOR_API_KEY`): `mcp-proxy.live.test.ts` runs two turns of one warm `createExecute` session against a stub host (each tool call reaches that turn's host with that turn's `Authorization` and capture key; a call between turns gets 503) and one `openclaw agent --local` turn that calls `session_status` through the proxy. `vitest.config.ts` runs live files serially because two `openclaw agent` runs at once contend for the isolated state.
- **End-to-end answer (the ticket's settings-file uncertainty).** In the isolated OpenClaw 2026.10.3 with real Cursor, `ctx.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH` is always set and the file has `mcpServers.openclaw` with `url` (`http://127.0.0.1:<gateway port>/mcp`, `type: "http"`), `Authorization: Bearer <64 hex>` and `x-openclaw-cli-capture-key` already resolved. `cursor-cli/auto` listed 47 OpenClaw tools and called `agents_list` and `session_status` through the proxy (`--local`, and on a Gateway for two turns of one session).
- **Two turns on a Gateway.** The file differs per turn (new path, token, capture key; same URL). The host's live-session fingerprint hashes the env, including that path, so `live.current().fingerprint !== live.fingerprint` on every later turn: no warm reuse in this mode, each turn restarts the process and resumes with `session/load` (P4 is now `approx`). Both turns reached the tools. Between turns Cursor's SSE `GET` got 503 and Cursor did not retry harmfully.
- **Risk for AD-12.** If a host version stabilises the fingerprint, `live.activate` moves the later turn onto the first turn's bearer and capture key (`adoptProcessToken`, `beginCapture(record.capture.key)`), so the later turn's file credentials would be rejected. Not reachable with 2026.10.3; needs a decision (pin the first turn's credentials per process) before it is.

## Plan Change Log

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 19 findings — high 0, medium 6, low 9, false 0, maybe-false 4
- findings:
  - `medium` `patch` Blind/Edge/VGap: `live.activate` throwing after `live.register` closes only the proxy; the host keeps a registered handle with no session — verified in execute.ts; patch: close the handle (which also removes it); add a test
  - `medium` `patch` Blind: a host `handle.close()` during `adapter.open` is a no-op for the not-yet-attached session, so cursor-agent leaks and the turn runs on a closed proxy — verified (`closing` guard, session attached later); patch: after `attachSession`, if the handle was closed, close the new session and end the turn; add a test
  - `low` `patch` Edge: a run superseded while `startMcpProxy` is pending registers over the current run's handle — patch: `assertCurrent()` after `createEntry`, closing the proxy on throw
  - `low` `patch` Edge: `createEntry`/`startMcpProxy` failures throw raw where open failures give an error record — patch: same error-record path as `attachSession`
  - `medium` `patch` Edge: a first turn without usable settings lets Cursor see 503 at connect and drop the server for the life of that process, so later warm turns lose tools — patch: mark such an entry degraded and not reusable
  - `maybe-false` `defer` Blind/Edge: `clearTarget` cuts a Cursor MCP GET/SSE stream between turns and the reconnect gets 503, which may disable the server — maybe-false: observed harmless on 2026.10.3 where every turn restarts; settle on a host with a stable fingerprint
  - `maybe-false` `defer` Blind/Edge: `Mcp-Session-Id` from turn 1 is sent to turn 2's target — maybe-false: only matters with warm reuse across hosts runs, which 2026.10.3 never does
  - `low` `patch` Blind: only `x-openclaw-cli-capture-key` is dropped from the CLI's request headers; other `x-openclaw-*`, `cookie`, `origin`, `x-forwarded-*` reach the host — patch: drop them
  - `low` `patch` Blind/Edge: a target URL with a query or fragment builds a broken upstream URL, and a blank `httpUrl` hides a valid `url` — patch: build with `URL`, ignore blank `httpUrl`
  - `low` `reject` Blind: request body has no size limit — loopback, token-gated; the cap adds a branch for no reachable harm
  - `low` `patch` Blind: `docs/setup.md` banner still says warm session (contradicts P4 approx); user docs carry host internals; claim that the proxy is the only MCP server Cursor loads — patch: banner, move internals to MEMORY.md, word the claim as what the plugin hands over
  - `medium` `patch` Blind/VGap: the real-host live test passes on any reply with a version string, so it does not prove a tool call crossed the proxy, and the real-host path (restart plus `session/load` plus mcpServers) has only one turn — patch: use a unique session id the reply must contain (from `session_status`), and run two turns of one session
  - `medium` `patch` VGap: no test covers activate-throws, proxy closed on host refusal, warn plumbing through backend and register, or GET/DELETE/subpath/query forwarding — patch: add them
  - `medium` `defer` VGap: no check without a Cursor login that the real host sets GEMINI_CLI_SYSTEM_SETTINGS_PATH with a loopback `mcpServers.openclaw`; the contract is checked only by the live tests — deferred: needs a fake-agent env log; recorded here
  - `maybe-false` `defer` Blind: `hostOwnedTools` and `toolAvailabilityEnforcement: "prepare-execution"` are set with no enforcement code behind them — maybe-false (medium if true): settle by reading how the host treats the value when `toolAvailabilityEnforced` is not returned; entry 4 owns enforcement
  - `low` `patch` Blind/Edge: the proxy starts and warns even for an adapter whose manifest does not decide P7 — patch: pass the flag into `createExecute`
  - `low` `reject` Blind: the missing-settings warning repeats every turn — noise only
  - `maybe-false` `defer` Intent: with OpenClaw 2026.10.3 the host hashes the per-turn settings path into the live-session fingerprint, so there is no warm reuse in this mode (P4 approx); and if a host stabilises the fingerprint, `activate` moves later turns onto the first turn's credentials and per-turn forwarding would get 401 — maybe-false: cannot happen on this host; decision: keep per-turn credentials as AD-12 says and revisit with entries 7 and 8
  - `low` `reject` Intent: readings of the intent and the stand-in surface of the two-turn test — descriptive; the real-host run is covered by the new two-turn live test

## Design Notes

The proxy is a thin forwarder, not an MCP server: it does not parse tool calls. Cursor speaks MCP streamable HTTP to it; it relays method, path, body and the response stream. Headers to Cursor stay the proxy's own Bearer; headers to the target are the turn's. Keep it dependency-free (Node `http`, global `fetch`).

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY`

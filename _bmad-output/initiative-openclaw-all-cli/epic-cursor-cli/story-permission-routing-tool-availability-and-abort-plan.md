---
title: 'Permission routing, tool availability, and abort'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: 'eda690f1c6b0908fe1bb871710a21a326b9dc35f'
route: 'full'
route_source: 'auto'
risk: 'medium'
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

**Problem:** Entry 2 rejects every Cursor permission request and the backend still declares `nativeToolMode: "always-on"`, so OpenClaw's approval policy never decides a native action and the host cannot select which native tools a run may use.

**Approach:** Route each ACP permission request to `ctx.requestToolPermission` (the host owns approval authority; the plugin only asks) and answer from its result. Declare `nativeToolMode: "selectable"` with `toolAvailabilityEnforcement: "prepare-execution"` and return `toolAvailabilityEnforced: true` from `prepareExecution` only for what the plugin really enforces. On abort, answer every pending permission request `cancelled`, so a turn waiting on a human ends cleanly (AD-11). Update parity P8, P9, P10 (P10's mechanism per AD-9). Open question to settle with live evidence: whether ACP edits can be made to ask.

## Boundaries & Constraints

**Always:** Core stays CLI-agnostic (AD-2): the adapter maps an ACP request to a canonical OpenClaw tool name and input (`exec`, `write`, `edit`, `delete`, `web_fetch`, `read`, `grep`, `glob`, or the MCP server/tool) and the core calls `ctx.requestToolPermission`. `allow` -> the ACP `allow_once` option; `deny`, an error, or no matching option -> reject (never allow on failure). A request that arrives after abort or turn end is answered `cancelled`. Per-turn policy never goes into a file (AD-6); the static AD-9 file from entry 2 stays. `toolAvailabilityEnforced: true` is returned only if native availability for the run is enforced by what the plugin does; otherwise keep the honest setting and record why.

**Never:** Claim enforcement that does not exist; allow a native action the host did not approve; add timers (the host owns them); change the OpenClaw-tool proxy of entry 3; translate `tools.allow`/`deny` in the adapter (the host filters the OpenClaw tool list).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Host allows | A permission request the host approves | ACP `allow_once` selected | No error expected |
| Host denies | Shell request the host denies | ACP reject selected; the model falls back to OpenClaw `exec` | No error expected |
| Host call fails | `requestToolPermission` throws | Reject (fail closed) | Logged, turn continues |
| Abort while waiting | Turn aborted with a request pending a human | Request answered `cancelled`; the turn ends cleanly, no hang | No error expected |
| Late request | Request arrives after the turn ended | Answered `cancelled`, never forwarded to the host | No error expected |
| No matching option | ACP offers only options of another kind | `cancelled` | No error expected |
| Excluded tool | Host selection leaves a native tool out | That tool is denied | No error expected |

</intent-contract>

## Code Map

- `src/core/execute.ts` -- `rejectPermission` becomes the routing function using `ctx.requestToolPermission`; pass the turn's abort signal; cancel pending requests on abort/turn end
- `src/core/ports.ts` -- `PermissionRequest` gains the canonical `toolName`/`toolInput` the adapter derives; `PermissionDecision` stays
- `src/transports/acp/session.ts` -- `requestPermission` builds the request from `params.toolCall` (kind, title, rawInput, locations); `cancelPermissions` already exists
- `src/adapters/cursor/` -- ACP kind/title to canonical tool name mapping; manifest P8/P9/P10
- `src/core/backend.ts` -- `nativeToolMode`, `toolAvailabilityEnforcement`, `hostOwnedTools` (flags from the manifest), `prepareExecution` returns `toolAvailabilityEnforced` and reads `ctx.toolAvailability`
- `src/adapters/cursor/index.ts` -- `requiredModeId: "ask"` was a stopgap "until entry 4"; decide with evidence whether sessions keep it
- Host reference (read-only): `.spike/openclaw/node_modules/openclaw/dist/cli-backend.types-*.d.ts` (`CliBackendToolAvailability`, `CliBackendToolPermissionRequest/Result`, `toolAvailabilityEnforced`) and `prepare.runtime-*.mjs` around `canEnforceExactToolAvailability`
- Facts: real `cursor-agent acp` with the entry-2 file (deny `Shell(*)`, `Write(**)`, `WebFetch(*)`; allow `Read(**)`, `Mcp(openclaw:*)`) denies shell and writes with no request and lets read/grep work, so requests arise only for actions the file neither allows nor denies. A test home without those rules makes Cursor ask for shell and apply edits unasked (entry 2 evidence, 2026-10-17). Real cursor-agent and `CURSOR_API_KEY` are available.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/execute.ts`, `ports.ts`, `session.ts`, adapter mapping -- route requests to the host and answer by its decision; `cancelled` after abort/turn end
- [x] `src/core/backend.ts` -- selectable native tools, `prepare-execution` enforcement, `toolAvailabilityEnforced` only for real enforcement; settle with live probes how the host selects native tools and what the plugin can enforce; record the design and evidence in Implementation Notes
- [x] settle "whether ACP edits can be made to ask" by a live probe and record the result in Implementation Notes and the P9 row
- [x] unit tests -- every matrix row (fake agent with scripted permission requests, a stub `requestToolPermission`)
- [x] live test (gated) -- with a test home that leaves shell to ask: a shell request the stub host denies makes the model use the OpenClaw `exec` tool (through the proxy) instead; abort mid-approval ends the turn cleanly; a tool the host denies via `tools.deny` is absent from the model's tool list
- [x] docs, manifest, parity P8/P9/P10 -- match behavior and evidence

**Acceptance Criteria:**
- Given a shell request the host denies, when the model runs, then it falls back to OpenClaw `exec`.
- Given a `tools.deny` tool, when the model lists tools, then the tool is absent.
- Given an abort while a permission request awaits approval, when the turn is aborted, then the request is answered `cancelled` and the turn ends cleanly.

## Implementation Notes

**Design.**
- Routing lives in `src/core/permissions.ts` (`routePermission`), called from the handler `execute.ts` gives `adapter.open`. The handler reads the entry's current `turn`, because a warm process outlives turns: a request with no turn, a finished turn, an aborted turn, or a superseded run (`assertCurrent`) is answered `cancelled` and never reaches the host. A tool outside `ctx.toolAvailability.native` is rejected without asking. Otherwise `ctx.requestToolPermission` decides (`abortSignal` passed; the core also races the abort, so a host that ignores the signal cannot hang the turn). Error, malformed answer, or an `updatedInput` that differs from the request (ACP cannot apply a rewrite) reject. No timers.
- `AcpSession` builds an `AcpPermissionRequest` (title, kind, call ID, option IDs, content, and `rawInput`/paths joined from earlier `tool_call` updates; the request itself carries no `rawInput`). `src/adapters/cursor/permissions.ts` names it (`exec`, `write`, `edit`, `delete`, `read`, `grep`, `glob`, `web_fetch`, `web_search`, `mcp__<server>__<tool>`) in the input shape of OpenClaw's tool of that name; the adapter rejects what it cannot name (unknown operation, no path, a question prompt) without asking the host.
- Abort: `session.cancel()` (unchanged) already answered pending requests `cancelled`; the core handler adds the same on its side. Live: the turn ends, the process exits, no hang.
- `backend.ts`: `nativeToolMode: "selectable"` + `prepare-execution` now follow manifest P10 (`DerivedFlags.toolPolicy`); `bundleMcp`/`hostOwnedTools` stay under P7. `CliAdapter.alwaysOnNativeTools` (Cursor: `read`, `grep`, `glob`) names the natives the adapter cannot switch off per turn. `prepareExecution` returns `toolAvailabilityEnforced: true` only when `ctx.toolAvailability` is set and keeps all of them; otherwise it throws a message and the host never starts the run. A run without `toolAvailability` gets no flag.

**Evidence (live, 2026-10-17, cursor-agent 2026.10.16, `CURSOR_API_KEY`).**
- Edits cannot be made to ask: in agent mode an edit (inside or outside the workspace) was applied with no request under no permissions, `approvalMode: allowlist`, `Write(nothing/**)` allow, and sandbox enabled; `ask` and `plan` mode have no edit tool. P9 stays `approx`; edits stay denied by `Write(**)` and `ask` mode.
- `ask` mode stays: it is the only lock that survives a changed permission file, a shell request in `ask` mode asks and runs after approval, and MCP works in it. Cost: the model refuses file-changing commands there, even if approved.
- How the host selects native tools: `ctx.toolAvailability = {native, openClaw}` is set only for capped runs; 2026.10.3 always sends `native: []` (runtime tools cap, `disableTools`, system agent, trusted handoff, rooted runs). The plugin cannot switch off `read`/`grep`/`glob` per turn (a per-turn file is excluded by AD-6), so it cannot honestly enforce `native: []`; such runs are refused, as they were under `always-on`. Plain runs and `tools.deny` runs work. A static second home denying `Read(**)`, `Grep(**)`, `Glob(**)` would enforce it (grep and glob return nothing then); not built, since it splits the chat store and AD-9 says one file for every agent.
- `hostOwnedTools` is inert with `prepare-execution` in 2026.10.3 (`resolveCliMcpToolOwnership` needs `execution-args`), so no real run offers `exec`; a real run listed 47 OpenClaw tools and no `exec`, also with `tools.allow: [session_status, exec]`. The acceptance fallback to `exec` is shown with a stub host serving `exec`. Follow-up for the epic: `execution-args` enforcement with `resolveExecutionArgs`, or an `exec` the host serves.
- `tools.deny` of `session_status` and `web_fetch` removed both from the model's list through the real host (`test/live/permission-routing.live.test.ts`).
- Tests: `npm run typecheck && npm run build && npx vitest run` pass; `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` passes (8 tests) after `npm run dev:install`.

## Plan Change Log

## Review Triage Log

## Design Notes

The host owns approval authority; the plugin only forwards a request and obeys the answer (fail closed). The static file stays the first line of defence; requests are the second, for what the file leaves open.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)

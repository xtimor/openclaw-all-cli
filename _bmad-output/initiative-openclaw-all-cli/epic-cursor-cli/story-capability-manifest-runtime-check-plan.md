---
title: 'Capability manifest runtime check'
type: 'feature'
ticket: '12'
created: '2026-10-18'
status: 'ready-for-dev'
baseline_revision: 'bd4a0ce10420d9647345dd189d36856dd5eb1818'
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
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md'
  - '{project-root}/MEMORY.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `deriveFlags` covers seven rows (P4, P5, P7, P10, P13, P15, P18). Some mechanisms still ignore the manifest: `hostOwnedTools` hangs off P7 instead of P8, and `clearEnv` (P17), `modelAliases` and the catalog (P1), synthetic auth (P2), permission routing (P9), `readUsage` (P16) and the `liveTest` probes are always on. Nothing compares the manifest with what the CLI reports. A CLI without HTTP MCP or `loadSession` runs with flags that claim P7/P5 and fails later in vague ways, or does not fail at all. The P6 gap reason ("no fork or checkpoint flag") is thin, and no test makes gap rows give a reason.

**Approach:** Give every backend mechanism exactly one parity row in `deriveFlags`, and list the rows that set no flag, each with a reason. Manifest rows declare the runtime capabilities they need (`requires`). The ACP transport reports capabilities from `initialize`. Right after `adapter.open`, the core fails the turn with `capability_mismatch` when a decided row's requirement is missing. Record concrete gap reasons, checked against the matrix.

## Boundaries & Constraints

**Always:** AD-2 (the core names no CLI; the transport maps ACP fields to neutral capability names; Cursor's requirements live in its manifest). The check runs on every process open (agent turn and side question, new and resumed) and only for rows marked `match`/`approx`. A CLI that reports more than the manifest claims is fine. A session that reports nothing (`capabilities` undefined) is not checked. On a mismatch: close the session, release the slot/lock/chat the same way a failed open does, never send the prompt, `retryable: false`. The Cursor backend's registered flags stay identical except `liveTest.defaultMcpProbe` (now true, from P7). Defaults of new `ExecuteOptions` keep today's behavior.

**Never:** Check the model listing's throwaway session. Fail on a model list missing at open (P1: `cursor-cli/auto` keeps working without one; model turns already fail `capability_mismatch` in `switchModel`). Turn `available_commands_update`, `agentInfo`, or the version into checks (the version stays AD-14 `unsupported_version`). Set `forkArg`/`resumeAtArg`, `systemPromptWhen`, `ownsNativeCompaction`, or skills flags. Warn about manifest under-claims. Change the transport's existing loadSession-before-resume and required-mode checks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real Cursor | 2026.10.16 init: `loadSession`, `mcpCapabilities{http,sse}`, `promptCapabilities.image` | Turn runs | No error expected |
| No HTTP MCP | P7 decided, `mcpCapabilities` absent or `http:false` | No prompt sent, process closed | `capability_mismatch`, message names P7 and "HTTP MCP" |
| No loadSession, new chat | P5 decided, `loadSession` absent/false, `useResume` false | Fails on the first turn (session/new already ran) | `capability_mismatch` naming P5 |
| No loadSession, resume | same, `useResume` true | Existing transport check fires before `session/load` | `capability_mismatch` (existing text) |
| Side question | P7 decided, no HTTP MCP | Fails too: the check is about the CLI, not the turn | `capability_mismatch` |
| Row undecided | P13 `spike` with `requires:["imagePrompts"]`, agent has no image | Turn runs | No error expected |
| Several missing | P5 and P7 | One error listing both rows | `capability_mismatch` |
| No report | Adapter session without `capabilities` | Not checked | No error expected |
| Login method gone | `authMethodId` set, agent lists `[{id:"other"}]` | No `authenticate` call | `capability_mismatch`: offered no "cursor_login" login method, lists "other" |
| Empty auth list | `authMethods: []` | No `authenticate`, session continues | No error expected |
| Auth list absent | `authMethods` undefined | `authenticate` called (as today) | Existing `auth` mapping |
| Reused process | Warm entry already checked | No re-check | No error expected |
| Row flags | All-`tbd` manifest | Backend has only structural fields (id, command, args, output, input, sessionMode, parseJsonlEvent, prepareExecution, `nativeToolMode: "always-on"`) | No error expected |
| P9 undecided | Permission request in an agent turn | Rejected, host never asked | `cancelled` after the turn, as today |
| P16 undecided | `result` without usage | `readUsage` never called | No error expected |
| P2 undecided | Synthetic auth asked | Returns undefined without probing | No error expected |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `ParityRow` (131): add optional `requires?: readonly CliCapability[]`. Add the `CliCapability` union `"resumeSession" | "httpMcp" | "imagePrompts"`. `CliSession` (216): optional `readonly capabilities?: ReadonlySet<CliCapability>` (undefined means not reported). Keep `createManifest`.
- `src/core/manifest.ts` -- `DerivedFlags`/`deriveFlags`. Add `models` (P1), `auth` (P2), `hostTools` (P8), `approvals` (P9), `usage` (P16), `cleanEnv` (P17), `liveTest` (P19). Exported `FLAG_ROWS: Record<keyof DerivedFlags, ParityRowId>` and `NO_FLAG_ROWS: Partial<Record<ParityRowId, string>>`, with reasons for P3 (streaming is the AD-3 seam itself), P6, P11, P12, P14 (no core mechanism; must not be decided). `missingCapabilities(manifest, reported) → Array<{row, capability}>` (decided rows only) and `capabilityMismatch(displayName, missing): CliError`. Message: `Capability mismatch: <displayName> does not report <label> (parity row <id>), which the plugin's manifest needs. Update the CLI.` Labels: session resume, HTTP MCP servers, image prompts.
- `src/core/backend.ts` -- `buildCliBackend` (34-128). Move `hostOwnedTools` out of the `flags.mcp` spread (52-61) into `flags.hostTools`. `clearEnv` (76) only with `cleanEnv`. `modelAliases` (85) only with `models`. `liveTest` (40-44) only with `liveTest`: `defaultImageProbe: flags.images`, `defaultMcpProbe: flags.mcp`. Pass `approvals` and `usage` to `createExecute` (106-115).
- `src/core/execute.ts` -- `ExecuteOptions` (24-51): `approvals?`, `usage?` (default true). `attachSession` (364-456): after the `waitForExit().then(releaseLock)` line (417) and the `entry.closed` check, run `missingCapabilities`. On a miss, `await session.close().catch(() => {})` and throw `capabilityMismatch`; the callers' existing catch closes the handle and yields the error record (528-534). `onPermissionRequest` (402-405): `!approvals` takes the side-question branch. `readTurnUsage` call (585-597): only when `usage`.
- `src/core/synthetic-auth.ts` -- `createSyntheticAuthProvider` (52-112). `catalog` only when `flags.models`. `withoutKeys(..., adapter.clearEnv)` only when `cleanEnv`. `prepareSyntheticAuth` returns undefined before probing when `!flags.auth`.
- `src/transports/acp/session.ts` -- `setup` (560-637) returns `capabilities`, mapped from `init.agentCapabilities`: `loadSession === true` → `resumeSession`, `mcpCapabilities?.http === true` → `httpMcp`, `promptCapabilities?.image === true` → `imagePrompts`. `AcpSession` (274-295) exposes it. Auth (581-590): a non-empty list without `authMethodId` throws `capability_mismatch`; `[]` skips `authenticate`.
- `src/adapters/cursor/manifest.ts` -- `P5.requires: ["resumeSession"]`, `P7.requires: ["httpMcp"]`, `P13.requires: ["imagePrompts"]` (not checked while `spike`). New P6 note (Design Notes).
- `test/fixtures/fake-cursor-agent.mjs` -- `initialize` (258-265) defaults to the real report: `{loadSession:true, mcpCapabilities:{http:true,sse:true}, promptCapabilities:{audio:false,embeddedContext:false,image:true}, sessionCapabilities:{list:{}}}`, no `agentInfo`. `FAKE_CURSOR_CAPS=<json>` shallow-merges into `agentCapabilities`. `FAKE_CURSOR_AUTH_METHODS=<json>` replaces `authMethods`. Update the header comment.
- Reuse: `test/live/operations.live.test.ts` `fakeShim`/`useCommand`/`ask` patterns, `harness.ts` `openclaw`, `describeLive`. `src/adapters/cursor/index.ts` `listModels` already opens without a manifest; leave it.
- Parallel ticket 1.19 (plugin-served exec) also touches P8/`hostOwnedTools`/the proxy. If it landed first, put its P8 mechanism under `hostTools` too.

## Tasks & Acceptance

**Execution:**
- [ ] `test/fixtures/fake-cursor-agent.mjs` -- real-shaped init, `FAKE_CURSOR_CAPS`, `FAKE_CURSOR_AUTH_METHODS` -- every later test needs them; without `httpMcp` in the default every fake turn would fail.
- [ ] `src/core/ports.ts`, `src/transports/acp/session.ts` -- capability type, `requires`, session report, auth-method mismatch.
- [ ] `src/core/manifest.ts`, `src/adapters/cursor/manifest.ts` -- full flag set, row tables, `missingCapabilities`, `capabilityMismatch`, Cursor `requires` and P6 reason.
- [ ] `src/core/backend.ts`, `src/core/execute.ts`, `src/core/synthetic-auth.ts` -- gate each mechanism on its flag; the check after open.
- [ ] Unit tests -- `manifest.test.ts`: each flag from its row alone. `FLAG_ROWS` ∪ `NO_FLAG_ROWS` covers P1–P19 exactly once. `missingCapabilities` matrix rows. For every adapter in `ADAPTERS`: each `gap` row has a non-empty note, the matrix cell for it reads `gap: <reason>`, and P6/P11/P12/P14 are not decided. `test/backend.test.ts`: an all-`tbd` manifest gives only structural fields. Toggling each row alone adds exactly its fields (table-driven). Rows whose mechanism lives elsewhere add no backend field: P2, P13 and P1's catalog live in the provider entry, P9 and P16 in execute, and the `liveTest` probes need P19 as well. Those are asserted where they live. The Cursor backend is unchanged except `defaultMcpProbe`. With the fake agent through `prepareExecution`/`execute`: `FAKE_CURSOR_CAPS={"mcpCapabilities":{"http":false}}` ends in an error event `code: "capability_mismatch"` naming P7, `FAKE_CURSOR_LOG` has no `session/prompt`, and the process exits. The same caps with P7 `spike` give a normal reply. `session.test.ts`: the capability mapping and the three auth rows. `execute.test.ts`: stub session missing a capability (slot, lock, chat released; handle closed), no report means no check, `approvals: false`, `usage: false`. `synthetic-auth`/catalog tests: P1, P2, P17 undecided.
- [ ] `test/live/capability-check.live.test.ts` (gated; AD-10, P5, P7) -- (a) fake shim exporting `FAKE_CURSOR_CAPS={"mcpCapabilities":{"http":false}}` and `FAKE_CURSOR_LOG`, set as `cursor-cli.command`; `openclaw agent --local` output contains `Capability mismatch` and `P7`, and the log has no `session/prompt`. (b) The same with `{"loadSession":false}` naming P5. (c) Real Cursor with the command unset: a turn replies, so real Cursor passes the check. Unset the command in `afterAll`.
- [ ] Docs -- `docs/providers/cursor.md`: a "Capability check" subsection under Operations covers what is checked at each open (P5 session resume, P7 HTTP MCP, P13 once decided), the checks that already exist (ask mode, model list for a named model, ACP protocol, version) and the rows with no runtime signal. Add the new P6 reason to the parity table. `docs/setup.md` troubleshooting: `Capability mismatch: ... (parity row Pn)` → run `cursor-agent update`, or report it with the version; a `no "<id>" login method` row. Parity matrix P6 cell. Architecture AD-10 rule: "the core checks, right after the adapter's open, the capabilities the session reports". MEMORY: the real `initialize` report (2026.10.16, below), no fork/resume capability, and the new fake knobs.

**Acceptance Criteria:**
- Given an all-`tbd` manifest and each parity row decided alone, when the backend is built, then it carries exactly the fields of that row's flag and no others.
- Given a CLI that does not report HTTP MCP while the manifest decides P7, when a `cursor-cli` turn runs through OpenClaw, then the turn fails with a `Capability mismatch` error naming P7, the plugin's error event has code `capability_mismatch`, and no prompt reaches the CLI.
- Given real `cursor-agent` 2026.10.16, when a turn runs, then it replies normally.
- Given the Cursor manifest, when its gap rows are read, then each states a reason, and the matrix row says the same gap with a reason.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Already built, kept:** flags for P4/P5/P7/P10/P13/P15/P18. In the transport: `capability_mismatch` for resume without `loadSession`, for a missing required mode (P9/P18 lock), and for a named model when no models are listed (P1). `unsupported_version` for ACP protocol ≠ 1 and the version floor (AD-14, P19). This ticket adds only the manifest-driven check, the auth-method check, and the missing flag gates.
- **Why the core checks, not each adapter:** AD-10 puts the check "at open". Doing it in `attachSession` on the session's report covers every future adapter (CAP-12) and can be tested with a stub adapter. The cost on a mismatch is one wasted `session/new`. The adapter still owns the requirements (its manifest), and the transport owns the mapping from the protocol.
- **Runtime-verifiable rows:** P5 (`loadSession`), P7 (`mcpCapabilities.http`; the proxy is HTTP), P13 (`promptCapabilities.image`, once decided). The other rows have no signal at open (P3, P4, P8, P10, P15–P17), are checked elsewhere (P1, P9/P18 mode, P19 version), or are not decided.
- **Real report (probed 2026-10-18, cursor-agent 2026.10.16-e3cb207, temp `CURSOR_CONFIG_DIR`, API key):** `protocolVersion 1`; `agentCapabilities {loadSession:true, mcpCapabilities:{http:true,sse:true}, promptCapabilities:{audio:false,embeddedContext:false,image:true}, sessionCapabilities:{list:{}}}`; `authMethods [{id:"cursor_login"}]`; no `agentInfo`. `session/new`: modes agent/plan/ask, 46 models, `configOptions` `mode` and `model` selects, then an `available_commands_update` with Cursor's built-in skills (async; not used).
- **P6 reason (manifest and matrix):** "cursor-agent has no fork or checkpoint: no CLI flag, and ACP initialize reports sessionCapabilities with list only (no fork, no resume); OpenClaw 2026.10.3 copies a CLI binding into a forked session only for a backend with forkArg and resumeAtArg (`forkCliSessionBindings`), so a forked OpenClaw session starts a new Cursor chat."
- **`liveTest` probes** are read only by the host's live-test defaults (`resolveCliBackendLiveTest`), never at runtime.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass, live tests skipped.
- `npm run dev:install && NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/capability-check.live.test.ts` -- expected: 3 passed (real `cursor-agent` and `CURSOR_API_KEY` are present on this host).
- `npm run test:live` -- expected: the whole live suite still passes (the fake's new default init, and the check on every real turn).
- `pgrep -fa "cursor-agent|fake-cursor-agent"` after the run -- expected: none left by the tests.

## Auto Run Result

- Status: ready-for-dev (halted after planning, as the invocation asked).
- Planning evidence (2026-10-18): real `cursor-agent acp` 2026.10.16 `initialize` and `session/new` probed with a temp config dir (see Design Notes). The host forks a CLI binding only when the backend has `forkArg` and `resumeAtArg`. `liveTest` probes are read only by host live-test defaults.
- Recommended review: thorough. Every turn goes through the new check, and execute's permission and usage paths gain gates.
- Coordination: ticket 1.19 (plugin-served exec) may change P8 and `hostOwnedTools` in parallel.
- Live Cursor check: possible on this host (`CURSOR_API_KEY` set); not run at planning time.

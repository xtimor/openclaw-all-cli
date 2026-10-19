---
title: 'Plugin-served exec tool for the model'
type: 'feature'
ticket: '19'
created: '2026-10-18'
status: done
baseline_revision: '1b76c2c62a505e53d392aa373165b6ae98688e32'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** On real OpenClaw 2026.10.3 a `cursor-cli` turn has no shell. Cursor's native Shell is denied (AD-9). The host serves its own `exec`/`process` (`hostOwnedTools`) only to backends with `toolAvailabilityEnforcement: "execution-args"` and a `resolveExecutionArgs` (`resolveCliMcpToolOwnership`, `prepare.runtime-*.mjs`). Our backend declares `prepare-execution`, so a real run listed 47 tools and no `exec`.

**Approach:** Use claude-cli's own mechanism (option b). Declare `execution-args` and add a `resolveExecutionArgs` that returns the host's `baseArgs` unchanged. Refuse a run whose native selection the adapter cannot enforce. The host then puts OpenClaw's real `exec` and `process` on its loopback MCP. The plugin's proxy already forwards them. OpenClaw's exec code runs the command: approvals (`tools.exec.ask`/`security`, `exec.approval.*`), sandbox, timeout, output cap, env sanitising, and killing the child on abort (the loopback aborts the tool when the HTTP request closes). The host also denies native `exec` permission requests itself ("Use OpenClaw exec"). The plugin writes no exec code of its own. `process` comes with it (same host list): in scope, no extra code.

Rejected: (a) an `exec` the plugin serves itself. It would re-implement OpenClaw's approvals, sandbox and limits outside OpenClaw's policy, and it would differ from claude-cli. (c) Opening native Shell behind `requestToolPermission`. AD-9 forbids it, and it bypasses the sandbox.

## Boundaries & Constraints

**Always:**
- Native Shell, Write and WebFetch stay denied in the static home file (AD-9). The host's contract is "the execution-args adapter must disable the equivalent native tools", and the static `Shell(*)` deny is that.
- Approvals, policy, sandbox and limits stay OpenClaw's. The proxy stays a thin forwarder: it reads no tool call (AD-12).
- `hostOwnedTools` is set only when P7, P8 and P10 are all decided. Flags come from the manifest alone (AD-10).
- Build on ticket 1.12 once it has landed: it may move flag derivation in `backend.ts`/`manifest.ts`, so re-read both first.

**Never:**
- Plugin-side command execution, command parsing, or allow/deny lists.
- Loosening the home's permissions.
- Writing into the workspace (AD-7). The model's own commands may write there.
- Logging commands, env or tokens.
- New timers (AD-11).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| Plain run | Default exec policy | Model lists `exec` and `process`. A command runs through OpenClaw `exec` in the turn's workspace, and its output is in the reply | — |
| Approval required | `tools.exec.ask: always` | A pending approval appears (`exec.approval.list`). Allow-once → runs | — |
| Denied | Approval resolved `deny`, or `security: deny` | Command does not run, and the model gets OpenClaw's denial. It cannot fall back to native Shell (still denied) | Turn ends normally |
| Timeout | `timeout` param / `tools.exec.timeoutSec` exceeded | OpenClaw kills the command and reports the timeout | Turn continues |
| Huge output | ~3 MB stdout | OpenClaw's output cap truncates it. The proxy relays the result, and the turn completes | — |
| Long call >15 s | `sleep 20; echo token` | Host keepalive frames pass through the proxy, and the token reaches the reply | — |
| Abort mid-run | Turn aborted during `sleep` | Child gone within 10 s. Its follow-up side effect never happens | Abort error, as today |
| Non-zero exit | `exit 3` | Exit code and output go to the model | Turn continues |
| cwd escape | `workdir` outside the workspace / `cd /` | Exactly OpenClaw exec policy (as for claude-cli). Default cwd is the workspace. A sandboxed run stays in its sandbox | — |
| Concurrent calls | Two exec calls in flight | Each gets its own response | — |
| `tools.deny: [exec, process]` | Config | Both are absent from the model's list, and no command runs | — |
| Sandboxed agent | `agents.*.sandbox.mode: all` | Command runs inside the sandbox, or the run is refused. Never on the Gateway host | — |
| Exec host `node`, capped/rooted run | Host does not set `hostOwnedTools` | No exec (documented gap: claude-cli falls back to native Bash there) | Capped `native: []` is refused, as today |
| Unenforceable selection | `toolAvailability` drops read/grep/glob | `prepareExecution` refuses. `resolveExecutionArgs` returns `undefined` (host fails closed) | Clear message |

</intent-contract>

## Code Map

- `src/core/backend.ts` -- flags block (`toolPolicy` → enforcement, `mcp` → `hostOwnedTools`), `prepareExecution` refusal (`unenforceableNativeTools`) and `toolAvailabilityEnforced`. The host only reads `toolAvailabilityEnforced` for `prepare-execution` (line 1435), so drop it.
- `src/core/manifest.ts` `DerivedFlags`/`deriveFlags` -- add a host-tools flag (P7 && P8 && P10)
- `src/core/permissions.ts` `unenforceableNativeTools` -- reuse it in `resolveExecutionArgs`
- `src/adapters/cursor/manifest.ts` P8/P9/P10 notes; `index.ts` `CURSOR_PERMISSIONS` (unchanged), `MODE_BY_EXECUTION` (`ask`; see the probe task)
- `src/core/mcp-proxy.ts` -- unchanged unless a test fails (it already streams, `requestTimeout = 0`, and aborts upstream on CLI disconnect or `clearTarget`)
- `test/fixtures/stub-mcp-host.ts` (exec stand-in), `test/fixtures/fake-cursor-agent.mjs` (no MCP calling yet), `test/backend.test.ts` lines 39-41 and 170-185, `test/live/harness.ts` (`startGateway`, `openclaw`, `waitFor`), `test/live/permission-routing.live.test.ts` (the stub-host fallback test stays)
- Host (read-only, `.spike/openclaw/node_modules/openclaw/dist/`):
  - `prepare.runtime-*.mjs` `resolveCliMcpToolOwnership` (~480)
  - `execute.runtime-*.mjs`: `resolveExecutionArgs` call (~3315; a capped run with a nullish return throws), plugin path passes `executionArgs` into `ctx.args` (~1990), `createPluginToolPermissionHandler` (~1370)
  - `mcp-http.runtime-*.mjs` `constructMcpLoopbackTools` (`defaultMediatedToolNames`)
  - `mcp-http-*.mjs` `keepMcpResponseAlive` (15 s `\n` frames), `createHttpRequestAbortSignal`
  - `cli-shared-*.mjs` `resolveClaudeCliExecutionArgs` (claude disallows `Bash` when `hostOwnedTools` has exec)
  - `exec-defaults-*.mjs` (`tools.exec.host|security|ask`)
  - Gateway methods `exec.approval.list`, `exec.approval.resolve` (`decision`: `allow-once|allow-always|deny`)

## Tasks & Acceptance

**Execution:**
- [x] `src/core/manifest.ts`, `src/core/backend.ts` -- `toolAvailabilityEnforcement: "execution-args"` under P10; `resolveExecutionArgs(ctx)` returns `ctx.baseArgs`, or `undefined` when `ctx.toolAvailability` is unenforceable; `hostOwnedTools: ["exec","process"]` under the new flag; drop `toolAvailabilityEnforced` -- claude-cli's mechanism; the host serves exec only this way
- [x] `test/backend.test.ts` -- flags per manifest (P8 gap → no `hostOwnedTools`); `resolveExecutionArgs` for plain, resume, side question, an enforceable selection, an unenforceable one; refusal message unchanged
- [x] `test/fixtures/fake-cursor-agent.mjs`, `test/fixtures/stub-mcp-host.ts`, `src/core/execute.test.ts`, `src/core/mcp-proxy.test.ts` -- the fake agent gets `[[mcp-call]]<json>`: `initialize` plus `tools/call` on its session's MCP server, then it replies with the tool's text. The stub `exec` gets a delay, keepalive frames and a hang mode, and records closed requests. Tests: an exec call reaches the stub with the turn's target headers; abort mid-call closes the upstream request and ends the turn; two concurrent calls are answered separately; keepalive frames are relayed before the body; a native shell request is still rejected
- [x] `src/adapters/cursor/index.ts`, `openclaw.plugin.json` -- live probes first (results go in Implementation Notes). In `ask` mode, does the real model run a file-changing command through OpenClaw `exec` (3 tries)? If it refuses, switch `MODE_BY_EXECUTION.agent` to `agent` (side questions stay `ask`), but only after a live run with the production home shows native shell, write and web fetch still blocked in agent mode. Also: Cursor's MCP client timeout (`sleep 90`, `timeout` 120); whether `CURSOR_API_KEY` is visible to `env` run through exec, and if it is, whether declaring it as the provider's auth env var in `openclaw.plugin.json` (host `listKnownProviderAuthEnvVarNamesCore`) removes it with no change to auth readiness. Adopt that if it works; otherwise document it
- [x] `test/live/exec-tool.live.test.ts` (gated, Gateway via `startGateway`, own port, `npm run dev:install` first) -- the matrix rows Plain, Approval required, Denied (approval and `security: deny`), Timeout, Huge output, Long call, Abort mid-run (`gateway call sessions.abort` with the session `key`, or `chat.abort`), Non-zero exit, `tools.deny`. Then the sandboxed agent, skipped with a logged reason when `docker info` fails. Prove each command ran with unguessable output (`/dev/urandom`) or a marker file in a temp dir; prove it did not run by the marker staying absent. Restore every config key in `finally`
- [x] `src/adapters/cursor/manifest.ts`, `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` P8/P9/P10, `docs/providers/cursor.md` (permissions, approvals table, parity rows, limitations: replace "No OpenClaw exec" with node/capped gap, Cursor MCP timeout, env finding), `docs/setup.md` (shell commands follow `tools.exec.*`), `MEMORY.md` (host facts and probe results) -- same change (AD-10)
- [x] `_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md` AD-9 -- flag list `prepare-execution` → `execution-args` + `resolveExecutionArgs`; `exec`/`process` served by the host. The principle ("follows claude-cli") is unchanged

**Acceptance Criteria:**
- Given a real OpenClaw turn on `cursor-cli/auto` through a Gateway, when the user asks for a shell command, then it runs through OpenClaw `exec` (reply holds its unguessable output) with Cursor's home still denying `Shell(*)`.
- Given `tools.exec.ask: always`, when the model calls exec, then a pending approval appears; denied, the marker stays absent; allowed once, it exists.
- Given the change, when `npm run typecheck && npm run build && npx vitest run` runs, then all pass and the import-boundary test holds.

## Implementation Notes

Adapted to ticket 1.12: flags come from `FLAG_ROWS`; the core gives `hostTools` only the P8 row, so `backend.ts` sets `hostOwnedTools` when `hostTools && toolPolicy && mcp` (P8, P10, P7 all decided; test per row). No new `DerivedFlags` field.

Changes:
- `src/core/backend.ts`: `toolAvailabilityEnforcement: "execution-args"` and `resolveExecutionArgs` (returns `ctx.baseArgs`, or `undefined` for a selection `unenforceableNativeTools` flags); `toolAvailabilityEnforced` dropped; `prepareExecution` keeps its early refusal and message.
- `src/adapters/cursor/index.ts`: the Cursor mode is `agent` only when the host serves exec for the run (`OpenParams.hostShell`), else `ask`; side questions stay `ask` (first built as always `agent`, narrowed after review). Tests: `index.test.ts` (mode, side question still needs `ask`).
- Tests: `test/backend.test.ts` (flags, `resolveExecutionArgs` plain/resume/side question/enforceable/unenforceable, `hostOwnedTools` gating), new `test/exec-tool.test.ts` (real backend + proxy + fake agent `[[mcp-call]]` + stub host: headers, concurrent calls, keepalive, abort closes upstream and ends the turn, native shell request still rejected), `src/core/mcp-proxy.test.ts` (keepalive relay, hang-up closes upstream, parallel calls). `src/core/mcp-proxy.ts` needed no change.
- Live: `test/live/exec-tool.live.test.ts` (own Gateway on port 18931, `connectApprovalClient` in `test/live/harness.ts`): plain, native shell and write blocked, approval allow-once and deny, `security: deny`, `tools.deny`, timeout, long call, 3 MB output, non-zero exit, abort mid-run; sandbox row skipped (no docker daemon on this host, logged). Every config key is restored in `afterAll`.
- Docs: manifest notes P8, P9, P10; parity matrix; `docs/providers/cursor.md` (Shell commands section, parity rows, limits); `docs/setup.md`; `MEMORY.md` entry 19; AD-9 now names `execution-args` + `resolveExecutionArgs`.

Probe results (cursor-agent 2026.10.16, OpenClaw 2026.10.3):
- Ask mode refuses file-changing commands through exec: 1 of 3 ran, 2 refused ("Ask mode is on"). 
- Agent mode with the production home: native Shell, Write, Edit, Delete blocked without a request (marker files stayed absent; a Task subagent could not write either). A native web fetch asks the host in both modes; `WebFetch(*)` does not stop it. This corrects older wording that the file stops web fetch.
- Cursor MCP call timeout: 60 s (call arrived at 26.6 s, error at 86.4 s; with 10 s keepalive frames: 11.5 s and 71.5 s). Cursor does not hang up the request then. A 90 s exec made the model re-run it in the background and read it with `process` (final output correct).
- `CURSOR_API_KEY` is visible to exec commands. `setup.providers[].envVars` did not remove it and changed auth display, so it is not adopted; documented, with the login-only alternative.
- Approvals need an approval-capable client: a headless `openclaw agent` run is denied at once under `ask: always`; with a WS client (`caps ["approvals"]`, admin scope) the approval is pending and allow-once runs the command, deny does not.

- Cost of agent mode: the model acts more eagerly (a trivial "remember this" turn: 6 tool calls, about 105k tokens), and OpenClaw's `cli_budget` compaction can then fail the turn without an API model. It failed `history-continuity.live.test.ts` (c) once in the full suite; a re-run of that file passed 5 of 5. Documented in Known limits.

Unverified: the sandbox row (no docker daemon here); exec host `node` and capped runs (documented from the host source, not run); behavior on OpenClaw versions other than 2026.10.3.

## Plan Change Log

- **ask -> agent (build).** The plan's gate for `MODE_BY_EXECUTION.agent = agent` read "native shell, write and web fetch still blocked in agent mode". It was met for shell, write, edit and delete (blocked without asking). It was NOT met for web fetch: `WebFetch(*)` has no effect, a native web fetch asks the host in `ask` and `agent` mode alike, and OpenClaw's tool policy decides. Accepted because the host, not the static file, is the control there in both modes. Review then narrowed the switch: `agent` only when the host serves `exec` for the run, else `ask` (see Triage Log).
- **No `DerivedFlags` field.** The plan's Code Map asked for a new host-tools flag (P7 && P8 && P10). After ticket 1.12 each flag has exactly one row (`FLAG_ROWS`), so `hostTools` stays P8 and `backend.ts` combines `hostTools && toolPolicy && mcp`.
- **Matrix corrections.** "Timeout" and "Abort mid-run" in the intent contract said OpenClaw kills the child when the request closes and implied that covers a long call. Real behavior: Cursor gives up on a call at 60 s and never hangs up, so a foreground command past that kept running while the model retried. The proxy now stops a `tools/call` at 55 s (upstream abort, host kills the command). A turn abort closes the call and OpenClaw kills the processes within 10 s (live). The contract text is read-only; docs and the parity matrix carry the corrected statement.
- **Added scope (review).** Plugin config `env` (key reaches the CLI process only), the host-shell marker, the call deadline.

## Review Triage Log

Thorough review, 4 lenses. Fixed:
1. (major) Foreground exec past Cursor's 60 s limit: proxy deadline 55 s with upstream abort and a model-readable tool error (`src/core/mcp-proxy.ts`); unit tests with an injected small deadline (never-answering host, keepalive-started response, event stream, fast call and non-call traffic untouched), an end-to-end test through the backend, and a live row that the command is dead after the turn. Documented, including `tools.deny: ["process"]` alone.
2. (major) `agent` mode only when the host serves exec: `resolveExecutionArgs` appends a marker (the plugin's execute context has no `hostOwnedTools`), `createExecute` strips it, keys the reuse on it and sets `OpenParams.hostShell`; the Cursor adapter chooses `agent` or `ask`. Tests assert the exact mode (the fake starts in `plan`, reports its mode with `[[mode]]`). Comments corrected (WebFetch).
3. (major) Key visible to exec: yes, a supported mechanism exists. Plugin config `cursor-cli.env` becomes the backend `config.env`, given to the CLI process only; probes get it too. Live row with a Gateway started without the key. Documented as the way after login; warnings added to `docs/setup.md`. The plugin strips nothing from the Gateway env.
4. Documented: sandbox with two workspaces and native reads leaving it, exec writing the agent home (only `permissions` restored), native exec request protected by `Shell(*)` alone where the host serves no exec (P8 wording and the unit-test comment fixed), the 60/55 s limit, rooted vs refused `native: []`, setup troubleshooting row for a missing `agent` mode.
5. Logged above; AD-9 amended (WebFetch deny has no effect; mode rule); AD-12 notes the call deadline.
6. A selection that lists native `exec` stays accepted: it is over-restrictive, not a bypass (Cursor can never run native exec). Refusing it would break runs that select all native tools. Said in the code comment and docs.
7. Live rows rewritten: native shell/write/edit/delete must be attempted (a non-`mcp__` tool in the tool summary, up to 3 tries) and stay blocked; `tools.deny` asserts the turn completed and no hidden tool was called (retried); huge output with head and tail secrets; the timeout is reported to the model; random exit code; sandbox row asserts a host-only file is not readable (skipped without a Docker daemon, logged); every LLM-dependent row retries up to 3 times and fails loudly.
8. The concurrency test no longer pins a stub detail; the two-slow-calls test proves overlap.
9. The flaky cap test now starts the second turn only after the first prompt is running and sleeps 1500 ms.
Follow-up review, fixed:
- (major) `hostOwnedTools` does not reflect tool policy, so the marker alone put Cursor in `agent` mode with no exec when `tools.deny`/`tools.allow` dropped it. The core now reads the host's `tools/list` (`listToolNames`) before the open and sets `hostShell` only if `exec` is in it; an unreadable list, a missing target or no marker means `ask` (fail safe). Tests: list with exec, without exec, empty, failing, no marker, no target; the backend + fake agent asserts the exact mode (`agent` with exec, `ask` without). Known gap: a reused warm process keeps the mode of its open (the reuse key has the marker, not the list); OpenClaw 2026.10.3 restarts the process every turn, so it does not occur there.
- Found by the live run: the first `listToolNames` parsed the answer wrongly (tool descriptions contain `data:`), so every real turn fell back to `ask`; the unit tests had used short descriptions. Fixed (JSON first, SSE `data:` line second) with a test whose descriptions contain `data:`. The live rows now compute their secret when the script runs, so a model that reads the script cannot quote it; a turn failed by OpenClaw's budget compaction (no API model on this host) counts as an unusable try and the rows try up to five times.
- Second follow-up: a process opened without exec because the tool list could not be read (marker present, list undefined) is marked degraded and never reused, so the next turn reads the list again (test: first read fails, second turn gets `agent`). A call inside a batch gets a neutral "status unknown" text (one timer covers the batch, the call may have finished); a batch of notifications is answered with 202 and no body.
- (major, docs) `cursor-cli.env` keeps the key out of exec's environment, not out of its reach (same user: `/proc/<pid>/environ`, the config file); docs recommend login, approvals, sandbox.
- The deadline leaves a response alone once it carries data (JSON and SSE tests); a batch containing a `tools/call` gets the deadline and is answered as a batch (tool error per stopped call, a JSON-RPC error for each other request); a batch without a call has none.
10. Deferred: an offline test that pins the host contract (that this backend shape makes the host serve exec/process). It needs the host's `resolveCliMcpToolOwnership`, which is not exported; the live rows cover it.

## Design Notes

The host already holds the policy, approvals and sandbox. The cheapest secure exec is the host's own, reached through a flag the host treats as a promise: "native equivalents are disabled". Our static `Shell(*)` deny keeps that promise. `baseArgs` pass through unchanged, so the launch argv and the reuse key (AD-13) do not change.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `npm run dev:install && npm run test:live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY`. A row that cannot run on this host (no docker, no Cursor login) is recorded as not run, with the reason

## Auto Run Result

- Status: ready-for-dev (halted after planning, as asked). Route full (auto), risk high, review thorough (pinned by the orchestrator).
- Approach: switch the backend to `execution-args` with a pass-through `resolveExecutionArgs`, so OpenClaw 2026.10.3 serves its own `exec`/`process` through the loopback the proxy already forwards. Native Shell stays statically denied.
- Build waits for ticket 1.12; re-read `backend.ts`/`manifest.ts` after it lands. The build amends AD-9's flag wording.

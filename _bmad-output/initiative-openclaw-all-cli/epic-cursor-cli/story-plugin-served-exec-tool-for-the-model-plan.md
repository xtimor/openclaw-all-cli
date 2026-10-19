---
title: 'Plugin-served exec tool for the model'
type: 'feature'
ticket: '19'
created: '2026-10-18'
status: 'in-progress'
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
- [ ] `src/core/manifest.ts`, `src/core/backend.ts` -- `toolAvailabilityEnforcement: "execution-args"` under P10; `resolveExecutionArgs(ctx)` returns `ctx.baseArgs`, or `undefined` when `ctx.toolAvailability` is unenforceable; `hostOwnedTools: ["exec","process"]` under the new flag; drop `toolAvailabilityEnforced` -- claude-cli's mechanism; the host serves exec only this way
- [ ] `test/backend.test.ts` -- flags per manifest (P8 gap → no `hostOwnedTools`); `resolveExecutionArgs` for plain, resume, side question, an enforceable selection, an unenforceable one; refusal message unchanged
- [ ] `test/fixtures/fake-cursor-agent.mjs`, `test/fixtures/stub-mcp-host.ts`, `src/core/execute.test.ts`, `src/core/mcp-proxy.test.ts` -- the fake agent gets `[[mcp-call]]<json>`: `initialize` plus `tools/call` on its session's MCP server, then it replies with the tool's text. The stub `exec` gets a delay, keepalive frames and a hang mode, and records closed requests. Tests: an exec call reaches the stub with the turn's target headers; abort mid-call closes the upstream request and ends the turn; two concurrent calls are answered separately; keepalive frames are relayed before the body; a native shell request is still rejected
- [ ] `src/adapters/cursor/index.ts`, `openclaw.plugin.json` -- live probes first (results go in Implementation Notes). In `ask` mode, does the real model run a file-changing command through OpenClaw `exec` (3 tries)? If it refuses, switch `MODE_BY_EXECUTION.agent` to `agent` (side questions stay `ask`), but only after a live run with the production home shows native shell, write and web fetch still blocked in agent mode. Also: Cursor's MCP client timeout (`sleep 90`, `timeout` 120); whether `CURSOR_API_KEY` is visible to `env` run through exec, and if it is, whether declaring it as the provider's auth env var in `openclaw.plugin.json` (host `listKnownProviderAuthEnvVarNamesCore`) removes it with no change to auth readiness. Adopt that if it works; otherwise document it
- [ ] `test/live/exec-tool.live.test.ts` (gated, Gateway via `startGateway`, own port, `npm run dev:install` first) -- the matrix rows Plain, Approval required, Denied (approval and `security: deny`), Timeout, Huge output, Long call, Abort mid-run (`gateway call sessions.abort` with the session `key`, or `chat.abort`), Non-zero exit, `tools.deny`. Then the sandboxed agent, skipped with a logged reason when `docker info` fails. Prove each command ran with unguessable output (`/dev/urandom`) or a marker file in a temp dir; prove it did not run by the marker staying absent. Restore every config key in `finally`
- [ ] `src/adapters/cursor/manifest.ts`, `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` P8/P9/P10, `docs/providers/cursor.md` (permissions, approvals table, parity rows, limitations: replace "No OpenClaw exec" with node/capped gap, Cursor MCP timeout, env finding), `docs/setup.md` (shell commands follow `tools.exec.*`), `MEMORY.md` (host facts and probe results) -- same change (AD-10)
- [ ] `_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md` AD-9 -- flag list `prepare-execution` → `execution-args` + `resolveExecutionArgs`; `exec`/`process` served by the host. The principle ("follows claude-cli") is unchanged

**Acceptance Criteria:**
- Given a real OpenClaw turn on `cursor-cli/auto` through a Gateway, when the user asks for a shell command, then it runs through OpenClaw `exec` (reply holds its unguessable output) with Cursor's home still denying `Shell(*)`.
- Given `tools.exec.ask: always`, when the model calls exec, then a pending approval appears; denied, the marker stays absent; allowed once, it exists.
- Given the change, when `npm run typecheck && npm run build && npx vitest run` runs, then all pass and the import-boundary test holds.

## Implementation Notes

## Plan Change Log

## Review Triage Log

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

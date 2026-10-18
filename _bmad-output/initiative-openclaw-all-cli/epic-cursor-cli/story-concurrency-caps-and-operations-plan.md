---
title: 'Concurrency caps and operations'
type: 'feature'
ticket: '8'
created: '2026-10-18'
status: 'in-progress'
baseline_revision: '8188cf52650e89ce23f9b32bf9336e866e99a798'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The core has no per-backend cap on turns or processes, never enforces the Cursor version floor (P19 says "recorded, not enforced"), declares no `clearEnv`, tracks no process outside the host's handles, so a killed Gateway leaves `cursor-agent acp` orphans (probed: real `cursor-agent acp` stays up after stdin EOF), and nothing closes live processes when the plugin unloads (the host closes none at shutdown).

**Approach:** Add a per-backend process pool in the core: a turn cap, a process cap with idle eviction, close-all on unload, and per-home pid lock files with stale reaping. The adapter adds a `--version` check against the manifest floor and a `clearEnv` list. Timers stay the host's. Parity rows P17, P19. The AD-8 fallback lane is not built: entry 1 found that OpenClaw 2026.10.3 accepts `liveSession: "claude-stdio"` from this plugin (1.1 plan, "liveSession: works"), so AD-8 stands unamended.

## Boundaries & Constraints

**Always:** AD-2: the core names no CLI; version parsing, the clear list, and the pid hand-off from the transport stay in the adapter/transport. AD-11: no new turn timer; a wait for a slot ends only on a free slot or `ctx.abortSignal`. Never kill a process unless its recorded pid **and** start time still match, and its owner Gateway is gone. Release every slot on every exit path (throw, abort, superseded run, error record). Lock files live only in the agent home (AD-6/AD-14, mode 0600, dir 0700), never in the workspace (AD-7). Logs carry no tokens, headers, or prompt text.

**Never:** Build the AD-8 core lane or `serialize: false`. Declare host `runtimeArtifact` (it cannot describe Cursor, see Design Notes). Kill by process name (`pkill`), or kill a process that a live Gateway owns. Start a per-turn watchdog. Change permission routing, events, the MCP proxy, or the resume/reuse rules of entries 4 and 7.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Under caps | 2 agents run turns at once, defaults (4 turns, 8 processes) | Both run at once | No error expected |
| Turn cap full | `maxConcurrentTurns` turns running, one more arrives | It waits FIFO, then runs when a slot frees | Abort while waiting: leaves the queue, throws the abort, holds no slot |
| Process cap full | `maxProcesses` processes, one idle, a new process is needed | The least recently used idle process is closed (`idle`), then the new one opens | No error expected |
| Process cap full, none idle | Only possible with a broken invariant | Turn fails | Retryable `overloaded`, slot released |
| Bad caps config | `maxProcesses` < `maxConcurrentTurns`, or out of 1..64 | Defaults used | Warning, as for any invalid backend config |
| Version ok | `--version` prints `2026.10.16-e3cb207` | Cached per backend and command; later processes skip the check | No error expected |
| Version too old | `2026.05.01-abc` | Turn fails before any ACP process starts | `unsupported_version`: found version, minimum `2026.07.06`, `cursor-agent update` |
| Version unreadable | Non-zero exit, timeout, or unparseable text | Turn runs; not cached, checked again next process | Warning |
| Binary missing | `--version` spawn ENOENT | Turn fails | `cli_not_found` (same text as the transport's) |
| Protocol mismatch | `initialize` answers protocol ≠ 1 | Turn fails (exists in `setup`) | `unsupported_version` |
| Gateway killed | SIGKILL; orphans recorded in `<home>/pids/` | On restart: plugin register (configured agents) and first home use (any agent) kill recorded orphans (SIGTERM, then SIGKILL after 2 s) and delete their locks; first home use waits for that before opening | Reap failures logged, never fail the turn |
| Another live Gateway | Lock owner pid alive with the recorded start time | Lock and process left alone | No error expected |
| Pid reused | Recorded pid alive, start time differs | Not killed; lock deleted | No error expected |
| Corrupt/foreign lock | Unparseable JSON, or a file name that is not `<pid>.json` | Corrupt `<pid>.json` deleted; other names ignored | Logged |
| Unload | Gateway stop or plugin dispose with busy and idle processes | Every process of every backend closed; returns after exit or the kill grace; new turns after that fail | Retryable `server_error` "shutting down" |
| Idle close | 15 idle minutes (exists) | Closed; its process slot and lock are released | No error expected |
| Host timeout | Host watchdog or `timeoutMs` aborts the signal mid-turn | Cancel, close after the 5 s grace (exists); slot and lock released | Host reports the timeout |
| Env hygiene | Gateway env holds a cleared key (e.g. `CURSOR_API_BASE_URL`) | Absent from the turn's process (host applies `config.clearEnv`) and from the catalog/auth probe (core applies the same list) | No error expected |

</intent-contract>

## Code Map

- `src/core/execute.ts` -- `createExecute` (145), `reusable` (153), `createEntry` / `handle.close` (176-217), `attachSession` / `adapter.open` (284-347), turn body (349-492; idle close 485-490). `entries` (WeakMap) and `chats` (Map) stay. The slot is taken before `reusable()`/`live.restart()`. Process slots are counted from `createEntry` until `handle.close`.
- `src/core/backend.ts` -- `BuildBackendOptions` (20), `config` block (61-78: add `clearEnv` from the adapter), `prepareExecution` (80-116: pass the pool). No `reliability`, no `serialize`, no `runtimeArtifact`.
- `src/core/register.ts` -- `registerAdapters`: one pool per adapter; close-all hook; register-time reaping in `registrationMode === "full"` only.
- `src/core/config.ts` -- `backendConfigSchema` (strict): add `maxConcurrentTurns`, `maxProcesses` (ints 1..64, refine processes ≥ turns). Regenerate `openclaw.plugin.json` `configSchema` through `buildConfigJsonSchema`.
- `src/core/home.ts` -- `prepareAgentHome`: first use of a home awaits its reap of `<home>/pids/`, one memoized promise per home, shared with register-time reaping, so a home is reaped once per process.
- `src/core/ports.ts` -- `OpenParams` (190): `onProcessStart?(pid)`. `CliAdapter` (257): `clearEnv: readonly string[]`, `checkVersion(params: {command, env, signal?}): Promise<"ok" | {warning: string}>` (throws `CliError` `unsupported_version` / `cli_not_found`). `CliSession`: `readonly pid?: number`. `unsupported_version` already exists (64, maps to `format`).
- `src/transports/acp/session.ts` -- `open` spawn (292): call `options.onProcessStart?.(child.pid)` once a pid exists; expose `pid`. The protocol check (554) stays as is. `terminate`/`KILL_GRACE_MS` for reference.
- `src/transports/process.ts` -- `runCommand` serves `--version` and `ps`.
- `src/adapters/cursor/index.ts` -- `open` (102) passes `onProcessStart`; `checkVersion` (`cursor-agent --version`, 5 s like `PROBE_TIMEOUT_MS`, `YYYY.MM.DD[-x]` compared numerically against `CURSOR_MIN_VERSION`); `clearEnv` list. `manifest.ts`: P17, P19 notes.
- `src/core/catalog.ts`, `src/core/synthetic-auth.ts` -- the env they build (`context.env ?? process.env`) drops `adapter.clearEnv`.
- `test/fixtures/fake-cursor-agent.mjs` -- `--version` prints `2026.10.14-fake` (line ~47): add `FAKE_CURSOR_VERSION`; add `t` (ms epoch) to `FAKE_CURSOR_LOG` lines.
- Host (read-only, `.spike/openclaw/node_modules/openclaw/dist/`): queue key `helpers-*.mjs` `resolveCliRunQueueKey` (with liveSession: `<backend>:owner:<hash(account, agent, authProfile, sessionId, sessionKey)>`); `cli-live-session-registry-*.mjs` `MAX_LIVE_SESSIONS = 16` (global; evicts an idle handle, else `rate_limit`); `execute.runtime-*.mjs` `createCliPluginWatchdog` (host no-output and overall timers for plugin execute; resume defaults ratio 0.3, 60-180 s) and the `clearEnv` deletion before `ctx.env`; plugin API `api.lifecycle.onDispose`, `api.lifecycle.registerRuntimeLifecycle`, `api.registerService({id,start,stop})`, `api.runtime.agent.resolveAgentDir(cfg, agentId)`.

## Tasks & Acceptance

**Execution:**
- [x] `test/fixtures/fake-cursor-agent.mjs` -- `FAKE_CURSOR_VERSION`, timestamps in the log; header comment and MEMORY fake list -- needed by every test below.
- [x] `src/core/ports.ts`, `src/transports/acp/session.ts` -- `onProcessStart`, `pid`, `clearEnv`, `checkVersion` on the port -- pids reach the core before the handshake (a crash during `session/new` still leaves a lock).
- [x] `src/core/pid-locks.ts` (new) -- `recordProcess(homeDir, pid)` writes `<home>/pids/<pid>.json` `{pid, startTime, ownerPid, ownerStartTime}` (start times from `ps -o lstart= -p <pid>`, the same on macOS and Linux; the owner's read once per process); removal when the process exits; `reapStale(homeDir, warn)` per the matrix rows. `ps` unavailable: kill nothing, warn.
- [x] `src/core/pool.ts` (new) -- `ProcessPool` per backend: FIFO turn semaphore (abort-aware), process registry with LRU idle eviction, `closeAll()` (closes every entry, waits for exits bounded by the kill grace, then marks the pool closed), version-check memo per command (success only).
- [x] `src/core/execute.ts` -- take the turn slot first and hold it for the turn; register each entry with the pool from `createEntry`; run `adapter.checkVersion` before the first `adapter.open` per backend and command; wire `onProcessStart` to `recordProcess`. `ExecuteOptions.pool?` (absent: a private, unbounded pool, so existing tests keep working).
- [x] `src/core/config.ts`, `openclaw.plugin.json`, `src/core/backend.ts`, `src/core/register.ts`, `src/core/home.ts` -- caps config; `config.clearEnv`; the pool passed through; close-all on unload; reaping at register and at first home use. Unload hook: probe in the isolated Gateway which of `api.lifecycle.onDispose`, `registerRuntimeLifecycle.dispose`, and `registerService.stop` run on Gateway SIGTERM, and register those (`closeAll` is idempotent). If none runs, add `process.once("exit")` that SIGKILLs the pool's processes synchronously. Record the result in MEMORY.
- [x] `src/adapters/cursor/index.ts`, `manifest.ts` -- `checkVersion`, `clearEnv`, `onProcessStart`, P17/P19 notes.
- [x] `src/core/catalog.ts`, `src/core/synthetic-auth.ts` -- drop the clear list from the env the listing and probe build.
- [x] Unit tests (`pool.test.ts`, `pid-locks.test.ts`, `execute.test.ts`, `backend.test.ts`, `config.test.ts`, `adapters/cursor/index.test.ts`, `session.test.ts`) -- every matrix row. Pid tests use real child processes (fake agent with `FAKE_CURSOR_IGNORE_STDIN_EOF=1`; a dead owner pid taken from a finished child).
- [x] `test/live/operations.live.test.ts` (gated, P17/P19) -- (a) real Cursor: two agents (two agent ids in the isolated config, one session each) run 20 turns each in parallel through one Gateway, all succeed; (b) fake agent through a Gateway (`cursor-cli.command` = `.spike/fake-bin/cursor-agent`): two `openclaw agent` calls to one session at once, and the fake log shows the second prompt starting after the first result; (c) real Cursor: after a turn, the Gateway is SIGKILLed (its pid only, not the group), the recorded pids are alive, then a Gateway restart with `agents.defaults.model.primary = cursor-cli/auto` reaps them within 30 s with no new turn; (d) a wrapper `command` that prints `2026.05.01-old` for `--version` (and execs the real CLI otherwise) fails the turn with `unsupported_version`; (e) a fake `[[hang]]` turn run with `openclaw agent --timeout 10` ends with the host timeout and leaves no fake process.
- [x] Docs -- `docs/providers/cursor.md`: new "Operations" section (caps, version check, orphans, unload, timers, clear env), status, P17/P19 rows; `docs/setup.md`: requirements (floor now enforced), config rows for the caps, troubleshooting (`unsupported_version`, `overloaded`, orphans); parity matrix P17/P19; spine open-question row "liveSession": answered yes by entry 1, AD-8 fallback not built; MEMORY facts (below).

**Acceptance Criteria:**
- Given two agents in one Gateway, when each runs 20 turns in parallel, then every turn succeeds, and a second turn sent to one session while its first runs starts only after the first ends.
- Given a Gateway killed with SIGKILL after Cursor turns, when the Gateway restarts, then no `cursor-agent` process recorded in the agent home is alive within 30 s, and no lock file is left.
- Given a `cursor-agent` that reports a version older than 2026.07.06, when a turn runs, then it fails with `unsupported_version` naming the found and required versions, and no ACP session starts.
- Given a Gateway stop, when processes are live, then all of them have exited by the time the stop completes.

## Implementation Notes

- **Pool** (`src/core/pool.ts`): one `ProcessPool` per adapter, made in `registerAdapters` (and by `buildCliBackend` when none is passed). FIFO turn semaphore (`acquireTurn(signal)`, abort leaves the queue and throws the signal's reason, release is idempotent and hands the slot straight to the next waiter); process registry with LRU idle eviction at `maxProcesses` (retryable `overloaded` if none is idle); `closeAll()` refuses new turns, rejects waiters, closes every member, waits up to 3 s for the exits, and is shared by repeated calls; version-check memo (success only) per command.
- **Execute** (`src/core/execute.ts`): the outer `execute` takes the turn slot (a failure to get one is an error record, an abort is a throw) and runs the old body as `run`, releasing the slot in `finally`. `createEntry` counts the process in the pool (before the proxy starts) until `handle.close`. `ensureVersion` runs before `createEntry` for the first process per command; `attachSession` records the pid through `onProcessStart` and releases the lock when the process exits or the open fails. `LiveEntry.opening` lets `closeAll` wait for a process that is still starting. A discarded not-yet-registered entry is now closed through its handle so the pool slot is freed.
- **Locks** (`src/core/pid-locks.ts`): `ps -o stat= -o lstart= -p` for start times (a zombie counts as gone; any `ps` failure except exit 1 means unavailable: record and kill nothing, warn once per logger). `reapOnce` memoizes per home; `prepareAgentHome` awaits it (new optional `warn` argument) and `registerAdapters` starts it for `main` plus the agents under `agents.entries`/`agents.list` in `registrationMode === "full"`.
- **Unload hook probe** (OpenClaw 2026.10.3, Gateway SIGTERM): `registerService.stop` and `lifecycle.onDispose` run; `registerRuntimeLifecycle.dispose` does not. Both working hooks are registered; no `process.once("exit")` fallback was needed. Recorded in MEMORY.
- **Config**: `maxConcurrentTurns` / `maxProcesses` (ints 1..64) with a refine on the effective values (defaults 4 and 8), so `maxConcurrentTurns: 9` alone is invalid. `openclaw.plugin.json` `configSchema` regenerated from `buildConfigJsonSchema`.
- **Adapter**: `checkVersion` (`--version`, 5 s, numeric `YYYY.MM.DD` compare), `CURSOR_CLEAR_ENV` (Design Notes list plus the `OTEL_*` keys of `claude-cli`'s list), `onProcessStart` passed to the transport. `clearEnv` is applied by the host to turns and by `createSyntheticAuthProvider` to the listing and the auth probe.
- **Fake agent**: `FAKE_CURSOR_VERSION`, `FAKE_CURSOR_VERSION_EXIT`, `FAKE_CURSOR_LOG_END`, `t` on every log line, `[[sleep:<ms>]]`.
- **Live tests** (`test/live/operations.live.test.ts`, harness gained `openclawAsync`, `waitFor`, and `TestGateway.pid/terminate/kill`): (a) 20 turns on each of two agents in parallel, (b) fake agent, second call to one session starts after the first result, (c) SIGKILLed Gateway, orphans reaped within 30 s of the restart, (d) wrapper reporting 2026.05.01, (e) fake `[[hang]]` with `--timeout 10`, plus Gateway SIGTERM leaving no recorded process. Each test stops its Gateways in `afterEach`, because a leftover Gateway makes the next `--local` run refuse to start.
- **Found, not fixed**: `cursor-agent acp` starts a `worker-server` child that can outlive a SIGTERMed parent (a reaped or unloaded process, or a killed model listing); it is not recorded, and a stray one disappeared by itself after a few minutes. The model listing's own throwaway process has no lock and is not closed on unload.
- **Verified (2026-10-18)**: `npm run typecheck && npm run build && npx vitest run` gave 432 passed, 26 live skipped. Full live suite with real `cursor-agent` 2026.10.16 and `CURSOR_API_KEY`: 26 passed in 8 files (`operations.live.test.ts` 6/6, including 20 turns on each of two agents in parallel). One hook in `model-catalog.live.test.ts` timed out at vitest's 10 s default (Gateway stop plus `config unset` take about 10 s); its `afterAll` now has a 120 s timeout and the file passes. No `cursor-agent`, `fake-cursor-agent`, or Gateway process was left (strays were killed by pid).
- AD-8 fallback lane not built; spine row "liveSession" answered in the architecture doc.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Already built, kept:** idle close (15 min), abort grace (5 s), cancel-then-close, ACP protocol check, `cli_not_found` on spawn ENOENT, host binary lookup (`CLI backend executable could not be resolved`), `liveTest`. Gap only: caps, version floor, `clearEnv`, locks/reaping, unload.
- **Timers:** the host already runs a no-output and overall watchdog around plugin `execute` and aborts `ctx.abortSignal`. "Honoring `timeoutMs` and `reliability.watchdog`" means using that signal and setting nothing: the backend declares no `reliability`, like `claude-cli`, so the host defaults apply. A turn waiting for a slot emits nothing, so the host watchdog may end it. That is documented, not worked around.
- **Caps:** the defaults are 4 turns and 8 processes per backend, under the host's global 16. Requiring processes ≥ turns means a turn that needs a process always finds an idle one to evict, so the pool never waits for processes.
- **`runtimeArtifact`:** the host's policy is `bundled-package-tree` only. It needs a `package.json` named for the package, with a version and no dependencies, or a shebang-free native entrypoint. Cursor's install is a bash launcher (`#!/usr/bin/env bash`) beside `package.json` `@anysphere/agent-cli-runtime` (no version, with dependencies), so the identity cannot resolve. P19 stays `approx`: the plugin does its own `--version` check.
- **Clear list (Cursor):** endpoint, harness and debug keys seen in the 2026.10.16 bundle: `CURSOR_API_BASE_URL`, `CURSOR_API_ENDPOINT`, `CURSOR_WEBSITE_URL`, `CURSOR_CONVERSATION_ID`, `CURSOR_REQUEST_ID`, `CURSOR_AGENT_PERSIST_SESSION`, `CURSOR_AGENT_DEBUG_PORT`, `CURSOR_AGENT_DEBUG_LIVE_BG`, `CURSOR_AGENT_COMPLETED_PATH`, `CURSOR_AGENT_CLI_LOCAL_MODE`, `CURSOR_AGENT_CLI_AUTHLESS_MODE`, `CURSOR_LOCAL_AGENT_HEADERS`, `CURSOR_STATSIG_OVERRIDES`, `CURSOR_HARNESS_TEST_NAME`, `CURSOR_HARNESS_RUN_ID`, `CURSOR_HARNESS_PROMPT_CATEGORY`, `CURSOR_ASKPASS_SOCKET`, `CURSOR_ASKPASS_SECRET`, `CURSOR_CLI`, `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`, `NODE_OPTIONS`, and the `OTEL_*` keys of `claude-cli`'s list. `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` are logins (P2) and are kept.
- **MEMORY facts to add:** `cursor-agent acp` ignores stdin EOF (orphans survive a killed Gateway); `initialize` carries no `agentInfo`/version; `--version` prints `YYYY.MM.DD-<hash>` in about 0.8 s; the launcher `exec`s node, so the spawned pid is the agent; the host's queue key, `MAX_LIVE_SESSIONS`, and watchdog facts above; which unload hook fires.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass, including every matrix row
- `npm run dev:install && OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` 2026.10.16 and `CURSOR_API_KEY` (present on this host), including `operations.live.test.ts`
- `pgrep -fa "cursor-agent|fake-cursor-agent"` after the live run -- expected: no process left by the tests

## Auto Run Result

- Status: ready-for-dev (halted after planning, as the invocation asked).
- Planning evidence (2026-10-18, cursor-agent 2026.10.16, OpenClaw 2026.10.3): real `cursor-agent acp` was still running 20 s after stdin closed, so it was killed by `timeout`; its `initialize` carries no version; `--version` prints `2026.10.16-e3cb207`. The host has a global cap of 16 live sessions, a per-owner queue key, and a watchdog around plugin execute. It closes no live session at shutdown, and its `runtimeArtifact` cannot describe Cursor's install.
- AD-8 fallback lane: not built, because entry 1 found that liveSession is accepted.
- Live Cursor check: possible on this host (`CURSOR_API_KEY` set); not run at planning time.

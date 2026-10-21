---
title: 'Leftovers of throwaway sessions and Cursor worker processes'
type: 'bugfix'
ticket: 21
created: '2026-10-20'
status: 'built'
baseline_revision: '17e9ea726f87e4c0009a5799c0762a3f7cd2c35c'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three things the plugin starts outlive their use: a side question's throwaway chat stays in `<home>/acp-sessions/<id>`; the model listing's `cursor-agent` has no pid lock and is not closed on unload (AD-14 exception); and Cursor's `worker-server` with its language-server chain survives a closed, reaped, or unloaded `cursor-agent` for about 5 minutes (Known limits D22/O2/F3).

**Approach:** Start every ACP `cursor-agent` as the leader of its own process group (POSIX) and stop the whole group wherever the leader is stopped or dies; record the group in the pid lock so the reaper stops it too. Remove a side question's session directory by id after its process exits. Track the listing process in a process-wide registry, lock it in the agent home, and close it on unload. Document the exact remainder.

## Boundaries & Constraints

**Always:** Signal a group only by the pgid of a leader the plugin spawned: at close, on the leader's own exit (within the same tick), within the kill grace while `kill(-pid, 0)` still finds a member, or in the reaper when the recorded leader is alive with the recorded start time and is still its group leader. ESRCH is not an error. Windows keeps today's single-process behavior. AD-2: core and transport name no CLI. Port changes are additive and optional (Antigravity hand-off). A failed lock, discard, or group signal never fails a turn or a listing (warn at most). Existing tests stay green; new tests are added. Docs and AD-14 change in the same change. Live runs use only the isolated OpenClaw.

**Never:** Kill by process name or `pkill`; signal a group whose leader is gone in the reaper; remove a session directory other than the side question's own (by its id, regex-checked as today) or a resumed chat; write into the workspace (AD-7); change the listing's env or config dir; count the listing in `maxProcesses`; edit `tickets.toml`, ticket files, or `runs/`; edit `AGENTS.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Close | Process closed (idle, eviction, abort grace, unload, failed open) | SIGTERM to the group; after `KILL_GRACE_MS` SIGKILL to the group if `kill(-pid, 0)` still finds a member. `close()` and `waitForExit()` resolve once the leader exited and the group is empty (polled every 100 ms) or the SIGKILL was sent, so the lock release and the pool's unload wait cover the members | ESRCH ignored |
| Leader dies on its own | Crash or unexpected exit, worker alive | Same group stop, started from the exit handler | none |
| Worker ignores SIGTERM | Fake worker with TERM ignored | Gone within grace + 1 s | none |
| Shared worker | Two processes of one home and workspace; the first one's group is stopped | Worker dies; the second process's turn still ends normally (it respawns the worker on its next request) | none |
| Reap, leader alive | Lock `group: true`, pid and start time match, pgid == pid, owner dead | Group stopped (TERM, wait, KILL), lock removed, existing warning | `ps` unavailable: as today |
| Reap, leader gone | Lock `group: true`, pid gone or reused | No group signal; lock removed | none |
| Old lock | No `group` field | Pid-only, as today | none |
| Side question ends | result, error, abort, or unload | After the process exited, `discardSession({env, sessionId})`; pool's `member.exited()` waits for it | discard failure ignored |
| Agent chat ends | any | Directory kept | none |
| Listing | `catalog.run` with `agentDir` | Lock in `homeDirFor(agentDir, backendId)/pids` from spawn to exit; acp-sessions dir removed as today | lock failure: warning, listing runs |
| Listing, no agentDir | context without `agentDir` | Listing runs unlocked; one warning per catalog | none |
| Unload during listing | `closeAll` while listing in flight | Listing aborted, process group stopped, lock released; `closeAll` waits at most 3 s | catalog falls back to the default row as today |

</intent-contract>

## Code Map

- `src/transports/acp/runtime.ts` -- `spawnRuntime` (spawn, `onProcessStart` call, `exit` handler), `terminate` (SIGTERM, SIGKILL after `KILL_GRACE_MS`, cleared on exit). Add `detached: process.platform !== "win32"`, a `group` flag on `Runtime`, a group stop helper shared by `terminate` and the exit handler (idempotent; the timer is unref'd). Imports only `core/ports` (AD-2).
- `src/transports/acp/session.ts` -- `AcpSessionOptions.onProcessStart` gains the info argument; `close`, `failedOpen`, abort already call `terminate`.
- `src/core/ports.ts` -- `OpenParams.onProcessStart` (line 254), `ListModelsParams` (305), `discardSession` doc (397). Add `ProcessStartInfo = { processGroup: boolean }`, optional second argument; `ListModelsParams.onProcessStart?`; `listModels` contract: settles only after the process it started has exited.
- `src/core/pid-locks.ts` -- `PidLockRecord`, `recordProcess`, `parseLock`, `inspectProcess` (`ps -o stat= -o lstart=`; add `pgid`), `reapStale`, `signal`, `waitGone`. Guards to keep: pid and start time match, owner alive check, re-check before SIGKILL, `ps` unavailable returns false.
- `src/core/attach-session.ts` -- `openProcess` records the lock in `onProcessStart` (line 91) and releases it on exit; `settleOpened` (line 107) is where a side question's discard is chained onto `session.waitForExit()`.
- `src/core/live-entry.ts` -- `member.exited()` (line 69): also await the entry's after-exit work (new optional field).
- `src/core/catalog.ts` -- `load()` (line 73) calls `adapter.listModels` with no signal. Add the listing registry (on `globalThis[Symbol.for("openclaw-all-cli.listings")]`, because `provider-discovery.ts` and `plugin.ts` are two composition roots and OpenClaw may load them as separate module instances), `CatalogParams.lockDir`, `closeListings()`.
- `src/core/synthetic-auth.ts` -- `catalog.run(context)` (line 74): OpenClaw passes `agentDir` and `workspaceDir` (`.spike/openclaw/node_modules/openclaw/dist/provider-discovery-BkPgLJBP.mjs:51-62`), and the models path always sets it (override, else the default agent dir: `models-config-D-0xvvrp.mjs:567`); add `agentDir?` to `CatalogContext`, pass `lockDir`.
- `src/core/register.ts` -- `closeAll` (line 43) also awaits `closeListings()`.
- `src/core/home.ts` -- `homeDirFor`, reused for the listing lock dir.
- `src/adapters/cursor/index.ts` -- `listModels` (line 278): forward `onProcessStart`; `removeListingSession`/`discardSession` reused for side questions.
- `test/fixtures/fake-cursor-agent.mjs` -- knobs at lines 20-38; add a worker child.
- Tests to extend: `src/transports/acp/session.test.ts` (onProcessStart at 976-1001), `src/core/pid-locks.test.ts`, `src/core/catalog.test.ts`, `src/core/execute.test.ts` (fake `onProcessStart` at 2034), `test/live/operations.live.test.ts` (rows at 149 and 167; helpers `homeOf`, `lockPids`, `processesWith`), `test/live/session-resume.live.test.ts` (side-question row at 163).
- Docs: `docs/providers/cursor.md` lines 39, 213, 237-238, 312-313; `docs/setup.md` line 151; AD-14 in `architecture-openclaw-all-cli.md` lines 160-163; `src/adapters/cursor/manifest.ts` P17/P18 notes only if their text conflicts.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` -- add `ProcessStartInfo`, the optional info argument, `ListModelsParams.onProcessStart`, the settle-after-exit contract, widen `discardSession` doc -- additive port change.
- [ ] `src/transports/acp/runtime.ts`, `session.ts` -- own process group on POSIX; group stop on close and on the leader's exit; report `{ processGroup }` -- stops worker-server and its children.
- [ ] `src/core/pid-locks.ts` -- `recordProcess(..., { group })` writes `group: true`; `parseLock` accepts an optional boolean; `inspectProcess` reads pgid; `reapStale` stops the group only per the matrix -- killed-Gateway case.
- [ ] `src/core/attach-session.ts`, `src/core/live-entry.ts` -- pass the info to the lock; discard a side question's session after exit; `member.exited()` waits for it -- O2.
- [ ] `src/core/catalog.ts`, `src/core/synthetic-auth.ts`, `src/core/register.ts`, `src/adapters/cursor/index.ts` -- listing registry, lock, abort on unload, forward `onProcessStart` -- D22 listing half.
- [ ] `test/fixtures/fake-cursor-agent.mjs` -- `FAKE_CURSOR_WORKER=1` spawns a non-detached child at `session/new` (logged as `{event:"worker", pid}` in `FAKE_CURSOR_LOG`); `FAKE_CURSOR_WORKER_IGNORE_TERM=1` -- offline proof.
- [ ] Unit tests (the files in Code Map) -- every matrix row offline, including the registry seen from two module instances (`vi.resetModules`); a mutation check per guard: drop the group signal, drop the pgid==pid check, drop the leader-alive check, drop the side-question mode check, drop the registry abort; each named test must fail, then restore.
- [ ] `test/live/operations.live.test.ts`, `test/live/session-resume.live.test.ts` -- live rows for AC 1-5 (worker forced to live: create `<home>/data/projects/<slug>` first, slug rule in Design Notes; the row must see a `worker-server` member of the leader's group during the turn).
- [ ] `docs/providers/cursor.md`, `docs/setup.md`, AD-14, `MEMORY.md` -- new behavior, the exact remainder (Design Notes), fake-agent knobs, probe facts.

**Acceptance Criteria:**
- Given a Gateway that ran a real Cursor turn and a `worker-server` was seen in that `cursor-agent`'s process group, when the Gateway is stopped with SIGTERM, and in a second run with SIGINT, then once the stop completes no process of that group remains and the agent home's `pids/` is empty.
- Given a Gateway SIGKILLed while such a group was alive, when a new Gateway starts, then within 30 s the leader and the worker are gone and the lock is removed.
- Given a real side question that ended, when its process has exited, then `<home>/acp-sessions/` holds no entry that was not there before it, and the agent chat directories are unchanged.
- Given `gateway call models.list --params '{"refresh":true}'` against a running Gateway, when the listing runs, then a lock for its process appears in the main agent home's `pids/`; after the call returns no listing process and no lock remain.
- Given a listing that hangs (`cursor-cli.command` set to a shim that runs the fake agent with `FAKE_CURSOR_NO_INIT=1`; the listing runs up to 30 s), when the Gateway gets SIGTERM, then the listing process is gone and its lock removed by the time the Gateway has exited.
- Given `docs/providers/cursor.md` Known limits and `docs/setup.md`, when a reader looks for what can still remain, then each item of the Design Notes remainder list is named with its bound, and nothing else is promised.
- Given the offline suite, when `npm test` and `npm run typecheck` run, then both pass, the counts grow only by the new tests, and `test/import-boundary.test.ts` passes.

## Implementation Notes

- Runtime: `Runtime.gone` (leader exited and group empty, or the group SIGKILL sent) backs `close()`, `waitForExit()`, and the failed-open path; `Runtime.exited` stays the leader's exit (the death race). `terminate` is idempotent through `Runtime.stopping`; the exit handler calls it in the same tick.
- Reaper: `reapGroup` signals only after the caller proved leader alive, start time equal, `pgid == pid`; its KILL repeats that proof; once the leader is gone after the TERM it sends no KILL, removes the lock, and warns that part of the group still runs (bound: the worker's own 5 minutes). A lock with `group: true` whose leader is alive but not a group leader falls back to pid-only.
- Listing registry lives in `src/core/listings.ts` (re-exported through `catalog.ts`); `lockDir` is the agent home (`recordProcess` appends `pids/`).
- Tests: +40 offline (858 -> 898 passed). Mutation checks (each named test failed, then restored): group signal, exit-handler stop, pgid == pid, leader-alive, re-check before KILL, side-question mode check, registry abort, channel close request.
- Live (cursor-agent 2026.10.19, `CURSOR_API_KEY`): see the final report of the build; the rows are in `test/live/operations.live.test.ts` and `test/live/session-resume.live.test.ts`.

## Plan Change Log

- Listing registry across threads. The plan put the registry on `globalThis` for "separate module instances". The live probe showed OpenClaw 2026.10.3 runs the provider catalog (`catalog.run`) in a worker thread (`isMainThread` false, another `globalThis`), so a `globalThis` registry never saw the listing and an unload left its lock behind (AC 5 failed). The registry now also uses a `BroadcastChannel` (`close` / `closing` / `closed`, 150 ms answer window, bounded by the 3 s wait); the `globalThis` set stays for same-thread instances. Plan text otherwise unchanged.
- Existing tests changed because the new behavior is the plan's: `catalog.test.ts` (the listing now gets its own signal and `onProcessStart`; the no-agentDir warning) and `backend.test.ts` (one failing-listing test now passes an `agentDir`).
- Live listing row: the plugin's catalog caches for a minute and the host passes no refresh flag, so the row repeats `models.list` until a call starts a listing.

## Review Triage Log

### 2026-10-21 — Review pass (thorough, 4 lenses)
- verdicts: 26 findings — high 0, medium 5, low 21, false 0, maybe-false 0
- findings:
  - `[medium]` `patch` signalGroup comment overstates safety / may signal a group after pid reuse (blind, edge x2) — comment corrected to state the residual race (window until `gone`, one poll or the grace)
  - `[low]` `reject` drainGroup has no own deadline (blind) — refuted: ESRCH/EPERM make groupHasMembers false so the loop ends; only a pid-reuse race could keep it alive, bounded by forceKill
  - `[medium]` `patch` hang-up (SIGHUP) now leaves detached groups running, undocumented (blind) — added to the remainder list in both docs
  - `[low]` `reject` closeListings aborts every listing process-wide, including a new instance's (blind, edge) — a reload overlap only costs one catalog read (falls back to the default row); owner ids would add surface for a rare overlap
  - `[low]` `reject` no shutting-down gate for listings (blind, edge) — a late listing has a pid lock, so the next start's reaper stops it; a gate adds state for a stopping Gateway
  - `[low]` `patch` fixed 150 ms answer window, late reply not waited (blind, edge) — documented as a remainder (design bound, no code change)
  - `[medium]` `patch` docs say 30 s reap holds for all agents (blind) — both docs limited to configured agents; others at first use
  - `[medium]` `patch` kill(pid,0) in the listing test sees zombies (blind, gap other, edge) — uses inspectProcess kind gone
  - `[low]` `reject` shared-worker test only shows an unrelated session survives (blind) — the sharing itself was probed live in planning (second process kept working); the test name states what it pins
  - `[low]` `patch` live tests create projects/<slug> by hand (blind) — docs say when a worker-server exists in a real install
  - `[low]` `patch` aborted listing leaves its acp-sessions dir and rethrows a non-CliError (blind) — directory case added to the remainder list; the catalog catches any error
  - `[low]` `reject` reused leader pid wastes 2 s and logs a false warning in the reaper (blind) — reapGroup is entered only with the leader alive, start time equal and pgid == pid; reuse mid-wait is not realistic
  - `[medium]` `patch` no test for a crash with a SIGTERM-ignoring worker (blind) — test added
  - `[low]` `patch` agentDir checked trimmed, used untrimmed (blind, edge) — trimmed value used
  - `[low]` `reject` zombie group members delay each close up to the grace (edge, gap other) — bounded by the 2 s grace, then SIGKILL; documented as a remainder
  - `[low]` `reject` SIGKILL timer could hit a reused pid group (edge) — same race as row 1; the timer is cleared as soon as the group is empty
  - `[low]` `patch` leader that left its group: no signal, no SIGKILL, close waits (edge) — SIGTERM and armed SIGKILL fall back to the leader alone
  - `[low]` `patch` groupHasMembers false on EPERM, pid-locks true (edge) — aligned to true
  - `[low]` `patch` onProcessStart warning outside try/finally (edge) — moved inside the try
  - `[low]` `reject` onProcessStart called more than once overwrites the lock (edge) — one listing spawns one process; no second spawn exists
  - `[low]` `patch` host terminating a listing worker thread leaves process and lock (edge) — documented; the next start reaps it
  - `[low]` `patch` claim comment on signalGroup (edge) — same as row 1
  - `[low]` `patch` side-question dir stays after Gateway kill/crash/discard failure/3 s wait (intent-alignment) — added to the remainder list
  - `[low]` `reject` composite scenario (side question, listing, Gateway stop) never run as one (intent-alignment) — reading A2 (separate checks) is defensible; each clause has an offline and a live check
  - `[low]` `patch` lock released at SIGKILL sent, not at exit (intent-alignment) — added to the remainder list
  - `[low]` `reject` Ctrl-C no longer reaches cursor-agent; shared worker may die (intent-alignment) — already documented (remainder 3, process-group paragraph); chosen approach per plan

## Design Notes

**Probe evidence** (cursor-agent 2026.10.19-6bbf2c4, this host, 2026-10-20; scripts kept in the planning scratchpad, not committed).
- `cursor-agent acp` spawns `<node> index.js worker-server` with `detached: false` at `session/new` (bundle `src/worker-manager.ts`). The worker serves a Unix socket `<CURSOR_DATA_DIR>/projects/<slug>/worker.sock`; if that path is over 91 chars the dir is cut to 83 chars plus a 7-hex hash, and if `projects` is over 83 chars it falls back to the data dir, then to `/tmp/.cursor/<slug>` (the live suite here lands in `/tmp/.cursor`). Slug: workspace path, non-alphanumerics to `-`, runs collapsed, ends trimmed.
- The worker writes its log to `<CURSOR_DATA_DIR>/projects/<slug>/worker.log` (uncut). When that dir does not exist it exits at once with ENOENT (traced). Cursor creates it later (`agent-tools`, `repo.json`), so a worker lives in most real installs after the first turns.
- At start the worker spawns `npm exec typescript-language-server --stdio` (`detached: false`), which starts two `tsserver.js` and a `typingsInstaller.js`; all share the group of the `cursor-agent` that spawned the worker. Cursor's own shell runs `detached: true` (own groups), but the static home denies it.
- Attached spawn, SIGTERM to `cursor-agent` only (today): worker plus the 6-process language-server chain lived on, all exited by themselves 296-311 s later (worker `INACTIVITY_TIMEOUT` 300 s; it also has `POST /kill`).
- Detached spawn, SIGTERM to `-pgid` after a real turn: all 7 gone within 1.2 s.
- Two processes, one home and workspace: the second connected to the first one's worker (no spawn of its own). Stopping the first group killed the worker; the second's next turn (read plus lints) ended `end_turn`. A worker is a cache (LSP, indexing); the client respawns it on a failed request.
- Linux keeps a pgid number allocated while any group member lives, so `kill(-pgid)` right after the leader's exit, or while `kill(-pgid, 0)` finds members, reaches only that group. Reuse needs the group empty and a pid wrap.
- OpenClaw 2026.10.3 logs `stop (SIGINT)` as a clean stop like SIGTERM (`gateway-boot-lifecycle-*.mjs:128`); the live SIGINT row confirms `stop` runs. With setsid, Ctrl-C no longer reaches `cursor-agent` directly.

**Remainder to document** (Known limits, setup "check for leftovers"): (1) a Gateway killed with SIGKILL leaves the groups until the next Gateway start reaps them (within 30 s); (2) a group whose leader died while no Gateway ran is not reaped (no proof it is ours); its worker exits within about 5 minutes of its last request; (3) a worker shared by two plugin processes (same agent and workspace, or the `/tmp/.cursor` fallback for long paths, possibly also the user's own `cursor-agent` there) dies with the process that started it and is respawned on next use; (4) Cursor children in their own group (its native shell, denied) are not covered; (5) Windows: no group handling; (6) a new chat refused after `session/new` (unknown model, missing mode) keeps its directory, since the core never learns its id; (7) a listing without `agentDir` from OpenClaw is not locked (warned).

**Why groups over the alternatives:** the worker's socket path and `POST /kill` are Cursor internals that change with path lengths and would need a CLI-specific client; `ps` scans by ppid lose the worker once it is reparented to init; a pgid is set at spawn, inherited by the language servers, and kernel-scoped.

**Review:** thorough recommended (risk high: process killing on every close path).

## Verification

**Commands:**
- `PATH=$PWD/.spike/node/bin:$PATH npm run typecheck` -- expected: clean
- `npm test` -- expected: all pass; new tests counted
- `npm run build && npm run dev:install && npx vitest run test/isolated-openclaw.test.ts` -- expected: pass
- `NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/operations.live.test.ts test/live/session-resume.live.test.ts` -- expected: pass (needs `CURSOR_API_KEY`, no sandbox)
- `npm run test:live` once at the end -- expected: all files pass under the known-flake re-run rule of plan 1.16

**Manual checks:**
- After the live run: `ps -eo pid,pgid,args | grep -E '[w]orker-server|[t]sserver|[t]ypescript-language'` lists nothing started by this run (check pgid against the run's lock pids; never kill by name).

## Auto Run Result

Planning result: ready-for-dev (halted after planning, as invoked). Route full (auto), risk high (from the ticket), review thorough recommended. No product code written. Probes ran real `cursor-agent` 2026.10.19 outside the sandbox with `CURSOR_API_KEY` (see Design Notes); their temporary homes under `.spike/` were removed and no probe process was left.

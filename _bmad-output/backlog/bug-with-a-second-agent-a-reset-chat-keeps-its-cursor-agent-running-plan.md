---
title: 'With a second agent configured, a reset chat keeps its cursor-agent running'
type: 'bugfix'
ticket: '31'
created: '2026-11-28'
status: 'done'
baseline_revision: 'd467522'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: [self-review, quick]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** On OpenClaw 2026.10.3, once the config names a second agent, `sessions.reset` (any `session_end` that releases) no longer ends the chat's `cursor-agent`: the host runs the turn in one loaded copy of the plugin and `session_end` in another, and the #74 release only looks at the pools of the copy the hook runs in (issue #105).

**Approach:** Every loaded copy shares its pools in one thread-wide registry (`globalThis` under a `Symbol.for` key, held weakly); the `session_end` hook releases the conversation in every shared pool. Each copy keeps its own pools, caps, and unload.

## Boundaries & Constraints

**Always:** Release only idle members of the ended conversation (AD-14 unchanged). A copy's unload takes its pools out of the registry and closes only them. One `globalThis` write site in the plugin (OpenClaw lists it as `host-patch`, which does not block install; `listings.ts` already had one), under the plugin's own symbol. The registry entry's shape stays minimal (`releaseConversation`), since copies of other versions may share it. The new Gateway scenario runs on a state of its own.

**Never:** One pool shared by all copies (one copy's unload would close every copy's processes and leave the pool closed). Change the reuse key, the idle close, the caps, the releasing reasons, or the unload path. Add an agent to the tier's shared config. Touch protected files (`scripts/`, `.github/`, ...).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Other copy holds it | turn ran in copy B, `session_end` runs in copy A | B's idle member of the key closes | none |
| Other chats | B holds chats a and b, end of a | only a's process closes | none |
| Unloaded copy | copy unloaded (closeAll) | its pools are out of the registry | none |
| Broken pool | one shared pool throws | the others still release | error dropped |
| Dropped copy | host drops a copy without unload | weak entry is pruned at the next release | none |
| Single copy | only `main`, or 2026.11.x | same as #74 | none |

</intent-contract>

## Code Map

- `.regression/openclaw-2026.10.3/openclaw/node_modules/openclaw/dist/control-plane-workspace-BSuk9I48.mjs` -- `resolvePluginControlPlaneWorkspace`: no workspace for the Gateway's registry when several explicit agents exist and no `agents.defaults.systemAgent.agentId`.
- `.../dist/prepared-model-runtime.facts-CcfIVV9n.mjs` -- `resolveLendingGatewayRegistry`: a turn borrows the Gateway's registry only when its load context's `workspaceDir` equals the turn's; else `loadAgentRuntimePluginRegistryHandle` loads a separate registry (a new plugin instance, captured build of its own).
- `.../dist/runtime-plugins-DhLN9OKn.mjs` -- `adoptAgentRuntimeRegistrations`: adopts tools, channels, decision providers, memory, widget presenters from the Gateway's registry, never CLI backends.
- `.../dist/hook-runner-global-CAwEvnZt.mjs`, `session-reset-service-CVdl8yPl.mjs` -- `session_end` runs through the global hook runner over the active (Gateway) registry.
- `src/core/register.ts` -- `registerAdapters`: per-copy `pools`, the `session_end` hook, `closeAll`.
- `src/core/conversation.ts` -- add the shared pool registry (`shareConversationPool`, `releaseConversationEverywhere`).
- `src/core/process-global.ts` (new) -- the one `globalThis` write; `src/core/listings.ts` uses it too.
- `src/core/pool.ts` -- `ProcessPool.releaseConversation` (unchanged).
- `test/regression/harness.ts` -- `isolatedState`, `gatewayAgentTurn(..., agent)`.
- `test/regression/gateway/multi-agent.regression.test.ts` (new) -- the reproduction.
- `test/session-end-release.test.ts`, `src/core/conversation.test.ts` -- unit tests.
- `test/regression/ledger.toml`, `CHANGELOG.md`, `docs/providers/cursor.md`, AD-14, `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [x] `test/regression/gateway/multi-agent.regression.test.ts`, `test/regression/harness.ts` -- Gateway scenario with two agents on its own state; red on the unfixed build
- [x] `test/session-end-release.test.ts` -- two module copies: an end in one copy releases the other copy's process; red before the fix
- [x] `src/core/process-global.ts`, `src/core/conversation.ts`, `src/core/register.ts`, `src/core/listings.ts` -- the fix
- [x] `src/core/conversation.test.ts` -- registry edge cases
- [x] ledger entry, CHANGELOG, docs, AD-14, MEMORY

**Acceptance Criteria:**
- Given 2026.10.3 with a second agent, when a `main` chat is reset, then its process exits within 20 s and another chat's stays.
- Given the same, when a chat of the second agent is reset, then its process exits within 20 s.
- Given the whole Gateway tier on 2026.10.3 and on latest, when it runs, then it is green except the known #39 case on 2026.10.3 (#106).

## Implementation Notes

- Root cause, read in the 2026.10.3 sources and probed with a temporary log line in the isolated host's `loadPreparedInboundPluginRegistry` (restored, file byte-identical after): with `main` only, the turn's prepared registry is lent and reused (`ownerWorkspace` = `turnWorkspace` = `<state>/workspace`, `lending: true, reusable: true`); with `agents.entries.second = {}`, the Gateway's registry has no `workspaceDir` (`resolvePluginControlPlaneWorkspace`: "workspace-scope-omitted", several explicit agents, no `agents.defaults.systemAgent.agentId`), `lending: false`, and the turns of `main` and of `second` each load a separate registry (registration mode `discovery`, its own captured build, its own pools). `adoptAgentRuntimeRegistrations` adopts no CLI backend, and `session_end` runs through the global hook runner over the Gateway's registry, whose pool is empty. Setting `agents.defaults.systemAgent.agentId: main` did not turn the main case green (not followed up; no workaround is claimed).
- Decision: share the release across copies, not one pool (Design Notes). Pools are shared in every registration mode, since the copy that serves turns is a `discovery` load.
- Decision: the one `globalThis` write moves to `src/core/process-global.ts`; `listings.ts` uses it with its old key, so a copy of an older version still shares the listings holder. On 2026.11.11 install the plugin's `globalThis.*` finding count stays one (`process-global.js:12`, was `listings.js`); the existing `managed-install.js` `host-patch` findings show the repo already ships such warnings (they never block install).
- Decision: the scenario isolates the state (`isolatedState` in the harness: own `SPIKE_DIR` beside the shared one under `.regression/`, Node and OpenClaw symlinked, the installed plugin re-packed with `npm pack --ignore-scripts` and installed, about 15 s) instead of restoring the config in `afterAll`, so a crash mid-file cannot leave a second agent in the shared config and no state the agent created reaches later files. `scripts/regression.sh` (protected) is unchanged. Checked after each run: the shared `openclaw.json` names no `second`, and the scenario dir is gone.
- Unit reproduction: two module copies (`vi.resetModules()` + dynamic import of `register.ts` and `registry.ts`). The first version without `FAKE_CURSOR_STORE` passed before the fix for the wrong reason (both fake processes name their chat `fake-session-1`, and the second takes over the first's chat and closes it); with a store it is red before the fix and green after.
- Files: `src/core/process-global.ts` (new), `src/core/conversation.ts`, `src/core/register.ts`, `src/core/listings.ts`, `src/core/conversation.test.ts`, `test/session-end-release.test.ts`, `test/regression/harness.ts` (`isolatedState`, `gatewayAgentTurn(..., agent)`), `test/regression/gateway/multi-agent.regression.test.ts` (new), `test/regression/ledger.toml`, `CHANGELOG.md`, `docs/providers/cursor.md`, AD-14, `MEMORY.md`.
- Not changed (follow-ups for the owner): the caps (`maxProcesses`, `maxConcurrentTurns`) and the remove method's `livePools` stay per copy, so on 2026.10.3 with several agents the caps hold per loaded copy, and Remove key does not see the turn copies' processes. A live Cursor check was not run (no `CURSOR_API_KEY` used in this session).

## Plan Change Log

## Review Triage Log

### 2026-11-28 — Review pass (self-review in the build's own session, no reviewer subagents)
- verdicts: 5 findings — high 0, medium 1, low 2, false 2, maybe-false 0
- findings:
  - `[medium]` `[patch]` unit reproduction passed before the fix (chat-ID takeover without a store) — store added, red before, green after.
  - `[low]` `[defer]` caps and `livePools` per copy — out of the approved scope; recorded in Implementation Notes and MEMORY.
  - `[low]` `[reject]` a copy dropped without unload keeps its pool in the registry — held by `WeakRef`, pruned at the next release (and, since review pass 1, at the next share).
  - `[false]` double release when both copies' hooks run — `releaseConversation` of an already-released key finds nothing.
  - `[false]` turns in a worker thread would not see `globalThis` — the Gateway scenario is green on 2026.10.3, so the turn copy shares the main thread's `globalThis`.

### 2026-11-28 — Review pass 1 (quick lens, triaged by the coordinator)
- verdicts: 6 findings — high 0, medium 2, low 4, false 0, maybe-false 0; all routed `patch`, applied in one commit on top of 756860a
- findings:

| # | Severity | Verdict | Route | Finding | What changed |
|---|----------|---------|-------|---------|--------------|
| 1 | medium | valid | patch | A red multi-agent run on 2026.11+ uploads no host logs: the scenario's `<state>/logs` and the Gateway console log were deleted in `afterAll`. | `test/regression/harness.ts`: `restore(extraLogs)` first copies `<dir>/state/logs` (as `state-logs/`) and each existing extra file into the shared state's `state/logs/<scenario dir name>/`, which the CI "Collect the failure logs" step already copies; a copy failure only warns. `multi-agent.regression.test.ts`: `afterAll` stops the Gateway without removing its temp dir, restores with `gateway.log`, then removes the temp dir. Workflow unchanged. Checked on 2026.10.3: `state/logs/scenario-two-agents-*/gateway.log` kept (10.3 writes no `state/logs`). |
| 2 | low | valid | patch | `expect(gatewayCopy.backend).not.toBe(turnCopy.backend)` proves nothing (a new backend per call). | `test/session-end-release.test.ts`: asserts the two dynamically imported copies and the static import have three distinct `registerAdapters` functions and three distinct `ADAPTERS` arrays. |
| 3 | low | valid | patch | No test that a copy's unload takes its pools out of the shared registry. | New test "takes a copy's pools out of the shared registry when the copy unloads": one pool per adapter appears in the registry at registration and none is left after `stop`. Red with the `unshare` loop in `closeAll` removed (checked, then restored). |
| 4 | low | valid | patch | Dead `WeakRef`s were pruned only on a release, so a Gateway that reloads often but rarely ends a conversation grows the set. | `src/core/conversation.ts`: `shareConversationPool` drops dead entries before adding; test "drops the entries of collected pools when a pool is shared" puts a dead-ref stand-in into the registry. |
| 5 | medium | valid | patch | User docs did not say the caps and Remove key are per loaded copy on 2026.10.3 with several agents. | `docs/providers/cursor.md` "Caps": each loaded copy has its own caps, so the Gateway can run more turns and processes than the numbers say, and Remove key neither closes the idle processes of the turn copies nor refuses while one of their turns runs. |
| 6 | low | valid | patch | `MEMORY.md` fact (3) put "fixed in backlog bug 31" on the 2026.11.10 clause. | Moved to the "NEW BUG, not fixed in ticket 3" clause; the `isolatedState` entry names the kept logs. |

## Design Notes

Decision: share the pools, not one pool. One `ProcessPool` per backend for the whole Gateway would also make the caps Gateway-wide, but a copy's unload (`closeAll`, which marks the pool closed) would then end every copy's processes and refuse later turns; avoiding that needs reference counting across copies and versions. Sharing the release only keeps each copy's lifecycle as it is.

```ts
// register.ts
const unshare = pools.map((pool) => shareConversationPool(pool));
api.on?.("session_end", (event, ctx) => { ...; releaseConversationEverywhere(key); });
```

## Verification

**Commands:**
- `npm test`, `npm run typecheck` -- green
- `scripts/regression.sh gateway` (2026.10.3) -- green except `#39` (#106)
- `scripts/regression.sh gateway --openclaw latest` -- green

**Results (2026-11-28):**
- `npm run typecheck`: green. `npm test`: 72 files passed, 30 skipped; 2118 tests passed, 101 skipped (2 min 53 s).
- Unit reproduction (`test/session-end-release.test.ts`, issue #105): red before the fix (`expected false to be true` at `gone(a)`), green after.
- Baseline tier on d467522 code, OpenClaw 2026.10.3: 18 passed, 1 skipped, 1 failed (#39, #106), 9 min 55 s.
- New scenario alone on the unfixed build, 2026.10.3: both tests red, "ended chat pids 4130 alive=true; kept chat pids 4871 alive=true (20 s after sessions.reset)" and "second chat pids 7740 alive=true" (1 min 48 s).
- Fixed tier, 2026.10.3: 20 passed, 1 skipped, 1 failed (#39 only); #105 main 11.0 s, #105 second 6.0 s, #74 9.1 s (10 min 38 s).
- Fixed tier, `--openclaw latest` (resolved 2026.11.11): 18 passed, 4 skipped (version-dependent), 0 failed; #105 23.2 s and 17.7 s (18 min 14 s). On 2026.11.x the scenario is green before and after (not a reproduction there).
- Live Cursor check: not run.

**Results after review pass 1 (2026-11-28):**
- `npm run typecheck`: green. `npm test`: 72 files passed, 30 skipped; 2120 tests passed, 101 skipped.
- Multi-agent scenario alone on OpenClaw 2026.10.3, with the patched build packed and installed into the tier's shared state as `scripts/regression.sh` does: 2 passed (1 min 55 s); the shared `openclaw.json` names no `second` afterwards, and `state/logs/scenario-two-agents-*/gateway.log` was kept. The whole tier was not re-run for this pass.

## Auto Run Result

Status: done
Blocking condition: none
Review: self-review in the build's session, then review pass 1 (quick lens, triaged by the coordinator); its 6 findings are patched. The owner's review of the batch is next.

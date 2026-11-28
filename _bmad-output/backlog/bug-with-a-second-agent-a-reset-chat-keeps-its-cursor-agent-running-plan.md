---
title: 'With a second agent configured, a reset chat keeps its cursor-agent running'
type: 'bugfix'
ticket: 'bug-with-a-second-agent-a-reset-chat-keeps-its-cursor-agent-running'
created: '2026-11-28'
status: 'in-progress'
baseline_revision: 'd467522'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
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

## Plan Change Log

## Review Triage Log

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

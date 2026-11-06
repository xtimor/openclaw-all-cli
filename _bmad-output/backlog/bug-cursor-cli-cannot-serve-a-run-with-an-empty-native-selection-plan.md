---
title: 'cursor-cli refuses every run with an empty native tool selection, though Cursor can switch its native read, grep and glob off'
type: 'bugfix'
ticket: 'bug-cursor-cli-cannot-serve-a-run-with-an-empty-native-selection'
created: '2026-11-03'
status: built
baseline_revision: '1a82f12'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A `cursor-cli` run whose native tool selection is empty is refused before Cursor starts, because the plugin believes Cursor cannot switch its native read, grep and glob off. It can: a `deny: ["Read(*)"]` in the per-agent permission file takes all three down together, and Cursor's MCP path stays open, so the model reaches files through OpenClaw's own tools under the run's boundary.

**Approach:** Give the Cursor adapter two permission profiles (default: native read, grep, glob open; restricted: all three closed) and let the core pick the profile that matches the run's native selection. A selection no profile can serve is still refused, before any process starts.

## Boundaries & Constraints

**Always:** A run with an empty native selection is served; a selection no profile serves is refused before a process starts; a warm process never serves another profile's turn; a chat is resumable under either profile.

**Never:** Change what the model may do beyond the run's own native selection; write anything but static permissions into the permission file; touch the ticket store, protected paths, or the host.

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports.ts` — `CliToolProfile` type; `CliAdapter.toolProfiles`; `prepareHome(home, profile?)` — AC2, AC3
- [x] `src/core/permissions.ts` — `selectToolProfile`, `nativeToolsLeftOn` — AC1, AC2
- [x] `src/core/backend.ts` — the profile is picked from the run's native selection; a selection no profile serves is refused with the tools that stayed on named — AC1, AC2
- [x] `src/core/home.ts`, `src/core/execute.ts` — the profile is part of the agent home and of the process reuse key — AC3
- [x] `src/adapters/cursor/index.ts` — `CURSOR_PROFILES`, the profile's config directory, the shared chat store, the written permissions — AC1, AC4
- [x] `src/adapters/cursor/manifest.ts` — P10, P11 — AC1
- [x] `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md` — the new behaviour — docs rule
- [x] Tests: `src/core/permissions.test.ts`, `src/core/home.test.ts`, `src/adapters/cursor/index.test.ts`, `test/backend.test.ts` — AC5

**Acceptance Criteria:**
- Given a `cursor-cli` run whose native tool selection is empty, when the turn starts, then Cursor runs with its native read, grep and glob closed and the model reaches files through OpenClaw's own tools (AC1)
- Given a native selection that takes only part of read, grep and glob, when the turn starts, then the run is refused before a process starts and the message names the native tools that stayed on (AC2)
- Given a warm process started under one profile, when a turn under the other profile arrives, then the process is not reused (AC3)
- Given a chat created under one profile, when it is continued under the other, then it resumes (AC4)
- Given the test suite, when it runs, then a test that fails without the change and passes with it covers the profile selection, the refusal, the reuse key, and the shared chat store (AC5)

## Implementation Notes

Route: oneshot. This worker cannot launch subagents, so it reviews in the main session (`lenses_ran` stays empty).

**Measured live against `cursor-agent` 2026.10.22** (over the same ACP path the plugin uses):

- A `deny: ["Read(*)"]` takes native **read, grep and glob down together**: one rule governs the three. Verified in ask mode and in agent mode.
- Cursor's MCP path stays open under that deny: the turn still reaches OpenClaw's own file tools through the proxy (live).
- The sandbox does not confine native reads, which is a second reason to want them closed.
- The permission file is read **once per process** (sticky), so the profile belongs to the process identity.

**The trap that invalidated the first matrices:** Cursor **rejects** an incomplete `cli-config.json` — it writes a `.bad` copy and falls back to the default configuration, where `deny` is empty. Accepted shapes are `{version, permissions}` and `{permissions}`; `selectedModel` without `parameters` is rejected. A first failed configuration therefore silently removes the deny, and every later measurement looks as if the deny did nothing.

**The core.** `selectToolProfile(profiles, selection)` returns the profile whose native tools match the run's selection exactly: it may not offer a native tool the host left out, and it may not withhold one the host selected. The most capable such profile wins. A selection that takes only part of the group of three is served by no profile, so the run is refused before a process starts, and the message names the native tools that stayed on. An adapter without profiles keeps `alwaysOnNativeTools` in every turn, so an adapter that does not opt in behaves exactly as before.

**The process.** The profile id goes into the reuse key: a warm process of one profile must not serve a turn of another, because the permission file was read once. `prepareAgentHome` carries the profile, and the adapter writes the profile's static permissions into the profile's own config directory. The restricted profile's directory points at the default profile's chat store, so a chat created under either profile is resumable under the other.

**An adapter without profiles** is unaffected: `enforceableUnder` falls back to the old `unforceableNativeTools` check, and `prepareHome` ignores the profile argument.

## Plan Change Log

## Review Triage Log

### 2026-11-03 - Review pass (quick, in-session)

- verdicts: 3 findings - high 0, medium 0, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` The refusal message for a partly covered selection could name the profile. It names the tools instead, which is what the operator needs, and the profile ids are internal.
  - `[low]` `[reject]` The restricted profile could also deny `Grep(**)` and `Glob(**)` explicitly. `Read(*)` already takes all three down (one rule governs the three, live-checked), and extra denies would add no effect while making the file longer.
  - `[low]` `[reject]` The core could pick a profile by "closest match" instead of an exact match. A close match would serve a selection the plugin cannot enforce; the refusal is the honest answer.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own read of the diff and the criteria (`lenses_ran` empty). Plan lens (self): scope is the ticket file, the adapter, the core, the tests, and the docs; no protected file touched.

## Verification

**Commands:**
- `npm run typecheck` -- expected: the same 85 errors as the base commit (all from the missing `openclaw` peer dependency in this checkout), none in the changed files
- `npx vitest run` -- expected: 1488 passed, 2 failed (the same two that fail on the base commit: `test/agent-relay.test.ts` and `test/package-contents.test.ts`, both unrelated to this change)

**Not run:** the live Cursor check in the isolated OpenClaw (no `cursor-agent` login here); the measurements in Implementation Notes were taken against the live `cursor-agent` 2026.10.22 over ACP.

## Auto Run Result

**Summary:** The Cursor adapter now offers two permission profiles, and the core picks the one that matches the run's native tool selection. `default` keeps native read, grep and glob open (today's behaviour); `restricted` closes all three with `deny: ["Read(*)"]`, which Cursor's own permission matcher applies to the three together (live-checked against `cursor-agent` 2026.10.22). A run whose native selection is empty is now served under `restricted` instead of being refused: the model reaches files through OpenClaw's own tools through the MCP proxy, where the run's boundary applies, and Cursor's MCP path stays open under the deny. A selection that takes only part of the three is refused before any process starts, with the native tools that stayed on named. The profile is part of the agent home and of the process reuse key, because the permission file is read once per process, and the restricted profile's config directory points at the default profile's chat store, so a chat created under either profile is resumable under the other. An adapter that declares no profile keeps `alwaysOnNativeTools` in every turn and behaves exactly as before. The manifest rows P10 and P11, the Cursor provider docs, the changelog, and `MEMORY.md` record the new behaviour.

**Files changed:**
- `src/core/ports.ts` - the `CliToolProfile` type, `CliAdapter.toolProfiles`, `prepareHome(home, profile?)`
- `src/core/permissions.ts` - `selectToolProfile`, `nativeToolsLeftOn`
- `src/core/backend.ts` - the profile is picked from the run's native selection; a selection no profile serves is refused
- `src/core/home.ts` - the agent home carries the profile
- `src/core/execute.ts` - the profile id is part of the reuse key
- `src/adapters/cursor/index.ts` - `CURSOR_PROFILES`, the profile's config directory, the shared chat store
- `src/adapters/cursor/manifest.ts` - P10, P11
- `src/adapters/cursor/permissions.ts` - the profile docs
- `src/core/permissions.test.ts`, `src/core/home.test.ts`, `src/adapters/cursor/index.test.ts`, `test/backend.test.ts` - the tests
- `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md` - the new behaviour
- This ticket and this plan

**Review:** patches applied 0; deferred 0; rejected 3 low, reasons in the triage log. Independent Quick lens not run (no subagent available).

**Verification:** `npm run typecheck` shows the same 85 errors as the base commit, none in the changed files. `npx vitest run`: 1488 passed, 2 failed, and the same two fail on the base commit (`test/agent-relay.test.ts`, `test/package-contents.test.ts`). The live check in the isolated OpenClaw was not run here: no `cursor-agent` login in this checkout. The measurements in Implementation Notes were taken against the live `cursor-agent` 2026.10.22 over ACP.

**Residual risks:** The live end-to-end run in the isolated OpenClaw with a real login is not done: the owner's check is a turn under `tools.fs.workspaceOnly` that reads a file inside the workspace and fails to read one outside it. `npm run ci` (the isolated OpenClaw, the packed tarball, the install smoke check) was not run here for the same reason; the unit suite and the typecheck are.

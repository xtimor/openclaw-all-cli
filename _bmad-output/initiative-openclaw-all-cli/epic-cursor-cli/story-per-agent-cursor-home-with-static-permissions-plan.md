---
title: 'Per-agent Cursor home with static permissions'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: 'ready-for-dev'
baseline_revision: 'a5ecca3cf18b141ebf189d0576e2849f29c0cede'
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
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every agent shares one Cursor config and chat store, and nothing denies native shell, write, edit, or web fetch once the session leaves `ask` mode.

**Approach:** The core derives a per-agent home from `prepareExecution` `agentDir` (AD-6) and hands it to the adapter; the Cursor adapter points `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` at it and writes the AD-9 static permissions once by atomic rename. Every ACP permission request stays rejected until entry 4.

## Boundaries & Constraints

**Always:** Home = `<agentDir>/openclaw-all-cli/<backendId>/`. Permissions are static and identical for every agent: deny `Shell(*)`, `Write(**)`, `WebFetch(*)`; allow `Read(**)` and `Mcp(openclaw:*)`. Write with a unique temp file and `rename`; skip the write when the file already holds them; keep other keys Cursor wrote. Core stays CLI-agnostic and adapters import only ports and transports (AD-2). No file is created in the agent's working directory (AD-7). A missing `agentDir` fails the turn with a `CliError`; never fall back to a shared home.

**Never:** Per-turn policy in a file; routing permission requests to OpenClaw (entry 4); MCP wiring (entry 3); touching the CLI login.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two agents | agentDirs A and B | Separate homes, each with the AD-9 file | No error expected |
| Rerun | Home already holds the file | File not rewritten | No error expected |
| Foreign keys | cli-config.json has Cursor-written keys | Keys kept, only `permissions` set | No error expected |
| Parallel start | Two turns prepare one home at once | One valid file, never a partial one | No error expected |
| No agentDir | `agentDir` undefined | Turn fails | `CliError` says OpenClaw gave no agent directory |
| Write denied | Session in agent mode, prompt asks to create a file | File not created, no permission request | Read and grep still answer |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `CliAdapter`: add `prepareHome(home)` returning the env additions; export helper types
- `src/core/backend.ts` -- `prepareExecution` receives `ctx.agentDir`; derive home, call the adapter, pass env to `createExecute`
- `src/core/execute.ts` -- merge the home env into `openEntry`'s env; add the home to `reuseKey`
- `src/adapters/cursor/index.ts` -- implement `prepareHome`; `manifest.ts` P8 note
- `src/transports/files.ts` (new) -- atomic JSON write helper (`transports/process.ts` is the sibling)
- `test/fixtures/fake-cursor-agent.mjs` -- logs its `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR`
- `test/import-boundary.test.ts`, `docs/providers/cursor.md`, `docs/setup.md`, parity matrix P8 row
- Live finding (2026-10-17): with that `cli-config.json`, real `cursor-agent acp` in agent mode creates no file and asks nothing; `grep` still works; without it the file is created.

## Tasks & Acceptance

**Execution:**
- [ ] `src/transports/files.ts` -- atomic JSON write with a unique temp name -- parallel starts never see a partial file
- [ ] `src/core/ports.ts`, `src/core/backend.ts`, `src/core/execute.ts` -- home derivation, adapter hook, env merge, reuse key -- AD-6
- [ ] `src/adapters/cursor/index.ts` -- env vars plus static permissions merged into any existing file -- AD-9
- [ ] tests -- unit tests for every matrix row, import-boundary still green
- [ ] `test/live/` -- gated test: a session in agent mode using the prepared home creates no file for a write request while `grep` still answers
- [ ] docs and parity P8 -- row and setup text match behavior

**Acceptance Criteria:**
- Given two agents with different `agentDir`, when each runs a turn, then each has its own home with the same AD-9 permissions and the user's workspace gains no file.
- Given the prepared home, when a turn asks to write, edit, or delete a file, then it is denied, and read and grep still work.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

`prepareHome(home)` returns `{ CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: <home>/data }`. The core owns the path rule (AD-6); the adapter owns the CLI's variable names and file format. `ctx.agentDir` is optional in the SDK type, hence the explicit error.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with a real `cursor-agent` and `CURSOR_API_KEY`

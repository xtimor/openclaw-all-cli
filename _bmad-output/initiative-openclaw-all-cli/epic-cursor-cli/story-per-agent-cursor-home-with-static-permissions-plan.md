---
title: 'Per-agent Cursor home with static permissions'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: done
baseline_revision: 'a5ecca3cf18b141ebf189d0576e2849f29c0cede'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
warnings: []
deferred:
  - summary: >-
      Read-modify-rename of cli-config.json can lose an update if a running cursor-agent writes it in between.
    evidence: |-
      Settled by checking whether Cursor rewrites cli-config.json while running.
    location: >-
      src/adapters/cursor/index.ts
    severity: medium (unverified)
  - summary: >-
      probeAuth checks the shared default home while turns use the per-agent home; on Linux hosts whose login lives in the config dir the probe says available and turns start logged out.
    evidence: |-
      Needs a logged-in Linux host. CURSOR_API_KEY is the recorded workaround.
    location: >-
      src/adapters/cursor/index.ts
    severity: medium (unverified)
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
- [x] `src/transports/files.ts` -- atomic JSON write with a unique temp name -- parallel starts never see a partial file
- [x] `src/core/ports.ts`, `src/core/backend.ts`, `src/core/execute.ts` -- home derivation, adapter hook, env merge, reuse key -- AD-6
- [x] `src/adapters/cursor/index.ts` -- env vars plus static permissions merged into any existing file -- AD-9
- [x] tests -- unit tests for every matrix row, import-boundary still green
- [x] `test/live/` -- gated test: a session in agent mode using the prepared home creates no file for a write request while `grep` still answers
- [x] docs and parity P8 -- row and setup text match behavior

**Acceptance Criteria:**
- Given two agents with different `agentDir`, when each runs a turn, then each has its own home with the same AD-9 permissions and the user's workspace gains no file.
- Given the prepared home, when a turn asks to write, edit, or delete a file, then it is denied, and read and grep still work.

## Implementation Notes

Implemented by a sonnet subagent from this plan; see the Auto Run Result.

## Plan Change Log

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 7 findings — high 0, medium 3, low 2, false 0, maybe-false 2
- findings:
  - `medium` `patch` P10 reads differently in manifest, matrix and docs (AD-9: adapters never translate tools.allow/deny), and the new live test tags itself P10 — verified in the three files; patch: one wording everywhere, live test tags P8 only
  - `medium` `patch` AC 2 asks for write, edit and delete denial but the live test only creates a file — patch: also ask to edit and to delete the seed file; assert content unchanged and file present
  - `medium` `patch` `readJsonObject` turns EACCES/EISDIR/EIO into "start fresh", so unreadable config loses Cursor's keys — patch: only a missing file or invalid JSON starts fresh; other read errors fail the turn with a CliError
  - `maybe-false` `defer` Read-modify-rename can lose an update if a running cursor-agent writes cli-config.json between read and rename — maybe-false (medium if true): settle by checking whether Cursor rewrites cli-config.json while running
  - `low` `patch` Rewritten config and the home directory use default modes — patch: temp file 0600, home 0700 (architecture Secrets convention: per-agent home files 0600)
  - `maybe-false` `defer` `probeAuth` runs `cursor-agent status` against the shared default home while turns use the per-agent CURSOR_CONFIG_DIR; on a Linux host whose login lives in the config dir the probe says available and turns start logged out — maybe-false (medium if true): this host is not logged in, so settle on a logged-in Linux host; API key is the workaround recorded in docs and MEMORY
  - `low` `reject` Plan task checkboxes are stale — the fix is to edit this build's plan; the orchestrator ticks them when it closes the step

## Design Notes

`prepareHome(home)` returns `{ CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: <home>/data }`. The core owns the path rule (AD-6); the adapter owns the CLI's variable names and file format. `ctx.agentDir` is optional in the SDK type, hence the explicit error.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with a real `cursor-agent` and `CURSOR_API_KEY`

## Auto Run Result

- Summary: each agent gets its own Cursor home at `<agentDir>/openclaw-all-cli/cursor-cli/` (core, AD-6). The Cursor adapter points `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` at it and writes the AD-9 static permissions by atomic rename, keeping Cursor's other keys. A missing `agentDir` fails the turn.
- Files: `src/transports/files.ts` (atomic write, modes 0600/0700), `src/core/home.ts`, `src/core/{ports,backend,execute}.ts`, `src/adapters/cursor/{index,manifest}.ts`, tests, `test/live/per-agent-home.live.test.ts`, docs and parity P8/P10 rows.
- Review (quick, one lens): 6 findings — patched 4 (P10 wording, live edit/delete denial, unreadable-config handling, file modes), deferred 2 (lost update vs a running cursor-agent; auth probe vs per-agent home on Linux), rejected 1 (stale checkboxes, plan edit).
- Follow-up review recommended: false. No high was patched.
- Verification (isolated Node 24, real cursor-agent 2026.10.16): `npm run typecheck`, `npm run build` clean; `npx vitest run` 122 passed, 2 skipped (live); live tests pass: in agent mode with the prepared home, create, edit and delete requests leave the workspace unchanged with no permission request and `grep` still answers (negative control without the file creates it); `openclaw agent --local --model cursor-cli/auto` still prints Cursor's reply and creates the home with the permissions.
- Residual risks: login location on Linux hosts without `CURSOR_API_KEY` (unverified); homes created before the mode fix keep their old modes.

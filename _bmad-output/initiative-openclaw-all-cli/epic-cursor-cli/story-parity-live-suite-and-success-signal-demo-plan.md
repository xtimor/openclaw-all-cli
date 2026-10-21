---
title: 'Parity live suite and success-signal demo'
type: 'feature'
ticket: 17
created: '2026-10-21'
status: 'in-review'
baseline_revision: '26d8970cc727d3f18858ef2f664d97764da81544'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized', 'multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The epic's done-when needs the spec's success signal passing live, one live test per decided parity row, and proof that the plugin writes nothing into a workspace (AD-7). Today the rows' live files exist, but nothing checks that every decided row keeps one, the success signal has never run as one scenario, and the host contracts the backend shape relies on (host-served `exec`/`process`, the live-session fingerprint, the settings file) are pinned only by live runs (sweep F5: D13, D21).

**Approach:** Add (1) an offline parity-suite test that reads the manifest, the parity matrix, the provider doc, and the `describeLive` titles, so every decided row must name a live file that covers it; (2) offline host-contract tests that load OpenClaw 2026.10.3's own code from `.spike/` and run it against this plugin's real backend; (3) one live file for the success signal, which also checks AD-7 on both agents' workspaces. The full live suite then runs green once.

## Boundaries & Constraints

**Always:** No product behavior change: `src/` stays untouched, except a comment if a test reveals a wrong one. Existing tests stay unchanged; new files only, plus additive harness helpers. Live secrets (nonces, code words) are built at run time with `randomBytes`, never written as literals (the model reads test files natively). Every live config key, agent, Gateway, mock server, and temp dir the new file creates is restored or removed in `afterAll`, and no Gateway is left running. Host-contract tests find host code by function name (not by chunk hash or export alias) and skip (`describe.skipIf`) when `.spike/openclaw/node_modules/openclaw/dist` is missing, like `test/isolated-openclaw.test.ts`. Docs, matrix, and `MEMORY.md` change in the same change.

**Never:** Patch or copy OpenClaw code into the repo; add a dependency to `package.json`; widen a live assertion to make it pass; delete or skip an existing live row; edit `AGENTS.md`, `tickets.toml`, ticket files, or `runs/`; touch the user's own `~/.openclaw`; use `pkill -f`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Decided row without a live file | a `match`/`approx` row whose id is in no `describeLive` title | parity-suite test fails, naming the row | none |
| Doc or matrix drift | status in matrix cell or docs table differs from the manifest; a decided row's cell names no live file that covers it | parity-suite test fails, naming file and row | none |
| Gap row | `gap` in the manifest | non-empty manifest note; matrix cell starts `gap:` with a reason; no live file required | none |
| Host serves exec | real backend resolved by the host's `resolveCliBackendConfig`, default config, MCP on | host's `resolveCliMcpToolOwnership` gives `["exec","process"]` | none |
| Host withholds exec | exec host `node`; rooted; `cliToolAvailability` set; MCP off | `hostOwnedTools` undefined (documented P8 gaps) | none |
| Settings file | host writes it (`prepareCliBundleMcpConfig`, then `prepareCliBundleMcpCaptureAttempt`) for `additionalConfig` and for `exclusiveConfig` | plugin `readTurnTarget` gives the loopback URL, `Authorization: Bearer <token>`, and the capture key; each attempt has a new file path | none |
| Fingerprint | host `createCliLiveSessionCapability` for two turns | differs when only `GEMINI_CLI_SYSTEM_SETTINGS_PATH` differs; equal for equal env; `OPENCLAW_MCP_CLI_CAPTURE_KEY` ignored | failure message names the MEMORY open risks to recheck |
| Live-session contract | plugin `execute` (fake agent) with the host's real capability per turn | new path: second `initialize` and `session/load` of turn 1's id; same path: one process, prompt only; `current()` is the plugin's handle until it closes | none |
| Success signal | API turn, then `cursor-cli` turn on agent A while agent B runs a turn | see AC 3 | model-dependent misses retried, max 3 tries, all raws in the failure |

</intent-contract>

## Code Map

- Manifest and docs read by the parity-suite test: `src/adapters/cursor/manifest.ts` (`cursorManifest.rows`, statuses), `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` (table, cursor-cli is the 4th cell), `docs/providers/cursor.md` (Parity table: `| P<n> | Feature | Status | Notes |`). Known misses the test will surface: matrix P9 names only `exec-tool` (title `(P8, P10)`, add `permission-routing`), matrix P10 names no file, docs P13 names no file (add `images-compaction`). Rows ↔ files today: every decided row has a file (`describeLive` titles end with `(P..)`); `errors.live` is `(AD-11)`; P6 and P14 are gaps. So no row lacks a live test; record that.
- Live harness: `test/live/harness.ts` (`startGateway`, `openclaw`, `openclawAsync`, `connectApprovalClient`, `ISOLATED_STATE_DIR`). Patterns to reuse: mock API model and default-model restore (`history-continuity.live.test.ts` 85-116), agent with own workspace and `BOOTSTRAP.md` removal (`images-compaction.live.test.ts` 34-42), parallel agents and homes (`operations.live.test.ts` 29-31, 122-129), usage entry from SQLite (`usage.live.test.ts` `lastAssistantEntry`, path `<state>/agents/<agent>/agent/openclaw-agent.sqlite`), exec proof with runtime secrets (`exec-tool.live.test.ts`). Ports in use: 18912, 18913, 18930-18938, 18931, 18941; use 18960.
- Host code (read-only, `.spike/openclaw/node_modules/openclaw/dist/`, OpenClaw 2026.10.3; find by `function <name>(`, read the chunk's `export { local as alias }` list):
  - exported: `resolveCliBackendConfig` (`cli-backends-*`), `requireActivePluginRegistry` (`runtime-Dn-*`; push `{backend, pluginId}` into `.cliBackends`), `createMcpLoopbackServerConfig(port)` (`mcp-http.loopback-runtime-*`), `prepareCliBundleMcpConfig`, `prepareCliBundleMcpCaptureAttempt` (`prompt-context-*`), `createCliLiveSessionCapability`, `acceptsCliLiveSession` (`cli-live-session-registry-*`), `prepareSystemAgentRunAdmission` (`admitted-run-context-*`; `(cfg {}, runId, "main", "test", () => {}).admit("cli")` gives the `admittedRunContext` the capability needs).
  - not exported: `resolveCliMcpToolOwnership(run, {backend, enabled, rooted})` (`prepare.runtime-*`, ~line 479). Its only free names are the imports `resolveExecConfigState` and `normalizeToolPolicyName`.
  - minimal capability context (probed): `{params: {provider, agentId, sessionId, sessionKey, admittedRunContext}, backendResolved: {id}, preparedBackend: {backend: {liveSession, output, input}, mcpConfigHash}, workspaceDir, cwd, normalizedModel, modelId, systemPrompt, executionTarget: {kind: "plugin"}}`; `captureKey` must be set exactly when `preparedBackend.mcpClientGrantCapture` is.
- Plugin code driven by the tests (read-only): `src/core/backend.ts` `buildCliBackend`, `src/adapters/cursor/index.ts` `cursorAdapter`, `src/core/mcp-target.ts` `readTurnTarget`, `src/core/execute.ts` reuse (`current.fingerprint !== live.fingerprint` → restart). Offline turn pattern: `test/exec-tool.test.ts` `turn()`; fixtures `test/fixtures/{paths,stub-mcp-host,fake-cursor-agent.mjs}` (`FAKE_CURSOR_LOG` lines carry `method`).
- Parser for the loader: `parseAst` from `vite` (installed with vitest, a public export; no `package.json` change).
- Baseline (Node 24 `.spike/node/bin`, HEAD 26d8970): `npx tsc --noEmit` clean; `npx vitest run` 31 files passed / 15 skipped, 901 tests passed / 64 skipped. Host has `cursor-agent` and `CURSOR_API_KEY`.

## Tasks & Acceptance

**Execution:**
- [ ] `test/fixtures/host-code.ts` (new) -- `HOST_DIST` (`.spike/openclaw/node_modules/openclaw/dist`, or `OPENCLAW_ALL_CLI_HOST_DIST` when set), `hostAvailable`, `hostExport(name)` (the one chunk declaring `function name(`, its export alias, dynamic import), `hostFunction(name)` (slice the top-level declaration with `parseAst`, bind each import it names from the chunk's own import list, `new Function`; throw naming any chunk-local binding it would need) -- one way to load host code, no hashes.
- [ ] `test/host-contract.test.ts` (new) -- the five host rows of the I/O Matrix: ownership (register the real backend, resolve it with the host, then call `resolveCliMcpToolOwnership` with `config` variants); settings file (both config variants, then an end-to-end turn: plugin `execute` + fake agent `[[mcp-call]]` against `startStubMcpHost`, whose port feeds `createMcpLoopbackServerConfig`, so the stub sees the host-written `Authorization` and capture key); `acceptsCliLiveSession` true for the resolved backend; fingerprint; live-session contract (three plugin turns with the host's capability: path A, path B, path B; fake log shows `initialize` twice, `session/load` once with turn 1's id, and turn 3 only `session/prompt`). Close every handle; remove host temp files with the `cleanup` functions -- F5, D13, D21.
- [ ] `test/parity-suite.test.ts` (new) -- the three drift rows of the I/O Matrix over `cursorManifest`, the matrix, the docs table, and `test/live/*.live.test.ts` titles; and every live file has at least one `describeLive` -- one suite, enforced.
- [ ] `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` P9, P10; `docs/providers/cursor.md` P13 -- name the covering live files -- what the new test demands.
- [ ] `test/live/harness.ts` -- add `watchGatewayEvents(port)`: an operator WS client (scopes read, write, admin; no caps) that records every `event` frame with its receive order -- streaming evidence; `connectApprovalClient` unchanged.
- [ ] `test/live/success-signal.live.test.ts` (new, title ends `(spec success signal, AD-7)`, `it.skipIf(!CURSOR_API_KEY)`) -- per Design Notes; Gateway on 18960; agents `oac-signal-a`, `oac-signal-b` with workspaces under the test's temp root -- the epic's done-when 1.
- [ ] `docs/setup.md` Develop, `docs/providers/cursor.md` Check it works -- `npm test` runs host-contract tests when `.spike` holds OpenClaw; `npm run test:live` is the parity suite plus the success-signal scenario (needs `CURSOR_API_KEY` for usage).
- [ ] `MEMORY.md` -- one entry: host-code loader method, the capability recipe, Gateway `chat` frames reach a plain operator client, any finding of the full live run.

**Acceptance Criteria:**
- Given `.spike` with OpenClaw 2026.10.3, when `npx vitest run test/host-contract.test.ts test/parity-suite.test.ts` runs, then every test passes and none is skipped; with `OPENCLAW_ALL_CLI_HOST_DIST` set to a missing directory, the host-contract file is skipped, not failed.
- Given each guard below removed alone in a scratch copy of the tree, when its named test runs, then it fails: backend without `hostOwnedTools` (ownership); `readTurnTarget` ignoring headers (settings); `execute.ts` reuse ignoring the fingerprint (live-session); a `(P9)` removed from `permission-routing`'s title and the matrix P9 path (parity suite).
- Given the success-signal file with `CURSOR_API_KEY`, when it runs, then in one try: the API-then-cursor chat replies with the earlier code word; the host's operator stream carried at least 2 `chat` `delta` frames of the cursor run (its `runId`, received after that turn started) before that run's `final`, whose text holds the code word; the tool summary holds `mcp__openclaw__sessions_history` and `mcp__openclaw__exec`, and the reply holds the exec marker's runtime content; the cursor entry in agent A's transcript has `input > 0`, `output > 0`, and `totalTokens` equal to their sum with cache; agent B's turn overlapped A's and replied its nonce; the two homes differ, each `cli-config.json` still holds the AD-9 rules, and neither chat id is in the other's `acp-sessions`; a resumed A turn repeats the code word; both workspaces are identical to their snapshots.
- Given the change, when `npx tsc --noEmit`, `npx vitest run`, and `npm run build && npm run dev:install` then `npm run test:live` run, then typecheck is clean, the offline suite is 901 + new passed with only the new tests added, and every live file passes under plan 1.16's re-run rule (recorded flakes only, one re-run).

## Implementation Notes

Built as planned; `src/` untouched, existing tests unchanged.

- Inventory (recorded): every decided row (P1-P5, P7-P13, P15-P19) already had a live file; P6, P14 are gaps; `errors.live` is `(AD-11)`. No row lacked a live test. Matrix P9, P10 and docs P13 missed file names; fixed (matrix P9 adds `permission-routing`, P10 names `permission-routing` and `exec-tool`, docs P13 names `images-compaction`).
- Files: `test/fixtures/host-code.ts`, `test/host-contract.test.ts` (10 tests), `test/parity-suite.test.ts` (5 tests), `test/live/success-signal.live.test.ts`, `watchGatewayEvents` in `test/live/harness.ts`; docs (`docs/setup.md`, `docs/providers/cursor.md`, matrix) and `MEMORY.md`.
- Deviation from the Code Map: the live-session test gives all turns one shared bearer token (`attemptEnvs`), because the host hashes `OPENCLAW_MCP_TOKEN` when no managed grant exists; only the settings path then differs between path A and path B. `ProcessPool.closeAll()` is final, so each turn test builds its own backend and pool.
- Success signal: passed in try 0 each time (3 runs). No host-written workspace file appeared, so no path is excluded. Evidence of the last isolated run: 3 `chat` deltas before the final, tools `sessions_history` and `exec`, B's first frame before A's final.
- Verification: offline 916 passed / 65 skipped (901 + 15 new, 64 + 1 skipped); typecheck clean; `OPENCLAW_ALL_CLI_HOST_DIST=/nonexistent` skips the host-contract file. Mutation checks in a scratch copy, each failed its named test alone: no `hostOwnedTools` (ownership), `readTurnTarget` without headers (3 settings tests), `reusable()` without the fingerprint (live-session), `(P9)` out of the `permission-routing` title plus matrix P9 path (parity suite).
- Live: `npm run build && npm run dev:install`, then one `npm run test:live` (16 files, 3196 s). Three files failed first, none from this change: `history-continuity` (c) (`cli_budget` compaction, recorded flake; it failed again on its one re-run and passed on a third run), `mcp-proxy` two-turn (`cli_budget` compaction `Unknown model`; passed on re-run), `usage` second turn (plugin entry 0 while the ledger had the event; passed on re-run; not yet a recorded flake, now in `MEMORY.md`). After the run: no `openclaw-gatewa` or `cursor-agent` process, the isolated config holds no `mockapi` and no default model, `git status` shows the planned files only.

## Plan Change Log

## Review Triage Log

## Design Notes

**Success-signal try** (a failed model step is a soft miss: new session ids, up to 3 tries; a workspace change, home collision, or broken `cli-config.json` fails at once):
1. Snapshot both workspaces: relative path, type, size, sha256.
2. `--agent A --model mockapi/echo --session-id S`: "Remember this: the code word is WORD."
3. Start `--agent A --model cursor-cli/auto --session-id S --json`: ask for the code word, and to run `od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | tee <root>/markers/<id>` with its shell tool and reply with the output. Once the first frame for A's session arrives after this turn started (the API turn's frames came before), start B: `--agent B --session-id SB`, "Reply with exactly: NONCE".
4. Assert AC 3, then a resumed A turn, then the snapshots.

A host-written workspace file would fail step 4 without being the plugin's. If that happens, prove it with an API-only turn in a control workspace, exclude exactly that path, and say why in a comment and Implementation Notes.

**Why load host functions this way.** The host exports the settings and live-session functions under hashed aliases and keeps `resolveCliMcpToolOwnership` private. Finding by function name and running the host's own body with the host's own imports pins the contract without copying it. A host upgrade that renames a function fails loudly, which is the point: these tests are the recheck the MEMORY open risks ask for. All recipes were probed offline in planning (scratch, not committed).

**Review:** quick recommended; thorough if a live row needs an exclusion or a retry rule beyond the above.

## Verification

**Commands:**
- `PATH=$PWD/.spike/node/bin:$PATH npx tsc --noEmit` -- expected: clean
- `npx vitest run` -- expected: 901 + new tests passed; skipped 64 plus the new live file's tests
- `npm run build && npm run dev:install && npm run test:live` -- expected: all live files pass under the re-run rule, `success-signal` included (outside the sandbox, `CURSOR_API_KEY`)

**Manual checks:**
- After the live run: no `openclaw-gatewa` process, no `cursor-agent` of this run (`ps -eo pid,pgid,comm,args`), the isolated config has no `mockapi` provider and its prior default model, and `git status` shows only the planned files.

## Auto Run Result

Planning result: ready-for-dev (halted after planning, as invoked). Route full (auto, about 700 lines of tests, docs and fixtures), risk medium (the ticket's level kept: tests and docs only, no product code). Baseline `26d8970cc727d3f18858ef2f664d97764da81544`: typecheck clean, 901 passed / 64 skipped. Inventory: every decided parity row already has a live file; the matrix (P9, P10) and docs (P13) miss some file names. Offline probes in planning (scratch, not committed) confirmed each host recipe against OpenClaw 2026.10.3: the host serves `exec`/`process` to the real backend and withholds them for node, rooted, capped, no-MCP runs; host-written settings files read correctly through `readTurnTarget`; the fingerprint changes with the settings path; the plugin's `execute` with the host's real capability restarts and `session/load`s on a new path and reuses on the same one; a plain operator client gets `chat` `delta` and `final` frames of a `cursor-cli` run (fake agent, isolated Gateway on 18977, stopped, config restored). No live Cursor turn was run in planning. No product code was written.

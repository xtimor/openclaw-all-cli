---
title: '15-20 s to first token because cursor-agent is restarted on every turn'
type: 'bugfix'
ticket: '6'
created: '2026-10-24'
status: built
baseline_revision: 'dc124b7816265afa88fc70d62d7b89dfb5920655'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: ['oversized']
deferred:
  - summary: >-
      Turn 2 of a brand-new agent still restarts the process (OpenClaw hashes a system prompt and tool list that change once after the first turn).
    evidence: |-
      Fingerprint dump through a real Gateway: only systemPromptHash and promptToolNamesHash differ between turn 1 and turns 2 to 4; turns 2 to 4 are equal (log reuse=reusable-drift:prompt-tools). The input is the host's, not the plugin's.
    location: >-
      OpenClaw 2026.10.3 buildCliLiveSessionFingerprint
    severity: low
  - summary: >-
      One mcp-proxy.live run in five saw no warm tool call reach the opening host on turn 2 (unverified).
    evidence: |-
      Not reproduced in 4 more runs and in 3 Gateway-level warm tool runs. If it were a real race in pointWarmProxy or in the proxy after a turn switch it would be medium. Settle with a loop of the live row (20 runs) that logs the model's tool calls.
    location: >-
      test/live/mcp-proxy.live.test.ts
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** OpenClaw 2026.10.3 hashes the per-turn MCP settings path into its live-session fingerprint, so every `cursor-cli` turn restarts `cursor-agent` and resumes with `session/load`. Measured here: the restart is about 3.2 s of a 5.4-6.2 s plugin leg, and a warm follow-up needs 1.8-2.1 s.

**Approach:** Declare the host's `claude-config-file` MCP mode (the path rides in a launch flag that the host's fingerprint already normalizes, as it does for `claude-cli`), read the turn's target from that file, strip the host's flags before the launch, and keep a warm process on its opening target (the host moves each later turn's grant onto the process bearer and capture key).

## Boundaries & Constraints

**Always:** AD-13's reuse key and one process per chat stay. A process that opened without a usable target never serves another turn. The CLI is never given a host flag it does not know. Text deltas go on as they arrive.

**Never:** Change tool routing, permissions, or session resume. Replace the host's live-session handling with a plugin-owned pool. Print a key, token, or account id.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Follow-up, same session | host fingerprint equal, `useResume`, same chat | no `initialize`, no `session/load`; only `session/prompt`; calls reach the host with the opening bearer and capture key | none |
| Host flags in args | `--strict-mcp-config`, `--mcp-config <p>`, `--disallowedTools a,b`, `--mcp-config=<p>` | none reaches `cursor-agent`; the path is read | none |
| No `--mcp-config` / unreadable file | args without the flag, missing or bad file | turn runs without OpenClaw tools, one warning, process not reused if it opened so | warning names no token |
| Later turn's file bad on a warm process | opened with a good target | tools off for that turn, process stays | warning |

</intent-contract>

## Code Map

- `src/core/backend.ts` -- `bundleMcpMode` (now `gemini-system-settings`; host-contract test pins it).
- `src/core/mcp-target.ts` -- `readTurnTarget(env)` reads `GEMINI_CLI_SYSTEM_SETTINGS_PATH`; becomes path-from-args; add arg splitter.
- `src/core/turn-prompt.ts` -- `splitHostShell` strips host markers from `ctx.args`; also strip MCP flags.
- `src/core/execute.ts`, `live-entry.ts` -- `pointProxy` per turn; keep the opening target on the entry, re-point warm turns to it.
- `src/core/mcp-proxy.ts` -- comments (per-turn target) only.
- Tests using `SETTINGS_PATH_ENV`/`GEMINI_CLI_SYSTEM_SETTINGS_PATH`: `src/core/{execute,mcp-target}.test.ts`, `test/{backend,exec-tool,system-prompt,images,host-contract}.test.ts`, `test/live/{harness,mcp-proxy,permission-routing,streaming}*.ts`.
- Docs/record: `docs/providers/cursor.md` P4 + P7 rows, `claude-cli-parity.md` P4, AD-12 in the architecture spine, `MEMORY.md`.
- Host: `cli-live-session-registry-*.mjs` `buildCliLiveSessionFingerprint` (`--mcp-config` value `<unstable>` when `mcpConfigHash`), `prompt-context-*.mjs` (`claude-config-file` writer), `activate` (`adoptProcessToken`, `beginCapture(record.capture.key)`).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/mcp-target.ts`, `turn-prompt.ts`, `backend.ts` -- mode, path from args, strip host MCP flags
- [x] `src/core/execute.ts`, `live-entry.ts` -- warm turns keep the opening target
- [x] tests -- move to the new mechanism; add: host fingerprint stable across turns (host code), warm follow-up has no `initialize`/`session/load`, flag stripping, warm turn reaches the opening bearer
- [x] `test/live/turn-latency.live.test.ts` -- timing before/after; live warm two-turn tool call through a Gateway
- [x] docs, parity matrix, AD-12, `MEMORY.md`

**Acceptance Criteria:**
- Given a live turn, when timed, then the numbers below are in this plan, with no secret.
- Given the real host and a second turn of one session, when it runs, then the process is not restarted (one `cli live session start` per session) and an OpenClaw tool call on the warm turn works.
- Given ACP text deltas, when they arrive, then they pass on before the result (test at `execute` level).
- Given the manifest and matrix, when the fix lands, then the P4 note says the new behavior.

## Implementation Notes

Route: full by size (several hundred lines with tests); this worker cannot launch subagents, so it implements and reviews in the main session (`lenses_ran` records the passes run in-session).

**Measurements** (2026-10-24, cursor-agent 2026.10.22, OpenClaw 2026.10.3, this host, `cursor-cli/auto`, plain prompt "Reply with the single word OK."; `test/live/turn-latency.live.test.ts`; ACP probe for the stages):
- ACP start: spawn to `initialize` 0.6 s; `session/new` 2.2-2.7 s, `session/load` 2.2 s; first chunk about 2.1 s after the prompt. Same in a fresh home and a used one, any cwd: no Cursor cache effect (`statsig-cache.json` is already kept in the per-agent config dir). So the "reuse Cursor's cache" lever has nothing to give here; the start is a fixed ~3 s.
- `createExecute`, restarted every turn (stub host): open 3.0-3.5 s, first text 5.4-6.2 s, result 8.3-9.7 s. Warm process: first text 1.8-2.1 s, result 4.8-6.9 s. Text arrives 3 s before the result (the usage read follows it): the plugin does not buffer.
- Real Gateway (`openclaw agent`, 4 turns of one session): first assistant text at 9.2 and 9.4 s after the call (turns 3, 4; turn 2 13.9 s, turn 1 23.5 s); the log shows `cli live session start` on every turn (restart confirmed). About 4 s of that is the host (client start, preparation), 5.4 s the plugin leg.

**What was built** (all in the main session):
- `src/core/backend.ts`: `bundleMcpMode: "claude-config-file"`. `src/core/mcp-target.ts`: `splitMcpArgs` (host flags out of the launch args, first `--mcp-config` path back), `readTurnTarget(path)`. `src/core/turn-prompt.ts`: `splitHostShell` also returns the path and strips the flags. `src/core/execute.ts` and `live-entry.ts`: `entry.target`, `pointWarmProxy` (a warm turn keeps the opening target; the host's `activate` moves the later grant onto the process bearer and capture key).
- Tests: `test/host-contract.test.ts` rewritten to the new mode (stable fingerprint across runs with a new file, bearer, and capture key; warm turn with no `initialize` or `session/load`; grant adopted onto turn 1's bearer; restart on a changed fingerprint), `src/core/execute.test.ts` (warm target, bad later file, flags never reach the CLI, delta passes on before the turn ends), `src/core/mcp-target.test.ts`, `test/fixtures/host-mcp.ts`, live `test/live/turn-latency.live.test.ts`.
- Docs: `docs/providers/cursor.md` (new Warm process and latency section, OpenClaw tools, P4, P7, limits), `docs/setup.md`, parity matrix P4 and P7, AD-12 and the open-questions row, `MEMORY.md`.

**Measurements after the fix** (same host, same prompt): plugin first text, warm follow-up 2.0-2.1 s against 6.0-6.5 s restarted (open 3.1-3.4 s); through a Gateway, first assistant text of turns 3 and 4: 5.0 to 7.6 s over three runs (9.2 and 9.4 s before), one `cli live session start` for turns 1 and 2 and none after (log), OpenClaw tool call (`session_status`) answered on turns 2 and 3.

**The bound** (AC2): a plain follow-up reaches its first text within 3 s in the plugin (warm process, measured 1.8-2.1 s) and within 8 s through a Gateway on this host (measured 5.0-7.6 s), from turn 3 of a fresh agent. The live test asserts the relative bound (warm follow-up under 0.75 of a restarted turn). Not fixed by this change: the first two turns of a fresh agent (host prompt and tool list change once), the model's own 2 s, and the host's ~4 s before the plugin runs. The "reuse Cursor's cache" lever has no effect (see measurements): `statsig-cache.json` already lives in the per-agent config dir and a fresh home costs the same.

**Not verified:** the owner's 15-20 s on a real long-lived workspace (this host has a fresh agent and a one-word answer); a Cursor login (this host used `CURSOR_API_KEY`).

## Plan Change Log

## Review Triage Log

### 2026-10-24 - Review pass
- verdicts: 8 findings - high 0, medium 0, low 6, false 1, maybe-false 1
- findings:
  - `[low]` `[reject]` `splitMcpArgs` reads the non-dash arguments that follow `--disallowedTools` as its values, so a marker that did not start with `-` would be swallowed - same rule as the host's `extractClaudeVariadicArgs`, and both markers (`--openclaw-all-cli:host-shell`, `--openclaw-plugin-delivers-system-prompt`) start with `-`; a guard would only add code for a case the host itself shares.
  - `[low]` `[reject]` A warm process keeps the URL it opened with, so a host that changed its loopback port inside one Gateway life would strand it - the loopback server and our process live and die with the Gateway (a restart kills the processes, a stale one is reaped), and a changed port within a Gateway life was not seen; the fix would re-read the file and compare, which brings back the 401 on the bearer.
  - `[false]` `[reject]` `pointProxy` sets `entry.target ??=` on a warm fallback path from a later turn - unreachable: a process that opened without a usable target is `degraded` and `reusable()` skips it, so `pointWarmProxy` never meets an entry without a target (tests: degraded process in `execute.test.ts`).
  - `[low]` `[reject]` Unit tests name the config file in a test-only env key that `makeCtx`/`withHostMcp` turn into the host flags - test plumbing, not production code; the fixture is one 12-line file and the production path (flags in args) is what the tests drive.
  - `[low]` `[reject]` The live log check reads `/tmp/openclaw/openclaw-*.log` - the Gateway always logs there (MEMORY, clean-install notes), the file is read by byte offset like the other live rows, and a missing file gives 0 starts, which fails the `toBeLessThanOrEqual` check only if it is wrong in the safe direction.
  - `[low]` `[reject]` The live mutation of `pointWarmProxy` failed on a budget compaction error, not on a visible 401 - the unit mutation (M3) and the host-contract mutation fail on the credential check directly; the live row is corroboration.
  - `[low]` `[defer]` Turn 2 of a brand-new agent still restarts - pre-existing host behavior (first-turn system prompt and tool list differ), outside the plugin; see `deferred`.
  - `[maybe-false]` `[defer]` One `mcp-proxy.live` run in five saw no warm tool call on turn 2 - could be the model skipping the call (its own thinking said it knew the schema in another run) or a race in the proxy after a turn switch; 4 later runs and 3 Gateway-level runs passed; see `deferred`.
- Note: the four lenses are subagents; this worker cannot launch one, so each pass is the worker's own read of the diff, the code it touches, and the host code (`lenses_ran` names the passes run in-session, not independent reviewers). Mutations run on the tree (each named test failed, then restored): `bundleMcpMode` back to gemini (backend and host-contract tests), flags not stripped (7 execute tests), warm turn re-pointed at its own file (host-contract and 2 execute tests).

## Auto Run Result

**Summary:** The backend now declares the host's `claude-config-file` MCP mode, so OpenClaw's live-session fingerprint no longer changes with the per-turn MCP path: from the third turn of a fresh agent a follow-up reaches the warm `cursor-agent` process (no `initialize`, no `session/load`). The plugin reads the turn's target from the `--mcp-config` file in the launch args, strips the host's MCP flags before the launch, and keeps a warm process on the target it opened with (the host moves each later grant onto that process's bearer and capture key). Measured first assistant text of a plain follow-up through a Gateway: 5.0 to 7.6 s, was 9.2 to 9.4 s; at the plugin 2 s warm against 6 s restarted. Cursor's cache is not a lever (no effect measured). No plugin buffering: deltas pass on as they arrive (test added; text reaches the host before the usage read).

**Files changed:** `src/core/{backend,mcp-target,turn-prompt,execute,live-entry,mcp-proxy}.ts`, `src/adapters/cursor/manifest.ts`; tests `src/core/{execute,mcp-target}.test.ts`, `test/{host-contract,backend,exec-tool,system-prompt,images}.test.ts`, `test/fixtures/host-mcp.ts`, `test/live/{turn-latency,mcp-proxy,permission-routing,streaming}.live.test.ts`, `test/live/harness.ts`; docs `docs/providers/cursor.md`, `docs/setup.md`, parity matrix, architecture spine (AD-12), `MEMORY.md`.

**Review:** patches applied 0; deferred 2 (turn 2 of a fresh agent, low; one unverified live miss, medium unverified); rejected 5 low and 1 false, reasons in the triage log. Lenses ran in-session (no subagent available), not as independent reviewers.

**Verification:** `npm run ci` passed. Live (real `cursor-agent`, `CURSOR_API_KEY`, isolated OpenClaw 2026.10.3): `turn-latency.live.test.ts` (3 tests), `mcp-proxy.live.test.ts`, `streaming.live.test.ts`, `permission-routing.live.test.ts` passed (one earlier `mcp-proxy` miss, not reproduced in 4 runs; one Gateway tool run lost to OpenClaw's own budget compaction and passed on the next). Live timing of the owner's real workspace not run.

**Residual risks:** the first two turns of a fresh agent still restart once; the 15-20 s the owner saw may also hold model time (about 10 s in the report against 2 s here) that no plugin change reaches; a future OpenClaw that changes what its fingerprint hashes (the host-contract test names the failure) or stops moving the later grant onto the process bearer (the warm tool call would fail with 401).

## Verification

**Commands:**
- `npm run ci` -- expected: passes
- `NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/turn-latency.live.test.ts test/live/mcp-proxy.live.test.ts` -- expected: passes, numbers recorded

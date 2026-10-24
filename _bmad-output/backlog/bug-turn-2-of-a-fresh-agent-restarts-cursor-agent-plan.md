---
title: 'Turn 2 of a fresh agent restarts cursor-agent'
type: 'bugfix'
ticket: '8'
created: '2026-10-24'
status: built
baseline_revision: '6007064291fe41fc2d61b4f8607f58e31f083921'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: ['oversized']
deferred:
  - summary: >-
      Unverified: a config change that touches models, providers, or plugin settings may reload the Gateway's catalog owner and restart a warm session twice (tool list 52 to 50, then back).
    evidence: |-
      Only a plain config write (agents.defaults.subagents.maxConcurrent) was probed on a warm session: no drift. If a model-related write empties the catalog, the same race as at Gateway start would hit a running session. Settle with the probe recipe in MEMORY (warm session, config set plugins.entries.openclaw-all-cli.config..., two turns, dump the fingerprint).
    location: >-
      OpenClaw 2026.10.3 prepared model catalog owner (prepared-model-catalog)
    severity: low (unverified)
---

<intent-contract>

## Intent

**Problem:** Since ticket 6 a `cursor-cli` follow-up reaches the warm `cursor-agent` process, but turn 2 of a fresh agent still restarts it (about 3 s more to first text): OpenClaw 2026.10.3 sees a different `systemPromptHash` and `promptToolNamesHash` between turn 1 and turn 2, and nobody had read what changed.

**Approach:** Dump the fingerprint's hashed inputs (not only the hashes) through a real Gateway and name the exact text, tool names, and host code path. Then either keep one warm process from turn 1 with a supported plugin-side way, or record the host cause in `MEMORY.md` and give the owner a ready-to-file upstream OpenClaw issue.

## Boundaries & Constraints

**Always:** Tool routing, permissions, session resume, the system-prompt block rules, and the ticket 6 warm path (turn 3 on stays warm) stay as they are. A probe patch to an installed OpenClaw file is temporary and restored (checksum checked).

**Never:** Patch installed OpenClaw files beyond a restored probe. Use private host internals that a host update would break silently (a test must fail loudly). Replace the host's live-session handling with a plugin-owned pool. Print a key, token, or account id.

</intent-contract>

## Code Map

- `test/host-contract.test.ts` -- pins the two host facts the cause rests on (new tests below).
- `test/live/turn-latency.live.test.ts` -- live row for the steady state; comments corrected.
- `docs/providers/cursor.md`, `src/adapters/cursor/manifest.ts` (P4 note), `claude-cli-parity.md` (P4), `MEMORY.md` -- the old "a fresh agent's first turn changes the prompt" claim replaced by the real cause.
- Host (OpenClaw 2026.10.3 `dist`): `cli-live-session-registry-*.mjs` `buildCliLiveSessionFingerprint`, `createCliLiveSessionCapability`; `prepare.runtime-*.mjs` (`promptTools`, `promptToolNamesHash`); `mcp-http.runtime-*.mjs` and `openclaw-tools-*.mjs` (`computer`, `view_image` gates); `model-catalog-lookup-*.mjs` `prepareModelRunCapabilities`, `modelSupportsInput`; `agent-command-*.mjs` `prepareCommandModelCatalog`; `agent-runner-utils-*.mjs` `resolveRunModelHasVision`; `prepared-model-catalog-*.mjs` `loadProviderScopedThinkingCatalog`.

## Tasks & Acceptance

**Execution:**
- [x] Investigation: probe the fingerprint inputs for turns 1 to 3 of a fresh agent through a real Gateway (`openclaw agent` and `chat.send`), trace the code path, test every candidate fix.
- [x] `test/host-contract.test.ts` -- fingerprint follows system prompt and tool-name hash; `modelHasVision` follows the catalog row (mutation-checked).
- [x] `test/live/turn-latency.live.test.ts` -- a new agent with a loaded catalog keeps one process for four turns (mutation-checked).
- [x] Docs, P4 note, parity matrix, `MEMORY.md` -- correct cause and the one remaining case.
- [x] This plan: the findings, the candidates, the upstream issue text.

**Acceptance Criteria:**
- Given a fresh agent through a real Gateway, when the hashed inputs for turns 1 to 3 are dumped, then the plan names the differing text, the tool names, and the host path (AC1: see Findings).
- Given no supported plugin-side way, when the investigation ends, then the plan says why each candidate fails, `MEMORY.md` holds the cause, and the upstream issue text is below (AC3).
- Given turn 1 and turn 2, when the model receives them, then nothing the plugin sends changed (no plugin code changed; AC4).
- Given the suite, when `npm run ci` runs, then it passes (AC5; the tests that cover the condition pin the host cause, since there is no fix to fail on).

## Implementation Notes

Route: full by size; this worker cannot launch subagents, so it implemented and reviewed in the main session (the Quick lens ran as the worker's own read of the diff, not as an independent reviewer).

### Findings (AC1)

Setup: OpenClaw 2026.10.3, cursor-agent 2026.10.22, `cursor-cli/auto`, a new agent (`agents add`, scratch workspace, `BOOTSTRAP.md` kept), a Gateway started right before, four plain "Reply with the single word OK." messages. Probe: `buildCliLiveSessionFingerprint` patched to append its input object (raw system prompt text; env keys with sha256 of values only) to a file, `prepare.runtime` patched to append `promptTools` names and bootstrap facts, plus two read-only logs at `prepareModelRunCapabilities` and `resolveRunModelHasVision`. All four host files restored; sha256 equal to the originals.

**What differs, turn 1 vs turn 2 (6 of 6 cold runs, `openclaw agent` and `chat.send`):** only `systemPromptHash` and `promptToolNamesHash`. Turn 2 vs turn 3: nothing. Equal in all three turns: argv (`acp`, `--strict-mcp-config`, `<unstable>`, marker), argv0, env keys and value hashes, model, cwd and workspace hashes, auth, skills fingerprint, `extraSystemPromptHash`, `mcpResumeHash`.
- Tool names: turn 1 has 50, turn 2 has 52; the added names are `computer` and `view_image`. (Turn 1: dashboard nodes mobile_ui automations sessions theme terminal portal message tts transcripts presence gateway plugins openclaw agents_list get_goal create_goal update_goal skill_workshop progress_card ask_user secrets sessions_list sessions_history sessions_search conversations_list conversations_send conversations_turn sessions_send sessions_spawn agents_wait sessions_yield subagents session_status web_search web_fetch browser canvas file_fetch dir_list dir_fetch file_write memory_search memory_get intent node_inference talk_voice exec process.)
- System prompt text: 39 312 chars on turn 1, 39 336 on turn 2. The `diff` is exactly two added lines in the bare tool-name list of the Tooling section: `- view_image` (after `- skill_workshop`, before `- agents_wait`) and `- computer` (between `- ask_user` and `- create_goal`). Nothing else in the prompt moved.
- Log: turn 2 `cli exec ... reuse=reusable-drift:prompt-tools`, then a second `cli live session start`; turn 3 `reuse=reusable`.

**Host code path (why the two tools come late):**
1. `prepare.runtime` builds `promptTools` from the MCP projection (`prepareCliMcpToolProjection`), renders their names into the system prompt, and sets `promptToolNamesHash = hash(sorted names)`. `computer` is created only when `modelHasVision !== false` (`openclaw-tools`, `mcp-http.runtime`); `view_image` only when `modelHasVision` is true or an image model is configured.
2. `modelHasVision` is `entry.input.includes("image")` of the model's row (`modelSupportsInput`, missing row = false). Its source depends on the surface. `openclaw agent` / cron: `prepareModelRunCapabilities` on the command's thinking catalog (the static manifest catalog, plus an on-demand read of the loaded catalog). Web chat / channels: `resolveRunModelHasVision`: config `models.providers.<p>.models`, then the run's thinking catalog (empty for a chat turn), then `loadProviderScopedThinkingCatalog`, which reads the published catalog owner read-only and never starts a load (its comment: "Missing turn-path capabilities do not authorize another inventory").
3. The `cursor-cli` rows (with `input: ["text","image"]`) exist only after the plugin's `catalog.run` (auth probe plus an ACP model listing, about 4 s) has run. The host runs it in the background after the Gateway starts (measured: the listing began about 8 s after the Gateway opened its port and ended about 4 s later) and for a new agent's catalog owner. A turn that starts earlier reads the static catalog (122 rows, none of `cursor-cli`; chat path: `scopedLen 0`): `modelHasVision` false, 50 tools. The next turn reads the loaded catalog (123 rows on the agent path, 46 `cursor-cli` rows on the chat path): true, 52 tools.
4. `buildCliLiveSessionFingerprint` hashes `systemPrompt` and `promptToolNamesHash`; `createCliLiveSessionCapability` demands `handle.fingerprint === fingerprint` in `register` and `activate`, so the plugin cannot keep the old handle. The host starts a new process (the chat resumes with `session/load`).

So the cause is not "a fresh agent": it is a turn that begins before the Gateway's model catalog has the plugin's rows. Measured: turn 1 about 5 s after the port opened: drift in 6 of 6 runs; after waiting 45 to 75 s: no drift; `agents add` on a warm Gateway and an immediate turn: drift (1 run), a turn 4, 8, or 14 s after the add: none; a plain config write on a warm session: none. Cost: one extra start, about 3 s once (chat path: turn 2 final reply 11.6 s with the restart, 8.7 s warm; single runs).

A second, separate change of the system prompt, also at a new agent's start: while `BOOTSTRAP.md` exists the host puts it into the prompt (`bootstrapMode: full`, +7.5 k chars); once it is gone, `bootstrapMode: none`, `extraSystemPromptHash` goes, and the next turn restarts once (`reuse=reusable-drift:system-prompt`; seen at turn 3 in one run). In that run the host removed the file itself (`reconcileWorkspaceBootstrapCompletionState` runs `fs.rm` when `workspaceProfileLooksConfigured`: a `memory/` dir, `MEMORY.md`, a skill, or an edited IDENTITY/USER/SOUL; the model made no tool call; `memory/` and `DREAMS.md` had appeared in the workspace, probably from memory-core's background job: an inference). Host design, no plugin lever.

### Candidates (AC3: why none is a plugin-side fix)

| Candidate | Result |
| --- | --- |
| Manifest `modelCatalog` row for `auto` with `input: ["text","image"]` | Turn 1 sees the row on the `openclaw agent` path: no drift (1 start, equal fingerprints). The chat path never reads manifest rows (`scopedLen 0` on every turn, `modelHasVision` false, 50 tools, no drift but also no `computer`/`view_image` ever). With `discovery: "refreshable"` or `"runtime"` the Gateway's `models.list` was empty. Half a fix, not shipped. |
| `models.providers.cursor-cli.models: [{id: "auto", input: ["text","image"]}]` in the user's config | Both paths: 52 tools and equal fingerprints from turn 1; `models.list` still 46 rows. It is user config, covers only the listed models, and the plugin cannot set it (login `configPatch` keeps only `plugins`). Mentioned in the docs as an option the owner may take. |
| Faster or cached `catalog.run` (listing answered from disk) | Narrows the window, cannot close it, adds a stale-model-list risk. Not built. |
| Hide `computer`/`view_image` from the model | Changes the tools the model gets on turn 2 on (AC4 forbids). |
| Keep the old process under the new fingerprint (adopt it into a new handle) | A plugin-owned pool (Never); Cursor reads `tools/list` at connect, so the process would keep the old 50 tools. |
| `canTransportSystemPrompt`, `systemPromptArg` | Only decide the chat binding (`reusable-drift` keeps the chat); the live-session fingerprint hashes the prompt regardless. |

### Upstream issue text (ready to file)

**Title:** CLI live sessions restart on the second turn after a Gateway start: tool list depends on a model catalog that loads in the background

**Environment:** OpenClaw 2026.10.3, a plugin-owned CLI backend with `liveSession` (here `cursor-cli`, plugin `openclaw-all-cli`, whose provider catalog is produced by `catalog.run`), Linux, Node 24.

**What happens:** The first turn after the Gateway starts (or right after a new agent is created) runs with 50 prompt tools. The next turn runs with 52 (`computer` and `view_image` added, and their two lines in the system prompt). `buildCliLiveSessionFingerprint` hashes `systemPrompt` and `promptToolNamesHash`, so turn 2 starts a second CLI process (`reuse=reusable-drift:prompt-tools`, a second `cli live session start`). Turn 3 on is stable. A plugin cannot avoid it: `register` and `activate` require the handle fingerprint to equal the run's.

**Steps:**
1. Create an agent for a plugin CLI backend whose models come from `catalog.run`; set `agents.defaults.model.primary` to it.
2. Start the Gateway; as soon as it answers, send three messages in one session (`openclaw agent --agent A --session-id S --message ...`, or `chat.send`).
3. Compare the logs (or dump the inputs of `buildCliLiveSessionFingerprint`).

**Actual:** turn 1: `modelHasVision` false (the model's row is not in the catalog the turn reads: 122 rows, none for the provider), 50 prompt tools. Turn 2: true (123 rows, the provider's row has `input: ["text","image"]`), 52 tools: added `computer`, `view_image`; prompt diff `+ - view_image`, `+ - computer` (39 312 to 39 336 chars). Two `cli live session start` lines. With the Gateway idle for 45 s before turn 1 there is one.

**Expected:** a session's first turns see the same tool list; one CLI process for the session.

**Where:** `prepareModelRunCapabilities` (`openclaw agent`, cron) and `resolveRunModelHasVision` (chat, channels) turn a missing catalog row into `modelHasVision: false`. `resolveRunModelHasVision` ends in `loadProviderScopedThinkingCatalog`, which reads the published catalog owner read-only and never starts the load. The plugin rows arrive from the owner's background load (about 4 s here) after Gateway start and after an agent is added. The two tools are gated on `modelHasVision` (`computer`: `!== false`; `view_image`: true).

**Proposed host change (any one):**
1. In `resolveRunModelHasVision` and `prepareModelRunCapabilities`, when the model's provider is a plugin CLI backend and the row is missing, await the owner's pending load (bounded, for example 10 s) instead of treating it as "no vision".
2. Treat an unknown row as unknown: decide the tool surface from `modelHasVision === undefined` the same way on every turn until the row is known, so the list does not change when the row arrives.
3. Let the chat path read manifest `modelCatalog` rows as the command path does, so a plugin can declare `input` statically.

**Workaround:** a model row in the user's config, `models.providers.<provider>.models: [{id, name, input: ["text","image"]}]`, gives both paths 52 tools from turn 1.

### What changed in this repository

No plugin code changed; no code was reverted or re-derived. Tests: two host-contract tests (fail on a host that stops hashing the prompt or tool names, or stops deriving vision from the row; mutation-checked: `modelSupportsInput` forced true, `promptToolNamesHash` dropped, `systemPromptHash` dropped, each failed its test), and a live row (one `cli live session start` for four turns of a new agent once the catalog has loaded; without the wait it saw 2). Docs, the P4 note, the parity matrix, and `MEMORY.md` carry the corrected cause.

## Plan Change Log

## Review Triage Log

### 2026-10-24 - Review pass
- verdicts: 5 findings - high 0, medium 0, low 4, false 0, maybe-false 1
- findings:
  - `[low]` `[patch]` (docs/providers/cursor.md, MEMORY.md, this plan) The text said the model deletes `BOOTSTRAP.md` (and, once, that a plugin or the model wrote notes). The turn made no tool call: the host removes the file itself in `reconcileWorkspaceBootstrapCompletionState` when the workspace shows user content (a `memory/` dir, `MEMORY.md`, a skill, an edited profile file). Fixed in all four places, and the live test comment.
  - `[low]` `[reject]` The Known limits bullet in docs/providers/cursor.md is long and holds a user-config option - every sentence is a fact the reader needs (cause, cost, log line, when it stops, the option), all checked live; splitting would only add length.
  - `[maybe-false]` `[reject]` The new live row asserts exactly one start; a host prompt change in the middle of the test (memory-core writing workspace files) could add one and make it flaky - the row removes `BOOTSTRAP.md` up front, passed 4 of 4 runs, and the `main`-agent rows keep `<= 2` for the same reason; if true it is a low test flake (what would settle it: a 20-run loop).
  - `[low]` `[defer]` Config changes that touch models or plugins may reset the catalog on a warm session - not caused by this change, not verified; see `deferred`.
  - `[low]` `[reject]` Two host-contract tests pin host internals by function name (`prepareModelRunCapabilities`, the fingerprint) - that is the repository's method for host contracts (`fixtures/host-code.ts`): a rename fails the lookup loudly, which is the point.
- Note: the Quick lens is a subagent in the workflow; this worker cannot launch one, so the pass is the worker's own read of the diff and the host code (`lenses_ran` names the lens run in-session, not an independent reviewer).

## Auto Run Result

**Summary:** The turn-2 restart is not about a fresh agent. Between turn 1 and turn 2 OpenClaw 2026.10.3 adds two tools, `computer` and `view_image` (50 to 52 names, and two lines in the system prompt's tool list), because the model's image support is read from a Gateway model catalog that holds the plugin's `cursor-cli` rows only after the plugin's listing has run in the background after the Gateway starts (about 12 s). A turn that starts earlier reads the static catalog, the next turn the loaded one; the host hashes prompt and tool names into its live-session fingerprint and starts a second process. No plugin-side fix exists (candidate table above); the cause is in `MEMORY.md` and the upstream issue text is in this plan. With the catalog loaded, a new agent keeps one process for four turns (live row). Cost of the case: about 3 s once.

**Files changed:** `test/host-contract.test.ts` (two host-contract tests), `test/live/turn-latency.live.test.ts` (new live row, comments), `docs/providers/cursor.md`, `src/adapters/cursor/manifest.ts` (P4 note), `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` (P4), `MEMORY.md`, this plan. No plugin code changed; nothing reverted or re-derived.

**Review:** patches applied 1 (low, wording); deferred 1 (low, unverified); rejected 3 (reasons in the triage log). Lens run in-session.

**Verification:** `npm run ci` passed. Host-contract mutations (`modelSupportsInput` forced true, `promptToolNamesHash` dropped, `systemPromptHash` dropped) each failed their test and were restored. Live (real cursor-agent, `CURSOR_API_KEY`, isolated OpenClaw 2026.10.3): `turn-latency.live.test.ts` 4 of 4 passed; the new row passed 4 of 4 runs and failed (2 starts) when the wait for the catalog was removed. The probe patches of the installed OpenClaw (4 files) and the edited installed manifest were restored; sha256 equal to the originals.

**Residual risks:** the first turn within about 12 s of a Gateway start (or an agent's creation) still costs one extra start until the upstream issue is fixed; the owner's config row is a workaround for the listed models only; the owner's webchat was probed with `chat.send`, not the Control UI.

## Verification

**Commands:**
- `npm run ci` -- expected: passes
- `NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/turn-latency.live.test.ts` -- expected: 4 passed (includes the new row)

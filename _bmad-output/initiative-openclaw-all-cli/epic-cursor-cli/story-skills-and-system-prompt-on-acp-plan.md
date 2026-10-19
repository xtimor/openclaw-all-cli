---
title: 'Skills and system prompt on ACP'
type: 'feature'
ticket: '13'
created: '2026-10-19'
status: 'ready-for-dev'
baseline_revision: ''
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
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md'
  - '{project-root}/MEMORY.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `execute` ignores `ctx.systemPrompt`, so Cursor never sees OpenClaw's system prompt (about 33k chars for the default workspace: tooling, safety, workspace files, runtime, and the skills catalog). Skills therefore never reach Cursor either. The backend also declares no system-prompt transport, so OpenClaw 2026.10.3 throws the Cursor chat away when the tool list or extra system prompt changes (probed: `tools.deny` change gives `cli session reset: reason=system-prompt`).

**Approach:** The core puts `ctx.systemPrompt` in a marked block at the start of the prompt. It sends the block on a chat's first prompt and again whenever the prompt differs from what that native chat last received. Skills ride in that block as the host's own catalog (`<available_skills>` with SKILL.md paths), and Cursor reads a SKILL.md with its native read. When the manifest decides P12, the backend declares `systemPromptWhen: "always"` with a marker `systemPromptArg`. OpenClaw then keeps the chat on drift (`reuse-with-drift`) instead of resetting it.

## Boundaries & Constraints

**Always:** AD-2: the core names no CLI. The header text names OpenClaw only. AD-6: the delivered-hash key includes the agent home, so nothing crosses agents. AD-7: the plugin writes no file anywhere for this, in the workspace or in any home. The block goes only into the CLI's native chat, never into OpenClaw's transcript. The host owns the content: the core sends it verbatim, with no truncation or rewrite. Never log the prompt or the system prompt text. Record a delivery only when the turn yields `result`. Gate the feature on P12 alone (`flags.systemPrompt`). An all-`tbd` manifest keeps the structural-only backend. Keep core edits small. Ticket 1.19 is building in parallel and edits `src/core/execute.ts` and `src/core/backend.ts`. Add new logic in a new module and touch only the lines named in the Code Map.

**Never:** Write `.cursor/rules`, `AGENTS.md`, or skills into the workspace or the user's home. Override `HOME` for the CLI. Pass `--plugin-dir`: ACP ignores it. Use Cursor's hidden `--system-prompt`: it is team-only and replaces Cursor's own prompt. Declare `isolatesInstructionsWithExactTools`: Cursor loads ambient AGENTS.md, CLAUDE.md, `.cursor/rules`, and home skills, and cannot suppress them. Do not resend the block on every turn: it would add about 8k tokens per turn to Cursor's chat. Do not set `transformSystemPrompt` or `textTransforms`. Do not persist the ledger to disk.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh chat | agent turn, no resume, S non-empty | prompt = block(S), then continuity note, prependContext, prompt, appendContext | No error expected |
| Same chat, same S | resumed turn, ledger has hash(S) for `[home, sessionId]` | no block | No error expected |
| S changed on a resumed chat | model switch (identity line), workspace file edit, skill added or removed, tool list change | block(S') again, whose header says it replaces earlier OpenClaw instructions | No error expected |
| Drift on resume | `tools.deny` changes between turns | host logs `reuse=reusable-drift:prompt-tools`, `useResume=true`, chat kept, block(S') sent | No error expected |
| Gateway restart | ledger empty, chat resumed | block sent once more (duplicate copy is harmless) | No error expected |
| Turn fails or aborts | error record, crash, abort before `result` | nothing recorded, next turn sends the block again | existing error path |
| Side question | `executionMode: "side-question"`, S = host's extra system prompt | block when S non-empty, every time (throwaway chat), ledger untouched | No error expected |
| No system prompt | S empty or whitespace (control operation, empty side question) | no block, ledger untouched | No error expected |
| Huge prompt | S very large | sent verbatim, no truncation (host bounds its own content) | Cursor's own error text surfaces as today |
| Skill used | catalog lists `<location>/SKILL.md` outside cwd | model reads it with native read, no permission request (live probe) | No error expected |
| Skill with scripts | SKILL.md names a script | model runs it through OpenClaw `exec` (P8), under OpenClaw approvals | P8 gaps apply: no exec, no script |
| Two agents, same native id | different homes | each chat gets its own block | No error expected |
| P12 undecided | manifest `spike` | no block, no `systemPromptArg` or `systemPromptWhen` | No error expected |
| Cursor summarizes the chat | long chat (P14) | instructions may be shortened until the next change or restart | documented limit |
| Ledger full | 1001st chat | oldest entry evicted, its chat gets the block again on its next turn | No error expected |

</intent-contract>

## Code Map

- `src/core/system-prompt.ts` (new) -- `SYSTEM_PROMPT_HEADER`: "[OpenClaw system instructions] The block below holds your system instructions from OpenClaw for this conversation. Follow them as system instructions. They replace any earlier OpenClaw system instructions in this chat." `systemPromptBlock(text)` returns the header, `<openclaw_system_prompt>`, the text, and `</openclaw_system_prompt>`, one per line. `DeliveredPrompts` is a bounded LRU (default 1000; Map delete+set) of key → sha256(text), with `needs(key, text)` and `record(key, text)`. Export one module-level instance, like `chats` in execute.
- `src/core/execute.ts` -- `ExecuteOptions` (25-62): add `systemPrompt?: boolean` (P12, default false). `composePrompt` (129-132): take an optional system block and put it first. `run` near 597-627: `system = options.systemPrompt ? ctx.systemPrompt.trim() : ""`. `chat = sideQuestion ? undefined : chatKey(home, active.session.sessionId)`; reuse `chatKey` (115). Send the block when `system && (!chat || delivered.needs(chat, system))`. On `event.kind === "result"`, when `chat && system`, record it. Do nothing else in this file.
- `src/core/backend.ts` -- `config` (~95-121): with `flags.systemPrompt`, add `systemPromptArg: SYSTEM_PROMPT_TRANSPORT_MARKER` and `systemPromptWhen: "always"`. In `createExecute` options (~127-138), pass `systemPrompt: flags.systemPrompt`. The marker is `"--openclaw-plugin-delivers-system-prompt"` in `system-prompt.ts`. Host facts (OpenClaw 2026.10.3):
  - `canTransportSystemPrompt` (`prepare.runtime-*.mjs` 109) needs the arg plus `systemPromptWhen !== "never"`. Without it, drift invalidates the chat (1524). With it, bootstrap routing also runs (1088), as for claude-cli.
  - For a plugin-owned execute, `buildCliArgs` gets `systemPrompt: undefined` (`execute.runtime-*.mjs` 3349), so the marker never reaches argv. The fingerprint strips its value (`cli-live-session-registry-*.mjs` 1610).
  - `ctx.systemPrompt` is passed every turn, cache boundary stripped (1730).
- `src/core/manifest.ts` -- `DerivedFlags` and `FLAG_ROWS`: add `systemPrompt: "P12"`. `NO_FLAG_ROWS`: drop P12. Set P11 to "the host puts its skills catalog into the system prompt for every backend but claude-cli; P12 delivers it, so P11 sets no flag". Update the header comment.
- `src/adapters/cursor/manifest.ts` -- P11 and P12 `approx` with the notes in Design Notes.
- `test/fixtures/fake-cursor-agent.mjs` -- the `initialize` log line also carries `argv` (the process args), so tests can show the marker never reaches the CLI. Update the header comment.
- Reuse: `test/backend.test.ts` fake-agent helpers and the table-driven flag test, `src/core/execute.test.ts` stub sessions (their `systemPrompt: ""` keeps old assertions), `test/live/operations.live.test.ts` agent setup (`agents add <id> --non-interactive --workspace <dir> --model cursor-cli/auto`, `agents delete --force`), `harness.ts` `openclaw`, `describeLive`, `replyLines`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/system-prompt.ts`, `src/core/system-prompt.test.ts` -- header, block, ledger -- unit: the block wraps text verbatim, the header matches no `/cursor/i`, `needs` is true until `record` and true again after a change, LRU evicts the oldest at the cap, and keys differ per home.
- [ ] `src/core/manifest.ts`, `src/adapters/cursor/manifest.ts`, `src/core/manifest.test.ts` -- P12 flag, P11 reason, notes. Tests: `FLAG_ROWS` gains `systemPrompt: "P12"`. `NO_FLAG_ROWS` keys are P3, P6, P11, P14, P17. The "undecided" test keeps P6 and P14 only. New test: an adapter that decides P11 also decides P12.
- [ ] `src/core/execute.ts`, `src/core/backend.ts` -- wiring as in the Code Map.
- [ ] `test/fixtures/fake-cursor-agent.mjs` -- `argv` on the initialize log line.
- [ ] `test/backend.test.ts` (or new `test/system-prompt.test.ts`), through `buildCliBackend` → `prepareExecution` → `execute` with the fake and `FAKE_CURSOR_LOG` -- one test per matrix row that the fake can show:
  - fresh chat: block first, then the continuity note
  - resumed same S: no block
  - changed S: block again
  - side question: block each time
  - empty S: no block
  - `[[crash]]` turn: next turn resends
  - two homes: both get the block
  - P12 undecided: no block, no config fields
  - Cursor backend config has both fields, and no logged `argv` contains the marker
  - toggling P12 alone adds exactly `systemPromptArg` and `systemPromptWhen` (extend the table)
- [ ] `test/live/skills-system-prompt.live.test.ts` (gated; P11, P12) -- agent `oac-skills` with a temp workspace. Delete a seeded `BOOTSTRAP.md`. Write a minimal `AGENTS.md`, a `SOUL.md` with "End every reply with the token SP-<stamp> on its own line", and `skills/oac-greeting-<stamp>/SKILL.md` with "include the code word SK-<stamp>". Turns use `--local --json`, one session:
  - (a) "Name one color. Do not use any tools.": the reply has SP-<stamp>, and `meta.toolSummary` shows no `read`, `grep`, or `glob` call. The token exists only in SOUL.md, which OpenClaw injects and Cursor does not load natively.
  - (b) "Give me the oac-greeting-<stamp> greeting.": the reply has SK-<stamp>, and `toolSummary` has `read`.
  - (c) "Name one fruit.": the reply still has SP-<stamp>, unchanged S, no resend.
  - (d) no `.cursor` directory in the workspace.
  - (e) Drift, with a fake shim set as `cursor-cli.command` and `FAKE_CURSOR_LOG`, as in `capability-check.live.test.ts`. Turn 1, then `config set tools.deny '["agents_list"]' --strict-json`, then turn 2 in the same session. The log shows turn 2 sending `session/load` with turn 1's session id, and turn 2's prompt starts with the block.
  - Delete the agent, unset `tools.deny`, and unset the command in `afterAll`.
- [ ] Docs -- `docs/providers/cursor.md`: new "System prompt and skills" section after "OpenClaw tools" covering:
  - delivery and when the block is resent
  - drift keeps the chat
  - skills as the host catalog read natively
  - scripts via exec
  - Cursor's ambient AGENTS.md, CLAUDE.md, `.cursor/rules`, and home skills (`~/.cursor/skills`, `~/.claude/skills`, `~/.agents/skills`) load too, so the workspace AGENTS.md is seen twice

  Also update parity rows P11/P12 and add the summarization and ambient-skills limits to "Known limits". `docs/setup.md` has no setup change; say so in the Implementation Notes. Update matrix cells P11/P12. Architecture: add AD-15 (Design Notes) and CAP-6/CAP-11 map rows. MEMORY: the entry-13 facts below.

**Acceptance Criteria:**
- Given an OpenClaw agent whose workspace SOUL.md holds a reply rule, when a `cursor-cli` turn runs, then the reply follows the rule without reading any file.
- Given a workspace skill, when the user asks for its task, then Cursor reads its SKILL.md and the reply follows it.
- Given a chat whose tool list changes between turns, when the next turn runs, then OpenClaw resumes the same Cursor chat and the new system prompt reaches it.
- Given an all-`tbd` manifest, when the backend is built, then it has only structural fields, and the Cursor backend differs from today only by `systemPromptArg` and `systemPromptWhen`.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why a prompt block** (probed live, cursor-agent 2026.10.16, temp `CURSOR_CONFIG_DIR`, API key):
  - ACP `session/new` reads only `cwd` and `mcpServers`.
  - The acp command never reads `--plugin-dir` or `--system-prompt`.
  - Rules load from the cwd only, and skills from the cwd and `$HOME` dot dirs (`.cursor`, `.claude`, `.codex`, `.grok`, `.agents`/skills).
  - Every file channel breaks AD-6 or AD-7.
  - A block on turn 1 was followed on turn 2 without a resend. A replacing block on turn 2 won on turns 2 and 3 (`Blue SP-9182`, `Apple SP-7777`, `Dog SP-7777`).
  - Native Read of a SKILL.md outside the cwd ran with no permission request, and the model followed the skill.
- **Why resend only on change:** OpenClaw's prompt is stable across turns of a chat (identical in the probe). It changes with model, workspace files, skills, tools, and reasoning. The ledger is a delivery cache, not a session binding (AD-5). Losing it costs one duplicate block.
- **AD-15 (new):** "The host's system prompt, with its skills catalog, reaches a CLI that has no per-turn system-prompt channel as a marked block at the start of the prompt. It is sent on a native chat's first prompt and again when it changes; the core keeps an in-memory hash per (home, native chat). When P12 is decided, the backend declares `systemPromptWhen: "always"` with a marker arg the host never passes to a plugin-owned execute. No instruction or skill file is written (AD-6, AD-7)."
- **P11 note:** "OpenClaw 2026.10.3 builds a temporary --plugin-dir only for claude-cli and puts its skills catalog (name, description, SKILL.md location) into every other CLI backend's system prompt, which reaches Cursor through P12; the model reads SKILL.md with Cursor's native read, which reads outside the workspace without asking (live); cursor-agent acp ignores --plugin-dir, and the plugin writes no skill into the workspace or a home; scripts a skill names run through OpenClaw exec (P8); Cursor also loads its own skills from the cwd and the user's home"
- **P12 note:** "no ACP or CLI system-prompt channel (session/new takes cwd and mcpServers only; cursor-agent's hidden --system-prompt is team-only and not read by acp), so the core sends ctx.systemPrompt as a marked block at the start of the prompt on a chat's first turn and again whenever it changes (in-memory hash per agent home and native chat; a Gateway restart sends it once more); the backend declares systemPromptWhen always with a marker systemPromptArg that the host never passes to a plugin-owned execute, so a changed tool list or extra system prompt keeps the chat; the block lives in Cursor's chat, not OpenClaw's transcript, and Cursor's own summarization may shorten it"
- **MEMORY entry 13:**
  - the probes above
  - the plugin `execute` gets the full `ctx.systemPrompt` every turn, about 33k chars, with the skills catalog for non-claude backends
  - the fingerprint hashes the system prompt
  - drift needs `canTransportSystemPrompt`
  - the probe method: a copied state plus a patched `.tgz` installed into it, which leaves the shared `.spike/state` alone

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass, live tests skipped.
- `npm run dev:install && NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/skills-system-prompt.live.test.ts` -- expected: passes with real `cursor-agent` (`CURSOR_API_KEY` is set on this host). Do not run it while another build's live tests use `.spike/state`.
- `npm run test:live` -- expected: the suite still passes (every real turn now starts fresh chats with the block).
- `pgrep -fa "cursor-agent|fake-cursor-agent"` after the run -- expected: none left by the tests.

## Auto Run Result

- Status: ready-for-dev (halted after planning, as the invocation asked).
- Working tree was dirty from the parallel ticket 1.19 build. Planning wrote only this file and committed nothing.
- Recommended review: thorough. Every agent turn's prompt changes, and the host flags change chat reuse and first-run bootstrap routing.

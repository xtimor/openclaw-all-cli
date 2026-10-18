---
title: 'Chat continuity across a model switch'
type: 'feature'
ticket: '11'
created: '2026-10-18'
status: 'ready-for-dev'
baseline_revision: 'f1927df2417f3039dd949666c230e7f7798eaf15'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** After a mid-chat switch from an API model, `cursor-cli` answers without the earlier turns. Probed on OpenClaw 2026.10.3 (Gateway, real Cursor): the host sends only the new prompt (`historyPrompt=none`, log `cli session history refused across auth boundary: reason=auth-unknown`), with or without a `cursor-cli` `api_key` profile, because its history boundary trusts only turns written by the same CLI credential from an empty start. It adds no switch note. Without a hint Cursor never called `sessions_history` and gave a wrong answer taken from another session's memory. With a hint it called `sessions_history` (`sessionKey: "current"`) through the MCP proxy and answered correctly. The backend also leaves out `reseedFromRawTranscriptWhenUncompacted`, which `claude-cli` sets, so even with a profile a lost Cursor chat is never retried with history.

**Approach:** Two parts. (1) The core adds a short continuity note to the first prompt of every fresh agent chat that has the MCP proxy. The note points the model to `sessions_history` for turns it cannot see. (2) The backend sets `reseedFromRawTranscriptWhenUncompacted: true` when P15 is decided, so the host's own reseed works with an API-key profile. P15 becomes `approx`, and the fallback prelude is a `gap` with its reason.

## Boundaries & Constraints

**Always:** OpenClaw owns transcript, history policy, and session (AD-5): the plugin never reads OpenClaw's transcript itself and never gets around the auth boundary. History reaches the model only through the host's reseed or the policy-filtered `sessions_history` tool. The note text names OpenClaw and its tool, never a CLI (AD-2). The plugin keeps no state per chat: "fresh" means the process opened without `resumeSessionId`, and the note goes only on that process's first prompt. The note is never written to OpenClaw's transcript (the host records its own prompt). Logs carry no prompt text.

**Never:** Copy history into the prompt from plugin code. Add a session map. Change resume, reuse, permission, MCP-proxy or event behavior. Patch OpenClaw. Leave a live test's auth profile, mock provider, or Gateway behind.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Switch, no profile | API turns, then first `cursor-cli` turn | Fresh chat; the note comes first in the prompt; host `historyPrompt=none`; the model reads history with `sessions_history` | No error expected |
| Switch, with profile | Same, with a `cursor-cli:manual` `api_key` profile | Same as above. The host still refuses reseed (`auth-unknown`), because the API turns are outside the boundary | No error expected |
| Lost chat, with profile | `cursor-cli`-only chat, native chat deleted | `session_expired`, then a host fresh retry whose prompt holds `<conversation_history>`; the note is added too (reseed is capped at 12 288 chars) | Host retry; answer from history |
| Lost chat, no profile | Same, without a profile | Unchanged (1.7): `session_expired` every turn until `/reset` | Turn fails |
| Resumed turn | `useResume` with an id (every turn after the first, P4 restart) | No note | No error expected |
| Warm reuse | Second prompt on the same process (stub host) | No note | No error expected |
| Side question | `executionMode: "side-question"` | No note (no MCP) | No error expected |
| MCP off | Manifest P7 off / `ExecuteOptions.mcp: false` | No note | No error expected |
| Degraded first turn | No usable settings file | Note sent; it stays in the Cursor chat for later turns | Existing 503 path |
| Tool denied | `tools.deny` holds `sessions_history` | Note sent (worded "if available"); no history; documented | No error expected |
| Back to Cursor | cursor → API (new fact) → cursor resumes | Resume; the first prompt's note is still in Cursor's context; result recorded from a live probe | Per probe |
| Reverse switch | cursor turns, then API turn | The API request carries the cursor turns' user and assistant text from OpenClaw's transcript; no prelude (gap) | No error expected |
| `/reset` | No resume id | Fresh chat with the note; `current` history is the new session | No error expected |

</intent-contract>

## Code Map

- `src/core/manifest.ts` -- `DerivedFlags`/`deriveFlags`: add `history: decided(P15)`.
- `src/core/backend.ts` -- `config` block (around 64-82): add `reseedFromRawTranscriptWhenUncompacted: true` when `flags.history`. `prepareExecution` passes `continuity: flags.history && flags.mcp` to `createExecute`. Keep `freshSessionRecovery: "invalidated-only"`.
- `src/core/execute.ts` -- `ExecuteOptions` (`continuity?: boolean`, default false so existing prompt assertions hold); `LiveEntry` gets a one-shot "fresh chat" mark, set in `attachSession` (around 347) when `resumeSessionId` is undefined, mode is `agent`, and `entry.proxy` exists; `composePrompt` (102) puts the note first (`[note, prependContext, prompt, appendContext]`) and clears the mark. The note constant lives here. Ticket 1.10 works in parallel and may touch `execute.ts`: rebase, do not overwrite.
- `src/adapters/cursor/manifest.ts` -- P15 note (approx; the prelude is a gap, and why).
- `test/fixtures/mock-openai-api.mjs` (new) -- local OpenAI-compatible `/v1/chat/completions` (streamed and plain) and `/v1/models`. It sends a fixed reply and appends each request body as one JSON line to a log file given on argv. A spike version that worked: `models.providers.mockapi = {baseUrl:"http://127.0.0.1:<port>/v1", api:"openai-completions", apiKey:"sk-mock", models:[{id:"echo",name:"echo"}]}` via `config set ... --strict-json`.
- `test/live/harness.ts` -- `openclaw()`/`openclawAsync()` get an optional `input` (stdin), for `models auth paste-api-key --provider cursor-cli` (non-interactive works; it prints `Auth profile: cursor-cli:manual (cursor-cli/api_key)`; remove it with `models auth logout cursor-cli:manual --yes`). Reuse `startGateway`, `replyLines`, `ISOLATED_STATE_DIR`.
- `test/live/session-resume.live.test.ts` (222-252) -- pattern for deleting a native chat under `<home>/acp-sessions/`.
- Host (read-only, `.spike/openclaw/node_modules/openclaw/dist/`): `prepare.runtime-*.mjs` `prepareCliHistoryBoundary` (240, fingerprint from the `api_key`/`token`/`oauth` credential; "known" only for a contiguous CLI-written prefix or an empty start), reseed decision (1628-1698), auto-selected profile for `prepareExecution` backends (851-878); `session-history-*.mjs` `loadCliSessionPromptContext` (717, `auth-*` reasons give no messages), `RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS`, `buildCliSessionHistoryPrompt` (`<conversation_history>`, 12 288 chars); `execute.runtime-*.mjs` 3110 (`basePrompt` uses the history prompt only for a fresh chat), 1720-1740 (plugin `ctx` fields); `attempt-execution.runtime-*.mjs` 156 (fallback prelude only for `claude-cli`); `openclaw-tools-*.mjs` `sessions_history` (`sessionKey` required, `"current"` allowed, runs through the Gateway, so it fails under `--local`).

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/manifest.ts`, `src/core/backend.ts` -- `history` flag; reseed config flag; pass `continuity` -- host reseed parity with `claude-cli`.
- [ ] `src/core/execute.ts` -- continuity note on the first prompt of a fresh agent chat with a proxy -- the switch gap.
- [ ] `src/core/execute.test.ts`, `test/backend.test.ts`, `src/core/manifest.test.ts` -- with the fake agent and `FAKE_CURSOR_LOG` prompt text, one test per matrix row that the plugin decides: note on a fresh chat (and on top of a `<conversation_history>` prompt), none on resume, warm reuse, side question, MCP off, `continuity` off; config has the reseed flag exactly when P15 is decided.
- [ ] `test/fixtures/mock-openai-api.mjs`, `test/live/harness.ts` -- mock API model; stdin input.
- [ ] `test/live/history-continuity.live.test.ts` (new, gated, title names P15; one Gateway; random code words; config, profile and mock removed in `afterAll`) -- (a) no profile: a `mockapi/echo` turn states a word, then a `cursor-cli/auto` turn on the same `--session-id` gives it back; `--json` `toolSummary.tools` holds `sessions_history`; Gateway log `historyPrompt=none`. (b) The same with the profile (key from `CURSOR_API_KEY` on stdin); the log shows `reason=auth-unknown`. (c) With the profile, a `cursor-cli`-only chat whose native chat is deleted: the next turn returns the fact, and the log shows `historyPrompt=present`. (d) After (a), an API turn: the mock's logged request carries (a)'s `cursor-cli` user text and reply. (e) Probe cursor → API → cursor: record whether the model fetched the API-turn fact; no assertion.
- [ ] Docs -- `docs/providers/cursor.md`: new section "Chat continuity across a model switch" (the note, `sessions_history`, what the profile does and does not do, the prelude gap, `--local` has no Gateway for the tool), P15 row; `docs/setup.md`: rewrite the optional API-key paragraph (the `paste-api-key` command; the key only authorizes OpenClaw's reseed and is not handed to `cursor-agent`, so use the same key as `CURSOR_API_KEY` or the login account; billing is open, spec Q3), troubleshooting row "after a switch the model does not know earlier turns" (check `sessions_history` is not denied, run through a Gateway); parity matrix P15; `src/adapters/cursor/manifest.ts` P15; MEMORY facts (boundary, `auth-unknown` on a switch, profile command, mock provider, `--verbose on` takes a value, `sessions_history` needs a Gateway).

**Acceptance Criteria:**
- Given a chat whose earlier turn ran on an API model, with no Cursor API-key profile, when the user switches to `cursor-cli` and asks about that turn, then the reply gives the earlier fact correctly.
- Given the same with a `cursor-cli` `api_key` profile, when the user asks, then the reply gives the fact correctly.
- Given a profile and a `cursor-cli` chat whose native chat was lost, when the next turn runs, then it succeeds and the reply knows the earlier fact.
- Given an API turn after `cursor-cli` turns, when it runs, then the API model's request holds the `cursor-cli` turns' text.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why a note, not plugin-side history:** the host refuses reseed across the auth boundary on purpose. `sessions_history` stays under OpenClaw's tool policy (`tools.deny`, session visibility). The note costs about 70 tokens once per Cursor chat, and with the P4 restart only the first turn opens without resume. Suggested text:

  ```text
  [OpenClaw] This chat is part of an OpenClaw conversation. Turns answered by other models, before this chat started or between your turns, are not in your context. When the user refers to something you cannot see here, read the conversation with the OpenClaw tool `sessions_history` (sessionKey "current") before you answer, if that tool is available.
  ```

- **Profile scope (P15 approx):** the host auto-selects a `cursor-cli` `api_key` profile (probed: no boundary refusal for a `cursor-cli`-only chat). It reseeds only that chat's own history, and only for a fresh retry (`session_expired`) or a fresh start the host chooses. A switch from an API model is never covered.
- **Prelude (gap):** OpenClaw 2026.10.3 builds the fallback prelude only when the original provider is `claude-cli`, and it reads Claude's JSONL. There is no plugin seam for it. A model that takes over from `cursor-cli` still reads OpenClaw's transcript, with the user and assistant text of the cursor turns (probed). Only Cursor-internal tool detail is lost.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `npm run dev:install && OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/history-continuity.live.test.ts` -- expected: (a) to (d) pass with real `cursor-agent` and `CURSOR_API_KEY`; (e) recorded
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: the suite still passes
- `scripts/dev-openclaw.sh run models auth list` and `pgrep -f "^openclaw-gateway"` after the run -- expected: no profile, no Gateway left

## Auto Run Result

- Status: ready-for-dev (halted after planning, as the invocation asked).
- Planning evidence (2026-10-18, OpenClaw 2026.10.3, cursor-agent 2026.10.16, real Cursor via `CURSOR_API_KEY`, local mock API provider, isolated state restored afterwards): a switch from an API model gives `historyPrompt=none` with and without a `cursor-cli` `api_key` profile (`reason=auth-unknown`); without a hint Cursor answered wrongly from another session; with a hint it called `sessions_history` through the MCP proxy and answered correctly (Gateway only, not `--local`); a `cursor-cli`-only chat with the profile passes the boundary; an API turn after cursor turns sees their text.
- Open: Cursor API-key billing (spec Q3) stays open; it changes no task.

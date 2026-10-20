---
title: "Cursor errors must not appear as normal reply text"
type: 'bugfix'
ticket: 20
created: '2026-10-20'
status: built
baseline_revision: '874a33204b676fcf75dfe4c0f4a5a067d8b2f8e1'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/MEMORY.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Cursor reports a failed turn (network, auth, rate limit, plan) as one final `agent_message_chunk` and then `stopReason: end_turn`. The plugin shows it as a normal assistant reply, so OpenClaw failover, retries, and the transcript never see an error.

**Approach:** The ACP transport takes an optional adapter hook that recognises such a final chunk. A recognised chunk that ends the turn becomes an `error` event with a failover class; the Cursor adapter supplies the classifier.

## Boundaries & Constraints

**Always:** The transport stays CLI-neutral (AD-2): only the hook knows Cursor's wording. Error messages carry Cursor's original text plus keywords the host classifier reads (it reads message text only). Text that is followed by anything else in the turn stays ordinary text. A tool that started makes the error non-retryable.

**Never:** No change to `result` handling for normal turns, to cancel/refusal paths, or to usage. No retry loop in the plugin. Do not read `rawOutput` or other CLI files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal reply | text chunks, `end_turn` | text + `result`, unchanged | none |
| Failure chunk is last | final chunk `\n\nError: RetriableError: [internal] ...`, `end_turn` | `error` event (`server_error`, retryable if no tool started), no `result`, no assistant text | held chunk dropped from the reply |
| Action phrase last | `Upgrade your plan to continue` / `Please sign in to continue` / `Add a payment method to continue` / `Check your settings to continue` | `error`: `rate_limit` / `auth` / `billing` / `auth_permanent` | message has host keywords + original text |
| Look-alike, more follows | recognised chunk, then any text, thinking, or tool event | chunk flushed as ordinary text in order | none |
| Connect codes | `[unauthenticated]` `[permission_denied]` `[resource_exhausted]` `[unavailable]` `[deadline_exceeded]` `[invalid_argument]` | `auth`, `auth`, `rate_limit`, `overloaded`, `timeout`, `format` | unknown code: `server_error` |
| Start failure | `session/new` JSON-RPC `-32603`, `data.message` set | `CliError` message includes `data.message` | existing code mapping |
| Cancel with held chunk | `cancelled` stop | held chunk dropped, existing cancel error | none |

</intent-contract>

## Code Map

- `src/transports/acp/session.ts` -- `AcpSessionOptions`, `prompt()` loop, `settleTurn` (pushes `result`/`error`).
- `src/transports/acp/runtime.ts` -- `createClient.sessionUpdate` pushes `text`; hold logic goes here or in a small helper beside it.
- `src/transports/acp/handshake.ts` -- `toCliError`, `errorDetail` (reads JSON-RPC `data`); use it for start failures.
- `src/core/ports.ts` -- `CliErrorInfo`, `CliErrorCode` (reuse; no new codes).
- `src/adapters/cursor/index.ts` -- passes options to `AcpSession.open` (~l.222, ~l.281); add the hook.
- `src/adapters/cursor/errors.ts` -- new classifier. Do not change `tool-display.ts`, `usage.ts`.
- `test/fixtures/fake-cursor-agent.mjs` -- add `[[error]]<text>`: sends `<text>` as a final chunk, `end_turn`.
- `test/live/` + `harness.ts` -- add a live row (toggleable CONNECT proxy blocking `*.cursor.sh` after `session/new`); skip without a login.
- `docs/providers/cursor.md`, `docs/setup.md` (Troubleshooting), architecture spine AD-11 -- docs.

## Tasks & Acceptance

**Execution:**
- [x] `src/transports/acp/session.ts`, `runtime.ts` -- add `classifyReplyError?(text): CliErrorInfo | undefined`; hold a recognised text chunk, flush it on any later event, turn it into `error` in `settleTurn` on `end_turn`; drop on cancel -- the transport decides timing, the hook decides wording
- [x] `src/adapters/cursor/errors.ts` -- classifier: a chunk starting `\n\nError: ` then `[code]` or `<Name>: `, or one of the four exact phrases; `RetriableError` sets retryable; maps per the matrix -- Cursor wording in one place
- [x] `src/adapters/cursor/index.ts` -- pass the classifier on both open paths
- [x] `src/transports/acp/handshake.ts` -- include `data.message` in start failures
- [x] `src/transports/acp/session.test.ts`, `src/adapters/cursor/errors.test.ts`, fake agent -- unit tests for every matrix row
- [x] `test/live/errors.live.test.ts` -- forced failure gives an OpenClaw error turn, no assistant text
- [x] docs (`cursor.md` errors section and known limit: a reply that is exactly such a final chunk reads as an error; `setup.md` rows; AD-11 sentence)

**Acceptance Criteria:**
- Given a final failure chunk and `end_turn`, when the turn ends, then the consumer gets one `error` event with the matrix class and no `result` and no assistant text.
- Given a recognised chunk followed by more output, when the turn ends, then the chunk is in the reply in order and the turn ends with `result`.
- Given a forced Cursor failure through the real OpenClaw, when it runs, then the turn is an error turn (live; recorded `not run` if no Cursor login).
- Given `npm test`, and typecheck, when run, then all pass.

## Implementation Notes

Investigation (live, cursor-agent 2026.10.19): see commit 35886af. Failure text shapes: `\n\nError: <Name>: [<code>] ...`, `\n\nError: [unauthenticated] ...`, and bare action phrases. The host classifies by message text only, so wording matters: "rate limit", "payment required", "unauthorized" style keywords.

## Plan Change Log

## Review Triage Log

### 2026-10-20 — Review pass
- verdicts: 7 findings — high 0, medium 3, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `patch` SERVER_ERROR label "internal server error" reaches the host as `timeout` — checked with the host classifier; label changed to "reported a server error" (host gives no class)
  - `[medium]` `patch` empty trailing chunk flushes the held error as reply text — confirmed in `sessionUpdate` order; empty chunks are ignored, test added
  - `[low]` `patch` `failed_precondition` mapped to `format` against the plan's six codes — removed, falls to `server_error`
  - `[medium]` `patch` live test "no assistant text" check is weak and can throw unclearly — parse safely, assert no reply payload carries the error text
  - `[low]` `patch` setup.md row lacks the invalid-request-format message — row extended
  - `[low]` `reject` handshake `toCliError` wider than the plan and beside `errorDetail` — the wider message helps every start/resume failure the same way; `errorDetail` joins all data strings for matching, a different job; merging adds more code than it removes
  - `[low]` `reject` toggle-proxy test polling has no deadline — vitest's per-test timeout ends it; a deadline adds code to a test helper nobody will hit in everyday use

## Verification

**Commands:**
- `npm run typecheck && npm test` -- expected: pass
- `npm run test:live -- errors` -- expected: pass with a Cursor login; otherwise record as not run

## Auto Run Result

Status: built. Summary: a Cursor failure reported as the last reply chunk now ends the turn as an `error` event with a failover class; ordinary text is unchanged.

Files changed:
- `src/transports/acp/{session,runtime,handshake}.ts` -- `classifyReplyError` hook, held chunk, `data.message` in start failures.
- `src/adapters/cursor/{errors,index}.ts` -- Cursor classifier, wired on both open paths.
- `test/` (fake agent, live harness and `errors.live.test.ts`, `toggle-proxy.test.ts`), unit tests, `docs/`, AD-11, `MEMORY.md`.

Review (quick, pass 1): 7 findings; 5 patched (3 medium, 2 low), 2 rejected as low (see Review Triage Log). Deferred: 0.

Follow-up review recommended: true. Three medium entries were patched (server-error wording, empty-chunk flush, weak live assertion), so one more pass should check the patches themselves.

Verification: `npm run typecheck` clean; `npm test` 857 passed, 61 skipped; `test/live/errors.live.test.ts` passed against real cursor-agent 2026.10.19 with `CURSOR_API_KEY` (1 test, 62 s).

Residual risks: a proxy `403 Forbidden` quoted in Cursor's text is read by the host as `auth` (documented); a model reply that is exactly a failure-shaped final chunk reads as an error (documented).

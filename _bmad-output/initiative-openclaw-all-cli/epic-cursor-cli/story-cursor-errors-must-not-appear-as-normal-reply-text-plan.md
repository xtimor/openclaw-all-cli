---
title: "Cursor errors must not appear as normal reply text"
ticket: 20
status: draft
---

## Auto Run Result

Status: blocked. Blocking condition: `no subagents`. This worker has no subagent-launching tool (the workflow requires a review subagent and, on the full route, an implementing subagent). No code was changed. The working tree was clean before this file was added.

Investigation done (carry into the retry; checked live with cursor-agent 2026.10.19 and `CURSOR_API_KEY`, outside the sandbox):

- Cursor's `session/prompt` turn catch (bundle `6136.index.js`) sends the failure as ONE final `agent_message_chunk`, then returns `end_turn`:
  - `ActionRequiredError`: `"\n\n" + {login:"Please sign in to continue", upgrade:"Upgrade your plan to continue", payment:"Add a payment method to continue", config:"Check your settings to continue"}[action] ?? e.message` (no `Error:` prefix).
  - Unauthenticated connect error: `"\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key ..."`.
  - Anything else: `"\n\nError: " + String(e)`, with `e.name` one of `RetriableError`, `NonRetriableError` (or a plain JS error name) and a message that usually starts `[<connect code>] ` (`internal`, `resource_exhausted`, `unavailable`, `deadline_exceeded`, ...).
  - A `CancelledError` returns silently.
- Reproduced live with a toggleable chaining CONNECT proxy (block after `session/new`): reply chunk `"\n\nError: RetriableError: [internal] HTTPS proxy CONNECT failed: 403 Forbidden"` or `"... Failed to negotiate an HTTP CONNECT tunnel with the configured proxy"`, stopReason `end_turn`, no other text. A bad `CURSOR_API_KEY` or no network at start fails `session/new` with JSON-RPC `-32603 Internal error`, `data.message` `Failed to initialize session services` (already an error turn, class `server_error`; `toCliError` drops `data.message`).
- The host derives the failover reason from the error MESSAGE text only (`createCliOutputFailoverError` -> `classifyFailoverReason(message)`); `code`/`retryable` never reach it. Tested with the host's `classify-*.mjs`: `"Cursor rate limit reached: Upgrade your plan to continue"` -> rate_limit; `"... payment required"` -> billing; `"Cursor rejected the API key (unauthorized): invalid API key"` -> auth; bare `"Upgrade your plan to continue"`, `"Please sign in to continue"`, `"Check your settings to continue"` -> unclassified; any text with `403 Forbidden` -> auth. So the message wording is part of the fix.

Proposed design (not built):

1. Generic hook in `src/transports/acp/session.ts` / `runtime.ts`: `AcpSessionOptions.classifyReplyError?(text): CliErrorInfo | undefined`. A text chunk the hook recognises is held back instead of pushed; any later text, thinking, or tool event flushes it as ordinary text (it was not final); if the prompt ends `end_turn` with it still held, `settleTurn` closes open tools and pushes `{kind:"error"}` (retryable only if the hook says so and no tool started) instead of `result`. `cancelled`/`refusal` keep their paths; a held chunk is dropped on cancel.
2. `src/adapters/cursor/errors.ts` (new): the classifier for the three shapes above, matching only a chunk that starts `\n\nError: ` followed by `[code]` or `<Name>: `, or one of the four exact action phrases. Map connect codes: unauthenticated/permission_denied -> auth, resource_exhausted -> rate_limit, unavailable -> overloaded, deadline_exceeded -> timeout, invalid_argument/failed_precondition -> format, internal/unknown -> server_error; RetriableError -> retryable. Action phrases: login -> auth, upgrade -> rate_limit ("usage limit"), payment -> billing, config -> auth_permanent (invalid key or outdated client). Messages carry host-recognised keywords plus Cursor's original text.
3. `src/transports/acp/handshake.ts`: include JSON-RPC `data.message` in start failures.
4. Tests: classifier unit tests; `session.test.ts` hold/flush/error cases; fake agent `[[error]]<text>` support; a live row in `test/live/` using the toggleable CONNECT proxy (probe script idea: block `*.cursor.sh` after `session/new`), asserting an error turn and no assistant text.
5. Docs: `docs/providers/cursor.md` (new errors section, Known limits: a model reply that is exactly a final chunk starting `\n\nError: <Name>: ` would be read as an error), `docs/setup.md` troubleshooting rows, one sentence in AD-11.

Estimated size: well over 100 lines, so route `full`; risk `medium`.

Report: plan_file above; final status `blocked`; followup_review_recommended false; deferred items 0; code reverted or re-derived: no.

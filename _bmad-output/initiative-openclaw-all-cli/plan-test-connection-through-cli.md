---
title: 'Make the Control UI Test connection reach Cursor through cursor-agent'
type: 'bugfix'
ticket: ''
created: '2026-11-18'
status: 'draft'
baseline_revision: '72ceba6f737166bf6600fbd181a7cc57495e5db8'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** nick (2026-11-18, OpenClaw 2026.11.x): on the `cursor-cli` card, Test connection answers "Timed out" after 5 ms, although chats work. OpenClaw's `models.probe` runs `runIsolatedCompletion` with `agentHarnessRuntimeOverride: "openclaw"`. That sends an HTTP request to the provider's placeholder `baseUrl` `cli://local`. The fetch fails with "Invalid URL: must be http or https", and OpenClaw reports it as `timeout`. The same forced route serves OpenClaw's skill review and session companion "ask", so those fail for `cursor-cli` too. The quota note also says "Cursor CLI did not answer" when it was Cursor's quota API that did not answer.

**Approach:** The provider registers `createStreamFn` (present on 2026.10.3 and 2026.11.x). Any request OpenClaw's own runtime makes for a `cursor-cli` model then runs as one real, text-only Cursor turn through `cursor-agent acp`. The key is OpenClaw's `options.apiKey`, the model is the requested one, and the reply streams back as assistant text. Test connection then gives a real answer: ok, auth, rate limit, model not found, CLI missing. The stale quota note names the plan API instead of the CLI.

## Boundaries & Constraints

**Always:**
- Run the turn through the adapter (a new optional `CliAdapter.complete`), using the ACP transport (`AcpSession`) like `listModels`. The core stays CLI-agnostic.
- Run in `ask` mode, in a throwaway home and temp `cwd`, with no MCP servers, rejecting every permission request. Use the key only through the process env. Remove the temp home and the ACP session dir afterwards (as `checkKey` and `removeListingSession` do).
- Use the configured `cursor-cli.command`, else the adapter default, plus `cursor-cli.env`, with the same cleared env as a turn.
- Honour `options.signal`, and stop the process when it aborts.
- Map failures to OpenClaw failover reasons, so the probe shows auth, rate limit, model not found or CLI missing, and never "timeout" for a non-timeout.

**Never:**
- Never use `-p`/print mode for this (architecture AD-4).
- Never write the key to a file or a log, and never touch `~/.config/cursor/auth.json`.
- No tools, images or thinking output on this path. A context that asks for tools is still answered with text only.
- Do not change the CLI backend turn path (`execute`), the pool, or session reuse.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Probe, valid key | `models.probe` for `cursor-cli:default` | status `ok`, with the reply text | none |
| Rejected key | Cursor refuses the key | status `auth` | error event carries the auth reason |
| No key | `options.apiKey` empty, nothing in env | status `auth` with a clear message | no process started |
| CLI missing | `command` not found | a clear "CLI not found" message, never `timeout` | error event |
| Unknown model | model not offered to the account | status `format` or no_model, with the model name | error event |
| Abort / timeout | `signal` aborts | process stopped, `aborted` stop reason | no leftover process or temp dir |
| Multi-message context | system prompt, earlier turns, and the user message | one prompt that keeps the roles in order | none |

</frozen-after-approval>

## Code Map

- `src/core/synthetic-auth.ts` -- the provider object with `catalog.run`, and `probeEnv` (cleared env, plugin `env`, stored key). `CLI_BASE_URL` stays as is.
- `src/core/register.ts:253` -- `api.registerProvider({...createAuthProvider, ...createUsageHooks})`. Add the stream hook here, as a new spread.
- `src/core/quota.ts:41` -- the stale note text ("did not answer").
- `src/core/ports.ts` -- `CliAdapter` (`listModels`, `checkKey`, optional methods), `NormalizedEvent`, `CliError`, `FAILOVER_REASONS`. Add `complete?` and its params type.
- `src/adapters/cursor/index.ts` -- `open()` (mode, `selectCursorModel`, `authMethodFor`, `classifyCursorReplyError`), `listModels()` (throwaway session pattern), `checkKey()` (throwaway home env), `removeListingSession`. Write `complete` from these pieces.
- `src/core/config.ts` `readBackendConfig`; `src/core/backend.ts` `backendIdFor`; `src/core/env.ts` (cleared keys).
- OpenClaw types (2026.11.3 `dist/types-*.d.ts`): `StreamFn(model, context, options)`, `AssistantMessageEvent` (start, text_start, text_delta, text_end, done, error), `AssistantMessage` (role, content, api, provider, model, usage, stopReason, errorMessage, timestamp), `options.apiKey` and `options.signal`. `ProviderPlugin.createStreamFn(ctx)` gets `{config, agentDir, workspaceDir, provider, modelId, model}`. Also `classifyFailoverReason`.
- `test/fixtures/fake-cursor-agent.mjs` -- an ACP fake for tests (models, `FAKE_CURSOR_*` switches).

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` -- add `CompleteParams` (`command`, `args`, `env`, `modelId`, `prompt`, `signal?`) and optional `CliAdapter.complete(params): AsyncIterable<NormalizedEvent>` -- a one-shot text turn behind the adapter.
- [ ] `src/adapters/cursor/index.ts` -- implement `complete`: throwaway home env (as `checkKey`), `AcpSession.open` in `ask` mode with `selectModel`, no MCP, permissions `cancelled`, then `prompt`, yield the events, and finally close and clean up -- reuse, don't duplicate.
- [ ] `src/core/stream.ts` (new) -- `createStreamHook(adapter, pluginId)` returning `{ createStreamFn }`. It flattens `Context` (system prompt, then user and assistant messages with role labels, text parts only) into one prompt, runs `adapter.complete`, and maps the events to `AssistantMessageEvent`s with a final `done` or `error`. A `CliError` code becomes the message's failover reason (`classifyFailoverReason` if needed).
- [ ] `src/core/register.ts` -- spread `createStreamHook(...)` into `registerProvider`.
- [ ] `src/core/quota.ts` -- the stale note says the plan quota API did not answer, not the CLI.
- [ ] `test/stream.test.ts` (new) -- the I/O matrix with the fake agent: ok text, rejected key, no key, missing CLI, unknown model, abort (no leftover temp dir), and context flattening.
- [ ] `docs/providers/cursor.md`, `CHANGELOG.md` (Fixed) -- Test connection now runs a short Cursor request; the quota note wording.

**Acceptance Criteria:**
- Given an isolated OpenClaw 2026.11.3 Gateway with the plugin, the fake agent as `command`, and a saved key, when `gateway call models.probe {"provider":"cursor-cli","profileId":"cursor-cli:default"}` runs, then the status is `ok`.
- Given the same Gateway with `FAKE_CURSOR_ABOUT`/auth refusal, or a missing `command`, when the probe runs, then the status is not `timeout` and the error names the real cause.
- Given OpenClaw 2026.10.3, when the host-contract tests run, then they pass.

## Design Notes

The probe only needs non-empty text ("Reply with OK. Do not use tools."). A real turn costs a little Cursor quota per click. The alternative, a key-only check (`cursor-agent about`), is cheaper but tests no model and would leave the other forced-route features broken. It went to nick as a decision card on 2026-11-18, with this plan recommended, and his pick approves the plan.

## Verification

**Commands:**
- `npm run typecheck` -- expected: passes.
- `npm test` -- expected: passes, including `test/stream.test.ts`.
- The isolated-Gateway probe from the Acceptance Criteria, with the fake agent (`scratchpad/gw.sh`), on 2026.11.3 -- expected: `ok`, then not `timeout` for the failure cases.

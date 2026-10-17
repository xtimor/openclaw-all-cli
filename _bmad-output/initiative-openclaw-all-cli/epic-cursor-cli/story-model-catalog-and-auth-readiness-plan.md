---
title: 'Model catalog and auth readiness'
type: 'feature'
ticket: '6'
created: '2026-10-17'
status: 'in-review'
baseline_revision: '775ec60bb2ae086fa8a13a0a85f3e5c2c611c0cf'
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
  - '{project-root}/MEMORY.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `/model` shows only the default `cursor-cli/auto`. The account's other Cursor models are not listed, their aliases do not exist, and selecting a model other than `auto` fails because the ACP transport expects a `configOptions` model select while real Cursor reports models in the ACP `models` state with ids like `default[]` and `grok-4.7[context=256k,reasoning_effort=high,fast=true]`.

**Approach:** On entry 1's synthetic auth, list the account's Cursor models in `/model` as `cursor-cli/<model>`, with readable aliases, marked available when the Cursor login or `CURSOR_API_KEY` counts as auth (parity rows P1 and P2). Selecting a model runs the turn on that model.

## Boundaries & Constraints

**Always:** The catalog comes from Cursor itself (`cursor-agent --list-models` / `models`, or the ACP session's `models`), never from a hard-coded list; if listing fails, `cursor-cli/auto` alone stays available and the failure is logged. Cursor model ids contain brackets and commas (`claude-opus-5-5[context=300k,effort=medium,fast=false]`): the user-facing `cursor-cli/<name>` uses a stable readable name, and a mapping from name to Cursor's exact id lives in the adapter. Aliases are CLI-agnostic data the core hands to OpenClaw (`modelAliases`, `resolveModelId`). Catalog discovery must not slow every turn (cache it; invalidate on auth change or an explicit refresh) and must not run a model turn. The core stays CLI-agnostic (AD-2). `auto` keeps sending no model switch.

**Never:** Invent models the account lacks; hard-code a model list; spend tokens to discover models; change permission, MCP or event behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Logged in | Account with several models | `/model` lists them as `cursor-cli/<name>`, available | No error expected |
| Select a model | `cursor-cli/<name>` chosen | The turn runs on that model (Cursor reports it) | No error expected |
| Alias | A short name or old alias | Resolves to the exact Cursor id | No error expected |
| Parameterized id | Id with brackets and commas | A stable readable name; round-trips to the exact id | No error expected |
| Listing fails | `cursor-agent` missing or errors | Only `cursor-cli/auto`, failure logged | No turn fails |
| Not logged in | No login, no key | Models listed as unavailable ([indeterminate] is not enough) with a clear reason | Turn fails with the login error |
| Unknown model | A name the account lacks | Turn fails with `model_not_found` | CliError |
| API key only | `CURSOR_API_KEY` set, no login | Available | No error expected |

</intent-contract>

## Code Map

- `src/provider-discovery.ts`, `src/core/synthetic-auth.ts`, `src/core/register.ts` -- how entry 1 registers the provider catalog entry and synthetic auth; extend to publish the model list
- `src/core/ports.ts`, `src/core/backend.ts` -- adapter hook for listing models (name, display, exact id); `modelAliases`, `resolveModelId` from the OpenClaw backend config
- `src/transports/acp/session.ts` -- model selection: real Cursor reports `models` (`currentModelId`, `availableModels`); find with a live probe which ACP call switches model (`session/set_model`, `session/set_config_option`, or the id at `session/new`/`session/load`) and use it; keep the configOptions path for agents that provide it
- `src/adapters/cursor/index.ts` -- listing via `cursor-agent --list-models` (or ACP `models`), name mapping, exact id; `probeAuth`
- `test/fixtures/fake-cursor-agent.mjs` -- model list, bracketed ids, a switch call
- Host reference (read-only): `.spike/openclaw/node_modules/openclaw/dist/` -- provider catalog entry (`providerCatalogEntry`), CLI backend `modelAliases`/`resolveModelId`, how `/model` and `openclaw models list` read the catalog
- Facts: real `cursor-agent --list-models`, `cursor-agent models` and the ACP `session/new` result (`models.availableModels` with `modelId` and `name`) list the account's models; the first entry is `default[]` named Auto; `auto` works today because it sends no switch; non-auto selection currently throws `capability_mismatch` (deferred item from ticket 1). Real cursor-agent and `CURSOR_API_KEY` are available.

## Tasks & Acceptance

**Execution:**
- [x] live probes -- which ACP call switches model on real Cursor; the shape of `--list-models`; what `openclaw models list` / the catalog needs; record in Implementation Notes
- [x] `src/transports/acp/session.ts`, adapter -- model switching that works on real Cursor, `model_not_found` for an unknown name
- [x] `src/core/*`, adapter -- catalog discovery, name and alias mapping, cache, fallback to `auto`
- [x] unit tests -- every matrix row with the fake agent
- [x] live test (gated) -- the isolated OpenClaw lists the account's Cursor models; selecting a non-auto model runs a turn and Cursor reports that model
- [x] docs, manifest, parity P1 and P2 -- match behavior and evidence

**Acceptance Criteria:**
- Given a logged-in account, when `/model` (or `openclaw models list`) runs in the isolated OpenClaw, then the account's Cursor models appear as `cursor-cli/<name>`, available.
- Given a non-auto model is selected, when a turn runs, then it runs on that model.

## Implementation Notes

Built as planned, with the changes in the Plan Change Log. Files: `src/adapters/cursor/models.ts` (naming, name to exact ID, `selectCursorModel`), `src/adapters/cursor/index.ts` (`listModels`, `selectModel`, `modelAliases`), `src/transports/acp/session.ts` (`AcpModelInfo`, `selectModel` option, `AcpSession.models`, `switchModel`), `src/core/catalog.ts` (cache, in-flight sharing, fallback, logging), `src/core/synthetic-auth.ts` (the provider entry's `catalog.run`), `src/core/logger.ts`, `src/core/ports.ts` (`CliModel`, `CliAdapter.listModels`), `src/provider-discovery.ts`, tests next to each, `test/fixtures/fake-cursor-agent.mjs` (bracketed IDs, `FAKE_CURSOR_MODEL_SURFACE`, `FAKE_CURSOR_NO_MODELS`, `session/set_model`), `test/live/model-catalog.live.test.ts`, `test/live/harness.ts` (`startGateway`, `env` option).

- **Live probes (cursor-agent 2026.10.16, ACP).**
  - `session/new` and `session/load` return `models` (46 on this account) and a `configOptions` model select with the same IDs. The SDK's types omit `models`; the transport reads it as an extra field.
  - Both `session/set_model` and `session/set_config_option` switch the model; an unknown value fails with `Invalid params` (`Invalid model value: x`). The configOptions select is used when present, `session/set_model` (through `connection.extMethod`) otherwise. A bare base name (`grok-4.7`) and `--list-models` IDs (`grok-4.7-high-fast`) are rejected: only the exact ID works.
  - `--list-models` / `models` print other IDs than ACP, so the catalog comes from ACP only. A listing is a throwaway `cursor-agent acp` session in the temp directory: initialize, authenticate (skipped with `CURSOR_API_KEY`), `session/new`, close; about 3 s, no prompt.
  - Cursor persists the selected model in `CURSOR_CONFIG_DIR/cli-config.json` (`selectedModel`). The probe changed the shared `~/.cursor` default to `composer-2.5`; it was restored to Auto with `session/set_model default[]`.
  - A selected model answers as that model (`composer-2.5`: "I'm Composer"); `claude-sonnet-5` answered `Upgrade your plan to continue` on this plan (a plan limit, not a plugin fault).
- **What the host needs (OpenClaw 2026.10.3).** The provider entry's `catalog.run` is called with `providerIds`, `env`, `signal`; its result must hold `baseUrl` and `api` or the host silently drops every row (checked by removing `api`). `contextWindow` and `maxTokens` may be omitted. `api: "openai-completions"` is a placeholder: the turn runs through `execute`, no request is made. `catalog.run` runs only once the plugin is loaded, so a Gateway that does not name a `cursor-cli/...` model has no Cursor rows (OpenClaw #148584). Rows show in `gateway call models.list` and `openclaw models list --provider cursor-cli` (with a Gateway running), `available: true` with a login or key.
- **Not logged in (host with the fake agent, `FAKE_CURSOR_LOGGED_IN=0`, no key).** Only `cursor-cli/auto` is listed; the Gateway's list marks it `available: false, unavailableReason: "missing-auth"` and `models list` shows `Auth: no`. `openclaw models status` still says `[indeterminate]`: that command has no prepared synthetic auth in this OpenClaw version, so the plugin cannot change it. The login error itself comes from the existing `authenticate` step (`The CLI rejected its login`, code `auth`); the fake agent accepts any login, so it is not exercised host-less.
- **Listing failure.** `/bin/false` as the command with `CURSOR_API_KEY` set: only `auto` is listed and the Gateway log shows `Could not list the Cursor CLI models, so only auto is offered: ...` through the subsystem logger.
- **Naming.** The name is the lowercase base ID before `[` (`default` is `auto`). IDs that share a base get their parameter values (`twin-low`), then `key-value` pairs, then a number. The turn resolves the requested name against the session's own `models`/`configOptions` list at `open`, never against the cache, so a stale catalog cannot select a model the account lost: it fails with `model_not_found` and a message that names the model.
- **Evidence.** `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/model-catalog.live.test.ts`: the isolated Gateway lists the same 46 models as Cursor's own session, all available; `openclaw models list --provider cursor-cli` shows them; a turn on a non-auto model records that model in the per-agent `cli-config.json`; a following `cursor-cli/auto` turn records Auto again; an unknown model fails with the named error. Resume on a non-auto model (`session/load` with the model switch) ran two turns on one session.
- **Verification run.** `npm run typecheck && npm run build && npx vitest run`: 301 passed, 14 live skipped. `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live`: 13 of 14 passed; `permission-routing` "falls back to OpenClaw exec" failed once because the model paraphrased the stub's `stub-exec-ran:` output (exec was called), and passed on rerun (4 of 4): model variance, not related to this change.

## Plan Change Log

- **`auto` is not "no switch".** The plan said `auto` keeps sending no model switch. Cursor remembers the last model in the config directory, so after a turn on another model a per-agent home starts the next session on that model (checked live: `selectedModel` stayed `composer-2.5` until a switch). The adapter now switches to Auto's exact ID unless the session already runs on it, and sends nothing when it does (no switch in the common case). When the agent lists no Auto entry or no models, `auto` keeps the session's model.
- **configOptions path kept, `models` path added.** The plan assumed real Cursor has no configOptions model select. The probe shows both; the transport uses the select when present and `session/set_model` for an agent that only reports `models`. The fake agent covers both (`FAKE_CURSOR_MODEL_SURFACE`).
- **`resolveModelId` not used.** The host's `resolveModelId` hook is synchronous and only knows `modelId` and `contextWindow`; names are resolved against the live list in `open` instead. `modelAliases` holds only Cursor's spellings of Auto (`default[]`, `default`), which are structural, not a model list.
- **Aliases beyond that are not built.** No short names such as `opus`: they would be a hard-coded list. A name or the exact ID (any case) resolves.
- **Refresh.** The host passes no refresh flag to `catalog.run`, so the 1-minute cache TTL (plus an environment-hash key) bounds staleness; `openclaw models list --refresh` after that minute lists again.

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 10 findings — high 0, medium 4, low 6, false 0, maybe-false 0
- findings:
  - `medium` `patch` `catalog.ts`: callers sharing one in-flight listing all fail when the first caller's signal aborts, and the provider then publishes no rows, not even `auto` — patch: the shared load ignores caller signals; each caller races its own
  - `medium` `patch` `models.ts`: a model keeps its bare name only while its base is unique, so a second variant of a base renames the existing model and breaks configured `cursor-cli/<base>` refs — patch: the first id of a base in Cursor's order keeps the bare name, later ones get suffixes
  - `medium` `patch` `synthetic-auth.ts` hard-codes `input: ["text","image"]` for every model although images are P13 `spike` and the turn sends text only (and the flag belongs to the manifest, AD-10) — patch: derive input from manifest P13
  - `medium` `patch` The listing session runs against the user's shared Cursor home and leaves a throwaway chat in `~/.cursor/acp-sessions` on every refresh (30 sessions seen on this host) — patch: remove the listing session's own directory after listing
  - `low` `patch` `docs/setup.md` troubleshooting is wrong without a login (nothing is logged) and `--refresh` does not reach the plugin cache; a failed listing is pinned for 30 s — patch the text
  - `low` `patch` `docs/providers/cursor.md` presents a new login as an environment change; the cache key is command and env, so a new login is covered only by the 60 s TTL — patch the text
  - `low` `patch` `MEMORY.md` still says ACP lists models "not a configOptions select" and lacks the new fake-agent knobs — patch
  - `low` `patch` `src/core/logger.ts` falls back to `console.warn`, against the logging convention (OpenClaw logger only) — patch: no console fallback
  - `low` `reject` Plan matrix row "Not logged in" (models listed as unavailable) is not met and not in the Plan Change Log — models cannot be listed without a login (ACP `session/new` needs auth), so the row is unachievable; the Implementation Notes already say so; the fix is to edit this build's plan
  - `low` `reject` The catalog cache map never drops an entry — one small entry per distinct env or command in a Gateway's life

## Design Notes

Names must be unique and stable across Cursor releases where Cursor keeps the base model name; the exact id stays the source of truth. A cached catalog is acceptable; a stale one must not select a model the account lost (the switch fails with `model_not_found`).

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)

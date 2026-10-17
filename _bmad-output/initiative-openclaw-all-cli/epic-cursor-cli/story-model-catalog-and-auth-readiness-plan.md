---
title: 'Model catalog and auth readiness'
type: 'feature'
ticket: '6'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '775ec60bb2ae086fa8a13a0a85f3e5c2c611c0cf'
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
- [ ] live probes -- which ACP call switches model on real Cursor; the shape of `--list-models`; what `openclaw models list` / the catalog needs; record in Implementation Notes
- [ ] `src/transports/acp/session.ts`, adapter -- model switching that works on real Cursor, `model_not_found` for an unknown name
- [ ] `src/core/*`, adapter -- catalog discovery, name and alias mapping, cache, fallback to `auto`
- [ ] unit tests -- every matrix row with the fake agent
- [ ] live test (gated) -- the isolated OpenClaw lists the account's Cursor models; selecting a non-auto model runs a turn and Cursor reports that model
- [ ] docs, manifest, parity P1 and P2 -- match behavior and evidence

**Acceptance Criteria:**
- Given a logged-in account, when `/model` (or `openclaw models list`) runs in the isolated OpenClaw, then the account's Cursor models appear as `cursor-cli/<name>`, available.
- Given a non-auto model is selected, when a turn runs, then it runs on that model.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Names must be unique and stable across Cursor releases where Cursor keeps the base model name; the exact id stays the source of truth. A cached catalog is acceptable; a stale one must not select a model the account lost (the switch fails with `model_not_found`).

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)

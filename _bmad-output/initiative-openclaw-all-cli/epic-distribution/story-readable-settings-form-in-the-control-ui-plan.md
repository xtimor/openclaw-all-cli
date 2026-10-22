---
title: 'Readable settings form in the Control UI'
type: 'feature'
ticket: '1'
created: '2026-10-22'
status: done
baseline_revision: '7a65357e75d3074e7c2e896d6d2c26a9859948bb'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The OpenClaw Control UI form for `plugins.entries.openclaw-all-cli.config` shows raw field names with no help, and nothing in the manifest declares that `cursor-cli.env` values (which hold `CURSOR_API_KEY`) are secrets.

**Approach:** Add `uiHints` to `openclaw.plugin.json`: a label and help for `cursor-cli`, `cursor-cli.command`, `cursor-cli.env`, `cursor-cli.maxConcurrentTurns`, `cursor-cli.maxProcesses`; mark every `env` map value sensitive with the wildcard key `cursor-cli.env.*` (the host's redaction walk matches `<prefix>.*` per map key, as bundled channels do with `accounts.*.incomingUrl`; a hint on `cursor-cli.env` itself would redact the whole map into one sentinel); put the two limits under `advanced`. `configSchema` is unchanged, so every existing config stays valid. A unit test pins the hints; the isolated Gateway's `config.schema` shows them; `docs/setup.md` names the form.

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [ ] `openclaw.plugin.json` -- add `uiHints` as above; `configSchema` untouched
- [ ] `test/manifest-ui-hints.test.ts` -- new: every schema leaf under `cursor-cli` has a hint with non-empty `label` and `help`; `cursor-cli.env.*` is `sensitive: true`; both limits `advanced: true`; no hint key names a path the schema lacks
- [ ] `docs/setup.md` -- one short note in the settings section: the Control UI shows these settings as a form with help, env values are hidden as secrets, limits are under advanced

**Acceptance Criteria:**
- Given the isolated Gateway with the packed plugin installed, when `gateway call config.schema` runs, then the plugin's hints carry label and help for each field, `env.*` sensitive, limits advanced.
- Given an existing config with `cursor-cli.command`, `env`, and both limits set, when the Gateway starts, then config validation passes and `config get` shows the env value redacted.

## Implementation Notes

Oneshot: about 60 lines across three files, no code under `src/`. Host redaction (`dist/redact-snapshot-*.mjs`, `redactValue`) checks `[path, prefix.*]` against the sensitive-hint lookup, so `cursor-cli.env.*` redacts each value and keeps the keys; the name heuristic (`/api.?key/i`) already caught `CURSOR_API_KEY`, the hint makes it explicit and covers any other variable.

Done: `openclaw.plugin.json` (`uiHints`, also a `placeholder` for `command`), `test/manifest-ui-hints.test.ts`, `docs/setup.md` (one paragraph in section 3). Isolated Gateway 2026.10.3 (port 18911): `config.schema` lists the hints under `plugins.entries.openclaw-all-cli.config.cursor-cli.*`, `env.*` `sensitive: true`, limits `advanced: true`; a config with all four old keys loaded, and `config get` showed both env values as `__OPENCLAW_REDACTED__`. The probe config (fake key) was unset and the rotated `.bak` copies removed afterwards.

## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 5 findings — high 0, medium 1, low 3, false 0, maybe-false 0 (one rejected by rule)
- findings:
  - `[low]` `[patch]` test never asserts label and help of `cursor-cli.env.*` — added the path to the label/help loop; a mutation removing its label fails the test.
  - `[medium]` `[patch]` hints and test hardcode `cursor-cli` while the schema is built per backend (`buildConfigJsonSchema(cliBackends)`), so a second backend would get no hints and no sensitive env silently — the test now runs `describe.each(manifest.cliBackends)`, so a backend without hints fails.
  - `[low]` `[patch]` path check ignores segments after the third and accepts inherited names (`constructor`) — extra segments must be empty and lookups use `Object.hasOwn`; a mutation adding `cursor-cli.constructor` fails.
  - `[low]` `[reject]` Execution checkboxes unticked in the plan — the fix edits this build's plan (rule: reject).
  - `[low]` `[reject]` acceptance criteria backed by a recorded manual Gateway check, not an automated one — `openclaw config schema` offline carries no `uiHints`, so an automated check needs a running Gateway in a test; that is a new live harness for a host-side regression, more than a direct fix. The host code paths (`redactValue`, `config-cli` hints) were confirmed by the reviewer.

## Auto Run Result

- Summary: `uiHints` in `openclaw.plugin.json` give the Control UI form a label and help for every `cursor-cli` field, mark every `env` value sensitive (`cursor-cli.env.*`), and put the two limits under advanced; `configSchema` unchanged.
- Files: `openclaw.plugin.json` (hints), `test/manifest-ui-hints.test.ts` (hints per backend, paths valid), `docs/setup.md` (form note).
- Review: 3 patched (1 medium, 2 low), 0 deferred, 2 rejected (plan edit; Gateway test cost).
- Follow-up review recommended: false (one medium patched, no high).
- Verification: typecheck; `npm test` 920 passed, 65 skipped; mutation checks on the test; isolated Gateway `config.schema` and `config get` redaction (see Implementation Notes).
- Residual risk: a host change in how plugin `uiHints` reach `config.schema` is caught only by a manual check.

## Verification

**Commands:**
- `npm run typecheck && npx vitest run test/manifest-ui-hints.test.ts test/backend.test.ts test/isolated-openclaw.test.ts` -- expected: pass
- isolated Gateway (`scripts/dev-openclaw.sh`), `gateway call config.schema --json` -- expected: hints present under the plugin's config path

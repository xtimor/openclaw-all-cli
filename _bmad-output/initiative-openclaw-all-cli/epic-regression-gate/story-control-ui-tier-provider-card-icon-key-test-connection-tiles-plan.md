---
title: 'Control UI tier: provider card, icon, key, Test connection, tiles in a browser'
type: 'feature'
ticket: '6'
created: '2026-11-27'
status: 'in-progress'
baseline_revision: '2274a24f1e995ccdb05298f90176ae7f0543678d'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** What the owner sees in the Control UI (the provider's icon and name, the card's credential line, Connect with a key, Test connection, Remove key, the context tile) has only ever been checked by hand or by a one-off scratch script, and its bugs recurred (#35 → #45, #39 → #98, #40 → #97).

**Approach:** A `ui` tier: `scripts/regression.sh ui` runs `test/regression/ui/*.regression.test.ts` with Playwright's Chromium against the Control UI of the Gateway tier's real Gateway (packed plugin, fresh state, `fake-cursor-agent`), with a screenshot and the page's text saved on every failure; `regression.yml` gains the tier (on latest for pull requests, and selectable per version so ticket 4.7 can run the full matrix); ledger entries move to tier `ui` with `reproduces = true`.

## Boundaries & Constraints

**Always:** reuse the gateway harness (`startRegressionGateway`, `configure`, `fakeCommand`, `authLogin`, `chatSend`, `openclawVersion`/`runsOfflineCatalog`, `finishRegression`) rather than a second one; one shared Gateway per file at most; selectors by visible text or role, not by OpenClaw's hashed bundle names; every assertion message carries the evidence (the page text around the element, the URL, the screenshot path); no network beyond the Gateway on localhost (an `img src` pointing at `raw.githubusercontent.com` is checked by its attribute, never loaded); each check passes on 2026.10.3 and 2026.11.10 or states which versions it applies to and why; the tier stays under about 10 minutes per version; Playwright pinned to an exact version as a devDependency (1.63.0 matches this environment's preinstalled browsers under `/opt/pw-browsers`; in CI `npx playwright install --with-deps chromium`, cached); `npm test` neither runs nor slows because of it; failure screenshots uploaded as a workflow artifact; English.

**Never:** change `src/` (a check red on main is a new bug: stop and report it with evidence, as 4.3 and 4.9 did); weaken an assertion for a green; a real key or `cursor-agent`; touch `release.yml` (4.7) or `.spike/`. The #39 card check on 2026.10.3 is expected red because of open bug #106; leave it red with #106 in its message, never skip it for that reason.

## I/O & Edge-Case Matrix

| Check | Conditions | Expected on main | Mutation that must turn it red |
|-------|-----------|------------------|------------------------------|
| #35/#45 icon | plugin installed | the Plugins page (or wherever the host draws plugin icons) shows our icon, served 200 as a PNG from `/__openclaw__/plugin-icon/openclaw-all-cli`; the model setup page's choice carries the manifest `icon` URL | #35: drop `assets/icon.png` from `package.json` `files`; #45: delete `icon` in `openclaw.plugin.json` |
| #36 name | Connect provider dialog, `/model-providers` | the provider reads "OAC / Cursor-CLI", never a bare "Cursor CLI" | `PROVIDER_LABEL` (or the manifest label the UI actually renders) back to "Cursor CLI" |
| #39 card | a key saved through Connect provider in the browser | the card lists the key's profile with Remove key, not "Not configured" (red on 2026.10.3 by #106) | the api-key method returns no profile (`src/core/provider-auth.ts` `profiles`) |
| #98 refused key | the fake refuses the key (`FAKE_CURSOR_ABOUT=invalid`) and the owner enters it in Connect provider | the dialog says the key is invalid and was not saved, and the card stays without a key | `probeAuth` accepts any non-empty key |
| Test connection | a saved dummy key | the button reports success, and the fake log shows the probe's one turn | the stream hook is not registered (`register.ts` `createStreamHook`); applies where `models.probe` runs the CLI (2026.10.3, see 4.9) |
| Remove key | a saved key | Remove key empties the card's key line and the store | (no separate fix; asserts the PR #92 path from the UI) |
| #40/#97 context tile | turns with `[[usage:<json>]]` (a tool-heavy turn's summed usage, then a plain turn) on the 256k model, readings at or below about 100k on 2026.10.3 | the chat's context tile never shows more than the window and never goes down between turns | #40: the ceiling check in `src/core/usage.ts` always passes; #97: `fellBelowAcceptedHigh` forced false |

</intent-contract>

## Code Map

- `test/regression/harness.ts`, `test/regression/gateway/{auth-setup,context-usage,managed-cli}.regression.test.ts` -- the conditions for #39/#98/Test connection/#40/#97 already exist at the Gateway level; reuse them, put browser helpers (launch, open page, screenshot-on-failure) in a small `test/regression/ui/browser.ts` or the harness.
- `scripts/regression.sh` -- tier selection (`gateway`), `--tgz`, `--result` (written by `scripts/regression-result.mjs`); add `ui` the same way, sharing the setup.
- `.github/workflows/regression.yml`, `ci.yml` -- add a tier input (or a UI job) so ci.yml runs `ui` on latest; 4.7 will call it per version; follow the 4.4 patterns (`defaults.run.shell: bash`, `PIPESTATUS`, restore/save caches, `persist-credentials: false`, per-version artifact names).
- UI facts: Control UI on the Gateway's HTTP port, `--auth none` in the tier; pages `/model-providers`; the plugin icon route above; 2026.10.10 card text "Credentials for main" / "Not configured" and the button "Connect provider" (`docs/providers/cursor-card-latest.md`); icon behavior per page in `docs/providers/cursor.md` around :338-346; chat picker and card draw a letter avatar (upstream openclaw/openclaw#186945), so do not assert our icon there; 2026.11.10 offline has no catalog and `models.probe` answers `format` (skip with reason).
- `src/adapters/cursor/index.ts` :341/:547 (`PROVIDER_LABEL`), `openclaw.plugin.json` :44 (`icon`), :46 (`groupLabel`), :89; `src/core/provider-auth.ts` :449; `src/core/usage.ts` :30-38; `src/core/register.ts` :258 -- read-only, for the mutations.
- Backlog context: `_bmad-output/backlog/` files for #35, #45, #9, #36, #39, #98, #40, #97 and `story-verify-the-cursor-cli-provider-card-on-current-openclaw-latest*.md` (the earlier Playwright measurement).
- `test/regression/ledger.toml` -- #35, #36, #39, #40, #45, #97, #98 get their ui tests (`tier = "ui"`, `reproduces = true`), `4.6` removed from `planned` (keep other tickets).
- Mutation proof as in 4.3/4.9: a scratch `git worktree` under the session scratchpad, one mutation per row, red/green recorded.

## Tasks & Acceptance

**Execution:**
- [ ] `test/regression/ui/*.regression.test.ts` and a browser helper -- every matrix row
- [ ] `scripts/regression.sh` -- `ui` tier
- [ ] `package.json` / `package-lock.json` -- `playwright` pinned devDependency
- [ ] `.github/workflows/regression.yml`, `ci.yml` -- UI tier on latest for pull requests, failure screenshots as an artifact
- [ ] `test/regression/ledger.toml` -- the entries above
- [ ] `docs/release.md` (the tier section), `MEMORY.md` -- a few lines
- [ ] this plan's Implementation Notes -- per row: conditions, mutation, red/green per version

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh ui --openclaw latest` runs, then every check passes or skips with a stated reason, under about 10 minutes; on 2026.10.3 only the #39 card check is red (#106).
- Given each row's mutation in a scratch copy, when the tier runs, then that row fails and a screenshot is saved.
- Given this pull request, when CI runs, then a UI job on latest appears, and its failure would upload screenshots.
- Given `npm test` and `npm run typecheck`, then both are green and `npm test` does not start a browser.
- Given a run ends, then no Gateway, fake, or browser process from it is left.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh ui --openclaw latest` -- expected: pass (stated skips allowed)
- `scripts/regression.sh ui` -- expected: pass except the #39 card check (#106)
- `npm test`, `npm run typecheck` -- expected: green

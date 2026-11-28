---
title: 'Control UI tier: provider card, icon, key, Test connection, tiles in a browser'
type: 'feature'
ticket: '6'
created: '2026-11-27'
status: done
baseline_revision: '2274a24f1e995ccdb05298f90176ae7f0543678d'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['quick']
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
- [x] `test/regression/ui/*.regression.test.ts` and a browser helper -- every matrix row
- [x] `scripts/regression.sh` -- `ui` tier
- [x] `package.json` / `package-lock.json` -- `playwright` pinned devDependency
- [x] `.github/workflows/regression.yml`, `ci.yml` -- UI tier on latest for pull requests, failure screenshots as an artifact
- [x] `test/regression/ledger.toml` -- the entries above
- [x] `docs/release.md` (the tier section), `MEMORY.md` -- a few lines
- [x] this plan's Implementation Notes -- per row: conditions, mutation, red/green per version

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh ui --openclaw latest` runs, then every check passes or skips with a stated reason, under about 10 minutes; on 2026.10.3 only the #39 card check is red (#106).
- Given each row's mutation in a scratch copy, when the tier runs, then that row fails and a screenshot is saved.
- Given this pull request, when CI runs, then a UI job on latest appears, and its failure would upload screenshots.
- Given `npm test` and `npm run typecheck`, then both are green and `npm test` does not start a browser.
- Given a run ends, then no Gateway, fake, or browser process from it is left.

## Implementation Notes

- Files: `test/regression/ui/browser.ts` (helpers), `provider-card.regression.test.ts` (#35/#45, #36, #39, #98), `key-actions.regression.test.ts` (Test connection, Remove key), `context-tile.regression.test.ts` (#40, #97); one Gateway per file through the gateway harness (`startRegressionGateway`, `configure`, `fakeCommand`, `gatewayCall`, `readFakeLog`, `runsOfflineCatalog`, `finishRegression`). Harness change: `startRegressionGateway({ waitForCatalog: false })` returns `catalog: "skipped"` for a Gateway whose config does not load the plugin at start. `playwright` 1.63.0 is imported dynamically in `launchBrowser()` only (types are `import type`), so `npm test` collects the skipped files without loading it; `OPENCLAW_ALL_CLI_CHROMIUM` is the local executable fallback (not needed here: the pinned Playwright found `/opt/pw-browsers`).
- Browser isolation (`withUiPage`): a fresh context per check (1400x1000, deviceScaleFactor 1, service workers blocked); every request not to `http://127.0.0.1:<port>` is aborted and listed in the evidence, and every WebSocket not to `ws://127.0.0.1:<port>` is closed unopened (`context.routeWebSocket`, review finding 7); requests to the Gateway's catalog-icon proxy (`/__openclaw__/catalog-icon/<url>`, which would make the Gateway fetch the URL) are aborted and recorded by URL. On a failure the page's full screenshot and text go to `<OPENCLAW_ALL_CLI_UI_ARTIFACTS>/<check>.png|.txt` and every assertion message names them, with the URL and the text of the element checked. No run left a browser, Gateway, or fake process (`pgrep` after every run).
- Selectors: visible text and roles (`Connect provider`/`Add account`, `Submit`, `Continue`, `Test connection`/`Test access`, `Remove key`/`Sign out of <account>?`, textbox named by the manifest `choiceLabel`, `Chat composer`), OpenClaw's `data-provider-id`/`data-plugin-id` attributes to scope a card or a plugin row, the context tile by its accessible name (`aria-label` "Session context usage: ..."). 2026.10.x dialogs are a `<dialog role="dialog">` in a shadow root with slotted content (its own innerText is empty), so `modalText` reads what the slots show.
- Rows (main, red/green per version; mutations in a scratch worktree, packed there and run with these unchanged checks through `--tgz`-style installs; every red run saved its screenshot):
  - #35/#45 icon. Conditions: plugin installed, cursor-cli the model. Checks: the Plugins page row "OpenClaw All CLI" draws an image (naturalWidth > 0) whose `src` is a `blob:` URL or the icon route; the route's response (awaited with `page.waitForResponse`, registered before the page loads) is 200 `image/png`; the bytes the drawn `src` holds equal the served body; and the served body decodes, in Node (`test/regression/ui/png.ts`: zlib inflate and unfilter, no dependency), to the same RGBA pixels as `assets/icon.png` (the host re-encodes: 2232 vs 2230 bytes, so the bytes themselves are not compared). The first version decoded both images in the page (canvas), which CI's Chromium refused (`EncodingError: The source image cannot be decoded`, run 46091784105); the model setup page (`/settings/model-setup?firstRun=1`) provider picker lists "OAC / Cursor-CLI, Cursor CLI API key (CURSOR_API_KEY)" and asks the catalog-icon proxy for the manifest icon URL, which is built from package.json `repository` (raw.githubusercontent.com, never loaded). Main: green on 2026.10.3 (4.8 s) and 2026.11.10. Mutation #35 (drop `assets/icon.png` from `files`): red on both ("the row draws no icon image"; the host draws an "OA" letter avatar). Mutation #45 (delete the manifest `icon`): red on both ("the setup page never asked for the API key choice's manifest icon").
  - #36 name. Conditions: the page's Connect provider (2026.11.x: Add account) dialog. Checks: no line reads a bare "Cursor CLI"/"Cursor-CLI", it lists "OAC / Cursor-CLI", and choosing it shows the method "Cursor CLI API key (CURSOR_API_KEY)". Main: green on both (1.5 s). Mutation `PROVIDER_LABEL` = "Cursor CLI": stays green on 2026.10.3, because no checked surface renders it (the dialog shows the manifest `groupLabel`, the card title is the host's rendering of the ID: "Cursor Cli", or "cursor-cli" once the card lists profiles). Mutation manifest `groupLabel` = "Cursor CLI" (the label the UI renders): red on both ("lists the provider under a bare name").
  - #39 card. Conditions: cursor-cli the model at Gateway start (the owner's setup), logged-in fake, a dummy key saved in the browser (Submit, then Continue on the method's note: the profile is saved only then). Checks: the store has `cursor-cli:default` (`models.probe` targets), and within 30 s the card is drawn, does not read "Not configured", and offers Remove key/Sign out. Main: green on 2026.11.10 (12 s); red on 2026.10.3 (47 s) with #106 in the message and evidence (store has the profile, card "Credentials for main / Not configured"). It runs before #98 because #98's plugin hot reload (`config set` of the plugin entry) makes the saved profile show on 2026.10.3. Mutation #39 (`profiles: []`): red on both ("the saved key is not in the auth store"; the dialog still says the key was accepted).
  - #98 refused key. Conditions: a shim with `FAKE_CURSOR_ABOUT=invalid`. Checks: (a) the dialog says "Cursor CLI says the key is invalid. It was not saved" (2026.10.x behind "Could not finish" > Details), not "accepted", after at least one keyed `about`; the card then offers no Remove key (2026.10.x also reads "Not configured"); the store is empty. (b) 2026.10.x only (catalog runs offline): the same refused key in the plugin config: the keyed `about` ran (asserted), `models.list` has no cursor-cli row (asserted `[]`), and once the card's credential line has rendered (polled, no fixed settle) it shows no "N models"; with no cursor-cli model 2026.10.3 may draw no card at all, and then the provider list must have rendered empty ("No model providers configured"), both seen in runs. Main: green on both (53 s on 2026.10.3, 25 s on 2026.11.10). Mutation `probeAuth` accepts any non-empty key: red on 2026.10.3 by (b) ("the card lists cursor-cli models on a key cursor-agent refused"); on 2026.11.10 it is not reachable (no catalog, and the save path checks with `checkKey`). Extra mutation `checkKey` returns valid: red on both by (a).
  - Test connection. Conditions: no default model at Gateway start (`waitForCatalog: false`; the plugin not loaded at start, so the saved key shows at once on 2026.10.3, outside #106); key saved in the browser; then cursor-cli set as the model (the probe picks the agent's model for the provider, else a prepared-catalog row, and without it answers "No models available. Configure a model, then retry."). Checks: the card's `role=status` says "Connected" and names `cursor-cli:default`, and the fake logged exactly one `session/prompt` since the click. Main: green on 2026.10.3 (32 s); skipped on 2026.11.x (models.probe answers `format` offline without the CLI). Mutation stream hook not registered (`register.ts`): red on 2026.10.3 ("Timed out ... The connection timed out", 0 prompts).
  - Remove key. Same Gateway. Click Remove key (2026.11.x: Sign out of API key? then Sign out). Checks: the store is empty and the card lists no key (no Remove key/Sign out, no "Credentials configured"/"Provider profiles"). Main: green on both (14 s, 19 s). No mutation (the plan's row has none).
  - #40/#97 context tile. Conditions: listing with Auto and `grok-4.7[context=256k,...]`, cursor-cli/grok-4.7 the model, turns typed into the chat composer of a fresh `/chat?session=agent:main:explicit:regression-ui-...` with `[[usage:<json>]] say:<marker>` (the Gateway tier's #40/#97 usages, readings up to about 100k). After each reply the session row must first hold that turn's usage (its input and output counts, asserted; so a reading left from the turn before cannot pass), then the tile is read once it agrees with the row (within its rounding) or after 30 s. Checks: a reading after the first plain turn, window 256k, never above it, never below an earlier reading (a missing tile is no reading: the plugin withholds the doubtful one). Main on 2026.10.3: #40 15.3k, none, 15.6k (14 s); #97 15.3k, 100k, none (10 s); skipped on 2026.11.x (no offline catalog: no window, no tile; the file starts no Gateway there). Mutation #40 (ceiling check always passes): red ("turn 2: the tile reads above the 256000 window", tile "5.5M of 256k (100%)"). Mutation #97 (`fellBelowAcceptedHigh` false): red ("turn 3: the tile reads lower", 100k then 15.8k).
- #35/#45 icon, second CI fix (run 46096365233 on 9528a40): on CI's Chromium the body of the page's own icon response comes back empty to Playwright (0 bytes; the page reads it into a blob), so `response.body()` is no longer used: the page's request is still asserted (200 `image/png`), the route is fetched again on its own (`page.request.get`, 200 `image/png`), the drawn blob's bytes must decode to the same pixels as that fetch, the fetch must decode to the same pixels as `assets/icon.png`, and `naturalWidth` must equal the packaged width (256); green on 2026.11.10 (5.0 s; tier run 194 s in all), #35 mutation red on 2026.11.10 ("the row draws no icon image"; fetch 404 `text/plain`).
- `scripts/regression.sh ui`: same setup as `gateway`, then `test/regression/ui`; `npm ci` also runs when `node_modules/playwright` is missing; `OPENCLAW_ALL_CLI_UI_ARTIFACTS` defaults to `.regression/ui-screenshots/<version>` (wiped per run); a folder the caller names is not wiped, only its earlier `*.png`/`*.txt` are removed (review finding 2); `--tgz`/`--result` work the same. `npm run test:regression:ui`.
- CI: `regression.yml` gained input `tier` (`gateway` default, `ui`; dispatch: a choice); the per-version job id is now `tier`, named `<tier> (<label>)`, so the gateway check names are unchanged (`regression / gateway (min = ...)`). The ui job runs `npm ci`, restores `~/.cache/ms-playwright` (key: Playwright version from the installed package), `npx playwright install --with-deps chromium`, saves the cache on a miss. Artifact names carry the tier (`regression-…` for gateway, `regression-ui-…` for ui) so both tiers run in one workflow run without a name clash; a failed ui job also uploads `regression-ui-screenshots-<version>`. `ci.yml` job `regression-ui` calls it with `versions: latest`, `tier: ui` (`contents: read`).
- Ledger: #35, #36, #39, #40, #45, #97, #98 have their ui tests (`tier = "ui"`, `reproduces = true`); `planned = "4.6"` removed from each (none had another ticket).
- Docs: `docs/release.md` (the tier input, the ui job and its artifacts, `regression-ui` on pull requests), `docs/setup.md` (the command), `MEMORY.md` (one entry with the UI facts).
- Observations, not changed: (1) the plugin's quota reader sends a saved dummy key to api2.cursor.sh (Gateway log "Cursor quota: the API key was rejected (... HTTP 401)") in this tier as in the Gateway tier's key cases: Gateway-side network with a dummy key, not the browser, and no secret. (2) The provider card's title is the host's rendering of the provider ID ("Cursor Cli"), not the plugin's label: not checked, not a plugin bug. No new bug: every check is green on main except the known #39 card check on 2026.10.3 (#106).

## Plan Change Log

- #98: the plan's mutation (`probeAuth` accepts any non-empty key) does not reach the Connect provider dialog: a key typed there is checked with `checkKey` (`cursor-agent about`) before it is saved. Added part (b), the same refused key in the plugin config on 2026.10.x (where the catalog's login probe uses `probeAuth`), which that mutation turns red; recorded an extra `checkKey` mutation for part (a).
- #36: `PROVIDER_LABEL` is rendered on no checked Control UI surface; the mutation that proves the row is the manifest `groupLabel` ("the manifest label the UI actually renders", as the plan allows).
- Test connection and Remove key run on a Gateway that starts with no default model, so the saved key shows on the card on 2026.10.3 (with cursor-cli as the model at start it does not: #106, which stays the #39 check's job); cursor-cli becomes the model after the save, because `models.probe` needs a model for the provider.
- #40/#97: 2026.11.x draws no context tile offline (no catalog, no window); the checks skip there by version with that reason and the file starts no Gateway.

## Review Triage Log

Review (quick) of ff60783 plus CI run 46091784105: 6 patched, 1 deferred, 1 rejected, 1 no change.

- Patched (CI, finding 5): #35/#45 failed on CI in `samePixels` (`EncodingError: The source image cannot be decoded` in the page). Now: the drawn `img` `src` is asserted, the icon response is awaited with `page.waitForResponse`, the drawn bytes must equal the served body, and the PNGs are decoded in Node (`png.ts`) and compared as RGBA; in-page decoding removed.
- Patched (finding 1): context tile: before reading the tile, wait until the session row holds this turn's usage (asserted), so `agrees` cannot read the previous turn's value.
- Patched (finding 2): `scripts/regression.sh` wipes only its default screenshot folder; a caller's `OPENCLAW_ALL_CLI_UI_ARTIFACTS` keeps everything but earlier `*.png`/`*.txt`.
- Patched (finding 3): #98 (b) asserts the keyed `about` wait and `models.list` cursor-cli rows `[]`, and polls the card until its credential line has rendered (`readProviderCard(ui, rendered)`) instead of the fixed 2 s settle. Verification found that 2026.10.3 may then draw no card at all ("No model providers configured", PROVIDER ACCESS 0): that rendered empty list is accepted, and `readProviderCard` now returns the page's provider section as `text` when there is no card (it returned only the heading's parent, which lacks the empty-list line).
- Patched (finding 4): `storedProfiles` in provider-card and key-actions asserts `Array.isArray(probed.results)` instead of `?? []`.
- Patched (finding 7): `context.routeWebSocket` closes any WebSocket that does not go to the Gateway (recorded in `blocked`).
- Deferred to 4.10: a CLI-level check that `PROVIDER_LABEL` shows in `openclaw models auth login`; the reviewer confirmed the Control UI renders only the manifest `groupLabel`.
- Rejected: changing #35 `fixed = false` in the ledger: that is the closing state of the issue, not the test's.
- No change: the shared cache key warning (two jobs of one run saving the same OpenClaw cache key; the second save only warns).

## Auto Run Result

- **Summary:** `scripts/regression.sh ui` runs `test/regression/ui/` with Playwright 1.63.0 against the Control UI of a real Gateway with the packed plugin: icon (#35/#45, drawn pixels against the packaged asset), provider name (#36, the manifest `groupLabel` the UI renders), the card after Connect (#39) and with a refused key (#98), Test connection, Remove key, and the chat's context tile (#40/#97); screenshot and page text on every failure; `regression.yml` takes a `tier` input and `ci.yml` runs the UI tier on latest.
- **Review:** 6 patched (medium 3, low 3), 1 deferred to ticket 4.10 (a CLI-level check that `PROVIDER_LABEL` shows in `openclaw models auth login`), 1 rejected (#35 `fixed = false` is the issue's closing state), 1 no change; plus two CI-only fixes of the icon check (in-browser decode error, then an empty captured body on CI's Chromium).
- **Follow-up review recommended:** false (no high finding).
- **Verification:** CI run 46097303388 on a80579e: `regression-ui / ui (latest = 2026.11.10)` green (5 passed, 3 stated skips); local 2026.10.3: 7 passed, #39 red (#106); mutations red per row with screenshots; `npm test` 2113 passed without a browser; typecheck and actionlint clean.
- **Residual risks:** on pull requests the UI tier runs on latest only, where Test connection and the tile skip (no offline catalog), so those run at release (4.7); visible labels may change with a new OpenClaw UI.

## Verification

**Commands:**
- `scripts/regression.sh ui --openclaw latest` -- expected: pass (stated skips allowed)
- `scripts/regression.sh ui` -- expected: pass except the #39 card check (#106)
- `npm test`, `npm run typecheck` -- expected: green

**Results (2026-11-28, this environment):**
- `scripts/regression.sh ui --openclaw latest` (2026.11.10): passed, 5 passed, 3 skipped (Test connection; #40, #97), 166 s in all (tier 142 s).
- `scripts/regression.sh ui` (min, 2026.10.3): 7 passed, 1 failed (#39 card, #106, screenshot `.regression/ui-screenshots/2026.10.3/39-card.png`), 285 s in all (tier 268 s). Checks: #35/#45 4.8 s, #36 1.5 s, #39 47 s, #98 53 s, Test connection 32 s, Remove key 14 s, #40 14 s, #97 10 s.
- Mutations (scratch worktree, removed): m35 red on both, m45 red on both, `PROVIDER_LABEL` green (not rendered), `groupLabel` red on both, m39 red on both, `probeAuth` red on 2026.10.3, `checkKey` red on both, stream hook red on 2026.10.3, #40 and #97 red on 2026.10.3; an unmutated pack built the same way: green.
- `npm test`: 72 files passed, 29 skipped, 2113 tests passed, 80 s; no browser process seen during the run. `npm run typecheck`: green. actionlint 1.7.9 on `.github/workflows/*.yml`: clean (no shellcheck installed here).
- No Gateway, fake, or browser process left after the runs.
- CI only: the `regression-ui / ui (latest = …)` job itself (Playwright's Chromium download and `--with-deps` on ubuntu-latest, the browser cache, the screenshot artifact upload on a red run).

**Results after the review patches (2026-11-28):**
- `scripts/regression.sh ui --openclaw latest` (2026.11.10): passed, 5 passed, 3 skipped, 160 s (tier 138 s).
- `scripts/regression.sh ui` (2026.10.3): only #39 red (#106), 7 passed, 269 s (tier 255 s). Checks: #35/#45 5.2 s, #36 1.6 s, #39 47 s, #98 46 s, Test connection 33 s, Remove key 13 s, #40 15 s, #97 10 s.
- Mutations re-run (scratch worktree, removed): #35 red on both ("the row draws no icon image"); `probeAuth` red on 2026.10.3 ("models.list still lists cursor-cli models on a key cursor-agent refused"); `checkKey` red on both; #40 red ("turn 2: the tile reads above the 256000 window"); #97 red ("turn 3: the tile reads lower"); each saved its screenshot.
- `png.ts`: the served icon (2232 bytes) and `assets/icon.png` (2230 bytes) decode to the same 256x256 RGBA; a flipped byte and a cut file come back undecodable with the reason.
- A caller's `OPENCLAW_ALL_CLI_UI_ARTIFACTS`: only its top-level `*.png`/`*.txt` were removed (other files and subfolders kept).
- `npm test` green (2113 tests, 74 s), `npm run typecheck` green, actionlint clean; no Gateway, fake, or browser process left.
- CI only: the icon check on CI's Playwright Chromium (the failure that started this round).

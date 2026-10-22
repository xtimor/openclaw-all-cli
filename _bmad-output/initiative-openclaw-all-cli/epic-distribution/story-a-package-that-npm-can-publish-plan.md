---
title: 'A package that npm can publish'
type: 'feature'
ticket: '3'
created: '2026-10-22'
status: 'built'
baseline_revision: '01cf1f67b862722f20241b43456ee4bada2b7c5c'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `package.json` is `private`, has no repository metadata, and ships `src/` and `docs/`; npm cannot publish it, and the npm page would show a README written for building from source.

**Approach:** Make `openclaw-all-cli` (unscoped, decided by the owner) publishable: drop `private`; add `repository`, `homepage`, `bugs`, `keywords`, `publishConfig` (`access: public`, `provenance: true`); ship only `dist/`, `openclaw.plugin.json`, `README.md`, `LICENSE` (npm adds `package.json`); keep the `openclaw` compat block. The version in git stays `0.0.0`; the release workflow (ticket 3.4) sets it from the `vX.Y.Z` tag, so the tag is the single source; document that. A unit test pins the packed file list to an allowlist. The README is rewritten for the npm page. The packed tarball installs and runs a real turn in the isolated OpenClaw.

## Boundaries & Constraints

**Always:** the allowlist test fails when any packed path is outside the allowlist, and when `dist/` exists it requires `dist/plugin.js` and `dist/provider-discovery.js`; README links use absolute `https://github.com/xtimor/openclaw-all-cli/...` URLs (docs are not shipped); keep `openclaw.extensions` (`./src/plugin.ts`, pinned by `test/backend.test.ts`) and `runtimeExtensions`; `scripts/ci-check.sh` runs the allowlist test once more after its build step, so CI checks the real `dist/` contents.

**Never:** publish, tag, or add a release workflow (3.4); add an npm credential; rewrite `docs/setup.md` install steps (3.5); change `src/`; ship source maps, tests, `src/`, `docs/`, `scripts/`, `_bmad*`, or `.spike`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | built `dist/`, `npm pack --dry-run --json` | only allowlisted paths; both entry files present | No error expected |
| NO_DIST | unit tests before a build (CI order) | allowlist still enforced; dist entry check skipped | No error expected |
| EXTRA_FILE | a path outside the allowlist would ship (e.g. `docs` added to `files`) | test fails naming the path | assertion message lists the path |

</intent-contract>

## Code Map

- `package.json` -- edit metadata as in Intent. `repository: {type: "git", url: "git+https://github.com/xtimor/openclaw-all-cli.git"}`, `homepage: "https://github.com/xtimor/openclaw-all-cli#readme"`, `bugs: {url: "https://github.com/xtimor/openclaw-all-cli/issues"}`, keywords e.g. `openclaw`, `openclaw-plugin`, `cursor`, `cursor-agent`, `acp`, `cli`, `llm`. `files: ["dist", "openclaw.plugin.json"]` (README and LICENSE are always packed). `tsconfig.build.json` already emits no maps or declarations.
- `test/package-contents.test.ts` -- new. Run `npm pack --dry-run --json --ignore-scripts` with `spawnSync` (`cwd` repo root), parse `[0].files[].path`. Allowlist: `package.json`, `README.md`, `LICENSE`, `openclaw.plugin.json`, `dist/**/*.js`. Note: the probe on 2026-10-22 showed a dist-only tarball installs and loads (`plugins inspect`: `loaded`, `cursor-cli`) in a throwaway state.
- `scripts/ci-check.sh` -- after `npm run build`, run `npx vitest run test/package-contents.test.ts` (step line `==> Package allowlist (with dist)`).
- `README.md` -- for the npm page: what it is, requirements (OpenClaw 2026.10.3+, Node 24, `cursor-agent` signed in), install `openclaw plugins install openclaw-all-cli`, minimal config pointer, status (early release, Cursor only), links to Setup and Cursor provider docs on GitHub, criteria and references kept short, license.
- `docs/setup.md` -- in `## Develop`, a short `### Versions` note: the version in git is `0.0.0`; a release sets it from the tag `vX.Y.Z` (see the release ticket); do not bump it by hand.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` -- metadata, `files`, `publishConfig`, no `private`
- [ ] `test/package-contents.test.ts` -- allowlist test per the matrix
- [ ] `scripts/ci-check.sh` -- allowlist test after build
- [ ] `README.md` -- npm-page README
- [ ] `docs/setup.md` -- Versions note

**Acceptance Criteria:**
- Given a build, when `npm pack --dry-run` runs, then it lists exactly `package.json`, `README.md`, `LICENSE`, `openclaw.plugin.json`, and `dist/**/*.js`.
- Given `docs` added to `files`, when the allowlist test runs, then it fails naming a `docs/` path (revert after).
- Given the packed tarball installed with `npm run dev:install`, when `npm run dev:openclaw -- agent --local --model cursor-cli/auto --message "Reply with the word ok"` runs with `CURSOR_API_KEY` in the environment, then the reply arrives from Cursor (record as not run if Cursor is unreachable).
- Given `npm run ci`, then it exits 0.

## Implementation Notes

Implemented by a sonnet subagent, read by the orchestrator. `package.json` (no `private`, metadata, `files: ["dist", "openclaw.plugin.json"]`, `publishConfig`), `test/package-contents.test.ts`, `scripts/ci-check.sh` allowlist step after build, `README.md` for npm, `docs/setup.md` `### Versions` (also the allowlist step named in Checks (CI)). Packed: 47 files, `dist/**/*.js` plus the four fixed files. `docs` in `files` made the test fail naming `docs/providers/cursor.md, docs/setup.md` (reverted). `npm run ci` exit 0. Live: `dev:install` then `agent --local --model cursor-cli/auto` replied `ok` from Cursor (25.8 s). `openclaw.extensions` names `./src/plugin.ts`, not in the tarball; the host loads `runtimeExtensions` (smoke and live turn).

## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 5 findings — high 0, medium 3, low 2, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` README tells readers to install from npm while `docs/setup.md` says no package exists, and no version is published yet — README Status now says to build from source until the first version is on npm; the setup banner says "until the first version is on npm".
  - `[medium]` `[patch]` README install lacks `--accept-capabilities` and the ClawHub-review prompt every other path documents — added the flag and the `--force` / restart sentence.
  - `[medium]` `[patch]` README Requirements steers to exporting `CURSOR_API_KEY`, which setup ranks last for exec exposure — now login first, key via `cursor-cli.env`, link to The API key.
  - `[low]` `[patch]` `ci-check.sh` header omits the allowlist step — added.
  - `[low]` `[patch]` allowlist accepts compiled tests (`*.test.js`) — excluded; a `dist/x.test.js` made the test fail naming it.

## Auto Run Result

- Summary: `openclaw-all-cli` is publishable: no `private`, repository/homepage/bugs/keywords, `publishConfig` public with provenance, tarball limited to `dist/**/*.js`, manifest, README, LICENSE, `package.json`; the tag is the version's single source (git keeps `0.0.0`); README written for the npm page.
- Files: `package.json`, `test/package-contents.test.ts` (new), `scripts/ci-check.sh` (allowlist step), `README.md`, `docs/setup.md` (Versions note, status banner, CI checks).
- Review: 5 patched (3 medium, 2 low), 0 deferred, 0 rejected.
- Follow-up review recommended: false (all patches are doc wording and one test predicate; no high, and the three mediums are text-only fixes checked by reading).
- Verification: `npm run ci` exit 0 after patches (923 unit tests, allowlist 3/3 with dist, smoke `loaded`/`cursor-cli`); extra-file mutations (`docs` in `files`, `dist/x.test.js`) fail the test; live turn from the packed tarball replied `ok` from Cursor.
- Residual risk: `openclaw plugins install openclaw-all-cli` from npm is unproven until 3.4 publishes and 3.5 checks it.

## Verification

**Commands:**
- `npm run typecheck && npx vitest run test/package-contents.test.ts test/backend.test.ts` -- expected: pass
- `npm run ci` -- expected: exit 0
- `npm run dev:install && npm run dev:openclaw -- agent --local --model cursor-cli/auto --message "Reply with the word ok"` -- expected: a Cursor reply

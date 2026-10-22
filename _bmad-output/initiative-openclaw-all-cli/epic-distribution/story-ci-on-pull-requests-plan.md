---
title: 'CI on pull requests'
type: 'feature'
ticket: '2'
created: '2026-10-22'
status: 'in-progress'
baseline_revision: 'd5e8eec4fe1ceecf0587045e23c3ab272e9d4163'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The repo has no CI: a pull request can break the types, the unit tests, the build, or the package, and nobody sees it until a person runs the checks by hand.

**Approach:** One agent-neutral script, `scripts/ci-check.sh` (`npm run ci`), runs every check a contributor runs locally: isolated Node 24 and OpenClaw 2026.10.3 in `.spike/`, `npm ci`, typecheck, `npm test`, build, `npm pack --dry-run`, and an install smoke check of the packed tarball into a throwaway OpenClaw state. A GitHub Actions workflow runs that script on pull requests and pushes to `main`, with pinned actions, npm cache, and no secret. Live tests stay out. The commands are documented in `docs/setup.md`.

## Boundaries & Constraints

**Always:** the workflow only calls `scripts/ci-check.sh` (logic lives in the script, not YAML); actions pinned by full commit SHA with the tag in a comment; `permissions: contents: read`; no `secrets.*` reference; the smoke check uses a fresh temp state dir and config path (never `.spike/state`, never `~/.openclaw`) and removes it on exit; the script fails on the first failing check (`set -euo pipefail`).

**Never:** run `npm run test:live` or set `OPENCLAW_ALL_CLI_LIVE`; install `cursor-agent`; change `src/`; change `package.json` fields other than adding the `ci` script (publishing fields are ticket 3.3); add a tag or release trigger (ticket 3.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | clean checkout, `npm run ci` | every step passes, smoke shows plugin `loaded` with backend `cursor-cli`, exit 0 | No error expected |
| TYPE_ERROR | a deliberate type error in `src/` | script stops at typecheck, exit non-zero | step name printed before it runs |
| SMOKE_FAIL | packed plugin does not load | `plugins inspect` status not `loaded` or `cursor-cli` missing: exit non-zero with the report | temp state removed by trap |

</intent-contract>

## Code Map

- `scripts/dev-openclaw.sh` -- reuse `setup` (installs `.spike/node` 24.22.0 and `.spike/openclaw` 2026.10.3, idempotent); its `run` uses `.spike/state`, so the smoke check must not use `run`: call `.spike/openclaw/node_modules/.bin/openclaw` directly with `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` set to a `mktemp -d`, and `.spike/node/bin` first on `PATH`.
- `scripts/dev-setup.sh` -- pattern: `npm ci` runs with `PATH="$ROOT/.spike/node/bin:$PATH"`.
- `tsconfig.json` -- `paths` maps `openclaw/plugin-sdk/*` to `.spike/openclaw/...`: typecheck and build need `setup` first.
- `test/isolated-openclaw.test.ts` -- the existing smoke assertion to mirror: `plugins inspect openclaw-all-cli --runtime --json` → `plugin.status === "loaded"`, `plugin.cliBackendIds` contains `cursor-cli`. Install command as in `dev-openclaw.sh install`: `plugins install --force --accept-capabilities <tgz>`.
- `package.json` -- add `"ci": "scripts/ci-check.sh"` only.
- `.github/workflows/ci.yml` -- new. Triggers: `pull_request`, `push` to `main`, `workflow_dispatch`. `concurrency` per ref with cancel-in-progress. `ubuntu-latest`, `timeout-minutes: 30`. Steps: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`; `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` with `node-version: 24.22.0`, `cache: npm`; `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0` for `.spike/node` and `.spike/openclaw`, key from OS + the two versions; run `scripts/ci-check.sh`.
- `docs/setup.md` -- section `## Develop`: add a short `### Checks (CI)` naming `npm run ci`, what it runs, that GitHub runs the same on every pull request and push to `main`, and that live tests are not part of it.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/ci-check.sh` -- new, executable; prints `==> <step>` before each step; steps as in Intent; `npm pack --dry-run` then a real `npm pack --pack-destination <tmp>` for the smoke; smoke parses the inspect JSON with `node -e` -- one source for local and CI
- [ ] `package.json` -- add the `ci` script
- [ ] `.github/workflows/ci.yml` -- as in Code Map
- [ ] `docs/setup.md` -- the Checks (CI) subsection

**Acceptance Criteria:**
- Given a clean checkout on this host, when `npm run ci` runs, then it exits 0 and prints the smoke result for `cursor-cli`, and `.spike/state` and `~/.openclaw` are unchanged.
- Given a deliberate type error in a `src/` file, when `npm run ci` runs, then it exits non-zero at the typecheck step (revert the error after).
- Given the workflow file, when read, then every `uses:` is pinned by a 40-hex SHA, no `secrets.` appears, and the only `run:` is the script.
- Given a pull request on GitHub, when the workflow runs, then it is green (verified after a PR exists; record as not run if none).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `bash -n scripts/ci-check.sh && npm run ci` -- expected: exit 0, smoke reports `loaded` and `cursor-cli`
- add `const x: number = "x";` to `src/plugin.ts`, `npm run ci` -- expected: non-zero at typecheck; then `git checkout src/plugin.ts`
- `grep -n "uses:\|secrets\.\|run:" .github/workflows/ci.yml` -- expected: SHA pins, no secrets, one run step

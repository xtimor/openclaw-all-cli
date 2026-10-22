---
title: 'CI on pull requests'
type: 'feature'
ticket: '2'
created: '2026-10-22'
status: done
baseline_revision: 'd5e8eec4fe1ceecf0587045e23c3ab272e9d4163'
route: 'full'
route_source: 'auto'
risk: 'low'
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

Implemented by a sonnet subagent, checked by the orchestrator. `scripts/ci-check.sh`, `npm run ci`, `.github/workflows/ci.yml` (workflow-level `env` `NODE_VERSION`/`OPENCLAW_VERSION`, read by `dev-openclaw.sh`, equal to its defaults), `docs/setup.md` `### Checks (CI)`. Action SHAs from `git ls-remote` (lightweight tags, so commit SHAs). Local `npm run ci`: exit 0, 920 unit tests, smoke `status=loaded cliBackendIds=["cursor-cli"]`, `.spike/state` checksums unchanged, temp dir removed. A type error in `src/plugin.ts` stopped at Typecheck (exit 1, reverted). GitHub run: not run yet (no pull request).

## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 4 findings — high 0, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` a non-zero `plugins inspect` stops the script before the report is printed — confirmed: inspect exits 1 when the plugin is missing; now `|| true`, the node check prints the report and fails.
  - `[low]` `[patch]` workflow comment says ci-check.sh reads the version variables — reworded: dev-openclaw.sh reads them.
  - `[medium]` `[patch]` `cancel-in-progress: true` lets a second push to `main` cancel the first run, so a main commit can go without a result — now cancels only for `pull_request` events.
  - `[low]` `[reject]` Execution checkboxes unticked — the fix edits this build's plan (rule: reject).

## Auto Run Result

- Summary: `scripts/ci-check.sh` (`npm run ci`) runs every PR check (isolated Node 24 and OpenClaw 2026.10.3, `npm ci`, typecheck, unit tests, build, `npm pack --dry-run`, install smoke into a throwaway state); `.github/workflows/ci.yml` runs it on pull requests, pushes to `main`, and by hand, pinned actions, no secrets.
- Files: `scripts/ci-check.sh` (new), `.github/workflows/ci.yml` (new), `package.json` (`ci` script), `docs/setup.md` (Checks (CI)).
- Review: 3 patched (1 medium, 2 low), 0 deferred, 1 rejected (plan edit).
- Follow-up review recommended: false.
- Verification: `npm run ci` exit 0 before and after the patches (920 unit tests, smoke `loaded` / `cursor-cli`); type error stops at Typecheck; workflow parses, SHAs match tags. Not run: the workflow on GitHub (needs a pull request; the ticket stays open until a PR shows it green and a type error red).
- GitHub (PR xtimor/openclaw-all-cli#1): run 39761055303 green in 74 s on d0c8b02; run 39761273380 on the deliberate type error 230b047 failed at Typecheck (`src/plugin.ts(14,7): error TS2322`, exit 1); the error was reverted in the next commit. `.spike` cache restored (~191 MB).
- Residual risk: none known.

## Verification

**Commands:**
- `bash -n scripts/ci-check.sh && npm run ci` -- expected: exit 0, smoke reports `loaded` and `cursor-cli`
- add `const x: number = "x";` to `src/plugin.ts`, `npm run ci` -- expected: non-zero at typecheck; then `git checkout src/plugin.ts`
- `grep -n "uses:\|secrets\.\|run:" .github/workflows/ci.yml` -- expected: SHA pins, no secrets, one run step

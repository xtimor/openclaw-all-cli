---
title: 'Each release also publishes to ClawHub'
type: 'feature'
ticket: '31'
created: '2026-11-11'
status: 'built'
baseline_revision: '5535f6f0916f6c69b4ec6eee7adeeb2d71ad8e6d'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Releases reach npm and GitHub only. The owner wants the plugin on ClawHub too (change publish-on-clawhub), and has added the `CLAWHUB_TOKEN` repository secret (2026-11-11).

**Approach:** `scripts/release.sh` publishes the same `.tgz` to ClawHub in the same run, with the `clawhub` CLI pinned to an exact version (`CLAWHUB_VERSION`, the same as `ci.yml`). ClawHub's reusable `package-publish.yml` is not used: its validate step runs under Bun and fails for every code plugin (ticket 30). The first publish uses the token; after it the script sets the trusted publisher, and later runs publish through OIDC with no token.

## Boundaries & Constraints

**Always:** ClawHub gets the exact tarball npm got (same sha256). ClawHub runs only after the npm publish and the GitHub release succeeded, so a ClawHub failure never leaves npm and the tag out of step; it fails the run, writes the summary first, and undoes nothing. The ClawHub token reaches only the `clawhub` commands (never the checks, the changelog step, or the CLI's install), through a config file mode 600 in the script's work dir. Prerelease → ClawHub tag `next`, stable → `latest`. Wait for publication (`--wait`, default deadline).

**Never:** `npm unpublish` or any ClawHub delete; a ClawHub publish on a dry run, on a staged (first npm) release, or on a pull request; printing the token.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dry run | `DRY_RUN=true` | runs `clawhub package publish <tgz> --family code-plugin --dry-run --json ...` (local) and prints the real command; no registry call | dry-run failure fails the run |
| Real, token set | npm publish ok | GitHub release, then `clawhub package publish <tgz> --family code-plugin --wait --json --tags latest --source-repo/commit/ref --manual-override-reason ...` with the token config; then `trusted-publisher set openclaw-all-cli --repository <repo> --workflow-filename release.yml`; summary: npm version, ClawHub `name@version` and status, one sha256 | trusted-publisher failure: warning in log and summary with the manual command, run stays green |
| Real, no token | npm publish ok | same publish without config or override reason (CLI uses OIDC) | |
| ClawHub refuses / blocked / times out | CLI exits non-zero | summary says npm and GitHub release are done, ClawHub failed, with the CLI's last error and the recovery pointer (docs/release.md); exit 1 | |
| ClawHub sha256 differs | JSON `artifactSha256` ≠ tarball sha256 | fail as above | |
| Prerelease | `v1.2.3-rc.1` | `--tags next` | |
| First npm release (stage) | package not on npm | ClawHub skipped; summary says so | |

</frozen-after-approval>

## Code Map

- `scripts/release.sh` -- add after "GitHub release": a ClawHub section; dry-run branch next to `npm publish --dry-run`; hide `CLAWHUB_TOKEN` at the top like `NODE_AUTH_TOKEN` (`STAGE_TOKEN` pattern); summary lines. `TARBALL` is absolute (`$OUT`), required: the CLI reads a relative `dir/x.tgz` as a GitHub repo.
- CLI invocation: default installs `clawhub@$CLAWHUB_VERSION` with `npm install --ignore-scripts --no-audit --no-fund --prefix "$WORK/clawhub"` under `env -u` of every credential, then runs `node "$WORK/clawhub/node_modules/clawhub/bin/clawdhub.js"`. Test hook `RELEASE_CLAWHUB` (a command, like `RELEASE_STAGE_NPM`) skips the install. `CLAWHUB_VERSION` defaults to `0.25.1` in the script.
- clawhub 0.25.1 facts: config `{"registry":"https://clawhub.ai","token":"..."}` via env `CLAWHUB_CONFIG_PATH`; publish `--json` prints `{name, version, status, publicationStatus, artifactSha256, attemptId, ...}`; `--wait` fails on blocked/failed/expired; without `--manual-override-reason` and with `ACTIONS_ID_TOKEN_REQUEST_*` it tries OIDC and falls back to the config token; `--manual-override-reason` is required for a token publish once a trusted publisher exists; `--source-repo/--source-commit` are required for code plugins.
- `.github/workflows/release.yml` -- env `CLAWHUB_VERSION: 0.25.1`; step env `CLAWHUB_TOKEN: ${{ secrets.CLAWHUB_TOKEN }}`; `id-token: write` already set.
- `test/release-script.test.ts` -- stub `clawhub` logging args and `CLAWHUB_CONFIG_PATH` content; `STUB_CLAWHUB_*` env for fail/blocked/sha mismatch/trusted-publisher failure; one test per matrix row plus: token absent from checks, notes, and log output; ClawHub call after `gh release create`.
- `test/clawhub-package.test.ts` -- `CLAWHUB_VERSION` equal in `ci.yml`, `release.yml`, and the script default.
- `docs/release.md` -- section "ClawHub": what a release does, first publish with `CLAWHUB_TOKEN`, trusted publisher (auto-set, then delete the secret), blocked review and `clawhub package recover`, rollback (no delete of latest; release a fix). Steps list item 7 mentions ClawHub.
- `MEMORY.md` -- the ClawHub line gains the release facts.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/release.sh` -- ClawHub publish, dry run, token isolation, summary -- the feature
- [x] `.github/workflows/release.yml` -- version and secret wiring
- [x] `test/release-script.test.ts`, `test/clawhub-package.test.ts` -- matrix rows, pin
- [x] `docs/release.md`, `MEMORY.md` -- docs and facts

**Acceptance Criteria:**
- Given any release run, when its summary is read, then it names the npm version, the ClawHub result, and one sha256.
- Given `npm run ci`, then it passes.

## Implementation Notes

Planned by the main session (2026-11-11); owner pre-approved building 31 and 32 (chat, 2026-11-11: build 31 and 32 after 30; the `CLAWHUB_TOKEN` secret is set), so Checkpoint 1 is taken as approved.

Built 2026-11-11. CLI facts confirmed by reading the `clawhub@0.25.1` npm tarball (not run: the cloud sandbox refuses it). Tactical choices: `--source-ref refs/tags/<tag>` on real runs (the GitHub release has just created the tag), `GITHUB_REF` on a dry run; `--source-commit` = the release commit (`git rev-parse HEAD`, as `gh release create --target`), `GITHUB_SHA` on a dry run; `CLAWHUB_CONFIG_PATH` always points into the work dir (no file without a token), so a local run never reads a user's own ClawHub login; a result whose `publicationStatus` is not `published` fails; a missing `artifactSha256` (optional in ClawHub's answer) passes with a `clawhub package verify` hint, only a differing one fails; a token publish runs without the OIDC variables; the token is trimmed of surrounding whitespace; `release.yml` job timeout 45 -> 120 min to cover the CLI's upload retries (~30 min) and its 30-minute `--wait` deadline after the checks, so the summary is always written. Review fixes applied 2026-11-11 (OIDC on the token path, timeout, optional sha, summary duplication, token trim, comment, gh-failure test). No CHANGELOG line (ticket 32 adds the user-facing one).

## Review Triage Log

Quick review, pass 1 (8 findings: 0 high, 3 medium, 4 low, 1 rejected):

- medium, patch: a token publish kept `ACTIONS_ID_TOKEN_REQUEST_*` in the CLI's env although `--manual-override-reason` makes clawhub 0.25.1 use only the config token (`resolvePackagePublishToken`); the CLI and its unlocked dependencies got the OIDC request token for nothing. Now `--no-oidc` whenever a token is set.
- medium, patch: job timeout 75 min did not cover the CLI's upload retries (5 x 5 min) plus the 30-minute `--wait`; a killed job writes no summary. Raised to 120.
- medium, patch: `artifactSha256` is optional in the publish-attempt response, so a published package with no reported sha failed as a mismatch with the wrong recovery text. Missing sha is now a note with a manual check; only a reported, different sha fails.
- low, patch: the failure reason appeared twice in the summary and twice in the log. Once each now.
- low, patch: a pasted token with a trailing newline made invalid JSON and a misleading "Not logged in". The secret is trimmed.
- low, patch: stale comment naming `clawhub_config`.
- low, patch: "npm or GitHub release failure stops before ClawHub" tested only npm; the `gh` stub gains a failure switch.
- rejected (fix edits this plan): a Russian quote in Implementation Notes broke the English-only rule; translated by the main session while finalizing.

## Verification

**Commands:**
- `npx vitest run test/release-script.test.ts test/clawhub-package.test.ts` -- expected: pass
- `bash -n scripts/release.sh` and `npm test` -- expected: pass
- Live (after merge, on the owner's release): the run publishes to ClawHub, summary shows the same sha256; the next release uses OIDC.

---
title: 'Release workflow: tag to npmjs.com'
type: 'feature'
ticket: '4'
created: '2026-10-22'
status: 'built'
baseline_revision: '3ea03129ca1cfdc25baaf4d06cf31b70bcd28351'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing publishes the package: a release is a manual build on someone's machine, with no provenance and no GitHub release.

**Approach:** Pushing a tag `vX.Y.Z` runs a GitHub Actions release: it sets the version from the tag, runs the same checks as CI (`scripts/ci-check.sh`), packs once, publishes that tarball to npmjs.com with provenance, and creates a GitHub release with the same `.tgz` and generated notes. Publishing is fully automatic through npm trusted publishing (OIDC). npm can set a trust only on an existing package, so while `openclaw-all-cli` is not on npm the workflow stages the tarball (`npm stage publish`) with the `NPM_TOKEN` secret (stage-only, no 2FA bypass) and the owner approves it once with 2FA; after that the owner runs `npm trust github ... --allow-publish` and deletes the token (owner's decision, 2026-10-22). A dry-run mode runs everything and stops before publish. `docs/release.md` covers cutting a release, the first-release steps, rollback (deprecate, never unpublish), and rotating the credential.

## Boundaries & Constraints

**Always:** logic in an agent-neutral script `scripts/release.sh`, YAML only wires triggers, permissions, and secrets; actions pinned by SHA (same as `ci.yml`); `permissions: contents: write` (release) and `id-token: write` (OIDC, provenance) only on the release job; the tarball published and the one attached are the same file, and its sha256 is printed and written into the release notes; a real release requires the tag's commit to be on `origin/main`; tag must be `vMAJOR.MINOR.PATCH` with an optional prerelease (`-rc.1`), and a prerelease publishes under dist-tag `next`; refuse a version already on npm; the token is used only for `npm stage publish`.

**Never:** `npm unpublish`; a token with publish rights or 2FA bypass; print a secret; push commits or move tags from CI; publish on a pull request or branch push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DRY_RUN | `workflow_dispatch` with `dry_run: true` (default), or a tag `v*-dryrun.*` | checks, pack, `npm publish --dry-run`, sha256 printed; no publish, no release | No error expected |
| FIRST_RELEASE | tag on main, package not on npm | `npm stage publish <tgz> --provenance` with `NPM_TOKEN`; release created; summary tells the owner to approve and then set the trust | missing `NPM_TOKEN`: fail before staging with a message naming the secret |
| NEXT_RELEASE | tag on main, package on npm | `npm publish <tgz> --provenance` via OIDC, no token; release created | npm rejects OIDC (no trust yet): fail with a pointer to `docs/release.md` |
| BAD_TAG | `v1.2`, `1.2.3`, or commit not on main | fail before checks | message names the rule |
| VERSION_EXISTS | `vX.Y.Z` already on npm (or staged) | fail before publish | message names the version |

</frozen-after-approval>

## Code Map

- `scripts/ci-check.sh` -- reuse as is for the checks; it builds `dist/` and leaves `.spike/node/bin` on `PATH` only inside itself, so `release.sh` sets its own `PATH`.
- `scripts/release.sh` -- new. Inputs from env: `RELEASE_TAG` (`GITHUB_REF_NAME` on a tag push, the dispatch input otherwise), `DRY_RUN` (`true`/`false`), `NODE_AUTH_TOKEN` (only for staging). Steps: validate tag; on a real release `git merge-base --is-ancestor HEAD origin/main` (checkout with `fetch-depth: 0`); `npm version "$V" --no-git-tag-version --allow-same-version`; `scripts/ci-check.sh`; `npm pack --pack-destination out/`; sha256; `npm view openclaw-all-cli@$V version` (exists → fail) and `npm view openclaw-all-cli name` (404 → first release); publish or stage or dry-run; `gh release create "$TAG" out/*.tgz --generate-notes --notes "sha256: ..."` (`--prerelease` for a prerelease); write `GITHUB_STEP_SUMMARY` when set. The isolated npm is 11.19.1 (`.spike/node`), which has `npm stage` and `npm trust`; OIDC needs `registry-url` from setup-node.
- `.github/workflows/release.yml` -- new. `on: push: tags: ['v*']` and `workflow_dispatch` (inputs `tag`, `dry_run` default true). One job, `ubuntu-latest`, `concurrency: release` (no cancel), steps: checkout (`fetch-depth: 0`), setup-node (24.22.0, `registry-url: https://registry.npmjs.org`), cache `.spike`, `scripts/release.sh` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` and `GH_TOKEN: ${{ github.token }}`.
- `package.json` -- `version` stays `0.0.0` in git (3.3); `publishConfig.provenance: true` already set.
- `docs/release.md` -- new: cut a release (tag on main, push); dry run; first release (stage, approve on npmjs.com or `npm stage approve <id>`, then `npm trust github openclaw-all-cli --file release.yml --repo xtimor/openclaw-all-cli --allow-publish`, delete the token and the secret, set package access to "require 2FA and disallow tokens"); rollback (`npm deprecate openclaw-all-cli@X.Y.Z "<reason>"`, release a fixed patch; never unpublish); rotate the credential (trust: `npm trust list/revoke`; token while it exists). Link it from `README.md` Docs and `docs/setup.md` Develop.
- `MEMORY.md` -- add the release facts learned (stage needs no 2FA, trust needs an existing package).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/release.sh` -- the matrix above
- [ ] `test/release-script.test.ts` -- run `release.sh` with stub `npm`, `gh`, `git`, and `scripts/ci-check.sh` replaced via env (`RELEASE_CI_CHECK`, `PATH` stubs) to cover every matrix row
- [ ] `.github/workflows/release.yml` -- as in Code Map
- [ ] `docs/release.md`, `README.md`, `docs/setup.md`, `MEMORY.md` -- as in Code Map

**Acceptance Criteria:**
- Given the stub tests, when `npm test` runs, then every matrix row passes, and a real-release path never calls `npm publish` without `--provenance`.
- Given a throwaway tag `v0.0.1-dryrun.1` pushed to GitHub, when the workflow runs, then every step is green, the summary shows the sha256, and npm and the releases page are unchanged (needs the workflow on GitHub; record as not run if the tag cannot be pushed).
- Given the first real tag on main, when the workflow runs, then the version is staged, and after the owner's approval `npm view openclaw-all-cli dist.shasum` matches the attached tarball (owner step; recorded after it happens).

## Implementation Notes

Implemented by a sonnet subagent. `scripts/release.sh`, `.github/workflows/release.yml`, `test/release-script.test.ts` (31 tests, stub npm/gh/git/check), `docs/release.md`, links from `README.md` and `docs/setup.md`, `MEMORY.md`, `.gitignore` (`out/`). Beyond the plan: a real release also requires HEAD to be the tag's commit; only a 404 from `npm view` counts as "free". The real token is visible only to `npm stage publish`; other commands see setup-node's placeholder. A staged-but-unapproved version is not visible to `npm view`; the registry's unique-version rule rejects a repeat stage. npm docs (`npm-stage.md`): "Staged publishing will allow you to create a new package if it does not exist." Local: `npm run ci` 954 tests; `RELEASE_TAG=v0.0.1-dryrun.1 DRY_RUN=true scripts/release.sh` end to end with real `npm publish --dry-run`; removing `--provenance` failed 3 tests.

## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 6 findings — high 1, medium 2, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` a staged-but-unapproved version is not caught before publish (matrix "or staged") — the registry's unique-version rule rejects the repeat stage/publish, so nothing wrong ships; catching it earlier needs an authenticated `npm stage list` call (new branch and credential use), more than a direct fix.
  - `[high]` `[patch]` first release stages with npm 11.19.1, whose `npm-stage.md` lists "package must exist", so the only first-release path could fail — confirmed the two docs disagree (npm 12.2.1: "will allow you to create a new package"); staging now runs `npm exec --package=npm@12.2.1 -- npm stage publish`, and `docs/release.md` adds a manual 2FA fallback.
  - `[medium]` `[patch]` an explicit `--tag latest` disables npm's guard against moving `latest` backwards (`publish.js` `isDefaultTag`) — stable versions now pass no `--tag`; test added, a mutation back to `--tag latest` fails 3 tests.
  - `[medium]` `[patch]` `GH_TOKEN` and the OIDC request token reach `ci-check.sh` (npm ci scripts, tests, plugin install) — the checks run under `env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL`; test added, removing it fails the test.
  - `[low]` `[reject]` AC2/AC3 status not recorded in the plan — the fix edits this build's plan (rule); recorded under Auto Run Result after the GitHub dry run.
  - `[low]` `[patch]` `workflow_dispatch` with `dry_run: false` fails unless started on the tag, undocumented — input description and `docs/release.md` now say so; docs also say `Run workflow` exists only once the file is on `main`.

## Auto Run Result

- Summary: a `vX.Y.Z` tag runs `.github/workflows/release.yml` → `scripts/release.sh`: tag and main checks, refuse an existing version, version from the tag, the CI checks without job credentials, one tarball with sha256, then stage (first release, npm 12.2.1, `NPM_TOKEN`), publish via OIDC with provenance (later releases), or `npm publish --dry-run`; GitHub release with the same `.tgz`. `docs/release.md` covers cutting, dry run, first release (approve, `npm trust`, delete token, manual fallback), rollback, rotation.
- Review: 4 patched (1 high, 2 medium, 1 low), 2 rejected, 0 deferred.
- Verification: 33 release-script tests (mutations on `--provenance`, `env -u`, and `--tag latest` each fail them); `npm run ci` green; a full local `RELEASE_TAG=v0.0.1-dryrun.1 DRY_RUN=true scripts/release.sh` ran the checks, packed, printed the sha256, ran `npm publish --dry-run`, restored `package.json`; CI green on PR #1.
- Not run: AC2, the dry-run tag on GitHub: this session cannot push tags (the git proxy drops tag pushes), so the owner pushes `v0.0.1-dryrun.1` (or uses `Run workflow` after merge). AC3, the first real release and the owner's approval, follows the merge.
- Residual risk: staging a package npm has never seen and OIDC publish are proven only by the first real run; docs/release.md has the manual fallback.

## Verification

**Commands:**
- `bash -n scripts/release.sh && npx vitest run test/release-script.test.ts` -- expected: pass
- `npm run ci` -- expected: exit 0
- `python3 -c "import yaml;yaml.safe_load(open('.github/workflows/release.yml'))"` and `grep -n "uses:" .github/workflows/release.yml` -- expected: parses, SHA pins

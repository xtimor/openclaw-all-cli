---
title: 'A package ClawHub accepts, checked on every pull request'
type: 'feature'
ticket: '30'
created: '2026-11-11'
status: 'built'
baseline_revision: '307d44d70b8022193f171fd281fd58db3f039948'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The owner wants the plugin on ClawHub (change publish-on-clawhub, 2026-11-11). ClawHub rejects a code plugin without `package.json` `openclaw.build.openclawVersion`, which we lack, and nothing checks our tarball against ClawHub before a release.

**Approach:** Add the missing metadata (`openclaw.build.openclawVersion` = the OpenClaw version CI tests against, one manifest category), pin them with unit tests, and add a CI job that hands the packed `.tgz` to ClawHub's own reusable `package-publish.yml` (pinned by SHA) with `dry_run: true`, which runs `clawhub package validate` and `clawhub package publish --dry-run`. No secret, no real publish.

</frozen-after-approval>

## Implementation Notes

Oneshot: under 100 changed lines across `package.json`, `openclaw.plugin.json`, one test file, `ci.yml`, `scripts/ci-check.sh` (comment), MEMORY.md, `docs/setup.md`.

Investigation (2026-11-11, `openclaw/clawhub` main `9df44b87850c142bee56db44d86417be0c0f0efd`, `clawhub` CLI 0.25.1):

- Category: `models` ("providing inference backends ... the selected backend may execute the request"), from `packages/schema/src/catalogMetadata.ts` `PLUGIN_CATEGORY_DEFINITIONS`. `agent-runtimes` is for engines that own the agent loop and native sessions; ours runs a CLI as a model with OpenClaw's tools and sessions.
- `openclaw.build.openclawVersion`: `2026.10.3`, the same as `ci.yml` `OPENCLAW_VERSION` and `scripts/dev-openclaw.sh`; a test keeps them equal so the field never claims a version CI did not run.
- Reusable workflow: inputs `dry_run` (default true), `package_artifact_name` (a prebuilt `.tgz` from an Actions artifact); the job needs `id-token: write` even for a dry run (it resolves its own source by OIDC), plus `actions: read`, `contents: read`. It runs `package validate` (Plugin Inspector) and `package publish <tgz> --dry-run`.
- Name: `clawhub package publish --dry-run` is local (`preparePackagePublishPlan`, no registry call), so it cannot settle whether ClawHub accepts the unscoped name under the owner. ClawHub docs show unscoped packages exist (`episodic-claw`, installed as `clawhub:episodic-claw@latest`). Decision: keep `openclaw-all-cli`; the first real publish (ticket 31) confirms it, and falls back to `@xtimor/openclaw-all-cli` only if refused. Recorded in MEMORY.md. This replaces the verify line's "dry-run output that decided it".
- Running the `clawhub` CLI in this session was refused by the sandbox (code from outside); the CI job is the check.

Built:
- `package.json`: `openclaw.build.openclawVersion: 2026.10.3`. `openclaw.plugin.json`: `categories: ["models"]` (OpenClaw 2026.11.3 docs list `categories` as a manifest field; older hosts ignore unknown fields, the CI smoke install confirms).
- `test/clawhub-package.test.ts`: the two fields, and the build version equal to `ci.yml` and `scripts/dev-openclaw.sh`. Removing the build field fails 2 of 3 tests (checked locally).
- `.github/workflows/ci.yml`: job `clawhub-pack` (setup, `npm ci`, build, `npm pack`; no tests, so ClawHub sees a bad package even when a unit test fails first; skipped for fork PRs) uploads `clawhub-pack/*.tgz` (`actions/upload-artifact` v7.0.2 pinned); job `clawhub` calls `openclaw/clawhub/.github/workflows/package-publish.yml@9df44b8...` with `dry_run: true`, `family: code-plugin`.
- `docs/setup.md` (CI paragraph), `MEMORY.md` (findings). No changelog line: nothing a plugin user sees changes.
- Local `npm run typecheck` reports 3 errors in `test/turn-timings.test.ts`, a file this change does not touch (this host has no `.spike` OpenClaw types); CI is the reference.

## Verification

**Commands:**
- `npx vitest run test/package-contents.test.ts test/clawhub-package.test.ts` -- expected: pass; removing `openclaw.build.openclawVersion` makes the new test fail.
- `npm test` -- expected: pass.
- CI on the PR -- expected: the ClawHub dry-run job green.
- `workflow_dispatch` of CI on a scratch branch without `openclaw.build.openclawVersion` -- expected: red (unit test, and the ClawHub job if it reaches it); the branch is deleted afterwards.

## Review Triage Log

Quick review, pass 1 (10 findings: 0 high, 3 medium, 5 low, 2 false):

- medium, patch: the ClawHub job sat behind `check`, so a missing field turned only the unit test red and ClawHub was skipped. Packing moved to its own job `clawhub-pack` without tests.
- medium, patch: `family: code-plugin` was not passed to the reusable workflow. Added.
- medium, patch: fork pull requests have no OIDC token, so the ClawHub job would always fail for them. `clawhub-pack` is skipped for fork PRs, and `clawhub` skips with it. Documented in `docs/setup.md`.
- medium, patch: `release.yml` carries its own `OPENCLAW_VERSION`, which builds the published tarball. The test now checks it too.
- low, patch: the `ci.yml` version check was a substring match, so `2026.10.30` would pass. It is now an anchored regex.
- low, patch: the CI comment said "the exact tarball a release would publish", but CI packs version 0.0.0 with `--ignore-scripts`. The comment now says what CI packs.
- low, patch: `ci-check.sh` and `docs/setup.md` still said `npm run ci` runs "every check". They now say "every local check" and name the ClawHub job.
- low, patch: the plan's file list named `docs/release.md`. Corrected to the files actually changed.
- false: "the new test reads the sources, not the tarball". `package.json` and `openclaw.plugin.json` ship verbatim; `test/package-contents.test.ts` requires both in `npm pack`; and the ClawHub job checks the packed tarball itself.
- false: "MEMORY lacks the dry-run output that decided the name". `clawhub package publish --dry-run` makes no registry call (`preparePackagePublishPlan`), so no dry run can decide it. The decision and its reason are recorded, and the first real publish (3.31) confirms the name. The ticket's verify line overstates what a dry run can show; this was reported to the owner.


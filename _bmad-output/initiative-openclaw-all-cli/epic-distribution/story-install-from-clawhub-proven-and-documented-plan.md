---
title: 'Install from ClawHub proven and documented'
type: 'feature'
ticket: '32'
created: '2026-11-12'
status: 'built'
baseline_revision: '05e427fd9c0ee339093a06d28299c70caf641191'
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

**Problem:** v0.1.8 is on ClawHub (2026-11-12), but README and `docs/setup.md` still install from npm with `--force` and describe trust and provenance as measured on npm with OpenClaw 2026.10.3.

**Approach:** Measure the ClawHub path in an isolated OpenClaw on the current stable release (2026.11.3), then rewrite README Install and Update and `docs/setup.md` step 2 to lead with `openclaw plugins install clawhub:openclaw-all-cli`, keep npm as the fallback, correct the review, `--force`, and provenance notes to the measurements, pin both commands in the doc tests, record the facts in MEMORY.md, and add one changelog line.

</frozen-after-approval>

## Implementation Notes

Oneshot: docs and doc tests only, no code under `src/`. Owner approved building 32 (chat, 2026-11-11, "build 31 and 32").

Measured 2026-11-12 in isolated states (`scripts/dev-openclaw.sh` with `SPIKE_DIR` in the scratchpad), OpenClaw 2026.11.3 (current `latest`) unless noted, package `openclaw-all-cli@0.1.8`:

- `openclaw plugins search openclaw-all-cli` → `openclaw-all-cli  code-plugin | community | v0.1.8`, `Install: openclaw plugins install clawhub:openclaw-all-cli`.
- `plugins install clawhub:openclaw-all-cli` (non-TTY) prints the package, its requirements, and a "ClawHub Security Audit" box (Outcome: Review; scan `suspicious`, one A.I.G finding about Cursor's native read, grep, and glob), downloads, and then stops with "requires capability consent ... Re-run ... with --accept-capabilities". Exit 0, nothing installed.
- With `--accept-capabilities` and no `--force`: `Installed plugin: openclaw-all-cli`; `plugins list` shows `0.1.8` enabled; `plugins inspect --json` shows `status: loaded`, `install.source: clawhub`, `clawhubChannel: community`, `clawhubTrustDisposition: review-required`, `clawhubTrustScanStatus: suspicious`, `clawpackSha256` = the release sha256 (60c908eb…). Same result on OpenClaw 2026.10.3.
- Trust: a ClawHub install gets `trust.reason: provenance-invalid` and the diagnostic "OpenClaw can't verify where this plugin came from ..." (OpenClaw 2026.11.3 `installed-plugin-record-match`: only an official ClawHub or npm package is `trusted-official`; any other ClawHub record is `provenance-invalid`). The npm install on 2026.11.3 gets `third-party-npm` and no diagnostic. So the ClawHub install does not remove the provenance note; it is harmless (the plugin loads and runs). No `provenance` line appeared in a 45 s Gateway start log for either.
- npm on 2026.11.3: without `--force` → "outside ClawHub review ... Install cancelled; rerun with --force"; with `--force` → installed. Unchanged.
- Reinstall over an existing ClawHub install without `--force` → "plugin already exists ... (delete it first)"; with `--force` → installed. So `--force` stays in the reinstall (update with the Gateway running) path only.
- npm → ClawHub: `plugins install clawhub:openclaw-all-cli --accept-capabilities` over an npm install, no `--force`, works; the record becomes `source: clawhub`, the npm project dir is removed, one plugin listed.
- `plugins update openclaw-all-cli --dry-run` on a ClawHub install resolves from ClawHub ("Downloading ... from ClawHub", "up to date (0.1.8)"); a pinned `clawhub:openclaw-all-cli@0.1.8` records the pinned spec. A move to a newer version is proven only after the next release.
- Live `cursor-cli` turn: NOT RUN. Installing `cursor-agent` (`curl https://cursor.com/install | bash`) was refused by this sandbox; the plugin loads and the Gateway reaches ready with `cursor-cli/auto`. The ClawHub tarball is byte-identical to the npm one (sha256), whose turn path is proven since 0.1.0.

Plan for the docs:

- `README.md` Install: ClawHub command first (`--accept-capabilities`, no `--force`), the audit box and the consent rule in one paragraph, `openclaw plugins search openclaw-all-cli`; npm as "From npm instead" with `--force` and why. Update: reinstall path uses `clawhub:` with `--force`; stop path keeps `plugins update openclaw-all-cli` (follows the install source); moving from npm is one ClawHub install.
- `docs/setup.md` step 2: same order and facts, plus the inspect fields to check, the pinned form `clawhub:openclaw-all-cli@X.Y.Z`, the provenance note corrected; Troubleshooting `provenance-invalid` row corrected (ClawHub community installs, not npm on 2026.11.3); "go back to the release" commands in Build from source point at ClawHub.
- `test/docs-update-instructions.test.ts`: the force-install regex becomes the ClawHub reinstall; new tests pin `clawhub:openclaw-all-cli --accept-capabilities` before the npm command in README Install and setup step 2, the audit mention, and the npm-to-ClawHub move.
- `MEMORY.md`: one line with the measurements. `CHANGELOG.md` Unreleased: one Changed line.

## Review Triage Log

Quick review, pass 1 (5 findings: 0 high, 1 medium, 3 low, 1 false):

- medium, patch: `docs/setup.md` pinned ClawHub install lacked `--force`, which a reinstall over an existing install needs (measured: `plugin already exists`; OpenClaw's update code also says `--force`). Now `--force` with the reason.
- low, patch: the ClawHub doc tests sat in a new file with a copied `section()` helper, outside the plan's verification command. Moved into `test/docs-update-instructions.test.ts`, reusing its helper.
- false: "the `https://clawhub.ai/plugins/openclaw-all-cli` link has no evidence". The install output prints exactly that URL (`ClawHub   https://clawhub.ai/plugins/openclaw-all-cli`), and it answers 307 to the owner's listing page.
- low, patch: README said `--accept-capabilities` accepts "the backend and provider", setup also names the usage reader (manifest `contracts.usageProviders`). README aligned.
- low, patch: the older ticket 3.5 MEMORY.md line said OpenClaw trusts "ClawHub/official sources", contradicted by the 3.32 measurement. Corrected with a pointer.

## Verification

**Commands:**
- `npx vitest run test/docs-update-instructions.test.ts` -- expected: pass
- `npm run ci` -- expected: pass
